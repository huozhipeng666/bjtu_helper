/**
 * DDL 分组：把任务列表切成「今日 / 逾期 / 明天 / 本周稍后 / 更晚 + 已完成」。
 *
 * 为什么从 DDLView 里抽出来（2026-10-27）：
 *   原来这段计算写在组件的 useMemo 里，而 urgency 又在**每一行渲染时**再算一次
 *   （`urgenyOf(sectionOf(t, …))`）。于是「勾选一条任务」引起的刷新要把全部任务
 *   分档两遍，列表越长越明显。抽成纯函数后：一次遍历同时得到分组、逾期数、
 *   待办数与每条的 urgency，调用方只读结果。
 *
 * 分组顺序（SECTIONS）刻意是「今日 → 逾期 → 明天 → 本周稍后 → 更晚」：
 * 先看今天要交什么，再翻历史的逾期账。Map 用插入顺序保留了这个次序。
 */

import type { Task, Urgency } from '../types'
import { daysBetween } from './date'

export type SectionKey = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later'

/** 分组的展示顺序：今日截止排在已逾期前面 */
export const SECTION_KEYS: SectionKey[] = ['today', 'overdue', 'tomorrow', 'thisWeek', 'later']

/** 按截止日相对「今天 / 本周日」落到哪一档；与 DDLView 旧实现逐条一致 */
export function sectionOf(dueDate: string, todayISO: string, weekEndISO: string): SectionKey {
  const diff = daysBetween(todayISO, dueDate)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (dueDate <= weekEndISO) return 'thisWeek'
  return 'later'
}

/**
 * 分档结果的紧迫度：
 * 「更晚」对外统一叫 upcoming（getUrgency 的同一套词），其余档位名与 Urgency 同名。
 */
export function urgencyOfSection(section: SectionKey): Urgency {
  return section === 'later' ? 'upcoming' : section
}

export interface SectionedTasks {
  /** 五档全在（即使为空），键顺序即展示顺序 */
  groups: Map<SectionKey, Task[]>
  /** 已完成的，保持输入顺序 */
  done: Task[]
  /** 未完成的总数 */
  pendingCount: number
  /** 逾期未完成的数量 */
  overdueCount: number
  /** 每条任务的紧迫度（只对未完成的有意义），供列表直接取用，避免二次计算 */
  urgencyById: Map<number, Urgency>
}

/**
 * 一次遍历切档。
 *
 * 入参 tasks 应当**已经过筛选**（课程 / 类型）—— 本函数不做筛选，
 * 只负责分档，这样调用方的筛选逻辑保持单一职责。
 */
export function sectionTasks(tasks: readonly Task[], todayISO: string, weekEndISO: string): SectionedTasks {
  const groups = new Map<SectionKey, Task[]>()
  for (const k of SECTION_KEYS) groups.set(k, [])
  const done: Task[] = []
  const urgencyById = new Map<number, Urgency>()
  let pendingCount = 0
  let overdueCount = 0
  for (const t of tasks) {
    if (t.status === 'done') {
      done.push(t)
      continue
    }
    const sec = sectionOf(t.dueDate, todayISO, weekEndISO)
    groups.get(sec)!.push(t)
    urgencyById.set(t.id, urgencyOfSection(sec))
    pendingCount++
    if (sec === 'overdue') overdueCount++
  }
  return { groups, done, pendingCount, overdueCount, urgencyById }
}
