/**
 * 上课周次的统一工具：展开 / 压缩 / 展示文案。
 *
 * 背景：课程周次有两套口径 ——
 *  - 旧口径：weekStart/weekEnd/weekType（区间 + 全部/单周/双周）；
 *  - 新口径：weeks（精确周号集合），可表达教务的 "第01,03,05…周" 与任意跳段。
 * weeks 非空时优先，区间三元组退化为兼容摘要。
 */
import type { Course, WeekType } from '../types'

/** 展开区间 + 单双周为精确周号集合（至少返回一个元素，防御空区间） */
export function expandWeeks(weekStart: number, weekEnd: number, weekType: WeekType): number[] {
  const out: number[] = []
  const s = Math.max(1, Math.min(weekStart, weekEnd))
  const e = Math.max(s, weekEnd)
  for (let w = s; w <= e; w++) {
    if (weekType === 'odd' && w % 2 === 0) continue
    if (weekType === 'even' && w % 2 === 1) continue
    out.push(w)
  }
  return out.length > 0 ? out : [s]
}

/** 压缩周号集合为简短文案：{1..8,10..16} → "1-8,10-16"；{1,3,5} → "1,3,5" */
export function compressWeeks(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b)
  const parts: string[] = []
  let runStart = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const w = sorted[i]
    if (w === prev + 1) {
      prev = w
      continue
    }
    parts.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`)
    runStart = w
    prev = w
  }
  return parts.join(',')
}

/**
 * 周次展示文案（一行）：优先 weeks 精确集合，否则回退区间+单双周。
 * 例："1-16周" / "1-16周（单）" / "1,3,5,7,9,11,13,15周"
 */
export function weekSummary(c: Pick<Course, 'weeks' | 'weekStart' | 'weekEnd' | 'weekType'>): string {
  if (c.weeks && c.weeks.length > 0) return `${compressWeeks(c.weeks)}周`
  const range = c.weekStart === c.weekEnd ? `${c.weekStart}` : `${c.weekStart}-${c.weekEnd}`
  const parity = c.weekType === 'odd' ? '（单）' : c.weekType === 'even' ? '（双）' : ''
  return `${range}周${parity}`
}
