/**
 * MIS 一键导入：对接北京交通大学 MIS / SSO / AA（本科教务）系统。
 *
 * 流程（对标「交大自由行」App，见 HFDLYS/BJTUselfService）：
 *  1. GET  mis/auth/nsso/?next=/        → 302 到统一身份认证（sso.bjtu.edu.cn/o/authorize/…）
 *  2. 从 SSO 登录页解析 flowId / client_id / redirect_uri / state / sm2 公钥
 *  3. POST sso/sso/login                → 学号 + SM2(密码) + 上面那批隐藏字段
 *                                         302 到 mis/auth/ncallback/?code=… → mis/home/
 *  4. GET  mis/module/module/10/        → 解析 form#redirect 的 action（AA 免登录跳转票据）
 *  5. GET  aa/course_selection/courseselecttask/schedule/ → 本学期课表 HTML
 *
 * ⚠️ 2026-10 学校换了统一身份认证（新域名 sso.bjtu.edu.cn，OAuth2 授权码模式）。相较旧版：
 *  - **没有图形验证码了**：登录页里 `#captchaParent` 是 `display:none`，正常走向不该出现验证码；
 *  - **密码必须 SM2 加密**（页面 sm2.min.js + `ssoConfig.sm2.publicKey`），明文会被判「账号或密码错误」；
 *  - 旧域名 cas.bjtu.edu.cn 对 MIS 这个 client_id 已经"服务未授权"，直连会得到
 *    `{"code":40000,"msg":"服务未授权"}`，不要再走 `/auth/sso/`；
 *  - 失败不再渲染 HTML 错误节点，而是页面里的 `var error = {"code":…,"msg":…}` JSON。
 *
 * 另：智慧教学平台（123.121.147.7:88）也复用本会话 —— 见 `misFetchAll` 与 ./bksy.ts。
 *
 * 安全约定：
 *  - 学号/密码只在请求瞬时使用，不落库、不打日志；
 *  - MIS 会话（cookie jar）只存内存，15 分钟 TTL，绑定本地 userId。
 *
 * 测试支持：三个域名的 origin 可用 MIS_MIS_ORIGIN / MIS_SSO_ORIGIN / MIS_AA_ORIGIN
 * 环境变量覆盖，供本地 mock 服务器做端到端测试。
 */
import * as cheerio from 'cheerio'
import { randomUUID } from 'node:crypto'
import { sm2Encrypt } from './ssoSm2.js'
import { fetchGrades, fetchReportCardBytes, type Grade } from './grades.js'
import {
  bksySso, bksySessionId, bksyFetchSemesters, bksyFetchCourses, bksyFetchHomeworks, bksyFetchTimetable,
  type BksyCourse, type BksyHomework, type BksySemester
} from './bksy.js'
import type { Period, SemesterWeek, WeekOption } from './types.js'
import { listSemesterWeekOptions } from './date.js'
import {
  parseHomeStatusJson, homeStatusFlags, type HomeStatus, type HomeStatusFlags
} from './homeStatus.js'
import {
  ClassroomOccupancyParseError, buildingNameOf, isKnownBuildingId,
  parseClassroomOccupancyTable, parseSemesterOptions,
  type OccupancyRoom, type SemesterOptions
} from './classroomOccupancy.js'

const MIS_ORIGIN = process.env.MIS_MIS_ORIGIN ?? 'https://mis.bjtu.edu.cn'
/**
 * 统一身份认证（SSO）的 origin。
 *
 * ⚠️ 2026-10 学校换了统一身份认证域名：cas.bjtu.edu.cn → sso.bjtu.edu.cn。
 * 旧域名对 MIS 这个 client_id 已经返回"服务未授权"，所以默认值必须跟着换。
 * 环境变量也改名（MIS_SSO_ORIGIN），旧名 MIS_CAS_ORIGIN 仍兼容，方便已有部署平滑过渡。
 */
const CAS_ORIGIN = process.env.MIS_SSO_ORIGIN ?? process.env.MIS_CAS_ORIGIN ?? 'https://sso.bjtu.edu.cn'
const AA_ORIGIN = process.env.MIS_AA_ORIGIN ?? 'https://aa.bjtu.edu.cn'

/** 给课件等额外业务路由复用 —— 之前是模块私有，bksySso 需要它来构造完整 URL。 */
export { MIS_ORIGIN, CAS_ORIGIN, AA_ORIGIN }

const MIS_HOST = new URL(MIS_ORIGIN).host
const CAS_HOST = new URL(CAS_ORIGIN).host
const AA_HOST = new URL(AA_ORIGIN).host

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'

/** 单次 HTTP 请求超时 */
const REQ_TIMEOUT_MS = 20_000
/**
 * 未完成登录的匿名会话有效期（滑动）。
 * 「本校学生登录」流程一般几分钟内走完，15 分钟足够宽裕。
 * 过期靠 TTL + 接口层限流一起压住，不能让它长期占内存。
 */
const ANON_SESSION_TTL_MS = 15 * 60 * 1000
/**
 * 已登录会话的「不活跃」有效期（滑动续期）—— 2026-10-14 会话池改造。
 *
 * 为什么要有它：以前每个教务类应用（课件 / 邮箱 / 成绩单 / 数据同步）打开时
 * 都要单独输一遍学号 + 密码 + 验证码，用户体验是「每个应用各登一次」。
 * 现在改为**一次登录、全部应用可用**：任一应用登录成功后会话留在池里，
 * 其他应用打开时先用 `GET /api/mis/session` 探测、有就直接复用；
 * 任何一次使用（getMisSession / findUserMisSession）都会刷新 lastUsedAt，
 * **不活跃超过 2 小时**才清理（学校侧会话若提前失效，使用时自然报错引导重登）。
 */
const AUTHED_IDLE_TTL_MS = 2 * 60 * 60 * 1000
/** 每用户并发 MIS 会话上限 */
const MAX_SESSIONS_PER_USER = 3
/**
 * 匿名会话的全局并发上限。
 * 匿名通道没有"每个用户"可依附（userId 恒为 0），只能按总量兜住内存占用。
 * 真正的创建频率由接口层的 per-IP 限流 + 匿名 TTL 一起压住。
 */
const MAX_ANON_SESSIONS = 200

/**
 * MisError 的类别（评审 A9，2026-10-23）：决定 fail()/misFail() 的 HTTP 状态码。
 * 此前统一映射 400 —— 学校门户宕机时用户收到「400 请求有问题」，排障方向全错。
 *   - input   用户输入 / 本地会话状态问题（密码错、会话过期、缺字段）→ 400
 *   - network 连不上学校门户（超时、拒连、DNS）→ 503，用户该「换个网络 / VPN / 稍后再试」
 *   - upstream 学校门户响应异常（页面改版、内容过大、跳转异常）→ 502，重试通常无解
 */
export type MisErrorKind = 'input' | 'network' | 'upstream'

export class MisError extends Error {
  readonly kind: MisErrorKind
  constructor(message: string, kind: MisErrorKind = 'input') {
    super(message)
    this.kind = kind
  }
}

/* ---------------- Cookie Jar（按 host 隔离） ---------------- */

/** 导出给 bksy.ts 复用：智慧教学平台与本模块共享同一份 MIS 登录态 */
export class CookieJar {
  private store = new Map<string, Map<string, string>>()

  /**
   * 从响应的 set-cookie 列表吸收 cookie。
   *
   * 参数只要求 `headers`，不绑死 Response —— 平台层的传输可能是 fetch、node:https
   * 或校园网中继，三者都能给出一个 Headers（且都实现了 getSetCookie）。
   */
  absorb(url: string, response: { headers: Headers }): void {
    const host = hostOf(url)
    const cookies = this.store.get(host) ?? new Map<string, string>()
    // Node 18.14+ / undici 提供 getSetCookie
    const setCookies = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const line of setCookies) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue
      // 过期/删除的 cookie 直接移除
      if (/expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) cookies.delete(name)
      else cookies.set(name, value)
    }
    if (cookies.size === 0) this.store.delete(host)
    else this.store.set(host, cookies)
  }

  /** 生成给该 url 请求应携带的 Cookie 头 */
  headerFor(url: string): string {
    const cookies = this.store.get(hostOf(url))
    if (!cookies || cookies.size === 0) return ''
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  clear(): void {
    this.store.clear()
  }
}

function hostOf(url: string): string {
  return new URL(url).host
}

/* ---------------- 会话存储 ---------------- */

interface MisSession {
  id: string
  userId: number
  createdAt: number
  /** 最后一次使用时间（不活跃过期的滑动基准；创建时 = createdAt） */
  lastUsedAt: number
  jar: CookieJar
  /** SSO 登录页 URL（POST 的 Referer 与隐藏字段来源） */
  casLoginUrl: string
  /** SSO 登录表单里的隐藏字段（flowId / client_id / redirect_uri / response_type / scope / state 等） */
  ssoFields: Record<string, string>
  /** SSO 页面里的 SM2 公钥（Base64），用来加密密码 */
  sm2PublicKey: string
  /** CAS 登录是否已通过 */
  misLoggedIn: boolean
  /** 姓名 / 身份 / 部门 */
  profile?: { name: string; identity: string; department: string }
  /** AA 免登录跳转是否已完成 */
  aaLoggedIn: boolean
  /** 智慧教学平台（123.121.147.7:88）免登录是否已完成 */
  bksyLoggedIn?: boolean
  /** 智慧教学平台接口会话标识（message.shtml 换来的 sessionid，需作为请求头） */
  bksySessionId?: string
}

const sessions = new Map<string, MisSession>()

/**
 * 会话销毁钩子（评审 B5，2026-10-23）：其他模块若按 MIS sid 缓存了衍生凭据
 * （mailbox 的 coremailSids 等），MIS 会话被 TTL/LRU 清理或显式销毁时必须联动清理，
 * 否则条目永久残留。用钩子而不是让 mis.ts 反向 import 业务模块 —— 那会形成循环依赖。
 */
type SessionDestroyedHook = (sid: string) => void
const sessionDestroyedHooks: SessionDestroyedHook[] = []
export function onMisSessionDestroyed(hook: SessionDestroyedHook): void {
  sessionDestroyedHooks.push(hook)
}
function emitSessionDestroyed(sid: string): void {
  for (const h of sessionDestroyedHooks) {
    try {
      h(sid)
    } catch {
      /* 钩子失败不能影响会话清理本身 */
    }
  }
}

function cleanupSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    /* 分档过期：未登录的匿名会话按短 TTL 快速周转（防止半途而废的登录
       把 MAX_ANON_SESSIONS 占满）；已登录会话按不活跃滑动 TTL。 */
    const ttl = s.misLoggedIn ? AUTHED_IDLE_TTL_MS : ANON_SESSION_TTL_MS
    if (now - s.lastUsedAt > ttl) {
      sessions.delete(id)
      emitSessionDestroyed(id)
    }
  }
}

export function countMisSessions(userId: number): number {
  cleanupSessions()
  let n = 0
  for (const s of sessions.values()) if (s.userId === userId) n++
  return n
}

/**
 * 取出会话（不做归属/登录态校验 —— 调用方拿到后自己判）。
 * 课件/教室等**额外业务路由**需要读取会话，而 sessions 本身是模块私有的，
 * 不想每个新路由都写一遍 .get()，所以这里导出 getter。
 * 2026-10-14 会话池：取出即视为"使用"，刷新 lastUsedAt（滑动续期）——
 * 用户在任一应用里的操作都会让共享会话的有效期整体延续。
 */
export function getMisSession(sid: string): MisSession | undefined {
  cleanupSessions()
  const s = sessions.get(sid)
  if (s) s.lastUsedAt = Date.now()
  return s
}

/**
 * 找该用户**最新的已登录**会话（会话池探测）。
 *
 * 教务类应用（课件 / 邮箱 / 成绩单 / 同步）打开时先调 `GET /api/mis/session`，
 * 服务端用本函数回答「有没有可复用的登录态」：
 *   - 有 → 前端跳过登录表单直接使用（"打开应用自动登录"）；
 *   - 无 → 显示登录表单，登录一次后其他应用也能复用。
 *
 * 只认 `misLoggedIn === true` 的会话：半途而废的匿名登录不能被复用。
 * 多个会话（多设备）取最新创建的那个。取出即续期（同 getMisSession）。
 */
export function findUserMisSession(userId: number): MisSession | undefined {
  cleanupSessions()
  let best: MisSession | undefined
  for (const s of sessions.values()) {
    if (s.userId !== userId || !s.misLoggedIn) continue
    if (!best || s.createdAt > best.createdAt) best = s
  }
  if (best) best.lastUsedAt = Date.now()
  return best
}

export function destroyMisSession(id: string, userId: number): boolean {
  const s = sessions.get(id)
  if (!s || s.userId !== userId) return false
  s.jar.clear()
  sessions.delete(id)
  emitSessionDestroyed(id)
  return true
}

export function destroyUserMisSessions(userId: number): void {
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      s.jar.clear()
      sessions.delete(id)
      emitSessionDestroyed(id)
    }
  }
}

/**
 * 把匿名会话的归属过继给刚建好的本地账号（`from` 通常是 0）。
 *
 * 为什么需要这个单独的动作：「本校学生登录」的会话必须以匿名身份（userId=0）开启 ——
 * 那一刻用户还没有本地账号。等 SSO 校验通过、账号建出来之后，会话必须改挂到真实
 * userId 上，否则紧接着的第 3 步 `/api/mis/courses`（它按真实 userId 校验归属）会
 * 直接判「会话不存在或已过期」，用户看到的现象就是「登录成功但课表导不进来」。
 *
 * 为什么不把这件事塞进 misLogin 的参数里：学号可能是**新用户**，userId 在登录成功
 * 之前根本不存在。硬塞进去只能传一个「此刻还不知道的值」，反而把这个先后顺序藏起来。
 *
 * 返回 false 表示会话不存在或归属不符（例如已被别处消费），调用方应报错让用户重来。
 */
export function rebindMisSession(id: string, from: number, to: number): boolean {
  cleanupSessions()
  const s = sessions.get(id)
  if (!s || s.userId !== from) return false
  if (to <= 0) return false
  s.userId = to
  return true
}

/* ---------------- HTTP 骨架 ---------------- */

export interface FetchResult {
  url: string
  response: Response
  body: string
  /** 响应原始字节（图片等二进制内容必须用它，text() 会按 UTF-8 解码损坏数据） */
  raw: Buffer
}

/**
 * 允许跟随重定向的主机白名单。
 *
 * ⚠️ 为什么必须白名单：`jarFetch` 会**带着用户的教务 cookie** 去请求重定向目标。
 *    学校门户若被攻陷、被 DNS 污染、或某个页面被注入了一段
 *    `Location: https://evil.example/steal`，服务端就会主动把 CAS ticket / JSESSIONID
 *    端到对手的服务器上 —— 而这些 cookie 等价于学生本人的教务身份。
 *    浏览器的同源策略在这里完全不生效，因为请求是**服务端发起**的（SSRF 的经典形态）。
 *    同时这也堵住了 `Location: http://169.254.169.254/...` 这类云元数据探测。
 *
 * 子域后缀放行（`*.bjtu.edu.cn`）是因为学校在 MIS/CAS/AA 之外还有一堆业务域
 * （jw、e、ehall 等），单列它们会随学校改版不断失效。放行整个 edu.cn 子域，
 * 仍然把任意第三方主机挡在外面，这是安全性上的核心收益。
 *
 * ⚠️ **运维显式配置的主机必须一并放行**（`_EXTRA_ALLOWED_HOSTS`）。
 *    2026-10-18 的回归就出在这里：智慧课程平台部署在 `123.121.147.7:88` ——
 *    一个裸 IP，既不是 `.edu.cn` 子域也不是 MIS/CAS/AA，于是 MIS 到 BKSY 的
 *    免登录跳转在**第一跳**就被拒了，表现为课件/成绩单/作业全线 400，
 *    而访问日志里只有一条 25ms 的 400（因为还没发到 bksy 就失败了）。
 *
 *    判据是「谁把它写进环境变量的」：`BKSY_ORIGIN` 这类由运维配置的值，
 *    其主机名与 MIS/CAS/AA 同属**受信配置**，不是用户可控输入，
 *    所以放行它不会削弱「门户被注入恶意 Location」的防护：
 *    用户可控的重定向目标依然必须落在 edu.cn 域内。
 */
const ALLOWED_REDIRECT_SUFFIXES = ['.bjtu.edu.cn', '.edu.cn']

/**
 * 由环境变量显式配置的受信主机（含端口）。
 *
 * 只读 `*_ORIGIN` 这类**部署方**提供的变量；不接受任何来自请求参数的值，
 * 否则白名单就形同虚设。
 */
const _EXTRA_ALLOWED_HOSTS = new Set(
  [
    /* ⚠️ 变量名必须与上面 MIS_ORIGIN / CAS_ORIGIN / AA_ORIGIN 的取值处逐字一致，
       写错不会报错，只会让白名单悄悄少放行一台主机。 */
    process.env.MIS_MIS_ORIGIN,
    process.env.MIS_SSO_ORIGIN,
    process.env.MIS_CAS_ORIGIN,
    process.env.MIS_AA_ORIGIN,
    process.env.BKSY_ORIGIN,
    /* 智慧课程平台的**默认**地址。必须写在这里而不是只依赖环境变量：
       线上从来没设过 BKSY_ORIGIN，实际用的就是这个默认值；
       只读环境变量会让默认部署直接挂掉（2026-10-18 的回归就是这么来的）。
       它与 bksy.ts / courseware.ts 里的默认值必须保持一致。 */
    'http://123.121.147.7:88'
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => {
      try {
        return new URL(v).host.toLowerCase()
      } catch {
        return ''
      }
    })
    .filter((h) => h.length > 0)
)

/** 明确的已知主机：即使运维把 *_ORIGIN 指到别的域（内网/测试环境），它们也始终放行 */
function isAllowedRedirectHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === MIS_HOST || h === CAS_HOST || h === AA_HOST) return true
  if (_EXTRA_ALLOWED_HOSTS.has(h)) return true
  return ALLOWED_REDIRECT_SUFFIXES.some((suf) => h.endsWith(suf))
}

/**
 * 单次响应体上限。
 *
 * 为什么要有：`arrayBuffer()` 会**无上限**地把对方返回的内容读进内存。
 * 学校门户正常页面几十 KB、成绩单 PDF 几 MB，但一个被篡改的 / 出bug 的端
 * 完全可能回一个几 GB 的流 —— 服务端会一直读到 OOM（而且是在共享的 ECS 上）。
 * 这里用流式读取，累计超过上限立即取消，把"外部依赖"变成一个有界的失败。
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** 读取响应体，超过 maxBytes 立即中断并抛错 */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  /* 有 Content-Length 时先判：省掉一整条浪费的下载 */
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new MisError('教务系统返回的内容过大', 'upstream')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        /* cancel 而不是直接丢弃：让底层连接知道我们不要了，避免 socket 一直被挂着 */
        await reader.cancel().catch(() => {})
        throw new MisError('教务系统返回的内容过大', 'upstream')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total)
}

/**
 * 把 fetch 抛出的网络层异常翻成用户能看懂、且**能据此行动**的提示。
 *
 * 为什么要统一在这里翻译：这类错误一旦漏到路由层，`fail()` 会把它归成
 * "服务器内部错误"并打一条堆栈 —— 用户完全无法判断是自己网络问题、
 * 学校门户在维护、还是本站坏了。而实际情况里，"在校园网外连不上 MIS"
 * 是学生最常撞上的一种，必须明确告诉他换个网络 / 开学校的 VPN。
 */
function describeNetworkError(err: unknown, url: string): string {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = url
  }
  const name = (err as { name?: string } | null)?.name ?? ''
  const cause = (err as { cause?: { code?: string; name?: string } } | null)?.cause
  const code = cause?.code ?? ''
  const causeName = cause?.name ?? ''
  /* AbortSignal.timeout 的超时在 undici 里表现为 TimeoutError / AbortError */
  if (name === 'TimeoutError' || name === 'AbortError' || causeName === 'ConnectTimeoutError') {
    return `连接学校 ${host} 超时。学校系统在校园网外访问较慢，请检查网络后重试；在校外建议先连学校 VPN。`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `无法解析学校 ${host} 的地址，请检查网络连接后重试。`
  }
  if (code === 'ECONNREFUSED') {
    return `学校 ${host} 拒绝了连接，可能正在维护，请稍后重试。`
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return `与学校 ${host} 的连接被中断，请稍后重试。`
  }
  if (code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `与学校 ${host} 的加密连接失败，请稍后重试；若持续出现请联系管理员。`
  }
  const detail = err instanceof Error ? err.message : String(err)
  return `无法连接学校 ${host}（${detail}），请检查网络后重试。`
}

/**
 * 判断一个网络异常是否发生在"连接还没建立起来"的阶段。
 *
 * 这个区分决定了**能不能安全重试**：连接都没建起来时，请求一个字节都没发出去，
 * 重试不会有副作用（对 POST 也一样）；而一旦进入收发阶段（读超时、被 RST），
 * 对方的服务端可能已经处理过这次请求，重试就可能造成重复提交。
 */
function isConnectPhaseError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; name?: string } } | null)?.cause
  const code = cause?.code ?? ''
  const causeName = cause?.name ?? ''
  return (
    causeName === 'ConnectTimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH'
  )
}

/**
 * 带一次重试的 fetch。
 *
 * 为什么需要：实测 sso.bjtu.edu.cn 存在**间歇性**连接超时 —— 同一台机器上，
 * 经 mis 跳转过去 99ms 就拿到页面，而直连同一个域名却连续 5 次都在 10s
 * 连接超时上失败。这不是我们的 bug，但如果一次就放弃，学生看到的就是
 * "连不上学校"，再点一次又好了 —— 体验上像是网站坏了。
 * 重试一次能把这类抖动吃掉，又不会把真正的故障（学校真的挂了）拖得更久。
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (!isConnectPhaseError(err)) throw err
    await new Promise((r) => setTimeout(r, 300))
    return await fetch(url, init)
  }
}

/** 手动跟随重定向的 fetch：每一跳都按 host 带上 cookie、吸收 set-cookie */
export async function jarFetch(jar: CookieJar, url: string, init: RequestInit = {}, maxHops = 8): Promise<FetchResult> {
  let current = url
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  const baseHeaders = new Headers(init.headers)
  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = new Headers(baseHeaders)
    headers.set('User-Agent', UA)
    const cookie = jar.headerFor(current)
    if (cookie) headers.set('Cookie', cookie)
    /* 网络层异常（DNS 失败、TLS 握手失败、连接/读取超时、被 RST）必须在这里
       翻译成 MisError。否则它会一路冒到路由层，被 fail() 归到"服务器内部错误"
       —— 用户看到 500 完全不知道该干什么，而我们这边只会打一条堆栈。
       学校门户在校园网外时快时慢，"连不上"是**用户的常见处境**，不是我们的 bug。 */
    let response: Response
    try {
      response = await fetchWithRetry(current, {
        method,
        body,
        headers,
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(REQ_TIMEOUT_MS)
      })
    } catch (err) {
      throw new MisError(describeNetworkError(err, current), 'network')
    }
    /* 先吸收 set-cookie 再判断重定向：CAS 的 ticket 就挂在 302 的 Set-Cookie 上。
       这里只写入 jar，jar 按 host 分桶（headerFor），所以被拒绝的跨域跳转即使记了
       cookie 也不会在后续请求里发出去。 */
    jar.absorb(current, response)
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new MisError('教务系统返回了无法解析的跳转地址', 'upstream')
      }
      /* 白名单判定在**发下一个请求之前**：这一步失败时我们还没有把 cookie 发给对方 */
      if (!isAllowedRedirectHost(next.host)) {
        console.error(`[mis] 拒绝跟随跨域重定向：${new URL(current).host} → ${next.host}`)
        throw new MisError('教务系统返回了异常的跳转地址，已中止请求', 'upstream')
      }
      // 303/307/308 语义化处理；301/302 按浏览器惯例 POST 转 GET
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        baseHeaders.delete('Content-Type')
      }
      /* response.body 不读完就走会泄漏连接，显式取消 */
      await response.body?.cancel().catch(() => {})
      current = next.toString()
      continue
    }
    const raw = await readBounded(response, MAX_RESPONSE_BYTES)
    return { url: current, response, body: raw.toString('utf8'), raw }
  }
  throw new MisError('重定向次数过多，MIS 登录流程异常，请稍后重试', 'upstream')
}

/* ---------------- 第 1 步：发起会话（打开 SSO 登录页） ---------------- */

/** SSO 登录页的特征串（form#loginForm），用来确认拿到的是登录页而不是错误页 */
const SSO_LOGIN_PAGE_HINT = 'id="loginForm"'

/**
 * 从 SSO 登录页里抠出提交登录所需的隐藏字段与 SM2 公钥。
 *
 * 字段清单以 `/sso/login` 的服务端实现为准（页面里那批 `<input name=… value=…>`）：
 * loginType / flowId / client_id / redirect_uri / response_type / scope / state。
 * 另外 captcha / delegator / tokenCode / continue / asserts / pageFrom 是空串占位，
 * 一并带上最稳妥（服务端缺字段时可能直接判错）。
 */
function parseSsoLoginPage(html: string): { fields: Record<string, string>; sm2PublicKey: string } | null {
  const $ = cheerio.load(html)
  const $form = $('form#loginForm')
  if ($form.length === 0) return null
  const fields: Record<string, string> = {}
  $form.find('input[name]').each((_, el) => {
    const name = $(el).attr('name') ?? ''
    if (!name) return
    // 可见的账号/密码/提交按钮不在这里取，避免把它们当成"隐藏字段"回填
    if (name === 'username' || name === 'password' || name === 'submit') return
    fields[name] = $(el).attr('value') ?? ''
  })
  // flowId 是每次都要新的，缺了说明页面结构变了
  if (!fields.flowId) return null

  /*
   * SM2 公钥在页面脚本里的 `var ssoConfig = {...}` 里，形如
   *   "sm2":{"enabled":true,"publicKey":"BI4o…"}
   * 注意页面里还有一段 `config.sm2.enabled` 的**引用**（doLogin 里），
   * 那个不是定义，抠它会拿到空值 —— 别再踩这个坑。
   * 用 JSON 解析而不是正则抠字符串：公钥是 Base64，带 `+` `/`，正则很容易截错。
   */
  let sm2PublicKey = ''
  const m = /var\s+ssoConfig\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html)
  if (m) {
    try {
      const cfg = JSON.parse(m[1]) as { sm2?: { enabled?: boolean; publicKey?: string } }
      const sm2 = cfg.sm2
      if (sm2?.enabled && typeof sm2.publicKey === 'string') sm2PublicKey = sm2.publicKey
    } catch {
      /* 解析失败留空，下面会报错 */
    }
  }
  return { fields, sm2PublicKey }
}

/**
 * 打开统一身份认证登录页。
 * 返回 sessionId（新流程没有验证码图片，所以只返回 sid）。
 *
 * userId === 0 表示**匿名会话**（「本校学生登录」入口：用户此刻还没有本地账号）。
 * 匿名会话不能按 userId 计数 —— 所有人共用 0，一按就会发现"3 个人就绪后
 * 全站匿名登录都被挡住 15 分钟"。改为按全局总量兜内存，配上接口层的 per-IP 限流。
 */
export async function startMisSession(userId: number): Promise<{ sid: string }> {
  cleanupSessions()
  if (userId > 0) {
    /* 达到上限时淘汰该用户**最久未使用**的会话（LRU），而不是直接报错。
       会话池化（2026-10-14）后，已登录会话会保留 2 小时，多设备 / 多入口的
       正常使用（手机+电脑+小程序）也可能短时超过 3 个 —— 直接拒绝会让
       "下一台设备/下一个入口"登不进来（旧模型 15 分钟速过期时不易触达）。
       淘汰不影响正在使用它的页面：那边下一次请求会收到"会话已过期"，前端引导重登。 */
    if (countMisSessions(userId) >= MAX_SESSIONS_PER_USER) {
      let oldest: MisSession | undefined
      for (const s of sessions.values()) {
        if (s.userId !== userId) continue
        if (!oldest || s.lastUsedAt < oldest.lastUsedAt) oldest = s
      }
      if (oldest) {
        oldest.jar.clear()
        sessions.delete(oldest.id)
        emitSessionDestroyed(oldest.id)
      }
    }
  } else if (countMisSessions(0) >= MAX_ANON_SESSIONS) {
    throw new MisError('当前使用人数较多，请稍后再试', 'network')
  }

  const jar = new CookieJar()
  // mis 的 SSO 入口（auth/nsso/）→ 一路 302 到统一身份认证的 /o/authorize/
  // 旧入口 /auth/sso/ 仍存在但指向已"未授权"的 cas.bjtu.edu.cn，不要再用。
  const entry = await jarFetch(jar, `${MIS_ORIGIN}/auth/nsso/?next=/`)
  const loginPageUrl = entry.url

  /* 这个 jar 是**全新**的，没有任何 cookie，所以正常情况下必然落在 SSO 登录页。
     没落上去说明学校的入口行为变了（或被网关拦了），此时不能装作成功：
     没有登录页表单就没法 POST 登录，硬建会话只会让用户在下一次点击时莫名其妙失败。 */
  if (!loginPageUrl.includes(CAS_HOST)) {
    throw new MisError(
      `MIS 登录入口没有跳到统一身份认证（被导向 ${new URL(loginPageUrl).host}），请稍后重试；若持续出现请联系管理员`,
      'upstream'
    )
  }

  const parsed = parseSsoLoginPage(entry.body)
  if (!parsed) {
    throw new MisError('统一身份认证登录页解析失败，学校门户可能已改版，请联系管理员', 'upstream')
  }
  if (!parsed.sm2PublicKey) {
    throw new MisError('统一身份认证登录页缺少加密公钥，学校门户可能已改版，请联系管理员', 'upstream')
  }

  const sid = randomUUID()
  const now = Date.now()
  sessions.set(sid, {
    id: sid,
    userId,
    createdAt: now,
    lastUsedAt: now,
    jar,
    casLoginUrl: loginPageUrl,
    ssoFields: parsed.fields,
    sm2PublicKey: parsed.sm2PublicKey,
    misLoggedIn: false,
    aaLoggedIn: false
  })
  return { sid }
}

/* ---------------- 第 2 步：提交账号密码完成登录 ---------------- */

/** 从 mis/home 页面解析姓名 / 身份 / 部门 */
function parseHomeProfile(html: string): { name: string; identity: string; department: string } {
  const $ = cheerio.load(html)
  const name = $('.name_right > h3 > a').first().text().split('（')[0].trim()
  let identity = ''
  let department = ''
  $('.name_right .nr_con span').each((_, el) => {
    const t = $(el).text()
    if (t.includes('身份')) identity = t.replace('身份：', '').trim()
    if (t.includes('部门')) department = t.replace('部门：', '').trim()
  })
  if (!name) throw new MisError('已登录但无法解析个人信息，学校门户可能已改版', 'upstream')
  return { name, identity, department }
}

/**
 * 从 SSO 登录页里取出 `var error = {…}` 的报错对象。
 *
 * 新版 SSO 失败时不再渲染 HTML 错误节点（`.error` / `.alert-danger`），
 * 而是把结果以 JSON 塞进页面脚本：`var error = {"code":40400,"msg":"账号或密码错误",…};`
 * 成功登录时这里就是 `var error = null;`。
 */
function parseSsoError(html: string): { code: number; msg: string } | null {
  const m = /var error\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html)
  if (!m) return null
  try {
    const v = JSON.parse(m[1]) as { code?: unknown; msg?: unknown }
    const code = typeof v.code === 'number' ? v.code : 0
    const msg = typeof v.msg === 'string' ? v.msg : ''
    if (!code && !msg) return null
    return { code, msg }
  } catch {
    return null
  }
}

/**
 * 把 SSO 的报错翻成人话。
 *
 * 重点：**"账号或密码错误"里有相当一部分其实是「统一身份认证还没激活」** ——
 * 学校 2026-10 换了统一身份认证之后，未激活的学生用正确的密码也登不进去，
 * 而系统只会含糊地说"账号或密码错误"。用户只会以为自己记错密码，然后反复重试。
 * 所以这里必须把「先去激活」这条出路写进提示里。
 */
function describeSsoError(err: { code: number; msg: string } | null): string {
  if (!err) {
    return '学号或密码不正确。若确认密码无误，可能是你的统一身份认证账号还没有激活，请先到 sso.bjtu.edu.cn 完成激活后再试。'
  }
  /* 顺序有讲究：先判"锁定/冻结"，再判"密码/账号"。
     反过来的话，"您的账号已被锁定" 会因为含"账号"二字被密码分支吞掉，
     用户看到的就成了"密码可能不对"，反而去重试密码、把账号越试越死。 */
  if (err.msg.includes('锁定') || err.msg.includes('冻结')) {
    return `账号已被学校锁定（学校返回：${err.msg}），请先到 sso.bjtu.edu.cn 处理后再试。`
  }
  // 41100 需要校验码 / 41102 带校验码但错误：说明短时间内失败太多次，触发了风控。
  if (err.code === 41100 || err.code === 41102 || err.msg.includes('校验码')) {
    return '登录失败次数过多，学校为您开启了图形验证码保护。请稍等几分钟再试，或直接到 sso.bjtu.edu.cn 登录一次后再回来。'
  }
  // 学校对"未激活"的账号也回 40400 账号或密码错误，所以这里必须把激活的出路写出来
  if (err.code === 40400 || err.msg.includes('密码') || err.msg.includes('账号')) {
    return `学号或密码不正确（学校返回：${err.msg}）。若确认密码无误，可能是你的统一身份认证账号还没有激活，请先到 sso.bjtu.edu.cn 完成激活后再试。`
  }
  return `统一身份认证登录失败：${err.msg || `错误码 ${err.code}`}`
}

export interface MisLoginResult {
  name: string
  identity: string
  department: string
}

export async function misLogin(
  sid: string,
  userId: number,
  username: string,
  password: string
): Promise<MisLoginResult> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (s.misLoggedIn) throw new MisError('该会话已登录，如需换账号请重新登录')
  if (!username || !password) throw new MisError('请填写学号和密码')

  // 密码必须 SM2 加密后再提交，明文会被服务端当成"账号或密码错误"
  let cipher: string
  try {
    cipher = sm2Encrypt(password, s.sm2PublicKey)
  } catch (e) {
    throw new MisError(`登录密码加密失败：${e instanceof Error ? e.message : '未知错误'}，请稍后重试`)
  }

  const form = new URLSearchParams({
    ...s.ssoFields,
    username,
    password: cipher,
    submit: '登录'
  })

  const res = await jarFetch(s.jar, `${CAS_ORIGIN}/sso/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: s.casLoginUrl,
      Origin: CAS_ORIGIN
    },
    body: form.toString()
  })

  // 成败判断必须先判成功再判失败：最终落点为 MIS 主机且不在 auth 流程内 = 登录成功
  const finalUrl = new URL(res.url)
  const succeeded = finalUrl.host === MIS_HOST && !finalUrl.pathname.startsWith('/auth/')
  if (!succeeded) {
    // 登录失败：作废本次会话（SSO 侧的 JSESSIONID / flowId 都已失效），要求用户重来
    const onCas = res.url.includes(new URL(CAS_ORIGIN).host)
    const ssoErr = onCas ? parseSsoError(res.body) : null
    const detail = onCas ? describeSsoError(ssoErr) : null
    /* 诊断日志（2026-10-22 加）：只记学校返回的错误码与原文，**不记学号、不记密码**。
       线上「账号突然登不进去」时，这是唯一能区分「密码错 / 未激活 / 风控要验证码 /
       门户改版导致解析不出错误」的证据 —— 此前这些信息全被埋在用户端的文案里，
       而用户往往只会说"登不进去"，排查只能靠猜。 */
    console.warn(
      `[mis] SSO 登录失败 path=${new URL(res.url).pathname} code=${ssoErr?.code ?? '-'} msg=${ssoErr?.msg ?? '-'}`
    )
    s.jar.clear()
    sessions.delete(sid)
    emitSessionDestroyed(sid)
    /* SSO 给出了明确错误（密码错/未激活/锁定）= 用户输入问题 → 400；
       只有拿不到原因（跳转异常、页面解析不出）才是上游异常 → 502。 */
    throw detail
      ? new MisError(detail, 'input')
      : new MisError('MIS 登录后跳转异常，请稍后重试', 'upstream')
  }

  const profile = parseHomeProfile(res.body)
  s.misLoggedIn = true
  s.profile = profile
  /* 归属不在这里改。匿名会话（本校学生登录）要在**账号建出来之后**由调用方
     显式用 rebindMisSession 过继 —— 见该函数注释。 */
  return profile
}

/* ---------------- 第 3 步：AA 跳转 + 课表抓取解析 ---------------- */

/** MIS 到 AA 免登录跳转（还原 aaLogin：module/10 页面里有自动提交的 redirect form） */
async function aaLogin(s: MisSession): Promise<void> {
  const page = await jarFetch(s.jar, `${MIS_ORIGIN}/module/module/10/`)
  const $ = cheerio.load(page.body)
  const action = $('form#redirect').attr('action')
  if (!action) throw new MisError('AA 教务跳转票据获取失败，MIS 会话可能已失效')
  const target = await jarFetch(s.jar, action.endsWith('?') ? action : action + '?')
  if (!target.url.includes(AA_HOST)) {
    throw new MisError('AA 教务系统跳转未成功，请重新登录 MIS')
  }
  s.aaLoggedIn = true
}

/** 大节时间表：与网站默认节次（DEFAULT_PERIODS）一一对应 */
export const MIS_PERIODS = [
  { index: 1, start: '08:00', end: '09:50' },
  { index: 2, start: '10:10', end: '12:00' },
  { index: 3, start: '12:10', end: '14:00' },
  { index: 4, start: '14:10', end: '16:00' },
  { index: 5, start: '16:20', end: '18:10' },
  { index: 6, start: '19:00', end: '20:50' },
  { index: 7, start: '21:00', end: '21:50' }
]

/** 与 server/src/index.ts 的 COURSE_COLORS 保持一致，按课程名稳定分配颜色 */
const COURSE_COLORS = [
  '#4f7cff', '#ff6b6b', '#20c997', '#ffa94d', '#845ef7',
  '#f783ac', '#12b886', '#ffd43b', '#4dabf7', '#e8590c'
]

function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return COURSE_COLORS[h % COURSE_COLORS.length]
}

/**
 * 从 AA「我的课表」整页文本里抓取官方"总学分"（页面上部选课摘要，形如"共 25.5 学分"）。
 *
 * 为什么要独立于逐格学分解析：
 *  - AA 课表格子本身**不渲染每门课的学分**（参考「交大自由行」App：getCourse 只解析
 *    课程名、周次/教师/地点，从不从格子读学分）——这也是早期「无法抓取学分」的根因。
 *  - 但页面上方有选课汇总，会写"共选修 N 门 · 总学分 X"或"已选 X 门，共 25.5 学分"之类。
 *  - 用户决定：不逐课导学分，只取这个官方总学分，作为课表页学分卡的权威口径。
 *
 * 因此用「共/总/合计」这类**汇总性措辞**做锚点而不是裸数字，避免误命中课格子里
 * 单门课的 "X学分"（那种不带「共/总」前缀）。
 */
export function parseAaTotalCredits(html: string): number | null {
  const text = cheerio.load(html).root().text().replace(/\s+/g, '')
  if (!text) return null
  const num = String.raw`(\d+(?:\.\d+)?)`
  const patterns: RegExp[] = [
    // 已选 10 门，共 25.5 学分 / 共选修 25.5 学分
    new RegExp(`共[^学分]{0,12}?${num}学分`),
    // 已选 10 门 · 总学分：25.5 / 总学分 25.5
    new RegExp(`总学分\\s*[:：]?\\s*${num}`),
    // 本学期总学分：25.5
    new RegExp(`本学期[^学分]{0,8}?总学分\\s*[:：]?\\s*${num}`),
    // 已修/已选修 → 学分合计 X
    new RegExp(`(?:合计|总计)[^学分]{0,8}?${num}学分`)
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) {
      const v = Number(m[1])
      if (Number.isFinite(v) && v >= 0 && v <= 300) return v
    }
  }
  return null
}

/* ---------------- 学期信息（开学日 / 总周数） ---------------- */

export interface AaSemesterInfo {
  /** 学期第一周的周一（YYYY-MM-DD）；教务页面没给则为 null */
  startDate: string | null
  /** 学期总周数；识别不到则为 null */
  totalWeeks: number | null
  /** 命中来源说明，用于前端展示与排障（如「开学日来自页面"开学日期"」） */
  source: string | null
}

/** 2026-09-07 / 2026/9/7 / 2026年9月7日 → YYYY-MM-DD；非法日期返回 null */
function toISOFromParts(y: string, m: string, d: string): string | null {
  const yi = Number(y)
  const mi = Number(m)
  const di = Number(d)
  if (!(yi >= 2000 && yi <= 2100)) return null
  if (!(mi >= 1 && mi <= 12) || !(di >= 1 && di <= 31)) return null
  const dt = new Date(yi, mi - 1, di)
  if (dt.getFullYear() !== yi || dt.getMonth() !== mi - 1 || dt.getDate() !== di) return null
  return `${yi}-${pad2(String(mi))}-${pad2(String(di))}`
}

/**
 * 开学日一律按「该周周一」对齐：系统所有周次计算都以 startDate 所在周的周一为锚点，
 * 教务若给的是周三，不对齐会让整学期周次集体错位。
 */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay() // 0=周日
  dt.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day))
  return `${dt.getFullYear()}-${pad2(String(dt.getMonth() + 1))}-${pad2(String(dt.getDate()))}`
}

const DATE_RE = String.raw`(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})`

/**
 * 从 AA 课表页尽力识别教务系统的「学期开学日」和「总周数」。
 * 各校教务页面结构不统一，因此多重兜底：
 *   - 正文里的「开学日期 / 学期开始 / 第一周 …」后跟日期；
 *   - <script> 或属性里的 startDate / termStart / firstWeek 等变量；
 *   - 周数：共 X 周 / 总周数 X / X 周制；仍拿不到就用课表里最大的 weekEnd 兜底。
 * 全部识别失败返回 null —— **只影响提示，不影响课表导入**，前端显示"未识别到"即可。
 */
export function parseAaSemesterInfo(html: string, courses: MisCourse[] = []): AaSemesterInfo {
  const $ = cheerio.load(html)
  const text = $.root().text().replace(/\s+/g, '')
  // raw 含 <script> 与标签属性，用于找藏在 JS 变量 / data-* 里的值。
  const raw = html.replace(/\s+/g, '')

  let startDate: string | null = null
  let dateSrc = ''
  const datePatterns: { re: RegExp; src: string }[] = [
    {
      re: new RegExp(`(?:开学|开课|学期开始|学期起始|起始日期|开始日期|第一周|首周|校历)[^0-9]{0,10}${DATE_RE}`),
      src: '页面「开学日期」'
    },
    { re: new RegExp(`${DATE_RE}[^0-9]{0,6}(?:开学|开课|起上课|学期开始)`), src: '页面「日期+开学」' },
    {
      re: new RegExp(`(?:startDate|start_date|start-date|termStart|termBegin|beginDate|firstWeek|week1Start|semesterStart)\\s*[:=]\\s*["']?${DATE_RE}`, 'i'),
      src: '页面脚本变量'
    }
  ]
  for (const p of datePatterns) {
    const m = p.re.exec(text) ?? p.re.exec(raw)
    if (!m) continue
    const iso = toISOFromParts(m[1], m[2], m[3])
    if (iso) {
      startDate = mondayOf(iso)
      dateSrc = p.src
      break
    }
  }

  let totalWeeks: number | null = null
  let weekSrc = ''
  const weekPatterns: { re: RegExp; src: string }[] = [
    { re: /共\s*(\d{1,2})\s*周/, src: '页面「共 X 周」' },
    { re: /(?:总周数|周数|教学周数)\s*[:：]?\s*(\d{1,2})/, src: '页面「总周数」' },
    // 教务页面脚本里的英文变量（totalWeeks=16 / weeks:"16" 等），只可能在 raw 里命中
    { re: /(?:totalWeeks|total_weeks|weekCount|weeks)\s*[:=]\s*["']?(\d{1,2})["']?/i, src: '页面脚本变量' },
    { re: /(\d{1,2})\s*周制/, src: '页面「X 周制」' },
    { re: /本学期[^。；]{0,10}?(\d{1,2})\s*周/, src: '页面「本学期 X 周」' }
  ]
  for (const p of weekPatterns) {
    const m = p.re.exec(text) ?? p.re.exec(raw)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isInteger(n) && n >= 1 && n <= 60) {
      totalWeeks = n
      weekSrc = p.src
      break
    }
  }
  if (totalWeeks == null && courses.length > 0) {
    const maxEnd = courses.reduce((a, c) => Math.max(a, c.weekEnd), 0)
    if (maxEnd >= 1 && maxEnd <= 60) {
      totalWeeks = maxEnd
      weekSrc = '课表最大结束周（页面未直接给出）'
    }
  }

  const notes: string[] = []
  if (startDate) notes.push(`开学日来自${dateSrc}`)
  if (totalWeeks) notes.push(`周数来自${weekSrc}`)
  return { startDate, totalWeeks, source: notes.length > 0 ? notes.join('；') : null }
}

/** 解析 "1-16" / "1-8,10-16" / "5" 这类周次串为若干连续区间 */
function parseWeekRanges(raw: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const part of raw.split(/[,，]/)) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!m) continue
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : start
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
      out.push({ start, end })
    }
  }
  return out
}

export interface MisCourse {
  name: string
  teacher: string
  location: string
  dayOfWeek: number
  weekStart: number
  weekEnd: number
  weekType: 'all' | 'odd' | 'even'
  /**
   * 精确上课周集合（升序去重）。
   * 教务页面常见 "第 1,03,05,07,09,11,13,15 周" 这类逗号列表，
   * 因此解析一律展开成显式集合；weekStart/weekEnd/weekType 退化为
   * min/max/单双周的兼容摘要，展示与旧客户端仍可用。
   */
  weeks?: number[]
  startPeriod: number
  endPeriod: number
  color: string
  /**
   * 学分。取值优先级：
   *  1. 课表格子文本里显式的 "X学分"（少见，AA 网格通常不渲染学分）；
   *  2. 课程列表「学时/学分」列按课程号匹配（见 parseAaCourseCredits，实测覆盖 19/19）；
   * 两者都取不到才为 null（可在课程里手动补填）。
   */
  credits: number | null
}

/**
 * 从 AA 课表页下方的「课程列表」表格抓取**每门课的学分**。
 * 为什么必须单独抓：课表网格里每个课程块**不渲染学分**，
 * 学分只出现在课程列表的「学时/学分」列（形如 `64.0 / 4.0`，前者学时、后者学分）。
 * 页面顶部也没有「共 X 学分」之类的汇总文案，所以 parseAaTotalCredits 在本页恒为 null。
 * 键用**课程号**而不是「课程名+班号」：同一门课的不同班（如物理实验的 08/09/17 班）
 * 学分相同，按课程号归一足够，且能避开"课程名含空格导致分列错位"的解析坑。
 * ⚠️ 课程列表**包含「选课状态 = 未中」的落选课**（它们不出现在课表网格里），
 * 所以本 Map 会比实际课表多出几条（实测 15 条 vs 课表 11 门）。这里只把它当
 * **查表字典**用 —— 课表格子里的课必然已选中 —— 绝不能拿它当"本学期课程清单"，
 * 否则会把落选课一并算进学分/课表。若将来要做「按课程列表整表导入」，
 * 必须先按「选课状态」列过滤掉「未中」。
 */
export function parseAaCourseCredits(html: string): Map<string, number> {
  const out = new Map<string, number>()
  const $ = cheerio.load(html)
  $('table').each((_, table) => {
    const $t = $(table)
    const rows = $t.find('tr').toArray()
    if (rows.length < 2) return
    const headers = $(rows[0]).find('th,td').toArray().map((el) => $(el).text().replace(/\s+/g, ''))
    const iCredit = headers.findIndex((h) => /学分/.test(h))
    const iClass = headers.findIndex((h) => /课堂/.test(h))
    if (iCredit < 0 || iClass < 0) return

    for (const row of rows.slice(1)) {
      const cells = $(row).find('td').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      if (cells.length <= Math.max(iCredit, iClass)) continue
      // 「课堂」列形如 "M108002B 大学物理（A)01 物工学院" → 取首个 token 作课程号
      const courseNum = (cells[iClass].match(/^[A-Za-z0-9]+/) ?? [])[0]
      // 「学时/学分」列形如 "64.0 / 4.0" → 后一个数是学分
      const m = /([\d.]+)\s*\/\s*([\d.]+)/.exec(cells[iCredit])
      if (!courseNum || !m) continue
      const credits = Number(m[2])
      if (Number.isFinite(credits) && credits >= 0 && credits <= 30) out.set(courseNum, credits)
    }
  })
  return out
}

/**
 * 解析 AA「我的课表」页面。
 * 表格结构（还原 App 端逻辑）：每行一个大节，每行去掉第一个标签格后
 * 剩 8 格，第 1-7 格对应周一~周日，第 8 格弃用；
 * 每个格子里可能有多个课程块（同格不同周次的多门课）。
 */
export function parseAaSchedule(html: string): MisCourse[] {
  const $ = cheerio.load(html)
  const table = $('table').first()
  if (table.length === 0) throw new MisError('课表页面解析失败：未找到课表表格（可能未登录 AA 或页面已改版）', 'upstream')

  // 网格块不含学分，学分统一从下方课程列表取（见 parseAaCourseCredits 注释）
  const creditMap = parseAaCourseCredits(html)

  const courses: MisCourse[] = []
  const rows = table.find('tr').toArray().slice(1) // 跳过表头行
  rows.forEach((row, rowIdx) => {
    const period = rowIdx + 1 // 大节序号：1-7
    if (period > 7) return
    const tds = $(row).find('td').toArray().slice(1) // 去掉行首节次标签
    tds.slice(0, 7).forEach((td, colIdx) => {
      const day = colIdx + 1
      $(td).children().each((_, block) => {
        const $b = $(block)
        // 课程号/名称：current 页在首个 span 的 html 里，用 <br> 分隔
        const spanHtml = $b.find('span').first().html() ?? ''
        const parts = spanHtml.split(/<br\s*\/?>/i)
        const courseId = cheerio.load(parts[0] ?? '').text().trim()
        const name = cheerio
          .load(parts[1] ?? $b.text())
          .text()
          .trim()
        if (!name) return

        // 时间块：形如 "1-16周" / "1-8,10-16周" / "第1,03,05…周"，可能带 单/双 标记
        const infoDiv = $b.find('div[style^=max-width]').first()
        /**
         * 周次文本必须与老师姓名隔离后再做单/双周判定：
         * 教务把 <i>老师</i> 放在同一个时间 div 里，整块匹配会把
         * "彭双巧" 的「双」字当成双周标记（真实事故：C语言整学期课被判成双周）。
         * 因此 clone 一份去掉 <i>，只留周次文本再匹配。
         */
        const weekText = infoDiv
          .clone()
          .find('i')
          .remove()
          .end()
          .text()
          .replace(/\s+/g, '')
        const timeRaw = infoDiv.text().replace(/\s+/g, '')
        const weekType: MisCourse['weekType'] = /单/.test(weekText) ? 'odd' : /双/.test(weekText) ? 'even' : 'all'
        // 只保留数字/区间/并列符，兼容 "1-16周" / "1-15(单)" / "第1,03,05…周" 等写法
        const weekPart = (weekText.split('周')[0] ?? '').replace(/[^\d,，\-]/g, '')
        const ranges = parseWeekRanges(weekPart)
        if (ranges.length === 0) return

        const teacher = infoDiv.find('i').first().text().trim() || '未知教师'
        const location = $b.find('span.text-muted').first().text().replace(/\s+/g, '') || '未知地点'
        const color = colorFor(name || courseId)
        // 学分 best-effort。两步：
        // 学分 best-effort。两步：
        //  1. 先从格子可见文本里剥掉已识别的片段（周次/课程号/名称/教师/地点），
        //     不剥的话，"C语言B02" 紧挨 "学分:2" 会被误读成 502 学分；
        //  2. 在剩余文本里找学分：中文习惯数字在前（"2学分"、"2.5 学分"），
        //     表头或英文习惯标签在前（"学分:2"、"credits: 3"），两种顺序都要支持。
        let restText = $b.text().replace(/\s+/g, '')
        for (const frag of [timeRaw, courseId, name, teacher, location]) {
          const f = frag.replace(/\s+/g, '')
          if (f) restText = restText.split(f).join('')
        }
        const num = String.raw`(\d+(?:\.\d+)?)`
        const creditMatch =
          new RegExp(`${num}\\s*学分`).exec(restText) ??
          new RegExp(`(?:学分|credits?)\\s*[:：]?\\s*${num}`, 'i').exec(restText)
        // 优先用格子文本里显式写的学分；没有则回退到课程列表「学时/学分」列
        const courseNum = (courseId.match(/^[A-Za-z0-9]+/) ?? [])[0]
        const credits = creditMatch
          ? Number(creditMatch[1])
          : courseNum
            ? creditMap.get(courseNum) ?? null
            : null

        // 展开（区间 × 单双周）为精确周集合，再按同一格合成一条课程记录。
        // 旧逻辑按 range 逐条拆分，"第1,03,05…周" 会生成 8 条记录，
        // 预览与课表数据都被无谓放大；显式集合是唯一无损表达。
        const weekSet = new Set<number>()
        for (const r of ranges) {
          for (let w = r.start; w <= r.end; w++) {
            if (w > 60) break // 防御：异常输入不至于展开出天文数字
            /* 单/双周过滤必须**两边都做**：此前只过滤了 even，于是 "第01-15(单)周"
               这类带显式单周标记的区间被展开成 1..15 全周 —— 用户看到的是
               "每周都有这门课"（课表、ICS 订阅、周视图统计全都跟着错）。
               并列写法的 "第1,03,05…周" 本身只含单周，过滤不会误伤。 */
            if (weekType === 'odd' && w % 2 === 0) continue
            if (weekType === 'even' && w % 2 === 1) continue
            weekSet.add(w)
          }
        }
        if (weekSet.size === 0) return
        const weeks = [...weekSet].sort((a, b) => a - b)

        courses.push({
          name,
          teacher,
          location,
          dayOfWeek: day,
          weekStart: weeks[0],
          weekEnd: weeks[weeks.length - 1],
          weekType,
          weeks,
          startPeriod: period,
          endPeriod: period,
          color,
          credits
        })
      })
    })
  })
  return courses
}

/* ---------------- 考试安排抓取（考务） ---------------- */

/**
 * 考务：AA 教务「考试查询」页面路径候选表。
 * 为什么是「候选表 + 逐个探测」而不是写死一个路径：
 *  - AA 是 Django 应用，考试模块（exam/examtask/…）的路由在不同学年/版本间改过名字，
 *    写死一个路径一旦改版就整体失效；
 *  - 探测代价很低（几次 GET），命中即止，且失败不会抛错、只返回空列表；
 *  - 运维侧可用环境变量 AA_EXAM_PATH（逗号分隔）直接指定正确路径，无需改代码。
 */
const DEFAULT_AA_EXAM_PATHS = [
  /* 参考仓库（KMP 版交大自助）实测命中过这个 —— 放在最前，
     优先用它，省掉逐条探测的往返。 */
  '/examine/examplanstudent/stulist/',
  '/exam/examtask/student_exam/',
  '/exam/examtask/exam_list/',
  '/exam/examtask/',
  '/exam/examarrange/student/',
  '/exam/examarrange/',
  '/exam/examtask/schedule/'
]

function examPaths(): string[] {
  const env = (process.env.AA_EXAM_PATH ?? '').trim()
  if (!env) return DEFAULT_AA_EXAM_PATHS
  const list = env.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith('/') ? p : `/${p}`))
  return list.length ? list : DEFAULT_AA_EXAM_PATHS
}

export interface MisExam {
  courseName: string
  /** YYYY-MM-DD */
  examDate: string
  /** HH:mm，未公布时为空串 */
  startTime: string
  endTime: string
  location: string
  seat: string
  note: string
}

function pad2(n: string): string {
  return n.length === 1 ? `0${n}` : n
}

/** 从 "2026-01-05(周一) 09:00-11:00" / "2026年1月5日 8:30~10:30" 里抽出日期与时间。 */
function parseExamDateTime(text: string): { date: string; start: string; end: string } | null {
  const dm = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(text)
  if (!dm) return null
  const date = `${dm[1]}-${pad2(dm[2])}-${pad2(dm[3])}`
  if (!isValidISODate(date)) return null
  const tm = /(\d{1,2}:\d{2})\s*(?:[-–—~～]|到|至)\s*(\d{1,2}:\d{2})/.exec(text)
  if (!tm) return { date, start: '', end: '' }
  return { date, start: pad2(tm[1]), end: pad2(tm[2]) }
}

/** 单独一列只给时间段时（如 "09:00-11:00" / "9:00~11:00"）解析。 */
function parseTimeRange(text: string): { start: string; end: string } | null {
  const tm = /(\d{1,2}:\d{2})\s*(?:[-–—~～]|到|至)\s*(\d{1,2}:\d{2})/.exec(text)
  if (!tm) return null
  return { start: pad2(tm[1]), end: pad2(tm[2]) }
}

function isValidISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

/** 表头里按关键词找列下标；多个正则按顺序优先命中 */
function colIndex(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h))
    if (i >= 0) return i
  }
  return -1
}

/**
 * 通用解析 AA 考试页：不依赖固定列顺序，按表头关键词定位列。
 * 只认「同时有课程名 + 日期列」的表格，避免误抓页面里的其他表格。
 */
export function parseAaExams(html: string): MisExam[] {
  const $ = cheerio.load(html)
  const out: MisExam[] = []
  const seen = new Set<string>()

  $('table').each((_, table) => {
    const $t = $(table)
    const rows = $t.find('tr').toArray()
    if (rows.length === 0) return

    // 表头：优先 thead th；否则若第一行像表头（含"课程/科目"等词）就拿它当表头
    let headers = $t.find('thead th').toArray().map((el) => $(el).text().replace(/\s+/g, ''))
    let bodyRows = rows
    if (headers.length === 0) {
      const first = $(rows[0]).find('th,td').toArray().map((el) => $(el).text().replace(/\s+/g, ''))
      if (first.length && /课程|科目|课名|考试/.test(first.join('|'))) {
        headers = first
        bodyRows = rows.slice(1)
      }
    }
    if (headers.length === 0) return

    const iCourse = colIndex(headers, [/课程名称|科目名称|课程名|课名|课程|科目/, /名称/])
    const iDate = colIndex(headers, [/考试时间|考试日期|考试时段/, /日期|时间/])
    const iLocation = colIndex(headers, [/考试地点|考场|地点|教室/])
    const iSeat = colIndex(headers, [/座位号|座位|座号/])
    const iNote = colIndex(headers, [/备注|说明/])
    // 课程名与日期缺一不可，否则这张表不是考试安排

    for (const row of bodyRows) {
      const cells = $(row)
        .find('td')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      if (cells.length <= Math.max(iCourse, iDate)) continue

      const courseName = cells[iCourse] ?? ''
      if (!courseName || courseName.length < 2) continue

      const dt = parseExamDateTime(cells[iDate] ?? '')
      if (!dt) continue
      // 时间可能在日期列里，也可能单列（如"考试时间"只写日期、"时间"列写时段）
      let { start, end } = dt
      if (!start && iDate !== iNote) {
        // 日期列没带时间时，去整行里找一个 HH:mm-HH:mm
        const rowTime = parseTimeRange(cells.join(' '))
        if (rowTime) {
          start = rowTime.start
          end = rowTime.end
        }
      }

      const key = `${courseName}|${dt.date}|${start}`
      if (seen.has(key)) continue
      seen.add(key)

      out.push({
        courseName,
        examDate: dt.date,
        startTime: start,
        endTime: end,
        location: iLocation >= 0 ? cells[iLocation] ?? '' : '',
        seat: iSeat >= 0 ? cells[iSeat] ?? '' : '',
        note: iNote >= 0 ? cells[iNote] ?? '' : ''
      })
    }
  })

  out.sort((a, b) => (a.examDate + a.startTime).localeCompare(b.examDate + b.startTime))
  return out
}

/**
 * 抓取本学期考试安排。前置：misLogin 已成功。
 * 逐个探测候选路径，命中（解析到考试行）即返回；全部未命中返回空列表而非报错，
 * 由前端提示「教务系统暂未公布考试安排 / 页面结构可能已变化」。
 */
export async function misFetchExams(
  sid: string,
  userId: number
): Promise<{ exams: MisExam[]; path: string | null; tried: string[] }> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  if (!s.aaLoggedIn) await aaLogin(s)

  const tried: string[] = []
  let hit: { exams: MisExam[]; path: string } | null = null
  for (const p of examPaths()) {
    tried.push(p)
    let page: FetchResult
    try {
      page = await jarFetch(s.jar, `${AA_ORIGIN}${p}`)
    } catch {
      continue
    }
    // 被踢回登录页/非 200 直接换下一个候选
    const exams = parseAaExams(page.body)
    if (exams.length > 0) {
      hit = { exams, path: p }
      break
    }
  }

  // 会话保留在池里（2026-10-14 会话池：一次登录全应用复用；靠滑动 TTL 清理）
  if (!hit) return { exams: [], path: null, tried }
  return { exams: hit.exams, path: hit.path, tried }
}

/** 拉取本学期课表。前置：misLogin 已成功。 */
export async function misFetchCourses(
  sid: string,
  userId: number
): Promise<{ courses: MisCourse[]; totalCredits: number | null; semester: AaSemesterInfo }> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  if (!s.aaLoggedIn) await aaLogin(s)

  const page = await jarFetch(s.jar, `${AA_ORIGIN}/course_selection/courseselecttask/schedule/`)
  if (!page.url.includes(AA_HOST)) {
    throw new MisError('课表页面跳转异常，AA 登录态可能已失效，请重新走一遍登录流程')
  }
  const courses = parseAaSchedule(page.body)
  const totalCredits = parseAaTotalCredits(page.body)
  // 顺带识别教务系统的开学日/总周数，供前端一键同步到用户学期设置
  const semester = parseAaSemesterInfo(page.body, courses)
  // 会话保留在池里（2026-10-14 会话池：一次登录全应用复用；靠滑动 TTL 清理）
  return { courses, totalCredits, semester }
}

/* ---------------- 合并同步：一次 MIS 会话同时取「本科教务课表」与「智慧教学平台」 ---------------- */

/** 智慧教学平台同步结果（失败不抛错，用 ok/error 表达，避免拖垮整个同步） */
export interface BksySyncResult {
  ok: boolean
  error?: string
  /** 当前学期（含开学日/结束日，可作为学期设置的权威来源） */
  semester: Omit<BksySemester, 'current'> | null
  courses: BksyCourse[]
  /** 作业(0) + 课程设计(1) + 实验报告(2) 合并列表 */
  homeworks: BksyHomework[]
  /**
   * 拉取失败的「课程 × 类型」清单（评审 B7，2026-10-23）。
   * 此前单门课失败被静默吞掉 —— 作业无声缺席一次同步、用户完全无感知。
   * ok 仍为 true（部分失败不该拖垮整体），前端把这份清单展示出来即可。
   */
  failedCourses?: string[]
}

export interface MisSyncResult {
  /** 本科教务课表（周次模型） */
  courses: MisCourse[]
  totalCredits: number | null
  semester: AaSemesterInfo
  /** AA 侧失败原因；null 表示成功。AA 失败但智慧教学平台成功时整体仍算成功 */
  aaError: string | null
  /**
   * 本科教务成绩（ln / lr 两类）。
   * ⚠️ `ok` 只有**两类都成功**时才为 true —— 路由层据此决定是否覆盖缓存，
   * 单类成功绝不能覆盖（会让另一类成绩凭空消失）。
   */
  grades: { ok: boolean; items: Grade[]; failed: string[]; error: string | null }
  bksy: BksySyncResult
}

/**
 * 一次会话、两个平台：
 *  1. AA 本科教务课表（周次模型 → courses 表）
 *  2. 智慧教学平台课程 + 作业（→ tasks 表 / 作业页）
 *
 * 为什么要合并成一次调用：两者共用同一个 CAS 登录态，而 MIS 会话是**一次性的**
 * （任一侧拉完即销毁）。拆成两个接口会导致第二个必然「会话已过期」。
 * 容错策略：两个平台**互不拖累** —— 任一失败只记 error，另一个照常返回；
 * 只有两边都失败才整体报错。这样学校某一个系统临时抽风时，用户仍能拿到另一半数据。
 */
export async function misFetchAll(sid: string, userId: number): Promise<MisSyncResult> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  // 1. 本科教务（AA）课表
  let aa: { courses: MisCourse[]; totalCredits: number | null; semester: AaSemesterInfo } | null = null
  let aaError: string | null = null
  try {
    if (!s.aaLoggedIn) await aaLogin(s)
    const page = await jarFetch(s.jar, `${AA_ORIGIN}/course_selection/courseselecttask/schedule/`)
    if (!page.url.includes(AA_HOST)) throw new MisError('课表页面跳转异常，AA 登录态可能已失效')
    const courses = parseAaSchedule(page.body)
    aa = {
      courses,
      totalCredits: parseAaTotalCredits(page.body),
      semester: parseAaSemesterInfo(page.body, courses)
    }
  } catch (err) {
    aaError = err instanceof Error ? err.message : String(err)
  }

  /* 2. 本科教务（AA）成绩。
     与课表共用同一个 AA 会话（s.jar），不额外登录一次。
     ⚠️ 成绩必须 ln / lr 两类都成功才算拿到 —— 只成功一类时把结果标成
     ok:false 并带上失败清单，由路由层决定**不覆盖缓存**（否则另一类成绩会消失）。 */
  let grades: { ok: boolean; items: Grade[]; failed: string[]; error: string | null } = {
    ok: false,
    items: [],
    failed: [],
    error: null
  }
  try {
    const r = await fetchGrades(s.jar)
    const allOk = r.failedCtypes.length === 0
    grades = {
      ok: allOk && r.grades.length > 0,
      items: r.grades,
      failed: r.failedCtypes,
      /* 两类都失败才算"完全没拿到"；一类失败时 items 里仍有另一类数据，
         前端展示但服务端不落库（避免覆盖） */
      error: allOk ? null : `成绩组 ${r.failedCtypes.join(' / ')} 分组拉取失败`
    }
  } catch (err) {
    grades = { ok: false, items: [], failed: [], error: err instanceof Error ? err.message : String(err) }
  }

  // 3. 智慧教学平台（复用同一 MIS 会话的 OAuth2 免登录）
  let bksy: BksySyncResult = { ok: false, semester: null, courses: [], homeworks: [] }
  try {
    if (!s.bksyLoggedIn) {
      await bksySso(s.jar, MIS_ORIGIN)
      s.bksyLoggedIn = true
    }
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)

    const semesters = await bksyFetchSemesters(s.jar, s.bksySessionId)
    const current = semesters.find((x) => x.current) ?? semesters[0] ?? null
    if (!current) throw new MisError('智慧教学平台未返回学期信息', 'upstream')

    const courses = await bksyFetchCourses(s.jar, s.bksySessionId, current.xqCode)
    // 逐门课拉三类任务（作业/课程设计/实验报告）；单门失败不中断整体，
    // 但必须**留痕**（评审 B7）：静默跳过 = 作业无声缺席、用户无从察觉。
    const homeworks: BksyHomework[] = []
    const failedCourses: string[] = []
    const SUBTYPE_LABEL: Record<0 | 1 | 2, string> = { 0: '作业', 1: '课程设计', 2: '实验报告' }
    for (const c of courses) {
      for (const subType of [0, 1, 2] as const) {
        try {
          homeworks.push(...(await bksyFetchHomeworks(s.jar, s.bksySessionId, c.id, subType)))
        } catch (err) {
          failedCourses.push(`${c.name}（${SUBTYPE_LABEL[subType]}）：${err instanceof Error ? err.message : '拉取失败'}`)
        }
      }
    }
    bksy = {
      ok: true,
      semester: {
        xqCode: current.xqCode,
        name: current.name,
        beginDate: current.beginDate,
        endDate: current.endDate
      },
      courses,
      homeworks,
      failedCourses
    }
  } catch (err) {
    bksy = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      semester: null,
      courses: [],
      homeworks: []
    }
  }

  // 会话保留在池里（2026-10-14 会话池：一次登录全应用复用；靠滑动 TTL 清理）
  if (!aa && !bksy.ok) {
    throw new MisError(aaError ?? bksy.error ?? '同步失败，请稍后重试', 'upstream')
  }
  return {
    courses: aa?.courses ?? [],
    totalCredits: aa?.totalCredits ?? null,
    semester: aa?.semester ?? { startDate: null, totalWeeks: null, source: null },
    aaError,
    grades,
    bksy
  }
}

/* ---------------- 课表导入（智慧课程平台，默认口径） ---------------- */

export interface BksyTimetableSyncResult {
  /** 可直接交给 /api/courses/import-replace 的课程列表 */
  courses: MisCourse[]
  /** 权威周次表 —— 前端把它写进学期设置，周/月视图据此把日期换算成教学周 */
  weeks: SemesterWeek[]
  /** 周次下拉可选项（教学周 + 放假周）。前端直接用它展示「哪几周放假」 */
  weekOptions: WeekOption[]
  /** 学期第一周的周一（第 1 个教学周的起始日） */
  startDate: string
  /** 教学周总数（有课的最大周号） */
  totalWeeks: number
  /** 抓取失败的周号（网络抖动）；非空时前端应提示数据可能不全 */
  failedWeeks: number[]
  /** 从教务课程列表匹配到学分的课程数 */
  creditHits: number
  /** 教务侧失败原因（拿不到学分时非空）—— 只影响学分，不影响课表 */
  aaError: string | null
}

/**
 * 从「本科生院教学服务平台 → 智慧课程平台 → 课表」抓取整学期课表。
 * 为什么这个**默认**口径：教务（AA）课表只给「第 N 周」这种相对周号，
 * 「第 N 周是哪几天」要靠开学日线性推算 —— 学校一放假（放假周不排课、
 * 也不算教学周），推算就从放假之后整体错位一周。智慧课程平台的课表页直接给出
 * 权威周次表（每周起止日期），周次与日期的对应以它为准，天然没有错位问题。
 * （2026-10-07 ~ 10-14 该平台故障期间前端曾临时默认 AA；2026-10-14 平台恢复，已改回本口径。
 *  服务端两条路由一直并存，此处仅说明「常态默认」。）
 * 学分**仍取自教务**：课表页的每个格子里只有课程名、教师/教室，没有学分
 *
 * 所以顺手用同一个 MIS 会话拉一次 AA 课表页，按课程号把学分对齐过来；
 * 这一步失败只记 `aaError`，课表照常返回 —— 两者互不拖累。
 */
export async function misFetchBksyTimetable(
  sid: string,
  userId: number,
  periods: Period[]
): Promise<BksyTimetableSyncResult> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  /* 1. 教务课表页 —— 只为拿学分（课表格子与课程列表都不含学分以外的信息需求） */
  let creditMap = new Map<string, number>()
  let aaError: string | null = null
  try {
    if (!s.aaLoggedIn) await aaLogin(s)
    const page = await jarFetch(s.jar, `${AA_ORIGIN}/course_selection/courseselecttask/schedule/`)
    if (!page.url.includes(AA_HOST)) throw new MisError('课表页面跳转异常，AA 登录态可能已失效')
    creditMap = parseAaCourseCredits(page.body)
  } catch (err) {
    aaError = err instanceof Error ? err.message : String(err)
  }

  /* 2. 智慧课程平台课表 —— 权威周次 + 逐周网格 */
  if (!s.bksyLoggedIn) {
    await bksySso(s.jar, MIS_ORIGIN)
    s.bksyLoggedIn = true
  }
  if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)
  const tt = await bksyFetchTimetable(s.jar, s.bksySessionId, periods)

  /* 会话保留在池里（2026-10-14 会话池：一次登录全应用复用；靠滑动 TTL 清理） */

  let creditHits = 0
  const courses: MisCourse[] = tt.courses.map((c) => {
    const weeks = c.weeks
    const credits = creditMap.get(c.courseNum) ?? null
    if (credits != null) creditHits++
    return {
      name: c.name,
      teacher: c.teacher || '未知教师',
      location: c.room || '未知地点',
      dayOfWeek: c.dayOfWeek,
      weekStart: weeks[0],
      weekEnd: weeks[weeks.length - 1],
      weekType: weeks.every((w) => w % 2 === 1) ? 'odd' : weeks.every((w) => w % 2 === 0) ? 'even' : 'all',
      weeks,
      startPeriod: c.startPeriod,
      endPeriod: c.endPeriod,
      color: colorFor(c.name),
      credits
    }
  })

  // 第一教学周的起始日即「学期第一周的周一」
  const firstTeaching = tt.weeks.find((w) => w.hasClass)
  const weeksOut: SemesterWeek[] = tt.weeks.map((w) => ({
    week: w.week,
    beginDate: w.beginDate,
    endDate: w.endDate,
    hasClass: w.hasClass
  }))
  return {
    courses,
    weeks: weeksOut,
    weekOptions: listSemesterWeekOptions({
      name: '',
      startDate: firstTeaching?.beginDate ?? '',
      totalWeeks: tt.totalWeeks,
      weeks: weeksOut
    }),
    startDate: firstTeaching?.beginDate ?? '',
    totalWeeks: tt.totalWeeks,
    failedWeeks: tt.failedWeeks,
    creditHits,
    aaError
  }
}

/**
 * 用现有 MIS 会话取成绩单 PDF。
 * 为什么单独一个入口而不是复用 misFetchAll：
 *   成绩单下载是**单域操作**（用户只想下载 PDF），不该顺带拉课表/作业
 *   （那会浪费学校侧额度，也会让下载变慢好几倍）。
 *   但它同样必须复用 MIS 会话 —— 成绩单 URL 需要 AA 登录态。
/* ---------------- 空闲教室（2026-10-14 已下线） ----------------
 * 保留实现仅为过渡期参考；路由已降级为 410、前端入口已移除。
 * 下线原因：实现方向有误 —— 教务真实页面是「教学楼 × 7 天 × 7 节」占用矩阵，
 * （路径含 /timeholdresult/ 段、教学楼用数字 id），此前按「楼/教室/座位」三列
 * 解析、且路径缺段，全部不成立。 */

export interface ClassroomsResult {
  week: number
  period: string
  rooms: Array<{ building: string; room: string; seats: number }>
  truncated: boolean
}

/**
 * 教学楼 ID 到名称表。
 *
 * 教务的空闲教室接口只给数字楼号（`1`、`2`…），页面上不出现楼名，
 * 所以只能硬编码一张表；同时留 `AA_CLASSROOM_BUILDINGS` 环境变量兜底，
 * 拿不到的 ID 会在结果里原样显示 `教学楼#<id>`，不至于丢数据。
 */
const DEFAULT_BUILDINGS: Record<string, string> = {
  '1': '思源楼',
  '2': '逸夫楼',
  '3': '第九教学楼',
  '4': '第八教学楼',
  '5': '第七教学楼',
  '6': '第六教学楼',
  '7': '第五教学楼',
  '8': '第四教学楼',
  '9': '第三教学楼',
  '10': '第二教学楼',
  '11': '第一教学楼',
  '12': '综合实验楼',
  '13': '机械楼',
  '14': '电气楼',
  '15': '土建楼',
  '16': '图书馆'
}

function buildingName(id: string): string {
  const env = (process.env.AA_CLASSROOM_BUILDINGS ?? '').trim()
  if (env) {
    for (const pair of env.split(',')) {
      const [k, v] = pair.split('=')
      if (k?.trim() === id && v?.trim()) return v.trim()
    }
  }
  return DEFAULT_BUILDINGS[id] ?? `教学楼#${id}`
}

/** 解析空闲教室页的表格。列序不固定，靠表头文字定位，找不到就按「楼号/教室/座位」猜。 */
function parseAaClassrooms(html: string): Array<{ building: string; room: string; seats: number }> {
  const $ = cheerio.load(html)
  const out: Array<{ building: string; room: string; seats: number }> = []

  $('table').each((_, table) => {
    const $t = $(table)
    // 先找表头，定位各列下标
    let iBuilding = -1
    let iRoom = -1
    let iSeats = -1
    const headerCells = $t.find('thead tr').first().find('th, td')
    const firstRow = $t.find('tr').first().find('th, td')
    const headSource = headerCells.length ? headerCells : firstRow
    headSource.each((i, el) => {
      const t = $(el).text().replace(/\s+/g, '')
      if (/教学楼|楼名|校区|建筑/.test(t) && iBuilding < 0) iBuilding = i
      else if (/教室|房间|课室/.test(t) && iRoom < 0) iRoom = i
      else if (/座位|容量|人数/.test(t) && iSeats < 0) iSeats = i
    })

    $t.find('tr').each((_, tr) => {
      const tds = $(tr).find('td')
      if (tds.length < 2) return
      const cell = (i: number) => (i >= 0 && i < tds.length ? $(tds[i]).text().replace(/\s+/g, ' ').trim() : '')

      let buildingRaw = cell(iBuilding)
      let room = cell(iRoom)
      const seatsRaw = cell(iSeats)

      // 表头没认出来 → 退化为「第 1 列楼、第 2 列教室」
      if (iBuilding < 0 && iRoom < 0) {
        buildingRaw = cell(0)
        room = cell(1)
      }
      if (!room || !/\d/.test(room)) return

      // 第 1 列可能是「1」这样的 ID，也可能是「思源楼」这样的名字
      const building = /^\d+$/.test(buildingRaw) ? buildingName(buildingRaw) : buildingRaw || '未知教学楼'
      const seats = Number((seatsRaw.match(/\d+/) ?? ['0'])[0]) || 0
      out.push({ building, room, seats })
    })
  })

  return out
}

/** 节次字符串 → 起始小节号（`room_view?zc=&jxlh=` 只要周次，节次由前端过滤/分页） */
function periodLabel(period: string): string {
  return period === 'all' ? '全天' : `第 ${period} 节`
}

const MAX_CLASSROOM_ROWS = 200

/**
 * 查询空闲教室。
 * ⚠️ **不落库、不复用 sync 会话**：教室占用每分钟都在变，缓存会误导用户白跑一趟；
 *   且 sync 是重操作（拉课表+成绩+作业十几秒），为查一间空教室等十几秒是错的交互。
 * ⚠️ 独立超时：教务的教室查询接口偶尔很慢（跨库联查），这里给 8s 上限，
 *   超时就返回"查询超时"而不是让会话一直挂着。
 */
export async function misFetchClassrooms(
  sid: string,
  userId: number,
  week: number,
  period: string
): Promise<ClassroomsResult> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  try {
    if (!s.aaLoggedIn) await aaLogin(s)

    const paths = classroomPaths(week)
    let html: string | null = null
    let hitUrl = ''
    for (const p of paths) {
      let page: FetchResult
      try {
        // 教室查询单独给 8s 上限（教务跨库联查偶尔很慢），失败就换候选路径
        page = await jarFetch(s.jar, `${AA_ORIGIN}${p}`, { signal: AbortSignal.timeout(8000) })
      } catch {
        continue
      }
      if (!page.response.ok || !page.url.includes(AA_HOST)) continue
      html = page.body
      hitUrl = page.url
      break
    }

    if (html === null) {
      throw new MisError('空闲教室页面打开失败，教务系统可能已改版或该功能未开放', 'upstream')
    }
    // 被踢回登录页的特征：最终 URL 里带 login/cas 且正文里有密码框
    if (/login|cas/i.test(hitUrl) && /type=["']password["']/i.test(html)) {
      throw new MisError('教务登录态已失效，请重新走一遍登录流程')
    }

    const all = parseAaClassrooms(html)
    const truncated = all.length > MAX_CLASSROOM_ROWS
    return {
      week,
      period: periodLabel(period),
      rooms: all.slice(0, MAX_CLASSROOM_ROWS),
      truncated
    }
  } finally {
    // 2026-10-14 会话池：不再"用完即销毁"，改为不活跃滑动 TTL 统一清理。
    // （本函数所属的「空闲教室」功能已下架，此段仅为历史代码保留。）
  }
}

/**
 * 首页账户状态：新邮件数 / 校园卡余额 / 校园网余额。
 *
 * `GET {MIS_ORIGIN}/osys_ajax_wrap/`，无参数，只认 MIS 会话（**不需要 AA 跳转**）。
 * 返回的 JSON 由 `parseHomeStatusJson` 严格解析 —— 三字段缺一即抛
 * `HomeStatusParseError`，这里原样向上冒，让路由层转 502 并带上字段名。
 *
 * 为什么不顺手做缓存：上游缓存了（`home_status_v1`），但它是**客户端本地**缓存，
 * 用来离线时保留上一次快照；服务端这边已经有会话池，多一次 HTTP 往返比
 * 教用户"余额没刷新"便宜得多。余额这种东西给旧值比给报错更糟。
 */
export async function misFetchHomeStatus(
  sid: string,
  userId: number
): Promise<{ status: HomeStatus; flags: HomeStatusFlags }> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  const res = await jarFetch(s.jar, `${MIS_ORIGIN}/osys_ajax_wrap/`)
  /* 被踢回登录页时平台会 302 到 SSO，jarFetch 跟随之后正文是 HTML。
     parseHomeStatusJson 会因为"不是 JSON"抛错，但那条文案会误导
     （用户以为是平台坏了）。这里先按最终 URL 判一次会话失效。 */
  if (/\/auth\/|sso\.|cas\./i.test(res.url)) {
    throw new MisError('MIS 登录态已失效，请重新登录')
  }
  if (!res.response.ok) {
    throw new MisError(`学校状态接口返回 ${res.response.status}`, 'upstream')
  }
  const status = parseHomeStatusJson(res.body)
  return { status, flags: homeStatusFlags(status) }
}

/**
 * 空闲教室候选路径。`zc` 是周次（第几周）。
 * 同样支持 `AA_CLASSROOM_PATH` 环境变量覆盖（逗号分隔，`{week}` 占位）。
 */
function classroomPaths(week: number): string[] {
  const env = (process.env.AA_CLASSROOM_PATH ?? '').trim()
  if (env) {
    return env
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.replace('{week}', String(week)))
      .map((p) => (p.startsWith('/') ? p : `/${p}`))
  }
  return [
    `/classroom/room_view/?zc=${week}&jxlh=`,
    `/classroom/room_view/?zc=${week}`,
    `/classroom/room_view/`,
    `/classroom/classroom_view/?zc=${week}`,
    `/classroom/free_room/?zc=${week}`
  ]
}

/**
 * 教室占用整周查询：`GET {AA_ORIGIN}/classroom/timeholdresult/room_view/?zc=&jxlh=&zxjxjhh=`
 *
 * 与 `misFetchClassrooms`（下线的「空闲教室」）的区别 —— 别再走回头路：
 *  - 路径必须带 `/timeholdresult/` 段。旧实现的 `/classroom/room_view/` 缺段，
 *    打开的是别的页面，这就是当时被判「实现方向有误」的直接原因。
 *  - `jxlh` 必须是**数字楼 ID**（见 `OCCUPANCY_BUILDINGS`），传中文楼名只会返回表头。
 *  - 返回的是「教室 × 7 天 × 7 节」占用矩阵，不是「楼/教室/座位」三列。
 *
 * 同一次响应里顺带解析学期下拉（`zxjxjhh`），省一次往返；解析失败不算错误。
 * ⚠️ **不缓存**：占用数据即查即弃，周次/学期一换就完全不同。
 */
export async function misFetchOccupancy(
  sid: string,
  userId: number,
  week: number,
  buildingId: string,
  semesterId?: string
): Promise<{
  week: number
  buildingId: string
  buildingName: string
  rooms: OccupancyRoom[]
  semesters: SemesterOptions | null
}> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')
  if (!Number.isInteger(week) || week < 1 || week > 53) {
    throw new MisError('教学周次超出范围（1-53）')
  }
  if (!isKnownBuildingId(buildingId)) {
    throw new MisError('未知教学楼')
  }

  try {
    if (!s.aaLoggedIn) await aaLogin(s)

    let url = `${AA_ORIGIN}/classroom/timeholdresult/room_view/?zc=${week}&jxlh=${encodeURIComponent(buildingId)}`
    if (semesterId) url += `&zxjxjhh=${encodeURIComponent(semesterId)}`
    url += '&page=1&perpage=500'

    /* 8s 上限：教务这个页面是跨库联查，慢的时候明显比成绩/课表慢。 */
    const page = await jarFetch(s.jar, url, { signal: AbortSignal.timeout(8000) })
    if (!page.response.ok) {
      throw new MisError(`教室占用查询失败（HTTP ${page.response.status}）`, 'upstream')
    }
    /* 会话失效判定与考试一致：最终 URL 掉出 aa 域就是被重定向回登录页了。
       不能只看正文有没有 password 框 —— 教务登录页是独立的 /client/login/。 */
    if (!page.url.includes(AA_HOST)) {
      throw new MisError('教务登录态已失效，请重新登录')
    }

    const { rooms } = parseClassroomOccupancyTable(page.body)
    let semesters: SemesterOptions | null = null
    try {
      semesters = parseSemesterOptions(page.body)
    } catch {
      semesters = null
    }
    return {
      week,
      buildingId,
      buildingName: buildingNameOf(buildingId) ?? buildingId,
      rooms,
      semesters
    }
  } catch (err) {
    if (err instanceof MisError) throw err
    if (err instanceof ClassroomOccupancyParseError) throw err
    throw new MisError(err instanceof Error ? err.message : '教室占用查询失败', 'upstream')
  }
}

/**
 * 教室占用页的学期下拉（`zxjxjhh`）单独预取。
 * 用最小参数打开一次列表页即可 —— 下拉在列表页本身就渲染出来。
 */
export async function misFetchOccupancySemesters(
  sid: string,
  userId: number
): Promise<SemesterOptions> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  if (!s.aaLoggedIn) await aaLogin(s)
  const page = await jarFetch(
    s.jar,
    `${AA_ORIGIN}/classroom/timeholdresult/room_view/?zc=1&jxlh=1&page=1&perpage=5`,
    { signal: AbortSignal.timeout(8000) }
  )
  if (!page.response.ok || !page.url.includes(AA_HOST)) {
    throw new MisError('教务登录态已失效，请重新登录')
  }
  const options = parseSemesterOptions(page.body)
  if (!options) throw new MisError('教室占用页的学期下拉解析失败，教务页面可能已改版', 'upstream')
  return options
}

export async function misFetchReportCard(
  sid: string,
  userId: number,
  lang: 'zh' | 'en'
): Promise<Buffer> {
  cleanupSessions()
  const s = sessions.get(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')

  try {
    if (!s.aaLoggedIn) await aaLogin(s)
    const buf = await fetchReportCardBytes(s.jar, lang)
    return buf
  } catch (err) {
    if (err instanceof MisError) throw err
    throw new MisError(err instanceof Error ? err.message : '成绩单下载失败', 'upstream')
  }
}
