/**
 * 复制文本到剪贴板（带降级链）。
 *
 * ⚠️ 为什么不能只用 navigator.clipboard：
 *   clipboard API 只在**安全上下文**（HTTPS / localhost）可用。
 *   本站历史上长期以 http://<裸IP> 直连（无域名、无证书），
 *   那时线上 `navigator.clipboard` 是 undefined —— 直接 await 调用会抛
 *   TypeError，表现为「点了复制没反应 / 弹复制失败」，校园卡、校园网
 *   两个页面的复制按钮因此全部失效（2026-10-14 实测确认）。
 *
 *   2026-10-20 域名备案 + 证书签发后，https 下 ① 会生效；但**降级链必须保留**：
 *   安全组尚未放行 443 的窗口期、用户手动输入 http 地址、以及旧版 APK
 *   （usesCleartextTraffic=true 的 v1.3 及更早版本）都会落到非安全上下文。
 *
 * 降级链：
 *   ① navigator.clipboard.writeText —— 安全上下文下的现代路径
 *   ② 临时 <textarea> + document.execCommand('copy') —— 非安全上下文仍广泛可用
 *   ③ 返回 false，由调用方给出「手动复制」的提示（例如展示可选中的链接）
 *
 * @returns 是否复制成功
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续降级（用户拒绝授权 / 内核差异） */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
