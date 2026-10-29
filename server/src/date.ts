import type { SemesterSettings, Task, Urgency, WeekOption } from './types.js'

/* ---------------- date helpers ---------------- */

export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/** 一周从周一开始 */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = r.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  r.setDate(r.getDate() + diff)
  return r
}

/** 两个 YYYY-MM-DD 之间相差的天数（b - a） */
export function diffDays(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86400000)
}

/** 校验 YYYY-MM-DD 且为合法日期 */
export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = parseISODate(s)
  return toISODate(d) === s
}

/** 校验 HH:mm */
export function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
}

/**
 * 把 Date 打成 **本地墙上时间** 的 `YYYY-MM-DD HH:mm:ss`。
 *
 * ⚠️ 存在的唯一理由：库里所有"用户会直接看到的"时间列（`share_plans.plan_date` /
 * `start_time`、`tasks.due_date` 等）存的都是**本地墙上时间** —— 用户填 `14:00`
 * 就存 `14:00`，不做时区换算。而 `new Date().toISOString()` 给的是 UTC 串，
 * 两者相减会凭空多出 8 小时（东八区）。曾因此让「到点提醒」整个失效：
 * now 被当成 8 小时前 → 计划永远"还没进窗口"。凡是要与这些列比大小的"现在"，
 * 一律用它，不要用 `toISOString()`。
 */
export function localStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 本学期第几周（**线性推算**，基于学期开始日；可能 <1 或 >totalWeeks）。
 *
 * ⚠️ 这是**旧口径**，只在学期没有显式周次表（`semester.weeks`）时兜底。
 * 它假定「每个自然周都是一个教学周」，因此一旦学校中途放假（放假周不排课、
 * 也不算教学周），放假之后的所有周次都会整体错位。有周次表时请用
 * `resolveSemesterWeek` —— 那边是查表，不是算。
 */
export function rawWeekNumber(dateISO: string, startISO: string): number {
  return Math.floor(diffDays(startISO, dateISO) / 7) + 1
}

/** 某一天在学期中所处的阶段（与 WeekData.weekState 同义） */
export type WeekPhase = 'before' | 'active' | 'holiday' | 'after'

export interface WeekResolution {
  /** 教学周号：1..totalWeeks；非 active 阶段恒为 0（没有可指的教学周） */
  week: number
  phase: WeekPhase
  /** 结果是否来自显式周次表（false = 退回线性推算，说明该学期没有周次表） */
  fromTable: boolean
}

/**
 * 把日期解析成「教学周号 + 阶段」，**优先查显式周次表**。
 *
 * 判据顺序（有周次表时）：
 *  1. 命中表里某一行：
 *     - 该行是教学周且有课 → active；
 *     - `week < 1`（平台的「第 0 周」= 开学前一周）→ before；
 *     - `week > totalWeeks`（学期结束后的空周）→ after；
 *     - 其余（表里存在但标记无课的教学周，如期中停课周）→ holiday。
 *  2. 不命中任何一行 = 表里被整条**跳过**的那一周 → holiday（这就是国庆周的情形）。
 *     再按「在第一个教学周之前 / 最后一个教学周之后」细分为 before / after。
 *
 * 没有周次表时退回 `rawWeekNumber` 线性推算，与改造前行为完全一致。
 */
export function resolveSemesterWeek(dateISO: string, semester: SemesterSettings): WeekResolution {
  const weeks = semester.weeks
  if (Array.isArray(weeks) && weeks.length > 0) {
    const hit = weeks.find((w) => dateISO >= w.beginDate && dateISO <= w.endDate)
    if (hit) {
      const inRange = hit.week >= 1 && hit.week <= semester.totalWeeks
      if (inRange && hit.hasClass) return { week: hit.week, phase: 'active', fromTable: true }
      if (hit.week < 1) return { week: 0, phase: 'before', fromTable: true }
      if (hit.week > semester.totalWeeks) return { week: 0, phase: 'after', fromTable: true }
      return { week: 0, phase: 'holiday', fromTable: true }
    }
    // 表里没有这一周：放假造成的空档
    const teaching = weeks.filter((w) => w.week >= 1 && w.week <= semester.totalWeeks && w.hasClass)
    const first = teaching[0]
    const last = teaching[teaching.length - 1]
    if (first && dateISO < first.beginDate) return { week: 0, phase: 'before', fromTable: true }
    if (last && dateISO > last.endDate) return { week: 0, phase: 'after', fromTable: true }
    return { week: 0, phase: 'holiday', fromTable: true }
  }

  const raw = rawWeekNumber(dateISO, semester.startDate)
  return {
    week: raw >= 1 && raw <= semester.totalWeeks ? raw : 0,
    phase: raw < 1 ? 'before' : raw > semester.totalWeeks ? 'after' : 'active',
    fromTable: false
  }
}

/**
 * 列出可用于「周次下拉」的周次项：教学周 + 被跳过的放假周，按日期升序。
 *
 * 放假周用 `week: null` 表示（它没有教学周号）。前端据此渲染出
 * 「第1周 / 第2周 / 第3周 / 放假周 / 第4周 …」这样与真实校历一致的下拉，
 * 用户一眼就能看出「周次为什么跳了」。
 * 没有周次表时返回 `[]`，由调用方回退到 `1..totalWeeks` 的旧列表。
 */
export function listSemesterWeekOptions(semester: SemesterSettings): WeekOption[] {
  const weeks = semester.weeks
  if (!Array.isArray(weeks) || weeks.length === 0) return []
  const out: WeekOption[] = []
  const teaching = weeks
    .filter((w) => w.week >= 1 && w.week <= semester.totalWeeks)
    .sort((a, b) => a.beginDate.localeCompare(b.beginDate))

  let prevEnd: string | null = null
  for (const w of teaching) {
    if (prevEnd) {
      // 上一教学周结束日的次日 ~ 本周开始日的前一日 = 被跳过的放假周
      const gapStart = toISODate(addDays(parseISODate(prevEnd), 1))
      if (gapStart < w.beginDate) {
        out.push({
          week: null,
          beginDate: gapStart,
          endDate: toISODate(addDays(parseISODate(w.beginDate), -1)),
          hasClass: false
        })
      }
    }
    out.push({ week: w.week, beginDate: w.beginDate, endDate: w.endDate, hasClass: w.hasClass })
    prevEnd = w.endDate
  }
  return out
}

export function urgencyOf(dueDate: string, todayISO: string, weekEndISO: string, status: Task['status']): Urgency {
  if (status === 'done') return 'upcoming'
  const diff = diffDays(todayISO, dueDate)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (dueDate <= weekEndISO) return 'thisWeek'
  return 'upcoming'
}
