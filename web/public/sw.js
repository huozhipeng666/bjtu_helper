/**
 * bjtu-helper Service Worker —— 离线课表 / 考务支持
 *
 * 策略总览（每一类资源用最适合它的策略，而不是一刀切）：
 *  1. `/assets/*`（Vite 产出的内容哈希文件名）→ **Cache-First**。文件名带哈希即内容不可变，
 *     命中缓存永远是正确且最快的，不需要回源校验。
 *  2. 应用外壳（`/`、`/index.html`、`/manifest.json`、`/icon.svg`）→ **Network-First**。
 *     外壳必须保持新鲜，否则新版本部署后用户会一直看到旧壳（旧的 hash 引用会 404）。
 *  3. 核心只读接口（courses / week / overview / exams / terms / settings）→ **Network-First**，
 *     断网时降级读缓存，这是「离线看课表与考务」的关键。
 *  4. 其它（写接口、上传、跨域）→ 完全不拦截。
 *
 * ⚠️ 所有异步工作都写在 respondWith 的那个 promise 内部。
 *    刻意不用 `event.waitUntil` 做"游离的后台刷新"：waitUntil 只能在事件派发期间**同步**调用，
 *    在 await 之后再调用会抛 InvalidStateError；而 respondWith 本身已经延长了事件生命周期，
 *    把逻辑收进一个 promise 里既正确又好推理。
 */

/* 缓存版本：**改动任何缓存策略都必须 +1**（activate 只删不等于当前名的缓存，不改名则老缓存永不清理）。
   v3（2026-10-05）：路由切分 —— `/` 从"应用外壳"变成了"官网首页"。
   必须升版本：老设备缓存里的 `/` 仍指向应用壳，装了 PWA 的用户从桌面图标进来会看到
   应用而不是首页 —— 而 `/app` 又没被缓存，语义彻底错位。改版本号是唯一能清掉它的方式。
   v4（2026-10-20）：发版换了整份 `/assets`（内容哈希文件名全变）。
   老缓存里的外壳 HTML 引用的是**已经不存在的** `app-CmezRhfk.js` 这类文件名，
   一旦命中缓存就是「HTML 有了、JS 404」→ 页面一片空白，看起来就是"网站打不开"。
   升版本让 activate 把老缓存整体删掉，客户端被迫重新取一份匹配的新外壳。
   v5（2026-10-28）：删掉「二维码工具」应用（17 → 16 个），AppEntryHost 与 app 的
   chunk 哈希全变，同时首页的 QQ 群码从 `/qr/qq-friend.jpg` 换成 `/qr/qq-group.jpg`。
   ⚠️ 以后**每次发版删掉了旧 assets 文件**，都应该顺手 +1；如果保留旧 assets（见 deploy 流程），
      则不必升 —— 但保留旧文件的成本是磁盘，升版本的成本是用户重下一次外壳。 */
const CACHE_NAME = 'bjtu-helper-cache-v5'

/** 安装时预缓存的外壳文件；只放必然存在的同源静态文件
    ⚠️ `/` 是首页、`/app` 才是应用本体，两个都要预缓存：
    离线导航兜底走的是 /index.html，但用户直接打开 /app 时也应命中缓存而不是白屏。 */
const STATIC_PRECACHE = ['/', '/app', '/index.html', '/manifest.json', '/icon.svg', '/theme-init.js']

/** 允许离线降级的只读接口白名单（前缀匹配）
 *
 *  ⚠️ `/api/tasks` 与 `/api/month` 必须在内：这两个是 DDL 页与月视图的数据源，
 *  而"离线看课表与考务"是本产品的明确承诺（见 manifest 的 description）。
 *  此前白名单只有下面 6 条，导致断网时课表能看、点「DDL」却得到一条
 *  `加载失败：Failed to fetch`（浏览器原生英文文案）—— 承诺与实现自相矛盾。
 *  两条都是 GET、按用户隔离，且缓存键已由 scopedKey() 带上 token 摘要，不会串号。 */
const CACHEABLE_API_PATHS = [
  '/api/courses',
  '/api/week',
  '/api/overview',
  '/api/exams',
  '/api/terms',
  '/api/settings',
  '/api/tasks',
  '/api/month'
]

/** 缓存条目上限：超过就按响应头 Date 淘汰最旧的一批。
 *
 *  为什么需要：`/assets/*` 是 Cache-First 且文件名带 hash，每次发版都会产生新文件；
 *  而 CACHE_NAME 是手工维护的常量（不会每次发版都变），activate 只删"名字不同"的缓存 ——
 *  于是旧版本的 JS/CSS 会**永久累积**。长期使用的设备能攒下几十个版本的产物。
 *  120 条足够覆盖当前版本的全部资源 + 上一两个版本，超出部分都是不会再被引用的死重量。 */
const MAX_CACHE_ENTRIES = 120

/**
 * 开发服务器主机名。
 *
 * ⚠️ 为什么必须在这里自毁，而不能只靠页面侧不注册：
 *   Service Worker 的更新检查与激活是**浏览器自主完成**的，与页面是否调用 register() 无关。
 *   用户浏览器里已装好的旧 SW，仅凭"页面不再注册"清不掉：下一次导航浏览器仍会拉取本文件、
 *   装上新版并 claim 页面，继续以缓存优先拦截 Vite 的 ES 模块流 → React 永远挂不上 →
 *   页面只剩一团黑底色。所以开发域下本文件必须**主动注销自己 + 清空缓存 + 重载标签页**。
 */
const IS_DEV_HOST = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(self.location.hostname)

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 由凭据派生缓存键后缀。
 *
 * ⚠️ 为什么不能直接用 URL 当缓存键：本项目的登录态是 `Authorization: Bearer <token>` 请求头，
 *   而请求头**不参与 Cache 匹配**（Cache 只按 URL + method + Vary 匹配，而响应的 Vary 里只有 Origin）。
 *   于是同一台设备上「A 退出 → B 登录」之后，B 在离线状态下会读到 A 缓存的课表与考试 —— 串号泄露。
 *   把 token 摘要拼进缓存键的查询串即可让缓存天然按账号隔离。
 *   （白名单内的接口路径本身不带查询串，拼接不会与既有参数冲突。）
 */
function authKeyOf(request) {
  const auth = request.headers.get('Authorization') || ''
  if (!auth) return 'anon'
  // djb2：非加密用途，只求"不同 token 极难碰撞"，同步、零依赖
  let h = 5381
  for (let i = 0; i < auth.length; i++) h = ((h << 5) + h + auth.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 生成带账号维度的缓存键 */
function scopedKey(url, request) {
  return `${url.pathname}${url.search ? `${url.search}&` : '?'}__ck=${authKeyOf(request)}`
}

/** 写缓存：失败绝不影响响应（配额满、私密模式等都会让 put 抛错） */
async function putSafe(key, response) {
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(key, response)
  } catch {
    /* ignore */
  }
}

/** 读缓存：失败一律当未命中 */
async function matchSafe(key) {
  try {
    return (await caches.match(key)) || null
  } catch {
    return null
  }
}

/** 统一的兜底响应：绝不让 respondWith 拿到 undefined（那会变成网络错误，页面直接白屏） */
function jsonFallback(message, status = 503) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

/* ------------------------------------------------------------------ *
 * 开发环境：自毁，避免拦截 Vite 模块流导致黑屏
 * ------------------------------------------------------------------ */
if (IS_DEV_HOST) {
  self.addEventListener('install', () => {
    self.skipWaiting()
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        try {
          const clients = await self.clients.matchAll({ type: 'window' })
          await self.registration.unregister()
          const keys = await caches.keys()
          await Promise.all(keys.map((k) => caches.delete(k)))
          // 重载受控标签页，让它们彻底脱离这个已注销的 SW
          await Promise.all(clients.map((c) => ('navigate' in c ? c.navigate(c.url) : undefined)))
        } catch {
          /* 自毁失败也不该把异常抛给浏览器 */
        }
      })()
    )
  })
} else {
  /* ---------------------------------------------------------------- *
   * 生产环境
   * ---------------------------------------------------------------- */

  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        // 逐个 add 而不是 addAll：addAll 是"全有或全无"，任何一项 404 都会让整次安装失败
        await Promise.all(
          STATIC_PRECACHE.map((u) =>
            cache.add(new Request(u, { cache: 'reload' })).catch(() => undefined)
          )
        )
        await self.skipWaiting()
      })()
    )
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => (k === CACHE_NAME ? undefined : caches.delete(k))))
        await pruneCache()
        await self.clients.claim()
      })()
    )
  })

  /** 按响应头 Date 淘汰最旧的条目，把缓存总量压到 MAX_CACHE_ENTRIES 以内。
   *  任何一步失败都静默跳过 —— 清理失败绝不该影响激活（否则新版本永远装不上）。 */
  async function pruneCache() {
    try {
      const cache = await caches.open(CACHE_NAME)
      const reqs = await cache.keys()
      if (reqs.length <= MAX_CACHE_ENTRIES) return
      const entries = []
      for (const req of reqs) {
        const res = await cache.match(req)
        const d = res && res.headers.get('Date')
        const t = d ? Date.parse(d) : 0
        entries.push({ req, t: Number.isFinite(t) ? t : 0 })
      }
      entries.sort((a, b) => a.t - b.t)
      const drop = entries.slice(0, entries.length - MAX_CACHE_ENTRIES)
      await Promise.all(drop.map((e) => cache.delete(e.req)))
    } catch {
      /* ignore */
    }
  }

  /**
   * 首次访问时 SW 尚未接管导航，JS/CSS 是在 SW 生效**之前**下载的，天然不在缓存里 ——
   * 结果就是"装了 SW，但第一次访问刚结束就断网仍然打不开"。
   * 页面在 SW ready 后会把本次已加载的同源静态资源清单发过来，这里补一次预缓存，
   * 让离线能力从**首次访问结束**起就可用。
   */
  self.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.type !== 'PRECACHE_URLS' || !Array.isArray(data.urls)) return
    event.waitUntil(
      (async () => {
        const urls = data.urls
          .filter((u) => typeof u === 'string' && u.startsWith('/'))
          .slice(0, 80)
        if (urls.length === 0) return
        const cache = await caches.open(CACHE_NAME)
        await Promise.all(
          urls.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => undefined))
        )
      })()
    )
  })

  self.addEventListener('fetch', (event) => {
    const req = event.request

    // 只处理同源 GET；写请求、上传、跨域一概放行
    if (req.method !== 'GET') return

    let url
    try {
      url = new URL(req.url)
    } catch {
      return
    }
    if (url.origin !== self.location.origin) return

    // 带 Range 的请求（媒体拖动）不做缓存，交给浏览器原始逻辑
    if (req.headers.has('range')) return

    /* —— 1. 核心只读接口：Network-First，断网降级读缓存 —— */
    if (CACHEABLE_API_PATHS.some((p) => url.pathname.startsWith(p))) {
      const key = scopedKey(url, req)
      event.respondWith(
        (async () => {
          try {
            const res = await fetch(req)
            if (res && res.status === 200) await putSafe(key, res.clone())
            return res
          } catch {
            const cached = await matchSafe(key)
            return cached || jsonFallback('当前处于离线状态，且本设备还没有可用的缓存数据')
          }
        })()
      )
      return
    }

    // 其余接口与用户上传内容不进缓存（避免把 401/500 或大文件写进去）
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return

    /* —— 2. 内容哈希资产：Cache-First（文件名带哈希 = 内容不可变） —— */
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(
        (async () => {
          const cached = await matchSafe(req)
          if (cached) return cached
          try {
            const res = await fetch(req)
            if (res && res.status === 200) await putSafe(req, res.clone())
            return res
          } catch {
            return new Response('', { status: 504, statusText: 'Offline' })
          }
        })()
      )
      return
    }

    /* —— 3. 应用外壳与其它同源 GET：Network-First，离线回退缓存 —— */
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          if (res && res.status === 200 && res.type === 'basic') await putSafe(req, res.clone())
          return res
        } catch {
          const cached = await matchSafe(req)
          if (cached) return cached
          // 导航请求兜底到应用外壳，保证离线打开任意路径都能进 SPA
          if (req.mode === 'navigate') {
            const shell = await matchSafe('/index.html')
            if (shell) return shell
          }
          return new Response('当前处于离线状态，且本页面尚未缓存', {
            status: 504,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          })
        }
      })()
    )
  })
}
