/**
 * 变动摘要的展示逻辑（与 UI 解耦，便于单测）。
 */

const DOMAIN_LABEL: Record<string, string> = {
  homework: '课程平台作业',
  grades: '成绩',
  exams: '考试安排',
  timetable: '课程表',
  classroom: '空闲教室'
}

export function domainLabelOf(domain: string): string {
  return DOMAIN_LABEL[domain] ?? domain
}

export interface DigestSummary {
  added: number
  modified: number
  deleted: number
  total: number
}

export function summarize(changes: { kind: 'added' | 'modified' | 'deleted' }[]): DigestSummary {
  return {
    added: changes.filter((c) => c.kind === 'added').length,
    modified: changes.filter((c) => c.kind === 'modified').length,
    deleted: changes.filter((c) => c.kind === 'deleted').length,
    total: changes.length
  }
}

/** 一句话概括（用于通知列表的副标题） */
export function summaryText(changes: { kind: 'added' | 'modified' | 'deleted' }[]): string {
  const s = summarize(changes)
  if (s.total === 0) return '无变动'
  const parts: string[] = []
  if (s.added) parts.push(`新增 ${s.added}`)
  if (s.modified) parts.push(`变更 ${s.modified}`)
  if (s.deleted) parts.push(`移除 ${s.deleted}`)
  return parts.join(' · ')
}
