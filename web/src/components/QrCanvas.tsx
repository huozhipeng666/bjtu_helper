/**
 * 二维码渲染组件（零依赖）。
 *
 * ⚠️ 为什么必须有「长按保存」而不是只给个 canvas：
 *   校园卡 / 校园网这两个场景的**真实用法是拿另一台手机扫码**，
 *   或者把二维码存下来再用微信扫。只渲染一个 canvas 等于逼用户截屏。
 *
 * ⚠️ 长按保存的三个「必须不做」（项目里 shareImage 已踩过同样的坑）：
 *   1. `<canvas>` 不能拦 `contextmenu`（拦了系统长按菜单就不出来，用户没法保存）；
 *   2. 不能设 `pointer-events: none`（那样长按事件根本到不了元素）；
 *   3. 不能设 `user-select: none`（部分浏览器会连带禁掉长按保存）。
 */
import { useEffect, useRef } from 'react'
import { encodeQr, drawQrToCanvas } from '../lib/qrcode'
import { saveBlob, type SaveResult } from '../lib/saveFile'

interface QrCanvasProps {
  /** 要编码的内容 */
  value: string
  /** 渲染尺寸（CSS 像素）。实际画布按 devicePixelRatio 放大，保证不糊 */
  size?: number
  /** 内容过长等编码失败时的回调（默认静默） */
  onError?: (msg: string) => void
  /** 外部拿画布引用（用于「保存二维码」下载 PNG） */
  canvasRef?: (el: HTMLCanvasElement | null) => void
}

export default function QrCanvas({ value, size = 220, onError, canvasRef }: QrCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const bindRef = (el: HTMLCanvasElement | null) => {
    ref.current = el
    canvasRef?.(el)
  }

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    try {
      const matrix = encodeQr(value)
      /* 按 CSS 尺寸 × DPR 计算 scale，保证在高分屏上不糊。
         scale 取整（Math.floor）—— 非整数 scale 会让模块边界落在半个像素上，
         照片式平滑显示还好，但这种像素块图案会出现粗细不均的缝，影响识别。 */
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const modules = matrix.length + 8 // 含 4 模块静区
      const scale = Math.max(2, Math.floor((size * dpr) / modules))
      drawQrToCanvas(canvas, matrix, { scale, quietZone: 4 })
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
    } catch (e) {
      onError?.(e instanceof Error ? e.message : '二维码生成失败')
    }
    // onError 刻意不进依赖：调用方通常传内联箭头函数，进依赖会导致每次渲染都重画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, size])

  return <canvas ref={bindRef} />
}

/**
 * 把已渲染的二维码画布保存为 PNG。
 *
 * ⚠️ 必须走 saveBlob 而不是 `<a download href="data:...">`：
 * Android WebView 里后者点了完全没反应（见 lib/saveFile.ts 顶部注释）。
 * 返回 Promise 是因为原生桥写文件是异步的。
 */
export async function saveQrCanvas(
  canvas: HTMLCanvasElement | null,
  fileName = 'qrcode.png'
): Promise<SaveResult> {
  if (!canvas) return { ok: false, via: 'browser', message: '二维码尚未生成，请稍后重试' }
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), 'image/png')
    })
    return await saveBlob(blob, fileName)
  } catch (e) {
    return { ok: false, via: 'browser', message: e instanceof Error ? e.message : '保存失败' }
  }
}
