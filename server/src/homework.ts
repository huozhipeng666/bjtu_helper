/**
 * 课程平台作业（智慧课程平台 → 作业 / 课程设计 / 实验报告）。
 *
 * 数据的**抓取**早已在 mis.ts 的 misFetchAll 里跑通了（bksyFetchHomeworks），
 * 但它当时只是作为「顺手带出来的副产品」返回给前端后就被丢弃。
 * 本模块负责后半段：**落库 + 查询 + 变动检测接入**。
 *
 * 为什么不复用 tasks 表：见 db.ts 中 homework_items 表头注释
 * （作业是学校下发的客观事实，与用户自建的 DDL 语义不同，混表会互相污染）。
 *
 * 提交作业（写操作）：2026-10-22 起已实现，见 homeworkSubmit.ts ——
 *   端点用学生端的 `homeworkUpload.shtml`（参考仓库注释确认 `rpUpload.shtml`
 *   是**老师端**），附件 multipart、回执判据、提交后回读验证都在那一份实现里。
 */
import { db, tx } from './db.js'
import { localStamp } from './date.js'
import type { BksyHomework } from './bksy.js'

export interface HomeworkRow {
  id: number
  upId: number
  snId: number | null
  courseId: number
  courseName: string
  title: string
  content: string
  createDate: string
  openDate: string
  endTime: string
  status: number
  subStatus: string
  submitCount: number
  allCount: number
  score: string
  homeworkType: number
  syncedAt: string
}

/** 前端视图：在行数据上加「服务端算好的截止状态」 */
export interface HomeworkView extends HomeworkRow {
  /**
   * 截止状态。**未知时不猜** —— 平台没给截止时间就返回 'unknown'，
   * 前端据此显示中性灰，而不是默认"还有时间"（那会让用户错过 deadline）。
   */
  deadlineState: 'submitted' | 'dueSoon' | 'overdue' | 'open' | 'unknown'
  /** 是否已提交（由 subStatus 判定，绝不用"有 snId"判定 —— 草稿也有 snId） */
  submitted: boolean
}

const TYPE_LABEL: Record<number, string> = { 0: '作业', 1: '课程设计', 2: '实验报告' }

/** 平台中文提交状态 → 是否已提交。仅在明确含「已提交/已批阅」时才为真。 */
export function isSubmitted(subStatus: string): boolean {
  const s = subStatus.trim()
  if (!s) return false
  // 「未提交」「尚未提交」里也含"提交"二字，必须先排除否定式
  if (/未提交|尚[未无]提交|待提交/.test(s)) return false
  return /已提交|已批阅|已评分|已评阅/.test(s)
}

/**
 * 截止状态判定。
 *
 * ⚠️ 时间比较必须用 localStamp()。平台给的 end_time 是「本地墙上时间」
 * （用户看到 23:00 截止，那就是本地 23:00），与它比较的"现在"也必须是本地墙上时间。
 * 用 toISOString() 会拿到 UTC，东八区会差 8 小时 —— 表现为"明明还有 8 小时，
 * 却显示已逾期"，或反之。
 */
export function deadlineStateOf(row: { endTime: string; subStatus: string; status: number }): HomeworkView['deadlineState'] {
  if (isSubmitted(row.subStatus)) return 'submitted'
  const end = row.endTime.trim()
  if (!end) return 'unknown'
  const now = localStamp()
  if (end < now) return 'overdue'
  // 48 小时内算「即将截止」—— 与 DDL 页的紧急阈值保持一致
  const soon = localStamp(new Date(Date.now() + 48 * 3600 * 1000))
  return end <= soon ? 'dueSoon' : 'open'
}

/** BksyHomework → 落库行（字段名转换集中在这里，改平台字段只改一处） */
function toRow(h: BksyHomework): Omit<HomeworkRow, 'id' | 'syncedAt'> {
  return {
    upId: h.upId,
    snId: h.snId,
    courseId: h.courseId,
    courseName: h.courseName,
    title: h.title,
    content: h.content,
    createDate: h.createDate,
    openDate: h.openDate,
    endTime: h.endTime,
    status: h.status,
    subStatus: h.subStatus,
    submitCount: h.submitCount,
    allCount: h.allCount,
    score: h.score,
    homeworkType: h.homeworkType
  }
}

/**
 * 把一次同步抓到的作业批量落库（UPSERT）。
 *
 * ⚠️ 刻意**不做「删掉本次没抓到的作业」**：
 *   平台的作业列表接口按课程分页，某门课这一次请求失败（网络抖动）时
 *   该课作业会整体缺席。若据此删除，用户会看到作业"凭空消失"，
 *   下一次同步又"复活" —— 比不删糟糕得多。
 *   教师撤回的作业由 synced_at 自然过期（list 里只展示最近一次同步批次可见的）。
 *
 * @returns 落库条数
 */
export function upsertHomeworks(userId: number, items: BksyHomework[]): number {
  if (items.length === 0) return 0
  const stmt = db.prepare(
    `INSERT INTO homework_items
       (user_id, up_id, sn_id, course_id, course_name, title, content, create_date, open_date,
        end_time, status, sub_status, submit_count, all_count, score, homework_type, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, up_id) DO UPDATE SET
       sn_id = excluded.sn_id,
       course_id = excluded.course_id,
       course_name = excluded.course_name,
       title = excluded.title,
       content = excluded.content,
       create_date = excluded.create_date,
       open_date = excluded.open_date,
       end_time = excluded.end_time,
       status = excluded.status,
       sub_status = excluded.sub_status,
       submit_count = excluded.submit_count,
       all_count = excluded.all_count,
       score = excluded.score,
       homework_type = excluded.homework_type,
       synced_at = datetime('now')`
  )
  let n = 0
  /* 统一走 tx()（见 db.ts）：手写 BEGIN/COMMIT 的 catch 里若 ROLLBACK 本身也失败，
     原始错误会被覆盖；tx() 内部已处理，且用 BEGIN IMMEDIATE 提前暴露锁冲突。 */
  tx(() => {
    for (const it of items) {
      const r = toRow(it)
      stmt.run(
        userId, r.upId, r.snId, r.courseId, r.courseName, r.title, r.content, r.createDate,
        r.openDate, r.endTime, r.status, r.subStatus, r.submitCount, r.allCount, r.score, r.homeworkType
      )
      n += 1
    }
  })
  return n
}

/** 列出全部作业（按截止时间升序，无截止时间的排最后） */
export function listHomeworks(userId: number): HomeworkView[] {
  const rows = db
    .prepare(
      `SELECT id, up_id, sn_id, course_id, course_name, title, content, create_date, open_date,
              end_time, status, sub_status, submit_count, all_count, score, homework_type, synced_at
       FROM homework_items
       WHERE user_id = ?
       ORDER BY (end_time = '') ASC, end_time ASC, id DESC`
    )
    .all(userId) as unknown as {
    id: number
    up_id: number
    sn_id: number | null
    course_id: number
    course_name: string
    title: string
    content: string
    create_date: string
    open_date: string
    end_time: string
    status: number
    sub_status: string
    submit_count: number
    all_count: number
    score: string
    homework_type: number
    synced_at: string
  }[]

  return rows.map((r) => {
    const base: HomeworkRow = {
      id: r.id,
      upId: r.up_id,
      snId: r.sn_id,
      courseId: r.course_id,
      courseName: r.course_name,
      title: r.title,
      content: r.content,
      createDate: r.create_date,
      openDate: r.open_date,
      endTime: r.end_time,
      status: r.status,
      subStatus: r.sub_status,
      submitCount: r.submit_count,
      allCount: r.all_count,
      score: r.score,
      homeworkType: r.homework_type,
      syncedAt: r.synced_at
    }
    return {
      ...base,
      submitted: isSubmitted(r.sub_status),
      deadlineState: deadlineStateOf(base)
    }
  })
}

export function homeworkTypeLabel(t: number): string {
  return TYPE_LABEL[t] ?? '作业'
}

/* ---------------- 详情缓存（正文 + 老师附件） ---------------- */

/** 对外可见的附件（`sourcePath` 已剥离，只用于服务端下载） */
export interface HomeworkAttachmentView {
  id: number
  fileName: string
  /** 0 = 平台没给大小（不是空文件），前端据此不显示 */
  sizeBytes: number
}

export interface HomeworkDetailView {
  upId: number
  content: string
  attachments: HomeworkAttachmentView[]
  /** 缓存时间（本地墙上时间），前端用它显示「缓存于 …」 */
  fetchedAt: string
}

/**
 * 读取缓存的详情。
 *
 * ⚠️ 缓存里的 `sourcePath` 在这里**必须丢掉** —— 它是平台内部路径，
 *   前端拿到也只能拼出无效 URL，还会泄露资源目录结构。
 *   下载走 `/api/homework/attachment`，由服务端从缓存重新取 path。
 */
export function getHomeworkDetail(userId: number, upId: number): HomeworkDetailView | null {
  const row = db
    .prepare(
      `SELECT up_id, content, attachments, fetched_at FROM homework_details WHERE user_id = ? AND up_id = ?`
    )
    .get(userId, upId) as
    | { up_id: number; content: string; attachments: string; fetched_at: string }
    | undefined
  if (!row) return null
  return {
    upId: row.up_id,
    content: row.content,
    attachments: sanitizeAttachments(parseAttachmentsJson(row.attachments)),
    fetchedAt: row.fetched_at
  }
}

/** 取单个附件的原始存储路径（**仅服务端下载用**，不要返回给前端） */
export function getHomeworkAttachmentPath(
  userId: number,
  upId: number,
  attachmentId: number
): { sourcePath: string; fileName: string } | null {
  const row = db
    .prepare(`SELECT attachments FROM homework_details WHERE user_id = ? AND up_id = ?`)
    .get(userId, upId) as { attachments: string } | undefined
  if (!row) return null
  const hit = parseAttachmentsJson(row.attachments).find((a) => a.id === attachmentId)
  if (!hit) return null
  return { sourcePath: hit.sourcePath, fileName: hit.fileName }
}

interface StoredAttachment {
  id: number
  fileName: string
  sizeBytes: number
  sourcePath: string
}

function parseAttachmentsJson(raw: string): StoredAttachment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: StoredAttachment[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = Number(o.id)
    if (!Number.isInteger(id) || id <= 0) continue
    out.push({
      id,
      fileName: String(o.fileName ?? ''),
      sizeBytes: Number(o.sizeBytes) || 0,
      sourcePath: String(o.sourcePath ?? '')
    })
  }
  return out
}

function sanitizeAttachments(list: StoredAttachment[]): HomeworkAttachmentView[] {
  return list.map((a) => ({ id: a.id, fileName: a.fileName, sizeBytes: a.sizeBytes }))
}

/** 写入/更新详情缓存 */
export function upsertHomeworkDetail(
  userId: number,
  upId: number,
  content: string,
  attachments: StoredAttachment[]
): void {
  db.prepare(
    `INSERT INTO homework_details (user_id, up_id, content, attachments, fetched_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, up_id) DO UPDATE SET
       content = excluded.content,
       attachments = excluded.attachments,
       fetched_at = excluded.fetched_at`
  ).run(userId, upId, content, JSON.stringify(attachments))
}

/** 转成变动检测用的归一化快照（只留用户可感知的字段） */
export function homeworkFingerprint(userId: number): { key: string; label: string; detail: Record<string, string> }[] {
  return listHomeworks(userId).map((h) => ({
    key: `${h.courseId}:${h.upId}`,
    label: `${h.courseName ? `${h.courseName} · ` : ''}${h.title}`,
    detail: {
      end: h.endTime,
      sub: h.subStatus,
      score: h.score
    }
  }))
}
