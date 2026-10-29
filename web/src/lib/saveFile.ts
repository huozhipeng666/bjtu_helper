/* ============================================================
   文件保存：原生壳桥 + 浏览器回退
   ============================================================

   ## 为什么需要这个模块

   网页端保存文件的标准写法是 `<a download href="blob:...">` + `click()`。
   它在桌面浏览器和大部分手机浏览器里都工作正常 —— **但在 Android WebView 里不生效**。

   WebView 没有下载管理器：`<a download>` 的点击事件被 WebView 自己吞掉，
   `setDownloadListener` 又没有实现（本工程 2026-10-18 之前就是这样），
   结果是**点了完全没反应**，连报错都没有。这正是「课件下载 / 成绩单下载在 App 里
   点了没反应、网页上却正常」的根因。

   ## 解决方式

   壳侧新增 `window.BjtuDownload.saveBase64(name, mime, base64)` 桥：
   网页把文件字节转成 base64 交给原生，由原生写进 MediaStore 的 Downloads 目录，
   并弹出系统「已下载」提示。这样文件真正落到手机的下载目录，用户能在
   文件管理器 / 下载 App 里找到。

   无桥（普通浏览器）时回退到原来的 `<a download>` 方案。

   ## 为什么用 base64 而不是 blob URL

   blob URL 只存在于 WebView 的 JS 上下文里，原生侧**读不到**它
   （除非再走一遍 shouldInterceptRequest，复杂度高且容易和 CORS 打架）。
   base64 是一段自包含的字符串，跨过桥之后原生可以直接解码成字节，
   没有第二套权限模型。

   代价是体积膨胀约 33%，且要占用 JS 堆内存。所以本模块设了 24MB 上限：
   超过就不走桥，改为提示用户用系统浏览器打开（成绩单 PDF 一般 200KB~2MB，
   课件最大也就几十 MB，实际几乎不会触发）。
   ============================================================ */

/** 走原生桥的体积上限（原始字节）。base64 后约 ×1.37，24MB → 约 33MB 字符串 */
const MAX_BRIDGE_BYTES = 24 * 1024 * 1024

interface BjtuDownloadBridge {
  isAvailable?: boolean
  /** 返回 '' 或 'ok' 表示成功；其它非空字符串为错误信息 */
  saveBase64: (name: string, mime: string, base64: string) => string | void
}

declare global {
  interface Window {
    BjtuDownload?: BjtuDownloadBridge
  }
}

/** 当前环境是否提供了原生下载桥（Android WebView 壳） */
export function hasNativeDownloadBridge(): boolean {
  if (typeof window === 'undefined') return false
  const b = window.BjtuDownload
  return !!b && typeof b.saveBase64 === 'function'
}

/**
 * 是否运行在**本站的** Android 壳里（而不是普通浏览器 / 微信内置浏览器）。
 *
 * 判据是 UA 里的 `BjtuHelperApp` 标记 —— 这个前缀只有本工程的壳会追加
 * （见 android-shell 的 `APP_UA_FALLBACK_VERSION`，实际值运行时取自 APK 的 versionName）。刻意**不用** `; wv)` 判定：
 * 微信、QQ 的内置浏览器同样带 `; wv)`，用它会把这些访客误判成 App 用户。
 */
export function isInAppShell(): boolean {
  if (typeof navigator === 'undefined') return false
  return /BjtuHelperApp/.test(navigator.userAgent)
}

/**
 * 「在壳里、但壳太老没有下载桥」——这是 2026-10 之前所有已安装版本的状态。
 *
 * 老壳里 `<a download>` 会被 WebView 静默吞掉，用户只看到「点了没反应」。
 * 与其让它无声失败，不如明确告诉用户去升级 App（新版本才有下载能力）。
 */
function isStaleAppShell(): boolean {
  return isInAppShell() && !hasNativeDownloadBridge()
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

export interface SaveResult {
  /** 是否成功交给下游保存 */
  ok: boolean
  /** 走的是哪条路径，便于调用方给不同的提示文案 */
  via: 'native' | 'browser'
  message: string
}

/**
 * 保存一个 Blob 到用户设备。
 *
 * 原生壳里走 MediaStore（文件真正落到「下载」目录），否则走 `<a download>`。
 * 两条路径都可能失败，所以返回结构化结果而不是抛异常 —— 调用方通常只需要
 * 把 message 丢给 toast。
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<SaveResult> {
  const name = sanitizeFileName(fileName)

  if (hasNativeDownloadBridge()) {
    if (blob.size > MAX_BRIDGE_BYTES) {
      return {
        ok: false,
        via: 'native',
        message: `文件较大（${(blob.size / 1048576).toFixed(1)}MB），请在浏览器中打开本站下载`
      }
    }
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const raw = window.BjtuDownload!.saveBase64(name, blob.type || 'application/octet-stream', bytesToBase64(bytes))
      if (typeof raw === 'string' && raw.length > 0 && raw !== 'ok') {
        return { ok: false, via: 'native', message: raw }
      }
      return { ok: true, via: 'native', message: `已保存到下载目录：${name}` }
    } catch (e) {
      return { ok: false, via: 'native', message: e instanceof Error ? e.message : '保存失败' }
    }
  }

  /* 老壳（没有下载桥）：明确告诉用户去升级，别让他对着「点了没反应」发呆。
     这是本轮唯一会让老用户看到新提示的分支 —— 新壳和浏览器都走不到这里。 */
  if (isStaleAppShell()) {
    return {
      ok: false,
      via: 'browser',
      message: '当前 App 版本不支持下载，请到「关于」页更新到最新版本后再试'
    }
  }

  return browserDownload(blob, name)
}

/** 浏览器回退：`<a download>` + blob URL */
function browserDownload(blob: Blob, name: string): SaveResult {
  let url = ''
  try {
    url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    /* 必须挂到文档里：Firefox 要求元素在文档树中才响应 click() */
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return { ok: true, via: 'browser', message: `已开始下载：${name}` }
  } catch (e) {
    return { ok: false, via: 'browser', message: e instanceof Error ? e.message : '下载失败' }
  } finally {
    /* ⚠️ 不能像旧代码那样在 click() 之后**立刻** revoke：
       blob URL 的下载是异步读取的，立即释放会让下载拿到空文件（Chrome 上表现为
       0 字节或直接失败）。这里给 10s 宽限，超时后释放，避免长会话内存泄漏。 */
    if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

/**
 * 生成一个 objectURL 用于**预览**（PDF 内嵌、图片预览等），调用方负责 revoke。
 * 与 saveBlob 分开是因为预览场景不能让本模块定时释放。
 */
export function objectUrlFor(blob: Blob): string {
  return URL.createObjectURL(blob)
}

/** 清掉文件名里的路径分隔符与非法字符，并限制长度。
 *  正则里的控制字符区间是刻意的 —— 它要剔除的就是它们。 */
export function sanitizeFileName(name: string): string {
  const cleaned = (name || 'file')
    // eslint-disable-next-line no-control-regex -- 控制字符区间正是本函数要剔除的对象
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'file').slice(0, 120)
}
