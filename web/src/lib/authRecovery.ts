/**
 * 启动鉴权失败时的恢复策略（纯函数，便于离线回归）。
 *
 * ## 这个文件要解决的问题
 *
 * 原来的启动逻辑是这样的：
 *
 * ```ts
 * const token = getToken()
 * if (token) {
 *   try { setUser((await me()).user); return }
 *   catch { clearToken() }        // ← 一把抓
 * }
 * await ensureGuestSession()      // 拿不到就落到登录页
 * ```
 *
 * `catch {}` 会把**所有**失败都当成"登录已失效"：
 *   - 401  → 确实是凭据无效，清掉并引导重登是对的；
 *   - 429  → 被限流（校园网整栋楼共用一个出口 IP，很容易触发），过几分钟就好了；
 *   - 5xx  → 服务端临时故障；
 *   - 断网 / 超时 / 请求被取消 → 纯粹的网络问题。
 *
 * 后三种情况下清 token 是**破坏性的错误**：用户的登录凭据本来好好的，
 * 却被本地抹掉了，而且他无法自愈 —— 重新打开页面仍然是登录页，只能重新输密码
 * （本校学生用的是学号 + 教务密码，很多人根本不记得）。
 * 更糟的是清完 token 后前端会去建游客号，而游客建号有 per-IP 配额，
 * 在校园网 NAT 下往往已经被用满 → 于是连"游客可用"这条退路也断了，直接甩到登录页。
 *
 * 所以规则只有一条：**只有 401 才清 token，其余一律保留并让用户重试。**
 */

/** 启动失败的处置方式 */
export type BootFailureAction =
  /** 凭据确实无效（401）：清掉本地 token，交给登录/游客流程 */
  | 'clear-token'
  /** 暂时性失败（限流 / 服务端故障 / 网络）：**保留** token，提示重试 */
  | 'keep-token'

/** 把任意异常归一成 HTTP 状态码；拿不到响应记为 0 */
export function statusOf(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number' && Number.isFinite(s)) return s
  }
  return 0
}

/**
 * 启动时 `me()` 失败后该怎么处理本地 token。
 *
 * @param status HTTP 状态码；0 表示请求没拿到响应（断网/超时/被取消）
 */
export function decideBootFailure(status: number): BootFailureAction {
  return status === 401 ? 'clear-token' : 'keep-token'
}

/**
 * 给用户看的主文案：只说**这次为什么没成功**。
 *
 * 刻意不在这里重复"登录没丢" —— 那句话由下面的 BOOT_REASSURANCE 单独承担，
 * 两处都写会在错误页上连出两句意思相同的话，读起来像机器人复读。
 */
export function bootFailureMessage(status: number): string {
  if (status === 429) return '当前访问人数较多（或网络受限），请稍后重试。'
  if (status >= 500) return '服务器暂时不可用，请稍后重试。'
  if (status === 0) return '网络连接失败，请检查网络后重试。'
  return '加载失败，请稍后重试。'
}

/**
 * 错误页上的安抚文案。
 *
 * 为什么必须单独有一句：用户看到"加载失败"时的第一反应是"我是不是被登出了 / 账号没了"，
 * 而旧版实现**确实**会把他登出（见本文件顶部的事故说明）。
 * 明确告诉他凭据还在，他才会去点「重试」而不是慌忙重新注册。
 */
export const BOOT_REASSURANCE = '你的账号与登录状态都还在，只是这一次请求没成功。'

/** 默认重试次数：3 次（首次 + 两次重试） */
const DEFAULT_ATTEMPTS = 3
/** 退避步长：600ms、1200ms —— 覆盖一次服务重启（约 1~3 秒）即可，不做长等待 */
const DEFAULT_BACKOFF_MS = 600

/**
 * 对**暂时性**失败做有限重试。
 *
 * 为什么需要：每次发布都会重启服务，期间约 1~3 秒连接被拒。
 * 恰好在这个窗口里打开页面的用户，`me()` 会以网络错误失败 —— 如果没有重试，
 * 他就会看到失败页（旧实现更糟：直接被登出）。有了这层退避，
 * 一次正常发布对用户就是完全无感的。
 *
 * 明确**不重试**的两类：
 *   - 401：凭据真的无效，重试一万次也不会变；
 *   - 429：已经在被限流了，立刻重试只会让情况更糟，应该让用户稍后再来。
 *
 * @param fn    要执行的请求
 * @param opts  attempts / backoffMs / sleep 可注入，便于用假时钟做离线回归
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number
    backoffMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS)
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = statusOf(err)
      if (status === 401 || status === 429) throw err
      if (i < attempts - 1) await sleep(backoffMs * (i + 1))
    }
  }
  throw lastErr
}
