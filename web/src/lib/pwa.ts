import { useEffect, useState } from 'react'

/**
 * 把本次页面已经加载过的同源静态资源告诉 SW，让它立刻补一次预缓存。
 *
 * 为什么需要：SW 是在首次导航**之后**才接管页面的，所以首访时的 JS/CSS 是在 SW 生效前
 * 下载的，压根没进过缓存 —— 结果是"装了 SW，但首访刚结束就断网仍然打不开"。
 * 补这一刀之后，离线能力从首次访问结束起就可用。
 */
function precacheLoadedAssets(): void {
  const sw = navigator.serviceWorker
  if (!sw.controller) return
  try {
    const urls = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.startsWith(`${location.origin}/`))
      .map((n) => n.slice(location.origin.length))
      // 只预缓存真正的静态资产；接口响应由 SW 自己的 Network-First 逻辑负责
      .filter((p) => p.startsWith('/assets/') || p === '/theme-init.js')
    if (urls.length === 0) return
    sw.controller.postMessage({ type: 'PRECACHE_URLS', urls: Array.from(new Set(urls)) })
  } catch {
    /* performance API 不可用就算了，不影响主流程 */
  }
}

/**
 * 开发环境：把可能残留的 Service Worker 彻底拆掉。
 *
 * ⚠️ 这是本地调试能否正常出画面的关键一步。
 *   Vite dev 是按需流式返回几百个未打包 ES 模块的，一旦被 SW 以"缓存优先"接管，
 *   React 就挂载不上，页面只剩一团深色底 —— 表现为"只有一团黑"。
 *   注意：能不能真正清干净，也依赖 /sw.js 自己在开发域下自毁（见 web/public/sw.js），
 *   因为浏览器会自主更新并激活已注册的 SW，与页面是否调用 register() 无关。
 */
function teardownServiceWorkerInDev(): void {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => undefined)

  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => undefined)
  }

  // 仍被旧 SW 控制的页面：注销后重载一次，脱离它的拦截
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      location.reload()
    })
  }
}

/* ---------------- 新版本提示 ----------------

   为什么需要：sw.js 在 install 里直接 skipWaiting()、activate 里 clients.claim()，
   所以新版本会**立刻接管**页面。用户完全没有感知，而这时如果页面再懒加载一个
   已经下线的 chunk（每次发版都会换 hash 文件名），就会抛 ChunkLoadError → 白屏。
   有了这个订阅，App 可以提示"已更新，刷新后生效"，并在懒加载失败时自动重载一次。 */
type UpdateListener = () => void
const updateListeners = new Set<UpdateListener>()

/** 订阅"Service Worker 已换新版本"。返回取消订阅函数。 */
export function onServiceWorkerUpdate(cb: UpdateListener): () => void {
  updateListeners.add(cb)
  return () => updateListeners.delete(cb)
}

function notifyUpdate(): void {
  for (const cb of updateListeners) {
    try {
      cb()
    } catch {
      /* 单个订阅者出错不影响其它人 */
    }
  }
}

/** 注册 Service Worker 实现 PWA 与离线支持（仅生产环境生效） */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  if (import.meta.env.DEV) {
    teardownServiceWorkerInDev()
    return
  }

  /* 首次访问时 SW 是从"没有"到"有"，controllerchange 也会触发 —— 那不是"更新"，
     不该弹提示。用一个快照区分这两种情况。 */
  const hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) notifyUpdate()
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        /* 页面长时间开着时（学生一挂一整天），浏览器不会主动检查更新；
           回到前台时补一次检查，让"发版即生效"这件事真的成立。 */
        const check = () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined)
        }
        document.addEventListener('visibilitychange', check)
        return navigator.serviceWorker.ready
      })
      .then(() => precacheLoadedAssets())
      .catch(() => {
        // 非安全上下文（http 且非 localhost）或浏览器禁用，静默降级为纯在线应用
      })
  })
}

/** 实时网络在线/离线状态监听 Hook */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true
  })

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}

/**
 * 本设备此刻**是否真的具备离线能力**（即是否已有 Service Worker 在接管请求）。
 *
 * 为什么要单独判断：Service Worker 只在安全上下文（HTTPS 或 localhost）可用。
 * 站点若跑在明文 HTTP 上，`navigator.serviceWorker` 压根不存在，离线缓存无从谈起。
 * 此时若还对断网用户显示"已加载离线缓存"，就是在说谎 —— 他看到的其实是加载失败。
 * 文案必须跟着真实能力走。
 */
export function useOfflineCapable(): boolean {
  const [capable, setCapable] = useState(false)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const sync = () => setCapable(!!navigator.serviceWorker.controller)
    sync()
    // 首次访问时 SW 会在页面加载后才 claim，需要监听这个交接时刻
    navigator.serviceWorker.addEventListener('controllerchange', sync)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', sync)
  }, [])

  return capable
}
