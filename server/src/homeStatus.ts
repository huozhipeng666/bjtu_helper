/**
 * 首页账户状态（新邮件数 / 校园卡余额 / 校园网余额）。
 *
 * 数据源 `GET https://mis.bjtu.edu.cn/osys_ajax_wrap/`，要 MIS 会话。
 * 上游（KMP 版）在 `data/home/HomeStatusJsonParser.kt` 里定的口径是**严格解析**：
 * 三个字段缺任何一个就整体判失败，不返回"半份状态"。
 *
 * ## 为什么要严格
 *
 * 这三个数字里有两个会直接驱动用户行为：
 *   - 校园卡余额 < 20 会提示充值，读成 0 会变成"你没钱了"这种明确误报；
 *   - 校园网余额 == 0 会提示流量用尽，读错就是"网断了"。
 * 平台返回 `null` 或空串时，把缺失当成 0 比报错更危险 —— 所以这里宁可
 * 整体失败、让前端显示"状态未知"，也不猜。
 *
 * ## 为什么三个字段都用字符串
 *
 * 平台把余额当**字符串**返回（`"88.00"` / `"12.50"`），而上游明确要求
 * **不改写显示文本**（`88.00` 不能变成 `88`，`19.5` 不能变成 `19.50`）。
 * 所以这里原样保留字符串，只在需要判断时临时转数字。
 *
 * ⚠️ 本文件必须**零依赖**（不 import lib.js / db.js）：单测要能直接 import 它。
 * lib.js 一进来就会连带 db.js 并打开数据库，纯函数单测瞬间变成集成测试。
 */

/** 三个字段都是平台原始文本，不做格式化 */
export interface HomeStatus {
  newMailCount: string
  campusCardBalance: string
  networkBalance: string
}

/** 由原始文本派生的提示标记（上游 `domain/home/HomeStatus.kt` 同口径） */
export interface HomeStatusFlags {
  hasNewMail: boolean
  /** 余额 < 20 元 */
  campusCardLow: boolean
  /** 余额恰好为 0 */
  networkEmpty: boolean
}

/**
 * 解析失败时抛出，`field` 指出是哪个字段出的问题。
 *
 * 单独一个类而不是 HttpError：解析失败在路由层要被转成 502（学校接口异常），
 * 而 HttpError 的 4xx 语义是"客户端传错了"，两者不能混。
 */
export class HomeStatusParseError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'HomeStatusParseError'
    this.field = field
  }
}

/**
 * 把 JSON 值读成字符串。
 *
 * 平台有时返回字符串，有时返回数字（上游测试用例覆盖了 `"net_fee":0` 这种）。
 *
 * ⚠️ 这里**只能**做到"字符串原样保留"：平台返回字符串 `"88.00"` 时原样透出；
 *    但返回的是 JSON 数字时，`JSON.parse` 已经把 `88.00` 变成 `88` 了，
 *    本函数拿到的就是 number，`String(value)` 无法还原字面量。
 *    （不要试图用 `toFixed(2)` 去"修"—— 平台有的字段本来就是整数，
 *    硬补两位小数反而改写了显示文本。）
 *    所以「不改写显示文本」这条约束的实际边界是：**仅对字符串形态成立**。
 */
function asDisplayString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function fieldOf(root: Record<string, unknown>, name: string): string {
  const raw = asDisplayString(root[name])
  if (raw === null || raw.trim() === '') {
    throw new HomeStatusParseError(name, `学校状态接口未返回 ${name}`)
  }
  return raw
}

/**
 * 解析 `/osys_ajax_wrap/` 的响应体。
 *
 * @throws HomeStatusParseError 根不是 JSON 对象、或三字段任一缺失/空白
 */
export function parseHomeStatusJson(body: string): HomeStatus {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    throw new HomeStatusParseError('root', '学校状态接口返回的不是 JSON')
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new HomeStatusParseError('root', '学校状态接口返回的结构异常')
  }
  const obj = root as Record<string, unknown>
  return {
    newMailCount: fieldOf(obj, 'newmail_count'),
    campusCardBalance: fieldOf(obj, 'ecard_yuer'),
    networkBalance: fieldOf(obj, 'net_fee')
  }
}

/**
 * 从原始文本派生提示标记。
 *
 * 转不成数字时一律为 false（**不猜**）：`"未知"` 不该被当成"余额充足"，
 * 也不该被当成"欠费"。
 */
export function homeStatusFlags(s: HomeStatus): HomeStatusFlags {
  const mail = Number.parseInt(s.newMailCount, 10)
  const card = Number.parseFloat(s.campusCardBalance)
  const net = Number.parseFloat(s.networkBalance)
  return {
    hasNewMail: Number.isFinite(mail) && mail > 0,
    campusCardLow: Number.isFinite(card) && card < 20,
    /* 用 === 0 而不是 <= 0：负数余额是数据异常，不该显示"流量用尽" */
    networkEmpty: Number.isFinite(net) && net === 0
  }
}

/** 把人话写给前端：解析失败时前端要能说清是"学校接口没给"还是"网络不通" */
export function describeHomeStatusError(err: unknown): string {
  if (err instanceof HomeStatusParseError) {
    return `学校状态接口的数据格式异常（${err.field}），请稍后重试`
  }
  if (err instanceof Error) return err.message
  return '学校状态接口请求失败'
}
