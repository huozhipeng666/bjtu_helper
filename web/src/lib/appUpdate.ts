/* ============================================================
   网页侧的「发现新版本」提示 —— 给 1.7 之前的 App 壳兜底
   ============================================================

   ## 为什么需要它（问题本身）

   壳从 v1.7 起才在启动时自己拉 `/download/manifest.json` 比对 versionCode，
   并在「我的 → 关于」提供「检查更新」。**1.3 ~ 1.6 的壳没有这段代码**，
   它们既不会主动检查，也没有 checkUpdate 桥 —— 用户装了 1.5 之后，
   除非自己想起来去官网下载，否则永远收不到新版本提示（这就是"老版本收不到推送"）。

   壳改不了已装出去的 APK，但**网页是服务器下发的**：只要在网页里做一次版本比对，
   所有还活着的老壳立刻就有了更新通道 —— 不需要发新版 APK，也不需要用户先升级。

   ## 怎么判断"装的是哪个版本"

   按可靠性从高到低三条线索（见 `shellVersion()`）：
     1. `BjtuApp.versionCode()` —— v1.7+ 的原生桥，精确；
     2. `window.BjtuNet` 是否存在 —— 这个桥 v1.6 才有，而 v1.6 的 UA 标记
        写死成了 `BjtuHelperApp/1.5`（APP_UA_TAG 没跟着改），所以 UA 在 1.6 上会撒谎；
     3. UA 里的 `BjtuHelperApp/x.y` —— v1.3 起所有壳都会追加，是最后的线索。

   ## 怎么把安装包交出去（三级降级）

   老壳的 WebView 没有下载管理器，`<a download>` 会被静默吞掉。所以：
     1. v1.7+：`BjtuApp.openUrl()` 交给系统浏览器（有进度条、下完直接点安装）；
     2. v1.3~1.6：`BjtuDownload.saveBase64()` 把安装包写进「下载」目录（APK 只有几十 KB，
        base64 过桥完全够用），用户去文件管理器点开安装；
     3. 都没有：明确告诉用户用手机浏览器打开下载地址，不做"点了没反应"的假按钮。
   ============================================================ */

import { hasNativeDownloadBridge, isInAppShell } from './saveFile'
import { appBridge, openInSystemBrowser } from './systemBrowser'

export interface ApkManifest {
  versionName: string
  versionCode: number
  fileName: string
  url: string
  sizeBytes?: number
  sha256?: string
  releasedAt?: string
  packageName?: string
  osRequirement?: string
  changelog?: string[]
}

export type ShellVersionSource = 'native' | 'net' | 'ua' | 'none'

export interface ShellVersion {
  inShell: boolean
  /** 壳版本号（如 "1.6"）；识别不出来时为空串 */
  versionName: string
  /** 壳的 versionCode；只有 v1.7+ 的桥能给，其它情况为 0 */
  versionCode: number
  source: ShellVersionSource
}

/** 把 "1.10" 拆成 [1,10] 比较（不能用字符串比较：'1.10' < '1.9'） */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => (v.match(/\d+/g) ?? []).map(Number)
  const x = norm(a)
  const y = norm(b)
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** 壳里是否有原生 HTTP 桥（v1.6 起）。用于纠正 v1.6 报错的 UA 版本号 */
function hasNetBridge(): boolean {
  if (typeof window === 'undefined') return false
  return typeof (window as unknown as Record<string, unknown>).BjtuNet !== 'undefined'
}

/**
 * 识别当前壳的版本。非壳环境（普通浏览器 / 微信内置浏览器）返回 `inShell: false`。
 *
 * ⚠️ 三条线索的取舍理由见文件头注释。注意 UA 里的版本号在 v1.6 上是**错的**（写成 1.5），
 *    所以"有 BjtuNet 但 UA 说 1.5"时必须按 ≥1.6 处理，否则 1.6 用户会被提示升级到 1.6。
 */
export function shellVersion(): ShellVersion {
  if (!isInAppShell()) return { inShell: false, versionName: '', versionCode: 0, source: 'none' }

  const bridge = appBridge()
  let versionCode = 0
  let bridgeName = ''
  try {
    if (typeof bridge?.versionCode === 'function') versionCode = Number(bridge.versionCode()) || 0
    if (typeof bridge?.versionName === 'function') bridgeName = String(bridge.versionName() ?? '').trim()
  } catch {
    /* 桥方法抛异常（老壳的 JS 接口偶有 StrictMode 报错）：退回 UA 线索 */
  }

  const uaMatch = /BjtuHelperApp\/([0-9][0-9.]*)/.exec(navigator.userAgent)
  const uaName = uaMatch ? uaMatch[1].replace(/\.$/, '') : ''

  if (versionCode > 0) {
    return { inShell: true, versionCode, versionName: bridgeName || uaName, source: 'native' }
  }
  if (hasNetBridge()) {
    const guess = uaName && compareVersions(uaName, '1.6') >= 0 ? uaName : '1.6'
    return { inShell: true, versionCode: 0, versionName: guess, source: 'net' }
  }
  if (uaName) return { inShell: true, versionCode: 0, versionName: uaName, source: 'ua' }
  /* 在壳里但三条线索全无（极老的壳）：按最老处理，宁可多提示一次也不要静默 */
  return { inShell: true, versionCode: 0, versionName: '1.0', source: 'none' }
}

/** 拉版本清单（与服务端 `/download/manifest.json`、官网下载页同一份） */
export async function fetchApkManifest(signal?: AbortSignal): Promise<ApkManifest | null> {
  /* 两个地址都试：生产环境由服务端路由 `/download/manifest.json` 直接吐出，
     而静态构建产物里这份文件同时存在于 `/downloads/manifest.json`（Vite 的 public 目录）。
     开发环境（vite dev）没有服务端路由，只有后者 —— 有它才能本地验证提示条。 */
  for (const path of ['/download/manifest.json', '/downloads/manifest.json']) {
    try {
      const res = await fetch(path, { cache: 'no-cache', signal })
      if (!res.ok) continue
      const raw = (await res.json()) as Partial<ApkManifest>
      if (!raw || typeof raw.versionName !== 'string' || !Number.isFinite(Number(raw.versionCode))) continue
      return {
        ...(raw as ApkManifest),
        versionCode: Number(raw.versionCode),
        versionName: raw.versionName.trim()
      }
    } catch {
      /* 换下一个地址；两个都失败才返回 null */
    }
  }
  return null
}

/** 清单里的版本是否比当前壳新。有 versionCode 时以它为准（版本名可能被手工改错） */
export function isNewerThanShell(manifest: ApkManifest, shell: ShellVersion): boolean {
  if (!shell.inShell) return false
  if (shell.versionCode > 0) return manifest.versionCode > shell.versionCode
  if (!shell.versionName) return true
  return compareVersions(manifest.versionName, shell.versionName) > 0
}

export type ApkDelivery = 'browser' | 'saved' | 'manual'

export interface ApkDownloadResult {
  delivery: ApkDelivery
  /** 直接展示给用户的说明 */
  message: string
  /** 拿不到安装包时的兜底地址（浏览器里可直接打开） */
  fallbackUrl: string
}

function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString()
  } catch {
    return path
  }
}

/** 原始字节 → base64（分块，避免 String.fromCharCode 的参数上限） */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * 把安装包交给用户。
 *
 * 三级降级见文件头注释；任一步失败都会继续往下试，最终返回 `manual`
 * （提示用户用浏览器打开下载地址），而不是让按钮"点了没反应"。
 */
export async function deliverApk(manifest: ApkManifest): Promise<ApkDownloadResult> {
  const url = absoluteUrl(manifest.url || '/download/latest')
  const fileName = manifest.fileName || `bjtu-helper-v${manifest.versionName}.apk`

  /* ① v1.7+：交给系统浏览器（有下载进度与通知栏，下完点一下就能安装） */
  if (openInSystemBrowser(url)) {
    return {
      delivery: 'browser',
      message: '已用系统浏览器打开下载，下载完成后在通知栏点一下安装包即可覆盖升级。',
      fallbackUrl: url
    }
  }

  /* ② v1.3~1.6：走原生保存桥，把 APK 写进「下载」目录 */
  if (hasNativeDownloadBridge()) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0) throw new Error('安装包为空')
      const b64 = bytesToBase64(bytes)
      const bridge = window.BjtuDownload
      /* 参数顺序在早期壳里可能是 (name, base64, mime)：先按当前顺序调，
         返回了明确的错误说明再换一种顺序重试一次。成功时返回空串。 */
      let raw = bridge?.saveBase64(fileName, 'application/vnd.android.package-archive', b64)
      if (typeof raw === 'string' && raw.length > 0) {
        const retry = bridge?.saveBase64(fileName, b64, 'application/vnd.android.package-archive')
        if (typeof retry === 'string' && retry.length === 0) raw = ''
      }
      if (typeof raw === 'string' && raw.length > 0) throw new Error(raw)
      return {
        delivery: 'saved',
        message: `安装包已保存到「下载」目录（${fileName}）。打开文件管理器点它即可覆盖安装，登录状态与本地设置都会保留。`,
        fallbackUrl: url
      }
    } catch (err) {
      return {
        delivery: 'manual',
        message: `下载失败（${err instanceof Error ? err.message : String(err)}）。请用手机浏览器打开下面的地址下载安装包。`,
        fallbackUrl: url
      }
    }
  }

  /* ③ 没有任何桥：如实说明，给可复制的地址 */
  return {
    delivery: 'manual',
    message: '当前 App 版本过旧，无法在应用内下载安装包。请用手机浏览器打开下面的地址下载安装。',
    fallbackUrl: url
  }
}

/** 「稍后」记在本地：同一个版本不再打扰（下一个版本来了仍会提示） */
const SKIP_KEY = 'bjtu_app_update_skipped'
const CHECK_KEY = 'bjtu_app_update_checked_at'
/** 自动检查的节流间隔，与壳里原生检查的 6 小时保持一致 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function readSkippedVersion(): string {
  try {
    return localStorage.getItem(SKIP_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeSkippedVersion(versionName: string): void {
  try {
    localStorage.setItem(SKIP_KEY, versionName)
  } catch {
    /* 隐私模式禁 localStorage：不记住也能用，只是下次启动会再提示一次 */
  }
}

export function shouldAutoCheck(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(CHECK_KEY) ?? 0)
    return !Number.isFinite(last) || now - last > CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

export function markChecked(now = Date.now()): void {
  try {
    localStorage.setItem(CHECK_KEY, String(now))
  } catch {
    /* 同上 */
  }
}

/** 供「我的 → 关于」手动检查用的事件名：ProfileView 派发，更新门组件监听 */
export const CHECK_UPDATE_EVENT = 'bjtu:check-update'

export function requestManualUpdateCheck(): void {
  window.dispatchEvent(new Event(CHECK_UPDATE_EVENT))
}
