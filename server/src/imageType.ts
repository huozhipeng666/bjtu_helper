/**
 * 图片真实类型嗅探（magic bytes）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 上传接口此前只校验 `data:` URL 里**声明的** MIME：
 *   `data:image/png;base64,<把 SVG 脚本塞进来的字节>`
 * 声明是 `image/png` 就放行，于是一个 `<svg onload=...>` 会以 `.png` 落盘，
 * 访问时还带着 `Content-Type: image/png`。实测确实能上传成功。
 *
 * 声明可以被任意伪造，**文件头不能**——它是内容自身的属性。
 * 所以判"是不是真图片"必须看字节，不能看标签。
 *
 * ── 实际风险等级：低，但值得堵 ────────────────────────────────────
 * 当前有 `X-Content-Type-Options: nosniff` + CSP `img-src 'self' data: blob:` 兜着，
 * 伪装文件在 `<img>` 上下文不会执行脚本，直接访问也不会被嗅探成 HTML。
 * 但这类"多层防御里恰好都挡住了"的结论很脆弱：
 * 任何一层（比如有人为了兼容方便去掉 nosniff、或把 uploads 挪到 CDN、
 * 或将来加个"在线预览"功能）被改动，伪装文件立刻变成可用的存储型 XSS 载荷。
 * 校验成本只有几十行，属于性价比很高的纵深防御。
 *
 * ── 为什么不用第三方库（如 file-type）────────────────────────────
 * 只需认 3 种格式，字节签名是稳定的公开常量，自己写比多引一个依赖更可控，
 * 也不会在升级时被上游的启发式规则变化影响（本项目一贯的取舍，见 CSP 那段注释）。
 */

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/webp'

/** PNG: 89 50 4E 47 0D 0A 1A 0A */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** JPEG: FF D8 FF */
const JPEG_SIG = [0xff, 0xd8, 0xff]
/** WebP: 'RIFF' ???? 'WEBP'（第 4~7 字节是文件长度，可变，故分段比对） */
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

function startsWith(buf: Uint8Array, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false
  }
  return true
}

/**
 * 按文件头判断真实图片类型。
 * @returns 识别出的 MIME；无法识别（含伪装、截断、非图片）一律返回 null
 */
export function sniffImageType(buf: Uint8Array): SniffedImageType | null {
  if (!buf || buf.length < 12) return null
  if (startsWith(buf, PNG_SIG)) return 'image/png'
  if (startsWith(buf, JPEG_SIG)) return 'image/jpeg'
  /* WebP 需要同时满足头部 RIFF 与偏移 8 处的 WEBP，缺一不可 */
  if (startsWith(buf, RIFF) && startsWith(buf, WEBP, 8)) return 'image/webp'
  return null
}

/**
 * 校验"声明的 MIME"与"真实字节"是否一致。
 *
 * 注意：这里要求**完全相等**而不是"同属图片即可"。
 * 若只要求"识别出是某种图片"，把 GIF 改名成 PNG 也能过 —— 落盘扩展名与实际内容
 * 不符，将来做格式转换/缩略图时会出现难以定位的怪问题。
 *
 * @returns null = 通过；否则返回给用户的错误文案
 */
export function checkImageConsistency(declaredMime: string, buf: Uint8Array): string | null {
  const actual = sniffImageType(buf)
  if (!actual) {
    return '文件内容不是有效的图片（仅支持 png / jpg / webp）。请确认没有把其他格式改成图片后缀'
  }
  if (actual !== declaredMime) {
    return `文件内容与声明的格式不一致（声明 ${declaredMime}，实际 ${actual}）`
  }
  return null
}