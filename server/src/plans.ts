/**
 * 情侣课表「共同计划」—— 数据层与业务规则。
 *
 * ## 它解决的问题
 *
 * 改造前「共同计划」是个空壳：挑一个共同空闲时段点「约这个时间」，实际只是往
 * **自己**的 DDL 里塞一条待办，界面还要诚实地写一句「只写进你自己的 DDL，TA 不会收到通知」。
 * 也就是说"共同"只体现在标题文案上 —— 对方既看不到、也不知道被约了。
 *
 * 本模块把「计划」做成**真正双人共享的实体**：一条记录同时属于两个人，
 * 双方在同一板块看到同一条，任何一方推进状态（发起 / 接受 / 婉拒 / 改期 / 取消）
 * 都会给对方投一条站内信，并在时间临近时由定时任务提醒双方。
 *
 * ## 三个设计要点
 *
 * 1. **单一事实来源**：计划的唯一权威副本存服务端 `share_plans` 表，前端只渲染服务端返回的真值。
 *    写操作（接受 / 婉拒 / 改期 / 取消）成功后**必须用服务端返回的行**覆盖本地状态，
 *    不做"我先猜一个状态、回头再对齐"的乐观更新 —— 状态机的合法迁移由服务端说了算，
 *    前端猜错会出现「我这边显示已确认、对方那边还是待确认」的假一致。
 *
 * 2. **状态机集中在这里**：谁能从哪个状态迁到哪个状态，只有本文件一处定义（见 PLAN_TRANSITIONS）。
 *    路由层只管鉴权与参数搬运，不重复判断——否则"谁可以取消别人的计划"这种规则会被实现两遍。
 *
 * 3. **通知与数据同事务**：投站内信失败不该让计划创建失败（用户看到的"约成了"才是主要的），
 *    所以通知走 best-effort，但**入队时机**紧跟写操作，并由收件人从成员表实时推导 ——
 *    不用额外维护"该通知谁"的字段，避免成员变动后通知发错人。
 *
 * ## 与纪念日（anniversary/birthday/nextMeet）的关系
 *
 * 那三个是 `share_groups` 上的标量日期列，语义是"**长期约定**"，只在倒计时页展示、无状态流转。
 * 本模块的计划是"**一次性安排**"，有状态机、有通知、可增删改。
 * 两者刻意不合并：把纪念日也做成计划行，会让倒计时页变成一张带状态的表，
 * 而"在一起的日子"根本不存在"待对方确认"这种状态。
 */
import type { SQLInputValue } from 'node:sqlite'
import { db, findUser } from './db.js'
import { HttpError } from './lib.js'
import { isValidISODate } from './date.js'

/* ---------------- 类型 ---------------- */

export type PlanStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'

/**
 * 状态机的唯一权威定义：`from -> 允许迁往的 to`。
 *
 * - `pending` → `accepted` / `declined`：由**非发起人**推进（对方回应）。
 * - `pending` → `cancelled`：由**发起人**撤回。
 * - `accepted` → `cancelled`：已确认后任一方都能取消（临时有事）。
 * - `declined` / `cancelled` 是**终态**：不再允许任何迁移。
 *   为什么终态不可复活：一旦允许"婉拒后又被接受"，双方对"这件事到底定了没有"
 *   就会产生分歧（一方看的是旧页面）。真要重新约，发起一条新计划更清晰、也留了痕。
 */
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  pending: ['accepted', 'declined', 'cancelled'],
  accepted: ['cancelled'],
  declined: [],
  cancelled: []
}

export interface PlanRow {
  id: number
  groupId: number
  createdBy: number
  title: string
  planDate: string
  startTime: string
  endTime: string
  location: string
  note: string
  status: PlanStatus
  respondedAt: string | null
  reminderSentAt: string | null
  createdAt: string
  updatedAt: string
}

/** 给前端的视图：在行数据上补充"我是不是发起人"等**视角相关**字段 */
export interface PlanView {
  id: number
  title: string
  planDate: string
  startTime: string
  endTime: string
  location: string
  note: string
  status: PlanStatus
  /** 发起人 userId */
  createdBy: number
  /** 发起人昵称（用成员快照，与页面其它地方口径一致） */
  createdByName: string
  /**
   * **对方**的昵称（情侣固定 2 人，即除我之外的那一个）。用于「等 TA 确认」这类文案。
   *
   * ⚠️ 不要用 `createdByName` 代替：发起人自己看这条时 `createdByName` 就是**自己**，
   * 文案会变成「等 我 确认」——曾经就是这个 bug（截图里才看出来）。
   * 未绑定满员时回退成 `'TA'`。
   */
  otherName: string
  /** 我是不是发起人：决定我这一侧显示「等 TA 确认」还是「接受/婉拒」 */
  isMine: boolean
  /** 当前状态**允许我**执行的动作，由服务端算好，前端不必再抄一份状态机 */
  myActions: PlanAction[]
  respondedAt: string | null
  createdAt: string
  updatedAt: string
}

export type PlanAction = 'accept' | 'decline' | 'cancel' | 'edit'

const PLAN_COLS = `id, group_id AS groupId, created_by AS createdBy, title,
  plan_date AS planDate, start_time AS startTime, end_time AS endTime,
  location, note, status, responded_at AS respondedAt, reminder_sent_at AS reminderSentAt,
  created_at AS createdAt, updated_at AS updatedAt`

/* ---------------- 校验 ---------------- */

const TITLE_MAX = 40
const LOCATION_MAX = 40
const NOTE_MAX = 200

/**
 * 计划的时间必须能解析成一个**真实的、可以排进日历的**时刻。
 *
 * 为什么时间也要校验而不是随手 String() 存进去：这条记录会参与"临近提醒"的
 * 时间比较（`plan_date || ' ' || start_time` 与 now 比大小）。存进一个
 * `25:99` 或 `2026-13-45`，比较结果会静默错乱 —— 计划永远不会被提醒，
 * 而用户只会觉得"提醒坏了"，查不出原因。
 */
function normalizeTime(raw: unknown, label: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) throw new HttpError(400, `${label}格式需为 HH:mm`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) throw new HttpError(400, `${label}不是有效时间`)
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

function normalizeText(raw: unknown, label: string, max: number, required = false): string {
  const s = String(raw ?? '').trim()
  if (!s && required) throw new HttpError(400, `${label}不能为空`)
  if (s.length > max) throw new HttpError(400, `${label}最多 ${max} 个字`)
  return s
}

/* ---------------- 内部查询 ---------------- */

function getPlanRow(id: number): PlanRow | null {
  return (db.prepare(`SELECT ${PLAN_COLS} FROM share_plans WHERE id = ?`).get(id) as PlanRow | undefined) ?? null
}

/** 取计划并断言「我是所属情侣组的成员」，否则 404（与 share.ts 的 requireMembership 口径一致） */
function requirePlanMember(userId: number, planId: number): { plan: PlanRow; memberIds: number[] } {
  const plan = getPlanRow(planId)
  if (!plan) throw new HttpError(404, '计划不存在或已被取消')
  const memberIds = listGroupMemberIds(plan.groupId)
  if (!memberIds.includes(userId)) throw new HttpError(404, '计划不存在或你不在这个绑定里')
  return { plan, memberIds }
}

/** 成员 userId 列表（顺序稳定），收件人一律由它推导 */
function listGroupMemberIds(groupId: number): number[] {
  const rows = db
    .prepare(`SELECT user_id AS userId FROM share_members WHERE group_id = ? ORDER BY joined_at, id`)
    .all(groupId) as unknown as { userId: number }[]
  return rows.map((r) => r.userId)
}

/** 成员昵称快照（与 share_members 一致，member 改动不影响历史计划的可读性） */
function memberNames(groupId: number): Map<number, string> {
  const rows = db
    .prepare(`SELECT user_id AS userId, nickname FROM share_members WHERE group_id = ?`)
    .all(groupId) as unknown as { userId: number; nickname: string }[]
  return new Map(rows.map((r) => [r.userId, r.nickname]))
}

/* ---------------- 通知 ---------------- */

/**
 * 给**除发起人外**的成员投站内信。
 *
 * best-effort：通知写失败不影响主流程（计划已经落库，用户在板块里照样看得到），
 * 但会把原因写进 stderr，方便排查"为什么对方没收到"。
 * 消息里带上 `#[plan:<id>]` 锚点，前端据此知道点开该跳到情侣课表。
 */
function notifyPlan(
  memberIds: number[],
  exceptUserId: number,
  title: string,
  body: string,
  planId: number
): void {
  const targets = memberIds.filter((id) => id !== exceptUserId)
  if (targets.length === 0) return
  try {
    const stmt = db.prepare(
      `INSERT INTO messages (user_id, type, title, body) VALUES (?, 'couple_plan', ?, ?)`
    )
    for (const uid of targets) stmt.run(uid, title, `${body}\n#[plan:${planId}]`)
  } catch (e) {
    console.warn(`[plans] 计划 #${planId} 的站内信投递失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ---------------- 视图组装 ---------------- */

/**
 * 把行数据 + 视角（我是谁）组装成前端视图。
 * `myActions` 在服务端算好，前端不再复刻状态机 —— 否则"谁能取消"的规则会有两份实现，
 * 改一处忘一处就会出现界面给了按钮但接口 403 的死角。
 */
function toView(row: PlanRow, userId: number, names: Map<number, string>): PlanView {
  const isMine = row.createdBy === userId
  /* 对方 = 成员里第一个不是我的人（情侣固定 2 人）。没有别的成员时回退 'TA'。 */
  const otherId = [...names.keys()].find((id) => id !== userId)
  const otherName = (otherId !== undefined ? names.get(otherId) : '') || 'TA'
  const myActions: PlanAction[] = []
  if (row.status === 'pending') {
    // 对方回应：接受 / 婉拒；发起人只能取消
    if (isMine) myActions.push('cancel', 'edit')
    else myActions.push('accept', 'decline')
  } else if (row.status === 'accepted') {
    // 已确认后任一方都能取消；发起人可以改期（改期 = 退回 pending 重新确认，见 updatePlan）
    myActions.push('cancel')
    if (isMine) myActions.push('edit')
  }
  // declined / cancelled 是终态，没有可执行动作
  return {
    id: row.id,
    title: row.title,
    planDate: row.planDate,
    startTime: row.startTime,
    endTime: row.endTime,
    location: row.location,
    note: row.note,
    status: row.status,
    createdBy: row.createdBy,
    createdByName: names.get(row.createdBy) ?? 'TA',
    otherName,
    isMine,
    myActions,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/* ---------------- 对外接口 ---------------- */

/** 描述一条计划的时间，用于通知文案（如「5月20日 14:00」） */
function describeWhen(row: Pick<PlanRow, 'planDate' | 'startTime'>): string {
  const d = row.planDate.slice(5).replace('-', '月') + '日'
  return row.startTime ? `${d} ${row.startTime}` : d
}

/**
 * 列出某个情侣组的全部计划。
 *
 * 排序：**未结束的在前，按日期升序**（快到的排最前）；已结束的（declined/cancelled）沉底。
 * 为什么不纯按 created_at 倒序：用户打开这个板块是想知道"我们接下来约了什么"，
 * 而不是"最近聊了什么"。所以未来的、已确认的必须浮到最上面。
 */
export function listPlans(userId: number, groupId: number): PlanView[] {
  const memberIds = listGroupMemberIds(groupId)
  if (!memberIds.includes(userId)) throw new HttpError(404, '你不在这个绑定里')
  const rows = db
    .prepare(`SELECT ${PLAN_COLS} FROM share_plans WHERE group_id = ?`)
    .all(groupId) as unknown as PlanRow[]
  const names = memberNames(groupId)
  const rank = (s: PlanStatus) => (s === 'accepted' ? 0 : s === 'pending' ? 1 : 2)
  return rows
    .map((r) => toView(r, userId, names))
    .sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        a.planDate.localeCompare(b.planDate) ||
        a.startTime.localeCompare(b.startTime) ||
        a.id - b.id
    )
}

export interface CreatePlanInput {
  title?: unknown
  planDate?: unknown
  startTime?: unknown
  endTime?: unknown
  location?: unknown
  note?: unknown
}

/**
 * 发起一条计划。
 *
 * 新建时**永远**是 `pending` —— 不存在"我新建一条已确认的"。理由是这条记录的语义
 * 是"我提议了一个安排"，只有对方点过接受才算数；允许自建已确认等于一个人就能替两个人拍板。
 */
export function createPlan(userId: number, groupId: number, input: CreatePlanInput): PlanView {
  const memberIds = listGroupMemberIds(groupId)
  if (!memberIds.includes(userId)) throw new HttpError(404, '你不在这个绑定里')
  if (memberIds.length < 2) throw new HttpError(400, '对方还没绑定，先等 TA 输入密钥加入')

  const title = normalizeText(input.title, '标题', TITLE_MAX, true)
  const planDate = String(input.planDate ?? '').trim()
  if (!isValidISODate(planDate)) throw new HttpError(400, '日期格式需为 YYYY-MM-DD')
  const startTime = normalizeTime(input.startTime, '开始时间')
  const endTime = normalizeTime(input.endTime, '结束时间')
  if (startTime && endTime && endTime < startTime) throw new HttpError(400, '结束时间不能早于开始时间')
  const location = normalizeText(input.location, '地点', LOCATION_MAX)
  const note = normalizeText(input.note, '备注', NOTE_MAX)

  const info = db
    .prepare(
      `INSERT INTO share_plans (group_id, created_by, title, plan_date, start_time, end_time, location, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(groupId, userId, title, planDate, startTime, endTime, location, note)
  const planId = Number(info.lastInsertRowid)
  const row = getPlanRow(planId)!

  const me = findUser(userId)
  notifyPlan(
    memberIds,
    userId,
    `${me?.nickname || me?.username || 'TA'} 约了你一程`,
    `「${title}」· ${describeWhen(row)}${location ? ` · ${location}` : ''}\n去「共同计划」里接受或婉拒。`,
    planId
  )
  return toView(row, userId, memberNames(groupId))
}

/**
 * 对方回应：接受 / 婉拒。
 *
 * 权限：**只有非发起人**能调用。让发起人自己接受自己的提议，等于绕过"共同约定"的全部意义。
 */
export function respondPlan(userId: number, planId: number, action: unknown): PlanView {
  const { plan, memberIds } = requirePlanMember(userId, planId)
  if (plan.createdBy === userId) throw new HttpError(403, '这是你自己发起的计划，等对方回应')
  if (action !== 'accept' && action !== 'decline') throw new HttpError(400, '无效的操作')
  const to: PlanStatus = action === 'accept' ? 'accepted' : 'declined'
  if (!PLAN_TRANSITIONS[plan.status].includes(to)) {
    throw new HttpError(409, plan.status === 'pending' ? '该计划无法再回应' : '这条计划已经处理过了')
  }

  /* 上面那次 PLAN_TRANSITIONS 判断读的是**读出来的快照**，两个请求并发时都会通过。
     所以真正的幂等闸门在 SQL 上：UPDATE 带上 `AND status = ?`（= 刚才读到的状态），
     只有抢到的那一个能改到行，另一个 changes === 0 → 409。
     没有这一条时，双方同时点"接受"会两次都成功，并各收一条通知。 */
  const info = db.prepare(
    `UPDATE share_plans SET status = ?, responded_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = ?`
  ).run(to, planId, plan.status)
  if (Number(info.changes ?? 0) === 0) {
    throw new HttpError(409, '这条计划刚刚已被处理，请刷新后再看')
  }
  const row = getPlanRow(planId)!

  const me = findUser(userId)
  const who = me?.nickname || me?.username || 'TA'
  notifyPlan(
    memberIds,
    userId,
    to === 'accepted' ? `${who} 接受了你的计划` : `${who} 婉拒了你的计划`,
    `「${row.title}」· ${describeWhen(row)}${to === 'accepted' ? '' : '\n可以换个时间再约一次。'}`,
    planId
  )
  return toView(row, userId, memberNames(plan.groupId))
}

/**
 * 修改计划（改期 / 改地点 / 改标题）。
 *
 * 为什么改期要**重置成 pending 并清掉提醒标记**：
 * 时间变了，"对方已经确认过"这件事就不再成立 —— 他确认的是旧时间。
 * 所以改期后自动退回待确认并重新征求同意；同时把 `reminder_sent_at` 清空，
 * 否则新时间到了却因为"已提醒过"而永远不提醒。
 *
 * 权限：只有**发起人**能改。允许多人改会让"当前约定是什么"变得无法追踪。
 */
export function updatePlan(userId: number, planId: number, input: CreatePlanInput): PlanView {
  const { plan, memberIds } = requirePlanMember(userId, planId)
  if (plan.createdBy !== userId) throw new HttpError(403, '只有发起人可以修改计划')
  if (plan.status === 'declined' || plan.status === 'cancelled') {
    throw new HttpError(409, '已结束的计划不能再修改，请重新发起')
  }

  const sets: string[] = []
  const args: SQLInputValue[] = []
  /** 时间/标题变了就要重新征求同意 */
  let materialChange = false

  if ('title' in input) {
    const v = normalizeText(input.title, '标题', TITLE_MAX, true)
    if (v !== plan.title) materialChange = true
    sets.push('title = ?')
    args.push(v)
  }
  if ('planDate' in input) {
    const v = String(input.planDate ?? '').trim()
    if (!isValidISODate(v)) throw new HttpError(400, '日期格式需为 YYYY-MM-DD')
    if (v !== plan.planDate) materialChange = true
    sets.push('plan_date = ?')
    args.push(v)
  }
  if ('startTime' in input) {
    const v = normalizeTime(input.startTime, '开始时间')
    if (v !== plan.startTime) materialChange = true
    sets.push('start_time = ?')
    args.push(v)
  }
  if ('endTime' in input) {
    const v = normalizeTime(input.endTime, '结束时间')
    if (v !== plan.endTime) materialChange = true
    sets.push('end_time = ?')
    args.push(v)
  }
  if ('location' in input) {
    const v = normalizeText(input.location, '地点', LOCATION_MAX)
    if (v !== plan.location) materialChange = true
    sets.push('location = ?')
    args.push(v)
  }
  // note 属于细节补充，不触发"重新确认"
  if ('note' in input) {
    sets.push('note = ?')
    args.push(normalizeText(input.note, '备注', NOTE_MAX))
  }
  if (sets.length === 0) return toView(plan, userId, memberNames(plan.groupId))

  /* 必须校验"改后"的起止时间：只传了 startTime 时，要与库里已有的 endTime 比 */
  const nextStart = 'startTime' in input ? normalizeTime(input.startTime, '开始时间') : plan.startTime
  const nextEnd = 'endTime' in input ? normalizeTime(input.endTime, '结束时间') : plan.endTime
  if (nextStart && nextEnd && nextEnd < nextStart) throw new HttpError(400, '结束时间不能早于开始时间')

  if (materialChange) {
    /* 回到待确认 + 清空提醒标记，理由见函数头注释 */
    sets.push(`status = 'pending'`, 'responded_at = NULL', 'reminder_sent_at = NULL')
  }
  sets.push(`updated_at = datetime('now')`)
  args.push(planId)
  db.prepare(`UPDATE share_plans SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  const row = getPlanRow(planId)!

  if (materialChange) {
    const me = findUser(userId)
    notifyPlan(
      memberIds,
      userId,
      `${me?.nickname || me?.username || 'TA'} 改了你们的计划`,
      `「${row.title}」改成了 ${describeWhen(row)}${row.location ? ` · ${row.location}` : ''}\n需要你重新确认。`,
      planId
    )
  }
  return toView(row, userId, memberNames(plan.groupId))
}

/**
 * 取消计划。
 *
 * 谁可以取消：**任一方**（已确认后临时有事，让双方都能撤是必要的）。
 * 状态限制：终态（declined / cancelled）不能再取消 —— 幂等地返回当前行即可，
 * 不报错，因为"对方已经拒了，我又点了取消"是正常的界面竞态，不该弹错误。
 */
export function cancelPlan(userId: number, planId: number): PlanView {
  const { plan, memberIds } = requirePlanMember(userId, planId)
  if (plan.status === 'declined' || plan.status === 'cancelled') {
    return toView(plan, userId, memberNames(plan.groupId))
  }

  db.prepare(`UPDATE share_plans SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(planId)
  const row = getPlanRow(planId)!

  const me = findUser(userId)
  notifyPlan(
    memberIds,
    userId,
    `${me?.nickname || me?.username || 'TA'} 取消了一个计划`,
    `「${row.title}」· ${describeWhen(row)}`,
    planId
  )
  return toView(row, userId, memberNames(plan.groupId))
}

/* ---------------- 临近提醒（供定时任务调用） ---------------- */

export interface DueReminder {
  planId: number
  groupId: number
  title: string
  planDate: string
  startTime: string
  location: string
  memberIds: number[]
}

/**
 * 找出"已确认、时间已进入提醒窗口、且尚未提醒过"的计划。
 *
 * 为什么只提醒 `accepted`：`pending` 还没定下来，提醒它等于催对方回应；
 * `declined`/`cancelled` 更不该提醒。只有双方都点头的安排才值得打扰。
 *
 * `nowIso` 由调用方传入（而不是内部取当前时间），便于测试注入固定时刻。
 *
 * ⚠️ `nowIso` 必须是**本地墙上时间**（`date.ts` 的 `localStamp()`），不能传 `toISOString()`。
 * 这里把 `planDate + 'T' + startTime` 用 `Date.parse` 解析，无时区后缀的串会被当作本地时间；
 * 若 nowIso 来自 UTC，两侧基准就差了时区偏移量（东八区 8 小时），提醒要么永不到点、要么错时。
 */
export function findDueReminders(nowIso: string, windowHours: number): DueReminder[] {
  const rows = db
    .prepare(
      `SELECT id, group_id AS groupId, title, plan_date AS planDate, start_time AS startTime, location
       FROM share_plans
       WHERE status = 'accepted'
         AND reminder_sent_at IS NULL
         AND plan_date >= ?`
    )
    .all(nowIso.slice(0, 10)) as unknown as {
    id: number
    groupId: number
    title: string
    planDate: string
    startTime: string
    location: string
  }[]

  const nowMs = Date.parse(`${nowIso.slice(0, 10)}T${nowIso.slice(11, 19)}`)
  const limitMs = nowMs + windowHours * 3600_000
  const out: DueReminder[] = []
  for (const r of rows) {
    // 只记了日期没记时间的计划，按当天 00:00 起算（保守：宁可早提醒也不漏）
    const at = Date.parse(`${r.planDate}T${r.startTime || '00:00'}`)
    if (Number.isNaN(at) || at > limitMs) continue
    out.push({
      planId: r.id,
      groupId: r.groupId,
      title: r.title,
      planDate: r.planDate,
      startTime: r.startTime,
      location: r.location,
      memberIds: listGroupMemberIds(r.groupId)
    })
  }
  return out
}

/** 标记已提醒（幂等防重）。返回是否本次真的写入（false = 已被别的扫描抢先） */
export function markReminded(planId: number): boolean {
  const r = db
    .prepare(`UPDATE share_plans SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_sent_at IS NULL`)
    .run(planId)
  return Number(r.changes) > 0
}

/** 给提醒任务用：投递"到点提醒"站内信（发给双方，不含任何"发起人"例外） */
export function notifyDueReminder(d: DueReminder): void {
  try {
    const stmt = db.prepare(
      `INSERT INTO messages (user_id, type, title, body) VALUES (?, 'couple_plan', ?, ?)`
    )
    for (const uid of d.memberIds) {
      stmt.run(
        uid,
        '共同计划马上开始',
        `「${d.title}」${d.startTime ? ` ${d.startTime}` : ''}${d.location ? ` · ${d.location}` : ''}\n别忘了。\n#[plan:${d.planId}]`
      )
    }
  } catch (e) {
    console.warn(`[plans] 计划 #${d.planId} 的到点提醒投递失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ---------------- 清理 ---------------- */

/**
 * 解散/解绑情侣关系时，计划会由外键 `ON DELETE CASCADE` 自动删除，
 * 这里只提供一个显式入口给需要"主动清空历史计划"的场景（幂等）。
 */
export function clearPlans(groupId: number): number {
  const r = db.prepare(`DELETE FROM share_plans WHERE group_id = ?`).run(groupId)
  return Number(r.changes)
}
