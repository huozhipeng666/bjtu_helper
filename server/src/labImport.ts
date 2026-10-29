/**
 * 实验 → 课表 / DDL 的**落库**部分。
 *
 * 与 labToSchedule.ts 的分工：
 *   - labToSchedule.ts：纯函数，负责"这条实验该落在第几周、第几大节"（可单测，不碰库）；
 *   - 本文件：把算好的草稿写进 courses / tasks，并负责**幂等去重**。
 *
 * ## 为什么去重放在写库这一层
 *
 * 「一键加入」是一个用户会连点、会重复点的按钮（尤其是网络慢的时候）。
 * 如果没有去重，用户点两次课表里就多出两节一模一样的实验，而且删起来很烦
 * （同名课程在周视图里完全分不清哪条是哪条）。
 *
 * ## 去重键**只有一份**（这次修的）
 *
 * 早前这里是直接写 SQL 判重的：
 *   `SELECT ... WHERE name = ? AND day_of_week = ? AND week_start = ? AND week_end = ? AND start_period = ?`
 * 而 `labToSchedule.courseDedupeKey` / `taskDedupeKey` 只被测试脚本引用 ——
 * 也就是说"去重键的规格"和"线上实际行为"是两份实现，而且**已经漂移**
 * （SQL 多比了 `week_end`）。谁按文档改了 `courseDedupeKey`，测试会过、线上不变。
 *
 * 现在改成：先把该用户已有的行读成内存集合，键一律由那两个纯函数生成。
 * 数据量是"一个用户的课程数"（几百条），一次 SELECT 完全可接受；
 * 换来的是去重规则只有一个定义处。
 *
 * 关于 `week_end`：`courseDedupeKey` 刻意**不**含它 —— 实验课的 weekStart 恒等于
 * weekEnd，带上它等于把一个冗余字段塞进"用户能感知到的身份"里。
 *
 * ## 为什么整批一个事务
 *
 * 一次加入可能写十几条课程 + 十几条 DDL。中途失败留下"课表加了一半"的状态
 * 比整体失败更难解释，用户也没法判断该重试还是该手动补。
 */
import { db, tx } from './db.js'
import {
  courseDedupeKey,
  labTitlePrefix,
  taskDedupeKey,
  type LabCourseDraft,
  type LabSource,
  type LabTaskDraft
} from './labToSchedule.js'

export interface LabWriteCount {
  added: number
  skipped: number
}

export interface LabWriteResult {
  courses: LabWriteCount
  tasks: LabWriteCount
}

interface CourseKeyRow {
  name: string
  day_of_week: number
  week_start: number
  start_period: number
}

interface TaskKeyRow {
  title: string
  due_date: string
  due_time: string
}

/**
 * 写入一批课程草稿，返回是否真的新增。
 *
 * `seen` 是本次批量里"已存在"的键集合（进入时由 `applyLabDrafts` 预填，
 * 写入成功后再补进去），所以同一次调用里重复的两条草稿也只会写一条。
 *
 * ⚠️ 调用方负责包事务（`applyLabDrafts` 已经包好）；单独调用本函数时不要嵌套 tx()。
 */
export function insertLabCourse(userId: number, d: LabCourseDraft, seen: Set<string>): boolean {
  const key = courseDedupeKey(d)
  if (seen.has(key)) return false

  db.prepare(
    `INSERT INTO courses (user_id, name, teacher, location, day_of_week, week_start, week_end,
                          week_type, weeks, start_period, end_period, color, credits, term, grading_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, '')`
  ).run(
    userId,
    d.name,
    d.teacher,
    d.location,
    d.dayOfWeek,
    d.weekStart,
    d.weekEnd,
    d.weekType,
    d.startPeriod,
    d.endPeriod,
    d.color,
    d.term
  )
  seen.add(key)
  return true
}

/** 写入一条 DDL 草稿，返回是否真的新增（同标题+日期+时间视为已存在） */
export function insertLabTask(userId: number, d: LabTaskDraft, seen: Set<string>): boolean {
  const key = taskDedupeKey(d)
  if (seen.has(key)) return false

  db.prepare(
    `INSERT INTO tasks (user_id, title, course_id, type, due_date, due_time, priority, status, notes)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'pending', ?)`
  ).run(userId, d.title, d.type, d.dueDate, d.dueTime, d.priority, d.notes)
  seen.add(key)
  return true
}

/** 该用户已有的课程去重键（键的构成与 `courseDedupeKey` 完全一致） */
function existingCourseKeys(userId: number): Set<string> {
  const rows = db
    .prepare(`SELECT name, day_of_week, week_start, start_period FROM courses WHERE user_id = ?`)
    .all(userId) as unknown as CourseKeyRow[]
  return new Set(
    rows.map((r) =>
      courseDedupeKey({
        name: r.name,
        dayOfWeek: r.day_of_week,
        weekStart: r.week_start,
        startPeriod: r.start_period
      })
    )
  )
}

/** 该用户已有的 DDL 去重键 */
function existingTaskKeys(userId: number): Set<string> {
  const rows = db
    .prepare(`SELECT title, due_date, due_time FROM tasks WHERE user_id = ?`)
    .all(userId) as unknown as TaskKeyRow[]
  return new Set(rows.map((r) => taskDedupeKey({ title: r.title, dueDate: r.due_date, dueTime: r.due_time })))
}

/** 整批写入（单事务）：课程与 DDL 各自去重，返回新增/跳过计数 */
export function applyLabDrafts(
  userId: number,
  courses: readonly LabCourseDraft[],
  tasks: readonly LabTaskDraft[]
): LabWriteResult {
  const result: LabWriteResult = {
    courses: { added: 0, skipped: 0 },
    tasks: { added: 0, skipped: 0 }
  }
  if (courses.length === 0 && tasks.length === 0) return result

  tx(() => {
    if (courses.length > 0) {
      const seen = existingCourseKeys(userId)
      for (const d of courses) {
        if (insertLabCourse(userId, d, seen)) result.courses.added++
        else result.courses.skipped++
      }
    }
    if (tasks.length > 0) {
      const seen = existingTaskKeys(userId)
      for (const d of tasks) {
        if (insertLabTask(userId, d, seen)) result.tasks.added++
        else result.tasks.skipped++
      }
    }
  })
  return result
}

/* ---------------- 取消导入 ---------------- */

export type LabRemoveTarget = 'course' | 'task' | 'both'

export interface LabRemoveResult {
  courses: number
  tasks: number
}

/**
 * 删掉某个平台**导入进来**的课程 / DDL。
 *
 * ## 怎么认出"哪些是导入的"
 *
 * courses / tasks 表里没有「来源」列（加列要迁移，且对存量行没有回溯依据），
 * 所以用**标题前缀**反查 —— `labTitle()` 保证每条导入的课程名与 DDL 标题都以
 * `物理实验 · ` / `演示实验 · ` 开头，`labTitlePrefix()` 就是那个前缀。
 *
 * 为什么不按"当前快照里的实验"逐个算出精确键再删：学校那边把实验取消之后，
 * 快照里就没有这条了，算不出键，那些行会永远留在课表里 —— 而这恰恰是
 * 用户最想清掉的一类（"我已经退课了，课表上还挂着"）。
 *
 * 用 `instr(x, ?) = 1` 而不是 `LIKE '...%'`：`LIKE` 里 `_` 和 `%` 是通配符，
 * 实验名里出现下划线就会误伤；`instr` 是纯子串查找，位置为 1 即"以此开头"。
 *
 * 单事务：课程与 DDL 要么都删掉，要么都不动，避免"课表清了、DDL 还留着"。
 */
export function removeLabDrafts(
  userId: number,
  source: LabSource,
  target: LabRemoveTarget
): LabRemoveResult {
  const prefix = labTitlePrefix(source)
  const result: LabRemoveResult = { courses: 0, tasks: 0 }

  tx(() => {
    if (target !== 'task') {
      /* node:sqlite 的 .changes 类型是 number | bigint，统一收敛成 number */
      result.courses = Number(
        db.prepare(`DELETE FROM courses WHERE user_id = ? AND instr(name, ?) = 1`).run(userId, prefix).changes
      )
    }
    if (target !== 'course') {
      /* tasks.course_id 是 ON DELETE SET NULL，上面删课不会连带删 DDL */
      result.tasks = Number(
        db.prepare(`DELETE FROM tasks WHERE user_id = ? AND instr(title, ?) = 1`).run(userId, prefix).changes
      )
    }
  })
  return result
}
