/**
 * 物理实验（http://wlsy.bjtu.edu.cn，ASP.NET WebForms + DevExpress）客户端。
 *
 * 协议来源：上游 `v1.8.5-EmergencyFix2` 的 `PhysicsLabRemote` /
 * `PhysicsLabRemoteKt.parsePhysicsLabs`（REA 静态分析）。
 *
 * ## 登录（WebForms 表单回历）
 *  1. GET `/` → 收集登录表单全部 `input[name]`（剔除 submit/button/image/file/reset，
 *     checkbox/radio 仅取 checked）；
 *  2. 按**后缀**定位字段填值：tbUserId=账号、tbPassword=密码、
 *     ASPxRadioButtonListType="0"、RB0="C"（选中）RB1/RB2="U"（未选中）；
 *  3. __EVENTTARGET / __EVENTARGUMENT 置空；
 *  4. 追加登录按钮（`input[type=submit][name$=btnLogin]`，value 空则用「登录」）；
 *  5. POST 回 `/`。
 *
 * ## 数据
 *  GET `/Student/Teach/Course/CourseResult.aspx` →
 *  `table[id$=ASPxGridViewCourseList_DXMainTable]` 的 tr（跳过 EmptyDataRow）：
 *  单元格 [1]=日期（20YY-M-D）[2]=节次（1-6）[3]=实验名 [4]=地点 [5]=指导教师。
 *
 * ## 编码
 *  wlsy 是 GB2312/GBK 老站，**必须按 gbk 解码**（上游同款有 LegacyGb18030Decoder）。
 *
 * ⚠️ 独立账号（与统一身份认证无关），凭据来自 independent_accounts 表。
 */
import * as cheerio from 'cheerio'
import { CookieJar } from './mis.js'
import {
  formEncode,
  looksLikeSessionExpired,
  platformFetch,
  PlatformError,
  PlatformSessionPool
} from './platformHttp.js'

/* 物理实验只对校园网开放：中继在线时走中继（见 campusRelay.ts） */
const PHYSICSLAB_FETCH = { preferRelay: true } as const

const ORIGIN = 'http://wlsy.bjtu.edu.cn'
const HOME_URL = `${ORIGIN}/`
const RESULTS_URL = `${ORIGIN}/Student/Teach/Course/CourseResult.aspx`

/** 物理实验的节次时间段（上游 physicsLabTimeRanges，与教务节次表对齐的显示用） */
export const PHYSICS_LAB_TIME_RANGES = [
  '13:20-15:50',
  '16:20-18:50',
  '19:10-21:40',
  '13:00-16:20',
  '17:40-21:00',
  '10:10-12:40'
] as const

export interface PlatformCred {
  username: string
  password: string
}

export interface PhysicsLab {
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  /** 1-6 */
  period: number
  name: string
  location: string
  teacher: string
}

interface PhysicsLabSession {
  jar: CookieJar
  lastUsedAt: number
  credFingerprint: string
}

const pool = new PlatformSessionPool<PhysicsLabSession>('physicslab')

function fail(message: string, code: 'login-failed' | 'session-expired' | 'parse' | 'unavailable' = 'parse'): never {
  throw new PlatformError(message, code)
}

function credFingerprintOf(cred: PlatformCred): string {
  return `${cred.username}\u0000${cred.password}`
}

/* ---------------- 登录 ---------------- */

/** 表单字段按**后缀**匹配（上游 fetch$field：endsWith 忽略大小写） */
function fieldBySuffix(fields: Record<string, string>, suffix: string): string {
  const key = Object.keys(fields).find((k) => k.toLowerCase().endsWith(suffix.toLowerCase()))
  if (!key) fail('实验系统登录表单发生变化，请稍后反馈', 'parse')
  return key
}

async function login(jar: CookieJar, cred: PlatformCred): Promise<void> {
  jar.clear()
  const page = await platformFetch(jar, HOME_URL, {}, { encoding: 'gbk', ...PHYSICSLAB_FETCH })
  const $ = cheerio.load(page.body)
  const form = $('form').first()
  if (form.length === 0) fail('未找到实验系统登录表单', 'parse')

  const fields: Record<string, string> = {}
  form.find('input[name]').each((_, el) => {
    const name = $(el).attr('name') ?? ''
    if (!name) return
    const type = ($(el).attr('type') ?? '').toLowerCase()
    if (['submit', 'button', 'image', 'file', 'reset'].includes(type)) return
    if (['checkbox', 'radio'].includes(type) && !$(el).attr('checked')) return
    fields[name] = $(el).attr('value') ?? ''
  })

  fields[fieldBySuffix(fields, 'tbUserId')] = cred.username
  fields[fieldBySuffix(fields, 'tbPassword')] = cred.password
  fields[fieldBySuffix(fields, 'ASPxRadioButtonListType')] = '0'
  /* DevExpress 单选列表状态：RB0 选中、其余未选（上游硬编码 3 项） */
  fields[fieldBySuffix(fields, 'RB0')] = 'C'
  fields[fieldBySuffix(fields, 'RB1')] = 'U'
  fields[fieldBySuffix(fields, 'RB2')] = 'U'
  fields[fieldBySuffix(fields, '__EVENTTARGET')] = ''
  fields[fieldBySuffix(fields, '__EVENTARGUMENT')] = ''

  const loginBtn = form.find('input[type=submit][name$=btnLogin]').first()
  if (loginBtn.length === 0) fail('未找到登录按钮', 'parse')
  const btnName = loginBtn.attr('name') ?? ''
  const btnValue = loginBtn.attr('value') ?? ''
  fields[btnName] = btnValue.trim() ? btnValue : '登录'

  const res = await platformFetch(
    jar,
    HOME_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: HOME_URL },
      body: formEncode(fields)
    },
    { encoding: 'gbk', ...PHYSICSLAB_FETCH }
  )
  if (res.status >= 400) fail(`实验系统登录请求失败（HTTP ${res.status}）`, 'unavailable')
  /*
   * 登录失败的判定：**只能看"密码框还在不在"**。
   *
   * 早前这里是 `res.url.includes('login') && res.body.includes('tbPassword')` ——
   * 但登录 POST 打的是 `/`，失败时 WebForms 也是 200 原样返回**同一个 URL**，
   * 里面根本没有 'login' 字样，于是这个条件永远不成立：
   * 密码输错会一路走到结果页，最后被 fetchLabs 判成 session-expired
   * （"登录已失效，请刷新重试"）。用户明明密码错了，却被告知"刷新一下"，
   * 于是反复刷新、反复失败 —— 实测错误密码就是这么表现成"拉取失败"的。
   */
  const after = cheerio.load(res.body)
  if (after('input[name$=tbPassword]').length > 0 || after('input[id$=tbPassword_I]').length > 0) {
    fail('物理实验登录失败，请检查独立账号密码', 'login-failed')
  }
}

async function ensureSession(userId: number, cred: PlatformCred): Promise<PhysicsLabSession> {
  const fp = credFingerprintOf(cred)
  const cached = pool.get(userId, fp)
  if (cached) return cached
  const jar = new CookieJar()
  await login(jar, cred)
  const session: PhysicsLabSession = { jar, lastUsedAt: Date.now(), credFingerprint: fp }
  pool.put(userId, session)
  return session
}

/* ---------------- 数据 ---------------- */

async function fetchLabs(jar: CookieJar): Promise<PhysicsLab[]> {
  const page = await platformFetch(jar, RESULTS_URL, {}, { encoding: 'gbk', ...PHYSICSLAB_FETCH })
  if (looksLikeSessionExpired(page)) {
    fail('物理实验登录已失效，请刷新重试', 'session-expired')
  }
  const $ = cheerio.load(page.body)
  /* 登录被踢回登录页的特征：密码框又出现了 */
  if ($('input[name$=tbPassword]').length > 0 || $('input[id$=tbPassword_I]').length > 0) {
    fail('物理实验账号或密码错误，或登录已失效', 'login-failed')
  }
  const table = $('table[id$=ASPxGridViewCourseList_DXMainTable]').first()
  if (table.length === 0) fail('选课结果结构发生了变化，请稍后反馈', 'parse')

  const labs: PhysicsLab[] = []
  const seen = new Set<string>()
  table.find('tr').each((_, tr) => {
    const row = $(tr)
    if ((row.attr('class') ?? '').includes('EmptyDataRow')) return
    const cells: string[] = []
    row.children().each((_, cell) => {
      const el = $(cell)
      const tag = (el.prop('tagName') ?? '').toLowerCase()
      if (tag === 'td' || tag === 'th') cells.push((el.text() ?? '').trim())
    })
    if (cells.length < 4) return
    const dateM = /^(20\d{2})[/-](\d{1,2})[/-](\d{1,2})$/.exec(cells[1])
    if (!dateM) return
    const period = Number(cells[2])
    if (!Number.isInteger(period) || period < 1 || period > 6) return
    const name = cells[3]
    if (!name) return
    const key = `${dateM[0]}|${period}|${name}`
    if (seen.has(key)) return
    seen.add(key)
    labs.push({
      date: Math.floor(Date.UTC(Number(dateM[1]), Number(dateM[2]) - 1, Number(dateM[3]), 0, 0) / 1000) - 8 * 3600,
      period,
      name,
      location: cells.length > 4 ? cells[4] : '',
      teacher: cells.length > 5 ? cells[5] : ''
    })
  })
  return labs
}

/**
 * 全量同步：登录 → 选课结果页 → 实验列表。
 *
 * ⚠️ 会话失效时必须**丢掉池子里的 jar 再重登一次**。
 *    早前这里是「ensureSession → fetchLabs」直线走完，fetchLabs 发现被踢回登录页
 *    只抛 session-expired，池子里那份死 cookie 原封不动。于是后续每一次请求
 *    （包括用户狂点刷新）都复用同一个死 jar，一路失败到 TTL 到期为止 ——
 *    线上表现就是「物理实验一直拉取失败，怎么刷都没用」，而且日志里是一串
 *    间隔 1~2 秒的 session-expired，看起来像学校那边在拒我们，实际是我们自己的缓存。
 */
export async function fetchPhysicsLabSnapshot(userId: number, cred: PlatformCred): Promise<PhysicsLab[]> {
  try {
    const session = await ensureSession(userId, cred)
    return await fetchLabs(session.jar)
  } catch (err) {
    if (!(err instanceof PlatformError) || err.code !== 'session-expired') throw err
    pool.drop(userId)
    const session = await ensureSession(userId, cred)
    return await fetchLabs(session.jar)
  }
}

/** 探测账号能否登录（保存凭据后由路由调用） */
export async function verifyPhysicsLabAccount(cred: PlatformCred): Promise<void> {
  const jar = new CookieJar()
  await login(jar, cred)
  const page = await platformFetch(jar, RESULTS_URL, {}, { encoding: 'gbk', ...PHYSICSLAB_FETCH })
  const $ = cheerio.load(page.body)
  if ($('input[name$=tbPassword]').length > 0 || $('input[id$=tbPassword_I]').length > 0) {
    fail('物理实验登录失败，请检查独立账号密码', 'login-failed')
  }
}
