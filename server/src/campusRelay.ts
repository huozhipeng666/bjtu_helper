/**
 * 校园网中继（campus relay）。
 *
 * ## 为什么需要它
 *
 * 物理在线（phyvlab.bjtu.edu.cn / 211.71.70.215）、物理实验（wlsy.bjtu.edu.cn /
 * 59.64.3.37）、演示实验（physpace.bjtu.edu.cn / 211.71.70.193）这三个站点
 * **只对校园网开放**。实测部署机到这三个 IP 的 80/443/8089
 * 全部端口在 TCP 层就被丢弃，域名解析正常、`mis/citel/sso` 等公网站点却可达 ——
 * 说明是学校防火墙按来源 IP 放行，不是我们这边的问题。
 * 学校的 WebVPN（webvpn.bjtu.edu.cn）对这台机器也直接回「当前IP被禁止登录」，
 * 所以「服务器自己想办法连进去」这条路是堵死的。
 *
 * ## 两种出口（2026-10-22 扩展）
 *
 * 1. **设备直连**（`deviceChannels`）：用户手机连在校园网 WiFi 时，由 App 里的原生
 *    HTTP 桥替服务器发这几个请求。手机本来就是请求发起方，不需要任何常开的电脑。
 *    —— **默认路径**，只在「手机在校园网内」时可用（走流量时站点也不可达）。
 * 2. **中继机器**（`machineChannel`）：校园网内一台常开机器跑
 *    `scripts/campus-relay.mjs` 主动连出来取任务。手机在校内外都能用，
 *    但要求那台机器在线（笔记本电脑关机就没了），所以只作兜底。
 *
 * 选择顺序：**设备优先 → 中继机器兜底 → 都没有就明确报错**。
 *
 * 之所以敢让手机排在前面（2026-10-22 早上刚因为「手机在蜂窝网抢走所有任务」
 * 改成机器优先），是因为当天下午补上了两道闸：`probeCampusReachable` 的 6s 探活
 * 和通道级熔断。现在"手机在线"不再等于"手机能访问学校站点"—— 探活一次就能识别出
 * 蜂窝网，把该通道熔断 60s，后面的任务直接跳过它。没有这两道闸，设备优先确实会
 * 把整次快照拖死；有了它们，设备优先只是多花一次 6s 探活。
 *
 * ## 为什么用长轮询而不是 WebSocket
 *
 * 不引入 ws 依赖，nginx 也不用额外配置 Upgrade 头；20~25s 一次的空轮询在
 * `proxy_read_timeout 300s` 下安全。延迟代价（一次取任务多一跳）对
 * 「一次快照十几次请求」的场景可以接受。
 *
 * ## 鉴权
 *
 * - 中继机器：共享密钥 `CAMPUS_RELAY_TOKEN`（环境变量）+ 时间恒定比较；
 * - 设备：走用户自己的登录态（`authenticate`），一个用户只能取自己的任务 ——
 *   否则任意登录用户都能劫持别人的抓取请求。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'

/** 中继机器空闲多久算离线（心跳由 25s 长轮询维持） */
const AGENT_STALE_MS = 70_000
/**
 * 手机出口的空闲判定：手机每 20s 轮询一次，漏掉一轮就当离线。
 * 不能照抄机器的 70s —— 用户退出物理页面后，若还把它当"在线"，
 * 接下来 70 秒内的快照都会白等一个不会有人取的任务。
 */
const DEVICE_STALE_MS = 30_000
/** 单次轮询最长挂起时间 */
const MAX_POLL_WAIT_MS = 30_000
/** 中继机器任务的默认超时（要替我们访问学校站点，给足余量） */
const DEFAULT_TASK_TIMEOUT_MS = 45_000
/**
 * 设备任务的超时。
 *
 * 不能设太小：wlsy 的首次建连实测要 10~17 秒（校园防火墙对首个 SYN 静默丢弃，
 * 靠 TCP 重传才连上），20s 会正好把首次冷连接掐掉，表现为"手机明明取到了数据，
 * 服务端却报出口超时"。40s 留足冷启动余量；真卡死时还有中继机器兜底。
 */
const DEVICE_TASK_TIMEOUT_MS = 40_000
/** 排队上限：一个用户一次快照最多十几跳，超过就是异常 */
const MAX_QUEUE = 200
/**
 * 手机通道数量上限。
 *
 * `deviceChannels` 是「userId → 通道」的常驻 Map，用户只要用过一次手机出口
 * 就会留下一条记录，不设上限的话它是**只增不减**的（进程活多久就存多久）。
 * 单条很小，但它和 `PlatformSessionPool.MAX_SESSIONS` 是同一类问题，
 * 那边有上限、这边没有。超限时先清掉"离线且队列为空"的通道。
 */
const MAX_DEVICE_CHANNELS = 500
/**
 * 手机出口的熔断窗口：**一次**连接层失败就停用这么久。
 *
 * 为什么阈值是 1 而不是 N：手机出口「在线」只代表它在长轮询，跟它能不能访问
 * 学校站点**完全无关**（2026-10-22 那次全体 503 就是这么来的）。用户手机在
 * 蜂窝网上时，每个任务都要挂到原生超时（24s）才失败，而一次快照要好几跳 ——
 * 不熔断的话，一次「拉取失败」要烧掉 24s × N，前端的超时都兜不住，
 * 用户看到的就是那句毫无信息量的「网络请求超时」。
 *
 * 单次误判的代价很小（退回中继机器/直连），漏判的代价是用户干等几分钟，
 * 所以宁可保守。任何一次成功都会立刻清零。
 */
const DEVICE_SUSPECT_MS = 60_000
/**
 * 探活超时。
 *
 * 校园网 WiFi 下这三个站点都很快（实测 wlsy 首字节 <100ms），所以 6 秒足够。
 * 之所以要探活：手机「在线」只代表它在长轮询，**不代表它连得上学校站点**
 * （蜂窝网下照样在线）。不探的话每个任务都要挂到原生超时才失败，
 * 一次快照好几跳，用户要干等一分钟后才看到一句「网络请求超时」。
 */
const PROBE_TIMEOUT_MS = 6_000
/**
 * 探活结果的缓存时长。
 *
 * **成功**的缓存久（60s）：一次快照十几跳，探一次就够，没必要每跳都探。
 * **失败**的缓存很短（3s）：探活失败意味着"你不在校园网里"，而用户接下来
 * 做的事正是「连上校园网 WiFi 然后重试」。失败也缓存一分钟的话，用户连上 WiFi
 * 点重试会继续看到那句"请连接校园网 WiFi"—— 明明已经连了，看起来像功能坏了。
 *
 * 之所以敢设得这么短：探活失败会**立刻抛出**并中止整次请求，所以一次快照里
 * 最多只探一次，不存在"每跳都探"的开销。这里的缓存只是为了挡住客户端的
 * 快速连点，不是为了省探活次数。
 */
const PROBE_OK_TTL_MS = 60_000
const PROBE_FAIL_TTL_MS = 3_000

export interface RelayTask {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 请求体（base64）。**没有请求体时必须整个字段缺失**，不能是 `null`。
   *
   * 踩过的坑（2026-10-22，演示实验 405）：安卓原生桥用
   * `req.optString("bodyB64", "")` 取值，而 Android 自带的 org.json 实现
   * 对 JSON `null` 返回的是**字符串 "null"** 而不是默认值 —— 于是
   * `"null".length() > 0` 成立，桥就去 `setDoOutput(true)` 并写了 3 个字节，
   * 而 `HttpURLConnection.setDoOutput(true)` 会把 **GET 悄悄改成 POST**。
   * 结果：手机出口发出的每一个 GET 都变成了 POST。
   * wlsy（ASP.NET）能容忍 POST，所以物理实验"看起来正常"；
   * 演示实验的 `/phydemo/appointment/` 只认 GET，直接 405。
   *
   * 修法选在服务端而不是桥里：字段缺失时 `optString` 才会走默认值 "",
   * 这样**已经装在用户手机上的旧 APK 也能立刻恢复**，不用等发版。
   */
  bodyB64?: string
  timeoutMs: number
  enqueuedAt: number
}

export interface RelayResult {
  status: number
  headers: Record<string, string | string[]>
  bodyB64: string
  /** 出口本地请求失败时的原因（此时 status 无意义） */
  error?: string
}

interface PendingEntry {
  resolve: (value: RelayResult) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  /** 任务归属（评审 B2）：设备任务 = 派活的 userId；中继任务 = 'machine'。
      settle 时校验，防止任意登录用户回传别人的任务、注入伪造"上游响应"。 */
  owner: number | 'machine'
}

/* ---------------- 出口通道 ---------------- */

/**
 * 一个出口 = 一条任务队列 + 一批等待中的长轮询。
 * 机器中继和每个用户的手机都各是一个通道，逻辑完全相同。
 */
class AgentChannel {
  readonly queue: RelayTask[] = []
  private waiters: Array<() => void> = []
  lastSeenAt = 0
  version = ''
  /**
   * 熔断截止时间；0 = 正常。
   *
   * 两种通道都会用到：手机在蜂窝网下、以及「中继机器放在自己电脑上但其实不在
   * 校园网里」时，通道都是"在线但连不上站点"。不熔断的话每个任务都要挂满
   * 40~45s 才失败，一次快照十几跳直接把用户前端的超时耗光。
   */
  private suspectUntil = 0

  constructor(private readonly staleMs: number = AGENT_STALE_MS) {}

  /** 这个出口是不是刚在连接层栽过（在线但连不上学校站点） */
  get suspect(): boolean {
    return Date.now() < this.suspectUntil
  }

  /** 连接层失败：出口根本没拿到任何 HTTP 响应（蜂窝网、断网、DNS 挂了） */
  recordTransportFailure(): void {
    this.suspectUntil = Date.now() + DEVICE_SUSPECT_MS
  }

  /** 拿到过真实响应 → 立刻解除熔断 */
  recordTransportSuccess(): void {
    this.suspectUntil = 0
  }

  get online(): boolean {
    return this.lastSeenAt > 0 && Date.now() - this.lastSeenAt < this.staleMs
  }

  touch(version?: string): void {
    this.lastSeenAt = Date.now()
    if (version) this.version = version
  }

  push(task: RelayTask): void {
    this.queue.push(task)
    this.wake()
  }

  remove(id: string): void {
    const idx = this.queue.findIndex((t) => t.id === id)
    if (idx >= 0) this.queue.splice(idx, 1)
  }

  private wake(): void {
    while (this.waiters.length > 0 && this.queue.length > 0) this.waiters.shift()?.()
  }

  /** 取一个任务；没有就挂起最多 waitMs */
  async take(waitMs: number): Promise<RelayTask | null> {
    if (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          const idx = this.waiters.indexOf(finish)
          if (idx >= 0) this.waiters.splice(idx, 1)
          finish()
        }, waitMs)
        this.waiters.push(finish)
      })
    }
    return this.queue.shift() ?? null
  }
}

const machineChannel = new AgentChannel()
/** userId → 该用户手机所在通道 */
const deviceChannels = new Map<number, AgentChannel>()
const pending = new Map<string, PendingEntry>()

/** 清掉离线且队列为空的通道（只在超限时调用，避免每次轮询都全表扫） */
function pruneDeviceChannels(): void {
  for (const [id, ch] of deviceChannels) {
    if (!ch.online && ch.queue.length === 0) deviceChannels.delete(id)
  }
}

function deviceChannel(userId: number): AgentChannel {
  let ch = deviceChannels.get(userId)
  if (!ch) {
    if (deviceChannels.size >= MAX_DEVICE_CHANNELS) pruneDeviceChannels()
    ch = new AgentChannel(DEVICE_STALE_MS)
    deviceChannels.set(userId, ch)
  }
  return ch
}

/**
 * 当前请求的发起用户。平台客户端（platformPhyvlab 等）是纯函数、签名里没有 userId，
 * 而「用谁的手机当中转」只有路由层知道 —— 用 AsyncLocalStorage 把这个上下文带下去，
 * 比给十几个函数加参数干净得多。
 */
const transportUser = new AsyncLocalStorage<number>()

export function withTransportUser<T>(userId: number, fn: () => T): T {
  return transportUser.run(userId, fn)
}

export function currentTransportUser(): number | undefined {
  return transportUser.getStore()
}

/* ---------------- 状态 ---------------- */

function relayToken(): string {
  return process.env.CAMPUS_RELAY_TOKEN ?? ''
}

export function isRelayConfigured(): boolean {
  return relayToken().length > 0
}

export function isRelayOnline(): boolean {
  return isRelayConfigured() && machineChannel.online
}

/** 该用户的手机通道是否在线 */
export function isDeviceRelayOnline(userId: number | undefined): boolean {
  if (userId === undefined) return false
  return deviceChannels.get(userId)?.online ?? false
}

/** 当前请求能不能走任一出口 */
export function isAnyRelayOnline(userId: number | undefined): boolean {
  return isDeviceRelayOnline(userId) || isRelayOnline()
}

/**
 * 等一个出口上线（最多 waitMs）。
 *
 * 为什么需要：手机出口是**页面挂载后才开始轮询**的（见 web/src/lib/deviceRelay.ts），
 * 而页面紧接着就会请求快照 —— 两者之间存在一个几百毫秒的窗口：
 * 此刻 `deviceChannels` 里还没有这个用户的通道，`isAnyRelayOnline` 返回 false，
 * 请求会被直接判成「仅限校园网访问」。用户看到的就是"一进页面就失败，刷新一下又好了"。
 *
 * 等一下比直接失败正确得多：真没连校园网的话，最多也就多等这几秒。
 *
 * ## 为什么是 10 秒（2026-10-22 傍晚从 4s 改）
 *
 * 这里的等待不是"技术窗口"，而是**给用户连校园网的时间**：用户往往是点了导入
 * 才被提示"要连校园网"，然后去切 WiFi —— 切网、系统重连、App 重新轮询，
 * 4 秒经常不够，结果就是"刚连上就被告知没连"。10 秒覆盖得住这个动作，
 * 而且只在"一个出口都没有"时才走这条路（真连上了会立刻返回，不会白等）。
 */
export async function waitForAnyRelay(userId: number | undefined, waitMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (isAnyRelayOnline(userId)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return isAnyRelayOnline(userId)
}

export interface ProbeResult {
  ok: boolean
  /** 失败原因（已翻译成人话），成功时为空串 */
  reason: string
}

/** (用户, host) → 探活结果 */
const probeCache = new Map<string, { at: number; result: ProbeResult }>()

/** 探活缓存上限（评审 B6，2026-10-23）：key 为 `userId|host`，与 deviceChannels 同类的
    无界 Map 问题。用户数 × 校内站点数会缓慢增长；到上限时**整表清空**而不是 LRU ——
    缓存 60s 自然重建，一次清空的代价是少量重复探活，不值得为它维护 LRU 结构。 */
const PROBE_CACHE_MAX = 512

/**
 * 探一下「当前这个出口到底能不能访问学校内网站点」。
 *
 * ## 为什么要单独探
 *
 * 出口「在线」和「能访问」是两件事：手机在蜂窝网上时原生桥照样在长轮询，
 * 但到 wlsy / physpace 的 TCP 连接会被校园防火墙静默丢弃 —— 每个任务都要
 * 挂到超时才失败。一次快照要好几跳，用户等一分钟后看到的却是
 * 「网络请求超时，请检查网络连接后重试」，这句话把责任推给了用户的网络，
 * 而真正该做的是**告诉他去连校园网 WiFi**。
 *
 * 这里用一次短超时（6s）的 GET 做探活，失败就立刻抛可执行的提示。
 * 结果按 (用户, host) 缓存 60 秒，所以一次快照的多跳只会探一次。
 */
export async function probeCampusReachable(url: string, userId?: number): Promise<ProbeResult> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return { ok: true, reason: '' }
  }
  const key = `${userId ?? '-'}|${host}`
  const hit = probeCache.get(key)
  if (hit) {
    const ttl = hit.result.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS
    if (Date.now() - hit.at < ttl) return hit.result
  }

  let result: ProbeResult
  try {
    /* force：绕过熔断。
       探活是**唯一**能发现"用户刚从蜂窝网切到校园网 WiFi"的手段 ——
       如果它自己也被熔断挡住，那条通道就再没有解除熔断的机会了，
       用户连上 WiFi 也只能一直看到"请连接校园网 WiFi"。
       代价可控：探活本身只有 6s，而且失败结果只缓存 8s。 */
    const res = await relayFetch({
      url,
      method: 'GET',
      headers: {},
      timeoutMs: PROBE_TIMEOUT_MS,
      userId,
      force: true
    })
    result = isTransportFailure(res) ? { ok: false, reason: `${host} 无响应` } : { ok: true, reason: '' }
  } catch {
    /* 不把 RelayOfflineError 的原话透出去：从用户视角只有一件事要传达 ——
       这个站点现在访问不到。到底是"没出口"还是"出口连不上"，上面
       `assertRelayReachable` 的第二步已经区分过了。 */
    result = { ok: false, reason: `${host} 无响应` }
  }
  if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear()
  probeCache.set(key, { at: Date.now(), result })
  return result
}

/** 仅供测试：清空探活缓存 */
export function resetProbeCacheForTest(): void {
  probeCache.clear()
}

/**
 * 丢掉某个 (用户, host) 的探活结论。
 *
 * 为什么必须有：探活**成功**的缓存是 60 秒，而"出口能访问"是个会变的事实 ——
 * 用户走出宿舍、关掉校园网 WiFi，下一跳就失败。如果此时不把这个 ok 结论作废，
 * 接下来一分钟里每一次请求都会跳过探活、直接派给出口，然后卡满超时才失败；
 * 更糟的是探活（`force`）本来是**唯一**能解除熔断的路径，缓存命中就意味着
 * 它再也不会被调用 —— 用户连回校园网 WiFi 也恢复不了，只能等 60 秒。
 *
 * 所以在任何一次连接层失败之后立刻作废，让下一次请求重新探。
 */
function dropProbeCache(userId: number | undefined, url: string): void {
  try {
    probeCache.delete(`${userId ?? '-'}|${new URL(url).host}`)
  } catch {
    /* URL 解析不了就没有缓存条目，忽略 */
  }
}

export function relayStatus(): {
  configured: boolean
  online: boolean
  lastSeenAt: number
  agentVersion: string
  queued: number
  inflight: number
  devices: number
} {
  return {
    configured: isRelayConfigured(),
    online: machineChannel.online,
    lastSeenAt: machineChannel.lastSeenAt,
    agentVersion: machineChannel.version,
    queued: machineChannel.queue.length,
    inflight: pending.size,
    devices: [...deviceChannels.values()].filter((c) => c.online).length
  }
}

/**
 * 给用户看的「为什么现在拉不到」。
 *
 * 三种情况必须分开说，因为用户的下一步动作完全不同：
 *  - 中继机器离线 → 去把那台机器打开；
 *  - 手机出口连不上学校站点（在蜂窝网上） → 连校园网 WiFi；
 *  - 都没配 → 这是部署问题，不是用户的问题。
 *
 * 混成一句「网络请求超时，请检查网络连接后重试」等于什么都没说 ——
 * 用户会去反复检查自己的 WiFi，而真正的原因在另一头。
 */
export function relayDiagnosis(userId?: number): string {
  const device = userId !== undefined ? deviceChannels.get(userId) : undefined
  if (device?.suspect) {
    return '手机当前网络访问不到学校内网站点，请连接校园网 WiFi 后重试'
  }
  if (device?.online) {
    return '校园网出口暂时不可用，请稍后重试'
  }
  if (isRelayConfigured() && !machineChannel.online) {
    /* 不要在这里再套括号：调用方会把整句放进括号里，套两层读起来像乱码 */
    return '手机出口未就绪、中继机器当前离线，需在 App 内打开本页'
  }
  if (!isRelayConfigured() && !device) {
    return '没有可用的校园网出口，需在 App 内打开本页'
  }
  return '校园网出口暂时不可用，请稍后重试'
}

/** 常量时间比较，避免按字节泄露密钥 */
function tokenMatches(given: unknown): boolean {
  const expected = relayToken()
  if (!expected) return false
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function takeToken(req: Request): string {
  return String(req.header('x-relay-token') ?? (req.body as { token?: string } | undefined)?.token ?? '')
}

/* ---------------- 路由处理器 ---------------- */

/** POST /api/campus-relay/poll —— 中继机器取任务（长轮询） */
export async function campusRelayPoll(req: Request, res: Response): Promise<void> {
  if (!tokenMatches(takeToken(req))) {
    res.status(401).json({ ok: false, error: '中继密钥不正确' })
    return
  }
  const waitMs = Math.min(Number((req.body as { waitMs?: number } | undefined)?.waitMs ?? 25_000) || 25_000, MAX_POLL_WAIT_MS)
  machineChannel.touch(String(req.header('x-relay-version') ?? ''))
  const task = await machineChannel.take(waitMs)
  /* 长轮询结束时再续一次心跳：避免「刚返回就被判定离线」 */
  machineChannel.touch()
  res.json({ ok: true, task })
}

/** POST /api/campus-relay/result —— 中继机器回传结果 */
export function campusRelayResult(req: Request, res: Response): void {
  if (!tokenMatches(takeToken(req))) {
    res.status(401).json({ ok: false, error: '中继密钥不正确' })
    return
  }
  machineChannel.touch()
  settleResult(req, res, 'machine')
}

/** POST /api/campus-relay/device/poll —— App 原生桥取任务（需登录，只能取自己的） */
export async function deviceRelayPoll(req: Request, res: Response, userId: number): Promise<void> {
  const waitMs = Math.min(Number((req.body as { waitMs?: number } | undefined)?.waitMs ?? 20_000) || 20_000, MAX_POLL_WAIT_MS)
  const channel = deviceChannel(userId)
  channel.touch(String(req.header('x-relay-version') ?? 'device'))
  const task = await channel.take(waitMs)
  channel.touch()
  res.json({ ok: true, task })
}

/** POST /api/campus-relay/device/result —— App 原生桥回传结果 */
export function deviceRelayResult(req: Request, res: Response, userId: number): void {
  deviceChannel(userId).touch()
  settleResult(req, res, userId)
}

function settleResult(req: Request, res: Response, owner: number | 'machine'): void {
  const body = (req.body ?? {}) as { id?: string; status?: number; headers?: Record<string, string | string[]>; bodyB64?: string; error?: string }
  const id = String(body.id ?? '')
  const entry = pending.get(id)
  if (!entry) {
    /* 任务已超时、出口还在路上：丢掉即可，不报错（否则出口会一直重试） */
    res.json({ ok: true, ignored: true })
    return
  }
  /* 2026-10-23 修（评审 B2）：结果只认**同一出口**回传 —— 设备任务只能由该 userId
     的设备 settle，中继任务只能由持中继密钥的机器 settle。此前不校验归属，
     任意登录用户都能 settle 他人任务、注入伪造的"上游响应"。
     注意这里不删除 entry：不匹配的回传直接 403，让真正的出口还能正常回包。 */
  if (entry.owner !== owner) {
    res.status(403).json({ ok: false, error: '任务不属于当前出口' })
    return
  }
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve({
    status: Number(body.status ?? 0),
    headers: body.headers ?? {},
    bodyB64: body.bodyB64 ?? '',
    error: body.error
  })
  res.json({ ok: true })
}

/* ---------------- 出口调用 ---------------- */

export class RelayOfflineError extends Error {
  constructor(message = '校园网出口不在线') {
    super(message)
    this.name = 'RelayOfflineError'
  }
}

function enqueue(channel: AgentChannel, task: RelayTask, timeoutMs: number, owner: number | 'machine'): Promise<RelayResult> {
  const promise = new Promise<RelayResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(task.id)
      channel.remove(task.id)
      reject(new RelayOfflineError(`校园网出口响应超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    timer.unref?.()
    pending.set(task.id, { resolve, reject, timer, owner })
  })
  channel.push(task)
  return promise
}

function makeTask(req: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | null
  timeoutMs: number
}): RelayTask {
  const task: RelayTask = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    url: req.url,
    method: req.method,
    headers: req.headers,
    timeoutMs: req.timeoutMs,
    enqueuedAt: Date.now()
  }
  /* ⚠️ 没有请求体时**不要写 bodyB64: null** —— 安卓桥的 optString 会把
     JSON null 读成字符串 "null"，进而 setDoOutput(true)，把 GET 变成 POST。
     详见 RelayTask.bodyB64 的注释。 */
  if (req.body) task.bodyB64 = Buffer.from(req.body, 'utf8').toString('base64')
  return task
}

/**
 * 中继回传的结果是不是「连接层失败」——即出口根本没拿到任何 HTTP 响应。
 *
 * 典型来源：手机切到蜂窝网、校园网断线、出口那台机器的 DNS 挂了。
 * 这种结果**不能**当成站点自己的应答往下传（否则会被解析成"页面结构变了"
 * 这类误导性错误），而应该换另一个出口再试。
 */
function isTransportFailure(res: RelayResult): boolean {
  return !!res.error || !(res.status > 0)
}

/**
 * 通过校园网出口发一次请求（不跟随重定向：跳转由 platformFetch 逐跳处理）。
 * 出口只搬字节，不解释内容。
 *
 * ## 出口顺序：**设备优先**，中继机器兜底
 *
 * 产品上的理由：这三个站点只对校园网开放，而**用户自己就连在校园网里**。
 * 手机出口是「离学校最近的一跳」，也不依赖任何一台常开电脑 —— 用户把笔记本
 * 关机、或者干脆没跑 `campus-relay.mjs` 时，功能仍然可用。
 *
 * 工程上的风险（手机在蜂窝网却仍然"在线"，把任务全抢走）由两道闸挡住，
 * 见文件头注释：`probeCampusReachable` 先花 6s 探活，探不通就把该通道熔断 60s。
 * 因此设备优先的代价上限是「每 60 秒多花一次 6s 探活」，不是「每个任务 40s」。
 *
 * 两个方向都做降级：设备取任务超时或连接层失败 → 换中继机器；
 * 中继机器失败 → 如实报错（此时已经没有第三个出口了）。
 */
export async function relayFetch(req: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | null
  timeoutMs?: number
  userId?: number
  /**
   * 忽略熔断状态，强行派活。
   *
   * 只给探活（`probeCampusReachable`）用：熔断是"别再浪费 40s"的优化，
   * 而探活是唯一能发现"用户刚从蜂窝网切到校园网 WiFi"的手段。两者撞在一起时，
   * 必须让探活赢 —— 否则通道永远解除不了熔断。
   */
  force?: boolean
}): Promise<RelayResult> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const userId = req.userId ?? currentTransportUser()
  const device = userId !== undefined ? deviceChannels.get(userId) : undefined

  /**
   * 出口是否可派活。`suspect` = 刚在连接层栽过，60s 内不再碰它 ——
   * 这是「设备优先」不重演 2026-10-22 那次全体 503 的关键。
   */
  const deviceReady = !!device?.online && (req.force || !device.suspect)
  const machineReady = (): boolean =>
    isRelayConfigured() &&
    machineChannel.online &&
    (req.force || !machineChannel.suspect) &&
    machineChannel.queue.length < MAX_QUEUE

  if (!deviceReady && !machineReady()) {
    /* 分两种文案：压根没有出口 vs 两个出口都刚失败过（后者才是"连不上站点"） */
    const tripped = (device?.suspect ?? false) || machineChannel.suspect
    throw new RelayOfflineError(
      tripped ? '校园网出口刚才连不上学校站点，已暂时停用' : '没有可用的校园网出口'
    )
  }

  let deviceErr: unknown = null
  let machineErr: unknown = null

  /**
   * 记一次连接层失败：熔断该通道 + 作废探活缓存。
   *
   * 两件事必须一起做。只熔断不作废缓存的话，探活结论还是 60 秒前的"能访问"，
   * 下一次请求会跳过探活直接派活，而探活（`force`）正是唯一能解除熔断的路径 ——
   * 用户连回校园网也恢复不了（见 `dropProbeCache` 的注释）。
   */
  const markFailure = (ch: AgentChannel): void => {
    ch.recordTransportFailure()
    dropProbeCache(userId, req.url)
  }

  /* ① 用户自己的出口优先 */
  if (deviceReady && device) {
    const t = Math.min(timeoutMs, DEVICE_TASK_TIMEOUT_MS)
    try {
      const res = await enqueue(device, makeTask({ ...req, timeoutMs: t }), t, userId!)
      if (!isTransportFailure(res)) {
        device.recordTransportSuccess()
        return res
      }
      /* 拿到回包但 status<=0 / 带 error = 出口自己没连上，熔断它 */
      markFailure(device)
      deviceErr = new RelayOfflineError(`手机出口连不上学校站点（${res.error ?? `status ${res.status}`}）`)
    } catch (err) {
      deviceErr = err
      markFailure(device)
    }
  }

  /* ② 中继机器兜底。重新判定一次：设备那边可能刚花掉几十秒，
     期间机器可能刚好上线（或刚好被熔断）。 */
  if (machineReady()) {
    try {
      const res = await enqueue(machineChannel, makeTask({ ...req, timeoutMs }), timeoutMs, 'machine')
      if (!isTransportFailure(res)) {
        machineChannel.recordTransportSuccess()
        return res
      }
      markFailure(machineChannel)
      machineErr = new RelayOfflineError(`中继机器连不上学校站点（${res.error ?? `status ${res.status}`}）`)
    } catch (err) {
      machineErr = err
      markFailure(machineChannel)
    }
  }

  /* 两边都试过：优先报设备的错 —— 它更能说明用户该做什么（"连校园网 WiFi"），
     而机器的错往往只是"那台电脑没开"，对用户没有可操作性。 */
  throw deviceErr ?? machineErr ?? new RelayOfflineError('校园网出口都不可用')
}

/** 仅供测试：清空所有通道状态 */
export function resetCampusRelayForTest(): void {
  machineChannel.queue.length = 0
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new RelayOfflineError('中继已重置'))
  }
  pending.clear()
  machineChannel.lastSeenAt = 0
  machineChannel.version = ''
  deviceChannels.clear()
  probeCache.clear()
}
