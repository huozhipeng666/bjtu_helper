/**
 * 智慧教学平台（一体化智慧教学平台）对接。
 *
 * 真实后端是 **http://123.121.147.7:88**（校内 IP + 明文 HTTP），
 * 域名 bksycenter.bjtu.edu.cn / bksy.bjtu.edu.cn 只是跳转中转，且**并非处处可达**。
 *
 * ## 登录方式：不独立登录，复用 MIS 会话做 OAuth2 免登录
 *
 * 该平台**有自己的账号密码登录页**（/ve/，用户名密码走 DES 加密 + 4 位图形验证码），
 * 但实测发现：**平台密码与统一认证（CAS）密码并不一致**，直连密码登录会返回
 * 「账号或密码错误」。真正可靠的路径是 MIS 门户的免登录跳转：
 *
 * ```
 * （前置）MIS 已登录
 * GET  mis.bjtu.edu.cn/module/module/28/
 *   → 302 http://123.121.147.7:88/oauth/api/user/thirdLogin
 *   → 301 https://cas.bjtu.edu.cn/o/authorize?client_id=aqYAshfy…&redirect_uri=…/oauth/token/callBack
 *   → 302 http://123.121.147.7:88/oauth/token/callBack?code=…
 *   → 200 http://123.121.147.7:88/ve/s.shtml?username=<DES密文>&loginType=2&login=main_2
 * ```
 *
 * 落点响应体是一段 JS 跳转到 `…/ve/back/core/main/index.shtml?method=index&type=qxkt`，
 * 同时 `Set-Cookie: JSESSIONID=…` —— 这就是该平台的登录态。
 *
 * > ⚠️ 参考实现（HFDLYS/BJTUselfService）走的是 `mis/module/module/104/`，
 * > 那条路会先经 `bksycenter.bjtu.edu.cn` 再落到 `bksy.bjtu.edu.cn`，
 * > 实测其中转域**从公网不可达**；`module/28` 才是稳定可用的入口。
 *
 * ## 会话机制：除了 Cookie，还要一个 `sessionid` 请求头
 *
 * 跳转成功≠能调接口。必须先用 Cookie 请求
 * `coursePlatform/message.shtml?method=getArticleList`，从返回 JSON 里取 `sessionId`，
 * **之后每个接口都要带 `sessionid: <值>` 头**，否则会被踢回 `/ve/Timeout.jsp`。
 *
 * ## 课表
 *
 * 「本科生院教学服务平台 → 智慧课程平台 → 课表」的抓取见文件末尾的
 * 「课表」小节（`bksyFetchTimetable`）：周次表 `getJxz` + 逐周网格 `skipIndex`。
 */
import * as cheerio from 'cheerio'
import { CookieJar, jarFetch, MisError } from './mis.js'
import type { Period } from './types.js'

export const BKSY_ORIGIN = process.env.BKSY_ORIGIN ?? 'http://123.121.147.7:88'
const BKSY_HOST = new URL(BKSY_ORIGIN).host
/** MIS 门户里"智慧教学平台"模块的入口编号 */
const MIS_BKSY_MODULE = process.env.MIS_BKSY_MODULE ?? '28'

/** 该平台接口统一前缀 */
const API = `${BKSY_ORIGIN}/ve/back`

/** 接口调用必须带的请求头（缺 Referer 或 X-Requested-With 会被判为非页面上下文） */
function apiHeaders(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Referer: BKSY_ORIGIN,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01'
  }
  if (sessionId) h.sessionid = sessionId
  return h
}

/* ---------------- 第 1 步：免登录跳转 ---------------- */

/**
 * 用已登录的 MIS 会话完成智慧教学平台免登录。
 * 成功判据：最终落在平台主机上，且响应体是跳转到 index.shtml 的脚本。
 */
export async function bksySso(jar: CookieJar, misOrigin: string): Promise<void> {
  const page = await jarFetch(jar, `${misOrigin}/module/module/${MIS_BKSY_MODULE}/`)
  if (!page.url.includes(BKSY_HOST)) {
    throw new MisError('智慧教学平台免登录跳转未成功（未落到课程平台），请重新登录 MIS 后再试')
  }
  if (!/index\.shtml/i.test(page.body)) {
    throw new MisError('智慧教学平台跳转异常：未获得登录态，学校系统可能已改版')
  }
}

/* ---------------- 第 2 步：换取 sessionId ---------------- */

/**
 * 取接口所需的 `sessionid`。
 *
 * 为什么单独一步：该平台把「页面会话（JSESSIONID Cookie）」与
 * 「接口会话（sessionId 请求头）」拆成两套，前者靠跳转自动获得，
 * 后者必须显式换取 —— 少了它所有业务接口都会 302 到超时页。
 */
export async function bksySessionId(jar: CookieJar): Promise<string> {
  const res = await jarFetch(jar, `${API}/coursePlatform/message.shtml?method=getArticleList`, {
    headers: apiHeaders()
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  try {
    const json = JSON.parse(res.body) as { sessionId?: string }
    if (json.sessionId) return json.sessionId
  } catch {
    /* 落到下面的统一报错 */
  }
  throw new MisError('智慧教学平台未返回会话标识，请稍后重试')
}

/* ---------------- 第 3 步：学期 / 课程 / 作业 ---------------- */

export interface BksySemester {
  xqCode: string
  name: string
  beginDate: string
  endDate: string
  /** currentFlag===2 表示当前学期（实测：当前学期为 2，历史学期为 1） */
  current: boolean
}

export interface BksyCourse {
  id: number
  courseNum: string
  name: string
  teacherName: string
  teacherId: number | null
  xqCode: string
  fzId: string
}

/** 作业 / 课程设计 / 实验报告 三类共用同一结构，靠 subType 区分 */
export interface BksyHomework {
  /** 作业主键（upId），提交/查看详情都靠它 */
  upId: number
  /** 提交记录 id（snId） */
  snId: number | null
  courseId: number
  courseName: string
  title: string
  content: string
  createDate: string
  openDate: string
  /** 截止时间（平台原始格式，如 2026-10-07 23:00） */
  endTime: string
  status: number
  /** 中文提交状态：已提交 / 未提交 / 待批阅 … */
  subStatus: string
  submitCount: number
  allCount: number
  score: string
  /** 0=作业 1=课程设计 2=实验报告 */
  homeworkType: number
}

function asNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function asStr(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v)
}

/** 解析学期列表（接口公开，无需登录，但登录后同样可用） */
export function parseBksySemesters(json: unknown): BksySemester[] {
  const list = (json as { result?: unknown[] })?.result
  if (!Array.isArray(list)) return []
  const out: BksySemester[] = []
  for (const item of list) {
    const o = item as Record<string, unknown>
    const xqCode = asStr(o.xqCode)
    if (!xqCode) continue
    out.push({
      xqCode,
      name: asStr(o.xqName) || asStr(o.CNAME),
      beginDate: asStr(o.beginDate),
      endDate: asStr(o.endDate),
      current: asNum(o.currentFlag) === 2
    })
  }
  return out
}

/** 解析课程列表 */
export function parseBksyCourses(json: unknown): BksyCourse[] {
  const list = (json as { courseList?: unknown[] })?.courseList
  if (!Array.isArray(list)) return []
  const out: BksyCourse[] = []
  for (const item of list) {
    const o = item as Record<string, unknown>
    const name = asStr(o.name)
    if (!name) continue
    out.push({
      id: asNum(o.id),
      courseNum: asStr(o.course_num),
      name,
      teacherName: asStr(o.teacher_name),
      teacherId: o.teacher_id == null ? null : asNum(o.teacher_id),
      xqCode: asStr(o.xq_code),
      fzId: asStr(o.fz_id)
    })
  }
  return out
}

/** 解析作业列表 */
export function parseBksyHomeworks(json: unknown, homeworkType: number): BksyHomework[] {
  const list = (json as { courseNoteList?: unknown[] })?.courseNoteList
  if (!Array.isArray(list)) return []
  const out: BksyHomework[] = []
  for (const item of list) {
    const o = item as Record<string, unknown>
    const title = asStr(o.title)
    if (!title) continue
    out.push({
      upId: asNum(o.id),
      snId: o.snId == null ? null : asNum(o.snId),
      courseId: asNum(o.course_id),
      courseName: asStr(o.course_name),
      title,
      content: asStr(o.content),
      createDate: asStr(o.create_date),
      openDate: asStr(o.open_date),
      endTime: asStr(o.end_time),
      status: asNum(o.status),
      subStatus: asStr(o.subStatus),
      submitCount: asNum(o.submitCount),
      allCount: asNum(o.allCount),
      score: asStr(o.stu_score),
      homeworkType
    })
  }
  return out
}

/** 拉取学期列表。失败抛 MisError。 */
export async function bksyFetchSemesters(jar: CookieJar, sessionId?: string): Promise<BksySemester[]> {
  const res = await jarFetch(jar, `${API}/rp/common/teachCalendar.shtml?method=queryCurrentXq`, {
    headers: apiHeaders(sessionId)
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  try {
    return parseBksySemesters(JSON.parse(res.body))
  } catch {
    throw new MisError('智慧教学平台学期数据解析失败，学校系统可能已改版')
  }
}

/** 拉取指定学期的课程列表 */
export async function bksyFetchCourses(
  jar: CookieJar,
  sessionId: string,
  xqCode: string
): Promise<BksyCourse[]> {
  const res = await jarFetch(
    jar,
    `${API}/coursePlatform/course.shtml?method=getCourseList&pagesize=100&page=1&xqCode=${encodeURIComponent(xqCode)}`,
    { headers: apiHeaders(sessionId) }
  )
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  try {
    return parseBksyCourses(JSON.parse(res.body))
  } catch {
    throw new MisError('智慧教学平台课程数据解析失败，学校系统可能已改版')
  }
}

/** 拉取某门课的作业 / 课程设计 / 实验报告（subType 0/1/2） */
export async function bksyFetchHomeworks(
  jar: CookieJar,
  sessionId: string,
  courseId: number,
  subType: 0 | 1 | 2
): Promise<BksyHomework[]> {
  const res = await jarFetch(
    jar,
    `${API}/coursePlatform/homeWork.shtml?method=getHomeWorkList&cId=${courseId}&subType=${subType}&page=1&pagesize=100`,
    { headers: apiHeaders(sessionId) }
  )
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  /* 2026-10-23 修（评审 B7）：这里原来是 `catch { return [] }` —— 单门课解析失败
     会被静默吞掉，表现为"这门课的作业无声缺席一次同步"。现在向上抛，
     由 mis.ts 的同步循环逐门收集进 failedCourses（同步结果可见，整体不中断）。 */
  try {
    return parseBksyHomeworks(JSON.parse(res.body), subType)
  } catch {
    throw new MisError('智慧教学平台作业数据解析失败，学校系统可能已改版')
  }
}

/* ==================================================================
 * 课表（「本科生院教学服务平台 → 智慧课程平台 → 课表」）
 * ==================================================================
 *
 * ## 为什么必须用它，而不是继续用教务（AA）课表
 *
 * AA 课表给的是「第 N 周」这种**相对周号**，而「第 N 周是哪几天」要靠
 * 开学日线性推算。学校一放假（放假周不排课、也不算教学周），这条推算就
 * 从放假之后整体错位一周。智慧课程平台的课表页则直接给出**权威周次表**
 * （`getJxz`：每周的起止日期 + 是否有课），周次与日期的对应关系以它为准。
 *
 * ## 接口
 *
 * | 用途 | 请求 |
 * | --- | --- |
 * | 周次表 | `GET /ve/back/rp/common/myTimeTableDetail.shtml?method=getJxz` |
 * | 某一周的网格 | `GET /ve/back/rp/common/myTimeTableDetail.shtml?method=skipIndex&flag=<周号>&begin_time=<该周周一>&sessionId=<平台常量>` |
 *
 * `getJxz` 的返回（实测）：
 * ```json
 * {"flag":true,"jxzList":[
 *   {"WEEK_CODE":"0","BEGIN_DATE":"2026-08-31","END_DATE":"2026-09-06","sfyk":""},
 *   {"WEEK_CODE":"1","BEGIN_DATE":"2026-09-07","END_DATE":"2026-09-13","sfyk":"(有课)"},
 *   ... 第 3 周止于 09-27，第 4 周起于 10-05 —— 国庆周 09-28~10-04 整条缺失 ...
 * ]}
 * ```
 * 注意最后一项 `WEEK_CODE` 是**字符串**，且放假周不是「标记为 0」，而是**整条不存在**。
 *
 * ## 两个实现上的坑
 *
 * 1. **课表页是 GBK 编码**。`jarFetch` 的 `body` 是按 UTF-8 解的，中文会全烂，
 *    所以必须用 `raw` 原始字节 + `TextDecoder('gbk')` 重新解码（见 `decodePage`）。
 * 2. **平台行序 ≠ 本站节次**。平台的大节网格只有 5 行
 *    （`08:00-09:50 / 10:10-12:00 / 10:30-12:20 / 14:10-16:00 / 16:20-18:10`），
 *    且第 2、3 行是**互相重叠**的两个时段。因此按「与本站节次时间重叠最多」推导
 *    （`mapRowToPeriod`），而不是硬编码一张映射表 —— 用户改过节次时间也不会错。
 */

/** 课表页里 `sessionId` 查询参数的常量值（平台自己的链接里写死的，与接口会话 sessionid 无关） */
const TIMETABLE_URL_SESSION = process.env.BKSY_TIMETABLE_URL_SESSION ?? '2021112401'

/** 抓 16 个教学周的并发度。平台是校内单机，压太高会被限流，5 是实测较稳的值。 */
const TIMETABLE_CONCURRENCY = Number(process.env.BKSY_TIMETABLE_CONCURRENCY ?? 5)

/**
 * 解码页面字节。
 *
 * 平台的 JSON 接口是 UTF-8，课表页却是 GBK —— 同一个后端两套编码。
 * 这里先按 UTF-8 试，出现替换字符（U+FFFD）就说明猜错了，改用 GBK 重解。
 */
function decodePage(raw: Buffer): string {
  const utf8 = raw.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(raw)
  } catch {
    return utf8
  }
}

/* ---------------- 周次表 ---------------- */

export interface BksyWeek {
  /** 平台周号：0 = 开学前一周（无课），1..N = 教学周，其后为无课周 */
  week: number
  /** 该周第一天（周一）YYYY-MM-DD */
  beginDate: string
  /** 该周最后一天（周日）YYYY-MM-DD */
  endDate: string
  /** 平台是否标记该周有课（`sfyk` 非空且不是「放假/停课」） */
  hasClass: boolean
}

/**
 * 解析周次表。
 *
 * 判「有课」用的是 `sfyk` 非空，而不是严格等于 `'(有课)'`：
 * 万一响应编码不是我们预期的（GBK/UTF-8 猜错），中文字符会变成乱码，
 * 但「非空」这个判据依然成立 —— 宁可按有课多抓一周（抓回来是空网格，无害），
 * 也不要因为一个字符串比对失败而把整个学期的课全丢了。
 */
export function parseBksyWeekTable(json: unknown): BksyWeek[] {
  const list = (json as { jxzList?: unknown[] })?.jxzList
  if (!Array.isArray(list)) return []
  const out: BksyWeek[] = []
  for (const item of list) {
    const o = item as Record<string, unknown>
    const week = asNum(o.WEEK_CODE, NaN)
    const beginDate = asStr(o.BEGIN_DATE)
    const endDate = asStr(o.END_DATE)
    if (!Number.isInteger(week) || !beginDate || !endDate) continue
    const sfyk = asStr(o.sfyk).trim()
    out.push({ week, beginDate, endDate, hasClass: sfyk !== '' && !/放假|停课/.test(sfyk) })
  }
  return out.sort((a, b) => a.week - b.week)
}

/** 拉取周次表。这是整条课表链路的**权威日期口径**。 */
export async function bksyFetchWeekTable(jar: CookieJar, sessionId?: string): Promise<BksyWeek[]> {
  const res = await jarFetch(jar, `${API}/rp/common/myTimeTableDetail.shtml?method=getJxz`, {
    headers: apiHeaders(sessionId)
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  let weeks: BksyWeek[]
  try {
    weeks = parseBksyWeekTable(JSON.parse(decodePage(res.raw)))
  } catch {
    throw new MisError('智慧教学平台课表周次解析失败，学校系统可能已改版')
  }
  if (weeks.length === 0) throw new MisError('智慧教学平台未返回本学期课表周次')
  return weeks
}

/* ---------------- 逐周网格 ---------------- */

/** 课表网格里的一格（一门课在「某天 × 某个大节」的安排） */
export interface BksyCell {
  /** 平台课程号（如 M108002B），用于与教务课程列表按课程号对齐学分 */
  courseNum: string
  name: string
  teacher: string
  room: string
  /** 1=周一 … 7=周日 */
  dayOfWeek: number
  /** 平台行序（0-based），仅在时间解析失败时兜底 */
  rowIndex: number
  /** 该行的时间文本，如 `08:00- 09:50` */
  timeText: string
}

/** 去掉 `课程：` / `教师：` 这类前缀标签 */
function stripLabel(text: string, label: string): string {
  return text.replace(new RegExp(`^${label}\\s*[:：]\\s*`), '').trim()
}

/**
 * 解析某一周的课表页。
 *
 * DOM 结构（实测）：
 * ```html
 * <ul class="timetable-tabletlist clearfloat">          <!-- 一个大节行 -->
 *   <li class="table-list"><span class="table-listsp1"> 08:00- 09:50</span></li>
 *   <li class="table-list2 nchooseClass">               <!-- 周一这一格 -->
 *     <span class="table-t" onclick="insertOpenCourse('M108002B','...','5994','...')">课程：大学物理（A)Ⅱ</span>
 *     <span class="table-b">教师：范玲</span>
 *     <span class="table-b">班级：2026-2027-1-2M108002B10</span>
 *     <span class="table-m">学生：118人</span>
 *     <span class="table-j">教室：SX203</span>
 *   </li>
 *   ... 共 7 格，依次为周一~周日；没课的格子是空 <li> ...
 * </ul>
 * ```
 * 空格子也照样输出，所以「第几个 `li.table-list2`」就是星期几，不需要读表头日期。
 */
export function parseBksyTimetableWeek(html: string): BksyCell[] {
  const $ = cheerio.load(html)
  const cells: BksyCell[] = []
  $('ul.timetable-tabletlist').each((rowIndex, ul) => {
    const timeText = $(ul).find('li.table-list span.table-listsp1').first().text().replace(/\s+/g, ' ').trim()
    $(ul)
      .children('li.table-list2')
      .each((dayIdx, li) => {
        const $li = $(li)
        const $t = $li.find('span.table-t').first()
        if ($t.length === 0) return
        const m = /insertOpenCourse\(\s*'([^']*)'/.exec($t.attr('onclick') ?? '')
        if (!m) return
        // 教师 / 教室都可能有多个 span（教师、班级同 class），按前缀文本挑
        let teacher = ''
        $li.find('span.table-b').each((_, el) => {
          const t = $(el).text()
          if (t.includes('教师')) teacher = stripLabel(t, '教师')
        })
        let room = ''
        $li.find('span.table-j').each((_, el) => {
          room = stripLabel($(el).text(), '教室')
        })
        cells.push({
          courseNum: m[1],
          name: stripLabel($t.text(), '课程'),
          teacher,
          room,
          dayOfWeek: dayIdx + 1,
          rowIndex,
          timeText
        })
      })
  })
  return cells
}

/** 拉取某一周的课表网格（页面为 GBK，必须按原始字节解码） */
export async function bksyFetchTimetableWeek(jar: CookieJar, sessionId: string, week: BksyWeek): Promise<BksyCell[]> {
  const url =
    `${API}/rp/common/myTimeTableDetail.shtml?method=skipIndex` +
    `&flag=${week.week}&begin_time=${encodeURIComponent(week.beginDate)}&sessionId=${TIMETABLE_URL_SESSION}`
  const res = await jarFetch(jar, url, { headers: apiHeaders(sessionId) })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  return parseBksyTimetableWeek(decodePage(res.raw))
}

/* ---------------- 节次映射 ---------------- */

/** `08:00` → 480（分钟） */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * 把平台的一行时间映射到本站的节次序号：取**时间重叠最多**的那个节次。
 *
 * 为什么不写死映射表：平台的行是「大节」（如 `10:10-12:00`），与本站节次不是一一对应，
 * 且第 2、3 行本身就互相重叠。按重叠量推导既能得到正确结果（实测 5 行 →
 * 本站节次 `[1,2,2,4,5]`），又能在用户自定义过节次时间后依然自洽。
 */
export function mapRowToPeriod(timeText: string, periods: Period[]): number | null {
  const m = /(\d{1,2}:\d{2})\s*[-–—~～]\s*(\d{1,2}:\d{2})/.exec(timeText)
  if (!m) return null
  const start = toMinutes(m[1])
  const end = toMinutes(m[2])
  if (start == null || end == null || end <= start) return null
  let best: { index: number; overlap: number } | null = null
  for (const p of periods) {
    const ps = toMinutes(p.start)
    const pe = toMinutes(p.end)
    if (ps == null || pe == null) continue
    const overlap = Math.min(end, pe) - Math.max(start, ps)
    if (overlap <= 0) continue
    if (!best || overlap > best.overlap) best = { index: p.index, overlap }
  }
  return best ? best.index : null
}

/* ---------------- 聚合：逐周网格 → 课程（含周次集合） ---------------- */

export interface BksyTimetableEntry {
  courseNum: string
  name: string
  teacher: string
  room: string
  /** 1=周一 … 7=周日 */
  dayOfWeek: number
  startPeriod: number
  endPeriod: number
  /** 精确上课周集合（升序去重）—— 由 16 周网格合并而来，天然跳过放假周 */
  weeks: number[]
}

/**
 * 把「每周一抓」的网格合并成课程列表。
 *
 * 聚合键是 `课程号 × 星期 × 平台行序`：同一门课一周内在不同时段出现（如周二讲授课 +
 * 周五习题课）会得到两条记录，这正是课表该有的样子。
 *
 * 教师取**众数**：实测存在同一门课不同周由不同老师上的情况（如管理运筹学
 * 王伶俐 / 孙晚华交替），而本站 Course 只有一个 teacher 字段，取出现最多的那个
 * 最接近事实；教室实测恒定，取众数同样安全。平票时取**最早出现**的那个
 * （即学期第一节课的老师），这比按字典序更符合直觉，也能保证同一份数据每次导入结果一致。
 */
export function buildBksyTimetableCourses(
  weekly: { week: number; cells: BksyCell[] }[],
  periods: Period[]
): BksyTimetableEntry[] {
  interface Acc extends Omit<BksyTimetableEntry, 'weeks'> {
    weeks: Set<number>
    teacherVotes: Map<string, { n: number; first: number }>
    roomVotes: Map<string, { n: number; first: number }>
  }
  const map = new Map<string, Acc>()
  const vote = (votes: Map<string, { n: number; first: number }>, v: string, week: number) => {
    if (!v) return
    const cur = votes.get(v)
    if (cur) cur.n++
    else votes.set(v, { n: 1, first: week })
  }

  for (const { week, cells } of weekly) {
    for (const c of cells) {
      const period = mapRowToPeriod(c.timeText, periods) ?? c.rowIndex + 1
      const key = `${c.courseNum}|${c.dayOfWeek}|${c.rowIndex}`
      let acc = map.get(key)
      if (!acc) {
        acc = {
          courseNum: c.courseNum,
          name: c.name,
          teacher: '',
          room: '',
          dayOfWeek: c.dayOfWeek,
          startPeriod: period,
          endPeriod: period,
          weeks: new Set<number>(),
          teacherVotes: new Map(),
          roomVotes: new Map()
        }
        map.set(key, acc)
      }
      acc.weeks.add(week)
      vote(acc.teacherVotes, c.teacher, week)
      vote(acc.roomVotes, c.room, week)
    }
  }

  const pickMode = (votes: Map<string, { n: number; first: number }>): string => {
    let best = ''
    let bestN = 0
    let bestFirst = Number.POSITIVE_INFINITY
    for (const [v, { n, first }] of votes) {
      if (n > bestN || (n === bestN && first < bestFirst)) {
        best = v
        bestN = n
        bestFirst = first
      }
    }
    return best
  }

  return [...map.values()]
    .map((a) => ({
      courseNum: a.courseNum,
      name: a.name,
      teacher: pickMode(a.teacherVotes),
      room: pickMode(a.roomVotes),
      dayOfWeek: a.dayOfWeek,
      startPeriod: a.startPeriod,
      endPeriod: a.endPeriod,
      weeks: [...a.weeks].sort((x, y) => x - y)
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod || a.name.localeCompare(b.name))
}

/* ---------------- 作业详情：正文 + 老师附件 ---------------- */

/**
 * 老师上传的附件（`picList` 的一项）。
 *
 * ⚠️ `sourcePath` **只用于组装下载请求**，不要出现在界面、日志或错误里 ——
 *   它是平台内部的存储路径（含带签名的目录），对外没有意义。
 */
export interface BksyHomeworkAttachment {
  id: number
  fileName: string
  /** 平台没给大小时为 0（不是"空文件"），前端据此不显示大小 */
  sizeBytes: number
  sourcePath: string
}

export interface BksyHomeworkDetail {
  /** 详情正文；详情接口没给时回落到列表里的 content */
  content: string
  attachments: BksyHomeworkAttachment[]
}

/**
 * 平台 `picList.file_name` 常常不带扩展名（老师上传 `fig2.zip` 后只回 `fig2`），
 * 真实扩展名只在存储路径 `url` 里 —— 从路径补，已带同一扩展名时不重复追加。
 *
 * 扩展名限定 `[A-Za-z0-9]{1,8}`：路径末段可能是 `download.action` 之类，
 * 太长的"扩展名"不是扩展名，补上去只会让文件名更糟。
 */
export function homeworkAttachmentFileName(fileName: string, sourcePath: string): string {
  const clean = sourcePath.split('?')[0].split('#')[0]
  const last = clean.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  const ext = dot >= 0 ? last.slice(dot + 1) : ''
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext)) return fileName
  if (fileName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return fileName
  return `${fileName}.${ext}`
}

/** 从 `picList` 解析附件列表。字段缺失/非法只跳过该项，不整条失败（附件不是关键路径）。 */
export function parseBksyHomeworkAttachments(picList: unknown): BksyHomeworkAttachment[] {
  if (!Array.isArray(picList)) return []
  const out: BksyHomeworkAttachment[] = []
  for (const item of picList) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = asNum(o.id)
    // id=0 的项是平台占位，点了下载会拿到别人作业的附件
    if (!Number.isInteger(id) || id <= 0) continue
    const sourcePath = asStr(o.url)
    const rawName = asStr(o.file_name).replace(/\+/g, ' ').trim() || `附件 ${id}`
    out.push({
      id,
      fileName: homeworkAttachmentFileName(rawName, sourcePath),
      sizeBytes: asNum(o.pic_size),
      sourcePath
    })
  }
  return out
}

/**
 * 解析作业详情响应。
 *
 * STATUS 判据沿用上游：**空** / `'0'` / `'2'` 都算成功（不同学期/版本用不同值），
 * 其余值视为会话失效或平台改版 —— 不能把登录页当"作业没有附件"。
 */
export function parseBksyHomeworkDetail(json: unknown, fallbackContent: string): BksyHomeworkDetail {
  const root = json as Record<string, unknown> | null
  if (!root || typeof root !== 'object') throw new MisError('作业详情解析失败，学校系统可能已改版')
  const status = root.STATUS == null ? '' : String(root.STATUS)
  if (status && status !== '0' && status !== '2') {
    throw new MisError('作业详情获取失败（平台状态 ' + status + '），请重新登录 MIS')
  }
  const detail = root.homeWork as Record<string, unknown> | undefined
  const content = asStr(detail?.content).trim() || fallbackContent
  return { content, attachments: parseBksyHomeworkAttachments(root.picList) }
}

/**
 * 拉取作业详情（正文 + 附件）。
 *
 * `teacherId` 必须传 —— 平台靠 `(id, courseId, teacherId)` 三元组定位，
 * 少了它返回的是空对象而不是报错，最后表现成"作业详情是空的"。
 */
export async function bksyFetchHomeworkDetail(
  jar: CookieJar,
  sessionId: string,
  upId: number,
  courseId: number,
  teacherId: number,
  fallbackContent: string
): Promise<BksyHomeworkDetail> {
  const q = new URLSearchParams({
    method: 'queryStudentCourseNote',
    id: String(upId),
    courseId: String(courseId),
    teacherId: String(teacherId)
  })
  const res = await jarFetch(jar, `${API}/coursePlatform/homeWork.shtml?${q.toString()}`, {
    headers: apiHeaders(sessionId)
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  if (res.body.trim().startsWith('<')) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  try {
    return parseBksyHomeworkDetail(JSON.parse(res.body), fallbackContent)
  } catch (e) {
    if (e instanceof MisError) throw e
    throw new MisError('作业详情解析失败，学校系统可能已改版')
  }
}

/** 附件下载结果（与课件下载同形，便于前端复用同一套保存逻辑） */
export interface BksyAttachmentDownload {
  bytes: Buffer
  contentType: string
  fileName: string
}

/**
 * 下载老师附件。
 *
 * 端点：`GET /ve/back/coursePlatform/dataSynAction.shtml?method=downLoadPic&id=<附件id>&noteId=<作业id>`
 * 响应是二进制流，不是 JSON —— 若拿到 `<` 开头的内容说明被踢回登录页。
 */
export async function bksyDownloadHomeworkAttachment(
  jar: CookieJar,
  sessionId: string,
  upId: number,
  attachmentId: number,
  fileName: string
): Promise<BksyAttachmentDownload> {
  const q = new URLSearchParams({
    method: 'downLoadPic',
    id: String(attachmentId),
    noteId: String(upId)
  })
  const res = await jarFetch(jar, `${API}/coursePlatform/dataSynAction.shtml?${q.toString()}`, {
    headers: apiHeaders(sessionId)
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  if (res.raw.length === 0) throw new MisError('附件内容为空')
  /* 2026-10-23 修（评审 B11）：登录/错误页判定改按 content-type。原判据
     「<512B 且以 < 开头」挡不住大体积 HTML 错误页（会被当附件原样保存）；
     正常附件端点不会返回 text/html，命中即视为会话/权限问题。 */
  const rawCt = (res.response.headers.get('content-type') ?? '').toLowerCase()
  if (rawCt.includes('text/html')) {
    throw new MisError('附件下载失败：会话已失效或附件不可见，请重新登录 MIS')
  }
  // 兜底保留：无 content-type 且内容像 HTML 的小响应（老版本行为）
  if (!rawCt && res.raw.length < 512 && res.raw.toString('utf8').trimStart().startsWith('<')) {
    throw new MisError('附件下载失败：会话已失效，请重新登录 MIS')
  }
  const ct = (rawCt || 'application/octet-stream').split(';')[0]
  return { bytes: res.raw, contentType: ct, fileName }
}

/* ---------------- 编排：周次表 + 全部教学周 ---------------- */

export interface BksyTimetableResult {
  /** 权威周次表（写进学期设置，周/月视图靠它把日期换算成教学周） */
  weeks: BksyWeek[]
  courses: BksyTimetableEntry[]
  /** 教学周总数 = 有课的最大周号 */
  totalWeeks: number
  /** 抓取失败的周号（网络抖动）。非空时前端应提示「数据可能不全」 */
  failedWeeks: number[]
}

/**
 * 拉取整学期课表：先取周次表，再并发抓每个教学周的网格，最后合并成课程。
 *
 * 只抓 `hasClass === true` 的周 —— 开学前一周（`WEEK_CODE=0`）与学期结束后
 * 的空周本来就无课，抓了也是空网格，白费请求。
 */
export async function bksyFetchTimetable(
  jar: CookieJar,
  sessionId: string,
  periods: Period[],
  opts: { concurrency?: number } = {}
): Promise<BksyTimetableResult> {
  const weeks = await bksyFetchWeekTable(jar, sessionId)
  const targets = weeks.filter((w) => w.hasClass)
  if (targets.length === 0) throw new MisError('智慧教学平台本学期课表没有可抓取的周次')

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? TIMETABLE_CONCURRENCY, targets.length))
  const weekly: { week: number; cells: BksyCell[] }[] = []
  const failedWeeks: number[] = []
  let cursor = 0

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= targets.length) return
        const w = targets[i]
        try {
          weekly.push({ week: w.week, cells: await bksyFetchTimetableWeek(jar, sessionId, w) })
        } catch {
          failedWeeks.push(w.week)
        }
      }
    })
  )

  const courses = buildBksyTimetableCourses(weekly, periods)
  const totalWeeks = targets.reduce((m, w) => Math.max(m, w.week), 0)
  return { weeks, courses, totalWeeks, failedWeeks: failedWeeks.sort((a, b) => a - b) }
}
