/* ============================================================
   桌面小组件：网页 → 原生快照推送（Android 壳 v1.8+）
   ============================================================

   为什么是"网页推、原生画"：
   - 登录 token 只在 WebView 的 localStorage 里，原生侧拿不到，自己拉接口不现实；
   - 课表/DDL 的展示口径（单双周、放假周、周次过滤、排序）网页已经算好，
     推**算好的展示快照**过去，原生零业务逻辑，两边永远不会口径漂移；
   - 浏览器里没有壳 → 没有桥 → 一切 no-op，本模块对普通网页用户零影响、零请求。

   原生侧暴露的桥（Android 实现见 android-shell/.../MainActivity.java 的 BjtuWidgetBridge）：
     window.BjtuWidget = {
       update(snapshotJson): void   // 整包替换快照并重画桌面上所有小组件实例
       supported(): boolean         // 是否支持（v1.8+ 恒 true，探测用）
     }

   快照契约（v1，原生侧未知字段一律忽略 —— 网页先升级不会炸老壳）：
   {
     v: 1,
     updatedAt: 1761260000000,          // 推送时刻 epoch ms，暂未消费，留给"上次同步"展示
     weekState: 'active',               // WeekData.weekState 原样透传
     weekNumber: 5,                     // 教学周号（active 时小组件标题栏显示）
     days: [                            // 当前教学周 Mon..Sun 共 7 天（Web 的 WeekData.days）
       {
         date: '2026-10-24',
         weekday: 6,                    // 1=周一 … 7=周日（原样透传）
         courses: [                     // 按 startTime 升序，最多 8 条（小组件只渲染前 4）
           { name, location, teacher, start: '08:00', end: '09:50', color: '#4f7cff' }
         ]
       }
     ],
     tasks: [                           // 全部未完成 DDL，按截止时间升序，最多 30 条
       { title, type: 'homework', dueDate: '2026-10-26', dueTime: '23:59' | '', courseName }
     ]
   }

   时效性模型（重要）：
   - 快照里全是**绝对时间**；小组件的"还剩 N 天"等倒计时文案由原生在每次渲染时现算
     （系统每 30 分钟 + 跨天/换时区都会触发重渲染），所以不需要网页定时推送；
   - 网页只在「启动 / 登录态变化 / 数据变更（refreshKey）」时推送一次；
   - 用户长期不开 App：课表快照可能停在"过去的周"，小组件会显示「打开 App 刷新」，
     而 DDL 倒计时仍然正确（30 条覆盖了最近的截止）。
   ============================================================ */

import type { HomePayload } from '../api'
import type { Task, WeekData } from '../types'

/** 推给原生小组件的一门课（WeekCourse 的瘦版） */
export interface WidgetCourse {
  name: string
  location: string
  teacher: string
  /** HH:mm */
  start: string
  /** HH:mm */
  end: string
  color: string
}

/** 推给原生小组件的"某一天"：日期 + 当天课程 */
export interface WidgetDay {
  date: string
  /** 1=周一 … 7=周日 */
  weekday: number
  courses: WidgetCourse[]
}

/** 推给原生小组件的一条待办 DDL（Task 的瘦版） */
export interface WidgetTask {
  title: string
  type: Task['type']
  /** YYYY-MM-DD */
  dueDate: string
  /** HH:mm；没有具体时间（截止日粒度）时为空串 */
  dueTime: string
  courseName: string
}

/** 快照 v1 结构，含义见文件头契约 */
export interface WidgetSnapshot {
  v: 1
  updatedAt: number
  weekState: WeekData['weekState']
  weekNumber: number
  days: WidgetDay[]
  tasks: WidgetTask[]
}

interface BjtuWidgetBridge {
  update: (snapshotJson: string) => void
  supported?: () => boolean
}

declare global {
  interface Window {
    BjtuWidget?: BjtuWidgetBridge
  }
}

function bridge(): BjtuWidgetBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const b = window.BjtuWidget
  return b && typeof b.update === 'function' ? b : undefined
}

/** 是否运行在支持小组件的壳里（v1.8+）。浏览器 / 老壳里为 false */
export function hasWidgetBridge(): boolean {
  return !!bridge()
}

/**
 * 组装快照。与 home / tasks 的取得方式解耦，方便单独测试与将来复用。
 *
 * 取舍：
 * - days 全周都推（不只今天）：跨天不打开 App 时，小组件仍能从快照里"找到今天"，
 *   一周的窗口让课程数据在 7 天内保持正确；
 * - tasks 排序后只留最近 30 条：小组件只消费第 0 条（最急的），30 条是倒计时
 *   "还剩 N 天"能覆盖的合理上限，也把快照体积钉在几十 KB 以内。
 */
export function buildWidgetSnapshot(home: HomePayload, tasks: Task[]): WidgetSnapshot {
  const days: WidgetDay[] = home.week.days.map((d) => ({
    date: d.date,
    weekday: d.weekday,
    courses: d.courses
      .slice()
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 8)
      .map((c) => ({
        name: c.name,
        location: c.location,
        teacher: c.teacher,
        start: c.startTime,
        end: c.endTime,
        color: c.color
      }))
  }))

  /* 截止时间升序：没有具体时间的按当天最后一刻（23:59）参与排序，
     与原生侧"没填时间 = 当天 23:59 截止"的倒计时口径一致 */
  const pending: WidgetTask[] = tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) =>
      `${a.dueDate}T${a.dueTime || '23:59'}`.localeCompare(`${b.dueDate}T${b.dueTime || '23:59'}`)
    )
    .slice(0, 30)
    .map((t) => ({
      title: t.title,
      type: t.type,
      dueDate: t.dueDate,
      dueTime: t.dueTime ?? '',
      courseName: t.courseName ?? ''
    }))

  return {
    v: 1,
    updatedAt: Date.now(),
    weekState: home.week.weekState,
    weekNumber: home.week.weekNumber,
    days,
    tasks: pending
  }
}

/**
 * 推送快照给原生小组件。没有桥（浏览器/老壳）或桥抛错时静默返回 false ——
 * 小组件是壳的附加能力，任何失败都不应该影响网页本身的操作。
 */
export function pushWidgetSnapshot(home: HomePayload, tasks: Task[]): boolean {
  const b = bridge()
  if (!b) return false
  try {
    b.update(JSON.stringify(buildWidgetSnapshot(home, tasks)))
    return true
  } catch {
    return false
  }
}
