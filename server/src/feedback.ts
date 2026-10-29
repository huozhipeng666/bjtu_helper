/**
 * 反馈工单（「联系管理员」的落地形态）。
 *
 * 与论坛的关系：论坛于 2026-10-01 整体下架，其帖子由
 * scripts/migrate-forum-to-feedback.mts 按作者迁为本表的工单（migrated_from_post_id 标记来源）。
 * 评论/点赞/蹲蹲/围观/话题不迁移 —— 公开讨论与私密工单不是同一种东西。
 *
 * 两条投递链路，职责严格区分：
 *   1. 站内信（messages 表）—— **权威链路**。管理员回复必然落库，用户下次打开就能看到。
 *   2. 邮件（smtp.ts）—— **附加提醒**，只在用户提交时通知管理员"有新的了，快来看"。
 * 之所以把邮件放在从属位置：SMTP 是外部依赖，会失败、会被限流、可能没配置。
 * 让"提交反馈"这个动作依赖邮件能发出去，等于把外部故障引到主流程上。
 * 因此 sendMail 的失败只记日志，接口照常返回成功。
 */

import { db, getDisplayName, tx } from './db.js'
import { escapeHtml, isMailConfigured, readSmtpConfig, sendMail } from './smtp.js'
/* 校验错误用 HttpError 而不是裸 Error：index.ts 的 fail() 按 instanceof HttpError 决定状态码，
   裸 Error 会掉进 500 兜底分支（曾经靠三处"Error→400"的包装来补救，现已统一到错误类型本身）。 */
import { HttpError } from './lib.js'

export type FeedbackType = 'bug' | 'suggestion' | 'consult' | 'other'
export type FeedbackStatus = 'pending' | 'replied' | 'closed'

export const FEEDBACK_TYPES: FeedbackType[] = ['bug', 'suggestion', 'consult', 'other']
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['pending', 'replied', 'closed']

export const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'Bug 报错',
  suggestion: '功能建议',
  consult: '使用咨询',
  other: '其他'
}

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  pending: '待处理',
  replied: '已回复',
  closed: '已关闭'
}

export interface Feedback {
  id: number
  userId: number
  author: string
  authorAvatar: string | null
  type: FeedbackType
  title: string
  content: string
  images: string[]
  contact: string
  status: FeedbackStatus
  /** 由论坛帖子迁移而来时记原帖 id；用户直接提交为 null */
  migratedFromPostId: number | null
  createdAt: string
  updatedAt: string
  replyCount: number
}

export interface FeedbackReply {
  id: number
  feedbackId: number
  adminId: number
  admin: string
  content: string
  createdAt: string
}

/* ---------------- 站内信 ---------------- */

/**
 * 投递一条站内信（通用入口）。
 *
 * 为什么要有这个统一函数，而不是各模块自己拼 INSERT：
 *   `messages.type` 有一份 CHECK 白名单（db.ts）、一份 TS 白名单（本文件的
 *   MESSAGE_TYPES）、一份前端白名单（types.ts 的 MessageType）——
 *   三处必须同步，历史上漏改过前端导致新类型**静默降级**成 system、点击路由失效。
 *   把写入收敛到一个入口后，至少服务端这两处不会各写各的。
 *
 * ⚠️ 本函数会抛错（供调用方自行决定是否 best-effort）。参考 plans.ts 的
 *   notifyPlan 与 index.ts 的变动提醒，都是自己 try/catch 包住的。
 */
export function sendMessage(userId: number, type: MessageType, title: string, body = ''): number {
  const r = db
    .prepare(`INSERT INTO messages (user_id, type, title, body) VALUES (?, ?, ?, ?)`)
    .run(userId, type, title, body)
  return Number(r.lastInsertRowid)
}

/** 站内信类型白名单：与 db.ts 的 messages.type CHECK 约束保持一致，改一处必须同步另一处 */
export const MESSAGE_TYPES = ['feedback_reply', 'system', 'couple_plan', 'data_change'] as const

export type MessageType = (typeof MESSAGE_TYPES)[number]

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_TYPES)

/** 把任意字符串收窄成已知站内信类型（未知一律兜底 system，保证前端拿到的 type 一定是可路由的） */
function asMessageType(raw: string): MessageType {
  return MESSAGE_TYPE_SET.has(raw) ? (raw as MessageType) : 'system'
}

export interface FeedbackMessage {
  id: number
  type: MessageType
  title: string
  body: string
  feedbackId: number | null
  read: boolean
  createdAt: string
}

/** 标题 / 正文长度上限，与前端表单的 maxLength 保持一致 */
const TITLE_MAX = 60
const CONTENT_MAX = 5000
const CONTACT_MAX = 60
const MAX_IMAGES = 9

/* ---------------- 行映射 ---------------- */

interface FeedbackRow {
  id: number
  user_id: number
  type: string
  title: string
  content: string
  images: string | null
  contact: string
  status: string
  migrated_from_post_id: number | null
  created_at: string
  updated_at: string
  author?: string | null
  author_avatar?: string | null
  reply_count?: number | null
}

/**
 * images 是 TEXT 列存的 JSON 数组，解析失败一律回退空数组。
 * 为什么不抛错：一条脏数据（历史迁移/手工改库造成）不该让整个反馈列表接口 500，
 * 那样用户连"反馈坏了"这件事都报不上来。
 */
function parseImages(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toFeedback(r: FeedbackRow): Feedback {
  return {
    id: r.id,
    userId: r.user_id,
    author: r.author ?? '',
    authorAvatar: r.author_avatar ?? null,
    type: (FEEDBACK_TYPES as string[]).includes(r.type) ? (r.type as FeedbackType) : 'other',
    title: r.title,
    content: r.content,
    images: parseImages(r.images),
    contact: r.contact ?? '',
    status: (FEEDBACK_STATUSES as string[]).includes(r.status) ? (r.status as FeedbackStatus) : 'pending',
    migratedFromPostId: r.migrated_from_post_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    replyCount: r.reply_count ?? 0
  }
}

/**
 * 列表查询的公共 SELECT。
 * reply_count 用相关子查询而不是 LEFT JOIN + GROUP BY：后者在有多个回复时会放大行数，
 * 需要再包一层 DISTINCT，写法更绕且容易在分页时算错总数。
 * 本场景每个工单回复数是个位数，子查询成本可忽略，换来的是可读性。
 */
const FEEDBACK_COLS = `
  f.id, f.user_id, f.type, f.title, f.content, f.images, f.contact, f.status,
  f.migrated_from_post_id, f.created_at, f.updated_at,
  COALESCE(u.nickname, u.username) AS author,
  u.avatar AS author_avatar,
  (SELECT COUNT(*) FROM feedback_replies r WHERE r.feedback_id = f.id) AS reply_count
`

/* ---------------- 用户侧 ---------------- */

export interface CreateFeedbackInput {
  type: FeedbackType
  title: string
  content: string
  images: string[]
  contact?: string
}

/**
 * 创建工单。校验在此集中完成（而不是放在路由里），
 * 因为迁移脚本也要走同一条校验路径，两处各写一遍必然会漂移。
 */
export function createFeedback(userId: number, input: CreateFeedbackInput): number {
  const type = (FEEDBACK_TYPES as string[]).includes(input.type) ? input.type : 'other'
  const title = input.title.trim()
  const content = input.content.trim()
  const contact = (input.contact ?? '').trim()
  if (!title) throw new HttpError(400, '标题不能为空')
  if (title.length > TITLE_MAX) throw new HttpError(400, `标题最多 ${TITLE_MAX} 字`)
  if (!content) throw new HttpError(400, '问题描述不能为空')
  if (content.length > CONTENT_MAX) throw new HttpError(400, `问题描述最多 ${CONTENT_MAX} 字`)
  if (contact.length > CONTACT_MAX) throw new HttpError(400, `联系方式最多 ${CONTACT_MAX} 字`)
  /* 图片仅接受本站 /uploads/ 相对路径（上传接口返回的），杜绝外链与路径注入 */
  const images = input.images
    .filter((x) => typeof x === 'string' && x.startsWith('/uploads/') && x.length <= 200)
    .slice(0, MAX_IMAGES)

  const r = db
    .prepare(
      `INSERT INTO feedbacks (user_id, type, title, content, images, contact)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, type, title, content, JSON.stringify(images), contact)
  return Number(r.lastInsertRowid)
}

export function listMyFeedbacks(userId: number): Feedback[] {
  const rows = db
    .prepare(
      `SELECT ${FEEDBACK_COLS}
       FROM feedbacks f JOIN users u ON u.id = f.user_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC, f.id DESC`
    )
    .all(userId) as unknown as FeedbackRow[]
  return rows.map(toFeedback)
}

/** 我提交过的工单总数与已回复数（个人中心首页的统计卡用） */
export function myFeedbackStats(userId: number): { total: number; replied: number; pending: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM feedbacks WHERE user_id = ?`
    )
    .get(userId) as unknown as { total: number; replied: number | null; pending: number | null }
  return { total: row.total ?? 0, replied: row.replied ?? 0, pending: row.pending ?? 0 }
}

function listReplies(feedbackId: number): FeedbackReply[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.feedback_id, r.admin_id, r.content, r.created_at,
              COALESCE(u.nickname, u.username) AS admin
       FROM feedback_replies r JOIN users u ON u.id = r.admin_id
       WHERE r.feedback_id = ?
       ORDER BY r.created_at ASC, r.id ASC`
    )
    .all(feedbackId) as unknown as {
    id: number
    feedback_id: number
    admin_id: number
    content: string
    created_at: string
    admin: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    feedbackId: r.feedback_id,
    adminId: r.admin_id,
    admin: r.admin,
    content: r.content,
    createdAt: r.created_at
  }))
}

/**
 * 取单个工单详情。
 * 权限判定收在这里而不是路由层：用户只能看自己的，管理员可看全部。
 * 若由调用方各自判断，迟早会有人漏掉一处 —— 那类漏洞不会报错，只会静默泄露。
 */
export function getFeedbackDetail(
  viewerId: number,
  isAdmin: boolean,
  id: number
): { feedback: Feedback; replies: FeedbackReply[] } | null {
  const row = db
    .prepare(
      `SELECT ${FEEDBACK_COLS}
       FROM feedbacks f JOIN users u ON u.id = f.user_id
       WHERE f.id = ?`
    )
    .get(id) as unknown as FeedbackRow | undefined
  if (!row) return null
  if (!isAdmin && row.user_id !== viewerId) return null
  return { feedback: toFeedback(row), replies: listReplies(id) }
}

/* ---------------- 管理侧 ---------------- */

export interface AdminListOptions {
  type?: FeedbackType
  status?: FeedbackStatus
  /** 标题/正文模糊搜索 */
  q?: string
  limit?: number
  offset?: number
}

export function listAllFeedbacks(opts: AdminListOptions = {}): { items: Feedback[]; total: number } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.type) {
    where.push('f.type = ?')
    params.push(opts.type)
  }
  if (opts.status) {
    where.push('f.status = ?')
    params.push(opts.status)
  }
  if (opts.q) {
    /* 2026-10-23 修（评审 A10）：LIKE 通配符（% _ \）必须转义，否则搜「100%」
       会匹配一切、搜索框退化成「不过滤」。ESCAPE '\' 声明转义字符。 */
    where.push("(f.title LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')")
    const like = `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    params.push(like, like)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM feedbacks f ${clause}`).get(...params) as unknown as { n: number }
  ).n

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT ${FEEDBACK_COLS}
       FROM feedbacks f JOIN users u ON u.id = f.user_id
       ${clause}
       ORDER BY
         /* 待处理优先浮到顶部：管理端最该先看到的就是"还没人管"的。
            用 CASE 排序而不是分两次查询，这样筛选/分页口径始终一致。 */
         CASE f.status WHEN 'pending' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END,
         f.created_at DESC, f.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as unknown as FeedbackRow[]
  return { items: rows.map(toFeedback), total }
}

export function feedbackStats(): {
  total: number
  pending: number
  replied: number
  closed: number
  byType: Record<FeedbackType, number>
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN status='closed'  THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN type='bug'        THEN 1 ELSE 0 END) AS bug,
              SUM(CASE WHEN type='suggestion' THEN 1 ELSE 0 END) AS suggestion,
              SUM(CASE WHEN type='consult'    THEN 1 ELSE 0 END) AS consult,
              SUM(CASE WHEN type='other'      THEN 1 ELSE 0 END) AS other
       FROM feedbacks`
    )
    .get() as unknown as Record<string, number | null>
  return {
    total: row.total ?? 0,
    pending: row.pending ?? 0,
    replied: row.replied ?? 0,
    closed: row.closed ?? 0,
    byType: {
      bug: row.bug ?? 0,
      suggestion: row.suggestion ?? 0,
      consult: row.consult ?? 0,
      other: row.other ?? 0
    }
  }
}

export function getFeedbackOwner(id: number): { userId: number; title: string } | null {
  const row = db.prepare(`SELECT user_id, title FROM feedbacks WHERE id = ?`).get(id) as unknown as
    | { user_id: number; title: string }
    | undefined
  return row ? { userId: row.user_id, title: row.title } : null
}

/**
 * 管理员回复。
 *
 * 一次事务里做三件事：写回复、把状态推到 replied、给用户投一条站内信。
 * 为什么必须原子：只写回复不改状态，工单会一直挂在"待处理"里被重复处理；
 * 只改状态不写站内信，用户永远不知道被回复了 —— 而站内信正是"用户能看到"的唯一保证。
 */
export function replyToFeedback(adminId: number, id: number, content: string): FeedbackReply | null {
  const text = content.trim()
  if (!text) throw new HttpError(400, '回复内容不能为空')
  if (text.length > CONTENT_MAX) throw new HttpError(400, `回复最多 ${CONTENT_MAX} 字`)

  const owner = getFeedbackOwner(id)
  if (!owner) return null
  const adminName = getDisplayName(adminId)

  let insertedId = 0
  /* 统一走 tx()（见 db.ts）：异常路径保证回滚，不会把连接留在事务里。 */
  tx(() => {
    const r = db
      .prepare(`INSERT INTO feedback_replies (feedback_id, admin_id, content) VALUES (?, ?, ?)`)
      .run(id, adminId, text)
    insertedId = Number(r.lastInsertRowid)
    db.prepare(`UPDATE feedbacks SET status = 'replied', updated_at = datetime('now') WHERE id = ?`).run(id)
    db.prepare(
      `INSERT INTO messages (user_id, type, title, body, feedback_id)
       VALUES (?, 'feedback_reply', ?, ?, ?)`
    ).run(owner.userId, `你的反馈「${owner.title}」有回复了`, text.slice(0, 200), id)
  })
  return {
    id: insertedId,
    feedbackId: id,
    adminId,
    admin: adminName,
    content: text,
    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
  }
}

export function setFeedbackStatus(id: number, status: FeedbackStatus): boolean {
  if (!(FEEDBACK_STATUSES as string[]).includes(status)) throw new HttpError(400, '无效的状态')
  const r = db
    .prepare(`UPDATE feedbacks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id)
  return r.changes > 0
}

/* ---------------- 站内信查询 ---------------- */

export function listMessages(userId: number, unreadOnly = false): FeedbackMessage[] {
  const rows = db
    .prepare(
      `SELECT id, type, title, body, feedback_id, read, created_at
       FROM messages
       WHERE user_id = ?${unreadOnly ? ' AND read = 0' : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT 200`
    )
    .all(userId) as unknown as {
    id: number
    type: string
    title: string
    body: string
    feedback_id: number | null
    read: number
    created_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    /* 只放行已知类型，其余兜底成 system。
       ⚠️ 早先的写法是 `type === 'feedback_reply' ? 'feedback_reply' : 'system'`，
       属于「白名单只列了一个」——新增 couple_plan 后 DB 里是对的、接口却一律吐 system，
       前端据此路由点击就会失效（且静默，不报错）。这里改为显式列举已知类型。 */
    type: asMessageType(r.type),
    title: r.title,
    body: r.body,
    feedbackId: r.feedback_id,
    read: r.read === 1,
    createdAt: r.created_at
  }))
}

export function unreadMessageCount(userId: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND read = 0`).get(userId) as unknown as {
    n: number
  }
  return row.n
}

export function markMessageRead(userId: number, id: number): boolean {
  // 带 user_id 条件：否则任何人猜到 id 就能标记别人的消息（越权写）
  const r = db.prepare(`UPDATE messages SET read = 1 WHERE id = ? AND user_id = ?`).run(id, userId)
  return r.changes > 0
}

export function markAllMessagesRead(userId: number): number {
  const r = db.prepare(`UPDATE messages SET read = 1 WHERE user_id = ? AND read = 0`).run(userId)
  // node:sqlite 的 changes 是 number | bigint（大结果集用 bigint），统一收敛成 number
  return Number(r.changes)
}

/* ---------------- 邮件通知管理员 ---------------- */

/**
 * 新工单落库后提醒管理员。**刻意不 await、不抛错**（fire-and-forget）。
 *
 * 为什么不等：SMTP 一次往返可能几秒（连接 + TLS + 认证 + 投递）。
 * 让用户提交后干等几秒只为发一封"给管理员的提醒"，体验上完全不划算 ——
 * 工单已经落库了，管理员在后台一定看得到，邮件只是加速。
 */
export function notifyAdminsByMail(feedback: Feedback): void {
  if (!isMailConfigured()) return
  const cfg = readSmtpConfig()
  if (!cfg) return

  const typeLabel = FEEDBACK_TYPE_LABEL[feedback.type]
  const subject = `[北交大助手] 新反馈 · ${typeLabel} · ${feedback.title}`
  const text = [
    `类型：${typeLabel}`,
    `标题：${feedback.title}`,
    `提交人：${feedback.author}（用户 id ${feedback.userId}）`,
    `联系方式：${feedback.contact || '未填写'}`,
    `图片：${feedback.images.length > 0 ? feedback.images.join('\n      ') : '无'}`,
    `时间：${feedback.createdAt}`,
    '',
    '问题描述：',
    feedback.content
  ].join('\n')

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.7;color:#222">
  <h2 style="margin:0 0 12px;font-size:17px">新反馈 · ${escapeHtml(typeLabel)}</h2>
  <table style="border-collapse:collapse;font-size:14px">
    <tr><td style="padding:3px 12px 3px 0;color:#888">标题</td><td>${escapeHtml(feedback.title)}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#888">提交人</td><td>${escapeHtml(feedback.author)}（用户 id ${feedback.userId}）</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#888">联系方式</td><td>${escapeHtml(feedback.contact || '未填写')}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#888">时间</td><td>${escapeHtml(feedback.createdAt)}</td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#888">工单号</td><td>#${feedback.id}</td></tr>
  </table>
  <pre style="white-space:pre-wrap;word-break:break-word;background:#f6f7f9;padding:12px;border-radius:8px;font-size:14px;margin-top:12px">${escapeHtml(
    feedback.content
  )}</pre>
  ${feedback.images.length > 0 ? `<p style="font-size:13px;color:#888">附件图片 ${feedback.images.length} 张，请在管理后台查看。</p>` : ''}
</div>`

  /* 评审 B12（2026-10-23）：显式 .catch 兜住 reject。当前 sendMail 全量自 catch，
     但那是实现细节不是契约 —— 未来改动一旦让 promise reject，这里就是
     unhandledRejection（通知失败不该打挂主流程）。 */
  void sendMail({ to: cfg.admins, subject, text, html })
    .then((r) => {
      if (!r.sent) console.warn(`[feedback] 新工单 #${feedback.id} 邮件通知未送达：${r.reason ?? '未知原因'}`)
    })
    .catch((err) => {
      console.warn(`[feedback] 新工单 #${feedback.id} 邮件通知发送异常：${err instanceof Error ? err.message : err}`)
    })
}

/** 读取刚创建的工单（用于发通知邮件时拿到 author 等 join 字段） */
export function getFeedbackById(id: number): Feedback | null {
  const row = db
    .prepare(
      `SELECT ${FEEDBACK_COLS}
       FROM feedbacks f JOIN users u ON u.id = f.user_id
       WHERE f.id = ?`
    )
    .get(id) as unknown as FeedbackRow | undefined
  return row ? toFeedback(row) : null
}

/* ---------------- 论坛迁移 ---------------- */

export interface MigrationResult {
  scanned: number
  migrated: number
  skipped: number
}

/**
 * 把论坛帖子本体迁为反馈工单（幂等）。
 *
 * 只迁「帖子」本身：标题/正文/图片/作者/时间。评论、点赞、蹲蹲、围观、话题一律不迁 ——
 *   评论是**别人**写的公开讨论，迁进工单会被当成"管理员的历史回复"，语义完全错位；
 *   点赞/蹲蹲/围观是社交指标，工单没有对应概念；
 *   话题（topics）是论坛的分类维度，反馈用的是 type，两套分类无法一一对应。
 *
 * 幂等靠 migrated_from_post_id 的 UNIQUE 约束：重复执行时 INSERT OR IGNORE 直接跳过，
 * 不会产生重复工单。这一点很重要 —— 迁移脚本一定会被跑第二次（失败重试、换机重跑）。
 *
 * 图片引用会一起带过来，因此 uploads.ts 的孤儿清理器必须把 feedbacks.images 也算作引用来源，
 * 否则迁移完成后旧帖图片会在 24 小时后被当成孤儿删掉。
 */
export function migrateForumPosts(): MigrationResult {
  let rows: { id: number; user_id: number; title: string; content: string; images: string | null; created_at: string }[]
  try {
    rows = db
      .prepare(`SELECT id, user_id, title, content, images, created_at FROM posts ORDER BY id ASC`)
      .all() as unknown as typeof rows
  } catch {
    // posts 表不存在（全新部署）：不是错误，直接视为无数据可迁
    return { scanned: 0, migrated: 0, skipped: 0 }
  }

  let migrated = 0
  let skipped = 0
  tx(() => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO feedbacks
         (user_id, type, title, content, images, contact, status, migrated_from_post_id, created_at, updated_at)
       VALUES (?, 'other', ?, ?, ?, '', 'pending', ?, ?, ?)`
    )
    for (const p of rows) {
      // 作者已注销（外键 CASCADE 本应带走，但手工改过库的情况防一手）
      const owner = db.prepare(`SELECT id FROM users WHERE id = ?`).get(p.user_id)
      if (!owner) {
        skipped += 1
        continue
      }
      const r = ins.run(
        p.user_id,
        p.title,
        p.content,
        p.images ?? '[]',
        p.id,
        p.created_at,
        p.created_at
      )
      if (Number(r.changes) > 0) migrated += 1
      else skipped += 1
    }
  })
  return { scanned: rows.length, migrated, skipped }
}
