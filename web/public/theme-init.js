/* 首屏防闪：在 React 挂载前就按本地偏好定好主题，避免出现「先白后黑」的跳变。
 *
 * 为什么单独放成外部文件而不是内联在 index.html 里？
 *   内联脚本会被 CSP 的 script-src 'self' 拦下，只能给 CSP 开 'unsafe-inline'（等于放弃
 *   脚本注入防护）。外置成同源文件后可写 `script-src 'self'`：仍然是 head 里的同步脚本、
 *   依旧在首次绘制前执行，防闪效果不变，但 CSP 不必为它破例。
 *   ⚠️ 改动本文件后无需改 CSP（同源静态资源）；只有把它改回内联才需要动 CSP。
 *
 * 解析逻辑刻意与 web/src/lib/theme.ts 保持一致，两处需同步修改。
 */
(function () {
  try {
    var mode = localStorage.getItem('bjtu-theme') || 'dark'
    var resolved =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : mode === 'light'
          ? 'light'
          : 'dark'
    document.documentElement.setAttribute('data-theme', resolved)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0e1013')
    /* 首屏防闪：自选主题色（色相）也提前恢复，避免先闪一下默认青绿 */
    var accent = localStorage.getItem('bjtu-accent')
    if (accent && /^\d{1,3}$/.test(accent) && Number(accent) <= 359) {
      document.documentElement.style.setProperty('--accent-h', accent)
    }
  } catch (e) {
    /* localStorage 被禁用时保持默认深色 */
  }
})()
