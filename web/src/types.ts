/**
 * 与 docs/API.md 契约对应的前端类型定义
 */

export type UserRole = 'user' | 'admin'

/** 主题偏好：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 实际渲染用的主题（system 已被解析掉） */
export type ResolvedTheme = 'light' | 'dark'

export interface User {
  id: number;
  /** 登录账号（邮箱或学号），不直接展示 */
  username: string;
  /** 展示用昵称 */
  nickname: string;
  role: UserRole;
  /** 头像 data URL，未设置时为 null（界面回退为昵称首字） */
  avatar: string | null;
  /** 主题偏好 */
  theme: ThemeMode;
  /** 是否已看过新用户引导（0=未看，注册后首次登录会弹一次） */
  onboarded?: number;
  /** 自选主题色：色相数值字符串（0-359），null/未返回 = 默认青绿(166) */
  accent?: string | null;
  /**
   * 是否为「一次性游客账号」。
   *
   * true = 用户还没登录，当前这个身份是服务端自动签发的临时账号（能正常用课程/DDL/学期设置，
   * 但不能用教务导入与拍照导入）。前端据此：
   *   - 顶栏显示「游客」标记与登录入口；
   *   - 把课表导入 / 拍照导入 / 教务导入考试的入口换成登录引导；
   *   - 不弹新用户引导。
   *
   * ⚠️ 这只是**展示与引导**用的标记。真正的拦截在服务端（requireRealUser → 403），
   * 前端藏按钮挡不住任何人，所以任何"安全"判断都不要只写在这里。
   */
  isGuest?: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

/* ---- 个人中心：反馈工单 ---- */

/** 反馈类型（服务端 CHECK 白名单，与 feedback.ts 的 FEEDBACK_TYPES 一一对应） */
export type FeedbackType = 'bug' | 'suggestion' | 'consult' | 'other';

export type FeedbackStatus = 'pending' | 'replied' | 'closed';

export interface Feedback {
  id: number;
  userId: number;
  author: string;
  authorAvatar: string | null;
  type: FeedbackType;
  title: string;
  content: string;
  /** 附件图片（/uploads/ 相对路径，最多 9 张） */
  images: string[];
  /** 选填的联系方式（邮箱/QQ/微信）—— 服务端没有用户邮箱，管理员靠它主动触达 */
  contact: string;
  status: FeedbackStatus;
  /** 由论坛帖子迁移而来时记原帖 id；用户直接提交为 null */
  migratedFromPostId: number | null;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
}

export interface FeedbackReply {
  id: number;
  feedbackId: number;
  adminId: number;
  admin: string;
  content: string;
  createdAt: string;
}

/** 我提交过的工单统计 */
export interface MyFeedbackStats {
  total: number;
  replied: number;
  pending: number;
}

/** 管理端全站反馈统计 */
export interface FeedbackStats {
  total: number;
  pending: number;
  replied: number;
  closed: number;
  byType: Record<FeedbackType, number>;
}

/* ---- 个人中心：站内信 ---- */

/**
 * 站内信类型。
 *
 * ⚠️ 这里必须与两处服务端白名单逐字同步：
 *   - server/src/db.ts 的 messages.type CHECK 约束
 *   - server/src/feedback.ts 的 MESSAGE_TYPES
 * 历史上漏改过本文件，导致新类型在 DB 里对、接口也吐对，
 * 但前端路由表没这一项 → 点击通知**静默无反应**（不报错，最难查）。
 * 新增类型时三处一起改，并在 MessageCenter 的 switch 里补上分支。
 */
export type MessageType = 'feedback_reply' | 'system' | 'couple_plan' | 'data_change';

export interface StationMessage {
  id: number;
  type: MessageType;
  title: string;
  body: string;
  /** 关联工单 id（feedback_reply 类才有）；点击可跳转到该工单 */
  feedbackId: number | null;
  read: boolean;
  createdAt: string;
}

/** 管理员活跃度分级（由服务端统一判定，前端只负责上色与文案） */
export type ActivityLevel = 'active' | 'normal' | 'silent' | 'never'

/**
 * 教学周次表的一行 —— 「第 N 周 ↔ 日期」的权威映射（服务端 SemesterWeek 的前端镜像）。
 *
 * 有它之后周次不再靠「开学日 + 7 天」线性推算，而是查表：学校放假那一周
 * 教务/平台会整周跳过（不排课、也不算教学周），线性推算会从放假之后整体错位一周。
 */
export interface SemesterWeek {
  /** 平台周号：0=开学前一周（无课），1..N=教学周，其后为无课周 */
  week: number;
  /** 该教学周第一天（周一）YYYY-MM-DD */
  beginDate: string;
  /** 该教学周最后一天（周日）YYYY-MM-DD */
  endDate: string;
  /** 平台标记该周是否有课 */
  hasClass: boolean;
}

/** 周视图下拉里的一项：一个教学周，或一个被跳过的放假周 */
export interface WeekOption {
  /** 教学周号；**null = 放假周**（没有教学周号） */
  week: number | null;
  beginDate: string;
  endDate: string;
  hasClass: boolean;
}

export interface Semester {
  /** 学期名称，如 "2025-2026 秋季学期" */
  name: string;
  /** 学期第一周的周一，YYYY-MM-DD */
  startDate: string;
  /** 学期总周数 */
  totalWeeks: number;
  /** 显式周次表（含放假周空档）；缺失/为 null 时按旧的线性口径解释周次 */
  weeks?: SemesterWeek[] | null;
}

export interface Period {
  /** 节次序号，从 1 开始 */
  index: number;
  /** 开始时间 HH:mm */
  start: string;
  /** 结束时间 HH:mm */
  end: string;
}

/**
 * 一个学期（教学周口径）。
 * 课程通过 Course.term 归属学期，因此下学期改开学日不会影响历史学期的课表解释。
 */
export interface Term {
  /** 稳定标识（如 2026-fall），创建后不变；课程靠它归属学期 */
  id: string;
  name: string;
  startDate: string;
  totalWeeks: number;
  /** 显式周次表（见 SemesterWeek） */
  weeks?: SemesterWeek[] | null;
  officialCredits?: number | null;
  /** 由 GET /api/terms 附带：该学期的课程数（列表页展示用） */
  courseCount?: number;
}

export interface Settings {
  /**
   * 当前学期（服务端维护的镜像字段，始终等于 terms 里 currentTermId 指向的那项）。
   * 页面读学期信息继续用这里即可。
   */
  semester: Semester;
  periods: Period[];
  /** 学期列表（含当前学期） */
  terms?: Term[];
  /** 当前学期 id，指向 terms 中某项 */
  currentTermId?: string;
  /**
   * 教务系统官方"总学分"（来自 AA 课表页"共 X 学分"）。MIS 整表导入时写入，
   * 课表页学分卡"总学分"优先用它；未导入时为空，回退为按课程学分累加。
   * 多学期后它是「当前学期」的镜像，各学期的权威值在 Term.officialCredits 上。
   */
  officialCredits?: number | null;
}

export type WeekType = 'all' | 'odd' | 'even';

export interface Course {
  id: number;
  /** 课程名称，必填 */
  name: string;
  teacher: string;
  location: string;
  /** 1=周一 … 7=周日 */
  dayOfWeek: number;
  /** 起始周 */
  weekStart: number;
  /** 结束周 */
  weekEnd: number;
  /** all | odd(单周) | even(双周) */
  weekType: WeekType;
  /**
   * 精确上课周集合（升序周号数组）。非空时按集合精确匹配周次，
   * weekStart/weekEnd/weekType 仅为兼容摘要；null/缺省时按区间+单双周口径。
   */
  weeks?: number[] | null;
  /** 开始节次 */
  startPeriod: number;
  /** 结束节次 */
  endPeriod: number;
  /** 可选，默认 #4f7cff */
  color: string;
  /** 学分（可空）：课表导入时读取（本科教务 / 智慧课程平台），缺失为 null，可手动补填 */
  credits?: number | null;
  /**
   * 归属学期 id（对应 Settings.terms[].id）。
   * 服务端按「term = 当前学期 或 term 为 NULL（多学期改造前的存量数据）」过滤，
   * 因此前端不需要关心它，展示时保持不传即可。
   */
  term?: string | null;
  /** 考核方式与成绩占比说明，如“平时 30% + 实验 20% + 期末 50%”，可空 */
  gradingPolicy?: string | null;
}

export type Urgency = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'upcoming';
export type TaskType = 'homework' | 'exam' | 'other';
export type Priority = 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'done';

export interface Task {
  id: number;
  /** 任务标题，必填 */
  title: string;
  /** 关联课程（可空） */
  courseId?: number | null;
  type: TaskType;
  /** 截止日期，YYYY-MM-DD，必填 */
  dueDate: string;
  /** 截止时间，HH:mm，可选 */
  dueTime?: string | null;
  priority: Priority;
  status: TaskStatus;
  notes?: string;
  /** 手动排序权重，0=未手动排序 */
  sortOrder?: number;
  /** 服务端 join 返回，只读 */
  courseName?: string;
  /** 关联课程颜色，只读 */
  color?: string;
}

/** 考务：一场考试安排（来源可为教务系统抓取或手动添加） */
export interface Exam {
  id: number
  /** 考试科目名称 */
  courseName: string
  /** 考试日期 YYYY-MM-DD */
  examDate: string
  /** 开始时间 HH:mm（教务未公布时为空串） */
  startTime: string
  /** 结束时间 HH:mm */
  endTime: string
  location: string
  seat: string
  note: string
  /** mis=教务抓取 manual=手动添加 */
  source: 'mis' | 'manual'
  /** 一键转 DDL 生成的任务 id（未转则为 null） */
  taskId: number | null
  createdAt: string
}

/** 周视图网格中的课程（服务端按周次过滤后返回，含起止时间） */
export interface WeekCourse extends Course {
  /** 该节次实际开始时间 HH:mm */
  startTime: string;
  /** 该节次实际结束时间 HH:mm */
  endTime: string;
}

/** 周视图网格中的任务（服务端附带 urgency 计算） */
export interface WeekTask extends Task {
  urgency: Urgency;
}

export interface DayData {
  date: string;
  isToday: boolean;
  /** 1=周一 … 7=周日 */
  weekday: number;
  courses: WeekCourse[];
  tasks: WeekTask[];
  /**
   * 本学期有课、但本周不上（单双周 / 离散周 / 未开课）的课程。
   * 仅在 `getWeek(..., { inactive: true })` 时返回 —— 对应课表页「显示非本周课程」开关。
   */
  inactiveCourses?: WeekCourse[];
}

export interface WeekData {
  /** 请求的日期 */
  date: string;
  /** 教学周号：1..totalWeeks；放假周/开学前/结课后为 0（没有可指的教学周） */
  weekNumber: number;
  /** 未经夹取的原始周数：开学前 <1，学期中 1..totalWeeks，结课后 >totalWeeks */
  rawWeek: number;
  /** 学期阶段：before=还没开学 / active=学期中 / holiday=放假周（学校整周不排课）/ after=已结课 */
  weekState: 'before' | 'active' | 'holiday' | 'after';
  /** 本周一 */
  weekStart: string;
  /** 本周日 */
  weekEnd: string;
  semester: Semester;
  /** 周次下拉可选项（教学周 + 放假周）。空数组 = 该学期没有周次表，回退 1..totalWeeks */
  weekOptions: WeekOption[];
  days: DayData[];
}

export interface Overview {
  overdue: Task[];
  today: Task[];
  tomorrow: Task[];
  thisWeek: Task[];
  counts: {
    overdue: number;
    today: number;
    pending: number;
    done: number;
  };
}

/** 月视图网格单元 */
export interface MonthCell {
  date: string;
  isToday: boolean;
  /** 是否属于当前展示月份 */
  inMonth: boolean;
  /** 1=周一 … 7=周日 */
  weekday: number;
  /** 当天上课的课程数（按周次/单双周过滤） */
  courseCount: number;
  /** 该日属于放假周（学校整周不排课）—— 用于标出「假」 */
  holiday: boolean;
  tasks: WeekTask[];
}

export interface MonthData {
  date: string;
  year: number;
  /** 1-12 */
  month: number;
  semester: Semester;
  gridStart: string;
  gridEnd: string;
  cells: MonthCell[];
}

/* ---------------- 共享课表（空闲课表 / 情侣课表） ----------------

   服务端用一张 share_groups 表承载两种形态（kind 区分），前端也共用同一套类型：
   'group' = 多人空闲课表（只共享忙闲，不共享课程内容）
   'couple' = 情侣课表（2 人，可选共享课程明细）
   详见 server/src/share.ts 文件头的隐私边界说明。 */

export type ShareKind = 'group' | 'couple';

/** 节次区间 [起, 止]，闭区间（如 [1, 2] 表示第 1-2 大节被占用） */
export type PeriodRange = [number, number];

/** 快照里的一条课程明细（服务端已把周次展开为显式集合，前端不必再懂单双周口径） */
export interface ShareCourse {
  name: string;
  teacher: string;
  location: string;
  /** 1=周一 … 7=周日 */
  dayOfWeek: number;
  startPeriod: number;
  endPeriod: number;
  startTime: string;
  endTime: string;
  color: string;
  /** 该课程实际上课的教学周号集合 */
  weeks: number[];
}

/** 群组列表项 */
export interface ShareGroupSummary {
  id: number;
  kind: ShareKind;
  name: string;
  /** 加入密钥（6 位）；仅成员可见 */
  secret: string;
  /** 共同空闲的人数门槛，0 = 全部已同步成员 */
  threshold: number;
  ownerId: number;
  isOwner: boolean;
  memberCount: number;
  syncedCount: number;
  /** 我自己的同步时间；null = 还没同步 */
  mySyncedAt: string | null;
  /** 情侣形态的三个纪念日（YYYY-MM-DD）；群组形态恒为 null */
  anniversary: string | null;
  birthday: string | null;
  nextMeet: string | null;
  createdAt: string;
}

/** 群组详情里的一个成员 */
export interface ShareMemberView {
  id: number;
  userId: number;
  nickname: string;
  avatar: string | null;
  color: string;
  isOwner: boolean;
  isMe: boolean;
  synced: boolean;
  syncedAt: string | null;
  /** 我（或对方）是否共享课程明细；群组形态恒为 false */
  showDetail: boolean;
  termName: string | null;
  termId: string | null;
  /** 快照学期与我的当前学期是否一致；不一致时忙闲不能直接比较（界面需提示） */
  sameTerm: boolean;
  totalWeeks: number;
  /** busy[教学周号][weekday] = 占用的节次区间 */
  busy: Record<string, Record<string, PeriodRange[]>>;
  /** 课程明细；群组形态恒为空数组 */
  courses: ShareCourse[];
}

export interface ShareDetail {
  group: ShareGroupSummary;
  members: ShareMemberView[];
  /** 我当前学期的周次下拉项（与课表页同源，含放假周） */
  weekOptions: WeekOption[];
  periods: Period[];
  semester: { termId: string; termName: string; startDate: string; totalWeeks: number };
  /** 我自己的成员记录 id */
  myMemberId: number;
}

/* ---------------- 共同计划（情侣课表的「共同计划」板块） ----------------

   ⚠️ 这是**服务端权威**的双人共享数据：一条记录同时属于两个人，双方看到的是同一条。
   写操作（接受 / 婉拒 / 改期 / 取消）后必须用接口返回的 plan 覆盖本地状态，
   不要自己猜一个新状态 —— 状态机的合法迁移由服务端判定，本地猜测会造成
   「我这边显示已确认、对方那边还是待确认」的假一致。详见 server/src/plans.ts。 */

/**
 * 计划状态机：
 *   pending   待确认（刚发起，等对方回应）
 *   accepted  已确认（对方点了接受；只有此时起才会到点提醒）
 *   declined  对方婉拒（终态）
 *   cancelled 任一方的取消（终态）
 */
export type PlanStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

/** 当前状态下**我**能执行的动作，由服务端算好下发 —— 前端不复刻状态机 */
export type PlanAction = 'accept' | 'decline' | 'cancel' | 'edit';

export interface CouplePlan {
  id: number;
  title: string;
  /** 计划日期 YYYY-MM-DD */
  planDate: string;
  /** 起止时间 HH:mm；空串 = 只记日期不记时间 */
  startTime: string;
  endTime: string;
  location: string;
  note: string;
  status: PlanStatus;
  /** 发起人 userId */
  createdBy: number;
  /** 发起人昵称 */
  createdByName: string;
  /**
   * 对方的昵称（情侣固定 2 人，即除我之外的那一个）。用于「等 TA 确认」这类文案。
   * ⚠️ 不能用 createdByName 代替：我自己发起时它就是我自己，会显示成「等 我 确认」。
   */
  otherName: string;
  /** 我是不是发起人：决定这一侧显示「等 TA 确认」还是「接受 / 婉拒」 */
  isMine: boolean;
  /** 服务端算好的可执行动作（myActions.includes('accept') 之类） */
  myActions: PlanAction[];
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  title: string;
  planDate: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  note?: string;
}

/* ==================== 「应用」模块 ==================== */

/** 课程平台作业的截止状态（服务端判定；'unknown' = 平台没给截止时间，不猜） */
export type HomeworkDeadlineState = 'submitted' | 'dueSoon' | 'overdue' | 'open' | 'unknown'

export interface Homework {
  id: number;
  upId: number;
  snId: number | null;
  courseId: number;
  courseName: string;
  title: string;
  content: string;
  createDate: string;
  openDate: string;
  endTime: string;
  status: number;
  subStatus: string;
  submitCount: number;
  allCount: number;
  score: string;
  homeworkType: number;
  /** 0/1/2 → 作业 / 课程设计 / 实验报告（服务端翻译好） */
  typeLabel: string;
  syncedAt: string;
  deadlineState: HomeworkDeadlineState;
  submitted: boolean;
}

export interface HomeworkList {
  ok: boolean;
  items: Homework[];
  /** 上次同步的条目数；null = 从未同步过 */
  lastSyncedCount: number | null;
}

/** 数据变动（一次同步相对上次变了什么） */
export type DataChangeKind = 'added' | 'modified' | 'deleted'

export interface DataChange {
  domain: string;
  kind: DataChangeKind;
  label: string;
  detail: Record<string, string>;
}

/** 成绩的课程类别。'unknown' 表示拿不到类别 —— **不等于任选**，统计时单独列出 */
export type GradeCourseType = 'required' | 'limited' | 'elective' | 'pe' | 'unknown';

export interface Grade {
  id: string;
  courseName: string;
  courseTeacher: string;
  /** 百分制分数；等级制/未出分时为 null */
  courseScore: number | null;
  /** 原始成绩文本（"优秀"/"通过"），分数为 null 时展示它 */
  scoreText: string;
  courseCredits: number | null;
  courseYear: string;
  semester: string;
  detail: string;
  courseType: GradeCourseType;
  courseCode: string;
}

/** 成绩统计（服务端算好；前端只展示、不复刻算法） */
export interface GradeStats {
  /** 有分数且计入统计的课程数 */
  counted: number;
  /** 学分加权平均；无有效数据时为 null */
  weightedAverage: number | null;
  average: number | null;
  totalCredits: number;
  creditsByType: Record<GradeCourseType, number>;
  /** 挂科门数（<60）；等级制不计入 —— 不猜 */
  failed: number;
}

export interface GradeList {
  ok: boolean;
  items: Grade[];
  stats: GradeStats;
  lastSyncedCount: number | null;
}

/* ---------------- 课件（智慧课程平台） ---------------- */

export type CoursewareKind = 'folder' | 'file';

export interface CoursewareNode {
  id: string;
  name: string;
  kind: CoursewareKind;
  /** 文件才有：下载用的资源 id */
  rpId: string;
  ext: string;
  size: string;
  teacherName: string;
  inputTime: string;
  downloadCount: number;
  canDownload: boolean;
}

export interface CoursewareList {
  courseName: string;
  nodes: CoursewareNode[];
  /** 该课程整体没有资源（合法空，不是错误） */
  empty: boolean;
}

/* ---------------- 校园邮箱（只读） ---------------- */

/** 收件箱列表里的一封邮件（不含正文） */
export interface MailSummary {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  sentAt: string;
  sizeBytes: number;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface MailListResult {
  ok: boolean;
  total: number;
  messages: MailSummary[];
}

export interface MailAttachmentMeta {
  id: string;
  name: string;
  sizeBytes: number | null;
  contentType: string | null;
}

export interface MailDetail {
  id: string;
  from: string[];
  to: string[];
  cc: string[];
  subject: string;
  sentAt: string;
  /** 服务端已把正文转为纯文本（不渲染平台 HTML） */
  bodyText: string;
  attachments: MailAttachmentMeta[];
}
