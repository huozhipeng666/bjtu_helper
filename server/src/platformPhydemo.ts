/**
 * 演示实验（https://physpace.bjtu.edu.cn:8089/phydemo）客户端。
 *
 * 协议来源：上游 `v1.8.5-EmergencyFix2` 的 `PhysicsDemoRemote` /
 * `PhysicsDemoKt.parsePhysicsDemoBookings`（REA 静态分析）。
 *
 * ## 登录（自建表单）
 *  1. GET `/phydemo/login` → 校验表单 action=`/phydemo/login`、method=post、
 *     存在 username/password 输入框，收集全部隐藏字段；
 *  2. POST 隐藏字段 + username + password（**不跟随重定向**）；
 *  3. 成功判定：302 且 Location 落在 `/phydemo/` 前缀内；
 *     其它 3xx/失败一律「登录失效」。
 *
 * ## 数据
 *  GET `/phydemo/appointment/` →
 *  `fieldset > legend`（含「已预约实验」）为一条预约：
 *   - 实验名 = legend 去掉「已预约实验：」前缀，只认 {光学, 近代与综合}
 *   - `dl > dt/dd`：实验日期：/ 预约的时间段：/ 助教：
 *   - 节次 = 时间段在固定课表里的序号（08:10-09:50 为第 1 节…）
 *
 * ⚠️ 独立账号（与统一身份认证无关），凭据来自 independent_accounts 表。
 * ⚠️ 端口是 8089 且**只有 https**，代理/防火墙环境要放行。
 */
import * as cheerio from 'cheerio'
import { CookieJar } from './mis.js'
import {
  formEncode,
  looksLikeSessionExpired,
  platformFetch,
  platformFetchOnce,
  PlatformError,
  PlatformSessionPool
} from './platformHttp.js'

/* 演示实验只对校园网开放：中继在线时走中继（见 campusRelay.ts） */
const PHYDEMO_FETCH = { preferRelay: true } as const

const ORIGIN = 'https://physpace.bjtu.edu.cn:8089'
const PREFIX = '/phydemo/'
const LOGIN_URL = `${ORIGIN}${PREFIX}login`
const APPOINTMENT_URL = `${ORIGIN}${PREFIX}appointment/`

/** 演示实验的固定时间段表（上游 physicsDemoTimes） */
export const PHYSICS_DEMO_TIMES = [
  '08:10-09:50',
  '10:10-11:50',
  '14:10-15:50',
  '16:10-17:50',
  '18:30-20:10',
  '20:30-22:10'
] as const

/** 演示实验名称白名单（上游 physicsDemoNames） */
export const PHYSICS_DEMO_NAMES = ['光学', '近代与综合'] as const

export interface PlatformCred {
  username: string
  password: string
}

export interface PhysicsDemoBooking {
  name: string
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  /** 1-6，对应 PHYSICS_DEMO_TIMES 的序号 */
  period: number
  teacher: string
}

interface PhyDemoSession {
  jar: CookieJar
  lastUsedAt: number
  credFingerprint: string
}

const pool = new PlatformSessionPool<PhyDemoSession>('phydemo')

function fail(message: string, code: 'login-failed' | 'session-expired' | 'parse' | 'unavailable' = 'parse'): never {
  throw new PlatformError(message, code)
}

function credFingerprintOf(cred: PlatformCred): string {
  return `${cred.username}\u0000${cred.password}`
}

/* ---------------- 登录 ---------------- */

async function login(jar: CookieJar, cred: PlatformCred): Promise<void> {
  jar.clear()
  const page = await platformFetch(jar, LOGIN_URL, {}, PHYDEMO_FETCH)
  if (looksLikeSessionExpired(page) && !page.body.includes('password')) {
    fail('演示实验登录页暂时无法访问', 'unavailable')
  }
  const $ = cheerio.load(page.body)
  const form = $('form').first()
  if (form.length === 0) fail('未找到演示实验登录表单', 'parse')
  const action = form.attr('action') ?? ''
  if (action !== PREFIX + 'login' || (form.attr('method') ?? '').toLowerCase() !== 'post') {
    fail('演示实验登录表单发生了变化，请稍后反馈', 'parse')
  }
  if (form.find('input[name=username]').length === 0 || form.find('input[name=password]').length === 0) {
    fail('演示实验登录表单发生了变化，请稍后反馈', 'parse')
  }

  const fields: Record<string, string> = {}
  form.find('input[type=hidden][name]').each((_, el) => {
    const name = $(el).attr('name') ?? ''
    if (name) fields[name] = $(el).attr('value') ?? ''
  })
  fields.username = cred.username
  fields.password = cred.password

  const res = await platformFetchOnce(
    jar,
    LOGIN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: LOGIN_URL },
      body: formEncode(fields)
    },
    PHYDEMO_FETCH
  )
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? ''
    if (location.startsWith(PREFIX) || location.startsWith(`${ORIGIN}${PREFIX}`)) return
    fail('演示实验登录失效，请检查独立账号和密码', 'login-failed')
  }
  if (res.status >= 400) fail(`演示实验登录请求失败（HTTP ${res.status}）`, 'unavailable')
  /* 200 = 还在登录页（账号密码错误时原样返回） */
  fail('演示实验登录失效，请检查独立账号和密码', 'login-failed')
}

async function ensureSession(userId: number, cred: PlatformCred): Promise<PhyDemoSession> {
  const fp = credFingerprintOf(cred)
  const cached = pool.get(userId, fp)
  if (cached) return cached
  const jar = new CookieJar()
  await login(jar, cred)
  const session: PhyDemoSession = { jar, lastUsedAt: Date.now(), credFingerprint: fp }
  pool.put(userId, session)
  return session
}

/* ---------------- 数据 ---------------- */

/** "2025-10-01" → epoch 秒（UTC+8 当天零点）；解析不了返回 null */
function parseIsoDate(text: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text.trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 1000) - 8 * 3600
}

function compact(value: string): string {
  return value.replace(/[\s\u00a0]+/g, '')
}

function parseBookings(html: string): PhysicsDemoBooking[] {
  const $ = cheerio.load(html)
  if ($('input[type=password]').length > 0) {
    fail('演示实验账号未登录或结果页无法验证', 'session-expired')
  }
  const allText = compact($('body').text() ?? '')
  if (!allText.includes('已预约实验信息')) {
    fail('演示实验账号未登录或结果页无法验证', 'session-expired')
  }
  const fieldsets: cheerio.Cheerio<never>[] = []
  $('fieldset').each((_, fs) => {
    const legend = $(fs).find('legend').first().text() ?? ''
    if (legend.includes('已预约实验')) fieldsets.push($(fs) as unknown as cheerio.Cheerio<never>)
  })
  if (allText.includes('无预约信息') && fieldsets.length === 0) return []

  const bookings: PhysicsDemoBooking[] = []
  for (const fs of fieldsets) {
    const legend = fs.find('legend').first().text() ?? ''
    const name = compact(legend).replace(/^已预约实验：/, '')
    if (!(PHYSICS_DEMO_NAMES as readonly string[]).includes(name)) {
      fail('已预约实验名称无法识别，保留上次结果', 'parse')
    }
    const dl: Record<string, string> = {}
    fs.find('dl').each((_, item) => {
      const dt = $(item).find('dt').first().text() ?? ''
      const dd = $(item).find('dd').first().text() ?? ''
      dl[compact(dt)] = compact(dd)
    })
    const date = parseIsoDate(dl['实验日期：'] ?? '')
    if (date === null) fail('已预约实验日期无法识别，保留上次结果', 'parse')
    const rangeText = dl['预约的时间段：'] ?? ''
    const ranges = [...rangeText.matchAll(/(\d{2}:\d{2})(?::\d{2})?[~～至-](\d{2}:\d{2})(?::\d{2})?/g)]
    if (ranges.length !== 1) fail('已预约实验时段无法识别', 'parse')
    const idx = PHYSICS_DEMO_TIMES.indexOf(`${ranges[0][1]}-${ranges[0][2]}` as never)
    const period = idx + 1
    if (period < 1 || period > 6) fail('已预约实验时段发生了变化', 'parse')
    const teacher = (dl['助教：'] ?? '').replace(/\(\)$/, '')
    bookings.push({ name, date, period, teacher })
  }
  if (bookings.length === 0) fail('预约结果结构发生了变化，保留上次结果', 'parse')
  /* 同一实验同一天同一节次只留一条 */
  const seen = new Set<string>()
  return bookings.filter((b) => {
    const key = `${b.name}|${b.date}|${b.period}|${b.teacher}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 一次「登录（必要时）→ 拉预约列表 → 解析」的完整尝试。
 *
 * `retried` 用来做**一次**自我重试：预约列表拿到非 2xx 时，最常见的原因不是站点
 * 挂了，而是池子里的 JSESSIONID 已经失效、站点却没按 302 跳登录（线上实测过
 * 直接回非 2xx 的情况）。丢掉会话重新登录再来一次，比让用户点刷新划算得多。
 * 重试仍然失败才报错 —— 那时日志里已经有状态码，可以判断是不是真的站点问题。
 */
async function fetchBookingsOnce(
  userId: number,
  cred: PlatformCred,
  retried = false
): Promise<PhysicsDemoBooking[]> {
  const session = await ensureSession(userId, cred)
  const page = await platformFetch(
    session.jar,
    APPOINTMENT_URL,
    {
      headers: {
        'Cache-Control': 'no-cache',
        Referer: LOGIN_URL
      }
    },
    PHYDEMO_FETCH
  )
  if (page.status < 200 || page.status >= 300) {
    /* 光看那句「演示实验系统暂时不可用」分不清是站点 5xx、被跳登录页、
       还是出口返回了别的东西。把状态码 / 最终 URL / 正文开头打出来，
       一次复现就能定位（日志里搜 `[phydemo]`）。 */
    console.warn(
      `[phydemo] 预约列表非 2xx：status=${page.status} url=${page.url} ` +
        `ct=${page.headers.get('content-type') ?? '-'} len=${page.body.length} ` +
        `retried=${retried} head=${page.body.replace(/\s+/g, ' ').slice(0, 160)}`
    )
    if (!retried) {
      pool.drop(userId)
      return await fetchBookingsOnce(userId, cred, true)
    }
    fail('演示实验系统暂时不可用', 'unavailable')
  }
  return parseBookings(page.body)
}

/**
 * 全量同步：登录 → 预约列表。
 *
 * ⚠️ 同 platformPhysicslab：会话失效时必须丢掉池子里的 jar 再重登一次，
 *    否则后续所有请求都会复用同一个死 cookie，一路失败到 TTL 到期。
 */
export async function fetchPhyDemoBookings(userId: number, cred: PlatformCred): Promise<PhysicsDemoBooking[]> {
  try {
    return await fetchBookingsOnce(userId, cred)
  } catch (err) {
    if (!(err instanceof PlatformError) || err.code !== 'session-expired') throw err
    pool.drop(userId)
    return await fetchBookingsOnce(userId, cred)
  }
}

/** 探测账号能否登录（保存凭据后由路由调用） */
export async function verifyPhyDemoAccount(cred: PlatformCred): Promise<void> {
  const jar = new CookieJar()
  await login(jar, cred)
  const page = await platformFetch(jar, APPOINTMENT_URL, { headers: { Referer: LOGIN_URL } }, PHYDEMO_FETCH)
  if (page.status < 200 || page.status >= 300) {
    fail('演示实验系统暂时不可用', 'unavailable')
  }
  parseBookings(page.body)
}
