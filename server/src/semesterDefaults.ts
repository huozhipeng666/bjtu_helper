/**
 * 新用户的默认学期 / 节次默认值。
 *
 * ⚠️ **本文件刻意不 import './db.js'**（与 terms.ts 同一约束）：
 *   迁移脚本（scripts/migrate-terms.mts）需要按「服务端会算出什么默认学期」来给
 *   存量课程回填 term，而 db.js 一被 import 就会打开数据库文件并建表。
 *   保持本模块为纯函数，迁移脚本才能只依赖口径、不产生副作用。
 */
import type { Period } from './types.js'
import { isValidISODate, startOfWeek, toISODate } from './date.js'

export const DEFAULT_PERIODS: Period[] = [
  { index: 1, start: '08:00', end: '09:50' },
  { index: 2, start: '10:10', end: '12:00' },
  { index: 3, start: '12:10', end: '14:00' },
  { index: 4, start: '14:10', end: '16:00' },
  { index: 5, start: '16:20', end: '18:10' },
  { index: 6, start: '19:00', end: '20:50' },
  { index: 7, start: '21:00', end: '21:50' }
]

/** 按当前月份猜一个学期名（8 月-次年 1 月算秋季，其余算春季） */
export function defaultSemesterName(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const season = month >= 8 || month <= 1 ? '秋季学期' : '春季学期'
  return `${year}-${year + 1} 学年 ${season}`
}

/** 新用户的默认学期总周数（与 2026-2027 秋季学期教务校历一致：16 周） */
export const DEFAULT_TOTAL_WEEKS = 16

/**
 * 学期「第一教学周」的默认起始日（该周的周一）。
 * 规则（本仓库约定）：第一教学周默认 = **9 月 7 日**（2026-2027 秋季学期开学日，恰为周一）。
 *  - 优先级最高：环境变量 `SEMESTER_START_DATE`（YYYY-MM-DD），便于跨学年运维时改，无需改代码；
 *  - 否则：按学年取 9 月 7 日——1 月属上学年秋季 → 上一自然年 9/7；其余月份取当前自然年 9/7。
 *    春季学期本应是 2 月开学，但这里作为「尚未人工改开学日」的兜底仍给 9/7，用户可在设置里改成真实日期。
 *  - 9/7 不一定每年都是周一，因此统一向前对齐到该周周一（第一教学周必须从周一起算，否则整学期周次会整体错位）。
 * 注意：这只是**新用户的默认值**；已存在 user_settings 记录的用户保留其已保存的开学日，不会被动迁移。
 * 教务导入（MIS）抓到教务系统的开学日/周数时会直接写进该用户的设置，优先级高于本默认值。
 */
export function defaultSemesterStartDate(): string {
  const envDate = (process.env.SEMESTER_START_DATE ?? '').trim()
  if (envDate && isValidISODate(envDate)) return envDate
  const now = new Date()
  let y = now.getFullYear()
  const m = now.getMonth() + 1
  if (m === 1) y -= 1 // 1 月仍属上一学年的秋季学期
  return toISODate(startOfWeek(new Date(y, 8, 7))) // 9 月 7 日，并向前后退到该周周一
}

/** 新用户的出厂设置（无 user_settings 记录时的读取结果） */
export function defaultSettings(): {
  semester: { name: string; startDate: string; totalWeeks: number }
  periods: Period[]
} {
  return {
    semester: {
      name: defaultSemesterName(),
      startDate: defaultSemesterStartDate(),
      totalWeeks: DEFAULT_TOTAL_WEEKS
    },
    periods: DEFAULT_PERIODS
  }
}
