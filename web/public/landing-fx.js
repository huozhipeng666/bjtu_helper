/* 首页动效开关：在 <head> 里**同步**执行，早于首次绘制。
 *
 * 为什么必须外置且同步（和 theme-init.js 同样的理由）：
 *   1. CSP 是 `script-src 'self'`，内联脚本会被浏览器直接拦下；
 *   2. 滚动显隐依赖 `html.lp-fx` 这个 class 来决定元素初始是否透明 ——
 *      如果等 <body> 末尾的 module 脚本（deferred）才加上，用户会先看到
 *      完整内容、再"跳"成透明、再淡入（一次可见的闪动）。
 *      放在 head 的同步脚本里，首次绘制前 class 就位，不存在这个窗口。
 *
 * 两个 class 的语义（CSS 里以它们为开关，见 landing.css 顶部注释）：
 *   lp-fx     允许 JS 驱动的动效（滚动显隐 / 聚光 / 3D 倾斜 / 进度条）
 *   lp-no-fx  明确关闭：App WebView 环境。此时连噪点、极光这些静态装饰层也一并去掉
 *
 * ⚠️ 兜底：module 脚本（landing.ts）万一加载失败，lp-fx 会一直挂着，
 *   `.lp-reveal` 元素就永远停在 opacity:0 —— 整页看起来是空白。
 *   所以这里在 window load 后检查一次"动效是否真的初始化过"，没初始化就把
 *   lp-fx 摘掉，让内容恢复默认可见。宁可没有动效，也绝不能白屏。
 */
(function () {
  try {
    var root = document.documentElement

    var ua = navigator.userAgent || ''
    // 我们自己的 App（v1.2 起追加的标记）与 Android WebView（微信/QQ 内置浏览器也带 ; wv)）
    var inShell = ua.indexOf('BjtuHelperApp') !== -1 || /;\s*wv\)/.test(ua)

    var reduce = false
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch (e) {
      /* 老浏览器没有 matchMedia，按"不减少"处理 */
    }

    if (inShell) {
      root.classList.add('lp-no-fx')
      return
    }
    if (reduce) return // 交给 CSS 的 prefers-reduced-motion 分支，不加 lp-fx 即无动效

    root.classList.add('lp-fx')

    window.addEventListener('load', function () {
      window.setTimeout(function () {
        if (!window.__lpFxReady) root.classList.remove('lp-fx')
      }, 900)
    })
  } catch (e) {
    /* 任何异常都不留隐患：不加 class 即"无动效但内容正常可见" */
  }
})()
