/**
 * 共享课表（空闲课表 / 情侣课表）—— 数据层与业务规则。
 *
 * 为什么一个模块承载两种功能：把 5 张设计稿摊开看，会发现「空闲课表群组」与「情侣课表」
 * 是**同一套数据的两种视图** —— 都是「一组人 + 各自同步上来的课表 + 算出共同空闲」。
 * 差别只在成员数（N 人 / 2 人）与明细可见性（不共享课程内容 / 共享课程明细）。
 * 因此用 share_groups.kind 区分形态，共用成员表与快照结构，前端只换皮不换逻辑；
 * 这样「同步」「退出」「密钥」「人数门槛」这些规则只存在一份，不会两边各修一遍。
 *
 * ⚠️ 隐私边界（这是本模块最核心的设计约束）：
 *   群组形态下，成员快照里的 `courses`（课名/教师/地点）**一律不下发**，只下发忙闲区间。
 *   图5 的原话是「找到大家都有空的时间，不共享具体课程内容」—— 这不是文案，是功能承诺：
 *   一旦把课名带出去，用户就能反推出同学在哪上课、跟谁一起，属于超出预期的信息暴露。
 *   情侣形态才在**双方各自**开启 show_detail 后下发明细。
 */
import { randomBytes } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { db, findUser, getSettings, tx } from './db.js'
import { HttpError, courseHitsWeek, listCourses } from './lib.js'
import { addDays, isValidISODate, listSemesterWeekOptions, parseISODate, toISODate } from './date.js'
import type { Course, Period, WeekOption } from './types.js'

export type ShareKind = 'group' | 'couple'

/** 单个用户最多能加入的群组数（图5：「最多可加入 20 个」） */
export const MAX_GROUPS_PER_USER = 20
/** 单个群组的成员上限 */
export const MAX_MEMBERS_PER_GROUP = 50
/** 密钥字符集：去掉了易混的 0/O/1/I，用户会照着念、照着抄 */
const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SECRET_LEN = 6

/* ---------------- 快照 ---------------- */

/**
 * 快照里的一条课程明细。
 * `weeks` 是**已展开的显式教学周集合**：对方拿到后不必再理解"区间 + 单双周 + 离散集合"
 * 三套并存的口径，避免同一个判定逻辑在前后端各写一遍、还各错一遍。
 */
export interface ShareCourse {
  name: string
  teacher: string
  location: string
  /** 1=周一 … 7=周日 */
  dayOfWeek: number
  startPeriod: number
  endPeriod: number
  startTime: string
  endTime: string
  color: string
  weeks: number[]
}

/** 节次区间 [起, 止]，闭区间，起止都按「第几大节」计 */
export type PeriodRange = [number, number]

/**
 * 一个成员同步上来的忙闲快照。
 *
 * 存快照而不是每次实时联查，是刻意的：共享课表要跨用户读别人的课表，
 * 实时读意味着每次打开群组详情都要按成员数放大成 N 次课程查询，
 * 且成员换学期、删课会**静默改变历史结论**（上周约好的时间这周显示大家都空）。
 * 快照把"我看到的就是你同步那一刻的状态"钉死，也让「已同步」这个状态有据可依。
 */
export interface ShareSnapshot {
  termId: string
  termName: string
  startDate: string
  totalWeeks: number
  periods: Period[]
  /** 该学期的周次下拉项（教学周 + 放假周），与课表页同源 */
  weekOptions: WeekOption[]
  /** busy[教学周号][weekday] = 该周该天被占用的节次区间（已合并相邻/重叠） */
  busy: Record<string, Record<string, PeriodRange[]>>
  /** 课程明细（是否下发给对方由成员的 show_detail 决定） */
  courses: ShareCourse[]
  syncedAt: string
}

/** 合并重叠/相邻的节次区间（如 1-2 与 2-3 合并为 1-3），让忙闲块的边界稳定 */
function mergeRanges(ranges: PeriodRange[]): PeriodRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: PeriodRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur[0] <= last[1] + 1) last[1] = Math.max(last[1], cur[1])
    else out.push([...cur] as PeriodRange)
  }
  return out
}

/** 某教学周内，按星期聚合出的忙闲区间 */
function busyOfWeek(courses: Course[], week: number): Record<string, PeriodRange[]> {
  const acc: Record<string, PeriodRange[]> = {}
  for (const c of courses) {
    if (!courseHitsWeek(c, week)) continue
    const key = String(c.dayOfWeek)
    ;(acc[key] ??= []).push([c.startPeriod, c.endPeriod])
  }
  const out: Record<string, PeriodRange[]> = {}
  for (const k of Object.keys(acc)) out[k] = mergeRanges(acc[k])
  return out
}

/**
 * 用用户**当前学期**的课表生成快照。
 * 学期口径以同步者自己的 settings 为准 —— 群组里两人可能在不同学期（如一个已放寒假），
 * 这种不一致由详情接口标记出来交给界面提示，而不是在这里强行对齐（对齐反而会造假数据）。
 */
export function buildSnapshot(userId: number): ShareSnapshot {
  const settings = getSettings(userId)
  const semester = settings.semester
  const termId = settings.currentTermId ?? ''
  const courses = listCourses(userId, termId)
  const totalWeeks = Math.max(1, semester.totalWeeks || 16)
  const periods = settings.periods ?? []

  const busy: Record<string, Record<string, PeriodRange[]>> = {}
  for (let w = 1; w <= totalWeeks; w++) busy[String(w)] = busyOfWeek(courses, w)

  const coursesOut: ShareCourse[] = courses.map((c) => {
    const sp = periods.find((p) => p.index === c.startPeriod)
    const ep = periods.find((p) => p.index === c.endPeriod)
    const weeks: number[] = []
    for (let w = 1; w <= totalWeeks; w++) if (courseHitsWeek(c, w)) weeks.push(w)
    return {
      name: c.name,
      teacher: c.teacher,
      location: c.location,
      dayOfWeek: c.dayOfWeek,
      startPeriod: c.startPeriod,
      endPeriod: c.endPeriod,
      startTime: sp?.start ?? '',
      endTime: ep?.end ?? '',
      color: c.color,
      weeks
    }
  })

  return {
    termId,
    termName: semester.name,
    startDate: semester.startDate,
    totalWeeks,
    periods,
    weekOptions: listSemesterWeekOptions(semester),
    busy,
    courses: coursesOut,
    syncedAt: new Date().toISOString()
  }
}

/** 安全解析成员快照：损坏/为空一律当作「未同步」，绝不让一条坏 JSON 打挂整个详情页 */
function parseSnapshot(raw: unknown): ShareSnapshot | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const o = JSON.parse(raw) as ShareSnapshot
    if (!o || typeof o !== 'object' || typeof o.busy !== 'object' || o.busy === null) return null
    return o
  } catch {
    return null
  }
}

/* ---------------- 行 <-> 对象 ---------------- */

interface GroupRow {
  id: number
  ownerId: number
  kind: ShareKind
  name: string
  secret: string
  threshold: number
  /** 情侣形态的三个纪念日（YYYY-MM-DD，可空） */
  anniversary: string | null
  birthday: string | null
  nextMeet: string | null
  createdAt: string
}

interface MemberRow {
  id: number
  groupId: number
  userId: number
  nickname: string
  avatar: string | null
  color: string
  snapshot: string | null
  syncedAt: string | null
  showDetail: number
  joinedAt: string
}

const GROUP_COLS = `id, owner_id AS ownerId, kind, name, secret, threshold,
  anniversary, birthday, next_meet AS nextMeet, created_at AS createdAt`
const MEMBER_COLS = `id, group_id AS groupId, user_id AS userId, nickname, avatar, color,
  snapshot, synced_at AS syncedAt, show_detail AS showDetail, joined_at AS joinedAt`

function getGroupRow(id: number): GroupRow | null {
  return (db.prepare(`SELECT ${GROUP_COLS} FROM share_groups WHERE id = ?`).get(id) as GroupRow | undefined) ?? null
}

function getMemberRow(groupId: number, userId: number): MemberRow | null {
  return (
    (db
      .prepare(`SELECT ${MEMBER_COLS} FROM share_members WHERE group_id = ? AND user_id = ?`)
      .get(groupId, userId) as MemberRow | undefined) ?? null
  )
}

function getMemberById(groupId: number, memberId: number): MemberRow | null {
  return (
    (db
      .prepare(`SELECT ${MEMBER_COLS} FROM share_members WHERE group_id = ? AND id = ?`)
      .get(groupId, memberId) as MemberRow | undefined) ?? null
  )
}

function listMemberRows(groupId: number): MemberRow[] {
  return db
    .prepare(`SELECT ${MEMBER_COLS} FROM share_members WHERE group_id = ? ORDER BY joined_at, id`)
    .all(groupId) as unknown as MemberRow[]
}

/** 取群组并断言「我是成员」，否则 404（不是 403：不暴露"这个群存在但你没资格"） */
function requireMembership(userId: number, groupId: number): { group: GroupRow; me: MemberRow } {
  const group = getGroupRow(groupId)
  if (!group) throw new HttpError(404, '群组不存在或已解散')
  const me = getMemberRow(groupId, userId)
  if (!me) throw new HttpError(404, '群组不存在或你已退出')
  return { group, me }
}

/**
 * 周次下拉项的兜底：学期没有周次表时按「开学日 + 7×(N-1)」线性生成 1..totalWeeks。
 *
 * 为什么服务端要兜这一手：详情页的网格按「教学周 × 星期」画，没有 weekOptions 就一格都画不出来。
 * 而周次表只在用「智慧课程平台」导入时才有 —— 用「本科教务」导入或手工建学期的用户占了相当一部分，
 * 对他们来说这个功能会直接变成空白页。兜底口径与课表页的 buildWeekPicks 保持一致。
 */
function fallbackWeekOptions(semester: { startDate: string; totalWeeks: number }): WeekOption[] {
  if (!isValidISODate(semester.startDate)) return []
  const total = Math.max(1, semester.totalWeeks || 16)
  const out: WeekOption[] = []
  for (let n = 1; n <= total; n++) {
    const begin = addDays(parseISODate(semester.startDate), (n - 1) * 7)
    out.push({
      week: n,
      beginDate: toISODate(begin),
      endDate: toISODate(addDays(begin, 6)),
      hasClass: true
    })
  }
  return out
}

/** 断言「我是群主」 */
function requireOwner(userId: number, groupId: number): GroupRow {
  const { group } = requireMembership(userId, groupId)
  if (group.ownerId !== userId) throw new HttpError(403, '只有群主可以执行该操作')
  return group
}

/* ---------------- 成员上限 / 计数 ---------------- */

function countMyGroups(userId: number, kind?: ShareKind): number {
  const sql = kind
    ? `SELECT COUNT(*) AS c FROM share_members m JOIN share_groups g ON g.id = m.group_id
       WHERE m.user_id = ? AND g.kind = ?`
    : `SELECT COUNT(*) AS c FROM share_members WHERE user_id = ?`
  const row = db.prepare(sql).get(...(kind ? [userId, kind] : [userId])) as { c: number }
  return row.c
}

function countMembers(groupId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM share_members WHERE group_id = ?`).get(groupId) as { c: number }).c
}

/* ---------------- 密钥 ---------------- */

/** 生成一个全局唯一的加入密钥（唯一索引兜底，冲突重试） */
function genSecret(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = randomBytes(SECRET_LEN)
    let s = ''
    for (let i = 0; i < SECRET_LEN; i++) s += SECRET_ALPHABET[bytes[i] % SECRET_ALPHABET.length]
    if (!db.prepare(`SELECT 1 FROM share_groups WHERE secret = ?`).get(s)) return s
  }
  throw new HttpError(500, '密钥生成失败，请重试')
}

/** 成员配色：按加入顺序从固定色板里取，保证同一群内颜色稳定且互不相同 */
const MEMBER_COLORS = ['#4f7cff', '#20c997', '#ffa94d', '#845ef7', '#f783ac', '#12b886', '#4dabf7', '#e8590c']
function pickColor(index: number): string {
  return MEMBER_COLORS[index % MEMBER_COLORS.length]
}

/* ---------------- 创建 / 加入 ---------------- */

function normalizeGroupName(raw: unknown, fallback: string): string {
  const name = String(raw ?? '').trim()
  if (!name) return fallback
  if (name.length > 20) throw new HttpError(400, '群组名称最多 20 个字')
  return name
}

/** 成员加入时把昵称/头像/配色快照下来（理由见 db.ts 的 share_members 注释） */
function addMember(groupId: number, userId: number): MemberRow {
  const u = findUser(userId)
  const nickname = u?.nickname || u?.username || '同学'
  const color = pickColor(countMembers(groupId))
  const info = db
    .prepare(`INSERT INTO share_members (group_id, user_id, nickname, avatar, color) VALUES (?, ?, ?, ?, ?)`)
    .run(groupId, userId, nickname, u?.avatar ?? null, color)
  return getMemberById(groupId, Number(info.lastInsertRowid))!
}

export function createShareGroup(
  userId: number,
  input: { name?: unknown; kind?: unknown; threshold?: unknown }
): GroupRow & { memberCount: number; syncedCount: number } {
  const kind: ShareKind = input.kind === 'couple' ? 'couple' : 'group'

  if (kind === 'couple') {
    if (getCoupleGroup(userId)) throw new HttpError(409, '你已经绑定了一个情侣课表')
  } else if (countMyGroups(userId, 'group') >= MAX_GROUPS_PER_USER) {
    throw new HttpError(400, `最多只能加入 ${MAX_GROUPS_PER_USER} 个群组`)
  }

  const name = normalizeGroupName(input.name, kind === 'couple' ? '我和 TA' : '我的群组')
  const threshold = kind === 'couple' ? 2 : normalizeThreshold(input.threshold)
  const secret = genSecret()

  /* 建群 + 把自己加进成员表必须在同一个事务里：否则 addMember 失败（约束冲突、
     磁盘满、进程被杀）会留下一个 **0 成员的孤儿群组** —— 它占着群组密钥、
     会出现在"我加入的群组"里，但永远没有人能同步，也没人能删（只有群主能删，而群主就是那个孤儿）。
     写操作是两条 INSERT，包事务的成本几乎为零。 */
  const groupId = tx(() => {
    const info = db
      .prepare(`INSERT INTO share_groups (owner_id, kind, name, secret, threshold) VALUES (?, ?, ?, ?, ?)`)
      .run(userId, kind, name, secret, threshold)
    const id = Number(info.lastInsertRowid)
    addMember(id, userId)
    return id
  })
  return { ...getGroupRow(groupId)!, memberCount: 1, syncedCount: 0 }
}

function normalizeThreshold(raw: unknown): number {
  const n = Number(raw ?? 0)
  if (!Number.isInteger(n) || n < 0 || n > MAX_MEMBERS_PER_GROUP) return 0
  return n
}

export function joinShareGroup(userId: number, rawSecret: unknown, kind: ShareKind = 'group'): GroupRow {
  const secret = String(rawSecret ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{4,12}$/.test(secret)) throw new HttpError(400, '请输入有效的群组密钥')
  const group = db.prepare(`SELECT ${GROUP_COLS} FROM share_groups WHERE secret = ?`).get(secret) as GroupRow | undefined
  if (!group) throw new HttpError(404, '密钥无效，请与分享者核对')
  if (group.kind !== kind) {
    throw new HttpError(400, kind === 'couple' ? '这是一张群组密钥，不是情侣密钥' : '这是情侣密钥，请到情侣课表里绑定')
  }
  if (getMemberRow(group.id, userId)) return group // 幂等：已加入就直接返回
  if (countMyGroups(userId, kind) >= MAX_GROUPS_PER_USER) {
    throw new HttpError(400, `最多只能加入 ${MAX_GROUPS_PER_USER} 个群组`)
  }
  const limit = group.kind === 'couple' ? 2 : MAX_MEMBERS_PER_GROUP
  if (countMembers(group.id) >= limit) {
    throw new HttpError(409, group.kind === 'couple' ? '对方已经绑定了另一位成员' : '该群组人数已满')
  }
  addMember(group.id, userId)
  return group
}

/* ---------------- 列表 / 详情 ---------------- */

export interface ShareGroupSummary {
  id: number
  kind: ShareKind
  name: string
  secret: string
  threshold: number
  ownerId: number
  isOwner: boolean
  memberCount: number
  syncedCount: number
  /** 我自己的同步时间（null = 还没同步） */
  mySyncedAt: string | null
  /** 情侣形态的三个纪念日（群组形态恒为 null） */
  anniversary: string | null
  birthday: string | null
  nextMeet: string | null
  createdAt: string
}

export function listMyShareGroups(userId: number, kind: ShareKind = 'group'): ShareGroupSummary[] {
  const rows = db
    .prepare(
      `SELECT ${GROUP_COLS} FROM share_groups g
       WHERE EXISTS (SELECT 1 FROM share_members m WHERE m.group_id = g.id AND m.user_id = ?)
         AND g.kind = ?
       ORDER BY g.created_at DESC, g.id DESC`
    )
    .all(userId, kind) as unknown as GroupRow[]
  return rows.map((g) => {
    const members = listMemberRows(g.id)
    const me = members.find((m) => m.userId === userId)
    return {
      id: g.id,
      kind: g.kind,
      name: g.name,
      secret: g.secret,
      threshold: g.threshold,
      ownerId: g.ownerId,
      isOwner: g.ownerId === userId,
      memberCount: members.length,
      syncedCount: members.filter((m) => m.snapshot).length,
      mySyncedAt: me?.syncedAt ?? null,
      anniversary: g.anniversary,
      birthday: g.birthday,
      nextMeet: g.nextMeet,
      createdAt: g.createdAt
    }
  })
}

/** 我的情侣绑定（没有则 null） */
export function getCoupleGroup(userId: number): ShareGroupSummary | null {
  return listMyShareGroups(userId, 'couple')[0] ?? null
}

export interface ShareMemberView {
  id: number
  userId: number
  nickname: string
  avatar: string | null
  color: string
  isOwner: boolean
  isMe: boolean
  /** 是否已同步课表 */
  synced: boolean
  syncedAt: string | null
  showDetail: boolean
  /** 快照里的学期名（用于提示"有人还没换成这学期"） */
  termName: string | null
  termId: string | null
  /** 快照的学期与**我**的当前学期是否一致；不一致时忙闲不可直接比较 */
  sameTerm: boolean
  /** 该成员快照里的教学周总数 */
  totalWeeks: number
  /** 忙闲：busy[教学周][weekday] = 区间数组 */
  busy: Record<string, Record<string, PeriodRange[]>>
  /** 课程明细；群组形态恒为空数组（隐私边界，见文件头注释） */
  courses: ShareCourse[]
}

export interface ShareDetail {
  group: ShareGroupSummary
  members: ShareMemberView[]
  /** 我当前学期的周次下拉项与节次表（界面按它画网格） */
  weekOptions: WeekOption[]
  periods: Period[]
  semester: { termId: string; termName: string; startDate: string; totalWeeks: number }
  /** 我自己的成员记录 id（前端判断"移除自己 = 退出"） */
  myMemberId: number
}

export function getShareDetail(userId: number, groupId: number): ShareDetail {
  const { group, me } = requireMembership(userId, groupId)
  const members = listMemberRows(groupId)

  const mySettings = getSettings(userId)
  const myTermId = mySettings.currentTermId ?? ''
  const totalWeeks = Math.max(1, mySettings.semester.totalWeeks || 16)

  const views: ShareMemberView[] = members.map((m) => {
    const snap = parseSnapshot(m.snapshot)
    /* 群组形态一律不给明细 —— 这是功能承诺，不是可配置项 */
    const allowDetail = group.kind === 'couple' && (m.showDetail === 1 || m.userId === userId)
    return {
      id: m.id,
      userId: m.userId,
      nickname: m.nickname,
      avatar: m.avatar,
      color: m.color,
      isOwner: m.userId === group.ownerId,
      isMe: m.userId === userId,
      synced: !!snap,
      syncedAt: m.syncedAt,
      showDetail: m.showDetail === 1,
      termName: snap?.termName ?? null,
      termId: snap?.termId ?? null,
      sameTerm: snap ? snap.termId === myTermId : false,
      totalWeeks: snap?.totalWeeks ?? 0,
      busy: snap?.busy ?? {},
      courses: allowDetail && snap ? snap.courses : []
    }
  })

  const syncedCount = views.filter((v) => v.synced).length
  /* 周次表优先用学期自带的（含放假周，最准确）；没有就线性兜底，保证网格永远画得出来 */
  const fromTable = listSemesterWeekOptions(mySettings.semester)
  return {
    group: {
      id: group.id,
      kind: group.kind,
      name: group.name,
      secret: group.secret,
      threshold: group.threshold,
      ownerId: group.ownerId,
      isOwner: group.ownerId === userId,
      memberCount: members.length,
      syncedCount,
      mySyncedAt: me.syncedAt,
      anniversary: group.anniversary,
      birthday: group.birthday,
      nextMeet: group.nextMeet,
      createdAt: group.createdAt
    },
    members: views,
    weekOptions: fromTable.length > 0 ? fromTable : fallbackWeekOptions(mySettings.semester),
    periods: mySettings.periods ?? [],
    semester: {
      termId: myTermId,
      termName: mySettings.semester.name,
      startDate: mySettings.semester.startDate,
      totalWeeks
    },
    myMemberId: me.id
  }
}

/* ---------------- 更新 ---------------- */

export function updateShareGroup(
  userId: number,
  groupId: number,
  patch: { name?: unknown; threshold?: unknown; anniversary?: unknown; birthday?: unknown; nextMeet?: unknown }
): GroupRow {
  const group = requireOwner(userId, groupId)
  const name = 'name' in patch ? normalizeGroupName(patch.name, group.name) : group.name
  const threshold = 'threshold' in patch ? normalizeThreshold(patch.threshold) : group.threshold

  /* 三个纪念日：传 null / 空串 = **清空**。只认 YYYY-MM-DD，非法值直接 400 ——
     存进一个坏日期会让倒计时算成 NaN，而用户只会看到"倒计时坏了"。
     ⚠️ 这里必须按"字段是否出现"决定是否写这一列，不能用 COALESCE(?, 旧值)：
     那会把「清空」和「没传」当成同一件事，用户就再也删不掉填错的纪念日。 */
  const sets: string[] = ['name = ?', 'threshold = ?']
  const args: SQLInputValue[] = [name, threshold]
  for (const key of ['anniversary', 'birthday', 'nextMeet'] as const) {
    if (!(key in patch)) continue
    const raw = patch[key]
    let value: string | null = null
    if (raw !== null && raw !== undefined && raw !== '') {
      const s = String(raw)
      if (!isValidISODate(s)) throw new HttpError(400, '日期格式需为 YYYY-MM-DD')
      value = s
    }
    sets.push(`${key === 'nextMeet' ? 'next_meet' : key} = ?`)
    args.push(value)
  }
  args.push(groupId)
  db.prepare(`UPDATE share_groups SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return getGroupRow(groupId)!
}

export function rotateShareSecret(userId: number, groupId: number): string {
  requireOwner(userId, groupId)
  const secret = genSecret()
  db.prepare(`UPDATE share_groups SET secret = ? WHERE id = ?`).run(secret, groupId)
  return secret
}

/* ---------------- 同步 ---------------- */

/** 把自己的课表快照写进群组（「同步」按钮）。返回写入后的成员行。 */
export function syncShareMember(userId: number, groupId: number): MemberRow {
  requireMembership(userId, groupId)
  const snap = buildSnapshot(userId)
  db.prepare(`UPDATE share_members SET snapshot = ?, synced_at = datetime('now') WHERE group_id = ? AND user_id = ?`).run(
    JSON.stringify(snap),
    groupId,
    userId
  )
  return getMemberRow(groupId, userId)!
}

/** 切换"是否共享课程明细"（仅情侣形态有意义） */
export function setShareMemberPrivacy(userId: number, groupId: number, showDetail: boolean): MemberRow {
  requireMembership(userId, groupId)
  db.prepare(`UPDATE share_members SET show_detail = ? WHERE group_id = ? AND user_id = ?`).run(
    showDetail ? 1 : 0,
    groupId,
    userId
  )
  return getMemberRow(groupId, userId)!
}

/* ---------------- 移除 / 退出 ---------------- */

/**
 * 移除成员。
 * 群主可以移除任意成员（包括自己以外的人）；**任何人都可以移除自己**（= 退出）。
 * 群主移除自己 = 解散群组（群主走了，群就没人管了，留着只会变成孤儿数据）。
 */
export function removeShareMember(userId: number, groupId: number, memberId: number): { disbanded: boolean } {
  const { group } = requireMembership(userId, groupId)
  const target = getMemberById(groupId, memberId)
  if (!target) throw new HttpError(404, '该成员不在群组里')
  const isSelf = target.userId === userId
  if (!isSelf && group.ownerId !== userId) throw new HttpError(403, '只有群主可以移除成员')

  if (target.userId === group.ownerId) {
    // 群主离开 = 解散：否则群组会留下一个永远无法管理、也无人负责的空壳
    db.prepare(`DELETE FROM share_groups WHERE id = ?`).run(groupId)
    return { disbanded: true }
  }
  db.prepare(`DELETE FROM share_members WHERE id = ?`).run(memberId)
  return { disbanded: false }
}

/** 退出群组（群主 = 解散） */
export function leaveShareGroup(userId: number, groupId: number): { disbanded: boolean } {
  const { group } = requireMembership(userId, groupId)
  if (group.ownerId === userId) {
    db.prepare(`DELETE FROM share_groups WHERE id = ?`).run(groupId)
    return { disbanded: true }
  }
  db.prepare(`DELETE FROM share_members WHERE group_id = ? AND user_id = ?`).run(groupId, userId)
  return { disbanded: false }
}

/** 解散群组（群主专用，语义上比"退出"更明确，供管理弹层使用） */
export function disbandShareGroup(userId: number, groupId: number): void {
  requireOwner(userId, groupId)
  db.prepare(`DELETE FROM share_groups WHERE id = ?`).run(groupId)
}

/* ---------------- 情侣专用 ---------------- */

export function createCouple(userId: number, name?: unknown): GroupRow {
  return createShareGroup(userId, { kind: 'couple', name })
}

export function joinCouple(userId: number, secret: unknown): GroupRow {
  return joinShareGroup(userId, secret, 'couple')
}

/** 解除情侣绑定（任一方均可，删除整条绑定） */
export function unbindCouple(userId: number, groupId: number): void {
  const { group } = requireMembership(userId, groupId)
  if (group.kind !== 'couple') throw new HttpError(400, '这不是情侣绑定')
  db.prepare(`DELETE FROM share_groups WHERE id = ?`).run(groupId)
}

/* ---------------- 统计（管理员看板用） ---------------- */

export function shareStats(): { groups: number; couples: number; members: number } {
  const g = db.prepare(`SELECT COUNT(*) AS c FROM share_groups WHERE kind = 'group'`).get() as { c: number }
  const c = db.prepare(`SELECT COUNT(*) AS c FROM share_groups WHERE kind = 'couple'`).get() as { c: number }
  const m = db.prepare(`SELECT COUNT(*) AS c FROM share_members`).get() as { c: number }
  return { groups: g.c, couples: c.c, members: m.c }
}
