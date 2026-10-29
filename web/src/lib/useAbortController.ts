import { useCallback, useEffect, useRef } from 'react'

/**
 * 请求竞态防护：给「会被反复触发」的数据加载提供取消能力。
 *
 * 解决什么问题：
 *   `useCallback` 形式的 load() 函数（依赖 tab/筛选/搜索词变化）没有清理函数，
 *   快速切换时会出现「先发的请求后返回」，把新数据覆盖成旧数据——用户看到
 *   自己切到了「我赞」tab，列表却是「全部」的内容。
 *
 * 用法：
 *   const begin = useAbortController()
 *   const load = useCallback(() => {
 *     const ac = begin()                     // 自动取消上一次未完成的请求
 *     fetchSomething(ac.signal)
 *       .then((d) => { if (!ac.signal.aborted) setData(d) })
 *       .catch((e) => { if (!ac.signal.aborted) setError(msg(e)) })
 *   }, [begin])
 *
 * 两个必须遵守的约定（否则会引入新 bug）：
 *   1. **每个 setState 前都要判 `ac.signal.aborted`** —— 被取消的请求不应再写状态，
 *      否则要么写进过期数据，要么在组件已卸载后更新状态。
 *   2. **catch 里要跳过 AbortError**，否则用户每次快速切换都会看到一次「加载失败」
 *      的假报错（取消不是失败）。用 isAbortError() 判定。
 */
export function useAbortController(): () => AbortController {
  const ref = useRef<AbortController | null>(null)

  const begin = useCallback((): AbortController => {
    ref.current?.abort()
    const ac = new AbortController()
    ref.current = ac
    return ac
  }, [])

  /* 组件卸载时取消在途请求：避免「离开页面后请求还在跑、回来又写一遍状态」 */
  useEffect(
    () => () => {
      ref.current?.abort()
    },
    []
  )

  return begin
}

/** 判断是否为「请求被主动取消」的异常——这类异常不应展示为加载失败 */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  /* api.ts 的 rawFetch 会把 fetch 层的一切异常统一包成 ApiError，
     所以 `name === 'AbortError'` 在真实链路里永远不成立 —— 必须同时看 canceled 标记。 */
  if ((e as { canceled?: unknown }).canceled === true) return true
  return (e as { name?: string }).name === 'AbortError'
}
