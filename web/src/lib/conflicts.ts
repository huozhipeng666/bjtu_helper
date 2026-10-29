/**
 * 课程时间冲突检测 —— 判定口径为「同一天 + 节次区间重叠 + 周次集合有交集」。
 *
 * 为什么必须落到周次集合，而不是周区间：
 *  - 第 1-8 周上课的 A 与第 9-16 周上课的 B，周区间相邻但永不同周上课，不该报冲突；
 *  - 单周课（1,3,5…）与双周课（2,4,6…）周区间完全重叠，但同样永不同周上课，也不该报冲突。
 * 所以「是否冲突」= 「是否存在某一个自然周，两门课都要上」——只有周号集合能准确表达。
 *
 * 周次展开复用 lib/weeks.ts 的 expandWeeks（与课表筛选用的周次工具同源，
 * 服务端 lib.ts 的 courseHitsWeek 也是同一套口径），避免出现「课表显示有课但检测说不冲突」
 * 这类前后不一致。
 */
import type { WeekType } from '../types'
import { compressWeeks, expandWeeks } from './weeks'

/** 冲突判定所需的字段子集：Course / MisCourse / 表单草稿都满足（后三项可省） */
export interface ConflictSubject {
  name: string
  /** 1=周一 … 7=周日 */
  dayOfWeek: number
  startPeriod: number
  endPeriod: number
  /** 精确周集合；非空时优先于下面的区间三元组 */
  weeks?: number[] | null
  weekStart?: number | null
  weekEnd?: number | null
  weekType?: WeekType | null
}

/**
 * 冲突类型：
 *  - overlapping：同一天同一时段、周次有交集的两门（不同）课 —— 真正的排课冲突；
 *  - duplicate：名称与节次完全相同且周次有交集 —— 重复录入（教务页面重复条目 / 手滑重复添加）。
 */
export type ConflictKind = 'overlapping' | 'duplicate'

export interface ConflictPair<T extends ConflictSubject> {
  a: T
  b: T
  kind: ConflictKind
  /** 两门课共同的上课周（升序去重）——非空才构成冲突，可直接展示给用户 */
  weeks: number[]
}

/** 取课程的有效周集合：weeks 优先，否则按区间 + 单双周展开 */
export function courseWeeks(c: ConflictSubject): number[] {
  if (c.weeks && c.weeks.length > 0) {
    return [...new Set(c.weeks)].filter((w) => Number.isFinite(w)).sort((x, y) => x - y)
  }
  const s = c.weekStart ?? 1
  const e = c.weekEnd ?? s
  return expandWeeks(s, e, (c.weekType ?? 'all') as WeekType)
}

/** 节次区间是否重叠（含端点相接，如 1-2 与 2-3 算重叠） */
function periodsOverlap(a: ConflictSubject, b: ConflictSubject): boolean {
  return a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod
}

/** 判定两门课是否冲突；不冲突返回 null */
export function detectConflict<T extends ConflictSubject>(a: T, b: T): ConflictPair<T> | null {
  if (a.dayOfWeek !== b.dayOfWeek) return null
  if (!periodsOverlap(a, b)) return null
  const setB = new Set(courseWeeks(b))
  const weeks = courseWeeks(a).filter((w) => setB.has(w))
  if (weeks.length === 0) return null
  const kind: ConflictKind =
    a.name.trim() === b.name.trim() && a.startPeriod === b.startPeriod && a.endPeriod === b.endPeriod
      ? 'duplicate'
      : 'overlapping'
  return { a, b, kind, weeks }
}

/**
 * 在一组课程里两两找冲突（用于「待导入的整份课表」这类同列表内部自查）。
 * 先按星期分桶再桶内两两比较：课程量级只有几十，O(n²) 完全够用，
 * 分桶只是让同一份数据里的无效比较少一个数量级。
 */
export function findConflicts<T extends ConflictSubject>(list: T[]): ConflictPair<T>[] {
  const byDay = new Map<number, T[]>()
  for (const c of list) {
    const arr = byDay.get(c.dayOfWeek)
    if (arr) arr.push(c)
    else byDay.set(c.dayOfWeek, [c])
  }
  const out: ConflictPair<T>[] = []
  for (const group of byDay.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const hit = detectConflict(group[i], group[j])
        if (hit) out.push(hit)
      }
    }
  }
  return out
}

/** 候选课程（正在编辑/准备添加的那门）与其它已有课程的冲突 */
export function conflictsWith<T extends ConflictSubject>(
  candidate: T,
  others: T[]
): ConflictPair<T>[] {
  const out: ConflictPair<T>[] = []
  for (const o of others) {
    const hit = detectConflict(candidate, o)
    if (hit) out.push(hit)
  }
  return out
}

/* ---------------- 展示文案 ---------------- */

const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `周${dayOfWeek}`
}

/** 节次区间文案：3-4 → "3-4 节"；5 → "5 节" */
export function formatPeriods(startPeriod: number, endPeriod: number): string {
  return startPeriod === endPeriod ? `${startPeriod} 节` : `${startPeriod}-${endPeriod} 节`
}

/** 时间点文案：周三 3-4 节 */
export function formatWhen(c: ConflictSubject): string {
  return `${dayName(c.dayOfWeek)} ${formatPeriods(c.startPeriod, c.endPeriod)}`
}

/** 共同周次文案：1-16 → "1-16 周" */
export function formatConflictWeeks(weeks: number[]): string {
  return `${compressWeeks(weeks)} 周`
}

/** 课程名兜底：新建课程时名称还是空的，直接展示会变成「」 */
function labelOf(c: ConflictSubject): string {
  return c.name.trim() || '未命名课程'
}

function verbOf(kind: ConflictKind): string {
  return kind === 'duplicate' ? '重复' : '冲突'
}

/**
 * 同一份课表内部自查的文案（导入预览用），例：
 *  「数据结构」（周三 3-4 节）与「计算机网络」（周三 4-5 节）冲突 · 共同周次 1-16 周
 */
export function describePair<T extends ConflictSubject>(pair: ConflictPair<T>): string {
  return (
    `「${labelOf(pair.a)}」（${formatWhen(pair.a)}）与「${labelOf(pair.b)}」（${formatWhen(pair.b)}）` +
    `${verbOf(pair.kind)} · 共同周次 ${formatConflictWeeks(pair.weeks)}`
  )
}

/**
 * 「正在编辑的这门课」与已有课程冲突的文案（课程表单用），例：
 *  与「数据结构」冲突 · 周三 3-4 节 · 共同周次 1-16 周
 */
export function describeConflict<T extends ConflictSubject>(pair: ConflictPair<T>): string {
  return `与「${labelOf(pair.b)}」${verbOf(pair.kind)} · ${formatWhen(pair.b)} · 共同周次 ${formatConflictWeeks(pair.weeks)}`
}
