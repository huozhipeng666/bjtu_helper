/**
 * 课表 / 考试导出到系统日历（.ics）。
 *
 * 为什么单独一个文件，而不是塞进 `calendarBridge.ts`：
 * calendarBridge 处理的是**单个事件**（把一条 DDL 或一次考试加进系统日历，
 * 走原生日历 App 的 intent / x-apple 协议），而这里是**批量导出整学期**，
 * 生成的是**多事件、带 RRULE 的日历文件**。两者的错误处理与用户预期都不同：
 * 前者失败只是"没加成"，后者失败是"我导出的文件里少了 30 节课"。
 *
 * 三条关键规则（都是踩过坑之后定下来的）：
 *
 * 1. **一律用本地时间，绝不能写 Z**。
 *    `buildIcs` 里的 `toLocalISO` 已经说明了这点：原生日历按设备时区解析
 *    不带 Z 的时间；一旦写了 Z，用户在美国打开就整体偏移 8 小时。
 *    导出文件会被转发到别人的设备上，这个坑比单事件场景更容易踩到。
 *
 * 2. **课表用 RRULE:FREQ=WEEKLY 而不是展开成 N 个 VEVENT**。
 *    一学期 18 周 × 每周 20 节课 = 360 个事件，展开会让文件变得巨大，
 *    而且用户在日历里改一节（调课）时，展开的事件无法"改一节、其他不变"。
 *    用 RRULE + EXDATE 表达单双周与精确周集合，体积小、语义也正确。
 *
 * 3. **缺时间的场合宁可不导出，也不猜**。
 *    教务没公布考试时间时 `Exam.startTime` 是空串。此时若按 00:00 导出，
 *    用户会在凌晨 0 点收到提醒。这种情况导出成**全天事件**并写明"时间待定"。
 */
import type { Course, Exam, Period, Term, WeekType } from '../types'
import { downloadIcs, toLocalISO } from './calendarBridge'
import type { SaveResult } from './saveFile'

/** 一节课的起止时间（本地时间，无时区后缀，如 20260107T080000） */
function localStamp(d: Date): string {
  return toLocalISO(d).replace(/[-:]/g, '')
}

/** 转义 RFC5545 保留字符。与 calendarBridge.buildIcs 里的 esc 同规则 */
function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

/**
 * 折行：RFC5545 规定每行不超过 75 字节（不是字符！）。中文一个字 3 字节，必须按字节切。
 *
 * ⚠️ 这里**不能用 `Buffer`** —— 这是浏览器代码，`Buffer` 只在 Node 里存在。
 *    早前版本的 fold 用了 Buffer.byteLength，在浏览器里会直接 ReferenceError，
 *    而 .ics 生成又在 try 里，用户看到的是"导出失败"，很难查到这里。
 *    用 TextEncoder 判断字节数，它对非 BMP 字符（emoji、生僻字）也按 UTF-8 算对了。
 */
function fold(line: string): string {
  const enc = new TextEncoder()
  const byteLen = (s: string) => enc.encode(s).length
  if (byteLen(line) <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const b = byteLen(ch)
    /* 续行以单个空格开头，占 1 字节，所以首行 75、续行 74 */
    const limit = out.length === 0 ? 75 : 74
    if (curBytes + b > limit) {
      out.push(cur)
      cur = ' '
      curBytes = 1
    }
    cur += ch
    curBytes += b
  }
  out.push(cur)
  return out.join('\r\n')
}

function dtStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * 生成提醒块。
 *
 * 与 `calendarBridge.buildIcs` 的差别：那里用 `-PT{时}H{分}M0S`，
 * 这里改成标准的 `-PT30M` / `-PT2H` 形式 —— 部分日历实现（尤其旧版 Outlook）
 * 不接受 `PT0H30M0S` 这种带前后零的写法。
 */
function alarmBlock(minutes: number, title: string): string[] {
  const m = Math.max(0, Math.round(minutes))
  if (m === 0) return []
  const dur = m % 60 === 0 ? `PT${m / 60}H` : m < 60 ? `PT${m}M` : `PT${Math.floor(m / 60)}H${m % 60}M`
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc('提醒：' + title)}`, `TRIGGER:-${dur}`, 'END:VALARM']
}

/**
 * 某教学周周一 00:00（本地时间）。
 * `startDate` 是学期第 1 周的周一；周次从 1 开始。
 */
function weekMonday(termStart: string, week: number): Date {
  const d = new Date(termStart + 'T00:00:00')
  d.setDate(d.getDate() + (week - 1) * 7)
  return d
}

/** 在周一基础上加天数，得到某一天 00:00 */
function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

/** 把 "08:00" 拼到某天的日期上，得到完整 Date */
function withTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10))
  const d = new Date(day)
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0)
  return d
}

/**
 * 算这门课实际要上课的周次集合（升序）。
 *
 * 优先级：精确周集合 `weeks` > `weekStart..weekEnd` + 单双周。
 * 这与服务端 `filterCoursesByWeek` 的口径一致 —— 不一致会导致
 * "页面上看到 16 次课、导出只有 15 个"这种对不上的情况。
 */
export function effectiveWeeks(c: Pick<Course, 'weeks' | 'weekStart' | 'weekEnd' | 'weekType'>): number[] {
  if (c.weeks && c.weeks.length > 0) {
    return [...new Set(c.weeks.filter((w) => Number.isFinite(w) && w > 0))].sort((a, b) => a - b)
  }
  const out: number[] = []
  const from = Math.max(1, c.weekStart)
  const to = Math.max(from, c.weekEnd)
  for (let w = from; w <= to; w += 1) {
    if (c.weekType === 'odd' && w % 2 === 0) continue
    if (c.weekType === 'even' && w % 2 === 1) continue
    out.push(w)
  }
  return out
}

/** 节次 → 起止时间。找不到时返回 null（不猜） */
function periodRange(c: Pick<Course, 'startPeriod' | 'endPeriod'>, periods: Period[]) {
  const s = periods.find((p) => p.index === c.startPeriod)
  const e = periods.find((p) => p.index === c.endPeriod)
  if (!s || !e) return null
  return { start: s.start, end: e.end }
}

export interface IcsEvent {
  uid: string
  title: string
  /** 本地时间 DATE-TIME（不带 Z） */
  startISO: string
  endISO: string
  description?: string
  location?: string
  /** 提醒分钟数；0 = 不提醒 */
  reminderMinutes?: number
  /** RFC5545 RRULE 值（不含 "RRULE:"），如 FREQ=WEEKLY;COUNT=16 */
  rrule?: string
  /** 要排除的时刻（本地 DATE-TIME，如 `20260928T080000`；类型必须与 DTSTART 一致） */
  exdates?: string[]
  /** 全天事件 */
  allDay?: boolean
}

/**
 * 把一组事件拼成完整 .ics。
 *
 * 与 `buildIcs` 的关键差异：那个函数是"一个 VCALENDAR 里一个 VEVENT"，
 * 这里是"一个 VCALENDAR 里多个 VEVENT" —— 这是日历订阅/导入的基本要求，
 * 一次导入多个文件会让用户被问 N 次"是否导入"。
 */
export function buildCalendar(events: IcsEvent[], calendarName: string): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bjtu-helper//Schedule Export//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(calendarName),
    /* 告诉客户端这是一个刚生成的日历，不要拿去和服务器同步 */
    'X-WR-TIMEZONE:Asia/Shanghai'
  ]
  const stamp = dtStamp()
  for (const ev of events) {
    lines.push('BEGIN:VEVENT')
    lines.push('UID:' + ev.uid)
    lines.push('DTSTAMP:' + stamp)
    if (ev.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + ev.startISO.slice(0, 8))
      lines.push('DTEND;VALUE=DATE:' + ev.endISO.slice(0, 8))
    } else {
      lines.push('DTSTART:' + ev.startISO)
      lines.push('DTEND:' + ev.endISO)
    }
    lines.push('SUMMARY:' + esc(ev.title))
    if (ev.description) lines.push('DESCRIPTION:' + esc(ev.description))
    if (ev.location) lines.push('LOCATION:' + esc(ev.location))
    if (ev.rrule) lines.push('RRULE:' + ev.rrule)
    if (ev.exdates && ev.exdates.length > 0) lines.push('EXDATE:' + ev.exdates.join(','))
    lines.push(...alarmBlock(ev.reminderMinutes ?? 0, ev.title))
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n')
}

/**
 * 课程 → 事件的展开。
 *
 * RRULE 只表达"从第几周开始的固定间隔"，不表达"哪些周不上"。
 * 所以：
 *  - 周次连续 → `FREQ=WEEKLY;COUNT=n`
 *  - 单周 / 双周 → `FREQ=WEEKLY;INTERVAL=2;COUNT=n`
 *  - 精确周集合里有洞（放假周）→ 用最早一周做 DTSTART，
 *    `FREQ=WEEKLY;COUNT=(最大周-最小周+1)`，再用 EXDATE 把不在集合里的周排掉。
 *    这是唯一能既保持"一个事件"又精确排掉放假周的写法。
 */
export function courseToEvents(
  courses: Course[],
  periods: Period[],
  term: Term,
  opts: { reminderMinutes?: number; includeLocation?: boolean } = {}
): { events: IcsEvent[]; skipped: number } {
  const reminder = opts.reminderMinutes ?? 30
  const events: IcsEvent[] = []
  let skipped = 0
  for (const c of courses) {
    const weeks = effectiveWeeks(c)
    if (weeks.length === 0) {
      skipped += 1
      continue
    }
    const range = periodRange(c, periods)
    if (!range) {
      /* 节次在 periods 里找不到 —— 说明节次表被改过。跳过而不是按 00:00 导出 */
      skipped += 1
      continue
    }
    const dayIdx = Math.max(0, Math.min(6, c.dayOfWeek - 1))
    const firstWeek = weeks[0]
    const day = addDays(weekMonday(term.startDate, firstWeek), dayIdx)
    const start = withTime(day, range.start)
    const end = withTime(day, range.end)

    /* ---------- 决定 RRULE ----------
       先区分「这个集合是否能用固定步长的 RRULE 精确表达」：
       - 每周课：相邻周差恒为 1 → FREQ=WEEKLY;COUNT=n
       - 单/双周课：相邻周差恒为 2 → FREQ=WEEKLY;INTERVAL=2;COUNT=n
       - 其它（放假周把连续段打断，或单双周里又缺了某周）→ 只能用
         FREQ=WEEKLY;COUNT=跨度 + EXDATE 把不上课的周排掉。

       ⚠️ 判据必须是**相邻差值**，不是 `跨度 === 周数`。
          区间 1..15 的单周课，周数是 8、跨度是 15，两者天然不等；
          用「相等」去判断会把它误判成有洞，于是丢掉 INTERVAL=2，
          导出的日历里每两周上一次的课变成每周一次，凭空多出 7 节课。 */
    const maxWeek = weeks[weeks.length - 1]
    const span = maxWeek - firstWeek + 1
    /* step = 2 表示这门课是单周或双周。
       这里**必须从 weekType 取，不能看 weeks 集合本身**：
       weekType 是教务给的原始口径，最可靠。 */
    const step = c.weekType === 'odd' || c.weekType === 'even' ? 2 : 1
    const stepContiguous = weeks.every((w, i) => i === 0 || w - weeks[i - 1] === step)

    const desc = [
      c.teacher ? `教师：${c.teacher}` : '',
      c.credits != null ? `学分：${c.credits}` : '',
      `周次：${weeks.length === 1 ? `第 ${weeks[0]} 周` : `第 ${weeks[0]}-${maxWeek} 周`}${c.weekType === 'odd' ? '（单周）' : c.weekType === 'even' ? '（双周）' : ''}`
    ]
      .filter(Boolean)
      .join('\n')

    const ev: IcsEvent = {
      uid: `course-${c.id}-${term.id}@bjtu-helper`,
      title: c.name,
      startISO: localStamp(start),
      endISO: localStamp(end),
      description: desc,
      location: opts.includeLocation === false ? undefined : c.location || undefined,
      reminderMinutes: reminder,
      rrule: stepContiguous
        ? step === 2
          ? `FREQ=WEEKLY;INTERVAL=2;COUNT=${weeks.length}`
          : `FREQ=WEEKLY;COUNT=${weeks.length}`
        : `FREQ=WEEKLY;COUNT=${span}`
    }
    if (!stepContiguous) {
      /* 有洞：把集合里不存在的周全部排除。
         ⚠️ EXDATE 的值类型必须与 DTSTART **完全一致**（RFC5545 §3.8.5.1）：
            DTSTART 是 DATE-TIME（`20260907T080000`），EXDATE 也必须是 DATE-TIME，
            而且时刻要和被排除的那次发生**逐字相同**，否则日历客户端匹配不上、
            这条 EXDATE 被直接忽略 —— 表现就是"放假周照样有课"，且没有任何报错。
            所以这里既不能截成 `20260928`，也不能用 00:00，必须拼上这门课的起始时刻。 */
      const have = new Set(weeks)
      const ex: string[] = []
      for (let w = firstWeek; w <= maxWeek; w += 1) {
        if (have.has(w)) continue
        const d = withTime(addDays(weekMonday(term.startDate, w), dayIdx), range.start)
        ex.push(localStamp(d))
      }
      if (ex.length > 0) ev.exdates = ex
    }
    events.push(ev)
  }
  return { events, skipped }
}

/**
 * 考试 → 一个考试一个文件所需的事件。
 *
 * `startTime` 为空串时导出成**全天事件**并注明"时间待定" ——
 * 教务确实存在"只公布日期、不公布时间"的状态，此时按 00:00 导出
 * 会让用户在凌晨收到提醒。
 */
export function examToEvents(exams: Exam[], opts: { reminderMinutes?: number } = {}): IcsEvent[] {
  const reminder = opts.reminderMinutes ?? 120
  return exams.map((e) => {
    const hasTime = /^\d{1,2}:\d{2}$/.test(e.startTime)
    const desc = [
      e.seat ? `座位：${e.seat}` : '',
      e.note ? e.note : '',
      e.startTime && e.endTime ? `时间：${e.startTime} - ${e.endTime}` : '时间：待定',
      e.location ? `地点：${e.location}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    if (!hasTime) {
      const day = new Date(e.examDate + 'T00:00:00')
      const next = addDays(day, 1)
      return {
        uid: `exam-${e.id}@bjtu-helper`,
        title: `${e.courseName} 考试（时间待定）`,
        startISO: localStamp(day).slice(0, 8) + 'T000000',
        endISO: localStamp(next).slice(0, 8) + 'T000000',
        description: desc,
        location: e.location || undefined,
        reminderMinutes: reminder,
        allDay: true
      }
    }
    const start = withTime(new Date(e.examDate + 'T00:00:00'), e.startTime)
    const end = e.endTime ? withTime(new Date(e.examDate + 'T00:00:00'), e.endTime) : new Date(start.getTime() + 2 * 3600_000)
    return {
      uid: `exam-${e.id}@bjtu-helper`,
      title: `${e.courseName} 考试`,
      startISO: localStamp(start),
      endISO: localStamp(end),
      description: desc,
      location: e.location || undefined,
      reminderMinutes: reminder
    }
  })
}

/** 文件名里不能出现的字符去掉（Windows/macOS 都保守一点） */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'export'
}

export interface ExportResult extends SaveResult {
  /** 实际写进文件的事件数 */
  count: number
  /** 因节次/周次缺失被跳过的课程数 */
  skipped: number
}

/** 导出本学期课表 */
export async function exportCoursesIcs(
  courses: Course[],
  periods: Period[],
  term: Term,
  opts: { includeLocation?: boolean; reminderMinutes?: number } = {}
): Promise<ExportResult> {
  const { events, skipped } = courseToEvents(courses, periods, term, opts)
  const name = `${term.name || '本学期'}课程表`
  const content = buildCalendar(events, name)
  const r = await downloadIcs(`${safeName(name)}.ics`, content)
  return { ...r, count: events.length, skipped }
}

/** 导出单场考试（上游行为：一场一个文件，方便只把要考的那门分享给同学） */
export async function exportExamIcs(exam: Exam): Promise<ExportResult> {
  const events = examToEvents([exam])
  const name = `${exam.courseName}-考试`
  const content = buildCalendar(events, name)
  const r = await downloadIcs(`${safeName(name)}.ics`, content)
  return { ...r, count: events.length, skipped: 0 }
}

/* 说明：原先还有一个「导出全部考试为一个 .ics」的批量入口（exportAllExamsIcs），
   对应 DDL 页右上角的「导出考试日历」按钮。该入口在 v1.7 一并下线 ——
   考试的心智是「转成 DDL 统一管理」，再维护一条独立的日历导出路径只会让人分不清
   该用哪个。单场考试仍可在「考试安排」里导出（exportExamIcs）。 */

/** 单双周判定用（导出到页面做图例时复用） */
export function weekTypeLabel(t: WeekType): string {
  return t === 'odd' ? '单周' : t === 'even' ? '双周' : '每周'
}
