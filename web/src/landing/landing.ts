/**
 * 首页交互脚本（原生 TS，不引 React / 不引动画库）
 *
 * 为什么首页不用 React：这一页只需要几件小事 —— 切主题、填版本信息、复制校验值、
 * 识别是否在 App 内打开、以及一批纯装饰动效。用 React 会让首屏多下载一个框架运行时
 * （~140KB gzip），而首页恰恰是最需要"秒开"的一页；静态 HTML + 这点脚本，首屏产物可以压到几 KB。
 *
 * ⚠️ 本文件必须由 landing.html 以 `type="module" src=...` 外置引入。
 *    应用 CSP 是 `script-src 'self'`，内联 <script> 会被浏览器直接拦下。
 *
 * ⚠️ 动效是否启用由 public/landing-fx.js 在 <head> 里同步决定（html.lp-fx / html.lp-no-fx）。
 *    本文件只负责"在允许的前提下实现效果"，不做环境判断。
 */

/* ---------------- 小工具 ---------------- */

/** matchMedia 在极老的浏览器里不存在，包一层避免直接抛错打断后续初始化 */
function media(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  } catch {
    return false
  }
}

const rootEl = document.documentElement

/** 与 landing-fx.js 约定的"动效已初始化"标记。没置上它，head 里的兜底会在 load 后摘掉 lp-fx。 */
const fxFlag = window as Window & { __lpFxReady?: boolean }

/** 是否有真正的指针（鼠标 / 触控笔）。触屏手机这里是 false，聚光、倾斜、跟随光都要换写法。 */
function hasFinePointer(): boolean {
  return media('(hover: hover) and (pointer: fine)')
}

/* ---------------- 主题 ---------------- */

/** 与应用共用的存储键（web/src/lib/theme.ts 的 THEME_KEY）。共用才能"首页切了，进应用还是这个主题"。 */
const THEME_KEY = 'bjtu-theme'

type Resolved = 'dark' | 'light'

function currentTheme(): Resolved {
  return rootEl.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function setupThemeToggle(): void {
  const btn = document.getElementById('themeBtn')
  if (!btn) return
  const sync = (): void => {
    const dark = currentTheme() === 'dark'
    // 按钮文案说明"切过去会变成什么"，比只放一个图标更好懂；
    // aria-pressed 表达"当前是否深色"，供读屏播报状态（光改文案是不会被播报的）。
    btn.textContent = dark ? '浅色' : '深色'
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false')
  }
  btn.addEventListener('click', () => {
    const next: Resolved = currentTheme() === 'dark' ? 'light' : 'dark'
    rootEl.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* 隐私模式下 localStorage 不可写，忽略：本次会话仍然生效 */
    }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', next === 'light' ? '#f4f6f9' : '#0e1013')
    sync()
  })
  sync()
}

/* ---------------- 应用内 / 老用户提示条 ---------------- */

/**
 * 在两种情况下显示顶部提示条（一键回应用）：
 *   ① 身处 App 的 WebView 里，但没有登录态 —— 旧版 App 首次安装就是这个状态；
 *   ② 普通浏览器，但本机有登录态 —— 用过这个应用的老用户。
 *
 * ⚠️ 对 ② 刻意只**提示**、不强制跳转。真正强制跳转的只有 landing-redirect.js 里那三种
 *   "确定是从 App 打开"的信号。原因见那个文件里的注释：浏览器里无条件跳转会让
 *   回退键看起来坏掉（返回 / 又被 replace 回 /app）。
 *
 * 判定用的 token 键 `bjtu-token` 必须与 web/src/api.ts 的 TOKEN_KEY 一致，
 * 写错不会报错、只是提示条永远不出现（典型的静默失效）。
 */
function setupInAppBar(): void {
  const bar = document.getElementById('inAppBar')
  if (!bar) return
  const ua = navigator.userAgent
  const inShell = ua.includes('BjtuHelperApp') || ua.includes('; wv)')
  let hasToken = false
  try {
    hasToken = !!localStorage.getItem('bjtu-token')
  } catch {
    /* 隐私模式下读不到，按新访客处理 */
  }
  if (!inShell && !hasToken) return
  const text = document.getElementById('inAppText')
  if (text) text.textContent = inShell ? '检测到你正在 App 内打开' : '你之前用过这个应用'
  bar.removeAttribute('hidden')
}

/* ---------------- 窄屏导航菜单 ---------------- */

/**
 * 窄屏（≤760px）把横向导航收进汉堡下拉。
 *
 * ⚠️ 这一步与动效无关，**不受 lp-fx 影响**：导航是功能，不是装饰，
 *   即使 WebView 里关掉了全部动效，菜单也必须能开。
 *   无 JS 时由 <head> 里的 <noscript> 样式退回成一行可换行的链接。
 */
function setupNavMenu(): void {
  const btn = document.getElementById('menuBtn')
  const links = document.getElementById('navLinks')
  if (!btn || !links) return

  const setOpen = (open: boolean): void => {
    rootEl.classList.toggle('lp-nav-open', open)
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  btn.addEventListener('click', () => {
    setOpen(!rootEl.classList.contains('lp-nav-open'))
  })
  // 点了任一链接就收起，避免跳转后菜单还挂在页面上
  links.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) setOpen(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false)
  })
  // 拉宽回桌面断点后要清掉状态，否则下次缩窄会带着旧的 open
  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) setOpen(false)
  })
}

/* ---------------- 下载信息（单一事实来源） ---------------- */

interface ApkManifest {
  versionName: string
  versionCode: number
  fileName: string
  url: string
  sizeBytes: number
  sha256: string
  md5?: string
  releasedAt: string
  packageName: string
  osRequirement: string
  changelog: string[]
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fill(selector: string, text: string): void {
  const el = document.querySelector(selector)
  if (el) el.textContent = text
}

/**
 * 版本号、大小、日期、校验值与更新日志全部来自 /downloads/manifest.json。
 *
 * 为什么不在 HTML 里写死：这些值会随每次发版变化，手写必然过期，
 * 而且"页面写着 v1.2 但下载到 v1.3"这种不一致最难被发现。
 * 统一从清单取，发版时只改一个文件。
 */
async function loadApkInfo(): Promise<void> {
  const shaEl = document.querySelector('[data-apk-sha]')
  try {
    const res = await fetch('/downloads/manifest.json', { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    const m = (await res.json()) as ApkManifest

    fill('[data-apk-version]', `v${m.versionName}（${m.versionCode}）`)
    fill('[data-apk-date]', m.releasedAt)
    fill('[data-apk-size]', formatSize(m.sizeBytes))
    fill('[data-apk-os]', m.osRequirement)
    fill('[data-apk-pkg]', `包名 ${m.packageName} · 仅在本站分发`)
    if (shaEl) shaEl.textContent = m.sha256

    // 直接挂到具体文件（而不是 /download/latest 重定向），让浏览器能正确显示文件名与进度
    const btn = document.getElementById('apkBtn')
    if (btn instanceof HTMLAnchorElement) {
      btn.href = m.url
      btn.setAttribute('download', `交大小助手-v${m.versionName}.apk`)
    }

    const list = document.querySelector('[data-apk-changelog]')
    if (list && Array.isArray(m.changelog) && m.changelog.length > 0) {
      list.innerHTML = ''
      for (const line of m.changelog) {
        const li = document.createElement('li')
        li.textContent = line
        list.appendChild(li)
      }
    }
  } catch {
    /* 取不到清单（断网/文件缺失）不能让整页看起来像坏了：
       按钮保留 /download/latest 这个服务端重定向入口，校验值处说明情况即可。 */
    if (shaEl) shaEl.textContent = '校验值载入失败，可直接点下方按钮下载最新版本'
    fill('[data-apk-version]', '最新版')
  }
}

/* ---------------- 复制校验值 ---------------- */

function setupCopySha(): void {
  const btn = document.getElementById('copySha')
  const code = document.querySelector('[data-apk-sha]')
  if (!btn || !code) return

  let timer = 0
  const done = (): void => {
    btn.textContent = '已复制'
    btn.classList.add('is-done')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      btn.textContent = '复制'
      btn.classList.remove('is-done')
    }, 1600)
  }

  btn.addEventListener('click', () => {
    const text = (code.textContent || '').trim()
    if (!/^[0-9a-f]{64}$/i.test(text)) return

    // 非安全上下文（http 明文）下没有 clipboard API，退回 execCommand
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done)
      return
    }

    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    // ⚠️ 只有真的复制成功才提示。原实现无条件调用 done()，
    //    复制失败也会显示"已复制"，与"避免误导"的初衷相反。
    if (ok) done()
  })
}

/* ---------------- 回到顶部 ---------------- */

/**
 * 滚过约一屏后从右下角浮出，点一下回顶。
 *
 * ⚠️ 这是**功能**不是装饰，所以放在 lp-fx 门控之外：App WebView 里同样该有。
 *   代价是它必须在没有动效的环境下也好看 —— 于是"出现/消失"只做 opacity+visibility，
 *   不做位移以外的花活（reduced-motion 下连这点过渡也一并关掉）。
 *
 * ⚠️ 用 class 控制可见性，不用 `hidden` 属性：.lp-top 自己声明了 display，
 *   会盖掉 [hidden] 的 display:none，按钮会一直挂在那儿。
 *   CSS 默认 opacity:0 + visibility:hidden，脚本没跑时它根本不会出现（不留死按钮）。
 *
 * 环上的进度用 stroke-dashoffset 表示 —— 它只改描边，不触发任何布局。
 */
function setupBackToTop(): void {
  const btn = document.getElementById('toTop')
  if (!btn) return

  let ticking = false
  const update = (): void => {
    ticking = false
    const y = window.scrollY || document.documentElement.scrollTop || 0
    const max = document.documentElement.scrollHeight - window.innerHeight
    const p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0

    btn.classList.toggle('is-on', y > window.innerHeight * 0.9)
    // dashoffset 语义是"还差多少没画" —— 正好等于"还没读的部分"
    btn.style.setProperty('--lp-top-p', (1 - p).toFixed(4))
  }
  const onScroll = (): void => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(update)
  }

  btn.addEventListener('click', () => {
    /* 显式传 behavior：html 上虽然写了 scroll-behavior: smooth，
       但 reduced-motion 下 CSS 会把它改回 auto —— 这里跟着尊重同一个偏好。 */
    const smooth = !media('(prefers-reduced-motion: reduce)')
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
  })

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  update()
}

/* ---------------- 二维码放大查看 ---------------- */

/**
 * 点击二维码全屏放大。
 *
 * 为什么要做：二维码是"拿手机摄像头去扫屏幕"的，卡片里那点尺寸在小屏上经常扫不出来
 * （模块边长只有 4px 左右）。放大到接近满屏后模块边长能到 10px 以上，成功率差别很大。
 * 而且放大层里长按图片就能直接保存/识别，比让用户对着小图反复对焦友好得多。
 *
 * ⚠️ 放大层必须挂到 document.body 上，不能塞在卡片内部：
 *   任何带 transform 的祖先都会成为 position:fixed 的包含块（本项目在弹层上踩过这个坑），
 *   而卡片有 hover 位移与过渡，一旦将来给卡片加上常驻 transform，嵌在里面的浮层就会
 *   被限制在卡片范围内而不是覆盖整屏。挂 body 是最省事的"等效 Portal"。
 *   —— 现在 .lp-phone 确实有了常驻 transform（3D 倾斜），这条规则更不是可选项了。
 */
function setupQrZoom(): void {
  const triggers = document.querySelectorAll<HTMLElement>('[data-zoom]')
  if (triggers.length === 0) return

  let overlay: HTMLDivElement | null = null
  let lastTrigger: HTMLElement | null = null

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }

  function close(): void {
    if (!overlay) return
    overlay.remove()
    overlay = null
    /* ⚠️ 解除监听必须放在这里，不能只在 onKey 里自解除：
       那样"点遮罩关闭"这条路会每开一次泄漏一个 document 级监听器，
       残留的监听器还会继续响应 Escape 去操作已置 null 的 overlay。 */
    document.removeEventListener('keydown', onKey)
    document.documentElement.style.removeProperty('overflow')
    // 焦点归还触发按钮，否则键盘用户关掉浮层后会掉回页面开头
    if (lastTrigger) {
      lastTrigger.focus()
      lastTrigger = null
    }
  }

  function open(src: string, alt: string, trigger: HTMLElement): void {
    close()
    lastTrigger = trigger

    overlay = document.createElement('div')
    overlay.className = 'lp-lightbox'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', alt)

    const img = document.createElement('img')
    img.src = src
    img.alt = alt
    img.className = 'lp-lightbox-img'
    img.tabIndex = -1

    const tip = document.createElement('p')
    tip.className = 'lp-lightbox-tip'
    tip.textContent = '长按图片可保存 / 识别　·　点击任意处关闭'

    overlay.append(img, tip)
    document.body.appendChild(overlay)
    // 锁住背景滚动，否则放大层里滑动会把后面的页面带着滚
    document.documentElement.style.setProperty('overflow', 'hidden')

    overlay.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    // 焦点移进对话框，避免 Tab 键跑到背后的页面内容上
    img.focus()
  }

  triggers.forEach((el) => {
    el.addEventListener('click', () => {
      const src = el.getAttribute('data-zoom') ?? ''
      const img = el.querySelector('img')
      if (src) open(src, img?.alt ?? '二维码', el)
    })
  })
}

/* ============================================================
   以下全部为装饰性动效，只在 html.lp-fx 下初始化。
   ============================================================ */

/* ---------------- 滚动显隐 ---------------- */

/**
 * 元素进入视口后加 .is-in（CSS 负责从透明+下移过渡到就位）。
 *
 * ⚠️ 只动 opacity / translate，不动 height/margin —— 否则会制造 CLS。
 * ⚠️ 触发一次就 unobserve，避免来回滚动反复播动画。
 * ⚠️ rootMargin 底部收 60px：让元素在完全进入前一点点就开始，观感更跟手。
 */
function setupReveal(): void {
  const items = document.querySelectorAll<HTMLElement>('.lp-reveal')

  const revealAll = (): void => {
    items.forEach((el) => el.classList.add('is-in'))
  }

  if (items.length === 0) {
    fxFlag.__lpFxReady = true
    return
  }
  if (typeof IntersectionObserver !== 'function') {
    revealAll()
    fxFlag.__lpFxReady = true
    return
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        io.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -60px 0px', threshold: 0 }
  )
  items.forEach((el) => io.observe(el))

  // 标记"动效确实初始化过了"，head 里的兜底脚本据此决定要不要摘掉 lp-fx
  fxFlag.__lpFxReady = true
}

/* ---------------- 导航：滚动状态 + 阅读进度 ---------------- */

function setupScrollFx(): void {
  const nav = document.getElementById('siteNav')
  const bar = document.getElementById('navProgress')
  let ticking = false

  const update = (): void => {
    ticking = false
    const y = window.scrollY || document.documentElement.scrollTop || 0

    if (nav) nav.classList.toggle('is-scrolled', y > 24)

    if (bar) {
      const max = document.documentElement.scrollHeight - window.innerHeight
      const p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0
      bar.style.transform = `scaleX(${p.toFixed(4)})`
    }
  }

  /* 禁止在 scroll 回调里直接做 DOM 读写：统一 rAF 节流，一帧最多一次 */
  const onScroll = (): void => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(update)
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  update()
}

/* ---------------- 导航：当前区块高亮 ---------------- */

function setupScrollSpy(): void {
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('.lp-nav-links a[href^="#"]')
  )
  if (links.length === 0 || typeof IntersectionObserver !== 'function') return

  const map = new Map<Element, HTMLAnchorElement>()
  for (const a of links) {
    const id = (a.getAttribute('href') || '').slice(1)
    const el = id ? document.getElementById(id) : null
    if (el) map.set(el, a)
  }
  if (map.size === 0) return

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const active = map.get(entry.target)
        if (!active) continue
        links.forEach((l) => l.classList.toggle('is-active', l === active))
      }
    },
    /* 把观察区压成视口中部一条窄带：只有"正跨过中间"的那一节才算当前区块，
       否则相邻两节会在同一帧里同时命中。 */
    { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
  )
  map.forEach((_a, el) => io.observe(el))
}

/* ---------------- 卡片光标聚光 ---------------- */

/**
 * 卡片跟随指针的柔光：只写 CSS 变量 --mx/--my，具体渲染交给 CSS 的 radial-gradient。
 *
 * 触屏没有 hover 语义，所以手机上改走另一条路（见 setupTouchPress）：
 * 手指按下的那一刻同样写 --mx/--my，但用 .is-lit 代替 :hover 来点亮，
 * 抬手后自动淡出 —— 一份渲染代码，两种触发方式。
 * 写变量用 rAF 节流，避免每个 pointermove 都触发一次样式重算。
 */
function setupSpotlight(): void {
  if (!hasFinePointer()) return
  const cards = document.querySelectorAll<HTMLElement>('.lp-card, .lp-shot')
  if (cards.length === 0) return

  let raf = 0
  let pending: { el: HTMLElement; x: number; y: number } | null = null

  const flush = (): void => {
    raf = 0
    if (!pending) return
    const { el, x, y } = pending
    pending = null
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${Math.round(x - r.left)}px`)
    el.style.setProperty('--my', `${Math.round(y - r.top)}px`)
  }

  cards.forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      pending = { el, x: e.clientX, y: e.clientY }
      if (!raf) raf = requestAnimationFrame(flush)
    })
    el.addEventListener('pointerleave', () => {
      el.style.removeProperty('--mx')
      el.style.removeProperty('--my')
    })
  })
}

/* ---------------- 主视觉手机截图的 3D 倾斜 ---------------- */

/**
 * ⚠️ 给 .lp-phone 加的是常驻 transform —— 它会成为 position:fixed 的包含块。
 *   所以手机框内部不能再放任何 fixed 浮层（二维码放大层因此挂在 body 上）。
 * ⚠️ 移动中不加 transition（否则跟手感很差），只有回正时才过渡。
 */
function setupTilt(): void {
  if (!hasFinePointer()) return
  const visual = document.querySelector<HTMLElement>('.lp-hero-visual')
  const phone = visual?.querySelector<HTMLElement>('.lp-phone')
  if (!visual || !phone) return

  const MAX = 6 // 最大倾角（度）；再大就会显得廉价

  visual.addEventListener('pointermove', (e) => {
    const r = visual.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    phone.classList.remove('is-reset')
    phone.style.setProperty('--ry', `${(px * MAX * 2).toFixed(2)}deg`)
    phone.style.setProperty('--rx', `${(-py * MAX * 2).toFixed(2)}deg`)
  })

  visual.addEventListener('pointerleave', () => {
    phone.classList.add('is-reset')
    phone.style.setProperty('--ry', '0deg')
    phone.style.setProperty('--rx', '0deg')
  })
}

/* ---------------- FAQ 平滑展开 ---------------- */

/**
 * <details> 原生不支持高度过渡，所以拦下点击、改 .lp-faq-wrap 的 grid-template-rows
 * （0fr ↔ 1fr）来做动画，动画结束后再真正切换 open。
 *
 * ⚠️ 只在 lp-fx 下接管：脚本没跑时（无 JS / 减弱动效）走浏览器原生开关，行为不受影响。
 * ⚠️ transitionend 不一定触发（旧浏览器不认 grid-template-rows 的过渡），
 *   所以另配一个超时兜底，保证 open 一定会被切过去，不会卡死。
 */
function setupFaq(): void {
  const items = document.querySelectorAll<HTMLDetailsElement>('.lp-faq details')

  items.forEach((d) => {
    const summary = d.querySelector('summary')
    const wrap = d.querySelector<HTMLElement>('.lp-faq-wrap')
    if (!summary || !wrap) return

    let closing = false

    summary.addEventListener('click', (e) => {
      e.preventDefault()
      if (closing) return

      if (d.open) {
        closing = true
        wrap.style.gridTemplateRows = '0fr'
        const finish = (): void => {
          if (!closing) return
          closing = false
          d.open = false
          wrap.style.gridTemplateRows = ''
        }
        wrap.addEventListener('transitionend', finish, { once: true })
        window.setTimeout(finish, 420)
      } else {
        d.open = true
        wrap.style.gridTemplateRows = '0fr'
        void wrap.offsetHeight // 强制回流，让 0fr 先生效，否则 0fr→1fr 不会产生过渡
        wrap.style.gridTemplateRows = '1fr'
      }
    })
  })
}

/* ---------------- 首屏视差 ---------------- */

/**
 * 滚动时给首屏加一点纵深：极光往上飘、手机截图往上让位。
 *
 * ⚠️ 位移只写进 --lp-py 这个 CSS 变量，真正的落点由 CSS 决定（极光落在伪元素上，
 *   截图落在 .lp-hero-visual 上）。把"算什么"和"动什么"分开，改哪一边都不会牵动另一边。
 * ⚠️ 归一化到**首屏高度**而不是整页高度：否则页面越长，滚到后面位移越大，
 *   首屏早就滚出视野了还在被推着跑。
 * ⚠️ 和 setupScrollFx 一样，scroll 回调里只置脏标记，真正的 DOM 读写在 rAF 里做。
 */
function setupHeroParallax(): void {
  const hero = document.querySelector<HTMLElement>('.lp-hero')
  if (!hero) return
  const visual = hero.querySelector<HTMLElement>('.lp-hero-visual')
  const aurora = hero.querySelector<HTMLElement>('.lp-aurora')
  if (!visual && !aurora) return

  const AURORA_SHIFT = 44 // px，往下飘
  const VISUAL_SHIFT = 30 // px，往上让

  let raf = 0
  const update = (): void => {
    raf = 0
    const y = window.scrollY || document.documentElement.scrollTop || 0
    const h = hero.offsetHeight || 1
    const p = Math.min(1, Math.max(0, y / h))
    if (aurora) aurora.style.setProperty('--lp-py', `${(p * AURORA_SHIFT).toFixed(1)}px`)
    if (visual) visual.style.setProperty('--lp-py', `${(-p * VISUAL_SHIFT).toFixed(1)}px`)
  }
  const onScroll = (): void => {
    if (raf) return
    raf = requestAnimationFrame(update)
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  update()
}

/* ---------------- 首屏指针柔光 ---------------- */

/**
 * 首屏跟随鼠标的柔光，和卡片聚光同一套做法：只写 --hx/--hy，渲染交给 CSS 的 radial-gradient。
 * 触屏没有 hover 语义，直接不启用；写变量走 rAF 节流，避免每个 pointermove 都触发样式重算。
 */
function setupHeroGlow(): void {
  if (!hasFinePointer()) return
  const hero = document.querySelector<HTMLElement>('.lp-hero')
  const glow = document.getElementById('heroGlow')
  if (!hero || !glow) return

  let raf = 0
  let pending: { x: number; y: number } | null = null

  const flush = (): void => {
    raf = 0
    if (!pending) return
    const { x, y } = pending
    pending = null
    const r = glow.getBoundingClientRect()
    glow.style.setProperty('--hx', `${Math.round(x - r.left)}px`)
    glow.style.setProperty('--hy', `${Math.round(y - r.top)}px`)
  }

  hero.addEventListener('pointermove', (e) => {
    pending = { x: e.clientX, y: e.clientY }
    if (!raf) raf = requestAnimationFrame(flush)
  })
}

/* ---------------- 触屏按压反馈（点亮 + 回弹） ---------------- */

/**
 * 触屏专用：手指按下时点亮卡片柔光并轻微收缩，抬手（或滑走取消）后复原。
 *
 * 为什么不用 :active 就完事：
 *   :active 在移动端 Safari 上要等 300ms 点击延迟判定，且一滑走就掉，
 *   反馈会"迟到 + 闪烁"。直接听 pointerdown/pointerup/pointercancel 最准。
 * ⚠️ 只在触屏上挂（hasFinePointer 为 false）：桌面上鼠标 down 也会触发，
 *   那会和现有的 :hover 聚光、hover 抬升打架，出现"点一下反而变暗"。
 * ⚠️ 不做 e.preventDefault()：卡片里可能有链接和按钮，拦掉默认行为会吞掉点击。
 * ⚠️ 只改 class 和两个 CSS 变量，全部命中已经在合成层上的 opacity / transform。
 */
function setupTouchPress(): void {
  if (hasFinePointer()) return

  const targets = document.querySelectorAll<HTMLElement>('.lp-card, .lp-shot, .lp-panel')
  if (targets.length === 0) return

  let lit: HTMLElement | null = null
  const light = (el: HTMLElement, x: number, y: number): void => {
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${Math.round(x - r.left)}px`)
    el.style.setProperty('--my', `${Math.round(y - r.top)}px`)
    el.classList.add('is-lit')
  }

  const clear = (el: HTMLElement | null): void => {
    if (!el) return
    el.classList.remove('is-lit', 'is-press')
    // ⚠️ 不要在这里 removeProperty('--mx')：淡出过程中光心会从"手指位置"跳回 50%，
    //    看起来像闪了一下。变量留着无副作用 —— 下次按下会立刻覆盖。
  }

  targets.forEach((el) => {
    el.addEventListener(
      'pointerdown',
      (e) => {
        lit = el
        el.classList.add('is-press')
        light(el, e.clientX, e.clientY)
      },
      /* passive：这个监听器只读坐标、不拦默认行为，声明成 passive 让浏览器不必等它 */
      { passive: true }
    )
  })

  const release = (): void => {
    if (!lit) return
    const el = lit
    lit = null
    // 抬手后保留点亮 260ms 再淡出：一瞬间全灭会让"点到了"这件事没有回音
    window.setTimeout(() => clear(el), 260)
    el.classList.remove('is-press')
  }

  window.addEventListener('pointerup', release, { passive: true })
  window.addEventListener('pointercancel', release, { passive: true })
  /* 手指按下后开始滚动 → pointercancel 不一定来（部分安卓 WebView），再兜一层 */
  window.addEventListener('scroll', release, { passive: true })
}

/* ---------------- 首屏层深（触屏版视差） ---------------- */

/**
 * 触屏版"主视觉是活的"：滚动时让手机截图做一次小角度 3D 转台。
 *
 * 桌面端靠鼠标位置驱动 setupTilt()，手机上根本没有指针，于是整块主视觉是死的。
 * 这里改用滚动进度当输入：文案里写的仍是 --rx/--ry —— 和桌面倾斜共用同一条
 * CSS transform 声明，不新增合成层、不改样式结构。
 *
 * 角度刻意很小（±7°/±11°）：手机上这块图几乎占满一屏，转多了会晕，而且截图里的
 * 小字会被透视拉斜。转台用 sin 包一层 —— 首屏还在原位时角度为 0（页面一打开是平的，
 * 不会"一进来就歪"），滚到一半转到最大，快要完全滚出去时又转回来。
 * 观感是"图先侧身让开，再自己站直"，两头都是正的，不会留下一个永远歪着的截图。
 */
function setupHeroDepth(): void {
  if (hasFinePointer()) return
  const hero = document.querySelector<HTMLElement>('.lp-hero')
  const phone = hero?.querySelector<HTMLElement>('.lp-phone')
  if (!hero || !phone) return

  const MAX_RX = 7
  const MAX_RY = 11

  let raf = 0
  const update = (): void => {
    raf = 0
    const r = hero.getBoundingClientRect()
    // 以"首屏滚出视口"为 0→1：手机截图刚好处在这个过程中，滚完就不再变
    const h = hero.offsetHeight || 1
    const p = Math.min(1, Math.max(0, -r.top / h))
    const k = Math.sin(Math.PI * p) // 0 → 1 → 0：两头归正
    phone.style.setProperty('--rx', `${(k * MAX_RX).toFixed(2)}deg`)
    phone.style.setProperty('--ry', `${(k * -MAX_RY).toFixed(2)}deg`)
  }
  const onScroll = (): void => {
    if (raf) return
    raf = requestAnimationFrame(update)
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  update()
}

/* ---------------- 关键词跑马灯 ---------------- */

/**
 * 把单份轨道包成两组、克隆一份并排，才能用 translateX(-50%) 做出无缝循环。
 *
 * 为什么在 JS 里克隆而不是在 HTML 里写两遍：
 *   写两遍意味着读屏会把同一批词念两次（首屏到正文之间多出 8 个无意义重复）。
 *   克隆体挂 aria-hidden，读屏只念一份，视觉上却有两份可以首尾相接。
 * ⚠️ 只有这一步真的做成了，才加 .is-loop —— CSS 里所有滚动/遮罩都挂在 .is-loop 上，
 *   于是"脚本没跑 / 关闭动效"时自动退回静态换行排布，不会出现"只有一份、右侧空一半"。
 */
function setupMarquee(): void {
  const track = document.querySelector<HTMLElement>('[data-marquee-track]')
  if (!track || track.children.length === 0) return

  const group = document.createElement('div')
  group.className = 'lp-marquee-group'
  while (track.firstChild) group.appendChild(track.firstChild)

  const clone = group.cloneNode(true) as HTMLElement
  clone.setAttribute('aria-hidden', 'true')
  // 当前轨道里只有 span，但将来若换成链接，克隆体不该再进一次 Tab 序列
  clone.querySelectorAll('a, button').forEach((el) => el.setAttribute('tabindex', '-1'))

  track.append(group, clone)
  track.parentElement?.classList.add('is-loop')
}

/* ---------------- 数字进位 ---------------- */

/**
 * 数据条里的数字从 0 滚到目标值（easeOutCubic：前段快、尾段收，像自己停下来）。
 *
 * ⚠️ HTML 里写的就是**最终值**，脚本只负责"从 0 滚过去"：脚本没跑、关闭动效、
 *   或者用户中途刷新，页面上显示的始终是正确数字，不会停在 0。
 */
function setupCountUp(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-count-to]'))
  if (els.length === 0) return

  const run = (el: HTMLElement): void => {
    const target = Number(el.dataset.countTo)
    if (!Number.isFinite(target)) return
    const DUR = 780
    const t0 = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / DUR)
      const eased = 1 - Math.pow(1 - t, 3)
      el.textContent = String(Math.round(target * eased))
      if (t < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  if (typeof IntersectionObserver !== 'function') {
    els.forEach(run)
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        io.unobserve(entry.target)
        run(entry.target as HTMLElement)
      }
    },
    /* 数字要"进场后再滚"，阈值取高一点：等它真的露出来再动，别在屏幕边缘就开始 */
    { threshold: 0.5 }
  )
  els.forEach((el) => io.observe(el))
}

/* ---------------- 区块指示点 ---------------- */

/**
 * 右侧一列圆点，指示当前读到哪一节，点了直接跳。
 *
 * ⚠️ 纯增强：没有脚本就没有这一列（HTML 里不存在这些节点），不会留下点不动的空壳。
 *   样式上也只有 html.lp-fx 下才 display:flex —— 动效被摘掉时它跟着一起消失。
 * ⚠️ 只收 `main > section[id]`：跑马灯、结尾区这些没有 id 的区块不参与，避免出现
 *   "点了一动也不动"的空锚点。
 */
function setupSectionDots(): void {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('main > section[id]'))
  if (sections.length === 0) return

  const nav = document.createElement('nav')
  nav.className = 'lp-dots'
  nav.setAttribute('aria-label', '区块快速跳转')

  const map = new Map<Element, HTMLElement>()
  for (const s of sections) {
    // 用区块的小标签（"核心能力""怎么用"…）当无障碍名 —— 比 id 好懂得多
    const label = s.querySelector('.lp-eyebrow')?.textContent?.trim() || s.id
    const a = document.createElement('a')
    a.className = 'lp-dot'
    a.href = `#${s.id}`
    a.setAttribute('aria-label', label)
    a.appendChild(document.createElement('span'))
    nav.appendChild(a)
    map.set(s, a)
  }
  document.body.appendChild(nav)

  if (typeof IntersectionObserver !== 'function') return

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const dot = map.get(entry.target)
        if (!dot) continue
        map.forEach((d) => d.classList.toggle('is-active', d === dot))
      }
    },
    /* 和导航高亮用同一条"视口中部窄带"：两处指示必须同步，否则同一个滚动位置
       会出现"导航说是 A、圆点说是 B"的矛盾。 */
    { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
  )
  map.forEach((_dot, el) => io.observe(el))
}

/* ---------------- 启动 ---------------- */

setupThemeToggle()
setupInAppBar()
setupNavMenu()
setupCopySha()
setupQrZoom()
setupBackToTop()
void loadApkInfo()

if (rootEl.classList.contains('lp-fx')) {
  try {
    setupReveal()
    setupScrollFx()
    setupScrollSpy()
    setupSpotlight()
    setupTilt()
    setupTouchPress()
    setupHeroDepth()
    setupFaq()
    setupHeroParallax()
    setupHeroGlow()
    setupMarquee()
    setupCountUp()
    setupSectionDots()
  } catch {
    /* 动效初始化失败 → 摘掉 lp-fx，内容回到"默认可见"。
       宁可没有动效，也绝不能因为一个装饰效果把整页内容藏起来。 */
    rootEl.classList.remove('lp-fx')
  }
}
