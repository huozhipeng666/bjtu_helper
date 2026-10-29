/**
 * 物理实验 / 演示实验 → 课表（courses）与 DDL（tasks）的**转换规则**。
 *
 * ## 为什么要有这一层
 *
 * 实验数据是「具体日期 + 第几节」模型（见 platformPhysicslab / platformPhydemo），
 * 而课表是「周几 + 第几大节 + 周次区间」模型。两种模型之间没有天然对应关系，
 * 转换时每一个判断都会直接影响用户「按错时间去实验室」，所以规则集中在这里、
 * 用纯函数实现、由脚本单测覆盖，而不是散在路由里。
 *
 * ## 三条硬规则
 *
 * 1. **节次映射按用户自己的作息表**（`settings.periods`），不写死学校节次表。
 *    用户可以在设置里改每节课的起止时间（比如中午连堂），实验时段落在哪个大节
 *    必须跟着他的设置走 —— 写死一张表的话，改过作息的人看到的就是错的时间。
 *
 * 2. **周次一律查学期周次表**（`resolveSemesterWeek`），不做 `日期差 / 7` 线性推算。
 *    国庆这类放假周会让线性推算整体错位一周，实验恰好排在那几周时最容易被推到错误的周。
 *
 * 3. **放假周 / 学期外的实验不硬塞进课表**。它没有可指的教学周号，塞进去只会显示在
 *    错误的周。这种情况返回 `null`，由调用方降级为「只加 DDL」并如实告知用户。
 *
 * ⚠️ 本文件**刻意不 import './db.js'**（与 terms.ts / semesterDefaults.ts 同一约束）：
 *    测试脚本与迁移脚本都要直接 import 它，而 db.js 一被 import 就会打开数据库文件。
 */
import { resolveSemesterWeek } from './date.js'
import type { Period, SemesterWeek } from './types.js'

export type LabSource = 'physicslab' | 'phydemo'

/** 来源的中文名（用于课程名 / DDL 标题前缀，让用户在课表上一眼看出这是实验） */
export const LAB_SOURCE_LABEL: Record<LabSource, string> = {
  physicslab: '物理实验',
  phydemo: '演示实验'
}

/**
 * 各平台的「第 N 节 → 起止时间」表，与 platformPhysicslab.PHYSICS_LAB_TIME_RANGES /
 * platformPhydemo.PHYSICS_DEMO_TIMES 保持同值。
 *
 * 为什么这里再抄一份：那两个模块 import 了 cheerio 与 platformHttp（会连带
 * 拉起 Cookie/加密等重依赖），而本模块要保持"纯函数、零副作用"，只被路由与测试引用。
 * 两边一致性由 `scripts/test-lab-to-schedule.mts` 断言，改动时会立刻报错。
 */
export const LAB_TIME_RANGES: Record<LabSource, readonly string[]> = {
  physicslab: ['13:20-15:50', '16:20-18:50', '19:10-21:40', '13:00-16:20', '17:40-21:00', '10:10-12:40'],
  phydemo: ['08:10-09:50', '10:10-11:50', '14:10-15:50', '16:10-17:50', '18:30-20:10', '20:30-22:10']
}

/** 两个平台快照条目里本模块用得上的字段（结构上兼容 PhysicsLab / PhysicsDemoBooking） */
export interface LabEntry {
  name: string
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  /** 1..6 */
  period: number
  location?: string
  teacher?: string
}

/** 学期（Term）里本模块用得上的字段 */
export interface LabTermLike {
  id: string
  startDate: string
  totalWeeks: number
  weeks?: SemesterWeek[] | null
}

/** epoch 秒（UTC+8 零点）→ `YYYY-MM-DD`（按 UTC+8 取日期，不受服务器时区影响） */
export function labDateISO(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** `YYYY-MM-DD` → ISO 星期（1=周一 … 7=周日），与 courses.day_of_week 同口径 */
export function isoWeekday(dateISO: string): number {
  const [y, m, d] = dateISO.split('-').map(Number)
  const w = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
  return w === 0 ? 7 : w
}

/** 平台节次号 → 起止时间；表外的节次返回 null（不猜） */
export function labTimeRange(source: LabSource, period: number): { start: string; end: string } | null {
  const raw = LAB_TIME_RANGES[source]?.[period - 1]
  if (!raw) return null
  const [start, end] = raw.split('-')
  if (!start || !end) return null
  return { start, end }
}

/** `HH:mm` → 当天分钟数，便于比较；格式不对返回 NaN */
function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * 实验时段 → 课表的「第几大节 ~ 第几大节」。
 *
 * 规则（按用户 settings.periods 的先后顺序）：
 *  - 起始大节 = 第一个「结束时间晚于实验开始」的大节（即实验开始时人应该已经在教室的那一节）；
 *  - 结束大节 = 从起始大节往后，最后一个「开始时间早于实验结束」的大节。
 *
 * 为什么不用"重叠面积最大"之类的做法：实验时段与学校大节本来就是错位的
 * （实验第 4 时段 13:00-16:20，学校第 4 大节 14:10-16:00），任何精确匹配都会
 * 在某些时段上抖到相邻大节。上面这条规则是单调的：实验开始得晚，起始大节一定不会更早。
 */
export function mapLabToPeriods(
  start: string,
  end: string,
  periods: readonly Period[]
): { startPeriod: number; endPeriod: number } | null {
  if (!Array.isArray(periods) || periods.length === 0) return null
  const s = minutesOf(start)
  const e = minutesOf(end)
  if (Number.isNaN(s) || Number.isNaN(e)) return null

  let startIdx = -1
  for (let i = 0; i < periods.length; i++) {
    const pEnd = minutesOf(periods[i].end)
    if (!Number.isNaN(pEnd) && pEnd > s) {
      startIdx = i
      break
    }
  }
  /* 实验比当天最后一节还晚（如 20:30 开始而最后一节 21:00 结束之后）→ 落在最后一节 */
  if (startIdx < 0) startIdx = periods.length - 1

  let endIdx = startIdx
  for (let i = startIdx; i < periods.length; i++) {
    const pStart = minutesOf(periods[i].start)
    if (!Number.isNaN(pStart) && pStart < e) endIdx = i
  }

  return { startPeriod: periods[startIdx].index, endPeriod: periods[endIdx].index }
}

/**
 * 日期 → (学期 id, 教学周号)。
 *
 * 优先用 `preferredTermId`（用户的当前学期），不命中再按开学日**从新到旧**试其它学期 ——
 * 这样「上学期末的实验」不会被硬算到本学期第 0 周，而能落到它真正所属的学期。
 * 全部不命中（放假周 / 学期外 / 没有学期）返回 null，调用方据此降级。
 */
export function resolveLabWeek(
  dateISO: string,
  terms: readonly LabTermLike[],
  preferredTermId?: string | null
): { termId: string; week: number } | null {
  if (!Array.isArray(terms) || terms.length === 0) return null
  const ordered = [...terms].sort((a, b) => {
    if (a.id === preferredTermId) return -1
    if (b.id === preferredTermId) return 1
    return (b.startDate ?? '').localeCompare(a.startDate ?? '')
  })
  for (const t of ordered) {
    if (!t?.id || !t.startDate) continue
    const r = resolveSemesterWeek(dateISO, {
      name: '',
      startDate: t.startDate,
      totalWeeks: t.totalWeeks,
      weeks: t.weeks ?? null
    })
    if (r.phase === 'active' && r.week >= 1) return { termId: t.id, week: r.week }
  }
  return null
}

/** 标题里「来源标签」与实验名之间的分隔符 */
export const LAB_TITLE_SEP = ' · '

/**
 * 课程名 / DDL 标题的**固定前缀**（`物理实验 · ` / `演示实验 · `）。
 *
 * 「取消导入」要靠它反查哪些行是导入进来的 —— courses / tasks 表里没有
 * 「来源」列，而前缀是 `labTitle()` 保证会加的，比按名称精确匹配更稳：
 * 学校那边把实验取消掉之后，快照里就没有这条实验了，也就算不出精确的键，
 * 但前缀仍然能命中那些"孤儿"行。
 */
export function labTitlePrefix(source: LabSource): string {
  return `${LAB_SOURCE_LABEL[source] ?? '实验'}${LAB_TITLE_SEP}`
}

/** 课程名 / DDL 标题：`物理实验 · 分光计`（前缀让用户在课表上一眼区分实验与正课） */
export function labTitle(source: LabSource, name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim()
  return clean ? `${labTitlePrefix(source)}${clean}` : labTitlePrefix(source).trimEnd()
}

/** 同名实验固定同色（按名字哈希取色板下标），避免每次加入都换颜色 */
export function labColorIndex(name: string, paletteSize: number): number {
  if (!Number.isFinite(paletteSize) || paletteSize <= 0) return 0
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 100000
  }
  return h % paletteSize
}

export interface LabCourseDraft {
  name: string
  teacher: string
  location: string
  dayOfWeek: number
  weekStart: number
  weekEnd: number
  weekType: 'all'
  startPeriod: number
  endPeriod: number
  color: string
  term: string
}

export interface LabTaskDraft {
  title: string
  type: 'other'
  dueDate: string
  dueTime: string
  priority: 'medium'
  notes: string
}

/** 一条实验对应的课表草稿；无法落周（放假周 / 学期外 / 节次表外）时返回 null + 原因 */
export function buildCourseDraft(
  source: LabSource,
  lab: LabEntry,
  opts: {
    periods: readonly Period[]
    terms: readonly LabTermLike[]
    preferredTermId?: string | null
    palette: readonly string[]
  }
): { draft: LabCourseDraft } | { draft: null; reason: string } {
  const dateISO = labDateISO(lab.date)
  const range = labTimeRange(source, lab.period)
  if (!range) return { draft: null, reason: `第 ${lab.period} 节不在已知时段表内，请手动添加` }

  const slot = mapLabToPeriods(range.start, range.end, opts.periods)
  if (!slot) return { draft: null, reason: '作息时间表为空，请先在设置里配置节次时间' }

  const wk = resolveLabWeek(dateISO, opts.terms, opts.preferredTermId)
  if (!wk) return { draft: null, reason: `${dateISO} 不在任何学期的教学周内（可能是放假周），请手动添加` }

  const name = labTitle(source, lab.name)
  const palette = opts.palette.length > 0 ? opts.palette : ['#4f7cff']
  return {
    draft: {
      name,
      teacher: (lab.teacher ?? '').trim(),
      location: (lab.location ?? '').trim(),
      dayOfWeek: isoWeekday(dateISO),
      weekStart: wk.week,
      weekEnd: wk.week,
      weekType: 'all',
      startPeriod: slot.startPeriod,
      endPeriod: slot.endPeriod,
      color: palette[labColorIndex(name, palette.length)],
      term: wk.termId
    }
  }
}

/**
 * 一条实验对应的 DDL 草稿。
 *
 * 截止时间 = 实验**开始**时刻。
 *
 * 为什么是开始而不是结束：这条 DDL 存在的意义是「到点该出现在实验室」，
 * 提醒必须在人还没进实验室之前响。取结束时刻的话，提醒会在实验已经做完
 * 之后才弹出来 —— 对"别迟到/别走错教室"这个真实诉求毫无帮助。
 * （早前版本取的是 `range.end`，注释却写着"到点该在实验室"，两者是矛盾的。）
 */
export function buildTaskDraft(source: LabSource, lab: LabEntry): LabTaskDraft {
  const dateISO = labDateISO(lab.date)
  const range = labTimeRange(source, lab.period)
  const bits: string[] = []
  if (lab.location) bits.push(`地点：${lab.location}`)
  if (lab.teacher) bits.push(`教师：${lab.teacher}`)
  bits.push(`来源：${LAB_SOURCE_LABEL[source] ?? '实验'}（${dateISO} 第 ${lab.period} 节）`)
  return {
    title: labTitle(source, lab.name),
    type: 'other',
    dueDate: dateISO,
    dueTime: range?.start ?? '',
    priority: 'medium',
    notes: bits.join('｜')
  }
}

/** 课表去重键：同一实验、同一天、同一周、同一大节只留一条 */
export function courseDedupeKey(d: Pick<LabCourseDraft, 'name' | 'dayOfWeek' | 'weekStart' | 'startPeriod'>): string {
  return `${d.name}|${d.dayOfWeek}|${d.weekStart}|${d.startPeriod}`
}

/** DDL 去重键：标题 + 日期 + 时间 */
export function taskDedupeKey(d: Pick<LabTaskDraft, 'title' | 'dueDate' | 'dueTime'>): string {
  return `${d.title}|${d.dueDate}|${d.dueTime}`
}
