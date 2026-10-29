/**
 * 日期纯函数工具。全部基于本地时区，日期以字符串 YYYY-MM-DD 比较，避免时区问题。
 */
import type { Urgency } from '../types';

const DAY_MS = 86400000;
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** Date -> YYYY-MM-DD（本地时区） */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD -> 本地时区当天 00:00 的 Date */
export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD -> "2026年1月5日 周一"（考务页展示用） */
export function fmtDateCN(s: string): string {
  const d = parseISODate(s);
  if (Number.isNaN(d.getTime())) return s;
  const wd = WEEKDAY_CN[(d.getDay() + 6) % 7];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

/** 该日期所在周的周一（周一为一周开始） */
export function startOfWeek(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = date.getDay(); // 0=周日 … 6=周六
  const diff = dow === 0 ? -6 : 1 - dow;
  date.setDate(date.getDate() + diff);
  return date;
}

export function endOfWeek(d: Date): Date {
  return addDays(startOfWeek(d), 6);
}

/** 如 "9月8日 周一" */
export function formatCN(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayCN(d.getDay() === 0 ? 7 : d.getDay())}`;
}

/** 1 -> 周一 … 7 -> 周日 */
export function weekdayCN(n: number): string {
  const idx = (((n - 1) % 7) + 7) % 7;
  return WEEKDAY_CN[idx] ?? '';
}

/** b - a 的自然日差（a、b 均为 YYYY-MM-DD） */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / DAY_MS);
}

/**
 * 截止时间紧迫度：
 * overdue: dueDate < today；today: == today；tomorrow: == today+1；
 * thisWeek: <= weekEnd；否则 upcoming。
 */
export function getUrgency(dueDate: string, todayISO: string, weekEndISO: string): Urgency {
  if (dueDate < todayISO) return 'overdue';
  if (dueDate === todayISO) return 'today';
  if (dueDate === toISODate(addDays(parseISODate(todayISO), 1))) return 'tomorrow';
  if (dueDate <= weekEndISO) return 'thisWeek';
  return 'upcoming';
}

/** 相对截止文案：逾期 / 今天 / 明天 / 还剩 N 天（用于 DDL 列表右侧） */
export function relativeDueText(dueDate: string, dueTime: string | null | undefined, urgency: Urgency, now = new Date()): string {
  const due = parseISODate(dueDate);
  if (dueTime) {
    const [h, m] = dueTime.split(':').map(Number);
    due.setHours(h || 0, m || 0, 0, 0);
  } else {
    due.setHours(23, 59, 0, 0);
  }
  const diff = due.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60000);
  const hours = Math.floor(min / 60);
  const days = Math.floor(hours / 24);
  if (urgency === 'overdue') {
    if (days >= 1) return `逾期 ${days} 天`;
    if (hours >= 1) return `逾期 ${hours} 小时`;
    return `逾期 ${Math.max(1, min)} 分钟`;
  }
  if (urgency === 'tomorrow') return '明天';
  if (urgency === 'today') return dueTime ? `今天 ${dueTime}` : '今天';
  if (urgency === 'thisWeek' || urgency === 'upcoming') {
    if (days >= 1) return `还剩 ${days} 天`;
    if (hours >= 1) return `还剩 ${hours} 小时`;
    return '即将截止';
  }
  return '';
}

/**
 * 服务端时间(UTC, 'YYYY-MM-DD HH:mm:ss') → 本地 Date。
 * 解析失败返回 null —— 调用方一律要能处理"没有这个时间"的情况（老数据、空值）。
 */
export function parseServerTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/** 服务端时间(UTC) → 'YYYY-MM-DD HH:mm'；空值/非法 → '—' */
export function fmtDateTimeCN(s: string | null | undefined): string {
  const d = parseServerTime(s);
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 服务端时间(UTC, YYYY-MM-DD HH:mm:ss) → 相对时间文案 */
export function fmtAgo(serverTime: string, now = new Date()): string {
  const d = new Date(serverTime.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return serverTime;
  const diff = now.getTime() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ---------------- epoch 秒（CITEL / 物理在线等平台的截止时间） ----------------
 *
 * 注意与上面 parseServerTime 的区别：那批字段是**服务端 UTC 字符串**，这里的是
 * 客户端时区解释的 epoch 秒（四个平台客户端在服务端已按 UTC+8 换算好）。
 * 前端用户基本都在东八区，直接用本机时区渲染即可，不做二次换算。 */

const p2 = (n: number) => String(n).padStart(2, '0');

/** epoch 秒 → 'MM-DD HH:mm'；null / 非法 → ''（调用方决定回退文案） */
export function fmtEpoch(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return '';
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** epoch 秒 → 'YYYY-MM-DD 周X'（列表页按天分组用） */
export function fmtEpochDay(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${weekdayCN(d.getDay() === 0 ? 7 : d.getDay())}`;
}

/** epoch 秒距今的天数差（正 = 未来）。用来给 DDL 上「还剩 N 天 / 已截止 N 天」的色 */
export function daysUntilEpoch(sec: number, now = Date.now()): number {
  const ms = sec * 1000 - now;
  return Math.floor(ms / 86_400_000);
}
