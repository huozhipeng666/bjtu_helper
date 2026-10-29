/**
 * 分享图预览层（设计稿图3 的第二步：预览 → 长按保存）。
 *
 * 为什么把预览单独做成一层全屏浮层，而不是留在「分享课表」弹层里放张小图：
 *   ① 用户看图时希望图尽量大。缩在弹层里的小图根本看不清课名，
 *      预览就失去了意义 —— 而"先看一眼再决定要不要存"正是这一步的全部价值。
 *   ② 手机上的「保存到相册」就是**长按图片**。长按要能唤出系统菜单，
 *      图必须是真实的 <img>、尺寸稳定、且不被弹层的滚动容器裁切。
 *      塞在设置弹层里滚动的小图，长按区域会跟着列表一起动，很容易按空。
 *   ③ 预览独立成层之后，"改设置 → 再预览"是一个清晰的来回，
 *      而不是在同一屏里让开关和图片互相打架。
 *
 * ⚠️ 关于长按：这里**刻意不拦截** contextmenu，也不设
 * `pointer-events:none` / `user-select:none` / `-webkit-touch-callout:none` ——
 * 任何一条都会把系统的"保存图片"菜单一并干掉，功能就没了。
 * 具体样式见 styles.css 的 .imgview-img 注释。
 *
 * 底部仍保留一个「保存到相册」按钮：桌面浏览器、以及部分不弹长按菜单的
 * WebView 里长按是无效的，按钮是那些环境的兜底路径，不是多余的第二入口。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackStep } from '../lib/back'
import { IconClose, IconDownload } from '../icons'

interface ShareImagePreviewProps {
  open: boolean
  /** 预览图（data URL，长按可保存） */
  src: string
  onClose: () => void
  /** 兜底保存路径；返回后由调用方决定提示文案 */
  onSave: () => Promise<void> | void
}

/** 退场动画时长，与 styles.css 里 .imgview 的 animation 时长保持一致 */
const CLOSE_MS = 200

export default function ShareImagePreview({ open, src, onClose, onSave }: ShareImagePreviewProps) {
  const [mounted, setMounted] = useState(open)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) return
    const t = setTimeout(() => setMounted(false), CLOSE_MS)
    return () => clearTimeout(t)
  }, [open, mounted])

  // 移动端返回键：先关预览层，再关它下面的「分享课表」弹层（back.ts 内部是栈）
  useBackStep(open, onClose)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!mounted) return null

  /* 与 Modal 同理必须 Portal 到 body：
     .anim-content 的直接子元素带入场 transform，会成为 position:fixed 的包含块，
     浮层会相对"整块页面内容"定位而不是视口 —— 长图一滚就跑到屏幕外。 */
  return createPortal(
    <div className="imgview" onClick={onClose} role="dialog" aria-modal="true" aria-label="课表分享图预览">
      <div className="imgview-bar">
        <button type="button" className="imgview-close" onClick={onClose} aria-label="关闭预览">
          <IconClose size={18} />
        </button>
      </div>

      <div className="imgview-body">
        {/* 点图不关层：长按唤菜单时手指抬起可能带出一个 click，
            若让它冒泡到遮罩就会"菜单刚出来浮层就没了"。
            关闭只走右上角按钮 / 点空白 / 返回键。 */}
        <img className="imgview-img" src={src} alt="课表分享图" onClick={(e) => e.stopPropagation()} />
      </div>

      <div className="imgview-foot">
        <p className="imgview-hint">长按图片即可保存到相册</p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation()
            setSaving(true)
            Promise.resolve(onSave()).finally(() => setSaving(false))
          }}
        >
          <IconDownload size={16} />
          {saving ? '处理中…' : '保存到相册'}
        </button>
      </div>
    </div>,
    document.body
  )
}
