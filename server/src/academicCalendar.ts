/**
 * 校历（学业日历）—— 学校公布的**权威**教学周来源。
 *
 * ## 为什么要有这个模块
 *
 * 项目里判断"今天是第几教学周"历来靠两种信息：用户手填的学期起始日，
 * 或者智慧教学平台（bksy）返回的周表。前者一旦填错就永远差一周；
 * 后者只知道"有没有课"，**不知道放假周**（国庆、校运会那几周仍然算教学周）。
 *
 * 学校在 `bksy.bjtu.edu.cn/Admin/SemesterTranPage.aspx` 上公开了完整的
 * 学业日历：每一周是不是教学周、是不是"休"（放假），以及每周的周一日期。
 * 这个接口**免登录**（`executePublic`，上游也这么用），可以直接作为唯一权威源。
 *
 * ## 数据形态（2026-10-20 线上实测）
 *
 * 页面里有若干隐藏字段：
 *   - `hidJson`      URL 编码的 JSON 数组，每项 `{ Id, Json: [周…] }`
 *   - `hidTitle_<Id>` 该学期的标题，如「第一学期（2026-2027学年）」
 *
 * 每个周项的关键字段：
 *   - `DT`   `/Date(1788710400000+0800)/` —— 那一周**周一**的时间戳（含 +0800 偏移）
 *   - `Week` `第1教学周` / `第2教学周` / **`休`** / `''`（假期或不排课的整周）
 *   - `Mon`..`Sun` 该周周一到周日的**日号**（几号）
 *
 * 注意 `DT` 是"周一 00:00 +0800"的毫秒值。`+0800` 是**必须**参与运算的：
 * 直接 `new Date(millis).getUTCDate()` 在 UTC 下会算成前一天（周日）。
 * 这里的做法是加 8 小时后按 UTC 取日期 —— 与上游 `ClassroomOccupancyHtmlParser` 一致。
 */

/**
 * 一周的学业日历状态。
 *
 * - `teaching` 正常教学周（`Week` 形如「第N教学周」）
 * - `holiday`  放假周（`Week` 恰为「休」）
 * - `gap`      `Week` 为空 —— 寒暑假、开学前等"没有周号"的时段
 */
export type AcademicWeekKind = 'teaching' | 'holiday' | 'gap'

export interface AcademicWeek {
  /** 教学周号；非教学周为 null（**不是 0**，0 在别处代表"开学前"） */
  teachingWeek: number | null
  kind: AcademicWeekKind
  /** 该周周一 YYYY-MM-DD */
  monday: string
  /** 该周周日 YYYY-MM-DD */
  sunday: string
  /** 平台原始周标签（`第3教学周` / `休` / 空串），排错时用 */
  raw: string
}

export interface AcademicSemester {
  /** 平台内部 Id（`hidTitle_49` 的 49） */
  id: number
  /** 「第一学期（2026-2027学年）」 */
  title: string
  /** 2026-2027 这种学年串，解析不出则空串 */
  academicYear: string
  /** 1=秋（第一学期）2=春（第二学期），解析不出则 0 */
  term: number
  weeks: AcademicWeek[]
}

export class AcademicCalendarParseError extends Error {
  readonly reason: string
  constructor(reason: string, message?: string) {
    super(message ?? `校历解析失败：${reason}`)
    this.name = 'AcademicCalendarParseError'
    this.reason = reason
  }
}

/** 「第一学期（2026-2027学年）」→ { term: 1, academicYear: '2026-2027' } */
const TITLE_RE = /第\s*([一二])\s*学期\s*[（(]\s*(\d{4})\s*[-–—]\s*(\d{4})\s*学年\s*[)）]/
const TERM_CN: Record<string, number> = { 一: 1, 二: 2 }

function parseTitle(title: string): { term: number; academicYear: string } {
  const m = TITLE_RE.exec(title)
  if (!m) return { term: 0, academicYear: '' }
  return { term: TERM_CN[m[1]] ?? 0, academicYear: `${m[2]}-${m[3]}` }
}

/**
 * `/Date(1788710400000+0800)/` → 那一周周一的 `YYYY-MM-DD`。
 *
 * 两步都不能省：
 *   ① 剥出毫秒与偏移。偏移的 `+` 在 `application/x-www-form-urlencoded`
 *      解码后可能变成**空格**（`+` 的遗留含义），所以毫秒与偏移之间允许空白。
 *      只用 `trim()` 是不够的 —— 那个空格在串**中间**。
 *   ② **加**上偏移再按 UTC 取日期。不加的话 00:00+0800 是前一天 16:00 UTC，
 *      取出来会整体早一天 —— 那一周的周一就变成了周日。
 */
export function mondayFromMicrosoftDate(raw: string): string | null {
  /* `[+-]?` 里的问号是必须的：`+` 被 form-urlencoded 解码成空格之后，
     剩下的只有 `0800` 这个**没有符号**的偏移。早前的正则要求必须有 `+`/`-`，
     于是 `/Date(1788710400000 0800)/` 整条匹配失败、返回 null，
     调用方 `if (!monday) continue` 会**静默跳过整周** —— 表现为"某几周凭空消失"。
     没有符号时按东八区（正偏移）解释。 */
  const m = /\/Date\(\s*(-?\d+)\s*([+-]?\d{4})?\s*\)\//.exec(raw.trim())
  if (!m) return null
  const millis = Number(m[1])
  if (!Number.isFinite(millis)) return null
  let offsetMinutes = 0
  if (m[2]) {
    const sign = m[2].startsWith('-') ? -1 : 1
    const digits = m[2].replace(/^[+-]/, '')
    const hh = Number(digits.slice(0, 2))
    const mm = Number(digits.slice(2, 4))
    offsetMinutes = sign * (hh * 60 + mm)
  }
  const shifted = new Date(millis + offsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

/** `第3教学周` → 3；其它（`休` / `''` / 乱码）→ null */
export function teachingWeekOf(raw: string): number | null {
  const m = /第\s*(\d+)\s*教学周/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

function kindOf(raw: string, teachingWeek: number | null): AcademicWeekKind {
  if (teachingWeek !== null) return 'teaching'
  /* 「休」是学校明确标注的放假周（国庆、校运会）。空串是"这一段没有周号"，
     两者对使用者的含义完全不同：前者是"本来该上课但放假"，后者是"压根不是学期内"。
     混成一个值会让"本周是放假周"这种提示永远说不准。 */
  return raw.trim() === '休' ? 'holiday' : 'gap'
}

/** 从 HTML 里抠出所有 `hidTitle_<Id>` 的 Id → 标题映射 */
function parseTitles(html: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /id=["']hidTitle_(\d+)["'][^>]*value=["']([^"']*)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    out.set(Number(m[1]), decodeEntities(m[2]))
  }
  /* value 属性也可能写在 id 前面，两种顺序都要认 */
  const re2 = /value=["']([^"']*)["'][^>]*id=["']hidTitle_(\d+)["']/g
  while ((m = re2.exec(html)) !== null) {
    const id = Number(m[2])
    if (!out.has(id)) out.set(id, decodeEntities(m[1]))
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

interface RawWeekItem {
  DT?: unknown
  Week?: unknown
}

interface RawGroup {
  Id?: unknown
  Json?: unknown
}

/**
 * 解析校历页 HTML。
 *
 * 返回**全部**学期（最新在前，与页面顺序一致）。调用方通常只关心第一个，
 * 但教室占用 / 课表历史周次会需要老学期，所以不在这里裁剪。
 *
 * `hidJson` 缺失或整体不是数组 → 抛 `AcademicCalendarParseError`。
 * 单个周项坏掉只跳过该项（学校偶尔会有 `DT` 为空的脏数据，
 * 不该让整页作废 —— 那会导致"本周是第几周"直接不可用）。
 */
export function parseAcademicCalendar(html: string): AcademicSemester[] {
  const m = /id=["']hidJson["'][^>]*value=["']([^"']*)["']/.exec(html)
    ?? /value=["']([^"']*)["'][^>]*id=["']hidJson["']/.exec(html)
  if (!m) throw new AcademicCalendarParseError('missing-hidjson', '校历页面里找不到 hidJson 字段，学校模板可能已改版')

  let decoded = decodeEntities(m[1])
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    /* 没编码过就直接用（学校有时两种都出现过） */
  }

  let groups: unknown
  try {
    groups = JSON.parse(decoded)
  } catch {
    throw new AcademicCalendarParseError('bad-json', '校历 hidJson 不是合法 JSON')
  }
  if (!Array.isArray(groups)) {
    throw new AcademicCalendarParseError('not-array', '校历 hidJson 根节点不是数组')
  }

  const titles = parseTitles(html)
  const out: AcademicSemester[] = []

  for (const g of groups as RawGroup[]) {
    const id = Number(g?.Id)
    if (!Number.isInteger(id)) continue
    const items = Array.isArray(g?.Json) ? (g.Json as RawWeekItem[]) : []
    const weeks: AcademicWeek[] = []
    for (const it of items) {
      const dt = typeof it?.DT === 'string' ? it.DT : ''
      const rawWeek = typeof it?.Week === 'string' ? it.Week : ''
      const monday = dt ? mondayFromMicrosoftDate(dt) : null
      if (!monday) continue
      const teachingWeek = teachingWeekOf(rawWeek)
      const sunday = addDaysIso(monday, 6)
      weeks.push({ teachingWeek, kind: kindOf(rawWeek, teachingWeek), monday, sunday, raw: rawWeek })
    }
    if (weeks.length === 0) continue
    const title = titles.get(id) ?? ''
    const { term, academicYear } = parseTitle(title)
    out.push({ id, title, academicYear, term, weeks })
  }

  if (out.length === 0) {
    throw new AcademicCalendarParseError('empty', '校历页面解析不出任何学期数据')
  }
  return out
}

function addDaysIso(iso: string, n: number): string {
  const [y, mo, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** 在某一学期里按日期定位所在周；不在范围内 → null */
export function weekAtDate(sem: AcademicSemester, isoDate: string): AcademicWeek | null {
  for (const w of sem.weeks) {
    if (isoDate >= w.monday && isoDate <= w.sunday) return w
  }
  return null
}

/** 该学期第一个教学周的周一 —— 就是"学期第一周周一"，可直接填进 settings.semester.startDate */
export function firstTeachingMonday(sem: AcademicSemester): string | null {
  const w = sem.weeks.find((x) => x.kind === 'teaching')
  return w ? w.monday : null
}

/** 教学周总数（`第N教学周` 里最大的 N，不数数组长度 —— 中间可能有脏数据被跳过） */
export function totalTeachingWeeks(sem: AcademicSemester): number {
  let max = 0
  for (const w of sem.weeks) {
    if (w.teachingWeek !== null && w.teachingWeek > max) max = w.teachingWeek
  }
  return max
}

/**
 * 学年/学期是否"看起来像当前学期"。
 *
 * 判断依据是**今天落在某一周里**，而不是标题字面匹配 —— 后者在跨年
 * （1 月还属于秋季学期）时会错。
 */
export function semesterContaining(sems: AcademicSemester[], isoDate: string): AcademicSemester | null {
  for (const s of sems) {
    if (weekAtDate(s, isoDate)) return s
  }
  return null
}

/* ======================= 网络抓取 ======================= */

/** 校历页面地址（免登录，上游同样用 `executePublic` 口径） */
export const ACADEMIC_CALENDAR_URL = 'https://bksy.bjtu.edu.cn/Admin/SemesterTranPage.aspx?noRemark=1'

/**
 * 超时 9 秒。
 *
 * 实测这个页面有 690KB+（29 个学期的全部周数据都塞在一个字段里），校内
 * 直连 300ms 左右，但校外经代理可能到 3-5 秒。设 9 秒是为了给校外留够
 * 余量，又不至于让用户在"检查校历"上等太久 —— 它只是首页/课表的一个
 * 辅助信息，不是主流程。
 */
const CALENDAR_FETCH_TIMEOUT_MS = 9_000

/**
 * 拉取并解析学业日历。
 *
 * 语义与 `classroom.ts` 的 `fetchClassroomCapacity` 保持一致：**不缓存**，
 * 失败抛带中文文案的 Error（路由层统一 502）。理由：校历一学期只变几次，
 * 但它决定"今天是第几周"，缓存出错会连带课表、DDL 一起错，宁可失败可见。
 *
 * `redirect: 'manual'` 是刻意为之：这个 URL 是 https，若被重定向到明文
 * http 就等于降级，必须拒绝而不是静默跟随。
 */
export async function fetchAcademicCalendar(now: Date = new Date()): Promise<{
  semesters: AcademicSemester[]
  current: AcademicSemester | null
  week: AcademicWeek | null
  today: string
}> {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALENDAR_FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(ACADEMIC_CALENDAR_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        /* 学校站点对没有 UA 的请求偶尔返回空白页，补一个常规浏览器 UA */
        'User-Agent': 'Mozilla/5.0 (compatible; bjtu-helper/0.1)'
      },
      redirect: 'manual',
      signal: controller.signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('校历服务响应超时，请稍后重试')
    }
    throw new Error('无法访问学校校历服务（bksy.bjtu.edu.cn），请检查网络')
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new Error('校历服务返回了重定向，已按安全策略拒绝')
  }
  if (!res.ok) {
    throw new Error(`校历服务返回 HTTP ${res.status}`)
  }

  const html = await res.text()
  const semesters = parseAcademicCalendar(html)
  const current = semesterContaining(semesters, today)
  const week = current ? weekAtDate(current, today) : null
  return { semesters, current, week, today }
}
