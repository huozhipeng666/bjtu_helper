/**
 * 左滑露出删除按钮的容器（课程卡片用）。
 *
 * 实现要点（移动端手势的三个坑）：
 *  1) 方向锁：touchstart 记录起点，touchmove 首次超过阈值时判定本次是横向滑动还是纵向滚动；
 *     判为纵向后本次手势彻底不参与滑动，避免"想滚页面却把卡片滑开"。
 *  2) touch-action: pan-y（写在 CSS 里）：告诉浏览器这一行只处理纵向滚动，
 *     横向手势不再被浏览器抢去做滚动/回弹，React 的 touchmove 才能稳定拿到事件。
 *     这也避免了用 passive:false 的原生监听器去 preventDefault。
 *  3) 点击抑制：滑动结束时 movedRef 为 true，下一次点击在冒泡到卡片（打开编辑）之前
 *     被 onClickCapture 拦掉并收起，避免"滑完手指一松就误进编辑页"。
 *
 * ── 2026-10-27 跟手改造 ─────────────────────────────────────────────
 * 之前每次 touchmove 都 `setOffset(next)`：手指每移动一帧就触发一次 React 重渲染，
 * 整棵课程卡子树跟着 reconciliation。真机上表现为"滑得动但发涩"——手势线程
 * 与渲染帧互相等待，且父级列表项越多越明显。
 *
 * 现在分两条路径：
 *  · 手势进行中：只更新 currentRef 并直接写 `content.style.transform`（内联
 *    `transition: none`），**不触发任何 React 渲染**；
 *  · 手势结束：用 settleSwipe() 定下终态，当场把终态值写进 DOM（这次带过渡），
 *    再 setOpen 同步「已展开」这个离散状态。
 * 判定逻辑本身抽在 lib/gesture.ts 里，有单测锁住，行为与改造前逐条一致。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { clampSwipeOffset, settleSwipe, swipeAxis } from '../lib/gesture'
import { IconTrash } from '../icons'

interface SwipeRowProps {
  /** 点击删除按钮时触发（二次确认由父级负责，组件本身不直接删数据） */
  onDelete: () => void
  /** 删除按钮宽度（px），也是最大滑动距离 */
  actionWidth?: number
  children: ReactNode
}

export default function SwipeRow({ onDelete, actionWidth = 76, children }: SwipeRowProps) {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<'x' | 'y' | null>(null)
  /** 手势开始时卡片已展开的位移，滑动要在此基础上叠加 */
  const base = useRef(0)
  /**
   * 当前位移的**唯一真值**。
   *
   * 刻意不放 useState：位移只有「跟手」和「吸附」两个时刻会变，而跟手阶段
   * 每帧 setState 正是改造前掉帧的根因。React 只负责 open 这个离散状态，
   * 连续量全部交给 ref + 直接改 style。
   */
  const current = useRef(0)
  /** 本次手势是否真的横向滑动过（用于抑制随后的 click） */
  const moved = useRef(false)

  /**
   * 把位移落到 DOM 上，不触发渲染。手势期唯一的状态出口。
   *
   * `withTransition = false` 时内联写 `transition: none`，让本帧严格跟手；
   * 松手吸附传 true，交回 CSS 的 0.18s 过渡播回弹。
   * 用内联而不是 .dragging 类：类名的增删要等 React 下一次提交，
   * 而终态值必须**当场**写进 DOM，两者对不上就会出现"先硬跳一下再补动画"。
   */
  function paint(x: number, withTransition: boolean) {
    current.current = x
    const el = contentRef.current
    if (!el) return
    el.style.transition = withTransition ? '' : 'none'
    el.style.transform = `translateX(${x}px)`
  }

  const close = useCallback(() => {
    setOpen(false)
    paint(0, true)
  }, [])

  // 展开后点击/触摸本行以外的地方自动收起，避免多行同时展开
  useEffect(() => {
    if (!open) return
    const onDocTouch = (e: TouchEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('touchstart', onDocTouch)
    return () => document.removeEventListener('touchstart', onDocTouch)
  }, [open, close])

  /* 首帧与外部收起（点空白处）时把位移同步回 DOM。
     吸附动画不在这里处理：handleTouchEnd 会直接用 paint() 写终态。 */
  useEffect(() => {
    if (!open) paint(0, true)
  }, [open])

  function handleTouchStart(e: ReactTouchEvent) {
    const t = e.touches[0]
    if (!t) return
    start.current = { x: t.clientX, y: t.clientY }
    axis.current = null
    moved.current = false
    base.current = open ? -actionWidth : 0
    current.current = base.current
  }

  function handleTouchMove(e: ReactTouchEvent) {
    const s = start.current
    const t = e.touches[0]
    if (!s || !t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (!axis.current) {
      const a = swipeAxis(dx, dy)
      if (!a) return
      axis.current = a
    }
    if (axis.current !== 'x') return
    moved.current = true
    // 只允许向左滑（向右滑就停在 0，不会露出左边的空白）
    paint(clampSwipeOffset(base.current, dx, actionWidth), false)
  }

  function handleTouchEnd() {
    if (axis.current === 'x') {
      // 滑过一半即吸附展开，否则回弹收起；这一次写值要带过渡
      const next = settleSwipe(current.current, actionWidth)
      setOpen(next.open)
      paint(next.offset, true)
    }
    start.current = null
    axis.current = null
  }

  return (
    <div
      ref={rowRef}
      className="swipe-row"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* 删除按钮在内容层下面，内容左移后露出来 */}
      <button
        type="button"
        className="swipe-action"
        style={{ width: actionWidth }}
        onClick={onDelete}
        aria-label="删除"
        tabIndex={open ? 0 : -1}
      >
        <IconTrash size={18} />
        删除
      </button>
      <div
        ref={contentRef}
        className="swipe-content"
        onClickCapture={(e) => {
          if (open || moved.current) {
            // 展开状态或刚滑过：这次点击只用来收起，不触发卡片本身的编辑
            e.stopPropagation()
            close()
          }
        }}
      >
        {children}
      </div>
    </div>
  )
}
