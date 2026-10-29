/**
 * 教室占用（教务 `room_view`）—— 纯解析 + 常量，不碰网络、不碰数据库。
 *
 * 与 `server/src/classroom.ts` 的「教室人数」是**两个完全不同的功能**，别混：
 *  - 教室人数：第三方 `yaya.csoci.com:2333`，免登录，回答「**此刻**这间教室有多少人」；
 *  - 教室占用：教务 `aa.bjtu.edu.cn/classroom/timeholdresult/room_view/`，要 AA 登录态，
 *    回答「**这一周**这间教室被排课/考试/实验占掉了哪些节次」。
 *
 * 数据形态的证据来自上游 `ClassroomOccupancyHtmlParser.kt`（REA 静态分析）与
 * `ClassroomOccupancyHtmlParserTest.kt` 的夹具；**本次没有真实登录态，表格的实际
 * 列数/底色未经线上核对**，因此解析器对「不像这个表」的输入一律报错而不是猜。
 */

import { mondayFromMicrosoftDate } from './academicCalendar.js'

/**
 * 占用类型。页面图例五种占用 + 空闲 + 未识别。
 * 与上游 `OccupancyKind` 逐项对应，中文标签在 `OCCUPANCY_KIND_LABEL`。
 */
export type OccupancyKind =
  | 'free'
  | 'scheduled'
  | 'rescheduled'
  | 'exam'
  | 'experiment'
  | 'other'
  | 'unknown'

export const OCCUPANCY_KIND_LABEL: Record<OccupancyKind, string> = {
  free: '空闲',
  scheduled: '排课',
  rescheduled: '调课',
  exam: '考试',
  experiment: '实验',
  other: '其他安排',
  unknown: '未知'
}

/**
 * 底色 → 占用类型。色值来自上游 `occupancyKindFromStyle`（它自述已与线上图例核对）。
 *
 * 两个刻意的取舍：
 *  - **没有 background-color 就判空闲**（上游同款）：教务把空闲格渲染成白底，
 *    有的行干脆不写 style；把「没样式」判成 UNKNOWN 会让整张表飘满问号。
 *  - **认不出的新底色判 unknown 而不是空闲**：判空闲会让用户以为教室能用，
 *    判 unknown 至少 UI 能提示「这个格子看不懂」，与人数功能「宁可报错不给错数据」一致。
 */
export function occupancyKindFromStyle(style: string): OccupancyKind {
  // eslint-disable-next-line no-control-regex
  const m = /background-color:\s*(#[0-9a-fA-F]{3,6})/.exec(style)
  if (!m) return 'free'
  switch (m[1].toLowerCase()) {
    case '#fff':
    case '#ffffff':
      return 'free'
    case '#e46868':
      return 'scheduled'
    case '#9e6868':
      return 'rescheduled'
    case '#394ed6':
      return 'exam'
    case '#77bf6d':
      return 'experiment'
    case '#d8cc56':
      return 'other'
    default:
      return 'unknown'
  }
}

/**
 * 教学楼清单：教务 `jxlh` 下拉的全量 35 项，`id` 是**数字 ID 字符串**。
 *
 * 必须传 ID：传中文楼名只会返回表头、查不到任何教室（上游注释明确记录）。
 * 顺序即教务下拉顺序，不要重排 —— 用户按这个顺序找自己的教学楼。
 */
export const OCCUPANCY_BUILDINGS: ReadonlyArray<{ id: string; name: string }> = [
  { id: '13', name: '第十七号教学楼' },
  { id: '100', name: '学生活动服务中心' },
  { id: '1', name: '思源楼' },
  { id: '2', name: '思源西楼' },
  { id: '3', name: '思源东楼' },
  { id: '4', name: '第九教学楼' },
  { id: '5', name: '第八教学楼' },
  { id: '6', name: '第五教学楼' },
  { id: '7', name: '第二教学楼' },
  { id: '11', name: '逸夫教学楼' },
  { id: '12', name: '机械楼' },
  { id: '91', name: '天佑会堂' },
  { id: '92', name: '工程素质' },
  { id: '93', name: '综合实验楼' },
  { id: '94', name: '机械实验馆' },
  { id: '9', name: '东区二教' },
  { id: '8', name: '东区一教' },
  { id: '10', name: '东教三楼' },
  { id: '90', name: '科技大厦' },
  { id: '14', name: '电气工程楼' },
  { id: '101', name: '综合体育馆' },
  { id: '102', name: '新综合体育馆' },
  { id: '16', name: '东校区计算机机房' },
  { id: '15', name: '交通运输科学馆' },
  { id: '17', name: '工程训练中心' },
  { id: '18', name: '第七教学楼' },
  { id: '19', name: '工程结构实验楼' },
  { id: '20', name: '土木工程楼' },
  { id: '103', name: '科技楼' },
  { id: '104', name: '思源楼A座' },
  { id: '105', name: '思源楼B座' },
  { id: '106', name: '致远楼' },
  { id: '107', name: '知行楼' },
  { id: '108', name: '逸夫楼' },
  { id: '109', name: '信息楼' }
]

/** jxlh → 楼名；认不出返回 null（不编造名字）。 */
export function buildingNameOf(id: string): string | null {
  return OCCUPANCY_BUILDINGS.find((b) => b.id === id)?.name ?? null
}

export function isKnownBuildingId(id: string): boolean {
  return OCCUPANCY_BUILDINGS.some((b) => b.id === id)
}

/**
 * 7 个大节的起止时间，index 0 = 第 1 节。来源：aa 学生课表页表头。
 * 每「节」实际是两小节连上，所以是 08:00-09:50 这种两小时段而非 45 分钟。
 */
export const SLOT_TIME_RANGES: readonly string[] = [
  '08:00-09:50',
  '10:10-12:00',
  '12:10-14:00',
  '14:10-16:00',
  '16:20-18:10',
  '19:00-20:50',
  '21:00-21:50'
]

/** 一周固定 7 天 × 7 节。表里每行 = 1 个教室名格 + 49 个占用格。 */
export const OCCUPANCY_ROW_CELLS = 50
export const OCCUPANCY_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const
export const OCCUPANCY_PERIODS = 7

export interface OccupancyRoom {
  room: string
  capacity: number
  /**
   * 49 格，键是 `"<星期1-7>-<节次1-7>"`。缺的格子按空闲处理（见 `occupancyAt`）。
   * 用字符串键而不是嵌套数组：JSON 直传前端，前端取值时不必判空数组。
   */
  cells: Record<string, OccupancyKind>
}

export class ClassroomOccupancyParseError extends Error {
  readonly reason: 'table-missing' | 'malformed-row'
  constructor(reason: 'table-missing' | 'malformed-row', message: string) {
    super(message)
    this.name = 'ClassroomOccupancyParseError'
    this.reason = reason
  }
}

/** 单元格位置键。 */
export function cellKey(weekday: number, period: number): string {
  return `${weekday}-${period}`
}

/** 取某格占用；缺格按空闲。weekday/period 都是 1 起。 */
export function occupancyAt(room: OccupancyRoom, weekday: number, period: number): OccupancyKind {
  return room.cells[cellKey(weekday, period)] ?? 'free'
}

/**
 * 行首形如 `SY101 (90)`：教室号 + 括号容量。容量缺失记 0（不编造）。
 *
 * 上游同样的做法，但这里多守一步：括号里的容量必须紧跟在教室名之后，
 * 因为有的教室名本身带括号（如 `机房(A)`），用贪婪匹配会吞掉名字。
 */
function parseRoomHeader(text: string): { room: string; capacity: number } | null {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const m = /^(.+?)\s*\(\s*(\d+)\s*\)/.exec(cleaned)
  if (m) {
    const room = m[1].trim()
    return room ? { room, capacity: Number(m[2]) } : null
  }
  const room = cleaned.split(' ')[0].trim()
  return room ? { room, capacity: 0 } : null
}

const CELL_TITLE = /星期([一二三四五六日天1-7])\s*第(\d+)节/

/**
 * 从 `title="星期三 第5节"` 取格子位置。
 *
 * 为什么以 title 为准而不是数组下标：上游测试里专门有一条用例证明服务器**不保证**
 * 列顺序（把第 2 格的 title 写成星期日第 7 节，要求仍定位到 7-7）。
 * 按顺序铺开只在 title 缺失时兜底。
 */
function parseCellPosition(title: string): { weekday: number; period: number } | null {
  const m = CELL_TITLE.exec(title.trim())
  if (!m) return null
  let weekday: number
  switch (m[1]) {
    case '一':
    case '1':
      weekday = 1
      break
    case '二':
    case '2':
      weekday = 2
      break
    case '三':
    case '3':
      weekday = 3
      break
    case '四':
    case '4':
      weekday = 4
      break
    case '五':
    case '5':
      weekday = 5
      break
    case '六':
    case '6':
      weekday = 6
      break
    case '日':
    case '天':
    case '7':
      weekday = 7
      break
    default:
      return null
  }
  const period = Number(m[2])
  if (!Number.isInteger(period) || period < 1 || period > OCCUPANCY_PERIODS) return null
  return { weekday, period }
}

/**
 * 表头单元格的文字。`cheerio` 版本不同、DOM 结构也可能不同，
 * 这里只用最小信息：`<th>` 存在即说明是表头行。
 */
function isHeaderRow(rowHtml: string): boolean {
  return /<th[\s>]/i.test(rowHtml)
}

/**
 * 从一段 HTML 里切出所有 `<tr>…</tr>`。
 *
 * 为什么不用 cheerio：本模块要能在没有 DOM 依赖的纯单测里跑（与 `homeStatus.ts`
 * 同样的理由 —— 一 import cheerio 就把整包拉进单测）。表格结构简单且自闭合可控，
 * 正则切片足够，也避免 cheerio 对畸形 HTML 的「自动修复」把我们想报错的输入改成合法。
 */
function splitRows(html: string): string[] {
  const rows: string[] = []
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) rows.push(m[1])
  return rows
}

/** 一行里的所有 `<td>`：返回每格的 style 与 title。 */
function splitCells(rowHtml: string): Array<{ style: string; title: string }> {
  const cells: Array<{ style: string; title: string }> = []
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(rowHtml)) !== null) {
    const attrs = m[1]
    const style = (/\bstyle\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bstyle\s*=\s*'([^']*)'/i.exec(attrs) ?? [])[1] ?? ''
    const title = (/\btitle\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\btitle\s*=\s*'([^']*)'/i.exec(attrs) ?? [])[1] ?? ''
    cells.push({ style, title })
  }
  return cells
}

/** 一格 td 的文字（去标签、压空白）。行首教室名用。 */
function cellText(rowHtml: string): string {
  const m = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml)
  if (!m) return ''
  return m[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface OccupancyParseResult {
  rooms: OccupancyRoom[]
}

/**
 * 解析 `room_view` 的教室占用表。
 *
 * 失败的判定刻意严格（与上游一致）：
 *  - 全文没有一个 `<table>` → `table-missing`。用于区分「页面被踢回登录页」与「这栋楼真没教室」。
 *  - 某行 `<td>` 少于 50 个、或行首教室名解析不出 → `malformed-row`。
 *  - 只有表头 / 空 tbody → **合法空结果**（学校对没排课的楼就返回空表）。
 *
 * 但有一条比上游宽松：某一行 `<td>` 恰好 50 个但格子里没有 `background-color`，
 * 按空闲处理（见 `occupancyKindFromStyle`），不报错。
 */
export function parseClassroomOccupancyTable(html: string): OccupancyParseResult {
  const tableMatch = /<table\b[\s\S]*?<\/table>/i.exec(html) ?? (/<table\b[\s\S]*$/i.exec(html))
  if (!tableMatch) {
    throw new ClassroomOccupancyParseError('table-missing', '教室占用页面里没有找到表格')
  }
  const rooms: OccupancyRoom[] = []
  for (const row of splitRows(tableMatch[0])) {
    if (isHeaderRow(row)) continue
    const cells = splitCells(row)
    if (cells.length === 0) continue
    if (cells.length < OCCUPANCY_ROW_CELLS) {
      throw new ClassroomOccupancyParseError(
        'malformed-row',
        `教室占用表有一行只有 ${cells.length} 个格子（应为 ${OCCUPANCY_ROW_CELLS} 个）`
      )
    }
    const header = parseRoomHeader(cellText(row))
    if (!header) {
      throw new ClassroomOccupancyParseError('malformed-row', '教室占用表有一行的教室名无法识别')
    }
    const map: Record<string, OccupancyKind> = {}
    for (let index = 1; index < OCCUPANCY_ROW_CELLS; index += 1) {
      const cell = cells[index]
      /* 优先按 title 定位；title 缺失/格式不认识时退化为顺序铺开
         （第 index 格 = 星期 (index-1)/7+1 的第 (index-1)%7+1 节）。 */
      const position = parseCellPosition(cell.title) ?? {
        weekday: Math.floor((index - 1) / OCCUPANCY_PERIODS) + 1,
        period: ((index - 1) % OCCUPANCY_PERIODS) + 1
      }
      map[cellKey(position.weekday, position.period)] = occupancyKindFromStyle(cell.style)
    }
    rooms.push({ room: header.room, capacity: header.capacity, cells: map })
  }
  return { rooms }
}

export interface OccupancySemester {
  /** option value，请求时作为 `zxjxjhh`，如 `2025-2026-2-2` */
  id: string
  /** option 显示文本，也是校历周日期 Map 的 key，如 `2025-2026-2` */
  label: string
}

export interface SemesterOptions {
  /** 服务器回填的当前学期；识别不出为 null。**不是**下拉第一项。 */
  selected: OccupancySemester | null
  all: OccupancySemester[]
}

/**
 * 解析 `zxjxjhh` 学期下拉。
 *
 * 最容易踩的坑：**下拉顺序是新到旧，第一项不等于当前学期**。当前学期有两种回填方式：
 *  1. `<option … selected>`
 *  2. 页面脚本 `$("[name=zxjxjhh]").val("2025-2026-2-2")` —— 线上主要用这种，
 *     上游注释明确记录「线上 room_view 页不回填 selected 属性」。
 * 两种都试；都失败返回 selected=null，调用方退化为「只用当前学期」。
 *
 * 找不到 `<select name="zxjxjhh">` 返回 null（调用方按响应异常处理）。
 */
export function parseSemesterOptions(html: string): SemesterOptions | null {
  const selectMatch = /<select\b[^>]*\bname\s*=\s*["']?zxjxjhh["']?[^>]*>([\s\S]*?)<\/select>/i.exec(html)
  if (!selectMatch) return null

  const all: OccupancySemester[] = []
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
  let m: RegExpExecArray | null
  let selected: OccupancySemester | null = null
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    const attrs = m[1]
    const value = (/\bvalue\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bvalue\s*=\s*'([^']*)'/i.exec(attrs) ?? [])[1] ?? ''
    const label = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (!value.trim() || !label) continue
    const item = { id: value.trim(), label }
    all.push(item)
    // `selected` 可以是布尔属性（无值）也可以是 selected="selected"
    if (selected === null && /\bselected\b/i.test(attrs)) selected = item
  }

  if (selected === null) {
    /* 脚本回填：`$("[name=zxjxjhh]").val("2025-2026-2-2")`。
       正则容忍 `[ name = zxjxjhh ]` 这类空格与单双引号。 */
    const scripted = /\[\s*name\s*=\s*["']?zxjxjhh["']?\s*\][^)]*\)\s*\.\s*val\(\s*["']([^"']+)["']\s*\)/i.exec(html)
    if (scripted) {
      const wanted = scripted[1].trim()
      selected = all.find((o) => o.id === wanted) ?? null
    }
  }

  return { selected, all }
}

/* ---------------- 校历周日期（bksy 校历页 → 周次 ↔ 日期） ---------------- */

/** 教务处校历页（公开页，免登录）。与 `academicCalendar.ts` 用的是同一个 URL。 */
export const CALENDAR_PAGE_URL = 'https://bksy.bjtu.edu.cn/Admin/SemesterTranPage.aspx?noRemark=1'

/**
 * 第二学期夏季段在 aa `zc` 里的续编偏移：春季 18 周后从 19 起。
 * 例：春季「第N教学周」→ zc=N；夏季「第N周」（无「教学」二字）→ zc=18+N。
 */
export const SPRING_WEEKS = 18

/** `第N教学周` → N。 */
const WEEK_NUMBER = /第(\d+)教学周/
/** `第N周`（夏季段没有「教学」二字）→ N。 */
const SUMMER_WEEK_NUMBER = /第(\d+)周/
/** 微软 JSON 日期 `/Date(毫秒+0800)/` → 那一周周一。
 * 2026-10-23 修：本文件曾自留一份正则，偏移组要求有符号（`[+-]\d{4}`），
 * 而上方预处理把字面 `+` 换成空格后 `/Date(… 0800)/` 整条匹配失败 → 静默丢周 ——
 * 与 academicCalendar.ts 修过的同一个坑（见其 mondayFromMicrosoftDate 注释）。
 * 现在直接复用那份实现（两文件解析的是同一个 hidJson 字段），消除双份口径。 */
const mondayOfDt = mondayFromMicrosoftDate

export interface OccupancyWeekDate {
  /** aa 的 zc 编号 */
  week: number
  /** 周一日期 `YYYY-MM-DD` */
  monday: string
  /** 周日日期 `YYYY-MM-DD` */
  sunday: string
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** 学期标题 → `2025-2026-2` 这种 label，与 aa 下拉 option 文本一致。 */
function labelFor(isSpring: boolean, baseYear: number): string {
  return `${baseYear}-${baseYear + 1}-${isSpring ? 2 : 1}`
}

const SEMESTER_TITLE = /第\s*([一二])\s*学期\s*[（(]\s*(\d{4})\s*[-–—]\s*(\d{4})\s*学年\s*[)）]/

/** 页面所有 `<input>` 的 (name|id, value)；`hidTitle_<Id>` 只有 id 没有 name。 */
function inputFields(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const inputRe = /<input\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0]
    const name = (/\bname\s*=\s*["']([^"']*)["']/i.exec(tag) ?? [])[1]
    const id = (/\bid\s*=\s*["']([^"']*)["']/i.exec(tag) ?? [])[1]
    const value = (/\bvalue\s*=\s*"([^"]*)"/i.exec(tag) ?? /\bvalue\s*=\s*'([^']*)'/i.exec(tag) ?? [])[1]
    const key = (name ?? '').trim() || (id ?? '').trim()
    if (!key || value === undefined) continue
    out.push([key, value])
  }
  return out
}

/**
 * 解析校历页 `hidJson` → `学期 label` → 周次 ↔ 日期。
 *
 * zc 规则（上游已实测）：
 *  - 第一/二学期春季段 `第N教学周` → zc = N
 *  - 第二学期夏季段 `第N周`（无「教学」二字）→ zc = 18 + N
 *  - `休`、空文本等非周次行 **跳过**（放假周不占 zc 编号）
 *
 * 尽力而为：任何异常都返回空 Map，绝不抛 —— 日期只是 UI 参考，
 * 拿不到不该阻断教室占用查询本身。
 */
export function parseAcademicWeeks(html: string): Map<string, OccupancyWeekDate[]> {
  const result = new Map<string, OccupancyWeekDate[]>()
  let fields: Array<[string, string]>
  try {
    fields = inputFields(html)
  } catch {
    return result
  }
  const payload = fields.find(([k]) => k.toLowerCase() === 'hidjson')?.[1]
  if (!payload) return result

  let decoded: string
  try {
    decoded = decodeURIComponent(payload.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\+/g, ' '))
  } catch {
    return result
  }
  let semesters: unknown
  try {
    semesters = JSON.parse(decoded)
  } catch {
    return result
  }
  if (!Array.isArray(semesters)) return result

  const titles = new Map<number, string>()
  for (const [key, value] of fields) {
    const m = /hidTitle_(\d+)/i.exec(key)
    if (!m) continue
    const id = Number(m[1])
    if (Number.isInteger(id)) titles.set(id, value)
  }

  for (const item of semesters) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const id = typeof obj.Id === 'number' ? obj.Id : Number(obj.Id)
    if (!Number.isInteger(id)) continue
    const title = titles.get(id)
    if (!title) continue
    const titleMatch = SEMESTER_TITLE.exec(title)
    if (!titleMatch) continue
    const isSpring = titleMatch[1] === '二'
    const baseYear = Number(titleMatch[2])
    if (!Number.isInteger(baseYear)) continue
    const rows = obj.Json
    if (!Array.isArray(rows)) continue

    const weeks: OccupancyWeekDate[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const weekText = typeof r.Week === 'string' ? r.Week.trim() : ''
      if (!weekText) continue
      let zc: number | null = null
      const plain = WEEK_NUMBER.exec(weekText)
      if (plain) {
        zc = Number(plain[1])
      } else if (isSpring) {
        const summer = SUMMER_WEEK_NUMBER.exec(weekText)
        if (summer) zc = Number(summer[1]) + SPRING_WEEKS
      }
      if (zc === null || !Number.isInteger(zc)) continue
      const dt = typeof r.DT === 'string' ? r.DT : ''
      const monday = mondayOfDt(dt)
      if (!monday) continue
      weeks.push({ week: zc, monday, sunday: addDaysIso(monday, 6) })
    }
    if (weeks.length > 0) {
      weeks.sort((a, b) => a.week - b.week)
      result.set(labelFor(isSpring, baseYear), weeks)
    }
  }
  return result
}
