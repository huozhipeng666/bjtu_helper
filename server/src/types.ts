/** 与 docs/API.md 契约一致的共享类型 */

export type UserRole = 'user' | 'admin'

/** 界面主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

export interface User {
  id: number
  /** 登录账号（邮箱或学号），唯一 */
  username: string
  /** 展示用昵称 */
  nickname: string
  role: UserRole
  /** 头像，data URL（data:image/...;base64,...），未设置时为 null */
  avatar: string | null
  /** 主题偏好，默认深色 */
  theme: ThemeMode
  /** 新用户引导是否已看过：0=未看过（前端应弹一次功能说明），1=已看过 */
  onboarded: number
  /** 自选主题色：色相数值字符串（0-359），null = 默认青绿(166) */
  accent: string | null
  /**
   * 是否为「一次性游客账号」（未登录体验用）。
   *
   * 语义：游客账号与真实账号在数据模型上完全同构（同样有 user_id、同样能读写
   * courses/tasks/exams/settings），差别只在三处 ——
   *   1. 不可密码登录（password_hash 为空串，且 getUserByUsername 排除游客）；
   *   2. 不计入 countUsers()（否则第一个访客会被判定成「首个用户」直接拿到管理员）；
   *   3. 会被 TTL 清理任务回收（见 purgeStaleGuests）。
   * 登录后其数据由 claimGuestData 迁移到真实账号，随后游客账号被删除。
   */
  isGuest: boolean
}

/** 考务：一条考试安排（教务系统抓取或手动添加） */
export interface Exam {
  id: number
  courseName: string
  /** 考试日期 YYYY-MM-DD */
  examDate: string
  /** 开始时间 HH:mm；教务未公布时为空串 */
  startTime: string
  endTime: string
  location: string
  seat: string
  note: string
  /** mis=教务抓取 / manual=手动添加 */
  source: 'mis' | 'manual'
  /** 一键转 DDL 后关联的任务 id；未转换为 null */
  taskId: number | null
  createdAt: string
}

export interface Period {
  index: number
  start: string // HH:mm
  end: string // HH:mm
}

/**
 * 教学周次表的一行 —— **「第 N 周 ↔ 日期」的权威映射**。
 *
 * 为什么必须有它：早期周次是纯线性推算的（`floor((date - startDate) / 7) + 1`），
 * 前提是「每个自然周都算一个教学周」。但学校一旦放假（如国庆），放假那一周
 * **不排课、也不算教学周**，教务与智慧课程平台的周次表会直接**跳过**它 ——
 * 于是线性推算从放假之后整体错位一周（第 4 周的课显示成第 5 周、日期整体后移）。
 *
 * 有了这张表，周次不再靠算，而是靠查：
 *  - 命中某一行 → 就是该行的教学周号；
 *  - 落在两行之间的空档 → 放假周（学校没排课）；
 *  - 落在第一行之前 / 最后一行之后 → 开学前 / 已结课。
 *
 * 来源：智慧课程平台 `myTimeTableDetail.shtml?method=getJxz` 的 `jxzList`。
 */
export interface SemesterWeek {
  /** 平台周号：0=开学前一周（无课），1..N=教学周，其后为无课周 */
  week: number
  /** 该教学周第一天（周一）YYYY-MM-DD */
  beginDate: string
  /** 该教学周最后一天（周日）YYYY-MM-DD */
  endDate: string
  /** 平台标记该周是否有课（`sfyk === '(有课)'`） */
  hasClass: boolean
}

export interface SemesterSettings {
  name: string
  startDate: string // YYYY-MM-DD，学期第一周的周一
  totalWeeks: number
  /**
   * 显式周次表（含放假周造成的空档）。
   * 缺失/为空时退回旧的线性推算口径 —— 存量用户与手工建的学期都不受影响。
   */
  weeks?: SemesterWeek[] | null
}

/**
 * 一个「学期」（教学周口径）。
 *
 * 为什么要把它独立成实体：早期版本每个用户只有一份学期设置（Settings.semester），
 * 而课程表里存的是「第 N 周」这种相对周号 —— 于是一旦下学期改开学日，
 * **全部历史课程的周次显示都会跟着整体偏移**（2026-09-07 那次 8/31→9/7 的迁移就是这个问题）。
 * 引入 Term 后：课程归属于某个 term（Course.term），切换当前学期不影响其它学期的解释。
 */
export interface Term {
  /** 稳定标识，创建后不再变化（如 `2026-fall`）。课程通过它归属学期 */
  id: string
  name: string
  startDate: string
  totalWeeks: number
  /** 显式周次表（见 SemesterWeek）。缺失时该学期按线性口径解释周次 */
  weeks?: SemesterWeek[] | null
  /** 教务官方总学分（按学期各自记录；旧的顶层字段作为「当前学期」的镜像保留） */
  officialCredits?: number | null
}

export interface Settings {
  /**
   * 当前学期（**镜像字段**）。
   * 所有既有读取方（周/月视图、设置页表单、课表文案）都读这里，因此保留它可以让
   * 多学期改造对既有代码零侵入 —— 它始终等于 terms 里 currentTermId 指向的那一项。
   */
  semester: SemesterSettings
  /** 学期列表（含当前学期）。缺失时由 semester 合成（见 terms.ts normalizeSettings） */
  terms?: Term[]
  /** 当前学期 id，指向 terms 中的某项 */
  currentTermId?: string
  periods: Period[]
  /**
   * 教务系统官方"总学分"（来自 AA 课表页上方选课摘要的"共 X 学分"）。
   * 仅在用户 MIS 整表导入时写入，作为课表页学分卡"总学分"的权威口径；
   * 未导入或该学期无此值时保持 undefined/null，前端回退为按课程学分累加。
   * 多学期后它是「当前学期」的镜像，权威值在各 Term.officialCredits 上。
   */
  officialCredits?: number | null
}

export type WeekType = 'all' | 'odd' | 'even'

export interface Course {
  id: number
  name: string
  teacher: string
  location: string
  dayOfWeek: number // 1=周一 … 7=周日
  weekStart: number
  weekEnd: number
  weekType: WeekType
  /**
   * 精确上课周集合（升序去重的周号数组）。
   * 非 null/非空时按此集合精确匹配周次（可表达逗号周列表与任意跳段），
   * 此时 weekStart/weekEnd/weekType 仅为兼容摘要（min/max/奇偶性）；
   * null 时按「区间 + 单双周」旧口径过滤。
   */
  weeks?: number[] | null
  startPeriod: number
  endPeriod: number
  color: string
  /** 学分（可空）：课表导入时读取（本科教务 / 智慧课程平台），缺失时为 null，可手动补填 */
  credits?: number | null
  /**
   * 归属学期 id（对应 Settings.terms[].id）。
   * NULL = 多学期改造前写入的存量课程，读取时按「属于当前学期」处理
   * （宁可多显示、也不要让用户的课凭空消失）；迁移脚本会回填为当前学期 id。
   */
  term?: string | null
  /** 考核方式与成绩占比说明，如“平时 30% + 实验 20% + 期末 50%”，可空 */
  gradingPolicy?: string | null
}

/**
 * 物理实验课（实验教学教务管理系统，wlsy.bjtu.edu.cn）—— **功能已下架**。
 *
 * 类型与 lab_courses 表一并保留：表里仍有用户历史上导入的实验数据，类型是该表结构的
 * 唯一说明。服务端不再有读写该表的业务代码，仅保留 /api/lab-courses 兼容占位路由。
 * 详见 db.ts 中 lab_courses 建表处的注释。
 */
export interface LabCourse {
  id: number
  name: string
  teacher: string
  location: string
  /** 实验日期 YYYY-MM-DD */
  date: string
  /** HH:mm */
  startTime: string
  /** HH:mm */
  endTime: string
  /** 第几次（两周制：1=第1周，2=第2周镜像） */
  round: number
  color: string
}

export type TaskType = 'homework' | 'exam' | 'other'
export type Priority = 'high' | 'medium' | 'low'
export type TaskStatus = 'pending' | 'done'

export interface Task {
  id: number
  title: string
  courseId: number | null
  type: TaskType
  dueDate: string // YYYY-MM-DD
  dueTime: string // HH:mm，可空字符串
  priority: Priority
  status: TaskStatus
  notes: string
  sortOrder?: number // 手动排序权重，0=未手动排序
  courseName?: string
  color?: string
}

export type Urgency = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'upcoming'

export interface WeekCourse extends Course {
  startTime: string
  endTime: string
}

export interface WeekTask extends Task {
  urgency: Urgency
}

export interface WeekDay {
  date: string
  isToday: boolean
  weekday: number
  courses: WeekCourse[]
  tasks: WeekTask[]
  /**
   * 本学期有课、但**本周不上**的课程（按 dayOfWeek 落到对应的那一天）。
   *
   * 只在请求带 `inactive=1` 时返回（课表页「显示非本周课程」开关），默认不下发 ——
   * 它通常是 `courses` 的一到两倍体积，而绝大多数用户并不需要看它。
   * 用途是让用户一眼看出"这门课这周为什么没出现在表上"（单双周 / 离散周 / 未开课），
   * 而不是怀疑课表导入漏了课。
   */
  inactiveCourses?: WeekCourse[]
}

/** 周视图下拉里的一项：一个教学周，或一个被跳过的放假周 */
export interface WeekOption {
  /** 教学周号；**null = 放假周**（学校整周不排课，没有教学周号） */
  week: number | null
  beginDate: string
  endDate: string
  hasClass: boolean
}

export interface WeekData {
  date: string
  /**
   * 教学周号：1..totalWeeks。
   * 落在放假周/开学前/结课后时为 **0**（此时无任何教学周可指），前端据此不标「本周」。
   */
  weekNumber: number
  /** 未经夹取的原始周数：开学前 <1；学期内 1..totalWeeks；已结课后 >totalWeeks */
  rawWeek: number
  /**
   * 学期所处阶段：
   *  - before  开学前
   *  - active  学期中
   *  - holiday **放假周**（学校整周不排课，如国庆）—— 需明确提示「放假无课程」，
   *            否则用户会以为课表没导入成功
   *  - after   已结课
   */
  weekState: 'before' | 'active' | 'holiday' | 'after'
  weekStart: string
  weekEnd: string
  semester: SemesterSettings
  /**
   * 周次下拉的可选项（教学周 + 放假周，按日期升序）。
   * 由服务端从周次表推导，前端不再自己算 —— 放假周是「两段教学周之间的空档」，
   * 这个推导只应有一份实现。没有周次表时为空数组，前端回退到 1..totalWeeks。
   */
  weekOptions: WeekOption[]
  days: WeekDay[]
}

export interface Overview {
  overdue: Task[]
  today: Task[]
  tomorrow: Task[]
  thisWeek: Task[]
  counts: { overdue: number; today: number; pending: number; done: number }
}

export interface MonthCell {
  date: string
  isToday: boolean
  inMonth: boolean
  weekday: number // 1=周一 … 7=周日
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
