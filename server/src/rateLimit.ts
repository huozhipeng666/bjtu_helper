/**
 * 滑动窗口限流（进程内）。
 *
 * 为什么要有这个东西：项目的敏感接口（登录、验证码签发）如果不限流，
 * 既可以被用来撞库，也可以被用来放大成 DoS——尤其当接口内部有 CPU 密集操作时。
 *
 * 设计取舍：
 *  - **进程内 Map**，不引第三方依赖、不做分布式计数。本项目单进程部署，够用；
 *    若将来多实例，需要换成共享存储（Redis）或按实例数折算阈值。
 *  - 提供 `hit` / `isBlocked` / `reset` 三个动作而不是单一 `allowed`，
 *    是为了支持「只在**失败**时计数」这种语义：登录成功要 reset，失败才 hit。
 *    若只有「每次调用都计数」，正常用户频繁登录也会被误伤。
 *  - 惰性清扫（Map 超过阈值时清理过期 key），避免长期运行内存增长。
 */

/** 超过这个 key 数量时触发一次过期清扫 */
const SWEEP_THRESHOLD = 5000

export interface SlidingWindowLimiter {
  /** 记一次调用，返回「本次是否仍在上限内」（false = 应拒绝） */
  hit(key: string): boolean
  /** 只查询不计数：当前是否已被限流 */
  isBlocked(key: string): boolean
  /** 清空某个 key 的计数（如登录成功后） */
  reset(key: string): void
  /** 当前跟踪的 key 数量（供日志/排查用） */
  readonly size: number
}

export function makeSlidingWindowLimiter(windowMs: number, max: number): SlidingWindowLimiter {
  const hits = new Map<string, number[]>()

  const prune = (now: number, arr: number[]): number[] => arr.filter((t) => now - t < windowMs)

  const sweep = (now: number) => {
    if (hits.size <= SWEEP_THRESHOLD) return
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k)
    }
  }

  return {
    hit(key: string): boolean {
      const now = Date.now()
      const arr = prune(now, hits.get(key) ?? [])
      arr.push(now)
      hits.set(key, arr)
      sweep(now)
      return arr.length <= max
    },
    isBlocked(key: string): boolean {
      const now = Date.now()
      const arr = prune(now, hits.get(key) ?? [])
      if (arr.length === 0) hits.delete(key)
      else hits.set(key, arr)
      return arr.length >= max
    },
    reset(key: string): void {
      hits.delete(key)
    },
    get size(): number {
      return hits.size
    }
  }
}

/**
 * 「计数数组」Map 的惰性清扫（供手写的 `Map<K, number[]>` 限流器复用）。
 *
 * 为什么需要它：`makeSlidingWindowLimiter` 自带清扫，但项目里还有几处手写的计数 Map
 * （`ocrHits` 按用户、`misHits` 按 IP/用户），它们每来一个**新 key** 就多一条永久驻留的记录。
 * 限流键里天然含有 IP —— 校园网 NAT 一天几万个出口，再加扫描器，一个月就能攒出几十万条
 * 空数组。这类"只增不减"的状态是最不容易被发现的内存泄漏（页面不慢、只是 RSS 一直涨，
 * 直到 OOM 被系统杀掉）。
 *
 * 实现刻意做成**原地复用**：只删除窗口内已无记录的键，不重建 Map。
 * 只在 `size > threshold` 时触发，避免每次请求都做 O(n) 扫描。
 *
 * @returns 被删掉的键数量（供测试断言）
 */
export function sweepCounterMap<K>(
  map: Map<K, number[]>,
  windowMs: number,
  now: number = Date.now(),
  threshold: number = SWEEP_THRESHOLD
): number {
  if (map.size <= threshold) return 0
  let removed = 0
  for (const [k, arr] of map) {
    /* 数组里只要有一条落在窗口内就保留；空数组/全过期就删 */
    if (arr.every((t) => now - t >= windowMs)) {
      map.delete(k)
      removed++
    }
  }
  return removed
}

/**
 * 「广度」追踪器：统计每个来源在窗口内**触达过多少个不同的对象**。
 *
 * 用途（本项目）：识别撞库。撞库的真实形态是沿账号列表横滚——每个账号只试一两次，
 * 所以"单账号失败次数"这个指标永远不触发，唯一能暴露它的是
 * "**失败横跨了多少个不同账号**"。这个指纹对共用出口（NAT）无害
 * （正常人的失败只集中在自己的号上），对撞库极敏感。
 *
 * 与 `makeSlidingWindowLimiter` 的关键差别：后者统计**次数**，
 * 本函数统计**去重后的对象个数**，因此必须保留"每个对象最近一次出现的时间"，
 * 才能随窗口自然过期。
 *
 * ⚠️ 实现上**必须让计数随窗口过期**（这里用 Map<对象, 最近时间> 每次调用时裁剪）。
 *    曾经用 `Set` 实现，而 Set 只能加不能减 —— 等于给每个来源攒了一份
 *    **永不过期**的黑名单：一个 NAT 出口只要历史累计触达过 N 个不同账号，
 *    就被永久挡在门外。这类"只增不减"的状态是限流器最容易出的 bug。
 *
 * `now` 可注入，便于单测在不等待真实时间的前提下验证过期行为。
 */
export interface FanoutTracker {
  /** 记一次"某来源触达了某对象"，返回本次是否仍在上限内（false = 应拒绝） */
  hit(source: string, subject: string, now?: number): boolean
  /** 某来源当前窗口内触达的不同对象数（供测试/排查） */
  distinct(source: string, now?: number): number
  /** 清掉所有足迹已空的来源条目，避免 Map 无限增长（定时调用） */
  sweep(now?: number): number
  /** 当前跟踪的来源数量 */
  readonly size: number
}

export function makeFanoutTracker(limit: number, windowMs: number): FanoutTracker {
  const footprints = new Map<string, Map<string, number>>()

  /** 裁掉窗口外的对象记录（原地修改），返回同一份 Map 便于链式使用 */
  const prune = (fp: Map<string, number>, now: number): Map<string, number> => {
    for (const [subject, t] of fp) {
      if (now - t >= windowMs) fp.delete(subject)
    }
    return fp
  }

  return {
    hit(source: string, subject: string, now: number = Date.now()): boolean {
      const fp = footprints.get(source) ?? new Map<string, number>()
      prune(fp, now)
      fp.set(subject, now)
      footprints.set(source, fp)
      /* 本次计入后超限也要拦（`<=` 而非 `<`），否则攻击者能多放行一票 */
      return fp.size <= limit
    },
    distinct(source: string, now: number = Date.now()): number {
      const fp = footprints.get(source)
      if (!fp) return 0
      return prune(fp, now).size
    },
    sweep(now: number = Date.now()): number {
      let removed = 0
      for (const [source, fp] of footprints) {
        if (prune(fp, now).size === 0) {
          footprints.delete(source)
          removed++
        }
      }
      return removed
    },
    get size(): number {
      return footprints.size
    }
  }
}
