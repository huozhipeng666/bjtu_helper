/**
 * 手机端「校园网出口」（设备直连）。
 *
 * ## 解决什么问题
 *
 * 物理在线 / 物理实验 / 演示实验这三个站点**只对校园网开放**，而服务器在公网机房，
 * 直连会被学校防火墙丢包（详见 server/src/campusRelay.ts）。手机连在校园网 WiFi 时
 * 本来就能访问它们 —— 但网页里直接 fetch 会被 CORS 挡住（读不到响应体）。
 *
 * 所以让 **App 的原生层** 代发这些请求：`window.BjtuNet.fetch()`（见
 * android-shell 的 BjtuNetBridge.java）。原生 HTTP 没有同源策略，拿到的字节原样
 * 回传给服务端解析 —— 解析逻辑仍然只有一份，留在服务端。
 *
 * ## 协议
 *
 * 服务端把「要访问哪个 URL」放进这位用户的任务队列，这里长轮询取任务：
 *   POST /api/campus-relay/device/poll   → { task: { id, url, method, headers, bodyB64 } | null }
 *   （原生发请求，回传 status / headers / bodyB64）
 *   POST /api/campus-relay/device/result → { ok }
 *
 * 只在这个用户打开三个物理页面时轮询，离开页面就停 —— 不做常驻心跳，
 * 因为一个 20s 的长轮询连接对手机电量和服务端连接数都不是白给的。
 *
 * ## 没有原生桥时
 *
 * 浏览器 / 小程序里没有 `window.BjtuNet`，`startDeviceRelay()` 直接返回空函数，
 * 服务端自然退回到「中继机器」或直连，不影响其他功能。
 */
import { request } from '../api'

/** 与服务端 MAX_POLL_WAIT_MS 对齐；留出网络余量给 request 的 25s 超时 */
const POLL_WAIT_MS = 20_000
/** 原生单次请求超时（服务端那边是 20s，这里略长，避免两边同时掐断） */
const NATIVE_TIMEOUT_MS = 24_000

export interface RelayTask {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 没有请求体时服务端**不会发这个字段**（不是 null）。
   * 原因见 server/src/campusRelay.ts 的 RelayTask.bodyB64：
   * 安卓桥的 optString 会把 JSON null 读成字符串 "null"，进而 setDoOutput(true)，
   * 把 GET 变成 POST —— 演示实验的预约页因此 405。
   */
  bodyB64?: string | null
  timeoutMs: number
}

interface NativeResult {
  status: number
  headers: Record<string, string | string[]>
  bodyB64: string
  error?: string
}

interface NativeNet {
  fetch(reqJson: string): void
}

/** 等待原生回包的 promise 表 */
const pending = new Map<string, (res: NativeResult) => void>()

/** 原生桥是否可用（只有 App 里有） */
export function hasNativeNet(): boolean {
  const net = (window as unknown as { BjtuNet?: NativeNet }).BjtuNet
  return !!net && typeof net.fetch === 'function'
}

function installResultHook(): void {
  const w = window as unknown as { __bjtuNetResult?: (id: string, json: string) => void }
  if (w.__bjtuNetResult) return
  w.__bjtuNetResult = (id: string, json: string) => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    try {
      resolve(JSON.parse(json) as NativeResult)
    } catch {
      resolve({ status: 0, headers: {}, bodyB64: '', error: '原生返回的内容无法解析' })
    }
  }
}

/** 调原生发一次请求 */
function nativeFetch(req: Omit<RelayTask, 'id' | 'timeoutMs'>, taskTimeoutMs: number): Promise<NativeResult> {
  return new Promise<NativeResult>((resolve, reject) => {
    const net = (window as unknown as { BjtuNet?: NativeNet }).BjtuNet
    if (!net) {
      reject(new Error('原生网络桥不可用'))
      return
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    /* 按服务端给这个任务的超时来掐，而不是一律等满 24s：
       服务端做"能不能访问学校站点"的探活时只给 6s，这里也应当在 6s 就放弃，
       否则手机还在傻等、服务端早已判失败，下一次轮询又会领到新任务。 */
    const limit = Math.max(1_000, Math.min(taskTimeoutMs || NATIVE_TIMEOUT_MS, NATIVE_TIMEOUT_MS))
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('原生请求超时'))
    }, limit)
    pending.set(id, (res) => {
      clearTimeout(timer)
      resolve(res)
    })
    try {
      net.fetch(JSON.stringify({ id, ...req, timeoutMs: limit }))
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * 轮询代次。每次 `startDeviceRelay` 自增一次，循环体里比对 `gen === generation`，
 * 一旦不等就退出 —— 这就是「停止」的唯一机制。
 *
 * ⚠️ 不要改回「一个全局 running 布尔量 + 每次 start 返回自己的 stop 闭包」的写法：
 *    旧实现里 stop() 只置闭包内的标志，而 running 要等那个 20s 长轮询返回、
 *    循环退出之后才复位。于是「物理实验页 → 演示实验页」这种切换会走到：
 *      cleanup 调 stop() → running 仍是 true → 新页面的 start() 命中
 *      `if (running) return () => {}` 拿到空函数 → 旧循环随后退出把 running 置 false
 *      → 结果没有任何人在轮询，而新组件的 effect 已经跑完、不会重跑。
 *    表现是「手机出口静默停摆」，三个物理平台退回中继机器/直连。
 */
let generation = 0

/**
 * 开始为当前用户跑设备出口。返回停止函数（在组件卸载时调用）。
 *
 * 可以并发调用（多个页面同时挂载时）：每个调用有自己的代次，停止只影响自己那一代，
 * 后来的调用会顶掉前一代，因此永远只有一个循环在真正轮询。
 */
export function startDeviceRelay(): () => void {
  if (!hasNativeNet()) return () => {}
  installResultHook()
  const gen = ++generation

  void (async () => {
    while (gen === generation) {
      let task: RelayTask | null = null
      try {
        const r = await request<{ ok: boolean; task: RelayTask | null }>('/api/campus-relay/device/poll', {
          method: 'POST',
          body: JSON.stringify({ waitMs: POLL_WAIT_MS }),
          timeoutMs: POLL_WAIT_MS + 8_000
        })
        task = r.task ?? null
      } catch {
        /* 网络抖动 / 未登录：歇一下再来，不要把循环打成忙等 */
        await new Promise((r) => setTimeout(r, 3_000))
        continue
      }
      /* 拿到任务就一定要跑完并回传结果，哪怕此刻已经"停止"了：
         丢下一个已取走的任务会让服务端白等 40s 超时才降级到中继机器，
         而这一跳其实几百毫秒就能完成。停止判定只放在循环顶部。 */
      if (!task) continue

      let result: NativeResult & { id: string }
      try {
        const res = await nativeFetch(
          {
            url: task.url,
            method: task.method,
            headers: task.headers,
            bodyB64: task.bodyB64
          },
          task.timeoutMs
        )
        result = { ...res, id: task.id }
      } catch (err) {
        result = {
          id: task.id,
          status: 0,
          headers: {},
          bodyB64: '',
          error: err instanceof Error ? err.message : String(err)
        }
      }
      try {
        await request('/api/campus-relay/device/result', {
          method: 'POST',
          body: JSON.stringify(result)
        })
      } catch {
        /* 结果送不回去就让服务端超时降级到中继机器，不在这里重试 */
      }
    }
  })()

  return () => {
    /* 只作废自己那一代：若期间已经有更新的调用，它会把代次顶得更高，
       这里再自增也不会误伤新循环（新循环的 gen 更大，比对依然成立） */
    if (gen === generation) generation++
  }
}
