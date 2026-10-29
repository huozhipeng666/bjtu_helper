import { useEffect, useState } from 'react'

/**
 * 每分钟对齐一次的「当前 HH:mm」+ 星期（评审 C7，2026-10-23）。
 *
 * 为什么要有它：渲染期直接 `new Date()`（如 CoupleView 的 nowHM()）读的是**组件
 * 上一次渲染那一刻**的时钟 —— 页面挂着不动，「正在上 X 课」就永远停在打开时刻，
 * 10:30 开的页面到 12:00 还显示在上课。本 hook 用 interval 每 30~60s 触发一次
 * 重渲染，让"此刻"真正随时间走。30s 步长：分钟级显示下最多半分钟延迟，代价可忽略。
 */
export function useNowMinute(): { hm: string; weekday: number } {
  const read = () => {
    const d = new Date()
    return {
      hm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      weekday: d.getDay() === 0 ? 7 : d.getDay()
    }
  }
  const [now, setNow] = useState(read)

  useEffect(() => {
    const timer = setInterval(() => setNow(read()), 30_000)
    /* 回前台立刻对齐一次：后台标签页里 interval 可能被浏览器节流到分钟以上 */
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(read())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return now
}
