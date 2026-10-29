/**
 * CITEL（https://citel.bjtu.edu.cn/mlsv3，Moodle 3.x）客户端。
 *
 * 协议来源：上游 `BJTUselfService-KMP-Refreshed v1.8.5-EmergencyFix2`
 * 的 `CitepRemote` / `CitelParserKt`（REA 静态分析，class sha256 见部署记录）。
 *
 * ## 登录（Moodle 标准表单）
 *  1. GET `/mlsv3/login/index.php` → 解析登录表单的隐藏字段（logintoken 必须有）
 *  2. POST 表单字段 + username + password + logintoken + anchor=""
 *  3. 拿 `/mlsv3/my/` 验登录态：有退出链接才算成
 *
 * ## 数据
 *  - sesskey：`/my/` 页面里 `"sesskey":"xxxx"`（页面级 JS 配置）
 *  - 课程列表：Moodle AJAX `lib/ajax/service.php?sesskey=…`
 *    `core_course_get_enrolled_courses_by_timeline_classification`（分页 limit=50）
 *  - 作业/编程练习列表：课程页 `/course/view.php?id=N` 的 `li.activity` 锚点
 *  - 作业详情：作业页 `#region-main` 的表格 + `[data-region=activity-dates]`
 *
 * ⚠️ CITEL 是**独立账号**（与统一身份认证无关），凭据来自 independent_accounts 表。
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

const CITEL_ORIGIN = 'https://citel.bjtu.edu.cn'
const CITEL_BASE = `${CITEL_ORIGIN}/mlsv3`
const LOGIN_URL = `${CITEL_BASE}/login/index.php`
const MY_URL = `${CITEL_BASE}/my/`

/** 课程列表每页条数（上游同款 50） */
const COURSE_PAGE_SIZE = 50
/** 课程列表最大页数，防「nextoffset 永远前进」把循环拖死 */
const MAX_COURSE_PAGES = 20
/** 作业详情并发上限：对 Moodle 客气一点，也避免把学校站打挂 */
const DETAIL_CONCURRENCY = 3

export interface CitelCourse {
  id: number
  name: string
}

export interface CitelTask {
  id: number
  courseId: number
  courseName: string
  title: string
  url: string
  /** 编程练习（mod/programming）与书面作业（mod/assign）的详情结构不同 */
  programming: boolean
  /** epoch 秒；null = 页面没写这个时间（不猜） */
  openTime: number | null
  dueTime: number | null
  discountTime: number | null
  discount: number | null
  allowLate: boolean | null
  status: string | null
  submitted: boolean
  grade: string | null
}

export interface CitelSnapshot {
  courses: CitelCourse[]
  tasks: CitelTask[]
}

export interface PlatformCred {
  username: string
  password: string
}

interface CitelSession {
  jar: CookieJar
  lastUsedAt: number
  credFingerprint: string
  sesskey: string
}

const pool = new PlatformSessionPool<CitelSession>('citel')

function fail(message: string, code: 'login-failed' | 'session-expired' | 'parse' | 'unavailable' = 'parse'): never {
  throw new PlatformError(message, code)
}

function credFingerprintOf(cred: PlatformCred): string {
  return `${cred.username}\u0000${cred.password}`
}

/* ---------------- 登录 ---------------- */

/** GET /my/ ：验证登录态并抠出 sesskey */
async function readMyPage(jar: CookieJar): Promise<{ loggedIn: boolean; sesskey: string | null }> {
  const res = await platformFetch(jar, MY_URL)
  if (looksLikeSessionExpired(res)) return { loggedIn: false, sesskey: null }
  const $ = cheerio.load(res.body)
  const loggedIn =
    $("a[href*='/login/logout.php']").length > 0 ||
    $("[data-region='usermenu']").length > 0 ||
    $("a[href='/user/profile.php']").length > 0
  const m = /"sesskey"\s*:\s*"([A-Za-z0-9]+)"/.exec(res.body)
  return { loggedIn, sesskey: m ? m[1] : null }
}

async function login(jar: CookieJar, cred: PlatformCred): Promise<string> {
  /* Moodle 常见坑：旧 cookie 会让登录页 302 到已登录状态。先清一次更可预期。 */
  jar.clear()
  const page = await platformFetch(jar, LOGIN_URL)
  if (!page.url.startsWith(LOGIN_URL)) {
    fail('CITEL 登录地址异常，请稍后重试', 'unavailable')
  }
  const $ = cheerio.load(page.body)
  const fields: Record<string, string> = {}
  $('form input[name]').each((_, el) => {
    const name = $(el).attr('name') ?? ''
    if (name) fields[name] = $(el).attr('value') ?? ''
  })
  if (!fields.logintoken) {
    fail('CITEL 登录页面格式发生变化，请稍后反馈', 'parse')
  }
  const res = await platformFetch(jar, LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: LOGIN_URL },
    body: formEncode({
      ...fields,
      username: cred.username,
      password: cred.password,
      logintoken: fields.logintoken,
      anchor: ''
    })
  })
  /* Moodle 登录失败 = 200 且停在登录页；成功 = 302 到 /my/ 或原页 */
  if (res.status >= 400) fail(`CITEL 登录请求失败（HTTP ${res.status}）`, 'unavailable')
  const my = await readMyPage(jar)
  if (!my.loggedIn) {
    fail('CITEL 登录失败，请检查 CITEL 专用账号密码', 'login-failed')
  }
  if (!my.sesskey) {
    fail('CITEL 会话令牌缺失，请稍后重试', 'session-expired')
  }
  return my.sesskey
}

/** 取会话：命中池直接复用；否则登录并缓存 */
async function ensureSession(userId: number, cred: PlatformCred): Promise<CitelSession> {
  const fp = credFingerprintOf(cred)
  const cached = pool.get(userId, fp)
  if (cached) return cached
  const jar = new CookieJar()
  const sesskey = await login(jar, cred)
  const session: CitelSession = { jar, lastUsedAt: Date.now(), credFingerprint: fp, sesskey }
  pool.put(userId, session)
  return session
}

/* ---------------- 课程列表（Moodle AJAX） ---------------- */

async function fetchCourses(jar: CookieJar, sesskey: string): Promise<CitelCourse[]> {
  const url =
    `${CITEL_BASE}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}` +
    `&info=core_course_get_enrolled_courses_by_timeline_classification`
  const courses: CitelCourse[] = []
  const seen = new Set<number>()
  for (let page = 0; page < MAX_COURSE_PAGES; page++) {
    const body = JSON.stringify([
      {
        index: 0,
        methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
        args: {
          offset: page * COURSE_PAGE_SIZE,
          limit: COURSE_PAGE_SIZE,
          classification: 'all',
          sort: 'fullname',
          customfieldname: '',
          customfieldvalue: ''
        }
      }
    ])
    const res = await platformFetch(jar, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: MY_URL },
      body
    })
    if (looksLikeSessionExpired(res)) {
      fail('CITEL 登录已失效，请检查账号密码后重试', 'session-expired')
    }
    let payload: unknown
    try {
      payload = JSON.parse(res.body)
    } catch {
      fail('CITEL 课程接口格式发生变化', 'parse')
    }
    const first = Array.isArray(payload) ? payload[0] : undefined
    const data = (first as { data?: unknown } | undefined)?.data as
      | { courses?: unknown; nextoffset?: unknown; errorcode?: unknown; exception?: unknown }
      | undefined
    if (!data || data.errorcode || data.exception) {
      if (data?.errorcode === 'invalidsesskey' || data?.errorcode === 'servicerequireslogin') {
        fail('CITEL 会话已失效，请刷新重试', 'session-expired')
      }
      fail('CITEL 课程接口返回异常', 'parse')
    }
    const list = Array.isArray(data.courses) ? data.courses : []
    let added = 0
    for (const raw of list) {
      const c = raw as { id?: unknown; fullname?: unknown }
      const id = typeof c.id === 'number' ? c.id : null
      const name = typeof c.fullname === 'string' ? c.fullname : ''
      if (id === null || !name) continue
      if (seen.has(id)) continue
      seen.add(id)
      courses.push({ id, name })
      added++
    }
    const nextOffset = typeof data.nextoffset === 'number' ? data.nextoffset : -1
    if (list.length < COURSE_PAGE_SIZE || nextOffset <= 0 || added === 0) break
  }
  return courses
}

/* ---------------- 作业列表 ---------------- */

async function fetchCourseTasks(jar: CookieJar, course: CitelCourse): Promise<CitelTask[]> {
  const url = `${CITEL_BASE}/course/view.php?id=${course.id}`
  const res = await platformFetch(jar, url, { headers: { Referer: MY_URL } })
  if (looksLikeSessionExpired(res)) {
    fail('CITEL 登录已失效，请刷新重试', 'session-expired')
  }
  const $ = cheerio.load(res.body)
  const region = $('#region-main')
  if (region.length === 0) {
    fail(`课程「${course.name}」页面格式发生了变化`, 'parse')
  }
  const tasks: CitelTask[] = []
  const seen = new Set<number>()
  region
    .find("li.activity a[href*='/mod/assign/view.php'], li.activity a[href*='/mod/programming/view.php']")
    .each((_, el) => {
      const href = $(el).attr('href') ?? ''
      const abs = new URL(href, url).toString()
      const m = /[?&]id=(\d+)/.exec(abs)
      if (!m) return
      const id = Number(m[1])
      if (!Number.isInteger(id) || seen.has(id)) return
      const instance = $(el).find('.instancename').first().clone()
      instance.find('.accesshide').remove()
      let title = instance.text().trim()
      if (!title) title = ($(el).text() ?? '').replace(/\s+(Assignment|Programming Practice|作业|编程练习)$/, '').trim()
      title = title.replace(/\s+(Assignment|Programming Practice|作业|编程练习)$/, '').trim()
      seen.add(id)
      tasks.push({
        id,
        courseId: course.id,
        courseName: course.name,
        title,
        url: abs,
        programming: abs.includes('/mod/programming/'),
        openTime: null,
        dueTime: null,
        discountTime: null,
        discount: null,
        allowLate: null,
        status: null,
        submitted: false,
        grade: null
      })
    })
  return tasks
}

/* ---------------- 时间解析（上游 parseCitelTime） ---------------- */

const CN_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]

/** Asia/Shanghai 固定 UTC+8 → epoch 秒 */
const CST_OFFSET_MIN = 480

function cstEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000) - CST_OFFSET_MIN * 60
}

export function parseCitelTime(text: string): number | null {
  if (!text) return null
  /* 中文："2024-10-1 … 18:00" / "2024年10月1日 18:00" */
  let m = /(\d{2,4})[年/-](\d{1,2})[月/-](\d{1,2})日?.*?(\d{1,2})[:：](\d{2})/.exec(text)
  if (m) {
    let hour = Number(m[4])
    const pm = /下午|晚上|PM/i.test(text)
    const am = /上午|AM/i.test(text)
    if (pm && hour < 12) hour += 12
    if (am && hour === 12) hour = 0
    let year = Number(m[1])
    if (year < 100) year += 2000
    return cstEpoch(year, Number(m[2]), Number(m[3]), hour, Number(m[5]))
  }
  /* 英文："1 October 2024, 6:00 PM" */
  m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text)
  if (m) {
    let hour = Number(m[4])
    const suffix = (m[6] ?? '').toUpperCase()
    if (suffix === 'PM' && hour < 12) hour += 12
    if (suffix === 'AM' && hour === 12) hour = 0
    const monthIdx = CN_MONTHS.indexOf(m[2].toLowerCase())
    if (monthIdx < 0) return null
    return cstEpoch(Number(m[3]), monthIdx + 1, Number(m[1]), hour, Number(m[5]))
  }
  return null
}

/* ---------------- 作业详情 ---------------- */

/**
 * 读「编程练习」的提交状态。
 *
 * 编程练习的提交结果**不在** `view.php?id=<cmid>` 里（那页只有题面和开放/截止时间），
 * 而在 `result.php?a=<内部 id>`：导航栏的 Result 标签带着那个 `a` 参数，
 * 注意 `a` 与课程模块 id（cmid）是两个不同的编号，不能混用。
 *
 * 页面里那两句话就是全部依据：
 *   Current Status: The program is successfully processed.
 *   Test Result: There are 1 test cases. Your program has passed 1 of them and failed in 0 of them.
 * 编译失败时 Current Status 是 "The program is failed to compile."，同样算「已提交」。
 *
 * 此前完全没读这页，`status` 恒为 null → `submitted` 恒为 false，
 * 于是写了作业也显示「未提交」（2026-10-22 线上反馈）。
 */
async function readProgrammingStatus(
  jar: CookieJar,
  $: cheerio.CheerioAPI,
  task: CitelTask
): Promise<{ status: string | null; submitted: boolean }> {
  const href = $('a.nav-link[href*="result.php"]').first().attr('href') ?? ''
  if (!href) return { status: null, submitted: false }
  const url = new URL(href, task.url).toString()
  const res = await platformFetch(jar, url, { headers: { Referer: task.url } })
  if (looksLikeSessionExpired(res)) fail('CITEL 登录已失效，请刷新重试', 'session-expired')
  const $r = cheerio.load(res.body)
  const text = ($r('body').text() ?? '').replace(/\s+/g, ' ')
  const rawM = /Current Status:\s*(.+?)(?:Test Result:|$)/.exec(text)
  const raw = rawM ? rawM[1].trim() : ''
  const passed = /passed (\d+) of them and failed in (\d+)/i.exec(text)
  const accepted = !!passed && Number(passed[2]) === 0 && Number(passed[1]) > 0
  /* 没有 Current Status 也没有 Test Result = 一次都没交过 */
  const submitted = raw.length > 0 || /Test Result:/i.test(text)
  if (!submitted) return { status: null, submitted: false }
  if (accepted) return { status: passed ? `已通过（${passed[1]}/${passed[1]} 用例）` : '已通过', submitted: true }
  if (/failed to compile/i.test(raw)) return { status: '编译失败', submitted: true }
  if (passed) return { status: `未通过（通过 ${passed[1]}，失败 ${passed[2]}）`, submitted: true }
  return { status: raw || '已提交', submitted: true }
}

/** 提交状态里出现这些词就说明"没交" */
const CITEL_NOT_SUBMITTED = /no attempt|not submitted|no submission|未提交|尚未提交|未作答|草稿|draft/i

async function fetchTaskDetail(jar: CookieJar, task: CitelTask): Promise<CitelTask> {
  const res = await platformFetch(jar, task.url, { headers: { Referer: `${CITEL_BASE}/course/view.php?id=${task.courseId}` } })
  if (looksLikeSessionExpired(res)) {
    fail('CITEL 登录已失效，请刷新重试', 'session-expired')
  }
  const $ = cheerio.load(res.body)
  const region = $('#region-main')
  if (region.length === 0) fail(`作业「${task.title}」详情格式发生了变化`, 'parse')

  const tableMap: Record<string, string> = {}
  region.find('table tr').each((_, tr) => {
    const th = $(tr).find('th').first()
    const td = $(tr).find('td').first()
    if (th.length === 0 || td.length === 0) return
    const key = (th.text() ?? '').trim().toLowerCase()
    if (key) tableMap[key] = (td.text() ?? '').trim()
  })
  const dateMap: Record<string, string> = {}
  region.find("[data-region=activity-dates] > div").each((_, div) => {
    const strong = $(div).find('strong').first()
    const key = (strong.text() ?? '').trim().replace(/[:：]+$/, '').toLowerCase()
    if (key) dateMap[key] = ($(div).text() ?? '').trim()
  })

  if (task.programming && region.find('h1.name').length === 0) {
    fail(`编程作业「${task.title}」详情格式发生了变化`, 'parse')
  }
  if (!task.programming && region.find('.submissionstatustable, [data-region=activity-information]').length === 0) {
    fail(`作业「${task.title}」详情格式发生了变化`, 'parse')
  }

  const fullText = region.text() ?? ''
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      if (tableMap[k.toLowerCase()]) return tableMap[k.toLowerCase()]
    }
    return null
  }
  const pickDate = (keys: string[]): number | null => {
    for (const k of keys) {
      const lk = k.toLowerCase()
      const raw = tableMap[lk] ?? dateMap[lk]
      if (raw) {
        const t = parseCitelTime(raw)
        if (t !== null) return t
      }
    }
    return null
  }

  let status: string | null
  let submitted: boolean
  if (task.programming) {
    const prog = await readProgrammingStatus(jar, $, task)
    status = prog.status
    submitted = prog.submitted
  } else {
    status = pick(['Submission status', '提交状态']) ?? task.status
    /* 不要只认 "Submitted for grading"：老师批改后状态会变成 "Graded"，
       中文站点是"已提交，等待评分"/"已评分"。凡是没出现"未提交"类措辞的都算交过。 */
    submitted = status ? !CITEL_NOT_SUBMITTED.test(status) : task.submitted
  }
  const discountM = /(?:Discount|折扣)\s*[:：]\s*(\d+(?:\.\d+)?)/i.exec(fullText)
  const discount = discountM ? Number(discountM[1]) : null
  const lateM = /(?:Allow late|允许迟交)\s*[:：]\s*(Yes|No|是|否)/i.exec(fullText)
  const allowLate = lateM ? /^(yes|是)$/i.test(lateM[1]) : task.allowLate
  const grade = pick(['Grade', '成绩']) ?? (/Grade\s*:\s*([^/]+?)\s*\/\s*Discount/i.exec(fullText)?.[1]?.trim() ?? null)

  return {
    ...task,
    openTime: pickDate(['Open Time', 'Opened', '开放时间', '开始时间']) ?? task.openTime,
    dueTime: pickDate(['Close Time', 'Due', '截止时间', '到期时间']) ?? task.dueTime,
    discountTime: pickDate(['Time Discount', '折扣时间']) ?? task.discountTime,
    discount,
    allowLate,
    status,
    submitted,
    grade
  }
}

/* ---------------- 编排 ---------------- */

/** 并发受限的 map，保持结果顺序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 全量同步：登录 → 课程 → 各课程作业 → 逐条详情。
 * 单条作业详情失败**不中止**整体同步（保留其余结果），全部失败才抛错。
 */
export async function fetchCitelSnapshot(userId: number, cred: PlatformCred): Promise<CitelSnapshot> {
  const session = await ensureSession(userId, cred)
  const courses = await fetchCourses(session.jar, session.sesskey)
  const perCourse = await mapLimit(courses, DETAIL_CONCURRENCY, (c) => fetchCourseTasks(session.jar, c))
  const allTasks = perCourse.flat()
  /* 2026-10-23 修（评审 B8）：mapLimit 本身没有隔离 —— 一条详情解析失败会让
     Promise.all 整体 reject，与 docstring 承诺的"单条失败不中止整体"相悖
     （一条页面改版 → 全部作业消失）。这里逐条 catch 保留失败前的任务原样；
     会话失效类错误（"重新登录"）仍上抛，让上层引导用户重登。 */
  const tasks = await mapLimit(allTasks, DETAIL_CONCURRENCY, async (t) => {
    try {
      return await fetchTaskDetail(session.jar, t)
    } catch (err) {
      /* 会话失效必须上抛（上层引导重登）；单条解析/网络抖动留原样 */
      if (err instanceof PlatformError && err.code === 'session-expired') throw err
      console.warn(`[citel] 单条作业详情拉取失败（${t.title ?? t.id}）：${err instanceof Error ? err.message : err}`)
      return t
    }
  })
  return { courses, tasks }
}

/** 探测账号能否登录（保存凭据后由路由调用） */
export async function verifyCitelAccount(cred: PlatformCred): Promise<void> {
  const jar = new CookieJar()
  await login(jar, cred)
}
