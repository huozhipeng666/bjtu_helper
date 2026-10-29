import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBackStep } from '../lib/back'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** 退场动画时长，与 styles.css 里 .closing 的 animation 时长保持一致 */
const CLOSE_MS = 180

/** 可聚焦元素的选择器（用于打开时定位焦点、以及 Tab 循环） */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Modal({ open, title, onClose, children, footer }: ModalProps) {
  /* 退场动画：open 变 false 后不立刻卸载，先播 180ms 下滑淡出再摘掉 DOM */
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  /** 打开前的焦点元素：关闭后要还回去，否则焦点会掉到 body（键盘用户瞬间"迷路"） */
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  /**
   * onClose 的 ref 镜像。
   *
   * ⚠️ 为什么必须这么写：下面那个焦点 effect 绝不能依赖 `onClose`。
   *    调用方普遍传内联箭头函数（如 App.tsx 的 `onClose={() => setLoginPrompt(null)}`），
   *    父组件每 setState 一次（弹一条 toast、未读数刷新、settings 更新…）都会给出新函数身份，
   *    effect 就会重跑 —— 重跑意味着把焦点**重新抢到第一个可聚焦元素**：
   *    用户在登录弹层里正常输入密码，App 那边一来一条 toast，密码框就失焦，
   *    输入直接丢给 body。同时 restoreRef 被覆盖成"弹层里的元素"，关闭时也还不到原处。
   *    用 ref 后 effect 只依赖 `[open]`，行为可预测。 */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, CLOSE_MS)
    return () => clearTimeout(t)
  }, [open, mounted])

  // 移动端返回键关闭弹层
  useBackStep(open, onClose)

  /* 焦点管理 + Esc 关闭。
     为什么需要：弹层打开后焦点仍停在背后的页面里，键盘用户按 Tab 会一路跑到遮罩后面，
     读屏用户则完全不知道"上下文已经变了"。这里做三件事：
     ① 打开时把焦点移进弹层（第一个可聚焦元素）；
     ② Tab / Shift+Tab 在弹层内循环（简单的焦点陷阱）；
     ③ 关闭后把焦点还给触发它的元素。 */
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const panel = panelRef.current
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null) : []

    /* 延后一帧：Portal 的内容此刻可能还没挂上（mounted 刚变 true） */
    const raf = requestAnimationFrame(() => {
      const list = focusables()
      ;(list[0] ?? panel)?.focus()
    })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        panel?.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      /* 焦点跑到弹层外（或压根不在里面）时，也要拉回来 —— 否则陷阱形同虚设 */
      if (!panel?.contains(active)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      /* 关闭后还原焦点（元素可能已被移除，所以要判 isConnected） */
      const prev = restoreRef.current
      if (prev && prev.isConnected) prev.focus()
    }
  }, [open])

  if (!mounted) return null

  /* 为什么必须 Portal 到 body：
     页面内容区 .anim-content 的**直接子元素**带入场动画（keyframes 含 transform）。
     只要祖先存在 transform，它就是 position:fixed 的包含块（containing block），
     弹层的 inset:0 会相对"整块页面内容"而不是视口定位；内容一超过一屏，
     弹层就被顶到列表最底部的视口之外 —— 表现就是"点了按钮完全没反应"。
     挂到 body 后弹层始终相对视口定位，且不受祖先 z-index / overflow 影响。 */
  return createPortal(
    <div className={`modal-overlay${closing ? ' closing' : ''}`} onClick={() => onCloseRef.current()}>
      <div
        className={`modal${closing ? ' closing' : ''}`}
        ref={panelRef}
        /* dialog 语义：读屏会播报"对话框 + 标题"，而不是把它当成一坨普通内容。
           aria-modal 告诉读屏"背后的内容暂时不可交互"。 */
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>{title}</h3>
        {children}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
