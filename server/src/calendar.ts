import type { Task } from './types.js'
import { addDays, parseISODate, toISODate } from './date.js'

/* 评审 B10（2026-10-23）：本模块按「服务器本地墙上时间 = 北京时间」生成 DTSTART，
   并向客户端声明 X-WR-TIMEZONE:Asia/Shanghai。两者必须一致 —— 若部署到非东八区
   的机器（比如 UTC 容器），所有事件整体错 8 小时。启动时明确告警，而不是让
   订阅者默默吃下错排的日程。 */
if (new Date().getTimezoneOffset() !== -480) {
  console.warn(
    `[calendar] 服务器时区不是东八区（UTC+8，当前偏移 ${new Date().getTimezoneOffset()} 分钟）。` +
      'ICS 的 DTSTART 按服务器本地墙上时间生成、以 Asia/Shanghai 声明，非东八区部署会让日程整体偏移。请把系统时区设为 Asia/Shanghai。'
  )
}

function esc(s: string): string {
  /* 转义顺序很重要：先把各种换行归一，再处理反斜杠，最后才把换行写成字面 `\n`。
     ⚠️ 原实现只处理了 `\n`，漏了 `\r`：任务标题/备注是用户自由输入的，
     一个裸 `\r` 在部分宽松解析器（某些安卓日历、第三方客户端）里会被当成换行，
     于是后面的内容被解析成**新的属性行** —— 等于可以在自己的订阅源里注入
     ATTENDEE / URL 之类的字段。虽然只影响受害者自己的订阅，但没理由留着。
     同时剔除其余 C0 控制字符（\x00-\x08 等）：它们在任何解析器里都是非法字符。 */
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}Z`
}

/**
 * 把「服务器本地时区的墙上时间」换算成 UTC 时间戳（YYYYMMDDTHHMMSSZ）。
 * 用于全天事件的绝对时刻闹钟：不能直接用 -P1D，否则 iOS 会在半夜零点弹提醒。
 */
function localWallClockToUtc(dateISO: string, hm: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const [hh, mi] = hm.split(':').map(Number)
  const asIfUtc = Date.UTC(y, m - 1, d, hh || 0, mi || 0, 0)
  // getTimezoneOffset() = UTC - 本地，东八区为 -480 分钟；因此 UTC 时刻 = 墙上时间 + 该偏移
  const offsetMin = new Date(asIfUtc).getTimezoneOffset()
  return stamp(new Date(asIfUtc + offsetMin * 60_000))
}

/** ICS 持续时间：1440 -> -P1D，120 -> -PT2H，30 -> -PT30M */
function triggerDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? '-P1D' : `-P${days}D`
  }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `-PT${m}M`
  if (m === 0) return `-PT${h}H`
  return `-PT${h}H${m}M`
}

/**
 * RFC 5545 §3.1 折行（评审 B10，2026-10-23）：单行超过 75 **字节**必须折为
 * 「CRLF + 空格」续行。此前不折 —— 长备注/长课程名的 DESCRIPTION 会超出，
 * 严格解析器（部分 iOS/企业日历）会拒绝或截断整行。
 * 按 UTF-8 字节切，并向回退到字符起始字节，避免把多字节汉字劈成乱码。
 */
function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const out: string[] = []
  let start = 0
  while (start < bytes.length) {
    const limit = start === 0 ? 75 : 74 /* 续行以空格开头，占 1 字节 */
    let end = Math.min(start + limit, bytes.length)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    out.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return out.join('\r\n ')
}

export interface IcsOptions {
  /** 是否写入 VALARM 闹钟，默认 true —— 关闭后订阅进日历也不会有任何提醒 */
  alarms?: boolean
  /** 有具体截止时刻时，相对截止时间提前多少分钟提醒 */
  alarmMinutes?: number[]
  /** 全天事件的提醒时刻（服务器本地时间 HH:mm）：默认前一天 20:00 与当天 08:00 */
  allDayAlarmTimes?: string[]
  /** 日历名称，订阅后显示在系统日历列表里 */
  calName?: string
}

/**
 * 由任务的 DDL 生成 .ics（浮动本地时间；无具体时刻用全天事件）
 *
 * 关键点：每个事件都带 VALARM。之前订阅后"没有通知"，根因就是缺了 VALARM ——
 * 日历 App 只负责存事件，提醒完全由事件自带的闹钟决定。
 */
export function buildTaskIcs(tasks: Task[], opts: IcsOptions = {}): string {
  const withAlarms = opts.alarms !== false
  const alarmMinutes = opts.alarmMinutes ?? [24 * 60, 120]
  const allDayTimes = opts.allDayAlarmTimes ?? ['20:00', '08:00']
  const calName = opts.calName ?? '交大小助手 · DDL'

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bjtu-helper//交大小助手//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    // 建议客户端 1 小时刷新一次；iOS 系统日历对订阅源有自己的调度，这个只是建议值
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ]
  const now = stamp(new Date())
  for (const t of tasks) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:bjtu-task-${t.id}@bjtu-helper`)
    lines.push(`DTSTAMP:${now}`)
    lines.push(`SEQUENCE:${t.status === 'done' ? 1 : 0}`)
    const ymd = t.dueDate.replace(/-/g, '')
    let summary = t.title
    if (t.courseName) summary += ` [${t.courseName}]`
    if (t.status === 'done') summary += '（已完成）'

    if (t.dueTime) {
      const [h, m] = t.dueTime.split(':').map(Number)
      const start = parseISODate(t.dueDate)
      start.setHours(h || 0, m || 0, 0, 0)
      const end = new Date(start.getTime() + 3600 * 1000)
      const f = (d: Date) =>
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      lines.push(`DTSTART:${f(start)}`)
      lines.push(`DTEND:${f(end)}`)
    } else {
      const next = toISODate(addDays(parseISODate(t.dueDate), 1))
      lines.push(`DTSTART;VALUE=DATE:${ymd}`)
      lines.push(`DTEND;VALUE=DATE:${next.replace(/-/g, '')}`)
    }
    lines.push(`SUMMARY:${esc(summary)}`)
    if (t.notes) lines.push(`DESCRIPTION:${esc(t.notes)}`)
    lines.push('STATUS:CONFIRMED')
    lines.push('TRANSP:TRANSPARENT')

    if (withAlarms) {
      if (t.dueTime) {
        // 有明确时刻：用相对触发，跨时区也不会跑偏
        for (const min of alarmMinutes) {
          lines.push('BEGIN:VALARM')
          lines.push('ACTION:DISPLAY')
          lines.push(`DESCRIPTION:${esc('DDL 提醒：' + summary)}`)
          lines.push(`TRIGGER:${triggerDuration(min)}`)
          lines.push('END:VALARM')
        }
      } else {
        // 全天事件：相对触发会落在午夜，改成绝对时刻
        // 第一条给「前一天」，第二条给「当天早上」
        const targets = allDayTimes.map((hm, i) => ({
          hm,
          date: i === 0 ? toISODate(addDays(parseISODate(t.dueDate), -1)) : t.dueDate
        }))
        for (const tg of targets) {
          lines.push('BEGIN:VALARM')
          lines.push('ACTION:DISPLAY')
          lines.push(`DESCRIPTION:${esc('DDL 提醒：' + summary)}`)
          lines.push(`TRIGGER;VALUE=DATE-TIME:${localWallClockToUtc(tg.date, tg.hm)}`)
          lines.push('END:VALARM')
        }
      }
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join('\r\n') + '\r\n'
}
