/**
 * 四个独立平台（CITEL / 物理在线 / 物理实验 / 演示实验）共用的 HTTP 与会话层。
 *
 * ## 为什么不复用 mis.ts 的 jarFetch
 *
 * `jarFetch` 的重定向白名单写死了 MIS/CAS/AA 三个 host（`isAllowedRedirectHost`），
 * 这四个平台的域名（citel / phyvlab / wlsy / physpace.bjtu.edu.cn）会被直接拒掉。
 * 所以这里自带一份**同款实现**（手动跟随重定向 + 按 host 分桶的 cookie jar），
 * 只是白名单由调用方按平台传入。
 *
 * ## 编码
 *
 * wlsy（物理实验）是上世纪留下来的 ASP.NET 站，实测返回 GB2312/GBK；
 * 其余三个平台是 UTF-8。响应解码按平台声明，**不猜**：调用方传 `encoding`，
 * 缺省 utf-8。猜编码是把「页面乱码」这个故障藏起来的标准做法。
 *
 * ## 会话
 *
 * 四个平台都是「登录一次、cookie 管一阵」的模型。这里给每个 (用户, 平台) 维护
 * 一个带 TTL 的会话池，凭据变更（用户名/密码改动）会使旧会话立即作废 —— 否则
 * 用户改了密码后还会继续用旧 cookie，报的错完全对不上现状。
 *
 * ## 三条传输路径（2026-10-22 加）
 *
 * 1. **直连**（默认）：`fetch`，够用；
 * 2. **legacyTls**：物理在线的 Apache 会请求「不安全的历史版本 TLS 重协商」，
 *    OpenSSL 3 默认拒绝，握手直接挂到超时（表现为一句光秃秃的 `fetch failed`）。
 *    这条路径用 `node:https` + `SSL_OP_LEGACY_SERVER_CONNECT` 走；
 * 3. **preferRelay**：这三个物理站点只对校园网开放（见 campusRelay.ts），
 *    公网服务器直连是被防火墙丢包的。中继在线时优先走中继，不在线时退回直连
 *    并在错误文案里说明原因。
 */
import * as cheerio from 'cheerio'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { CookieJar } from './mis.js'
import { currentTransportUser, isAnyRelayOnline, isRelayConfigured, probeCampusReachable, relayDiagnosis, relayFetch, RelayOfflineError, waitForAnyRelay } from './campusRelay.js'

/** cheerio 元素集合的宽松别名（服务端 tsconfig 无 DOM lib，Cheerio<never> 无法调用 find/each） */
export type AnyCheerio = cheerio.Cheerio<any>

export const PLATFORM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'

/** 单次请求超时。学校内网服务波动大，20s 与 mis.ts 对齐 */
const REQ_TIMEOUT_MS = 20_000

/** 响应体上限：4MB。这些页面最大的也就是课程表/占用表，2MB 足够，留一倍余量 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 已登录会话的不活跃有效期（滑动）：与 MIS 的 2 小时对齐 */
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000

/** 全局会话上限，防止内存被会话池撑爆 */
const MAX_SESSIONS = 500

/** 平台错误。message 是给用户看的中文；code 供路由层决定 HTTP 状态码 */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no-account'
      | 'login-failed'
      | 'session-expired'
      | 'parse'
      | 'network'
      | 'unavailable'
      | 'rate-limited'
  ) {
    super(message)
  }
}

export interface FetchResult {
  /** 最终 URL（跟随重定向后的） */
  url: string
  status: number
  headers: Headers
  body: string
}

function hostOf(url: string): string {
  return new URL(url).host
}

/* ---------------- 错误分类与文案 ---------------- */

/** 连接阶段/瞬时错误码：值得重试一次 */
const RETRYABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  /* undici 的超时/断流错误码（Node 22 的 fetch 抛 TypeError: fetch failed，
     真正的信息在 cause.code 里 —— 之前的实现漏了这几个，导致「首连超时」一次就失败） */
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED'
])

function causeCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const cause = (err as Error & { cause?: { code?: string } }).cause
  return cause?.code ?? (err as { code?: string }).code
}

function isRetryable(err: unknown): boolean {
  const code = causeCode(err)
  if (code && RETRYABLE_CODES.has(code)) return true
  if (err instanceof Error) {
    return (
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      err.name === 'HeadersTimeoutError' ||
      err.name === 'BodyTimeoutError'
    )
  }
  return false
}

/** 网络异常 → 用户能看懂的话。学校的站在校园网外时快时慢，"连不上"是常见处境 */
export function describeNetworkError(err: unknown, url: string): string {
  const host = hostOf(url)
  const code = causeCode(err)
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return `连接 ${host} 超时，学校服务可能暂时无响应`
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return `${host} 响应超时`
  }
  if (code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED') return `与 ${host} 的连接被中断`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析域名 ${host}`
  if (code === 'ECONNREFUSED') return `${host} 拒绝了连接`
  if (code === 'ECONNRESET') return `与 ${host} 的连接被重置`
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `${host} 的 HTTPS 证书异常`
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'BodyTimeoutError') {
      return `连接 ${host} 超时，学校服务可能暂时无响应`
    }
    if (err.message === 'fetch failed') return `无法连接 ${host}`
  }
  return `访问 ${host} 失败：${err instanceof Error ? err.message : String(err)}`
}

/* ---------------- 传输层 ---------------- */

interface RawResponse {
  status: number
  headers: Headers
  body: Buffer
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 按 content-encoding 解压（node:https 不会自动解，fetch 会） */
function maybeDecompress(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch {
    /* 解不开就原样返回，让上层解析器报错，比吞掉更可查 */
  }
  return buf
}

/**
 * `node:https` 直连（用于需要历史版本 TLS 重协商的老站点，如物理在线的 Apache）。
 *
 * 为什么不用 fetch：`fetch` 走的是 Node 内置 undici，没暴露 `secureOptions`，
 * 对「服务端请求不安全重协商」的站点会握手卡死到超时。
 */
function requestRaw(url: string, init: RequestInit, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isTls = u.protocol === 'https:'
    const lib = isTls ? https : http
    /* 不用 Object.fromEntries(headers.entries())：DOM 与 undici 的 Headers 类型对
       entries() 的支持不一致，forEach 两边都有 */
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        servername: isTls ? u.hostname : undefined,
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            req.destroy(Object.assign(new Error('响应体过大'), { code: 'BODY_TOO_LARGE' }))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          clearTimeout(wallClock)
          const out = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) for (const item of v) out.append(k, item)
            else if (v !== undefined) out.append(k, String(v))
          }
          resolve({ status: res.statusCode ?? 0, headers: out, body: maybeDecompress(Buffer.concat(chunks), out.get('content-encoding')) })
        })
        res.on('error', (err) => {
          clearTimeout(wallClock)
          reject(err)
        })
      }
    )
    /* 评审 B4（2026-10-23）：上面 lib.request 的 `timeout` 只是 socket **空闲**超时，
       挡不住「慢滴流」—— 对方每 19s 滴一个字节，每次都不触发空闲判定，
       整体却能拖到任意久。fetch 路径有 AbortSignal.timeout（墙钟），这里补齐对称性：
       从发起到响应读完的整体墙钟上限。 */
    const wallClock = setTimeout(() => {
      req.destroy(Object.assign(new Error('响应超时'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    wallClock.unref?.()
    req.on('timeout', () => req.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })))
    req.on('error', (err) => {
      clearTimeout(wallClock)
      reject(err)
    })
    if (typeof init.body === 'string') req.write(init.body)
    req.end()
  })
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** 中继回传的 headers（含重复的 set-cookie 数组）→ Headers */
function relayHeadersToHeaders(raw: Record<string, string | string[]>): Headers {
  const out = new Headers()
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) for (const item of v) out.append(k, item)
    else if (v !== undefined) out.append(k, String(v))
  }
  return out
}

async function sendOnce(
  url: string,
  init: RequestInit,
  opts: PlatformFetchOptions
): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? REQ_TIMEOUT_MS
  const headers = new Headers(init.headers)
  headers.set('User-Agent', PLATFORM_UA)

  /* 1) 校园网出口优先（这三个物理站点公网直连必然被丢包）。
     出口可能是用户手机上的原生桥，也可能是校园网里的中继机器 —— 由 campusRelay 决定。
     ⚠️ 条件是「有出口在线 **或** 配了中继」，不能只写前者：一次快照要好几跳，
     中途手机切走/锁屏就会让 `isAnyRelayOnline` 变 false，此时若退回直连，
     服务器（阿里云）到学校站点的连接会被防火墙静默丢弃 —— 用户又要干等 20s×2
     才看到一句「网络请求超时」。交给 relayFetch 它会立刻抛可读的 503。 */
  const userId = currentTransportUser()
  if (opts.preferRelay && (isAnyRelayOnline(userId) || isRelayConfigured())) {
    const res = await relayFetch({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: headersToObject(headers),
      body: typeof init.body === 'string' ? init.body : null,
      timeoutMs: timeoutMs + 25_000,
      userId
    })
    if (res.error) throw Object.assign(new Error(res.error), { code: 'RELAY_ERROR' })
    return {
      status: res.status,
      headers: relayHeadersToHeaders(res.headers),
      body: maybeDecompress(Buffer.from(res.bodyB64, 'base64'), relayHeadersToHeaders(res.headers).get('content-encoding'))
    }
  }

  const run = async (): Promise<RawResponse> => {
    /* 2) 老 TLS 站点走 node:https（需要打开历史版本重协商） */
    if (opts.legacyTls && url.startsWith('https:')) {
      return requestRaw(url, { ...init, headers }, timeoutMs)
    }
    /* 3) 其余走 fetch（自动解压、HTTP/2 之类都不用操心） */
    const response = await fetch(url, {
      method: init.method,
      body: init.body,
      headers,
      redirect: 'manual',
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs)
    })
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer())
    }
  }

  try {
    return await run()
  } catch (err) {
    /* 学校站点的首连超时很常见（防火墙 SYN 代理、老设备握手慢），重试一次基本就好 */
    if (!isRetryable(err)) throw err
    await sleep(400)
    return run()
  }
}

/** 按 Content-Type/charset 或调用方声明解码响应体 */
function decodeBody(buf: Buffer, headers: Headers, encoding: string): string {
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new PlatformError('页面内容过大，已中止读取', 'unavailable')
  }
  /* 声明 utf-8 但响应头写了别的 charset 时以响应头为准 —— wlsy 有些页面
     meta 里写 gb2312 而响应头不写，两头都没有才用调用方的声明。 */
  const headerCt = headers.get('content-type') ?? ''
  const m = /charset=["']?([\w-]+)/i.exec(headerCt)
  const cs = (m?.[1] ?? encoding).toLowerCase().replace(/^utf8$/, 'utf-8')
  try {
    return new TextDecoder(cs === 'utf-8' ? 'utf-8' : cs === 'gb2312' ? 'gbk' : cs).decode(buf)
  } catch {
    /* TextDecoder 对未知编码标签抛错；退回 utf-8 由上层解析器报错 */
    return new TextDecoder('utf-8').decode(buf)
  }
}

export interface PlatformFetchOptions {
  /** 允许跟随重定向的 host 白名单；缺省 = 初始 URL 的 host */
  allowedHosts?: string[]
  encoding?: 'utf-8' | 'gbk'
  signal?: AbortSignal
  /** 单跳超时（毫秒），默认 20s */
  timeoutMs?: number
  /**
   * 站点只对校园网开放：中继在线时走中继，否则退回直连。
   * 用于 phyvlab / physicslab / phydemo（见 campusRelay.ts 顶部说明）。
   */
  preferRelay?: boolean
  /** 站点要求历史版本 TLS 重协商（物理在线）：直连时改用 node:https */
  legacyTls?: boolean
}

/**
 * 手动跟随重定向的 GET/POST。每一跳都带 cookie、吸收 set-cookie。
 * 与 mis.ts 的 jarFetch 同构，但白名单按平台配置。
 */
export async function platformFetch(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  opts: PlatformFetchOptions = {}
): Promise<FetchResult> {
  await assertRelayReachable(opts, url)
  const allowed = new Set(opts.allowedHosts ?? [hostOf(url)])
  let current = url
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  const baseHeaders = new Headers(init.headers)
  const maxHops = 8
  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = new Headers(baseHeaders)
    const cookie = jar.headerFor(current)
    if (cookie) headers.set('Cookie', cookie)
    let response: RawResponse
    try {
      response = await sendOnce(current, { method, body, headers }, opts)
    } catch (err) {
      throw relayFailure(err, current, opts) ?? new PlatformError(describeNetworkError(err, current) + relayHint(err, opts), 'network')
    }
    jar.absorb(current, { headers: response.headers })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new PlatformError('服务端返回了无法解析的跳转地址', 'unavailable')
      }
      if (!allowed.has(next.host)) {
        throw new PlatformError(`服务端返回了异常的跳转地址（${next.host}）`, 'unavailable')
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        baseHeaders.delete('Content-Type')
      }
      current = next.toString()
      continue
    }
    return {
      url: current,
      status: response.status,
      headers: response.headers,
      body: decodeBody(response.body, response.headers, opts.encoding ?? 'utf-8')
    }
  }
  throw new PlatformError('重定向次数过多，服务端流程异常', 'unavailable')
}

/**
 * 中继相关的补充说明：这三个站点只对校园网开放，直连失败时把话说明白，
 * 否则用户看到的永远是「访问 xxx 失败」，无从下手。
 *
 * 只处理**不是**出口层错误的情况（`RelayOfflineError` 由 `relayFailure` 整句替换，
 * 见下）；这里补的是"出口明明在线、但这一跳因为别的原因失败"时缺的那半句解释。
 */
function relayHint(err: unknown, opts: PlatformFetchOptions): string {
  if (!opts.preferRelay) return ''
  if (!isAnyRelayOnline(currentTransportUser())) return `（${relayDiagnosis(currentTransportUser())}）`
  return ''
}

/**
 * 出口层的失败 → 用户能看懂的那句话。
 *
 * `RelayOfflineError` 的原文是给开发看的（"手机出口连不上学校站点
 * （connect ETIMEDOUT）"），对用户没有任何可操作性。这里**整句替换**成
 * `relayDiagnosis` 的判断结果，而不是在后面追加 —— 追加会得到
 * "…失败：手机出口连不上学校站点（connect ETIMEDOUT）（手机当前网络访问不到…）"
 * 这种半截英文半截中文的长句，用户读不出重点。
 *
 * 状态码用 `unavailable`（503）而不是 `network`（502）：502 在本项目里表示
 * "页面改版 / 站点返回了看不懂的东西"，而这里压根没拿到任何响应，
 * 两者在日志和监控里必须分得开。
 */
function relayFailure(err: unknown, url: string, opts: PlatformFetchOptions): PlatformError | null {
  if (!opts.preferRelay || !(err instanceof RelayOfflineError)) return null
  return new PlatformError(
    `访问不到 ${hostOf(url)}：${relayDiagnosis(currentTransportUser())}`,
    'unavailable'
  )
}

/**
 * 出口可用性检查（**在每一跳真正发请求之前**跑）。
 *
 * 分三步，每一步都对应一类线上真实故障：
 *
 * 1. **没有出口在线** → 等几秒（手机出口是页面挂载后才开始轮询的，存在几百毫秒
 *    的窗口，见 `waitForAnyRelay`）；仍然没有就报「请连接校园网 WiFi」。
 * 2. **有出口在线，但出口连不上学校站点** → 探活一次（短超时 6s）。
 *    这是最关键的一步：手机「在线」不等于「能访问」（蜂窝网下照样在长轮询），
 *    不探的话每个任务都要挂到超时才失败，用户等一分钟后看到的是一句
 *    「网络请求超时」—— 那句话把责任推给了用户的网络，而真正该说的是
 *    「你当前不在校园网里」。
 * 3. 探活通过 → 放行，后续跳靠 `probeCache`（60s）不再重复探。
 *
 * 没配中继（自建 / 校园内网部署）时不做这些判断，照常直连。
 */
async function assertRelayReachable(opts: PlatformFetchOptions, url: string): Promise<void> {
  if (!opts.preferRelay) return
  const userId = currentTransportUser()

  if (!isAnyRelayOnline(userId)) {
    /* 一个出口都没配 = 服务端自己就在校园网内，走直连。
       ⚠️ 不能加 `&& userId === undefined`：调用方全是 requireRealUser，
       userId 一定有值，那会让自建部署被误挡（见 git 历史里的那次修复）。 */
    if (!isRelayConfigured()) return
    if (await waitForAnyRelay(userId)) {
      /* 等到了，继续往下探 */
    } else {
      /* 文案要像一句**提醒**而不是一句错误：用户此刻该做的动作就是去连校园网，
         所以把"请连接校园网 WiFi 后重试"放在最前面，诊断细节放括号里。
         等满 10 秒才走到这里（见 waitForAnyRelay），用户很可能已经切了一半网。 */
      throw new PlatformError(
        `该功能需要校园网环境，请连接校园网 WiFi 后重试（${relayDiagnosis(userId)}）`,
        'unavailable'
      )
    }
  }

  const probe = await probeCampusReachable(url, userId)
  if (!probe.ok) {
    throw new PlatformError(
      `当前网络访问不到学校内网站点（${probe.reason}）。请连接校园网 WiFi 后重试`,
      'unavailable'
    )
  }
}

/**
 * 单次请求，**不跟随重定向**。
 * 演示实验（phydemo）的登录成功判定就是「302 落到 /phydemo/ 前缀」，
 * 自动跟随会把 302 吞掉、只剩最终页，反而判断不了。
 */
export async function platformFetchOnce(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  opts: PlatformFetchOptions = {}
): Promise<FetchResult> {
  await assertRelayReachable(opts, url)
  const headers = new Headers(init.headers)
  const cookie = jar.headerFor(url)
  if (cookie) headers.set('Cookie', cookie)
  let response: RawResponse
  try {
    response = await sendOnce(url, { ...init, headers }, opts)
  } catch (err) {
    throw relayFailure(err, url, opts) ?? new PlatformError(describeNetworkError(err, url) + relayHint(err, opts), 'network')
  }
  jar.absorb(url, { headers: response.headers })
  return {
    url,
    status: response.status,
    headers: response.headers,
    body: decodeBody(response.body, response.headers, opts.encoding ?? 'utf-8')
  }
}

/** application/x-www-form-urlencoded 序列化 */
export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/**
 * 「这一页其实是登录页/失效页」判定（上游 `SchoolHttpTransportKt.looksLikeSessionExpired` 的等价移植）。
 *
 * 判据按优先级：
 *  1. 401/403 直接算失效；
 *  2. 最终 URL 落在登录路径（/auth/login、/login/、SSO）算失效；
 *  3. 正文含「会话失效/未登录/请重新登录…」等措辞算失效；
 *  4. HTML 里有 password 输入框/登录名输入框算失效。
 *
 * 为什么不能只看 URL：Moodle 登录失败时是 200 + 停在登录页本身，URL 不变。
 */
export function looksLikeSessionExpired(res: { status: number; url: string; body: string }): boolean {
  if (res.status === 401 || res.status === 403) return true
  const lowerUrl = res.url.toLowerCase()
  if (
    lowerUrl.includes('/auth/login') ||
    lowerUrl.includes('/login/') ||
    lowerUrl.includes('cas.bjtu.edu.cn/auth/') ||
    lowerUrl.includes('sso.bjtu.edu.cn/o/authorize') ||
    lowerUrl.includes('sso.bjtu.edu.cn/sso/')
  ) {
    return true
  }
  const body = res.body
  if (body.trim().length === 0) return false
  const hints = ['会话失效', '会话结束', '登录失效', '登录超时', '未登录', '请重新登录', 'session expired', 'session timeout', 'not logged in']
  for (const h of hints) {
    if (body.toLowerCase().includes(h.toLowerCase())) return true
  }
  const isHtml = /^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body) || body.toLowerCase().includes('<form')
  if (!isHtml) return false
  return (
    body.toLowerCase().includes('type="password"') ||
    body.toLowerCase().includes("type='password'") ||
    body.toLowerCase().includes('name="password"') ||
    body.toLowerCase().includes("name='password'") ||
    body.toLowerCase().includes('id="id_captcha') ||
    body.toLowerCase().includes('name="loginname"')
  )
}

/* ---------------- 会话池 ---------------- */

export interface PlatformSession {
  jar: CookieJar
  /** 最近一次使用时间（滑动 TTL 基准） */
  lastUsedAt: number
  /** 建立会话时所用的凭据指纹；凭据一变，会话作废重登 */
  credFingerprint: string
}

/**
 * (用户, 平台) → 会话的带 TTL 池。
 *
 * 泛型 T 留给各平台挂自己的登录态字段（如 phyvlab 的 `username`
 * 或 physicslab 的 `landingUrl`），公共的只有 jar / lastUsedAt / credFingerprint。
 */
export class PlatformSessionPool<T extends PlatformSession> {
  private map = new Map<string, { session: T; timer: NodeJS.Timeout }>()

  constructor(
    private readonly keyPrefix: string,
    private readonly idleTtlMs: number = SESSION_IDLE_TTL_MS
  ) {}

  private key(userId: number): string {
    return `${this.keyPrefix}:${userId}`
  }

  get(userId: number, credFingerprint: string): T | undefined {
    const key = this.key(userId)
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.session.credFingerprint !== credFingerprint) {
      this.drop(userId)
      return undefined
    }
    /* 「滑动」TTL 的关键：光更新 lastUsedAt 是不够的 —— 那个 timer 是在 put() 时
       一次性设下的，不重建的话会话仍然会在**创建后** 2 小时被清掉，
       连续用满 2 小时的重度用户会被强制重登一次。这里连同 timer 一起续期。 */
    clearTimeout(entry.timer)
    entry.session.lastUsedAt = Date.now()
    entry.timer = setTimeout(() => this.drop(userId), this.idleTtlMs).unref()
    return entry.session
  }

  put(userId: number, session: T): void {
    this.drop(userId)
    if (this.map.size >= MAX_SESSIONS) {
      /* 粗暴但有效：整体清理一次过期的，还满就清最旧的 */
      const now = Date.now()
      for (const [k, v] of this.map) {
        if (now - v.session.lastUsedAt > this.idleTtlMs) {
          /* 删 entry 时必须一起 clearTimeout：timer 虽然 unref 了不拖住进程，
             但漏掉它会让 2 小时后对一个已经不存在的 key 再跑一次 drop() */
          clearTimeout(v.timer)
          this.map.delete(k)
        }
      }
      if (this.map.size >= MAX_SESSIONS) {
        const oldest = [...this.map.entries()].sort((a, b) => a[1].session.lastUsedAt - b[1].session.lastUsedAt)[0]
        if (oldest) {
          clearTimeout(oldest[1].timer)
          this.map.delete(oldest[0])
        }
      }
    }
    session.lastUsedAt = Date.now()
    const timer = setTimeout(() => this.drop(userId), this.idleTtlMs).unref()
    this.map.set(this.key(userId), { session, timer })
  }

  drop(userId: number): void {
    const entry = this.map.get(this.key(userId))
    if (entry) {
      clearTimeout(entry.timer)
      this.map.delete(this.key(userId))
    }
  }

  /** 测试 / 关服时用 */
  clear(): void {
    for (const entry of this.map.values()) clearTimeout(entry.timer)
    this.map.clear()
  }
}
