/**
 * 头像工具
 *  - initialOf：没有头像时回退成昵称首字（QQ 风格）
 *  - compressAvatar：把用户选中的图片在前端压成 data URL，
 *    既保证服务端（仅接受 png/jpeg/webp）+ 大小上限（~300KB）能过，
 *    又避免把几十 MB 的原图直接塞进 SQLite。
 */

export function initialOf(name: string): string {
  const s = (name || '').trim()
  if (!s) return '?'
  // 中文取首字，英文转大写；emoji 取第一个码点
  return Array.from(s)[0].toUpperCase()
}

const MAX_DIM = 256

/** 把图片源按长边缩放画到 canvas 并导出 JPEG data URL（透明先铺白底） */
function drawToJpeg(source: CanvasImageSource, sw: number, sh: number, maxDim: number, quality: number): string {
  const scale = Math.min(1, maxDim / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持图像处理')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', quality)
}

export function compressAvatar(file: File, maxDim = MAX_DIM, quality = 0.82): Promise<string> {
  if (!file.type.startsWith('image/')) return Promise.reject(new Error('请选择图片文件'))

  // 优先 createImageBitmap + imageOrientation:'from-image'：显式按 EXIF 方向转正。
  // 手机竖拍的照片 EXIF 里带旋转标记，部分浏览器（尤其旧 iOS Safari）drawImage
  // 不套用该标记，上传给识别模型的图就是横躺的，直接导致识别失败。
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      .then((bmp) => {
        try {
          return drawToJpeg(bmp, bmp.width, bmp.height, maxDim, quality)
        } finally {
          bmp.close()
        }
      })
      .catch(() => legacyCompress(file, maxDim, quality)) // 不支持该选项时回退
  }
  return legacyCompress(file, maxDim, quality)
}

/** 兼容路径：FileReader + <img> + canvas（老浏览器；EXIF 处理依赖浏览器自身行为） */
function legacyCompress(file: File, maxDim: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败，请换一张'))
      img.onload = () => {
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        if (!width || !height) {
          reject(new Error('图片尺寸异常'))
          return
        }
        try {
          resolve(drawToJpeg(img, width, height, maxDim, quality))
        } catch {
          reject(new Error('图片编码失败'))
        }
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}
