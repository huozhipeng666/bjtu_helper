import type { SQLInputValue } from 'node:sqlite'
import type { Course, Exam, Overview, SemesterSettings, Task, WeekCourse, WeekData, WeekTask } from './types.js'
import { db, getSettings, tx } from './db.js'
import { addDays, listSemesterWeekOptions, parseISODate, rawWeekNumber, resolveSemesterWeek, startOfWeek, toISODate, urgencyOf } from './date.js'

/* ---------------- query helpers（均按 user 隔离） ------------- */

/** 把 courses.weeks 的 JSON 文本安全解析为升序去重的周号数组；空/非法返回 null（走旧口径） */
function parseWeeksJson(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    const set = new Set<number>()
    for (const w of arr) {
      const n = Number(w)
      if (Number.isInteger(n) && n >= 1 && n <= 60) set.add(n)
    }
    return set.size > 0 ? [...set].sort((a, b) => a - b) : null
  } catch {
    return null
  }
}

/**
 * 课程在某教学周是否上课 —— 全项目唯一的周次命中判定。
 * weeks 精确集合优先（教务逗号周列表 / 手动自由选周）；
 * 否则回退「区间 + 单双周」旧口径。
 */
export function courseHitsWeek(c: Pick<Course, 'weeks' | 'weekStart' | 'weekEnd' | 'weekType'>, week: number): boolean {
  if (c.weeks && c.weeks.length > 0) return c.weeks.includes(week)
  if (week < c.weekStart || week > c.weekEnd) return false
  if (c.weekType === 'odd' && week % 2 === 0) return false
  if (c.weekType === 'even' && week % 2 === 1) return false
  return true
}

/**
 * 列出课程。
 *
 * @param term 传入学期 id 时只返回该学期的课程。
 *   **`term IS NULL` 也算命中**（存量课程在多学期改造前没有 term）——
 *   这是刻意的「宁可多显示、也不要让课凭空消失」：万一迁移未跑到，
 *   用户看到的是"课还在"，而不是"课全没了"这种灾难性表象。
 */
export function listCourses(userId: number, term?: string | null): Course[] {
  const where = term ? 'WHERE user_id = ? AND (term = ? OR term IS NULL)' : 'WHERE user_id = ?'
  const params: SQLInputValue[] = term ? [userId, term] : [userId]
  const rows = db
    .prepare(
      `SELECT id, name, teacher, location, day_of_week AS dayOfWeek,
              week_start AS weekStart, week_end AS weekEnd, week_type AS weekType,
              weeks, term,
              start_period AS startPeriod, end_period AS endPeriod, color, credits,
              COALESCE(grading_policy, '') AS gradingPolicy
       FROM courses ${where} ORDER BY day_of_week, start_period`
    )
    .all(...params) as unknown as (Course & { weeks: unknown })[]
  return rows.map((r) => ({ ...r, weeks: parseWeeksJson(r.weeks) }))
}

export function getCourse(userId: number, id: number): Course | null {
  const row = db
    .prepare(
      `SELECT id, name, teacher, location, day_of_week AS dayOfWeek,
              week_start AS weekStart, week_end AS weekEnd, week_type AS weekType,
              weeks, term,
              start_period AS startPeriod, end_period AS endPeriod, color, credits,
              COALESCE(grading_policy, '') AS gradingPolicy
       FROM courses WHERE id = ? AND user_id = ?`
    )
    .get(id, userId) as (Course & { weeks: unknown }) | undefined
  if (!row) return null
  return { ...row, weeks: parseWeeksJson(row.weeks) }
}

export function listTasks(
  userId: number,
  filter?: { status?: string; type?: string; from?: string; to?: string }
): Task[] {
  const where: string[] = ['t.user_id = ?']
  const params: SQLInputValue[] = [userId]
  if (filter?.status) {
    where.push('t.status = ?')
    params.push(filter.status)
  }
  if (filter?.type) {
    where.push('t.type = ?')
    params.push(filter.type)
  }
  if (filter?.from) {
    where.push('t.due_date >= ?')
    params.push(filter.from)
  }
  if (filter?.to) {
    where.push('t.due_date <= ?')
    params.push(filter.to)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT t.id, t.title, t.course_id AS courseId, t.type, t.due_date AS dueDate, t.due_time AS dueTime,
              t.priority, t.status, t.notes, t.sort_order AS sortOrder, c.name AS courseName, c.color
       FROM tasks t LEFT JOIN courses c ON c.id = t.course_id
       ${whereSql}
       ORDER BY CASE WHEN t.sort_order = 0 THEN 1 ELSE 0 END, t.sort_order,
                t.due_date, t.due_time, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id`
    )
    .all(...params) as unknown as Task[]
}

export function getTask(userId: number, id: number): Task | null {
  return (
    (db
      .prepare(
        `SELECT t.id, t.title, t.course_id AS courseId, t.type, t.due_date AS dueDate, t.due_time AS dueTime,
                t.priority, t.status, t.notes, t.sort_order AS sortOrder, c.name AS courseName, c.color
         FROM tasks t LEFT JOIN courses c ON c.id = t.course_id
         WHERE t.id = ? AND t.user_id = ?`
      )
      .get(id, userId) as Task | undefined) ?? null
  )
}

/* ---------------- 考务（考试安排） ----------------
 * 与 tasks 的关系：考试可以「一键转 DDL」，转换后 exams.task_id 指向生成的任务，
 * 重复转换会复用同一条任务而不是新建，避免用户在 DDL 里看到一堆重复的考试条目。
 */

const EXAM_COLS = `id, course_name AS courseName, exam_date AS examDate, start_time AS startTime,
                   end_time AS endTime, location, seat, note, source, task_id AS taskId,
                   created_at AS createdAt`

export function listExams(userId: number): Exam[] {
  return db
    .prepare(`SELECT ${EXAM_COLS} FROM exams WHERE user_id = ? ORDER BY exam_date, start_time, id`)
    .all(userId) as unknown as Exam[]
}

export function getExam(userId: number, id: number): Exam | null {
  return (
    (db.prepare(`SELECT ${EXAM_COLS} FROM exams WHERE id = ? AND user_id = ?`).get(id, userId) as Exam | undefined) ?? null
  )
}

export type ExamInput = {
  courseName: string
  examDate: string
  startTime?: string
  endTime?: string
  location?: string
  seat?: string
  note?: string
  source?: 'mis' | 'manual'
}

/**
 * 写入一条考试。同 (用户, 科目, 日期, 开始时间) 视为同一场考试，冲突时更新
 * 考场/座位/备注，避免重复抓取产生多行。
 */
export function createExam(userId: number, input: ExamInput): Exam {
  const info = db
    .prepare(
      `INSERT INTO exams (user_id, course_name, exam_date, start_time, end_time, location, seat, note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course_name, exam_date, start_time)
       DO UPDATE SET end_time = excluded.end_time, location = excluded.location,
                     seat = excluded.seat, note = excluded.note, source = excluded.source`
    )
    .run(
      userId,
      input.courseName,
      input.examDate,
      input.startTime ?? '',
      input.endTime ?? '',
      input.location ?? '',
      input.seat ?? '',
      input.note ?? '',
      input.source ?? 'manual'
    )
  // ON CONFLICT 走更新分支时 lastInsertRowid 不一定是这行，回退按唯一键再查一次
  return (
    getExam(userId, Number(info.lastInsertRowid)) ??
    (db
      .prepare(
        `SELECT ${EXAM_COLS} FROM exams WHERE user_id = ? AND course_name = ? AND exam_date = ? AND start_time = ?`
      )
      .get(userId, input.courseName, input.examDate, input.startTime ?? '') as unknown as Exam)
  )
}

export function deleteExam(userId: number, id: number): void {
  db.prepare(`DELETE FROM exams WHERE id = ? AND user_id = ?`).run(id, userId)
}

/** 把考试信息拼成任务备注：考场 + 座位 + 起止时间 */
function examNotes(e: { location: string; seat: string; startTime: string; endTime: string; note: string }): string {
  const parts: string[] = []
  if (e.location) parts.push(`考场：${e.location}`)
  if (e.seat) parts.push(`座位：${e.seat}`)
  if (e.startTime || e.endTime) parts.push(`时间：${e.startTime || '待定'}-${e.endTime || '待定'}`)
  if (e.note) parts.push(e.note)
  return parts.join(' · ')
}

/** 找同名课程，用于把考试 DDL 挂到对应课程上（找不到就挂"无课程"） */
function findCourseIdByName(userId: number, courseName: string): number | null {
  const row = db
    .prepare(`SELECT id FROM courses WHERE user_id = ? AND name = ? ORDER BY id LIMIT 1`)
    .get(userId, courseName) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * 查一条已存在的「考试 DDL」：同用户 + 类型为考试 + 同一截止日 + 标题含科目名。
 * 用 instr 而不是 LIKE，避免课名里的 % / _ 被当成通配符。
 */
function findExamTask(userId: number, courseName: string, examDate: string): { id: number } | null {
  return (
    (db
      .prepare(
        `SELECT id FROM tasks
         WHERE user_id = ? AND type = 'exam' AND due_date = ? AND instr(title, ?) > 0
         ORDER BY id LIMIT 1`
      )
      .get(userId, examDate, courseName) as { id: number } | undefined) ?? null
  )
}

/**
 * 考试转 DDL：存在则复用（不新建），否则建一条高优先级考试任务。
 * 返回任务 id 与是否是本次新建。
 */
export function examToTask(userId: number, examId: number): { taskId: number; created: boolean } | null {
  const e = getExam(userId, examId)
  if (!e) return null
  // 已关联过任务且任务还在 → 直接复用
  if (e.taskId) {
    const alive = db.prepare(`SELECT id FROM tasks WHERE id = ? AND user_id = ?`).get(e.taskId, userId) as
      | { id: number }
      | undefined
    if (alive) return { taskId: alive.id, created: false }
  }
  const existed = findExamTask(userId, e.courseName, e.examDate)
  if (existed) {
    db.prepare(`UPDATE exams SET task_id = ? WHERE id = ? AND user_id = ?`).run(existed.id, examId, userId)
    return { taskId: existed.id, created: false }
  }
  const info = db
    .prepare(
      `INSERT INTO tasks (user_id, title, course_id, type, due_date, due_time, priority, status, notes)
       VALUES (?, ?, ?, 'exam', ?, ?, 'high', 'pending', ?)`
    )
    .run(
      userId,
      `${e.courseName} 考试`,
      findCourseIdByName(userId, e.courseName),
      e.examDate,
      e.startTime || '',
      examNotes(e)
    )
  const taskId = Number(info.lastInsertRowid)
  db.prepare(`UPDATE exams SET task_id = ? WHERE id = ? AND user_id = ?`).run(taskId, examId, userId)
  return { taskId, created: true }
}

/**
 * 整表覆盖导入考试（事务：先删后插）。
 * createDdl = true 时为每场考试自动生成/复用一条 DDL，实现「抓完自动设置 DDL」。
 */
export function replaceExams(
  userId: number,
  rows: ExamInput[],
  opts: { createDdl: boolean } = { createDdl: false }
): { deleted: number; imported: number; taskCreated: number; taskReused: number; exams: Exam[] } {
  const deleted = (db.prepare(`SELECT COUNT(*) AS c FROM exams WHERE user_id = ?`).get(userId) as { c: number }).c
  let taskCreated = 0
  let taskReused = 0

  /* 统一走 db.ts 的 tx()：手写 BEGIN/COMMIT 容易在异常路径上漏掉 ROLLBACK，
     一旦漏掉，这个连接会一直停在事务里 —— 之后所有写操作都返回
     "cannot start a transaction within a transaction"，且没人能看出问题在哪。
     tx() 用的是 BEGIN IMMEDIATE（立即拿写锁），比裸 BEGIN 更早暴露锁冲突。 */
  tx(() => {
    db.prepare(`DELETE FROM exams WHERE user_id = ?`).run(userId)
    for (const r of rows) {
      createExam(userId, { ...r, source: r.source ?? 'mis' })
    }
    if (opts.createDdl) {
      for (const e of listExams(userId)) {
        const r = examToTask(userId, e.id)
        if (!r) continue
        if (r.created) taskCreated++
        else taskReused++
      }
    }
  })
  return { deleted, imported: rows.length, taskCreated, taskReused, exams: listExams(userId) }
}

/* ---------------- week aggregation ---------------- */

export function getWeekData(
  userId: number,
  dateISO: string,
  opts: { includeInactive?: boolean } = {}
): WeekData {
  const settings = getSettings(userId)
  const { semester, periods } = settings
  /* 只取当前学期的课：切换学期后，旧学期的课不会被重新解释，也不会混进来 */
  const allCourses = listCourses(userId, settings.currentTermId)
  const date = parseISODate(dateISO)
  const weekStart = toISODate(startOfWeek(date))
  const weekEnd = toISODate(addDays(parseISODate(weekStart), 6))
  /* 周次一律**查表**（semester.weeks），不再线性推算 —— 学校放假跳过的那一周会让
     线性推算从放假之后整体错位。没有周次表的学期（存量数据/手工建的学期）才退回线性。 */
  const res = resolveSemesterWeek(weekStart, semester)
  const rawWeek = res.fromTable ? res.week : rawWeekNumber(weekStart, semester.startDate)
  /** 教学周号：0 = 该周不是教学周（放假周 / 开学前 / 已结课） */
  const weekNumber = res.week
  const weekState = res.phase
  /**
   * 筛课用的周次。三种非 active 阶段各有讲究：
   *  - 放假周 → 0：课程周次最小是 1，任何课都命不中，于是自然得到「放假无课程」；
   *    这也是与平台「第 0 周」口径天然对齐的地方。
   *  - 开学前 → 1：按「第 1 教学周」的口径预览。开学前若直接不给周号，
   *    用户导入完课表却看见空白，会以为导入失败。
   *  - 已结课 → 真实线性周号：超出课程 weekEnd 的课本就不该再出现。
   */
  const courseWeek =
    weekState === 'holiday' ? 0 : weekState === 'before' ? 1 : weekState === 'active' ? res.week : rawWeekNumber(weekStart, semester.startDate)
  const todayISO = toISODate(new Date())

  const allTasks = listTasks(userId, { from: weekStart, to: weekEnd })

  /** 给课程补上实际起止时间（节次 → 时钟）。active 与 inactive 两条路径共用同一套映射，
   *  避免"本周的课有时间、灰掉的课没有"这种只有细看才发现的不一致。 */
  const withTime = (c: Course): WeekCourse => {
    const sp = periods.find((p) => p.index === c.startPeriod)
    const ep = periods.find((p) => p.index === c.endPeriod)
    return { ...c, startTime: sp?.start ?? '', endTime: ep?.end ?? '' }
  }

  /* 非本周课程（可选下发）：本学期有课、但本周不命中的那些。
     注意放假周 courseWeek=0，此时**所有课**都不命中 —— 于是整周都会被灰掉，
     这恰好是「显示非本周课程」在这个场景下最该有的表现：一眼看出"课没丢，是这周放假"。 */
  const inactive: WeekCourse[] = opts.includeInactive
    ? allCourses
        .filter((c) => !courseHitsWeek(c, courseWeek))
        .map(withTime)
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod)
    : []

  const days: WeekData['days'] = []
  for (let i = 0; i < 7; i++) {
    const dayDate = toISODate(addDays(parseISODate(weekStart), i))
    const weekday = i + 1

    const courses: WeekCourse[] = allCourses
      .filter((c) => {
        if (c.dayOfWeek !== weekday) return false
        return courseHitsWeek(c, courseWeek)
      })
      .map(withTime)
      .sort((a, b) => a.startPeriod - b.startPeriod)

    const tasks: WeekTask[] = allTasks
      .filter((t) => t.dueDate === dayDate)
      .map((t) => ({ ...t, urgency: urgencyOf(t.dueDate, todayISO, weekEnd, t.status) }))

    const day: WeekData['days'][number] = { date: dayDate, isToday: dayDate === todayISO, weekday, courses, tasks }
    if (opts.includeInactive) {
      day.inactiveCourses = inactive.filter((c) => c.dayOfWeek === weekday)
    }
    days.push(day)
  }

  return { date: dateISO, weekNumber, rawWeek, weekState, weekStart, weekEnd, semester, weekOptions: listSemesterWeekOptions(semester), days }
}

/* ---------------- month aggregation ---------------- */

export interface MonthCell {
  date: string
  isToday: boolean
  inMonth: boolean
  weekday: number
  courseCount: number
  /** 该日属于放假周（学校整周不排课）—— 月视图据此标出「假」 */
  holiday: boolean
  tasks: WeekTask[]
}

export interface MonthData {
  date: string
  year: number
  month: number // 1-12
  semester: SemesterSettings
  gridStart: string
  gridEnd: string
  cells: MonthCell[]
}

export function getMonthData(userId: number, dateISO: string): MonthData {
  const settings = getSettings(userId)
  const { semester, periods } = settings
  const date = parseISODate(dateISO)
  const year = date.getFullYear()
  const month = date.getMonth() // 0-based
  const gridStart = startOfWeek(new Date(year, month, 1))
  const todayISO = toISODate(new Date())

  const allCourses = listCourses(userId, settings.currentTermId)
  const allTasks = listTasks(userId, { from: toISODate(gridStart), to: toISODate(addDays(gridStart, 41)) })

  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i)
    const dayISO = toISODate(d)
    const weekday = ((i % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7
    const res = resolveSemesterWeek(dayISO, semester)
    /* 放假周 / 开学前 / 已结课一律 0 门：这些日子学校本来就不排课。
       教学周内用 courseHitsWeek 判定（与周视图同一口径）—— 它认得 weeks 精确周集合，
       而旧的「区间 + 单双周」内联判断对 [1,2,3,10,11] 这种跳段课会误判成 4~9 周也有课。 */
    const courseCount =
      res.phase === 'active' ? allCourses.filter((c) => c.dayOfWeek === weekday && courseHitsWeek(c, res.week)).length : 0

    const tasks: WeekTask[] = allTasks
      .filter((t) => t.dueDate === dayISO)
      .map((t) => ({ ...t, urgency: urgencyOf(t.dueDate, todayISO, toISODate(addDays(gridStart, 6)), t.status) }))

    cells.push({
      date: dayISO,
      isToday: dayISO === todayISO,
      inMonth: d.getMonth() === month,
      weekday,
      courseCount,
      holiday: res.phase === 'holiday',
      tasks
    })
  }

  return {
    date: dateISO,
    year,
    month: month + 1,
    semester,
    gridStart: toISODate(gridStart),
    gridEnd: toISODate(addDays(gridStart, 41)),
    cells
  }
}

/* ---------------- overview ---------------- */
export function getOverview(userId: number): Overview {
  const todayISO = toISODate(new Date())
  const tomorrowISO = toISODate(addDays(new Date(), 1))
  const weekEndISO = toISODate(addDays(startOfWeek(new Date()), 6))
  /* 一次取全量再在内存分组：原实现分别按 status='pending' 和 'done' 查两次，
     等于对同一批数据扫两遍。任务表本来就按 user_id 过滤（user 维度基数很小），
     单次查询 + 内存 filter 更省事也更省 I/O。 */
  const all = listTasks(userId)
  const pending = all.filter((t) => t.status === 'pending')
  const doneCount = all.length - pending.length

  const by = (u: 'overdue' | 'today' | 'tomorrow') =>
    pending.filter((t) => urgencyOf(t.dueDate, todayISO, weekEndISO, t.status) === u)

  const overdue = by('overdue')
  const today = by('today')
  const tomorrow = by('tomorrow')
  const thisWeek = pending.filter((t) => t.dueDate > tomorrowISO && t.dueDate <= weekEndISO)

  return {
    overdue,
    today,
    tomorrow,
    thisWeek,
    counts: {
      overdue: overdue.length,
      today: today.length,
      pending: pending.length,
      done: doneCount
    }
  }
}

/* ---------------- 通用 HTTP 业务错误 ----------------

   为什么定义在这里而不是 index.ts：share.ts 这类业务模块也要抛「带状态码的错误」，
   而 index.ts 的 fail() 是按 `instanceof HttpError` 决定响应码的 —— 定义必须只有一份，
   否则各模块自建的错误类会掉进兜底分支被当成 500，把一个 400 的业务提示变成"服务器内部错误"。
   放在 lib.ts 是因为它是全项目最底层的共享模块（db → lib → 各业务 → index），不会成环。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
