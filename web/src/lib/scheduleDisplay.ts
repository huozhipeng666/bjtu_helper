/**
 * 课表显示偏好（设计稿图2「课表显示」）。
 *
 * 为什么存 localStorage 而不是服务端 settings：
 *   这四项都是**纯渲染偏好**（行高、是否显示灰色课、要不要藏空周末、字号），
 *   不参与任何数据计算，也不影响别人看到的内容。写进服务端 settings 需要扩契约、
 *   走一遍 PUT/GET、还要考虑老数据缺字段的兼容；而收益只是"换设备也一致" ——
 *   对一个"我此刻看得清不清楚"的开关来说，这个收益撑不起那份复杂度。
 *   主题（theme/accent）之所以双写，是因为它还会影响**别人分享出去的图**和首屏，
 *   这里不具备那个性质。
 *
 * 读取失败（隐私模式禁 localStorage / JSON 损坏）一律回退默认值：
 * 显示偏好坏掉不该让课表页打不开。
 */
import { useCallback, useEffect, useState } from 'react'

export type ScheduleFontScale = 'sm' | 'md' | 'lg'

export interface ScheduleDisplayPrefs {
  /**
   * 紧凑视图：压行高 **且** 让周一~周日一屏看全（7 列平分容器宽度，不出现横向滚动）。
   * 这两件事是一体的 —— 用户点这个开关图的就是"一眼看全整周"，
   * 若还要左右滑动才能看到周五，开关就白点了。
   */
  compact: boolean
  /** 显示非本周课程：以灰色标记本周不上课的课程 */
  showInactive: boolean
  /** 按需显示周末：隐藏当前周没有任何可见课程的周六、周日 */
  autoWeekend: boolean
  /** 字体大小：今日课程与周课表同步调整 */
  fontScale: ScheduleFontScale
  /**
   * 卡片行高（px）。null = **自动**（按可见节数与紧凑档推导）。
   * 对齐竞品 Nexio课程表 的可调区间 34~92dp —— 把"紧凑"从二档开关
   * 变成一个连续可调的量，用户能自己找到"看清"和"看全"的平衡点。
   */
  rowHeight: number | null
  /** 周课表块内是否显示地点（@教学楼 A309） */
  showLocation: boolean
  /** 周课表块内是否显示教师 */
  showTeacher: boolean
  /** 周课表块内是否显示学分角标（默认关：竞品块内只放课名/地点/教师） */
  showCredit: boolean
  /** 午休 / 晚休通栏分隔带 */
  showBreaks: boolean
}

/** 行高滑杆的合法区间（与竞品 34~92dp 同口径） */
export const ROW_HEIGHT_MIN = 34
export const ROW_HEIGHT_MAX = 92

export const DEFAULT_DISPLAY_PREFS: ScheduleDisplayPrefs = {
  compact: false,
  showInactive: false,
  autoWeekend: false,
  fontScale: 'md',
  rowHeight: null,
  showLocation: true,
  showTeacher: true,
  showCredit: false,
  showBreaks: true
}

export const FONT_SCALE_LABEL: Record<ScheduleFontScale, string> = {
  sm: '小',
  md: '标准',
  lg: '大'
}

const STORAGE_KEY = 'bjtu-schedule-display'

/**
 * 读取偏好。
 *
 * ⚠️ 新增字段一律走「缺字段回落默认」而不是 `=== true`：
 * 老用户 localStorage 里是上一版写下的 JSON，没有 rowHeight / showLocation 这些键。
 * 若用 `o.showLocation === true`，升级后所有人会突然看不到地点（默认被当成 false）；
 * 布尔项默认开的就用 `!== false`，默认关的才用 `=== true`。
 */
export function readDisplayPrefs(): ScheduleDisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_DISPLAY_PREFS }
    const o = JSON.parse(raw) as Partial<ScheduleDisplayPrefs>
    const rh = o.rowHeight
    return {
      compact: o.compact === true,
      showInactive: o.showInactive === true,
      autoWeekend: o.autoWeekend === true,
      fontScale: o.fontScale === 'sm' || o.fontScale === 'lg' ? o.fontScale : 'md',
      rowHeight:
        typeof rh === 'number' && Number.isFinite(rh) && rh > 0
          ? Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, Math.round(rh)))
          : null,
      showLocation: o.showLocation !== false,
      showTeacher: o.showTeacher !== false,
      showCredit: o.showCredit === true,
      showBreaks: o.showBreaks !== false
    }
  } catch {
    return { ...DEFAULT_DISPLAY_PREFS }
  }
}

export function writeDisplayPrefs(p: ScheduleDisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式 / 配额满：偏好写不进去不影响本次会话，忽略 */
  }
}

/**
 * 把字号落到文档根元素。
 * 用 data 属性 + CSS 变量而不是给每个组件传 prop：
 * 图2 的说明是「今日课程和周课表同步调整」—— 字号要同时作用于**两个页面**，
 * 走 CSS 变量才能一处生效、不必把偏好穿透进 HomeView / WeekGrid / ScheduleView 三层 props。
 */
export function applyDisplayPrefs(p: ScheduleDisplayPrefs): void {
  const root = document.documentElement
  root.dataset.schFont = p.fontScale
}

/**
 * 显示偏好的读写 hook。
 *
 * 为什么每个用到它的页面各自持有一份 state 就够了：App 的 tab 是**互斥渲染**的
 * （`<div className="content anim-content" key={tab}>`），首页与课表页不会同时挂载，
 * 因此不存在"两处 state 不一致"的问题。跨页面同步靠 localStorage + 重新挂载时重读。
 */
export function useScheduleDisplay(): {
  prefs: ScheduleDisplayPrefs
  update: (patch: Partial<ScheduleDisplayPrefs>) => void
  reset: () => void
} {
  const [prefs, setPrefs] = useState<ScheduleDisplayPrefs>(() => readDisplayPrefs())

  useEffect(() => {
    applyDisplayPrefs(prefs)
  }, [prefs])

  const update = useCallback((patch: Partial<ScheduleDisplayPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      writeDisplayPrefs(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    const d = { ...DEFAULT_DISPLAY_PREFS }
    writeDisplayPrefs(d)
    setPrefs(d)
  }, [])

  return { prefs, update, reset }
}
