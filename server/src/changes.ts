/**
 * 校园数据变动检测。
 *
 * 解决的问题（参考仓库 domain/change/DataChange.kt 的同一思路）：
 *   用户同步一次，系统应该告诉他**"变了什么"**（新出成绩、作业改了截止时间、
 *   多了一场考试），而不是让他自己一个个页面翻着对比。
 *
 * 三条设计要点（都来自参考仓库踩过的坑）：
 *
 * 1. **按出现顺序配对重复身份**，不是按 key 查集合差。
 *    同一门课可能有多条同名作业（"第三章作业"出现两次很常见），
 *    简单的 `新集合 - 旧集合` 会把它们判重/判错。正确做法：
 *    按顺序两两配对，多出来的才是 added。
 *
 * 2. **recordSafely 语义**：变动检测失败不能让主数据同步失败。
 *    调用方（index.ts）用 try/catch 包住本模块，见那里的注释。
 *
 * 3. **只对"用户可感知的字段"做 diff**。
 *    快照只存归一化后的少量字段（截止时间、状态、分数…），
 *    否则学校页面改个无关的展示顺序就会误报"有变动"。
 */
import { createHash } from 'node:crypto'
import { db } from './db.js'
import { sendMessage } from './feedback.js'

export type DataChangeKind = 'added' | 'modified' | 'deleted'

export interface DataChange {
  domain: string
  kind: DataChangeKind
  /** 人类可读的条目名（用于站内信与前端摘要） */
  label: string
  /** 变动的字段明细（如 { end: '2026-10-20 23:00' }），用于前端展开 */
  detail: Record<string, string>
}

/** 一个可 diff 的条目：key 是身份，label 是给人看的名字，detail 是可感知字段 */
export interface SnapshotItem {
  key: string
  label: string
  detail: Record<string, string>
}

interface SnapshotRow {
  payload: string
  hash: string
  item_count: number
}

function hashOf(items: SnapshotItem[]): string {
  // 顺序敏感：作业/课程列表的顺序变化本身也算一种变动（新增项通常插在特定位置）
  return createHash('sha1').update(JSON.stringify(items)).digest('hex')
}

/**
 * 与上一条快照比对。
 *
 * @param prev 上一次的快照（无则视为首次同步，返回空数组 ——
 *             **首次同步绝不能报"全部新增"**，那会在用户第一次登录时
 *             塞进去几十条通知，把消息中心冲爆）
 */
export function detectDataChanges(prev: SnapshotItem[], next: SnapshotItem[]): DataChange[] {
  if (prev.length === 0) return []

  const changes: DataChange[] = []
  const prevIdx = new Map<string, number[]>()
  prev.forEach((it, i) => {
    const arr = prevIdx.get(it.key)
    if (arr) arr.push(i)
    else prevIdx.set(it.key, [i])
  })

  const usedPrev = new Set<number>()
  const usedNext = new Set<number>()

  /* 第一轮：按 key 的**出现顺序**两两配对，判定 modified。
     同名同 key 的重复条目按先后次序一一对应，多出来的留到第二轮。 */
  for (let i = 0; i < next.length; i += 1) {
    const cur = next[i]
    const pool = prevIdx.get(cur.key)
    if (!pool) continue
    const slot = pool.find((p) => !usedPrev.has(p))
    if (slot === undefined) continue
    usedPrev.add(slot)
    usedNext.add(i)

    if (JSON.stringify(prev[slot].detail) !== JSON.stringify(cur.detail)) {
      changes.push({ domain: '', kind: 'modified', label: cur.label, detail: cur.detail })
    }
  }

  /* 第二轮：新列表里没配上的 = added */
  for (let i = 0; i < next.length; i += 1) {
    if (usedNext.has(i)) continue
    changes.push({ domain: '', kind: 'added', label: next[i].label, detail: next[i].detail })
  }

  /* 第三轮：旧列表里没配上的 = deleted（教师撤回作业、成绩记录被删） */
  for (let i = 0; i < prev.length; i += 1) {
    if (usedPrev.has(i)) continue
    changes.push({ domain: '', kind: 'deleted', label: prev[i].label, detail: prev[i].detail })
  }

  return changes
}

const DOMAIN_LABEL: Record<string, string> = {
  homework: '课程平台作业',
  grades: '成绩',
  exams: '考试安排',
  timetable: '课程表',
  classroom: '空闲教室'
}

const KIND_LABEL: Record<DataChangeKind, string> = {
  added: '新增',
  modified: '变更',
  deleted: '移除'
}

/** 同一条站内信里最多列几条明细 —— 再多就该点进去看了，堆在通知里没人读 */
const MAX_DIGEST_ITEMS = 6

/**
 * 记录一次域快照，并返回相对上次的变动。
 *
 * @param domain 数据域（= AppEntry.id，如 homework / grades）
 * @param items  当前归一化快照
 * @param title  域的中文名（写站内信用）
 */
export function recordDomainChanges(
  userId: number,
  domain: string,
  items: SnapshotItem[],
  title?: string
): DataChange[] {
  const prevRow = db
    .prepare('SELECT payload, hash, item_count FROM data_snapshots WHERE user_id = ? AND domain = ?')
    .get(userId, domain) as SnapshotRow | undefined

  const hash = hashOf(items)
  let changes: DataChange[] = []

  if (prevRow) {
    // hash 相同 → 快速跳过，省掉逐项 diff
    if (prevRow.hash !== hash) {
      let prev: SnapshotItem[] = []
      try {
        prev = JSON.parse(prevRow.payload) as SnapshotItem[]
      } catch {
        prev = []
      }
      changes = detectDataChanges(prev, items).map((c) => ({ ...c, domain }))
    }
  }

  // 写回快照（upsert）
  db.prepare(
    `INSERT INTO data_snapshots (user_id, domain, payload, hash, item_count, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, domain) DO UPDATE SET
       payload = excluded.payload,
       hash = excluded.hash,
       item_count = excluded.item_count,
       updated_at = datetime('now')`
  ).run(userId, domain, JSON.stringify(items), hash, items.length)

  if (changes.length > 0) notifyChanges(userId, domain, changes, title)
  return changes
}

/**
 * 变动 → 站内信。best-effort：写失败只记 stderr，不影响调用方。
 */
function notifyChanges(userId: number, domain: string, changes: DataChange[], title?: string): void {
  const name = title ?? DOMAIN_LABEL[domain] ?? domain
  const counts = {
    added: changes.filter((c) => c.kind === 'added').length,
    modified: changes.filter((c) => c.kind === 'modified').length,
    deleted: changes.filter((c) => c.kind === 'deleted').length
  }
  const parts: string[] = []
  if (counts.added) parts.push(`新增 ${counts.added} 项`)
  if (counts.modified) parts.push(`变更 ${counts.modified} 项`)
  if (counts.deleted) parts.push(`移除 ${counts.deleted} 项`)

  const head = `${name}有更新：${parts.join('、')}`
  const lines = changes
    .slice(0, MAX_DIGEST_ITEMS)
    .map((c) => `· [${KIND_LABEL[c.kind]}] ${c.label}`)
  const more = changes.length > MAX_DIGEST_ITEMS ? `\n…以及另外 ${changes.length - MAX_DIGEST_ITEMS} 项` : ''

  try {
    sendMessage(userId, 'data_change', head, `${lines.join('\n')}${more}`)
  } catch (e) {
    console.warn(`[changes] ${name} 变动提醒投递失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 读某域的最近一次快照条目数（前端展示「上次同步 N 项」用） */
export function snapshotCount(userId: number, domain: string): number | null {
  const row = db
    .prepare('SELECT item_count FROM data_snapshots WHERE user_id = ? AND domain = ?')
    .get(userId, domain) as { item_count: number } | undefined
  return row ? row.item_count : null
}

export function domainLabel(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain
}
