/* ============================================================
   在 App 壳里把 URL 交给系统浏览器
   ============================================================

   ## 解决什么问题

   壳（Android WebView）里没有下载管理器：
   - `<a download href="blob:...">` 被 WebView 静默吞掉，点了没反应；
   - 走 `BjtuDownload.saveBase64` 原生桥虽然能把文件写进「下载」目录，
     但整个文件要先读成 base64 再过桥（体积 +33%、几十 MB 会卡住 JS 线程），
     而且**全程没有进度**，用户点完只能干等 —— 这就是「App 里下载没反馈」的来源。

   课件这类文件最合适的归宿是系统浏览器：它有下载管理器（进度条、通知栏、
   断点续传、下完可直接打开）。所以壳里改成：
     ① 用短命票据换一个免登录的下载地址（见 api.ts 的 createCoursewareDownloadTicket）；
     ② 把地址交给 `BjtuApp.openUrl()`，由系统浏览器下载。

   ## 与 saveFile.ts 的分工

   - saveFile.ts：小文件（.ics、txt、头像这类几 KB~几 MB）仍然走原生桥/`<a download>`；
   - 本模块：**大文件**（课件、整目录 zip）走浏览器，用户能看到真实进度。

   两个模块都靠 UA 里的 `BjtuHelperApp` 判定"是否在壳里"，不靠 `; wv)`
   （微信/QQ 内置浏览器也带 `; wv)`，会把普通访客误判成 App 用户）。
   ============================================================ */

interface BjtuAppBridge {
  /** 用系统浏览器打开 http(s) 地址；返回 true 表示已唤起 */
  openUrl?: (url: string) => boolean | void
  /** 壳版本号（如 "1.7"） */
  versionName?: () => string
  /** 壳的 versionCode */
  versionCode?: () => number
  /** 手动检查更新（有新版会弹原生对话框） */
  checkUpdate?: () => void
  /** 退出 App（网页侧「再按一次退出」用） */
  exit?: () => void
}

declare global {
  interface Window {
    BjtuApp?: BjtuAppBridge
  }
}

/** 是否运行在本站的 Android 壳里（UA 标记由 MainActivity 追加）。
 *  实现只有一份，在 saveFile.ts —— 两个模块各写一遍迟早会漂移。 */
export { isInAppShell } from './saveFile'

/** 壳是否提供了 openUrl（v1.7 起才有；更早的壳没有这个能力） */
export function canOpenSystemBrowser(): boolean {
  if (typeof window === 'undefined') return false
  const b = window.BjtuApp
  return !!b && typeof b.openUrl === 'function'
}

/** 取原生壳桥（可能不存在） */
export function appBridge(): BjtuAppBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.BjtuApp
}

/**
 * 用系统浏览器打开地址。
 *
 * @returns true = 已唤起浏览器；false = 没有桥 / 地址非法 / 唤起失败，
 *          调用方应回退到原来的保存方案（别让用户点了没反应）。
 */
export function openInSystemBrowser(url: string): boolean {
  if (!canOpenSystemBrowser()) return false
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const r = window.BjtuApp!.openUrl!(url)
    /* 老壳的桥方法可能返回 undefined（没有返回值），按成功处理 */
    return r !== false
  } catch {
    return false
  }
}

/** 相对路径 → 绝对地址（浏览器下载必须用绝对地址，否则 ACTION_VIEW 打不开） */
export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString()
  } catch {
    return path
  }
}
