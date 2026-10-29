/* 首页入口分流：从 App 里打开的人直接送进应用界面，其余人正常看官网首页。
 *
 * 为什么需要它：站点原来只有一个地址 `/`，它就是应用本体。现在 `/` 改成了官网首页，
 * 而那些**已经装在手机上的旧版本 App**（v1.1 的入口写死为 `/`）和
 * **已经添加到桌面的 PWA**（旧 manifest 的 start_url 是 `/`）打开之后会看到一个官网页面 ——
 * 对它们来说这是纯干扰，必须直接送回应用。
 *
 * 判定规则（刻意收得很紧，宁可不跳也不误跳）：
 *   ① display-mode: standalone  → 从桌面图标启动的已安装 PWA，语义明确
 *   ② UA 含 BjtuHelperApp       → 我们自己的新版 App（v1.2 起追加的标记，精确）
 *   ③ Android WebView 且本机有登录态 → 覆盖旧版 App（v1.1 没有自定义 UA，
 *      但它的 WebView localStorage 里必然有 `bjtu-token`：应用一打开就会自动签发游客身份）
 *
 * ⚠️ 为什么不把"有登录态"作为独立条件（那样能把所有老用户都跳走）：
 *   普通浏览器里老用户如果被无条件跳转，回退键会失效 —— 他在 /app 按返回回到 `/`，
 *   页面又把他 replace 回 /app，看起来像"返回键坏了"。本项目在移动端返回行为上踩过够多的坑，
 *   不值得为省一次点击换来这种体验。所以浏览器里只提示、不强制跳（见 landing.ts 顶部横幅）。
 *
 * ⚠️ 微信/QQ 内置浏览器也带 `; wv)`，但它们**没有本地登录态**，
 *   所以只会走到"看首页"这一支 —— 这正是想要的效果：新访客看官网，老用户进应用。
 *
 * `?home=1` 是显式豁免：应用内如果要给"官网"入口，就指向它。
 *
 * ⚠️ 本文件必须外置并由 <head> 同步引入（CSP 是 script-src 'self'，内联脚本会被拦），
 *   而且要放在样式表之前 —— 越早执行，越不容易闪一下首页再跳走。
 */
(function () {
  try {
    if (location.search.indexOf('home=1') !== -1) return

    var ua = navigator.userAgent || ''

    var standalone = false
    try {
      standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
    } catch (e) {
      /* 老浏览器没有 matchMedia，按"不是 PWA"处理 */
    }

    var isOurApp = ua.indexOf('BjtuHelperApp') !== -1
    var isAndroidWebView = /;\s*wv\)/.test(ua)

    var hasToken = false
    try {
      hasToken = !!localStorage.getItem('bjtu-token')
    } catch (e) {
      /* 隐私模式下 localStorage 不可读，按"新访客"处理 */
    }

    if (standalone || isOurApp || (isAndroidWebView && hasToken)) {
      location.replace('/app')
    }
  } catch (e) {
    /* 任何异常都不拦截跳转：最坏结果只是多看一次首页，绝不能白屏 */
  }
})()
