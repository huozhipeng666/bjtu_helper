/**
 * 物理在线（https://phyvlab.bjtu.edu.cn，Moodle）客户端。
 *
 * 协议来源：上游 `v1.8.5-EmergencyFix2` 的 `PhyVlabSessionProtocol` /
 * `SchoolPhyVlabRemoteDataSource` / `PhyVlabHtmlParserKt`（REA 静态分析）。
 *
 * ## 登录（Moodle 标准表单，独立账号）
 *  1. GET `/login/index.php` → `form#login` 的隐藏字段（logintoken 必须非空）
 *  2. POST 隐藏字段 + username + password（带 Referer / Origin）
 *  3. 验登录态：后续页面含退出链接 / usermenu / 「您已经以…身份登录」
 *
 * ## 数据
 *  - 课程：`/my/courses.php`，卡片 `[data-region=course-content]`，
 *    课号取 `data-course-id`，课名取 `.multiline`（旧版布局走链接回退）
 *  - 作业活动：`/course/view.php?id=N` 的 `li.activity.modtype_assign`
 *  - 作业详情：`/mod/assign/view.php?id=N` 的提交状态表
 *  - 日历事件：`/calendar/view.php?view=month&time=<epoch>` 的 `td.day.hasevent`
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
  PlatformSessionPool,
  type AnyCheerio
} from './platformHttp.js'

/* 物理在线只对校园网开放（公网服务器直连被防火墙丢包），且站点要求历史版本 TLS 重协商 */
const PHYVLAB_FETCH = { preferRelay: true, legacyTls: true } as const

const ORIGIN = 'https://phyvlab.bjtu.edu.cn'
const LOGIN_URL = `${ORIGIN}/login/index.php`
const COURSES_URL = `${ORIGIN}/my/courses.php`

export interface PlatformCred {
  username: string
  password: string
}

export interface PhyVlabCourse {
  id: number
  name: string
  category: string
  courseUrl: string
}

export interface PhyVlabActivity {
  id: number
  courseId: number
  courseName: string
  title: string
  url: string
  /** 页面上的开放时间文字（原样保留，解析失败也有个东西显示） */
  openText: string | null
  dueText: string | null
  dueTimestamp: number | null
  completed: boolean
}

export interface PhyVlabAssignmentDetail {
  activityId: number
  /** 提交状态原文，如 "Submitted for grading" / "No attempt" */
  submissionStatus: string | null
  /** 成绩文字，如 "85 / 100"；没有则 null */
  gradeText: string | null
  /** 能否编辑/提交（页面出现编辑入口） */
  canEdit: boolean
  canSubmit: boolean
  /** 附件文件名列表（已提交的文件） */
  files: string[]
}

export interface PhyVlabSnapshot {
  courses: PhyVlabCourse[]
  activities: PhyVlabActivity[]
}

interface PhyVlabSession {
  jar: CookieJar
  lastUsedAt: number
  credFingerprint: string
  username: string
}

const pool = new PlatformSessionPool<PhyVlabSession>('phyvlab')

function fail(message: string, code: 'login-failed' | 'session-expired' | 'parse' | 'unavailable' = 'parse'): never {
  throw new PlatformError(message, code)
}

function credFingerprintOf(cred: PlatformCred): string {
  return `${cred.username}\u0000${cred.password}`
}

/* ---------------- 登录 ---------------- */

/** 上游 isPhyVlabAuthenticatedPage 的等价移植 */
function isAuthenticatedPage(url: string, body: string): boolean {
  if (!url.startsWith(ORIGIN)) return false
  const $ = cheerio.load(body)
  if ($("a[href*='/login/logout.php']").length > 0) return true
  if ($("[data-region='usermenu']").length > 0) return true
  if ($("a[href='/user/profile.php']").length > 0) return true
  const text = ($('title').text() ?? '') + ' ' + ($('body').text() ?? '')
  return text.includes('您已经以') && text.includes('身份登录')
}

async function login(jar: CookieJar, cred: PlatformCred): Promise<void> {
  jar.clear()
  const page = await platformFetch(jar, LOGIN_URL, {}, PHYVLAB_FETCH)
  if (looksLikeSessionExpired(page) && !page.body.includes('logintoken')) {
    fail('物理在线登录页暂时无法访问', 'unavailable')
  }
  const $ = cheerio.load(page.body)
  const form = $('form#login')
  if (form.length === 0) fail('物理在线登录页面格式发生了变化', 'parse')
  const action = form.attr('action') ?? ''
  /* action 必须解析回登录页本身；出现跨站 action 一律拒绝（防钓鱼式改版） */
  if (action && new URL(action, LOGIN_URL).toString().split('?')[0] !== LOGIN_URL) {
    fail('物理在线登录地址异常', 'unavailable')
  }
  const fields: Record<string, string> = {}
  form.find('input[type=hidden][name]').each((_, el) => {
    const name = $(el).attr('name') ?? ''
    if (name) fields[name] = $(el).attr('value') ?? ''
  })
  if (!fields.logintoken) fail('物理在线登录令牌缺失，请稍后重试', 'parse')

  const res = await platformFetch(
    jar,
    LOGIN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: LOGIN_URL,
        Origin: ORIGIN
      },
      body: formEncode({ ...fields, username: cred.username, password: cred.password })
    },
    PHYVLAB_FETCH
  )
  if (res.status >= 400) fail(`物理在线登录请求失败（HTTP ${res.status}）`, 'unavailable')
  /* Moodle 登录失败 = 200 停在本页；成功 = 302。逐一验到课程页为止。 */
  const check = await platformFetch(jar, COURSES_URL, {}, PHYVLAB_FETCH)
  if (!isAuthenticatedPage(check.url, check.body)) {
    fail('物理在线登录失败，请检查物理在线独立账号密码', 'login-failed')
  }
}

async function ensureSession(userId: number, cred: PlatformCred): Promise<PhyVlabSession> {
  const fp = credFingerprintOf(cred)
  const cached = pool.get(userId, fp)
  if (cached) return cached
  const jar = new CookieJar()
  await login(jar, cred)
  const session: PhyVlabSession = { jar, lastUsedAt: Date.now(), credFingerprint: fp, username: cred.username }
  pool.put(userId, session)
  return session
}

/* ---------------- 数据 ---------------- */

async function authGet(jar: CookieJar, url: string): Promise<string> {
  const res = await platformFetch(jar, url, { headers: { Referer: COURSES_URL } }, PHYVLAB_FETCH)
  if (!isAuthenticatedPage(res.url, res.body)) {
    fail('物理在线登录已失效，请刷新重试', 'session-expired')
  }
  return res.body
}

async function fetchCourses(jar: CookieJar): Promise<PhyVlabCourse[]> {
  const html = await authGet(jar, COURSES_URL)
  const $ = cheerio.load(html)
  const courses: PhyVlabCourse[] = []
  const seen = new Set<number>()

  const cards = $("[data-region='course-content']")
  if (cards.length > 0) {
    cards.each((_, card) => {
      const id = Number($(card).attr('data-course-id'))
      if (!Number.isInteger(id) || seen.has(id)) return
      let name = ($(card).find('a.aalink.coursename .multiline').first().text() ?? '').trim()
      if (!name) name = ($(card).find('a.aalink.coursename').first().text() ?? '').trim()
      if (!name) return
      const category = ($(card).find('.categoryname').first().text() ?? '').trim()
      const href = ($(card).find('a.aalink.coursename').first().attr('href') ?? '').trim()
      const courseUrl = href
        ? href.startsWith('https://') ? href : href.startsWith('/') ? ORIGIN + href : ''
        : ''
      if (!courseUrl) return
      seen.add(id)
      courses.push({ id, name, category, courseUrl })
    })
    if (courses.length > 0) return courses
  }
  /* 旧版布局回退：全页面扫描课程链接 */
  $("a[href*='/course/view.php?id=']").each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim()
    const m = /[?&]id=(\d+)/.exec(href)
    if (!m) return
    const id = Number(m[1])
    if (!Number.isInteger(id) || seen.has(id)) return
    let name = ($(a).find('.multiline').first().text() ?? '').trim()
    if (!name) name = ($(a).text() ?? '').trim()
    if (!name) return
    const courseUrl = href.startsWith('https://') ? href : href.startsWith('/') ? ORIGIN + href : ''
    if (!courseUrl) return
    seen.add(id)
    courses.push({ id, name, category: '', courseUrl })
  })
  return courses
}

/** 活动日期文字：在 [data-region=activity-dates] 里找 label 匹配的 strong */
function activityDateText($: cheerio.CheerioAPI, li: AnyCheerio, label: string): string | null {
  let found: string | null = null
  li.find("[data-region='activity-dates'] strong").each((_, strong) => {
    if (found) return
    const text = ($(strong).text() ?? '').trim().replace(/[:：]+$/, '')
    if (text !== label) return
    const parent = $(strong).parent()
    let value = (parent.text() ?? '').replace(/\u00a0/g, ' ').trim()
    if (value.startsWith(`${label}：`)) value = value.slice(label.length + 1).trim()
    else if (value.startsWith(`${label}:`)) value = value.slice(label.length + 1).trim()
    if (value) found = value
  })
  return found
}

/** "2025年10月1日 18:00" / "2025年10月1日 星期三 18:00" → epoch 秒（UTC+8） */
export function parsePhyVlabTimestamp(text: string): number | null {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+[^\d\s]+)?\s+(\d{1,2}):(\d{2})/.exec(text)
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 1000) - 8 * 3600
}

async function fetchActivities(jar: CookieJar, course: PhyVlabCourse): Promise<PhyVlabActivity[]> {
  const html = await authGet(jar, `${ORIGIN}/course/view.php?id=${course.id}`)
  const $ = cheerio.load(html)
  const out: PhyVlabActivity[] = []
  const seen = new Set<number>()
  $('li.activity.modtype_assign').each((_, li) => {
    const idAttr = $(li).attr('data-id')
    let id = Number(idAttr)
    const a = $(li).find("a.aalink[href*='/mod/assign/view.php']").first()
    const href = (a.attr('href') ?? '').trim()
    if (!Number.isInteger(id) || !href) {
      const m = /[?&]id=(\d+)/.exec(href)
      if (!m) return
      id = Number(m[1])
    }
    if (seen.has(id)) return
    const title = ($(li).find('.instancename').first().text() ?? '').trim()
    if (!title) return
    const url = href.startsWith('https://') ? href : ORIGIN + href
    const openText = activityDateText($, $(li), '开放时间') ?? activityDateText($, $(li), 'Opened')
    const dueText = activityDateText($, $(li), '截止时间') ?? activityDateText($, $(li), 'Due')
    /* 完成状态看按钮的 data-toggletype，**不是看按钮存不存在**。
       课程页给每个开了"手动完成跟踪"的活动都渲染一个 toggle 按钮：
       未完成时 data-toggletype="manual:mark-done"、文字「标记完成」；
       已完成时是 "manual:mark-undone"、文字「标记为未完成」。
       此前写成「按钮存在即完成」，于是所有作业都显示已完成 —— 线上就是这么报的。 */
    const toggle = $(li).find("button[data-action='toggle-manual-completion']").first()
    const toggleType = toggle.attr('data-toggletype') ?? ''
    const toggleText = (toggle.text() ?? '').trim()
    const completed =
      toggleType.includes('mark-undone') || /标记为未完成|已完成|Mark as not done/i.test(toggleText)
    seen.add(id)
    out.push({
      id,
      courseId: course.id,
      courseName: course.name,
      title,
      url,
      openText,
      dueText,
      dueTimestamp: dueText ? parsePhyVlabTimestamp(dueText) : null,
      completed
    })
  })
  return out.sort((a, b) => a.id - b.id)
}

async function fetchAssignmentDetail(jar: CookieJar, activity: PhyVlabActivity): Promise<PhyVlabAssignmentDetail> {
  const html = await authGet(jar, activity.url)
  const $ = cheerio.load(html)
  const statusEl = $('.submissionstatus, [data-region=\'submission-status\']').first()
  const submissionStatus = statusEl.length > 0 ? (statusEl.text() ?? '').replace(/\s+/g, ' ').trim() : null

  let gradeText: string | null = null
  $("div.submissionstatustable tr, table.submissionstatustable tr, div.gradingsummarytable tr, table.gradingsummarytable tr").each((_, tr) => {
    const cells = $(tr).find('th, td')
    if (cells.length < 2) return
    const key = (cells.eq(0).text() ?? '').trim()
    if (/成绩|Grade/i.test(key)) gradeText = (cells.eq(1).text() ?? '').replace(/\s+/g, ' ').trim() || null
  })

  const files: string[] = []
  $(".submissionstatussubmitted .files a, .assignsubmission_file .files a, .submissionstatustable a[href*='/pluginfile.php']").each((_, a) => {
    const name = ($(a).text() ?? '').trim()
    if (name && !files.includes(name)) files.push(name)
  })

  const canEdit = $("input[name=action][value=editsubmission], a[href*='action=editsubmission']").length > 0
  const canSubmit = $("input[name=action][value=submit], a[href*='action=submit']").length > 0
  return { activityId: activity.id, submissionStatus, gradeText, canEdit, canSubmit, files }
}

/* ---------------- 编排 ---------------- */

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

/** 全量同步：登录 → 课程 → 各课程作业活动 */
export async function fetchPhyVlabSnapshot(userId: number, cred: PlatformCred): Promise<PhyVlabSnapshot> {
  const session = await ensureSession(userId, cred)
  const courses = await fetchCourses(session.jar)
  const perCourse = await mapLimit(courses, 3, (c) => fetchActivities(session.jar, c))
  return { courses, activities: perCourse.flat() }
}

/** 单个作业的提交状态/成绩详情 */
export async function fetchPhyVlabAssignmentDetail(
  userId: number,
  cred: PlatformCred,
  activityId: number
): Promise<PhyVlabAssignmentDetail> {
  const session = await ensureSession(userId, cred)
  /* 2026-10-23 修（评审 B9）：snapshot 的真实错误不能吞成"找不到作业" ——
     session-expired / 网络失败被 `.catch(() => ({courses:[],activities:[]}))`
     吃掉后，用户看到的"找不到编号为 X 的作业"会误导排查方向。
     现在只有"作业列表里确实没有这一条"才报找不到；snapshot 自身的错误原样上抛。 */
  const { activities } = await fetchPhyVlabSnapshot(userId, cred)
  const activity = activities.find((a) => a.id === activityId)
  if (!activity) fail(`找不到编号为 ${activityId} 的作业`, 'parse')
  return fetchAssignmentDetail(session.jar, activity)
}

/** 探测账号能否登录（保存凭据后由路由调用） */
export async function verifyPhyVlabAccount(cred: PlatformCred): Promise<void> {
  const jar = new CookieJar()
  await login(jar, cred)
}
