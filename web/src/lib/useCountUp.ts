import { useEffect, useRef, useState } from 'react'

/**
 * 数字滚动：值变化时从旧值平滑滚到新值（rAF + easeOutCubic）。
 * 用于首页「这周还剩 N 件」这类大数字，完成/新建任务时数字变化有过渡感。
 * 系统「减少动态效果」开启时直接跳到目标值。
 */
export function useCountUp(target: number, duration = 550): number {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  const rafRef = useRef(0)

  useEffect(() => {
    const from = displayRef.current
    if (from === target) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      displayRef.current = target
      setDisplay(target)
      return
    }
    const t0 = performance.now()
    const tick = (t: number) => {
      const p = duration <= 0 ? 1 : Math.min(1, (t - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(from + (target - from) * eased)
      displayRef.current = v
      setDisplay(v)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration])

  return display
}
