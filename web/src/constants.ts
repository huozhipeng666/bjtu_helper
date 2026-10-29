import type { FeedbackStatus, FeedbackType, Priority, TaskType, Urgency } from './types'

export const COURSE_COLORS = [
  '#4f7cff', '#ff6b6b', '#20c997', '#ffa94d', '#845ef7',
  '#f783ac', '#12b886', '#ffd43b', '#4dabf7', '#e8590c'
]

export const URGENCY_LABEL: Record<Urgency, string> = {
  overdue: '已逾期',
  today: '今天截止',
  tomorrow: '明天截止',
  thisWeek: '本周',
  upcoming: ''
}

/**
 * 空闲课表：一个用户最多能加入的群组数（与 server/src/share.ts 的 MAX_GROUPS_PER_USER 一致）。
 * 前端用它做「已达上限」的提示与按钮禁用，服务端才是真正的拦截 —— 改这里不会放宽限制。
 */
export const MAX_GROUPS_PER_USER = 20

export const TYPE_LABEL: Record<TaskType, string> = {
  homework: '作业',
  exam: '考试',
  other: '其他'
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export const PRIORITY_COLOR: Record<Priority, string> = {
  high: '#e5484d',
  medium: '#f5a623',
  low: '#9ca3af'
}

/** #rrggbb -> rgba(r,g,b,a) */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/* ---------------- 反馈工单 ---------------- */

/** 与 server/src/feedback.ts 的 FEEDBACK_TYPE_LABEL 保持一致 */
export const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'Bug 报错',
  suggestion: '功能建议',
  consult: '使用咨询',
  other: '其他'
}

/** 类型选择器上的引导文案（帮用户选对分类，比只给一个名词更有效） */
export const FEEDBACK_TYPE_HINT: Record<FeedbackType, string> = {
  bug: '功能出错、页面异常、数据不对',
  suggestion: '希望增加或改进某个功能',
  consult: '不知道怎么用、想找人问问',
  other: '以上都不太合适'
}

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  pending: '待处理',
  replied: '已回复',
  closed: '已关闭'
}
