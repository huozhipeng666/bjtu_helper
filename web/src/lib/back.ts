import { useEffect, useRef } from 'react'

/**
 * 移动端「返回」统一处理（Android 返回键 / 全面屏边缘手势 / iOS Safari 边缘滑动，
 * 三者最终都落到 history.back()，因此只需要一套历史栈即可同时适配）。
 *
 * - armRootBackGuard：壳挂载后压入一条历史，最上层返回时不会直接退出应用
 * - useBackStep(open, onClose)：open 时压入一条历史；返回时触发 onClose
 * - useEdgeSwipeBack：页面内左缘右滑兜底（系统手势不接管边缘时才轮到它）
 */

interface Entry {
  close: () => void
}

const stack: Entry[] = []
let listenerOn = false
let rootGuarded = false
let suppressPop = 0
/**
 * 最近一次「UI 主动关闭浮层」所触发的 history.back() 标记。
 *
 * 为什么需要：这个 back() 是异步生效的 —— 关浮层时 App 往往同时切了页面
 * （例如消息通知里点「校园邮箱」：先关子页，再打开邮箱应用），App 的
 * replaceState 已经把**当前**历史条目改成了新页面，随后浏览器回到的却是
 * **上一条**历史，那条 URL 里还是旧页面。于是 hashchange 把刚打开的页面又切回去，
 * 表现为「点了校园邮箱，却回到个人中心，邮箱根本没打开」。
 *
 * 所以关闭浮层时要在这里留一个标记，让 App 的 hashchange 监听知道
 * "这次回退是我们自己造的，别信那条过期 URL"。
 *
 * 为什么记时间戳而不是布尔：如果前后 URL 的 hash 恰好相同（比如关的是
 * 「全部应用」里的子页，而外层本来就停在 #/apps），那次 back() 不产生
 * hashchange，布尔标记就会一直挂着，把之后某次真正的用户导航悄悄吞掉。
 * 用时间窗口只影响紧接着的那一次，超时就自动失效。
 */
let internalPopAt = 0
/** 内部回退的识别窗口：足够覆盖一次 back() 的响应延迟，又不会误伤用户稍后的导航 */
const INTERNAL_POP_WINDOW_MS = 1200
/** 最上层再返回时回调；返回 true = 已处理（继续留在应用内），false = 交给系统退出 */
let rootBackHandler: (() => boolean) | null = null

function onPop(): void {
  if (suppressPop > 0) {
    suppressPop--
    return
  }
  const top = stack.pop()
  if (top) {
    top.close()
    return
  }
  // 没有任何应用内步骤时：说明已经在最上层
  if (rootGuarded) {
    const handled = rootBackHandler?.() ?? true
    /* 回调说"没处理"（例如用户在 2 秒内第二次按返回，想真的退出）→ 不再补历史，
       让 WebView 的下一次返回落到系统，Activity 正常关闭。
       默认（无回调）维持老行为：吞掉这次返回，应用不退出。 */
    if (handled) window.history.pushState(null, '')
  }
}

function ensureListener(): void {
  if (listenerOn) return
  listenerOn = true
  window.addEventListener('popstate', onPop)
}

/** 当前是否存在可回退的应用内步骤（边缘手势据此决定要不要响应） */
export function hasBackStep(): boolean {
  return stack.length > 0
}

/**
 * 刚才那次回退是不是 UI 自己造的（取一次即清，且只在时间窗口内有效）。
 * App 的 hashchange 监听据此跳过对过期 URL 的解析。
 */
export function consumeInternalPop(): boolean {
  if (!internalPopAt) return false
  const fresh = Date.now() - internalPopAt < INTERNAL_POP_WINDOW_MS
  internalPopAt = 0
  return fresh
}

/** 在应用壳层调用一次：让最上层的返回键不会退出应用 */
export function armRootBackGuard(onRootBack?: () => boolean): void {
  if (!rootGuarded) {
    ensureListener()
    rootGuarded = true
    window.history.pushState(null, '')
  }
  if (onRootBack) rootBackHandler = onRootBack
}

/** open=true 时注册一个“上一步” */
export function useBackStep(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    ensureListener()
    const entry: Entry = { close: () => closeRef.current() }
    stack.push(entry)
    window.history.pushState(null, '')
    return () => {
      const i = stack.indexOf(entry)
      if (i < 0) return // 已被返回键弹出并关闭
      const wasTop = i === stack.length - 1
      stack.splice(i, 1)
      if (wasTop) {
        /* UI 主动关闭：撤销我们压入的历史条目（抑制随之而来的 popstate）。
           同时留标记给 App 的 hashchange 监听：那次回退是自造的，它带回的 URL 是
           关闭前的旧页面，不能拿来重置界面状态。 */
        suppressPop++
        internalPopAt = Date.now()
        window.history.back()
      }
    }
  }, [open])
}

/** 起手区宽度（px）：与系统手势的边缘感应区同宽，触感一致 */
const EDGE_PX = 28
/** 触发距离（px）：从起手点向右滑过这个距离才算返回 */
const TRIGGER_PX = 56

/**
 * 判断触摸点是否落在可横向滚动的容器内。
 *
 * 为什么要排除：课表周视图、话题 chips 这类容器本身就是横向滚动的，
 * 用户在里面左滑看内容时，手指起点很可能正好贴着屏幕左缘 ——
 * 不排除的话，"翻课表"会被误判成"返回"。
 * 只向上找 4 层：既能覆盖真实容器，又不会为了一次触摸去遍历整棵 DOM。
 */
function insideHorizontalScroller(el: EventTarget | null): boolean {
  let node = el instanceof HTMLElement ? el : null
  for (let i = 0; i < 4 && node; i++) {
    if (node.scrollWidth - node.clientWidth > 8) {
      const ox = getComputedStyle(node).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * 页面内「左缘右滑返回」。
 *
 * 为什么系统手势之外还需要它：Android 全面屏手势与 iOS Safari 的边缘返回
 * 会**先被系统截走**——页面收不到后续的 touchmove，只会收到 touchcancel。
 * 所以真正能走到这段逻辑的，只有系统不接管边缘的场景（桌面浏览器、三键导航、
 * 部分 WebView 内核）。两者天然互斥，不会重复触发一次返回。
 *
 * 实现上刻意 **不调用 preventDefault**：一旦阻止默认行为，
 * iOS 的原生边缘滑动返回就失效了，等于为了兜底把主路径弄坏。
 */
export function useEdgeSwipeBack(): void {
  useEffect(() => {
    let startX = 0
    let startY = 0
    let armed = false
    let fired = false

    const onStart = (e: TouchEvent) => {
      fired = false
      if (e.touches.length !== 1 || !hasBackStep()) {
        armed = false
        return
      }
      const t = e.touches[0]
      armed = t.clientX <= EDGE_PX && !insideHorizontalScroller(e.target)
      startX = t.clientX
      startY = t.clientY
    }

    const onMove = (e: TouchEvent) => {
      if (!armed || fired) return
      const t = e.touches[0]
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      // 必须横向主导：否则纵向滚列表时手指略微右偏就会误触发返回
      if (dx < TRIGGER_PX) return
      if (Math.abs(dy) > dx * 0.6) {
        armed = false
        return
      }
      fired = true
      armed = false
      /* 走 history.back() 而不是直接调 close：
         与系统返回键、边缘手势共用同一条路径，栈的弹出顺序完全一致。 */
      window.history.back()
    }

    const onEnd = () => {
      armed = false
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [])
}
