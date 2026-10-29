/**
 * 成绩查询（本科教务 AA）。
 *
 * 数据源：`https://aa.bjtu.edu.cn/score/scores/stu/view/?page=1&perpage=500&ctype=<ln|lr>`
 *
 * ⚠️ 必须按 `ctype` 分别请求两次（`ln` 与 `lr` 是教务对课程类别的两组口径），
 *    **两类全部成功才允许覆盖缓存** —— 只拿到一类就写库，会让另一类历史成绩
 *    在页面上凭空消失。参考仓库 GradeRemoteDataSource 也是这个策略。
 *
 * 三条必须遵守的规则（来自参考仓库 domain/grade/GradeRules.kt，都有实际理由）：
 *
 *   1. `displayCourseName()`：去掉原始课名前 8 位、后 4 位。
 *      教务返回的课名带前后缀（课程号片段 / 类别标记 / 班级号），不对齐会让
 *      列表看起来杂乱，且同一门课在不同学期显示不一致。
 *
 *   2. `courseCodeOf()`：用 `^[A-Z]\d{3}[A-Z0-9]{4,5}` 提取课程号，作为与
 *      培养方案/学分映射的**同键**。**取不到时必须归 unknown，绝不误判为任选** ——
 *      把必修课错判成任选会算错必修学分，直接影响毕业审核。
 *
 *   3. 体育课（`pe`）单独成类。体育课的学分与绩点算法和普通课不同，
 *      混进必修会污染统计。
 */
import * as cheerio from 'cheerio'
import { jarFetch, type CookieJar } from './mis.js'
import { db, tx } from './db.js'

const AA_ORIGIN = process.env.MIS_AA_ORIGIN ?? 'https://aa.bjtu.edu.cn'
const AA_HOST = new URL(AA_ORIGIN).host

/** 教务成绩页（两类口径各请求一次） */
export const AA_GRADE_URL = (ctype: 'ln' | 'lr') =>
  `${AA_ORIGIN}/score/scores/stu/view/?page=1&perpage=500&ctype=${ctype}`

/** 成绩单 PDF 下载（中文 / 英文各一个 type） */
export type ReportCardLanguage = 'zh' | 'en'

export const AA_REPORT_CARD_URL = (lang: ReportCardLanguage) =>
  `${AA_ORIGIN}/score/scorecard/stu/5201314/download_pdf/?type=${
    lang === 'zh' ? 'card_cn_sign' : 'card_en_sign'
  }&has_advance_query=`

export type CourseType = 'required' | 'limited' | 'elective' | 'pe' | 'unknown'

export interface Grade {
  /** 稳定 id：课程号 + 学期 + 课名（同一门课重修会在两个学期各有一条） */
  id: string
  courseName: string
  courseTeacher: string
  /** 百分制分数；未出分/等级制时为 null */
  courseScore: number | null
  /** 原始成绩文本（"优秀"/"通过"/"95" 等），前端在分数为空时展示它 */
  scoreText: string
  courseCredits: number | null
  courseYear: string
  semester: string
  detail: string
  courseType: CourseType
  /** 从课名提取的课程号（提取不到为空串） */
  courseCode: string
}

/**
 * 去前后缀后的显示名。
 *
 * ⚠️ 为什么是"前 8 后 4"这种看似任意的数字：这是对齐参考仓库 v1.7.0 的
 * 视觉效果 —— 教务原始课名的前缀（类别标记）恰好 8 字符、后缀（班级/类型）恰好 4 字符。
 * 改动会让本页与「学分统计」的观感与旧版不一致，**非必要不要动**。
 */
export function displayCourseName(raw: string): string {
  const s = raw.trim()
  if (s.length <= 12) return s
  return s.slice(8, s.length - 4).trim() || s
}

/**
 * 从课名提取课程号。
 * ⚠️ 提取不到返回空串（→ 归 unknown），**绝不猜成任选**。理由见文件头。
 */
export function courseCodeOf(raw: string): string {
  const m = /^[A-Z]\d{3}[A-Z0-9]{4,5}/.exec(raw.trim())
  return m ? m[0] : ''
}

/** 判断课程类别。unknown ≠ 任选 —— 见文件头第 2 条。 */
export function courseTypeOf(name: string, teacher: string): CourseType {
  const n = name.toLowerCase()
  if (n.includes('体育')) return 'pe'
  /* 教务的 ln / lr 分组本身已经区分了必修/限选，但解析出来的课名里
     往往也带标记词。两者结合判断更稳。 */
  if (/必修/.test(name)) return 'required'
  if (/限选|限制选修/.test(name)) return 'limited'
  if (/任选|选修|通识|公选/.test(name)) return 'elective'
  // 课名 + 教师都拿不到类别信息 → unknown（由调用方用 ctype 分组兜底修正）
  return teacher ? 'unknown' : 'unknown'
}

/** 把成绩文本转百分制分数；纯等级制返回 null（不猜分数） */
export function parseScore(text: string): number | null {
  const s = text.trim()
  if (!s) return null
  const m = /^(\d{1,3}(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null
}

function numOrNull(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(text)
  return m ? Number(m[1]) : null
}

function colIndex(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h))
    if (i >= 0) return i
  }
  return -1
}

/**
 * 解析教务成绩页。
 *
 * 不依赖固定列顺序，按表头关键词定位（与 parseAaExams 同一策略）——
 * 教务改版时通常只调顺序，关键词匹配能扛住。
 *
 * @param ctype 这一页来自哪一类请求，用于兜底推断课程类别
 */
export function parseAaGrades(html: string, ctype: 'ln' | 'lr'): Grade[] {
  const $ = cheerio.load(html)
  const out: Grade[] = []
  const seen = new Set<string>()

  $('table').each((_, table) => {
    const $t = $(table)
    const rows = $t.find('tr').toArray()
    if (rows.length === 0) return

    let headers = $t.find('thead th').toArray().map((el) => $(el).text().replace(/\s+/g, ''))
    let bodyRows = rows
    if (headers.length === 0) {
      const first = $(rows[0]).find('th,td').toArray().map((el) => $(el).text().replace(/\s+/g, ''))
      if (first.length && /课程|成绩|学分/.test(first.join('|'))) {
        headers = first
        bodyRows = rows.slice(1)
      }
    }
    if (headers.length === 0) return

    const iName = colIndex(headers, [/课程名称|课程名|课名|课程/, /名称/])
    const iScore = colIndex(headers, [/成绩|分数|得分/])
    const iCredit = colIndex(headers, [/学分/])
    const iTeacher = colIndex(headers, [/教师|老师|任课/])
    const iYear = colIndex(headers, [/学年|年度|年份/])
    const iTerm = colIndex(headers, [/学期|学期名/])
    const iType = colIndex(headers, [/课程性质|课程类别|修读|性质|类别/])
    const iCode = colIndex(headers, [/课程号|课程代码|课程编号/])

    // 课名与成绩缺一不可，否则不是成绩表
    if (iName < 0 || iScore < 0) return

    for (const row of bodyRows) {
      const cells = $(row)
        .find('td')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      if (cells.length <= Math.max(iName, iScore)) continue

      const rawName = cells[iName] ?? ''
      if (!rawName || rawName.length < 2) continue
      const scoreText = cells[iScore] ?? ''

      const year = iYear >= 0 ? cells[iYear] ?? '' : ''
      const term = iTerm >= 0 ? cells[iTerm] ?? '' : ''
      const teacher = iTeacher >= 0 ? cells[iTeacher] ?? '' : ''
      const codeRaw = iCode >= 0 ? cells[iCode] ?? '' : ''
      const typeRaw = iType >= 0 ? cells[iType] ?? '' : ''

      const code = courseCodeOf(codeRaw || rawName)
      const name = rawName

      let type = courseTypeOf(`${typeRaw} ${name}`, teacher)
      /* 表头没给类别时用 ctype 兜底：
         ln 组在教务口径里是必修+限选，lr 组是任选。这里只把 ln 兜底成
         required（更保守：算学分时必修权重高，宁可归必修也不归任选），
         lr 兜底成 elective。 */
      if (type === 'unknown' && !typeRaw) {
        type = ctype === 'ln' ? 'required' : 'elective'
      }

      const id = `${code || name}|${year}|${term}`
      if (seen.has(id)) continue
      seen.add(id)

      out.push({
        id,
        courseName: name,
        courseTeacher: teacher,
        courseScore: parseScore(scoreText),
        scoreText,
        courseCredits: iCredit >= 0 ? numOrNull(cells[iCredit] ?? '') : null,
        courseYear: year,
        semester: term,
        detail: typeRaw,
        courseType: type,
        courseCode: code
      })
    }
  })

  return out
}

export interface GradeFetchResult {
  grades: Grade[]
  /** 两类请求里失败的那一类（空数组 = 都成功）。非空时**不要覆盖缓存**。 */
  failedCtypes: ('ln' | 'lr')[]
  /** 每个请求命中的最终 URL，便于排查「被踢回登录页」 */
  finalUrls: Record<string, string>
}

/**
 * 抓取全部成绩。前置：MIS 已登录且 AA 会话可用。
 *
 * ⚠️ 由调用方复用 MIS 会话（s.jar），本函数**不销毁会话** ——
 *    一次同步会话里还要拉课表/作业，销毁了后面的域全都拿不到。
 */
export async function fetchGrades(jar: CookieJar): Promise<GradeFetchResult> {
  const failedCtypes: ('ln' | 'lr')[] = []
  const finalUrls: Record<string, string> = {}
  const all: Grade[] = []

  for (const ctype of ['ln', 'lr'] as const) {
    try {
      const page = await jarFetch(jar, AA_GRADE_URL(ctype))
      finalUrls[ctype] = page.url
      // 被踢回登录页 → 这一路视为失败（不能把登录页解析成"没有成绩"）
      if (!page.url.includes(AA_HOST)) {
        failedCtypes.push(ctype)
        continue
      }
      all.push(...parseAaGrades(page.body, ctype))
    } catch {
      failedCtypes.push(ctype)
    }
  }

  return { grades: all, failedCtypes, finalUrls }
}

/* ---------------- 统计（只对能确定的数据计算） ---------------- */

/**
 * 五级制成绩的「代表分数」折算表（2026-10-14 引入）。
 *
 * 背景：官方《成绩管理办法》规定加权平均成绩 = Σ(课程分数×学分)/Σ学分，
 * 其中**五级制课程按对应分数折算**、两级制不参与。KMP 参考实现（及学生预期
 * 口径）取每个等级区间分数的**中点**作为代表分数（A: 90-100→95，A-: 85-89→87，
 * B+: 81-84→83 向上取整…），用它对应用户核对出的 84.9。
 *
 * ⚠️ 与 web/src/components/apps/GradesApp.tsx 的前端重算映射保持同步（同源），
 *    改动必须两处一起改（成绩页按学期筛选时由前端重算统计）。
 * ⚠️ 映射不到的等级文本（"通过"/"缓考"等两级制或未知）→ null，**不参与计算**，
 *    绝不默认取任何值 —— 与官方"两级制课程不参与计算"一致。
 */
export const GRADE_REPRESENTATIVE: Record<string, number> = {
  A: 95,
  'A-': 87,
  'B+': 83,
  B: 79,
  'B-': 76,
  'C+': 73,
  C: 69,
  'C-': 66,
  'D+': 63,
  D: 60,
  F: 30
}

/** 单门课参与统计的分数：百分制用实际分数；五级制用代表分数；其余 null（不参与） */
export function statScoreOf(g: { courseScore: number | null; scoreText: string }): number | null {
  if (g.courseScore !== null) return g.courseScore
  return GRADE_REPRESENTATIVE[g.scoreText.trim().toUpperCase()] ?? null
}

export interface GradeStats {
  /** 计入统计的课程数（百分制有分数，或五级制可折算） */
  counted: number
  /**
   * 加权平均分（学分加权）：百分制用实际分数、五级制用代表分数，
   * 按官方口径**保留一位小数**（如 84.9）；无有效数据时为 null
   */
  weightedAverage: number | null
  /** 算术平均分（同口径：含五级制折算；页面已不展示，保留字段供小程序等端使用） */
  average: number | null
  totalCredits: number
  /** 按类别的学分小计 */
  creditsByType: Record<CourseType, number>
  /** 挂科门数（折算后分数 < 60，含 F；无法折算的不计入 —— 不猜） */
  failed: number
}

export function computeStats(grades: Grade[]): GradeStats {
  const creditsByType: Record<CourseType, number> = {
    required: 0,
    limited: 0,
    elective: 0,
    pe: 0,
    unknown: 0
  }
  let totalCredits = 0
  let weightedSum = 0
  let weightedCredits = 0
  let scoreSum = 0
  let scoreCount = 0
  let failed = 0

  for (const g of grades) {
    const cr = g.courseCredits ?? 0
    totalCredits += cr
    creditsByType[g.courseType] += cr

    const s = statScoreOf(g)
    if (s === null) continue
    scoreSum += s
    scoreCount += 1
    if (s < 60) failed += 1
    if (cr > 0) {
      weightedSum += s * cr
      weightedCredits += cr
    }
  }

  return {
    counted: scoreCount,
    weightedAverage: weightedCredits > 0 ? Math.round((weightedSum / weightedCredits) * 10) / 10 : null,
    average: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
    totalCredits: Math.round(totalCredits * 10) / 10,
    creditsByType,
    failed
  }
}

/** 归一化快照（变动检测用）：只留用户可感知的字段 */
export function gradesFingerprint(grades: Grade[]): { key: string; label: string; detail: Record<string, string> }[] {
  return grades.map((g) => ({
    key: g.id,
    label: g.courseName,
    detail: { score: g.scoreText, credits: String(g.courseCredits ?? '') }
  }))
}

/* ---------------- 落库与查询 ---------------- */

/**
 * 整批替换某用户的成绩。
 *
 * ⚠️ 调用方必须先确认 `fetchGrades().failedCtypes` 为空。
 *    只成功一类就调用本函数，会把另一类历史成绩全部删掉。
 *
 * @returns 落库条数
 */
export function replaceGrades(userId: number, items: Grade[]): number {
  /* 统一走 tx()（见 db.ts）：异常路径上的回滚由它保证，调用方不必再写 catch/ROLLBACK。 */
  tx(() => {
    db.prepare('DELETE FROM grades WHERE user_id = ?').run(userId)
    const stmt = db.prepare(
      `INSERT INTO grades
         (user_id, grade_key, course_name, course_teacher, course_score, score_text,
          course_credits, course_year, semester, detail, course_type, course_code, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    for (const g of items) {
      stmt.run(
        userId, g.id, g.courseName, g.courseTeacher, g.courseScore, g.scoreText,
        g.courseCredits, g.courseYear, g.semester, g.detail, g.courseType, g.courseCode
      )
    }
  })
  return items.length
}

interface GradeRow {
  id: number
  grade_key: string
  course_name: string
  course_teacher: string
  course_score: number | null
  score_text: string
  course_credits: number | null
  course_year: string
  semester: string
  detail: string
  course_type: string
  course_code: string
}

/** 列出全部成绩（按学年、学期倒序 —— 最近的在最上面） */
export function listGrades(userId: number): Grade[] {
  const rows = db
    .prepare(
      `SELECT id, grade_key, course_name, course_teacher, course_score, score_text,
              course_credits, course_year, semester, detail, course_type, course_code
       FROM grades
       WHERE user_id = ?
       ORDER BY course_year DESC, semester DESC, id ASC`
    )
    .all(userId) as unknown as GradeRow[]

  return rows.map((r) => ({
    id: r.grade_key,
    courseName: r.course_name,
    courseTeacher: r.course_teacher,
    courseScore: r.course_score,
    scoreText: r.score_text,
    courseCredits: r.course_credits,
    courseYear: r.course_year,
    semester: r.semester,
    detail: r.detail,
    courseType: r.course_type as CourseType,
    courseCode: r.course_code
  }))
}

export function hasGrades(userId: number): boolean {
  const r = db.prepare('SELECT 1 FROM grades WHERE user_id = ? LIMIT 1').get(userId)
  return !!r
}

/* ---------------- 成绩单 PDF 下载 ---------------- */

/** PDF 魔数：%PDF */
function isPdfBytes(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
}

/**
 * 用服务端的 AA 会话取成绩单 PDF。
 *
 * ⚠️ 必须校验是 PDF 而不是 HTML：AA 会话失效时它返回 200 + 登录页 HTML，
 *    不校验的话用户会下载到一个"看起来是 PDF、打开是登录页"的文件（很难理解发生了什么）。
 *    前端据 502 + 明确文案提示重新登录。
 */
export async function fetchReportCardBytes(jar: CookieJar, lang: ReportCardLanguage): Promise<Buffer> {
  const page = await jarFetch(jar, AA_REPORT_CARD_URL(lang))
  if (!page.url.includes(AA_HOST)) {
    throw new Error('会话已失效，请重新用学号登录后再下载')
  }
  if (!isPdfBytes(page.raw)) {
    throw new Error('教务未返回 PDF（可能是会话过期或教务侧未开放成绩单下载）')
  }
  return page.raw
}
