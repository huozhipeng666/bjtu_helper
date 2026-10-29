import { useCallback, useRef, useState } from 'react'

/**
 * sessionStorage 持久化的 useState（评审 C1 最小缓解，2026-10-23）。
 *
 * 背景：主界面各 tab 是 `{tab === 'week' && …}` 式条件渲染，切 tab 即卸载重挂 ——
 * 周视图预览到第 8 周、DDL 筛选到某门课，切个 tab 回来就全丢了。
 * 长期修法是「常驻容器 + display:none」（会改渲染树结构，风险大）；
 * 本 hook 是最小缓解：把这些**用户明确的视图选择**存进 sessionStorage，
 * 重挂时恢复。刷新页面/新标签自然是干净的（sessionStorage 生命周期如此，正合适）。
 *
 * 为什么不用 localStorage：这是"本次会话内的浏览位置"，不是持久偏好（显示偏好
 * 那类才用 localStorage，见 lib/scheduleDisplay.ts）。存 localStorage 会让用户
 * 一周后打开还停在上次的预览周，反而是惊吓。
 *
 * 值变化时同步写 sessionStorage；写失败（隐私模式禁用）静默退化为普通 useState。
 *
 * ── 2026-10-27：setter 改为稳定引用 ──────────────────────────────────
 * 之前每次渲染都返回一个新的 set 闭包，于是任何把它写进依赖数组的 effect
 * （如 DDLView 的「课程筛选自愈」）都会陷入"effect 每帧重跑"，
 * 调用方只能选择漏依赖（换来一条 exhaustive-deps 警告）。这里用 useCallback
 * 把 set 固定下来，initial/storageKey 改走 ref，行为完全不变。
 */
export function useSessionState<T extends string | number | null>(
  key: string,
  initial: T
): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `ui:${key}`
  /* 最新值走 ref：setter 要用到 initial/storageKey 做比较与落盘，但它们不该
     成为 setter 的依赖（否则引用又不稳定了）。 */
  const initialRef = useRef(initial)
  initialRef.current = initial
  const keyRef = useRef(storageKey)
  keyRef.current = storageKey

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as T
        /* 类型护栏：反序列化结果与初始值类型不符（例如改过 key 语义）时弃用 */
        if (parsed === null || typeof parsed === typeof initial) return parsed
      }
    } catch {
      /* 读不到/解析不了就用初始值 */
    }
    return initial
  })

  const set = useCallback((v: T | ((prev: T) => T)) => {
    /* 走 useState 的函数式更新（避免连续两次 set 时读到过期闭包）；
       存储写在 updater 内做持久化 —— updater 在 StrictMode 下可能被调两次，
       但 set/remove 同值是幂等的，无副作用。 */
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (prev: T) => T)(prev) : v
      try {
        if (next === initialRef.current || next === null) sessionStorage.removeItem(keyRef.current)
        else sessionStorage.setItem(keyRef.current, JSON.stringify(next))
      } catch {
        /* sessionStorage 不可用：退化为纯内存态 */
      }
      return next
    })
  }, [])

  return [value, set]
}
