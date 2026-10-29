/**
 * 教室人数评估（第三方公开接口）。
 *
 * ## 为什么这个功能能"复活"
 *
 * 2026-10-14 下线的「空闲教室」走的是**教务**的教室占用矩阵（`/timeholdresult/`，
 * 需要真实登录态、教学楼用数字 id、页面是 50 列宽表），当时无法联调于是整块下架。
 * 那是**另一个**功能：查"哪个教室这节点名有课"。
 *
 * 这里接的是 v1.8.5 上游用的第三方接口 `http://yaya.csoci.com:2333/api/classnum/`，
 * 语义完全不同：查"这栋楼各个教室现在**实际有多少人**"（由第三方轮询教室里的
 * 网络设备估算）。**免登录、无凭据、不碰学校会话** —— 本机实测 11 栋教学楼
 * 全部 200 返回真实数据（2026-10-20 20:18–20:23）。
 *
 * ## 安全边界（照抄上游的克制）
 *
 * 1. **只允许精确 origin** `http://yaya.csoci.com:2333`。明文 HTTP 没有 TLS，
 *    重定向是最容易被利用的面：中间人可以把响应 302 到任意主机，如果我们
 *    跟随重定向再检查 finalUrl，攻击者已经拿到了一次明文会话上下文。
 *    所以这里**不跟随重定向**（`redirect: 'manual'`），3xx 直接判定失败。
 * 2. **不共享学校会话**：本模块不 import 任何 MIS 相关代码，也不传 Cookie。
 *    `yaya` 侧拿不到任何能关联到学号的信息 —— 请求里只有教学楼中文名。
 * 3. **不缓存**：数据是「最近一次轮询窗口内」的快照，缓存等于给用户看假数据。
 *    上游同样明确不缓存（见 `ClassroomRepository.kt` 注释）。
 *
 * ## 响应结构
 *
 * ```json
 * { "time": ["2026-10-20 20:18:06", "2026-10-20 20:18:21"],
 *   "data": [["202", 12.12, 4, 33], ...] }
 * ```
 * `data` 每行 = `[教室名, 使用率百分比, 已用人数, 容量]`。
 * 使用率是**百分比数值**（0.39 表示 0.39%），与 `已用/容量` 不等价
 * （第三方按自己的口径算），所以展示保留原值、排序与筛选一律用 used/capacity。
 */

const CLASSROOM_ORIGIN = 'http://yaya.csoci.com:2333'
const CLASSROOM_PATH = '/api/classnum/'
/** 第三方接口偶发慢（实测最慢一栋 ~1.4s），给 8s 足够；再久就是挂了 */
const FETCH_TIMEOUT_MS = 8_000

/**
 * 教学楼清单 —— 与上游 `domain/classroom/Classroom.kt` 的 `CLASSROOM_BUILDINGS`
 * 逐字一致（11 栋）。顺序是学校习惯顺序，不是字典序，**不要重排**：
 * 用户在原生 App 里记住的是这个顺序，改了会让人找不着。
 *
 * 注意：这些名字是直接拼进 URL 查询参数的，必须 `encodeURIComponent`。
 */
export const CLASSROOM_BUILDINGS: readonly string[] = [
  '第十七号教学楼',
  '思源楼',
  '思源西楼',
  '思源东楼',
  '第九教学楼',
  '第八教学楼',
  '第五教学楼',
  '逸夫教学楼',
  '机械楼',
  '东区二教',
  '东区一教'
]

export interface ClassroomRoom {
  /** 教室名（如 `SY101`、`东102`、`中心报告厅`） */
  name: string
  /** 已用人数 */
  used: number
  /** 容量（座位数） */
  capacity: number
  /** 第三方给的使用率百分比（0–100）。仅展示用，不参与排序 */
  usagePercent: number
}

export interface ClassroomBuildingInfo {
  building: string
  /** 数据轮询窗口起（第三方原样字符串，如 `2026-10-20 20:18:06`，不解析时区） */
  effectiveStart: string
  /** 数据轮询窗口止 */
  effectiveEnd: string
  rooms: ClassroomRoom[]
}

/** 教室列表解析失败（结构不符合预期）——与网络失败区分开，文案不同 */
export class ClassroomParseError extends Error {}

/** 已知教学楼校验：只接受清单内的名字，杜绝"任意字符串当查询参数" */
export function isKnownBuilding(name: string): boolean {
  return CLASSROOM_BUILDINGS.includes(name)
}

/**
 * 严格解析响应。任一字段类型不对 → 抛 ClassroomParseError。
 *
 * 为什么要"严格"而不是尽量兜住：这个接口是第三方在维护，字段一旦变形，
 * 半解析出来的数据（比如 used 变成 0）看起来完全正常，用户会当成真的
 * "教室空了"直接白跑一趟。宁可明确报"数据格式异常"。
 *
 * 与上游 `ClassroomJsonParser.kt` 的判定一致：`data[i]` 必须是长度 ≥ 4 的数组，
 * `[0]` 非空字符串、`[1]` 数字、`[2]`/`[3]` 整数。
 */
export function parseClassroomJson(building: string, body: string): ClassroomBuildingInfo {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    throw new ClassroomParseError('教室人数接口返回的不是 JSON，可能已被网络中间人改写')
  }
  if (!root || typeof root !== 'object') throw new ClassroomParseError('教室人数数据格式异常（根节点）')
  const obj = root as Record<string, unknown>

  const time = obj.time
  if (!Array.isArray(time) || time.length < 2) throw new ClassroomParseError('教室人数数据格式异常（时间窗口）')
  const effectiveStart = typeof time[0] === 'string' ? time[0] : ''
  const effectiveEnd = typeof time[1] === 'string' ? time[1] : ''
  if (!effectiveStart || !effectiveEnd) throw new ClassroomParseError('教室人数数据格式异常（时间窗口）')

  if (!Array.isArray(obj.data)) throw new ClassroomParseError('教室人数数据格式异常（教室列表）')

  const rooms: ClassroomRoom[] = []
  for (const raw of obj.data) {
    if (!Array.isArray(raw) || raw.length < 4) throw new ClassroomParseError('教室人数数据格式异常（教室行）')
    const name = typeof raw[0] === 'string' ? raw[0].trim() : ''
    if (!name) throw new ClassroomParseError('教室人数数据格式异常（教室名）')
    const usagePercent = typeof raw[1] === 'number' && Number.isFinite(raw[1]) ? raw[1] : NaN
    const used = typeof raw[2] === 'number' && Number.isInteger(raw[2]) ? raw[2] : NaN
    const capacity = typeof raw[3] === 'number' && Number.isInteger(raw[3]) ? raw[3] : NaN
    if (Number.isNaN(usagePercent) || Number.isNaN(used) || Number.isNaN(capacity)) {
      throw new ClassroomParseError('教室人数数据格式异常（数值字段）')
    }
    rooms.push({ name, used, capacity, usagePercent })
  }

  return { building, effectiveStart, effectiveEnd, rooms }
}

/**
 * 拉取某栋教学楼的人数和。**不缓存**。
 *
 * 失败语义：
 *  - 网络不可达 / 超时 → 抛错（文案提示第三方接口可能挂了）
 *  - 3xx → 抛错（安全边界：明文接口不允许重定向）
 *  - 非 2xx → 抛错
 *  - 结构异常 → ClassroomParseError
 */
export async function fetchClassroomCapacity(building: string): Promise<ClassroomBuildingInfo> {
  if (!isKnownBuilding(building)) {
    throw new ClassroomParseError(`未知教学楼：${building}`)
  }
  const url = `${CLASSROOM_ORIGIN}${CLASSROOM_PATH}?building=${encodeURIComponent(building)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json;q=0.9,*/*;q=0.5' },
      /* 关键：不跟随重定向。明文接口 + 重定向 = 中间人可把请求引到任意主机 */
      redirect: 'manual',
      signal: controller.signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('教室人数接口响应超时，请稍后重试')
    }
    throw new Error('教室人数接口无法访问（第三方服务可能已下线，或当前网络屏蔽了明文 HTTP）')
  } finally {
    clearTimeout(timer)
  }

  /* redirect:'manual' 下 3xx 会以 opaqueredirect（status 0）或 3xx 返回，
     两种都必须拒绝 —— 不能让"被重定向过"的响应进入解析。 */
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new Error('教室人数接口返回了重定向，已按安全策略拒绝')
  }
  if (!res.ok) {
    throw new Error(`教室人数接口返回 HTTP ${res.status}`)
  }

  const body = await res.text()
  return parseClassroomJson(building, body)
}
