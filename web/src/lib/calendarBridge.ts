/* ============================================================
   本地日历同步：原生 WebView 桥 + 网页回退
   ============================================================

   背景 / 为什么这么设计：
   - 纯浏览器(网页)受沙箱限制，**无法**直接往手机系统日历里写事件，也无法"申请"
     系统日历权限——Web 没有这个 API。之前用 webcal:// 订阅在部分 Android 浏览器
     打开失败率高、且依赖系统日历后台定期拉取，实时性差。
   - 真正能"申请本地日历权限 + 写入 + 实时更新"的方式，只有把站点包进一个原生
     WebView 壳(Android/iOS)，由原生壳暴露一个 JS 桥，让网页调用原生日历 Intent。
   - 因此本模块定义了一个**稳定的桥契约**；壳工程按此实现即可。网页运行时自动探测：
       有桥 → 走"申请权限 + 写入本地日历"（可靠、实时）；
       无桥 → 回退到"下载 .ics → 系统日历打开并授权导入"（比 webcal 直达稳）。

   原生壳暴露的桥（Android 实现见 android-shell/.../MainActivity.java）：
     window.BjtuCalendar = {
       addEvent(payloadJson): string   // 'granted' | 'updated' | 'pending' | 错误说明
       permissionState(): string       // 'granted' | 'denied' | 'blocked'
       openSettings(): void            // 权限被永久拒绝后，跳到本应用的系统设置页
     }
     payload: { title, description, location, startISO, endISO, allDay, reminderMinutes, uid }

   addEvent 的四种成功/半成功状态（2026-10-20 起）：
     granted  新建成功
     updated  同一条 DDL 再点一次 / 改了截止时间再点 → 更新原事件，不会重复
     pending  壳弹出了系统授权框，事件排队；用户点「允许」后由原生侧自动补写
     其它     错误说明（含"设置"字样 = 权限被永久拒绝，需要去系统设置里开）
   ============================================================ */

import type { Task } from '../types'
import { saveBlob, type SaveResult } from './saveFile'

export interface CalendarEventInput {
  title: string
  description?: string
  location?: string
  /** RFC3339，如 2026-09-07T10:00:00 */
  startISO: string
  endISO: string
  allDay?: boolean
  /** 提前多少分钟提醒；默认 120（2 小时）。0 表示不设提醒 */
  reminderMinutes?: number
  /** 稳定唯一标识，便于壳侧做去重/更新；形如 bjtu-task-123 */
  uid?: string
}

/** 壳侧 addEvent 的解析结果 */
export interface CalendarAddResult {
  ok: boolean
  /**
   * ok        已新建
   * updated   已更新同一条
   * pending   已弹系统授权框、事件排队（用户允许后原生侧自动补写）
   * blocked   权限被拒且系统不再弹框，只能去系统设置里开
   * error     其它失败
   */
  status: 'ok' | 'updated' | 'pending' | 'blocked' | 'error'
  message: string
}

export type CalendarPermissionState = 'granted' | 'denied' | 'blocked' | 'unknown'

interface BjtuCalendarBridge {
  /** 同步写日历：返回 'granted' | 'updated' | 'pending' | 错误说明（兼容旧壳的 true/false） */
  addEvent: (payloadJson: string) => boolean | string | void
  permissionState?: () => string
  openSettings?: () => void
}

declare global {
  interface Window {
    BjtuCalendar?: BjtuCalendarBridge
    AndroidCalendar?: BjtuCalendarBridge
  }
}

function bridge(): BjtuCalendarBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const b = window.BjtuCalendar ?? window.AndroidCalendar
  return b && typeof b.addEvent === 'function' ? b : undefined
}

/** 是否运行在提供了原生日历桥的 WebView 壳里 */
export function hasNativeCalendarBridge(): boolean {
  return !!bridge()
}

/** 当前日历权限状态；没有桥时返回 unknown（网页端只能走 .ics 回退） */
export function calendarPermissionState(): CalendarPermissionState {
  const b = bridge()
  if (!b) return 'unknown'
  try {
    const s = typeof b.permissionState === 'function' ? b.permissionState() : ''
    if (s === 'granted' || s === 'denied' || s === 'blocked') return s
  } catch {
    /* 老壳没有这个方法，忽略 */
  }
  return 'unknown'
}

/** 跳到本应用的系统设置页（权限被永久拒绝时唯一出路）。返回是否成功唤起 */
export function openCalendarPermissionSettings(): boolean {
  const b = bridge()
  if (!b || typeof b.openSettings !== 'function') return false
  try {
    b.openSettings()
    return true
  } catch {
    return false
  }
}

/** 把桥的返回值翻译成统一结果 */
function interpret(raw: unknown): CalendarAddResult {
  if (raw === true || raw === 'granted') return { ok: true, status: 'ok', message: '已写入本地日历' }
  if (raw === 'updated') return { ok: true, status: 'updated', message: '已更新本地日历中的这一条' }
  if (raw === 'pending') {
    return { ok: false, status: 'pending', message: '已弹出日历授权框，点「允许」后会自动写入' }
  }
  if (raw === false || raw === 'denied') {
    return { ok: false, status: 'blocked', message: '未授予日历权限' }
  }
  if (typeof raw === 'string' && raw) {
    // 原生侧在"权限被永久拒绝"时返回的文案里带「设置」二字
    if (raw.includes('设置')) return { ok: false, status: 'blocked', message: raw }
    /* 老版本壳（v1.4 及更早）未授权时返回的是
       "未授予日历权限，请在系统弹窗中点击允许（授权后会自动同步）" ——
       它其实已经把事件排队并弹了系统框，语义上就是 pending，别当成错误。 */
    if (raw.includes('权限') && raw.includes('允许')) {
      return { ok: false, status: 'pending', message: raw }
    }
    return { ok: false, status: 'error', message: raw }
  }
  return { ok: true, status: 'ok', message: '已调用原生日历' }
}

/** 同步写一条日历事件（不做 DDL 语义转换，底层入口） */
export function nativeAddEvent(input: CalendarEventInput): CalendarAddResult {
  const b = bridge()
  if (!b) return { ok: false, status: 'error', message: '当前环境未提供原生日历桥' }
  try {
    return interpret(b.addEvent(JSON.stringify(input)))
  } catch (e) {
    return { ok: false, status: 'error', message: e instanceof Error ? e.message : '调用原生日历失败' }
  }
}

/* ============================================================
   DDL → 日历事件
   ============================================================ */

const TYPE_LABEL: Record<string, string> = { homework: '作业', exam: '考试', other: '其他' }
/** 定时 DDL 提前 2 小时提醒 */
export const REMIND_TIMED = 120
/** 全天 DDL 提前 12 小时提醒（相对当天 00:00，即前一天中午，避免半夜响） */
export const REMIND_ALLDAY = 720

/**
 * 一条 DDL → 一个独立日历事件：
 * - 有截止时间：做成 30 分钟的日程，标题带类型前缀，提前 2 小时提醒；
 * - 只有截止日期：做成全天事件，提前 12 小时提醒（全天事件 DTSTART 是 00:00，
 *   -12h 正好落在前一天中午，既不会半夜响，也留足半天缓冲）。
 * uid 用任务 id 生成且保持稳定 —— 原生壳按它做去重/更新，所以同一条 DDL
 * 反复点「加入日历」只会更新那一个事件，不会越点越多。
 */
export function taskToEvent(t: Task): CalendarEventInput {
  const prefix = TYPE_LABEL[t.type] ?? 'DDL'
  const desc = [t.courseName ? `课程：${t.courseName}` : '', t.notes ?? ''].filter(Boolean).join('\n')
  if (!t.dueTime) {
    return {
      title: `${prefix} · ${t.title}`,
      description: desc,
      startISO: `${t.dueDate}T00:00:00`,
      endISO: `${t.dueDate}T23:59:00`,
      allDay: true,
      reminderMinutes: REMIND_ALLDAY,
      uid: `bjtu-task-${t.id}`
    }
  }
  const start = new Date(`${t.dueDate}T${t.dueTime}:00`)
  const end = new Date(start.getTime() + 30 * 60 * 1000)
  return {
    title: `${prefix} · ${t.title}`,
    description: desc,
    startISO: toLocalISO(start),
    endISO: toLocalISO(end),
    allDay: false,
    reminderMinutes: REMIND_TIMED,
    uid: `bjtu-task-${t.id}`
  }
}

/**
 * 把一条 DDL 写进系统日历（仅在原生壳里可用；无桥时返回 status:error）。
 *
 * 这是 DDL 页「加入日历」按钮与新建表单勾选框共用的唯一入口：
 * 没授权时原生壳会自己弹系统授权框（返回 pending），用户点允许后自动补写。
 */
export function addTaskToCalendar(t: Task): CalendarAddResult {
  return nativeAddEvent(taskToEvent(t))
}

/* ============================================================
   「这条 DDL 已经加过日历了吗」的本地标记
   ============================================================
   只用于界面状态（列表里的日历图标点亮 / 编辑时默认勾选），不上传服务器。
   真相以系统日历为准：用户若在系统日历里删掉了事件，这里仍会显示已添加 ——
   所以它只是"提示"，重复点击也不会产生重复事件（原生侧按 uid 更新）。 */
const ADDED_KEY = 'bjtu.calendar.addedTasks'
/** 标记上限：只留最近 500 条，避免 localStorage 无限增长 */
const ADDED_LIMIT = 500

function readAdded(): number[] {
  try {
    const raw = localStorage.getItem(ADDED_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((v): v is number => typeof v === 'number') : []
  } catch {
    return []
  }
}

function writeAdded(ids: number[]): void {
  try {
    localStorage.setItem(ADDED_KEY, JSON.stringify(ids.slice(-ADDED_LIMIT)))
  } catch {
    /* 隐私模式写不了，界面状态退化为"未添加"，不影响功能 */
  }
}

export function isTaskInCalendar(taskId: number): boolean {
  return readAdded().includes(taskId)
}

/** 一次性读出全部「已加过日历」的任务 id（列表初始化用） */
export function readTasksInCalendar(): number[] {
  return readAdded()
}

export function markTaskInCalendar(taskId: number): void {
  const ids = readAdded().filter((id) => id !== taskId)
  ids.push(taskId)
  writeAdded(ids)
}

export function unmarkTaskInCalendar(taskId: number): void {
  writeAdded(readAdded().filter((id) => id !== taskId))
}

/* ============================================================
   「新建 DDL 时是否同步到系统日历」偏好
   ============================================================
   存在本地 localStorage：只影响本机默认勾选状态，不上传服务器。
   用户改过一次就沿用他的选择，避免每次都手动勾/取消。 */
const PREF_KEY = 'bjtu.calendar.askOnTask'

export function readTaskCalendarPref(): boolean {
  try {
    const v = localStorage.getItem(PREF_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true // 隐私模式下 localStorage 可能抛错，退回默认开启
  }
}

export function writeTaskCalendarPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0')
  } catch {
    /* 写不了就不记，不影响功能 */
  }
}

/** Date → 本地时间 ISO 串（不带 Z）；原生日历按本地时区解析，传 UTC 会整体偏移 */
export function toLocalISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 生成单事件 .ics 文本（转义 RFC5545 保留字符） */
export function buildIcs(input: CalendarEventInput, uid: string): string {
  const esc = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
  const t = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '') // 2026-09-07T10:00:00 -> 20260907T100000
  const now = new Date()
  const dtStamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace('Z', '') + 'Z'
  // 全天事件也需要提醒：TRIGGER 相对 DTSTART（00:00）往前推，例如 -PT12H → 前一天中午
  const mins = Math.max(0, Math.round(input.reminderMinutes ?? 120))
  const alarm =
    mins === 0
      ? ''
      : [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          'DESCRIPTION:提醒：' + esc(input.title),
          `TRIGGER:-PT${Math.floor(mins / 60)}H${mins % 60}M0S`,
          'END:VALARM'
        ].join('\r\n')
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bjtu-helper//Calendar//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + (input.uid || uid),
    'DTSTAMP:' + dtStamp,
    'DTSTART' + (input.allDay ? ';VALUE=DATE' : '') + ':' + (input.allDay ? input.startISO.slice(0, 10).replace(/-/g, '') : t(input.startISO)),
    'DTEND' + (input.allDay ? ';VALUE=DATE' : '') + ':' + (input.allDay ? endDayExclusive(input.startISO) : t(input.endISO)),
    'SUMMARY:' + esc(input.title),
    input.description ? 'DESCRIPTION:' + esc(input.description) : '',
    input.location ? 'LOCATION:' + esc(input.location) : '',
    alarm,
    'END:VEVENT',
    'END:VCALENDAR'
  ]
    .filter(Boolean)
    .join('\r\n')
}

function endDayExclusive(startISO: string): string {
  // 全天事件用 DATE;结束日排他 = 开始日 +1 天
  const d = new Date(startISO.slice(0, 10) + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * 触发下载一个 .ics 文件（比 webcal:// 直达在更多浏览器里更可靠）。
 *
 * ⚠️ 走 saveBlob：Android WebView 里 `<a download>` 点了没反应，
 * 而 .ics 导出后必须能在文件管理器里找到才能导入日历。详见 lib/saveFile.ts。
 */
export async function downloadIcs(filename: string, content: string): Promise<SaveResult> {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  return saveBlob(blob, filename)
}
