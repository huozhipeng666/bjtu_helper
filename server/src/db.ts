import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import type { SemesterSettings, Settings, Term, ThemeMode, User } from './types.js'
import { makeCaptchaCode, renderCaptchaSvg } from './captcha.js'
import { normalizeSettings } from './terms.js'
import { hardenDataDir } from './dataPerms.js'
import {
  DEFAULT_PERIODS,
  DEFAULT_TOTAL_WEEKS,
  defaultSemesterName,
  defaultSemesterStartDate,
  defaultSettings
} from './semesterDefaults.js'
/* 默认学期 / 节次默认值已抽到纯模块 semesterDefaults.ts（迁移脚本需要在不打开数据库的
   前提下复用同一套口径），此处再导出，保证既有 `from './db.js'` 的引用路径不变。 */
export {
  DEFAULT_PERIODS,
  DEFAULT_TOTAL_WEEKS,
  defaultSemesterName,
  defaultSemesterStartDate,
  defaultSettings
}

// 数据目录：优先 DATA_DIR 环境变量；否则锚定当前工作目录（systemd 的 WorkingDirectory=/opt/bjtu-helper，或本地仓库根）
const dataDir = process.env.DATA_DIR ? join(process.env.DATA_DIR) : join(process.cwd(), 'server', 'data')
/* 0700：这里装的是**全站用户的真实数据**（账号、会话、加密后的平台凭据、上传截图）。
   mkdirSync 的默认 mode 受 umask 影响，线上实测是 755 —— 意味着同机任何其它系统的
   低权用户都能 `ls` 甚至读到 644 的 bjtu-helper.db。单租户云主机上不算致命，但这是
   "纵深防御里最便宜的一层"：多用户/多服务共存（宝塔面板、docker、其它站点）时，
   它就是唯一挡住横向读取的东西。已存在的目录用 chmodSync 兜一次，不依赖重装。 */
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
try {
  chmodSync(dataDir, 0o700)
} catch {
  /* Windows / 无权限时忽略：跨平台的 mode 语义不同，不能让启动因此失败 */
}

/** 论坛图片等待放目录（dataDir/uploads），由 index.ts 写入并静态托管 */
export const dataDirPath = dataDir

export const db = new DatabaseSync(join(dataDir, 'bjtu-helper.db'))
/* 0600：库文件连同 -wal/-shm 都只让属主读写。DatabaseSync 建库用的是默认 umask（线上实测 644），
   于是同机其它用户能直接把整库拷走。chmod 放在打开之后、任何写入之前，代价可忽略。 */
try {
  chmodSync(join(dataDir, 'bjtu-helper.db'), 0o600)
} catch {
  /* 见上：Windows / 只读挂载时忽略 */
}
/**
 * 收口数据目录里**历史遗留**的宽松权限文件。具体规则与"为什么不能只靠 UMask"
 * 都写在 dataPerms.ts 里（那里是可注入依赖的纯逻辑，回归能逐条钉住文件名匹配）。
 *
 * 为什么不在这里内联正则：文件名匹配写松了会误伤运维自己放进来的文件、
 * 写紧了会漏掉 `-wal`/`-shm`/`.db.gz`，而这两种错误**都不会报错**，
 * 只有专门单测才能发现。抽出去才测得动。
 */
try {
  hardenDataDir(dataDir)
} catch {
  /* 权限收紧是加固，不是启动前提：任何异常都不该让服务起不来 */
}
db.exec('PRAGMA foreign_keys = ON;')
db.exec('PRAGMA journal_mode = WAL;')
/* 写锁等待：单进程单连接时用不到，但备份/迁移脚本与服务同时开库时，
   没有它写操作会立刻抛 SQLITE_BUSY，而不是等待锁释放后重试。 */
db.exec('PRAGMA busy_timeout = 5000;')
/* WAL 下 synchronous 默认仍是 FULL —— 每次 COMMIT 都 fsync。
   本项目的写路径相当密（每个请求的 touchLastSeen、登录时 3 条写、每条站内信一个事务），
   在云盘上 fsync 是实打实的延迟。NORMAL 是 WAL 的推荐档位：
   断电最多丢**最后一个**已提交事务，但数据库**不会损坏**（这是 WAL + NORMAL 的保证）。 */
db.exec('PRAGMA synchronous = NORMAL;')
/* 临时表（ORDER BY CASE / GROUP BY 会用到）放内存，避免落盘到 /tmp。 */
db.exec('PRAGMA temp_store = MEMORY;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  feed_token TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captchas (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- 密码重置申请（设计与安全要点见文件下方 createPasswordReset 处的注释）
-- pending_hash 存的是**散列**，明文不落库；批准时直接搬进 users.password_hash。
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pending_hash TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at TEXT,
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ===== 论坛（功能已下架，2026-10-01 由「个人中心」取代）=====
-- topics / posts / comments / post_likes / post_bumps / post_views / notifications
-- 七张表与存量数据刻意保留，不做 DROP：删表不可逆，而不再读写的表零成本。
-- 帖子的正文/图片/作者/时间已由 scripts/migrate-forum-to-feedback.mts 迁为反馈工单，
-- 评论/点赞/蹲蹲/围观/话题只进 JSON 备份、不迁移（语义不同：公开讨论 ≠ 私密工单）。
-- 服务端仅保留 /api/forum/* 兼容占位路由（读返回空、写返回 410），
-- 以免已发布的 APK 与浏览器缓存的旧前端 404 白屏。
-- 如确需彻底清理，请先备份数据库再手动 DROP 这七张表。
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  /* 楼中楼回复：NULL = 顶层评论；否则指向同帖下的父评论。
     自引用外键 + ON DELETE CASCADE（PRAGMA foreign_keys = ON 已开），
     删父评论时其所有子回复一并清理，不会出现"回复了不存在的评论"。
     注意 parent_id 存的是「所在的楼」（回复的回复会被折叠到同一楼），
     真正"在回复谁"另存于 reply_to_user_id —— 两者不等价，见下。 */
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  /* 真正被回复的人。为什么不直接由 parent_id 推导：
     楼中楼只保留一层，回复"回复"时 parent_id 会指向所在楼的根评论，
     如果按 parent_id 取作者，界面会显示「回复 @楼主」而用户明明点的是另一个人 ——
     文案与操作不一致，是最容易被当成 bug 的一类错误。
     顶层评论该列为 NULL。 */
  reply_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);

/** 蹲蹲（与点赞独立的交互：单独计数、单独按钮） */
CREATE TABLE IF NOT EXISTS post_bumps (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);

/** 围观去重表：每个用户对每个帖子只计一次浏览，UI 列表上展示"围观 N" */
CREATE TABLE IF NOT EXISTS post_views (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('like', 'comment')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_name TEXT NOT NULL,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  post_title TEXT NOT NULL,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  comment_preview TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 反馈工单（「联系管理员」的落地形态，2026-10-01 起）=====
/*
  为什么不做成站内信/私信：
    私信是「两个人对等聊天」，而反馈是「用户提单 → 管理员处理 → 回复」的有状态工单。
    工单需要 status（待处理/已回复/已关闭）、需要按类型筛选、需要"已处理数"这类管理视角的统计，
    这些用私信模型都要额外加字段才能表达，不如直接建成工单。

  为什么 type 用 CHECK 白名单：
    类型要参与管理端筛选与统计，一旦允许自由文本，同一个"课表导入失败"
    会出现"bug""报错""功能异常"三种写法，统计立刻失效。

  为什么 images 与 posts.images 同为 JSON 数组：
    复用前端既有的「选图即上传」流程与 /uploads 静态托管，不引入第二套附件机制。
    ⚠️ uploads.ts 的孤儿图片清理器以 posts.images ∪ feedbacks.images 为引用来源，
       漏掉任何一边都会把仍在使用的图片误判为孤儿删掉。
*/
CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** bug=报错 / suggestion=功能建议 / consult=使用咨询 / other=其他 */
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('bug','suggestion','consult','other')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  /** 附件图片：JSON 数组（/uploads/ 相对路径），最多 9 张 */
  images TEXT NOT NULL DEFAULT '[]',
  /**
   * 选填的联系方式（邮箱 / QQ / 微信）。
   *
   * 为什么必须有这个字段：users 表只有 username + password_hash，**没有邮箱**，
   * 服务端无法主动给用户发信。管理员在站内回复后，如果用户长期不登录就永远看不到。
   * 留一个可选联系方式，管理员才能在有急事时主动触达。
   * 选填而非必填：填了是加分项，强制填会劝退只想随手报个 bug 的用户。
   */
  contact TEXT NOT NULL DEFAULT '',
  /** pending=待处理 / replied=已回复 / closed=已关闭 */
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','replied','closed')),
  /** 来源论坛迁移时记原帖 id；NULL = 用户直接提交。
      兼作迁移幂等键（UNIQUE），重复跑迁移脚本不会产生重复工单。 */
  migrated_from_post_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  管理员回复：一个工单可以来回多轮，因此独立成表而不是在 feedbacks 上放一个 reply 字段。
  放字段只能存"最后一次回复"，第二轮沟通就会覆盖掉第一轮，用户看到的历史是残缺的。
*/
CREATE TABLE IF NOT EXISTS feedback_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 站内信 =====
/*
  与论坛时代的 notifications 表的区别（为什么不复用）：
    notifications 是论坛专用：type 只有 like/comment 两种，且 post_id 是 NOT NULL 外键指向 posts。
    论坛下架后 posts 不再产生新数据，这张表在结构上就表达不了「管理员回复了你的反馈」这类通知，
    改造它需要重建表并回填，代价高于新建。

  为什么 feedback_id 可空：
    站内信不只是反馈回复，后续的系统公告/维护通知也走这张表，那类消息没有对应工单。
    查询时按 type 分流渲染即可。

  为什么 type 里含 couple_plan：
    情侣「共同计划」的发起 / 接受 / 婉拒 / 改期 / 取消 / 到点提醒都要落进同一个收件箱，
    复用一张表 + 一个未读红点，用户不必在两个地方找通知。
    ⚠️ 存量库的 messages 表带 CHECK 约束，新增枚举值走 ensureTableRebuild 重建（见下方迁移块），
    不能只改这里 —— 建表语句只在**全新库**生效。
*/
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  /** 收件人 */
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** feedback_reply=反馈回复 / system=系统通知 / couple_plan=情侣共同计划动态 / data_change=校园数据变动 */
  type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('feedback_reply','system','couple_plan','data_change')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  /** 关联工单；点开通知可直接跳到该工单。system 类为 NULL */
  feedback_id INTEGER REFERENCES feedbacks(id) ON DELETE CASCADE,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 前端运行时错误上报。
-- 为什么需要它：React 的渲染异常会卸载整棵树（用户看到白屏），而浏览器控制台里的
-- 报错用户根本不会转述。没有这张表时，"白屏"类工单只能靠猜；有了它，
-- 至少能拿到 message + 前 2KB 堆栈 + 出问题的路由。
-- 刻意**只**存这些：不存完整 DOM、不存用户数据、不存截图。
CREATE TABLE IF NOT EXISTS client_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 允许匿名（登录页崩了就还没有 userId）；用户被删后置 NULL 而不是级联删除整条记录
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  stack TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  teacher TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  week_start INTEGER NOT NULL DEFAULT 1,
  week_end INTEGER NOT NULL DEFAULT 16,
  week_type TEXT NOT NULL DEFAULT 'all' CHECK (week_type IN ('all','odd','even')),
  start_period INTEGER NOT NULL,
  end_period INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f7cff',
  grading_policy TEXT NOT NULL DEFAULT '',
  -- links（课程资源/网盘/群号）已下线：功能上线当天即被移除，服务端不再读写该列。
  -- 刻意保留而非 DROP COLUMN：删列不可逆，而一个不再读写的列零成本；
  -- 若哪天要把这个功能做回来，用户当时填过的内容还在。参见 lab_courses 的同款处置。
  links TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 物理实验课表（功能已下架）。表与存量数据刻意保留，不做 DROP：
-- 删表不可逆，而一张不再读写的表零成本；服务端仅保留 /api/lab-courses 兼容占位路由。
-- 如确需彻底清理，请先备份数据库再手动执行 DROP TABLE lab_courses。
CREATE TABLE IF NOT EXISTS lab_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  teacher TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#f783ac',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'homework' CHECK (type IN ('homework','exam','other')),
  due_date TEXT NOT NULL,
  due_time TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  notes TEXT NOT NULL DEFAULT '',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);

/** 考务（考试安排）：来源可为教务系统抓取或手动添加 */
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** 考试科目名称 */
  course_name TEXT NOT NULL,
  /** 考试日期 YYYY-MM-DD */
  exam_date TEXT NOT NULL,
  /** 开始时间 HH:mm（可空，教务未公布时为空串） */
  start_time TEXT NOT NULL DEFAULT '',
  /** 结束时间 HH:mm */
  end_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  seat TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  /** 来源：mis=教务抓取 manual=手动添加 */
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('mis','manual')),
  /** 一键转 DDL 生成的任务 id（用于避免重复创建；任务被删则置空） */
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, course_name, exam_date, start_time)
);

-- 共享课表（空闲课表 / 情侣课表）：一张表承载两种形态，靠 kind 区分。
--   kind='group'  → 多人时间协作群组：只共享「忙/闲」，不共享具体课程内容
--   kind='couple' → 双人形态：除忙闲外还可共享课程明细（受 show_detail 开关约束）
-- 两者共用同一套成员表与同步快照，前端只换皮不换逻辑（图1/图4/图5 本就是同一套数据的不同视图）。
CREATE TABLE IF NOT EXISTS share_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('group','couple')),
  name TEXT NOT NULL DEFAULT '',
  -- 加入密钥：6 位大写字母数字（去掉了易混的 0/O/1/I）。全局唯一，加人靠它。
  secret TEXT NOT NULL DEFAULT '',
  -- 共同空闲的人数门槛：0 = 默认看全部已同步成员的共同空闲
  threshold INTEGER NOT NULL DEFAULT 0,
  -- 情侣形态的三个纪念日（YYYY-MM-DD，可空）。群组形态恒为 NULL。
  -- 存服务端而不是本地：「下次见面」是两个人共享的约定，一方填了对方看不到就失去意义。
  anniversary TEXT,
  birthday TEXT,
  next_meet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS share_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES share_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 昵称/头像/配色在**加入时快照**：群组详情要展示成员，而成员可能改昵称、换头像，
  -- 更可能（游客转正、账号回收）已经查不到 —— 快照保证列表永远画得出来。
  nickname TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  color TEXT NOT NULL DEFAULT '#4f7cff',
  -- 忙闲快照 JSON（见 share.ts 的 ShareSnapshot）。NULL = 还没同步过课表。
  snapshot TEXT,
  synced_at TEXT,
  -- 是否把自己的**课程明细**（课名/地点/教师）共享给同群成员。
  -- 刻意做成**成员级**而非群级：隐私是单方面的，我可以看你的课表，你也可以选择不给我看；
  -- 群组形态（kind='group'）恒不下发明细，只有情侣形态才读这一位。
  show_detail INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, user_id)
);

-- 共同计划（情侣课表的「共同计划」板块）。
--
-- 为什么必须是独立表、而不是复用 tasks：
--   tasks 是**单人**表（user_id NOT NULL，语义是"我的待办"）。共同计划的本质是
--   「两个人对同一件事的**共同约定**」，它需要三个 tasks 表达不了的东西：
--     ① 一条记录归属**两个人**，双方看到的是同一条（不是各自一份副本）；
--     ② 需要**状态机**（待确认 → 已确认 / 已婉拒 / 已取消），且「确认」是对方做出的动作；
--     ③ 需要**双方各自的提醒标记**，避免定时任务重复发通知。
--   若塞进 tasks 并加 group_id，则每个涉及 DDL 的查询（列表 / 排序 / 统计 / ICS 导出）
--   都要先判"这条是不是共享计划"，两套语义缠在一张表里，改一处漏一处。
--
-- 为什么不做成 share_groups 上的 JSON 列：
--   计划会不断增删改、要按时间排序、要按状态过滤、要用 reminder 标记做幂等；
--   JSON 列无法建索引、无法原子更新单条、并发写会整列覆盖互相丢数据。
CREATE TABLE IF NOT EXISTS share_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES share_groups(id) ON DELETE CASCADE,
  -- 发起人。决定「谁需要被通知」：通知永远发给**除发起人外的另一名成员**。
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- 计划日期 YYYY-MM-DD 与起止时间 HH:mm（起止可为空串 = 只记日期不记时间）
  plan_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  /*
    状态机（谁在什么时机推进）：
      pending   —— 刚发起，等**对方**确认。这是初始态。
      accepted  —— 对方点了「接受」。只有此刻起，"到点提醒"才有意义。
      declined  —— 对方点了「婉拒」。记录保留（发起人要看得到结果），但不再提醒。
      cancelled —— 发起人取消了（或改期时先取消旧条）。任何一方都可见。
    ⚠️ 刻意区分 declined 与 cancelled：前者是"对方不答应"，后者是"我收回"，
    文案与责任归属完全不同，合并成一个"无效"会让用户看不懂发生了什么。
  */
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  -- 对方做出回应的时间（pending 时为 NULL）。前端用它显示「TA 于 xx 确认」。
  responded_at TEXT,
  -- 临近提醒：定时任务给**双方各发一条**后写入本列做幂等。
  -- 为什么是单列而不是"每人一列"：两人在同一时刻收到的是同一条提醒，
  -- 任务只要保证「这条计划只触发一次」即可；收件人由成员表实时推导。
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
  智慧课程平台作业（课程平台作业页的数据源）。

  为什么单独一张表，而不是塞进 tasks：
    tasks 是**用户自己写的 DDL**（单人语义、可任意改标题改日期），
    作业是**学校下发的客观事实**（有截止时间、有提交状态、有分数）。
    混在一起会导致：
      ① 用户把作业任务的日期改了，同步一次又被打回原样；
      ② 作业被删掉后重新同步，用户的备注/优先级全丢。
    所以两套数据各自成表，前端展示时**并列**而不是合并。

  ⚠️ user_id + up_id 联合唯一：up_id 是平台侧作业主键，
  但不同用户可能修同一门课、拿到同一个 up_id，单靠 up_id 唯一会互相覆盖。
*/
CREATE TABLE IF NOT EXISTS homework_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 平台侧作业主键（upId）；提交/查看详情都靠它 */
  up_id INTEGER NOT NULL,
  /* 提交记录 id（snId），未提交时为 NULL */
  sn_id INTEGER,
  course_id INTEGER NOT NULL,
  course_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  create_date TEXT NOT NULL DEFAULT '',
  open_date TEXT NOT NULL DEFAULT '',
  /* 截止时间（平台原始格式，如 2026-10-07 23:00）。比较时用 localStamp() */
  end_time TEXT NOT NULL DEFAULT '',
  /* 平台状态码 + 中文提交状态（已提交 / 未提交 / 待批阅 …） */
  status INTEGER NOT NULL DEFAULT 0,
  sub_status TEXT NOT NULL DEFAULT '',
  submit_count INTEGER NOT NULL DEFAULT 0,
  all_count INTEGER NOT NULL DEFAULT 0,
  score TEXT NOT NULL DEFAULT '',
  /* 0=作业 1=课程设计 2=实验报告 */
  homework_type INTEGER NOT NULL DEFAULT 0,
  /* 同步批次标记：用于识别"某条作业已从平台消失"（教师撤回），
     而不是直接删 —— 保留历史，前端按 synced_at 过滤展示 */
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, up_id)
);
CREATE INDEX IF NOT EXISTS idx_homework_user_end ON homework_items(user_id, end_time);

/*
  作业详情缓存（老师上传的附件列表 + 详情正文）。

  ── 为什么单独一张表，而不是给 homework_items 加列 ────────────────
  详情来自另一个接口（queryStudentCourseNote，按需实时拉取），
  与列表同步的节奏完全不同：列表每次 sync 全量刷新，详情只在用户
  展开某条作业时才请求一次。把两者塞进一行会让「sync 写入」和
  「读详情」互相覆盖 —— 列表 UPSERT 一次就把详情抹掉了。

  ── 为什么要缓存 ──────────────────────────────────────────────
  详情接口要 (upId, courseId, teacherId) 三元组，每次展开都要重走
  一次 bksy SSO + sessionid 换取（几秒）。用户反复展开同一条作业的
  情况很常见（看附件叫什么名字再决定下不下），缓存省掉这部分等待。
  但**不设过期时间**：附件列表随老师操作变化，由用户手动刷新触发重拉。

  ⚠️ source_path 是平台内部存储路径，只用于服务端组装下载请求，
     绝不回传到前端（见 bksy.ts 的 BksyHomeworkAttachment 注释）。
*/
CREATE TABLE IF NOT EXISTS homework_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  up_id INTEGER NOT NULL,
  /* 详情正文（平台可能比列表更完整） */
  content TEXT NOT NULL DEFAULT '',
  /* 附件列表 JSON：[{id,fileName,sizeBytes,sourcePath}] */
  attachments TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, up_id)
);

/*
  独立账号凭据（CITEL / 物理在线 / 物理实验 / 演示实验）。

  这四个平台各自有**独立的账号密码**，与统一身份认证无关（上游 v1.8.5 发布说明：
  物理在线的 OAuth 按钮仍指向已下线的 CAS，物理实验/演示实验从来就是独立账号）。

  ⚠️ 密码列是**明文**：服务端被攻陷时加密密钥必然也在同一台机器上，静态加密只是
  安慰剂；真正的防护是「谁能调这个接口」，由 session + requireRealUser 决定。
  对外只暴露 hasPassword（见 independentAccounts.ts 的 toPublic），日志不打印。

  为什么不塞进 user_settings 的 JSON 列：账号是凭据不是偏好，那个列被几乎所有
  接口读，格式变更会波及全部页面。单表存放，删除级联到用户。

  platform 取值：citel | phyvlab | physicslab | phydemo（CHECK 约束见下）。
*/
CREATE TABLE IF NOT EXISTS independent_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('citel', 'phyvlab', 'physicslab', 'phydemo')),
  username TEXT NOT NULL,
  /* 明文密码；空串 = 只改了用户名、沿用旧密码 */
  password TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_independent_accounts_user ON independent_accounts(user_id);

/*
  本科教务成绩。

  ⚠️ 落库策略是「整批替换」而不是 UPSERT：教务的成绩列表是**全量快照**，
  一门课重修后旧记录会被新记录取代。用 UPSERT 会让历史记录越积越多、
  同一门课出现两条不同分数，用户不知道该信哪条。
  替换时按 (user_id, grade_key) 去重，grade_key 由「课程号|学年|学期」组成。
*/
CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 稳定业务键：课程号或课名 | 学年 | 学期 */
  grade_key TEXT NOT NULL,
  course_name TEXT NOT NULL,
  course_teacher TEXT NOT NULL DEFAULT '',
  /* 百分制分数；等级制/未出分时为 NULL（不猜分数） */
  course_score REAL,
  /* 原始成绩文本（"优秀"/"通过"/"95"），分数为 NULL 时前端展示它 */
  score_text TEXT NOT NULL DEFAULT '',
  course_credits REAL,
  course_year TEXT NOT NULL DEFAULT '',
  semester TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  /* required | limited | elective | pe | unknown */
  course_type TEXT NOT NULL DEFAULT 'unknown',
  course_code TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, grade_key)
);
CREATE INDEX IF NOT EXISTS idx_grades_user ON grades(user_id, course_year, semester);

/*
  数据快照（变动检测用）。

  每次同步某个数据域后，把归一化结果存一条；下次同步时与上一条 diff，
  产出「新增了什么 / 改了什么 / 删了什么」→ 写站内信。
  这是"用户同步一次，系统告诉他变了什么"的基础，参考仓库的
  DataChangeRecorder + detectDataChanges() 就是这个思路。

  payload 是**归一化后的 JSON**（不是原始 HTML/JSON）：只留会产生用户可感知
  变动的字段，否则学校页面改个无关时间戳就会误报"有变动"。
  hash 用于快速判断"这一域根本没变"，省掉逐项 diff。
*/
CREATE TABLE IF NOT EXISTS data_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /* 数据域：timetable / grades / exams / homework / classroom …（对应 AppEntry.id） */
  domain TEXT NOT NULL,
  /* 归一化后的 JSON 数组 */
  payload TEXT NOT NULL DEFAULT '[]',
  hash TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, domain)
);
`)

/* 存量数据库迁移：为旧表的 courses / tasks 补 user_id（可空，旧数据视为无主，登录后各自新建） */
{
  const ensureCol = (table: string, col: string, def: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
    }
  }
  ensureCol('tasks', 'sort_order', 'REAL NOT NULL DEFAULT 0')
  ensureCol('courses', 'user_id', 'INTEGER')
  ensureCol('tasks', 'user_id', 'INTEGER')
  ensureCol('users', 'feed_token', 'TEXT')
  ensureCol('users', 'nickname', 'TEXT')
  ensureCol('users', 'avatar', 'TEXT')
  ensureCol('users', 'theme', `TEXT NOT NULL DEFAULT 'dark'`)
  /* 帖子置顶（管理员可在详情页开关） */
  ensureCol('posts', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  /* 校园墙：「围观」「蹲蹲」两个独立指标；
     旧数据为 0 时由 listPosts 子查询补算，避免历史帖围观数从 0 起步显得"刚开张" */
  ensureCol('posts', 'view_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureCol('posts', 'bump_count', 'INTEGER NOT NULL DEFAULT 0')
  /* 学分（可空）：课表导入时尽量读取（本科教务 / 智慧课程平台），缺失可手动补填；周视图课程块上展示 */
  ensureCol('courses', 'credits', 'REAL')
  /* 精确上课周集合：JSON 周号数组（如 [1,3,5,7,9,11,13,15]）。
     NULL = 沿用 week_start/week_end/week_type 的「区间+单双周」旧口径。
     区间+奇偶表达不了逗号周列表（教务常见）与任意跳段，显式集合才是无损模型。 */
  ensureCol('courses', 'weeks', 'TEXT')
  /* 新用户引导：注册后首次登录弹一次功能说明，看完置 1（换设备/清缓存也不会重复打扰已有账号） */
  ensureCol('users', 'onboarded', 'INTEGER NOT NULL DEFAULT 0')
  /* 帖子图片：JSON 数组（最多 9 张，/uploads/ 相对路径），发帖时随帖写入 */
  ensureCol('posts', 'images', `TEXT NOT NULL DEFAULT '[]'`)
  /* 用户自选主题色：色相数值字符串（0-359），NULL = 默认青绿(166) */
  ensureCol('users', 'accent', 'TEXT')
  /* 课程归属的学期 id（对应 Settings.terms[].id）。
     NULL = 多学期改造前的存量课程，读取时按「属于当前学期」处理，
     并由 scripts/migrate-terms.mts 回填为当前学期 id。 */
  ensureCol('courses', 'term', 'TEXT')
  /* 单门课程信息扩展：成绩占比/考核说明（courses.links 已下线，不再读写，见建表处注释） */
  ensureCol('courses', 'grading_policy', "TEXT NOT NULL DEFAULT ''")
  /* 楼中楼回复：父评论 id，NULL=顶层。存量评论全为顶层，零迁移。
     （SQLite 允许 ALTER ADD COLUMN 带 REFERENCES，前提是默认值为 NULL —— 这里正好满足） */
  ensureCol('comments', 'parent_id', 'INTEGER REFERENCES comments(id) ON DELETE CASCADE')
  /* 真正被回复的人（与 parent_id 不等价，理由见 CREATE TABLE 注释）。
     存量回复该列为 NULL，查询时回退为"父评论作者"，结果与旧行为一致。 */
  ensureCol('comments', 'reply_to_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
  /* 最后活跃时间：管理员「用户活跃度」的数据源，由认证中间件节流写入（见 index.ts touchLastSeen）。
     NULL = 从未记录过（本功能上线前注册/登录过的老用户），前端按「从未活跃」展示。 */
  ensureCol('users', 'last_seen_at', 'TEXT')
  /* 一次性游客账号标记（未登录体验）。1 = 游客。
     ⚠️ 加这一列之后 countUsers() 必须排除游客 —— 它决定「首个注册用户 = 管理员」，
     不排除的话第一个访客会直接拿到管理员权限（权限提升）。详见 countUsers 的注释。 */
  ensureCol('users', 'is_guest', 'INTEGER NOT NULL DEFAULT 0')
  /* 情侣课表的三个纪念日（YYYY-MM-DD，可空）：
     存服务端而不是 localStorage —— 「下次见面」是**两个人共享的约定**，
     一方在手机上填了、另一方却看不到，这个功能就没有意义。群组形态不使用这三列。 */
  ensureCol('share_groups', 'anniversary', 'TEXT')
  ensureCol('share_groups', 'birthday', 'TEXT')
  ensureCol('share_groups', 'next_meet', 'TEXT')

  /**
   * 重建一张表以更新它的 CHECK 约束等无法 ALTER 的部分。
   *
   * 为什么需要它：SQLite 不支持 `ALTER TABLE ... DROP/ADD CONSTRAINT`，
   * 而 `CREATE TABLE IF NOT EXISTS` 对**已存在**的表是空操作 ——
   * 意味着改上面的建表语句只对全新库生效，线上老库永远拿不到新约束。
   * 唯一办法是「建新表 → 搬数据 → 换名」。
   *
   * 判定方式用 `sqlite_master.sql` 里是否含目标标记，而不是版本号：
   * 版本号要额外维护一张元数据表，而"建表语句里有没有这个词"本身就是幂等的事实。
   * 迁移整体走事务，中途失败即回滚，不会留下半张表。
   */
  const ensureTableRebuild = (table: string, marker: string, createTmp: string, cols: string) => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
      | { sql: string | null }
      | undefined
    if (!row || (row.sql ?? '').includes(marker)) return
    db.exec('BEGIN')
    try {
      db.exec(createTmp)
      db.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}`)
      db.exec(`DROP TABLE ${table}`)
      db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 已自动回滚，别盖住原始错误 */
      }
      throw e
    }
  }

  /* messages.type 增加 couple_plan（情侣共同计划动态）。存量库的 CHECK 只认
     feedback_reply/system，不重建的话插入新类型会直接违反约束、计划通知全丢。 */
  ensureTableRebuild(
    'messages',
    'couple_plan',
    `CREATE TABLE messages__new (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('feedback_reply','system','couple_plan')),
       title TEXT NOT NULL,
       body TEXT NOT NULL DEFAULT '',
       feedback_id INTEGER REFERENCES feedbacks(id) ON DELETE CASCADE,
       read INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    'id, user_id, type, title, body, feedback_id, read, created_at'
  )

  /* messages.type 再增加 data_change（校园数据变动提醒）。
     ⚠️ 这里必须单独再来一次、marker 用 'data_change'：
     上面那次用 'couple_plan' 做标记，对**已经跑过情侣计划迁移**的线上库
     而言 `row.sql.includes('couple_plan') === true` → 函数直接 return，
     新类型根本进不去 CHECK，插站内信时违反约束、变动提醒静默全丢。 */
  ensureTableRebuild(
    'messages',
    'data_change',
    `CREATE TABLE messages__new (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       type TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('feedback_reply','system','couple_plan','data_change')),
       title TEXT NOT NULL,
       body TEXT NOT NULL DEFAULT '',
       feedback_id INTEGER REFERENCES feedbacks(id) ON DELETE CASCADE,
       read INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    'id, user_id, type, title, body, feedback_id, read, created_at'
  )
}

/* 存量数据回填：老账号没有昵称/主题时，用账号名与深色主题兜底 */
db.exec(`UPDATE users SET nickname = username WHERE nickname IS NULL OR TRIM(nickname) = ''`)
db.exec(`UPDATE users SET theme = 'dark' WHERE theme IS NULL OR theme NOT IN ('light','dark','system')`)

/* ---------------- 索引 ----------------

   SQLite 只为 PRIMARY KEY / UNIQUE 自动建索引，外键列本身不会自动获得索引，
   而本项目几乎所有业务查询都是 `WHERE user_id = ?`（课程/任务/考试/实验/通知），
   论坛侧还有大量 `WHERE post_id = ?`（评论）。缺索引时每次查询都是全表扫描，
   随用户与数据量增长延迟线性上升。
   统一用 CREATE INDEX IF NOT EXISTS，幂等且重启自动生效，无需单独迁移脚本。
   注意：post_likes / post_bumps / post_views 的主键是 (post_id, user_id)，
   post_id 已是主键最左前缀，因此这三张表无需再单独建 post_id 索引。
   验证：EXPLAIN QUERY PLAN SELECT * FROM courses WHERE user_id = 1
        应输出 SEARCH courses USING INDEX idx_courses_uid（而非 SCAN courses）。 */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_courses_uid       ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_uid         ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_uid_due     ON tasks(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_exams_uid         ON exams(user_id);
-- 已下架功能的遗留索引，随 lab_courses 一并保留（见上方该表注释）
CREATE INDEX IF NOT EXISTS idx_lab_uid_date      ON lab_courses(user_id, date);
-- 论坛已下架：以下三个索引同样随表保留（理由见 topics 表上方的下架说明）
CREATE INDEX IF NOT EXISTS idx_posts_uid         ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created     ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_pid      ON comments(post_id);
/* 楼中楼：按父评论取子回复（渲染时逐层取，也用于删除时的级联清理） */
CREATE INDEX IF NOT EXISTS idx_comments_parent   ON comments(parent_id);
-- 反馈：用户查自己的工单（列表按时间倒序）；管理端按状态/类型筛选并倒序翻页
CREATE INDEX IF NOT EXISTS idx_feedback_uid      ON feedbacks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status   ON feedbacks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_type     ON feedbacks(type);
CREATE INDEX IF NOT EXISTS idx_fbreply_fid       ON feedback_replies(feedback_id, created_at);
-- 站内信：收件箱按时间倒序取；未读红点走 (user_id, read) 覆盖索引
CREATE INDEX IF NOT EXISTS idx_messages_uid      ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread   ON messages(user_id, read);
/* 管理员活跃度：按最后活跃时间排序/筛选 */
CREATE INDEX IF NOT EXISTS idx_users_last_seen   ON users(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_notif_uid_created ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_uid_read    ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_sessions_uid      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_captchas_expires  ON captchas(expires_at);
-- 共享课表：按成员查「我加入的群组」（列表页）、按群查成员（详情页）、按密钥加入
CREATE INDEX IF NOT EXISTS idx_share_mem_uid     ON share_members(user_id);
CREATE INDEX IF NOT EXISTS idx_share_mem_gid     ON share_members(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_secret ON share_groups(secret);
-- 共同计划：按群查列表（详情页，按日期排序）；
-- 另建一条覆盖「未提醒 + 未取消」的部分索引给定时扫描用 —— 计划表会长期增长，
-- 而扫描只关心一小撮未来的待提醒行，部分索引能让它保持常量级扫描量。
CREATE INDEX IF NOT EXISTS idx_share_plans_gid   ON share_plans(group_id, plan_date);
CREATE INDEX IF NOT EXISTS idx_share_plans_due   ON share_plans(plan_date, status, reminder_sent_at);

/* 以下四条是补漏（2026-10-17 评审发现）：
   - feed_token：ICS 订阅是**外部日历客户端**发起的请求，iOS/安卓通常 15~60 分钟轮询一次，
     而此前该列没有索引 → 每次订阅轮询都是 users 全表扫描。UNIQUE 同时也是一道数据完整性约束。
   - password_resets：后台每次刷新都要查 pending 列表与计数，没有索引就是全表扫。
   - courses(user_id, term)：多学期上线后列表查询带 term 谓词，
     原有的 idx_courses_uid 只能用到 user_id 前缀，term 退化为过滤。
   - client_errors：后台按时间倒序看最近错误。 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feed_token  ON users(feed_token);
CREATE INDEX IF NOT EXISTS idx_pwd_reset_status         ON password_resets(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pwd_reset_user           ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_courses_uid_term         ON courses(user_id, term);
CREATE INDEX IF NOT EXISTS idx_client_errors_created    ON client_errors(created_at);
`)

/* ---------------- 事务 ---------------- */

/**
 * 把一段写操作包进事务（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）。
 *
 * 为什么需要：`node:sqlite` 没有内置的 transaction 助手，项目里此前是手写
 * `db.exec('BEGIN')...COMMIT`（9 处）。手写的最大问题是"容易漏掉 ROLLBACK"，
 * 而漏掉之后这个连接会一直停在事务里，后续所有写操作都被卷进同一个隐式事务，
 * 直到进程重启 —— 这是最难查的一类故障。统一走这个函数，异常时必定回滚。
 *
 * ⚠️ 不支持嵌套：SQLite 没有真正的嵌套事务。调用前请确认自己不在另一个 tx() 里。
 */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败（例如事务已被 SQLite 自动回滚）不应盖住原始错误 */
    }
    throw err
  }
}

/* ---------------- 用户 / 会话 ---------------- */

/**
 * 密码散列使用 **异步** scrypt，而不是 scryptSync。
 *
 * 为什么这点很重要：scrypt 本身刻意设计得慢（几十~上百毫秒），这是抗暴力破解的基础。
 * 但 `scryptSync` 会在**主线程**上跑完这段计算，Node 是单线程事件循环——
 * 只要有人并发请求登录接口，事件循环就被反复占满，
 * 全站所有请求（静态资源、课表查询、验证码）一起排队，等于一个公开接口就能拖垮整站。
 *
 * 异步版 `scrypt` 走 libuv 线程池（默认 4 线程）执行，主线程继续处理其它请求；
 * 线程池天然把并发散列数限制在 4 个，配合路由层限流即可消除这个放大面。
 * 散列格式与同步版完全一致（`salt:hash`），**存量密码无需迁移**。
 */
const scryptAsync = (password: string, salt: string, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)))
  })

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scryptAsync(password, salt, 32)).toString('hex')
  return `${salt}:${hash}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = await scryptAsync(password, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

const USER_COLS = `id, username, nickname, role, avatar, theme, onboarded, accent, is_guest AS isGuest`

/**
 * 建号。nickname 为空时回退为账号名（兼容管理员后台建号等不带昵称的场景）
 * 因密码散列改为异步，本函数也是 async（调用处需 await）。
 */
export async function createUser(
  username: string,
  password: string,
  role: 'user' | 'admin',
  nickname?: string
): Promise<User> {
  const nick = (nickname ?? '').trim() || username
  const hash = await hashPassword(password)
  const info = db
    .prepare(`INSERT INTO users (username, password_hash, role, nickname) VALUES (?, ?, ?, ?)`)
    .run(username, hash, role, nick)
  const id = Number(info.lastInsertRowid)
  return { id, username, nickname: nick, role, avatar: null, theme: 'dark', onboarded: 0, accent: null, isGuest: false }
}

/** 游客账号名前缀。冒号是刻意选的：真实账号（邮箱/学号）不会含冒号，
    即便有人把用户名过滤关了也不会与真实账号名撞上。 */
const GUEST_USERNAME_PREFIX = 'guest:'

/**
 * 创建一个**一次性游客账号**（未登录体验用）。
 *
 * 几个刻意的设计：
 *  - `password_hash` 存**空串**而不是随机密码：空串过不了 `verifyPassword` 的
 *    `split(':')` 检查，等于"这个账号在设计上就没有密码"，比存一个随机散列更诚实
 *    （随机散列会被误认为"可以登录但密码忘了"）。再叠一道 getUserByUsername 排除游客。
 *  - `role` 恒为 `'user'`：游客永远拿不到管理员权限，与 countUsers 的排除互为双保险。
 *  - `last_seen_at` 立刻写入：TTL 清理依赖它判断"多久没来过"，不写的话游客一创建
 *    就会被当成"从未活跃"而立刻回收。
 */
export function createGuestUser(): User {
  const username = GUEST_USERNAME_PREFIX + randomBytes(16).toString('hex')
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, nickname, is_guest, last_seen_at)
       VALUES (?, '', 'user', ?, 1, datetime('now'))`
    )
    .run(username, '游客')
  const id = Number(info.lastInsertRowid)
  return {
    id, username, nickname: '游客', role: 'user',
    avatar: null, theme: 'dark', onboarded: 0, accent: null, isGuest: true
  }
}

/** 该 token 是否属于一个**有效且未过期**的游客会话；是则返回游客 id，否则 null。 */
export function getGuestIdByToken(token: string): number | null {
  if (!token) return null
  const key = resolveSessionKey(token)
  const row = db
    .prepare(
      `SELECT u.id AS id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.is_guest = 1`
    )
    .get(key, new Date().toISOString()) as { id: number } | undefined
  return row ? row.id : null
}

/**
 * 覆盖某个账号的本地密码（管理员重置 / 学号账号的密码轮换）。
 *
 * 单独抽出来是为了让"改密码"只有一个写入点：散列必须走 hashPassword（scrypt 异步），
 * 散落各处写 `UPDATE users SET password_hash = ?` 迟早会有人忘记 await 或写成明文。
 * 明文不落库，调用方也不该把它留在任何日志里。
 */
export async function setUserPassword(userId: number, password: string): Promise<void> {
  setUserPasswordHash(userId, await hashPassword(password))
}

/**
 * 已有散列的落库点。给需要把「算散列」挪出事务的调用方用（如 provisionStudentAccount：
 * hashPassword 是异步的几十毫秒，不能包进同步的 tx()，否则事务里夹着 await）。
 * 正常路径仍走 setUserPassword，「改密码只有一个写入点」的原则不变。
 */
export function setUserPasswordHash(userId: number, hash: string): void {
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, userId)
}

/** 标记新用户引导已看过（幂等，重复调用无副作用） */
export function markOnboarded(userId: number): void {
  db.prepare(`UPDATE users SET onboarded = 1 WHERE id = ?`).run(userId)
}

/* ---------------- 密码重置申请 ----------------
 *
 * 为什么需要它：本校学生账号（学号）是走教务登录自动建的，**本地密码是一串没人知道的随机数**
 * （见 index.ts 的 provisionStudentAccount）。他们一旦丢了会话就彻底无法自助登录。
 * 而线上又是纯 HTTP：WebCrypto 在非安全上下文里不可用，浏览器**无法**加密教务密码，
 * 把「学号登录」放到网页端等于让教务密码在公网明文传输 —— 安全审计明确不建议。
 * 所以走「用户自己设新密码 → 管理员核实身份后批准」这条路：
 *   · 全程没有任何密码经过管理员，管理员只做"确认你是本人"这一件事；
 *   · 不依赖邮件服务（线上 SMTP 未配置，邮件重置根本发不出去）。
 *
 * 安全设计要点：
 *   1. 待生效的密码**只存散列**（复用 password_hash 同一套 scrypt），明文不落库、不进日志；
 *   2. 同一账号只保留一条待处理申请，重复提交直接覆盖（避免堆积与被反复利用）；
 *   3. 申请接口对"账号不存在"也返回成功，避免账号枚举；
 *   4. 批准动作幂等：已处理过的申请不能二次生效（防重放）。
 */

export interface PasswordResetRequest {
  id: number
  userId: number
  username: string
  nickname: string
  contact: string
  note: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  handledAt: string | null
}

/**
 * 建/覆盖一条重置申请。
 *
 * @param pendingHash 用户自选新密码的散列（调用方先用 hashPassword 算好）
 */
export function createPasswordReset(
  userId: number,
  pendingHash: string,
  contact: string,
  note: string
): void {
  /* 同一账号只留一条：把旧的待处理记录删掉再插，避免用户手抖点多次堆出一长串申请，
     也避免"很久以前那条"被人翻出来批准。 */
  db.prepare(`DELETE FROM password_resets WHERE user_id = ? AND status = 'pending'`).run(userId)
  db.prepare(
    `INSERT INTO password_resets (user_id, pending_hash, contact, note) VALUES (?, ?, ?, ?)`
  ).run(userId, pendingHash, contact, note)
}

/** 管理员视角：待处理的申请（按提交时间升序，先来先处理） */
export function listPendingPasswordResets(): PasswordResetRequest[] {
  return db
    .prepare(
      `SELECT r.id, r.user_id AS userId, u.username, u.nickname, r.contact, r.note,
              r.status, r.created_at AS createdAt, r.handled_at AS handledAt
       FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.status = 'pending' ORDER BY r.created_at ASC`
    )
    .all() as unknown as PasswordResetRequest[]
}

export function getPasswordReset(id: number): (PasswordResetRequest & { pendingHash: string }) | null {
  const row = db
    .prepare(
      `SELECT r.id, r.user_id AS userId, r.pending_hash AS pendingHash, u.username, u.nickname,
              r.contact, r.note, r.status, r.created_at AS createdAt, r.handled_at AS handledAt
       FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
    )
    .get(id) as (PasswordResetRequest & { pendingHash: string }) | undefined
  return row ?? null
}

/**
 * 批准一条申请：把待生效的散列**搬**为正式密码，并把申请标记为已处理。
 *
 * 整个动作放在一个事务里，且以 `status = 'pending'` 作为更新条件 ——
 * 这样并发的两次批准只有一次能生效，天然幂等，杜绝重复生效。
 *
 * @returns 是否真的生效（false = 申请已被处理过 / 不存在）
 */
export function approvePasswordReset(id: number, adminId: number): boolean {
  const req = getPasswordReset(id)
  if (!req || req.status !== 'pending') return false
  /* 用事务内的 UPDATE ... WHERE status = 'pending' 作互斥：两个管理员同时点批准，
     只有一方 changes=1。这里手写事务（而非 tx()）是因为有"提前 return false"的分支 ——
     提前返回必须先把事务回滚掉，tx() 的回调返回值语义表达不了这个。 */
  db.exec('BEGIN IMMEDIATE')
  try {
    const upd = db
      .prepare(
        `UPDATE password_resets SET status = 'approved', handled_at = datetime('now'), handled_by = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(adminId, id)
    if (Number(upd.changes ?? 0) === 0) {
      db.exec('ROLLBACK')
      return false
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(req.pendingHash, req.userId)
    /* 改完密码把该用户的会话全部作废：万一有别人正持着他的旧会话，必须一起踢掉 */
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(req.userId)
    db.exec('COMMIT')
    return true
  } catch (err) {
    /* ROLLBACK 自己失败不能盖住原始错误（否则日志里只剩"no transaction is active"） */
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已自动回滚 */
    }
    throw err
  }
}

/** 驳回一条申请（同理以 pending 为条件，保证只生效一次） */
export function rejectPasswordReset(id: number, adminId: number): boolean {
  const info = db
    .prepare(
      `UPDATE password_resets SET status = 'rejected', handled_at = datetime('now'), handled_by = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(adminId, id)
  return Number(info.changes ?? 0) > 0
}

/** 某账号当前是否有待处理的申请（用于给用户提示"已提交，等待处理"） */
export function hasPendingPasswordReset(userId: number): boolean {
  return (
    db.prepare(`SELECT 1 AS x FROM password_resets WHERE user_id = ? AND status = 'pending'`).get(userId) !==
    undefined
  )
}

/** 待处理申请总数（管理员后台角标） */
export function countPendingPasswordResets(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM password_resets WHERE status = 'pending'`).get() as {
    c: number
  }
  return Number(row.c)
}


/**
 * 按账号名取用户（**排除游客**）。
 *
 * 排除游客的理由：游客账号 `password_hash` 是空串、本就不该能登录，但"靠空串过不了
 * verifyPassword"是一层隐式依赖 —— 将来谁把 verifyPassword 改成"空密码直接放行"
 * 就会静默变成一条登录旁路。这里显式排除，让"游客不可登录"成为结构上的事实。
 */
export function getUserByUsername(username: string): (User & { passwordHash: string }) | null {
  const row = db
    .prepare(`SELECT ${USER_COLS}, password_hash AS passwordHash FROM users WHERE username = ? AND is_guest = 0`)
    .get(username) as (User & { passwordHash: string }) | undefined
  return row ?? null
}

/**
 * 账号名是否已被占用 —— **包含游客**。
 *
 * 与 getUserByUsername 的区别就是这一条：注册/后台建号必须用「包含游客」的判据去查重，
 * 否则有人恰好注册到某个游客的随机账号名时，getUserByUsername 返回 null（放行），
 * 随后 INSERT 撞上 `username UNIQUE` 约束 → 500。
 * 概率极低（32 位随机 hex），但"低概率的 500"正是最不该留下的那类 bug。
 */
export function usernameTaken(username: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM users WHERE username = ?`).get(username) !== undefined
}

export function findUser(id: number): User | null {
  const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as User | undefined
  return row ?? null
}

/** 取用户展示名（昵称优先，空则回退账号） */
export function getDisplayName(id: number): string {
  const row = db
    .prepare(`SELECT COALESCE(NULLIF(TRIM(nickname), ''), username) AS name FROM users WHERE id = ?`)
    .get(id) as { name: string } | undefined
  return row?.name ?? '用户'
}

/** 更新昵称 / 头像 / 主题，只更新传入的字段 */
export function updateProfile(
  userId: number,
  patch: { nickname?: string; avatar?: string | null; theme?: ThemeMode; accent?: string | null }
): User {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.nickname !== undefined) {
    sets.push('nickname = ?')
    params.push(patch.nickname)
  }
  if (patch.avatar !== undefined) {
    sets.push('avatar = ?')
    params.push(patch.avatar)
  }
  if (patch.theme !== undefined) {
    sets.push('theme = ?')
    params.push(patch.theme)
  }
  if (patch.accent !== undefined) {
    sets.push('accent = ?')
    params.push(patch.accent)
  }
  if (sets.length === 0) return findUser(userId)!
  params.push(userId)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return findUser(userId)!
}

/**
 * 真实用户总数（**不含游客**）。
 *
 * ⚠️ 这个数字被注册逻辑用来判定「首个用户 = 管理员」（`countUsers() === 0`）。
 * 一旦把游客算进来，**第一个打开页面的访客就会直接成为管理员** —— 一条权限提升漏洞。
 * 因此这里的 `is_guest = 0` 不是优化，是安全边界，改动前请先读这条注释。
 * 管理员看板的用户数 / 用户列表同理必须排除游客，否则后台会被游客账号刷屏。
 */
export function countUsers(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_guest = 0`).get() as { c: number }).c
}

/** 游客账号总数（仅用于管理员看板展示"当前有多少一次性账号"，不影响任何权限判定） */
export function countGuests(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_guest = 1`).get() as { c: number }).c
}

/**
 * 记录「最后活跃时间」（管理员活跃度看板的数据源）。列由 ensureCol 补，见文件上部。
 *
 * 为什么必须节流：认证中间件每个请求都会经过，若每次都 UPDATE users，
 * 一个刷课表的用户每分钟能打出几十次写事务，WAL 下纯属浪费（还和备份抢锁）。
 * 这里用「进程内 Map + 60s 窗口」节流：
 *   - 同一用户 60s 内最多写一次；而活跃度判定粒度是「天」，精度绰绰有余；
 *   - Map 条目上界 = 用户数（百级），无需淘汰策略；
 *   - 多实例部署时各实例各记各的，落到列上的仍是"最近一次访问时间"，无正确性问题。
 *
 * force=true 用于登录/注册这类必须立刻留痕的时刻（否则刚注册的用户会显示"从未活跃"）。
 */
const LAST_SEEN_THROTTLE_MS = 60_000
const lastSeenWriteAt = new Map<number, number>()

export function touchLastSeen(userId: number, force = false): void {
  const now = Date.now()
  if (!force) {
    const prev = lastSeenWriteAt.get(userId)
    if (prev !== undefined && now - prev < LAST_SEEN_THROTTLE_MS) return
  }
  lastSeenWriteAt.set(userId, now)
  db.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).run(userId)
}

/**
 * 单个账号最多保留的**活跃会话数**（手机 + 电脑 + 平板 + App 外壳 + 备用，5 个足够）。
 * 超出部分按创建时间从旧到新淘汰——旧设备会掉登录，但换来的好处是：
 * sessions 表不会因为反复登录无限增长，且每个残留 token 都是一个有效凭证（攻击面）。
 */
const MAX_ACTIVE_SESSIONS = 5

/* ---------------- 会话 token 的存储形态 ----------------

   为什么库里存的是**哈希**而不是 token 本身：
   token 是一张 30 天有效的通行证，谁拿到它就能直接冒用账号（不需要密码）。
   而数据库文件与备份并不是"只有服务器能看到"的：本项目就有 4 份 .db 躺在 data 目录里，
   任何一次误打包/误上传/备份泄露，都会让里面的明文 token 立刻可用。
   存 sha256 之后，泄露的只是"无法反推的指纹"，攻击者还得再攻破一次才有用。

   为什么用 sha256 而不是 scrypt：token 本身是 32 字节 CSPRNG 随机串，没有"弱口令"可爆破，
   不需要慢哈希；而会话校验是**每个请求**都要跑的热路径，用 scrypt 会把全站拖死。

   向后兼容：上线前的会话是明文入库的。查询时先按哈希找，找不到再按原文找一次；
   一旦按原文命中，就**原地升级**成哈希（旧 token 因此可以继续用到自然过期，不会踢人下线）。
   这条兼容分支只在存量会话上走一次，之后所有查询都是单次命中。 */
function hashSessionToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token).digest('hex')
}

/** 把客户端给的 token 解析成"库里实际存的键"，顺带把存量明文会话升级成哈希 */
function resolveSessionKey(token: string): string {
  const hashed = hashSessionToken(token)
  if (db.prepare(`SELECT 1 AS ok FROM sessions WHERE token = ?`).get(hashed)) return hashed
  if (db.prepare(`SELECT 1 AS ok FROM sessions WHERE token = ?`).get(token)) {
    try {
      db.prepare(`UPDATE sessions SET token = ? WHERE token = ?`).run(hashed, token)
    } catch {
      /* 升级失败不影响本次请求（本次仍能按原文查到）；下次再试 */
      return token
    }
    return hashed
  }
  return hashed
}

/** 会话有效期 30 天；剩余不足 7 天时自动续期（见 getSessionUser） */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const SESSION_RENEW_BELOW_MS = 7 * 24 * 3600 * 1000

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(
    hashSessionToken(token),
    userId,
    expiresAt
  )
  pruneSessionsForUser(userId)
  return token
}

/** 清掉该用户的过期会话，并把活跃会话收敛到最近 MAX_ACTIVE_SESSIONS 个 */
function pruneSessionsForUser(userId: number): void {
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at < ?`).run(userId, new Date().toISOString())
  db.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token NOT IN (
       SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
     )`
  ).run(userId, userId, MAX_ACTIVE_SESSIONS)
}

/**
 * 全局清理过期数据（sessions / captchas / 前端错误上报）。
 * 由 index.ts 在启动后挂一个定时器周期调用——这两张表都是「只在写入时顺手清一次」，
 * 长时间运行下会积累无用的过期行。
 */
export function purgeExpired(): { sessions: number; captchas: number; clientErrors: number } {
  const now = new Date().toISOString()
  const s = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now)
  const c = db.prepare(`DELETE FROM captchas WHERE expires_at < ?`).run(now)
  /* 前端错误只留 30 天：它是排障材料，不是业务数据。
     不清理的话，一个反复崩溃的页面（比如某个机型上的循环报错）能在一夜之间写满几十万行。 */
  const e = db.prepare(`DELETE FROM client_errors WHERE created_at < datetime('now', '-30 days')`).run()
  return {
    sessions: Number(s.changes ?? 0),
    captchas: Number(c.changes ?? 0),
    clientErrors: Number(e.changes ?? 0)
  }
}

/* ---------------- 前端错误上报 ---------------- */

export interface ClientErrorInput {
  /** 未登录时为 null（例如登录页就崩了） */
  userId: number | null
  message: string
  stack: string
  url: string
  ua: string
}

/** 记一条前端运行时错误。字段长度在调用方就已截断（见 index.ts 的 /api/client-errors）。 */
export function recordClientError(input: ClientErrorInput): void {
  db.prepare(
    `INSERT INTO client_errors (user_id, message, stack, url, ua) VALUES (?, ?, ?, ?, ?)`
  ).run(input.userId, input.message, input.stack, input.url, input.ua)
}

export interface ClientErrorRow {
  id: number
  userId: number | null
  username: string | null
  message: string
  stack: string
  url: string
  ua: string
  createdAt: string
}

/** 管理端：最近的前端错误（按时间倒序）。 */
export function listClientErrors(limit = 100): ClientErrorRow[] {
  return db
    .prepare(
      `SELECT e.id, e.user_id AS userId, u.username, e.message, e.stack, e.url, e.ua,
              e.created_at AS createdAt
       FROM client_errors e LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(limit) as unknown as ClientErrorRow[]
}

/* ==================== 一次性游客账号：统计 / 迁移 / 回收 ==================== */

/** 游客名下的数据量（用于登录后询问「合并 / 覆盖 / 不用了」时给用户看） */
export interface GuestDataCounts {
  courses: number
  tasks: number
  exams: number
  feedbacks: number
  messages: number
  /** 是否改过设置（学期 / 节次）。false = 仍是出厂默认，迁移时可忽略 */
  hasSettings: boolean
}

export type ClaimMode = 'merge' | 'replace' | 'discard'

export interface ClaimResult {
  mode: ClaimMode
  courses: number
  tasks: number
  exams: number
  feedbacks: number
  messages: number
}

const countOf = (sql: string, userId: number): number =>
  (db.prepare(sql).get(userId) as { c: number }).c

/** 数一数这个账号名下有多少业务数据 */
export function countUserData(userId: number): GuestDataCounts {
  return {
    courses: countOf(`SELECT COUNT(*) AS c FROM courses WHERE user_id = ?`, userId),
    tasks: countOf(`SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?`, userId),
    exams: countOf(`SELECT COUNT(*) AS c FROM exams WHERE user_id = ?`, userId),
    feedbacks: countOf(`SELECT COUNT(*) AS c FROM feedbacks WHERE user_id = ?`, userId),
    messages: countOf(`SELECT COUNT(*) AS c FROM messages WHERE user_id = ?`, userId),
    hasSettings: db.prepare(`SELECT 1 AS x FROM user_settings WHERE user_id = ?`).get(userId) !== undefined
  }
}

/** 是否有"值得迁移"的业务数据（设置不算：游客没改过设置就等于没有） */
export function hasGuestData(c: GuestDataCounts): boolean {
  return c.courses > 0 || c.tasks > 0 || c.exams > 0 || c.feedbacks > 0
}

/** 迁移过程中读出来的原始行。用 SQLInputValue 而不是 unknown，
    这样行里的值可以直接回填进 INSERT 语句的参数位（否则每个字段都要显式断言）。 */
type Row = Record<string, SQLInputValue>

/** 读原始 settings JSON（不经过归一化），没有记录则返回 null */
function rawSettings(userId: number): Settings | null {
  const row = db.prepare(`SELECT data FROM user_settings WHERE user_id = ?`).get(userId) as
    | { data: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.data) as Settings
  } catch {
    /* 脏数据（手工改库）不应该让迁移整体失败，退回"没有设置" */
    return null
  }
}

/**
 * 把游客的学期表并进目标账号，并给出 `游客 term id → 目标 term id` 的映射。
 *
 * 为什么必须有这层映射：`courses.term` 存的是 `Settings.terms[].id`（字符串），
 * 而游客与目标账号是两套独立的 term id 空间。不做映射直接复制课程，
 * 课程就会指向目标账号里不存在的学期 —— 表现为「课程导入成功但一门都看不到」。
 *
 * 匹配口径用 **name**：term id 是客户端生成的（如 `2026-fall`），两个账号各自建的
 * 同名学期完全可能 id 不同；而"学期名"才是用户认知里的同一个学期。
 */
function mergeTerms(
  guest: Settings,
  target: Settings
): { terms: Term[]; currentTermId: string; termMap: Map<string, string> } {
  const terms = [...(target.terms ?? [])]
  const termMap = new Map<string, string>()
  const byName = new Map(terms.map((t) => [t.name, t.id]))
  const usedIds = new Set(terms.map((t) => t.id))

  for (const gt of guest.terms ?? []) {
    const hit = byName.get(gt.name)
    if (hit) {
      termMap.set(gt.id, hit)
      continue
    }
    let id = gt.id
    if (usedIds.has(id)) {
      /* id 撞车：客户端生成的 id 常是 `2026-fall` 这种可预测串，两个账号撞上是正常的。
         换一个随机 id，并让映射指向它。 */
      id = `t-${randomBytes(6).toString('hex')}`
    }
    usedIds.add(id)
    byName.set(gt.name, id)
    terms.push({ ...gt, id })
    termMap.set(gt.id, id)
  }

  /* currentTermId 保留目标账号的：刚登录的这个账号才是用户认知里的"主账号"，
     用游客的当前学期去覆盖它会让用户以为自己切错了学期。
     仅当目标账号压根没有学期时，才接管游客的。 */
  const targetCurrent = target.currentTermId && terms.some((t) => t.id === target.currentTermId)
    ? target.currentTermId
    : ''
  const guestMapped = guest.currentTermId ? termMap.get(guest.currentTermId) : undefined
  const currentTermId = targetCurrent || guestMapped || terms[0]?.id || ''
  return { terms, currentTermId, termMap }
}

/**
 * 把游客账号名下的数据迁移到真实账号，并在成功后**删除游客账号**。
 *
 * 三种策略：
 *  - `merge`（默认）：课程按自然键去重、任务按 (标题, 日期) 去重、考试靠 UNIQUE 去重；
 *    目标账号的设置优先，只补它没有的学期。**目标账号为空时等价于整体接管。**
 *  - `replace`：清空目标账号的课程/任务/考试，整体接管游客的（连同学期设置）。
 *    适用于「我在未登录状态下认真排好了课表，登录只是为了同步」。
 *  - `discard`：只登录，丢弃游客数据（适用于「我登录回来拿回老账号的数据」）。
 *
 * 全过程在**单个事务**里：任一步抛错整体回滚，绝不会出现"删了游客的、又没写进目标"的丢数据。
 *
 * ⚠️ 最容易写错的两处（都有专门的映射表兜着）：
 *   - `tasks.course_id` 与 `exams.task_id` 是外键，必须按「旧 id → 新 id」改写，
 *     否则 DDL 会挂到错误的课上、考试会指向错误的 DDL；
 *   - `courses.term` 是学期 id，必须经 mergeTerms 映射。
 */
export function claimGuestData(guestId: number, targetId: number, mode: ClaimMode): ClaimResult {
  if (guestId === targetId) throw new Error('不能把游客数据迁移给自己')

  const guestSettings = rawSettings(guestId)
  const targetSettings = rawSettings(targetId)

  const result: ClaimResult = { mode, courses: 0, tasks: 0, exams: 0, feedbacks: 0, messages: 0 }

  db.exec('BEGIN')
  try {
    if (mode !== 'discard') {
      /* ---------------- 学期映射（必须在插入课程之前算出来） ---------------- */
      const gs = normalizeSettings(guestSettings ?? (defaultSettings() as Settings))
      const ts = normalizeSettings(targetSettings ?? (defaultSettings() as Settings))
      const termMap = new Map<string, string>()
      /* mergeTerms 只调一次（2026-10-23 修）：它会给撞名的学期生成随机新 id，
         调两次会得到两份不同的 id —— 课程插的是第一份，settings 写的是第二份，
         课程指向 settings 里不存在的学期 →「迁移成功但这批课任何学期都看不到」。
         下面学期设置复用同一个结果。 */
      let merged: ReturnType<typeof mergeTerms> | null = null
      if (mode === 'merge' && targetSettings) {
        merged = mergeTerms(gs, ts)
        merged.termMap.forEach((v, k) => termMap.set(k, v))
      }

      /* ---------------- 课程 ---------------- */
      /** 目标账号已有的课程自然键 → id（merge 去重用；replace 时清空后为空） */
      const courseKey = (r: Row): string =>
        `${r.name}|${r.day_of_week}|${r.start_period}|${r.end_period}|${r.weeks ?? ''}`

      let targetCourses: Row[]
      if (mode === 'replace') {
        db.prepare(`DELETE FROM courses WHERE user_id = ?`).run(targetId)
        targetCourses = []
      } else {
        targetCourses = db
          .prepare(
            `SELECT id, name, day_of_week, start_period, end_period, weeks FROM courses WHERE user_id = ?`
          )
          .all(targetId) as Row[]
      }
      const existingCourse = new Map<string, number>()
      for (const r of targetCourses) {
        existingCourse.set(courseKey(r), Number(r.id))
      }

      const guestCourses = db
        .prepare(
          `SELECT id, name, teacher, location, day_of_week, week_start, week_end, week_type,
                  start_period, end_period, color, credits, weeks, term,
                  COALESCE(grading_policy, '') AS grading_policy,
                  created_at
           FROM courses WHERE user_id = ? ORDER BY id`
        )
        .all(guestId) as Row[]

      const insCourse = db.prepare(
        `INSERT INTO courses
           (user_id, name, teacher, location, day_of_week, week_start, week_end, week_type,
            start_period, end_period, color, credits, weeks, term, grading_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      /** 旧课程 id → 新课程 id（任务的外键要按它改写） */
      const courseMap = new Map<number, number>()
      for (const c of guestCourses) {
        const key = courseKey(c)
        const dup = existingCourse.get(key)
        if (dup !== undefined) {
          // 目标账号已有同一门课：任务改挂到它上面，不重复插入
          courseMap.set(Number(c.id), dup)
          continue
        }
        // 学期 id 映射；游客的 term 为 null 时保持 null（读时按"属于当前学期"处理）
        const term = c.term === null || c.term === undefined ? null : termMap.get(String(c.term)) ?? String(c.term)
        const info = insCourse.run(
          targetId, c.name, c.teacher, c.location, c.day_of_week, c.week_start, c.week_end, c.week_type,
          c.start_period, c.end_period, c.color, c.credits ?? null, c.weeks ?? null, term,
          c.grading_policy ?? '',
          c.created_at ?? new Date().toISOString()
        )
        const newId = Number(info.lastInsertRowid)
        courseMap.set(Number(c.id), newId)
        existingCourse.set(key, newId)
        result.courses += 1
      }

      /* ---------------- 任务 ---------------- */
      let targetTasks: Row[]
      if (mode === 'replace') {
        db.prepare(`DELETE FROM tasks WHERE user_id = ?`).run(targetId)
        targetTasks = []
      } else {
        targetTasks = db.prepare(`SELECT title, due_date FROM tasks WHERE user_id = ?`).all(targetId) as Row[]
      }
      const existingTask = new Set(targetTasks.map((t) => `${t.title}|${t.due_date}`))

      const guestTasks = db
        .prepare(
          `SELECT id, title, course_id, type, due_date, due_time, priority, status, notes,
                  sort_order, created_at, done_at
           FROM tasks WHERE user_id = ? ORDER BY id`
        )
        .all(guestId) as Row[]

      const insTask = db.prepare(
        `INSERT INTO tasks
           (user_id, title, course_id, type, due_date, due_time, priority, status, notes,
            sort_order, created_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      const taskMap = new Map<number, number>()
      for (const t of guestTasks) {
        const key = `${t.title}|${t.due_date}`
        if (existingTask.has(key)) continue
        const courseId =
          t.course_id === null || t.course_id === undefined ? null : courseMap.get(Number(t.course_id)) ?? null
        const info = insTask.run(
          targetId, t.title, courseId, t.type, t.due_date, t.due_time, t.priority, t.status, t.notes,
          t.sort_order ?? 0, t.created_at ?? new Date().toISOString(), t.done_at ?? null
        )
        taskMap.set(Number(t.id), Number(info.lastInsertRowid))
        existingTask.add(key)
        result.tasks += 1
      }

      /* ---------------- 考试 ---------------- */
      if (mode === 'replace') db.prepare(`DELETE FROM exams WHERE user_id = ?`).run(targetId)

      const guestExams = db
        .prepare(
          `SELECT id, course_name, exam_date, start_time, end_time, location, seat, note,
                  source, task_id, created_at
           FROM exams WHERE user_id = ? ORDER BY id`
        )
        .all(guestId) as Row[]

      /* INSERT OR IGNORE 让「同一场考试」由表上的 UNIQUE(user_id, course_name, exam_date, start_time)
         自动去重，不必自己比对 —— 这也是 merge 语义在这里唯一正确的写法。 */
      const insExam = db.prepare(
        `INSERT OR IGNORE INTO exams
           (user_id, course_name, exam_date, start_time, end_time, location, seat, note,
            source, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const e of guestExams) {
        const taskId = e.task_id === null || e.task_id === undefined ? null : taskMap.get(Number(e.task_id)) ?? null
        const info = insExam.run(
          targetId, e.course_name, e.exam_date, e.start_time, e.end_time, e.location, e.seat, e.note,
          e.source, taskId, e.created_at ?? new Date().toISOString()
        )
        if (Number(info.changes ?? 0) > 0) result.exams += 1
      }

      /* ---------------- 学期 / 节次设置 ---------------- */
      if (mode === 'replace') {
        if (guestSettings) setSettings(targetId, gs)
      } else if (!targetSettings) {
        // 目标账号还没写过设置（全新账号）：直接接管游客的，游客改过的节次/学期才不会丢
        if (guestSettings) setSettings(targetId, gs)
      } else if (guestSettings) {
        /* 走到这里必然 mode==='merge' 且目标已有设置 → merged 一定已算出（见上方注释）；
           termMap 与课程插入用的是同一份随机 id。 */
        if (!merged) throw new Error('claimGuestData: merge 学期映射缺失（内部错误）')
        const { terms, currentTermId } = merged
        const next: Settings = {
          ...ts,
          terms,
          currentTermId,
          /* 官方总学分：目标账号没有、游客有时才接管（它是"当前学期"的镜像，
             用游客的值去覆盖目标已有的值会与目标课程对不上） */
          officialCredits: ts.officialCredits ?? gs.officialCredits ?? null
        }
        setSettings(targetId, normalizeSettings(next))
      }

      /* ---------------- 反馈 / 站内信 ----------------
         这两类没有"冲突"概念（一个工单就是一个工单），直接改归属即可。
         不迁的话：游客提交的反馈会随游客账号一起被删掉，管理员那边回复到一半就没了。 */
      result.feedbacks = Number(
        db.prepare(`UPDATE feedbacks SET user_id = ? WHERE user_id = ?`).run(targetId, guestId).changes ?? 0
      )
      result.messages = Number(
        db.prepare(`UPDATE messages SET user_id = ? WHERE user_id = ?`).run(targetId, guestId).changes ?? 0
      )
    }

    /* ---------------- 收尾：删掉游客账号 ----------------
       courses / tasks / exams / user_settings / sessions / feedbacks / messages 都有
       ON DELETE CASCADE（PRAGMA foreign_keys = ON），一行 DELETE 即可全部回收。
       已迁移的数据是插到**目标账号**名下的新行，不受影响。 */
    db.prepare(`DELETE FROM users WHERE id = ? AND is_guest = 1`).run(guestId)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败也要把原始错误抛出去，它才是根因 */
    }
    throw err
  }

  return result
}

/** 游客账号默认保留天数（自最后一次活跃起算） */
export const GUEST_TTL_DAYS = 14

/**
 * 回收长期不活跃的一次性游客账号。
 *
 * 为什么必须有：用户清一次缓存 / 换个浏览器 / 开个无痕窗口，就是一个新游客账号。
 * 没有回收的话 users 表会被一次性账号慢慢灌满，管理员看板的统计口径也会被污染。
 *
 * 判据是 `COALESCE(last_seen_at, created_at)` —— 创建时 createGuestUser 就会写
 * last_seen_at，之后每次带 token 的请求由 authenticate → touchLastSeen 续期（60s 节流）。
 * 用 COALESCE 兜住历史数据（is_guest 这一列刚加上时不存在老游客，属于纯防御）。
 *
 * ⚠️ **提交过反馈的游客跳过回收**：管理员可能还在处理他的工单，
 * 账号一删工单会跟着 CASCADE 消失 —— 那是运营事故，不是清理。
 *
 * @returns 实际删除的游客账号数
 */
export function purgeStaleGuests(ttlDays: number = GUEST_TTL_DAYS): number {
  /* last_seen_at / created_at 都是 SQLite 的 datetime('now') 格式（UTC、'YYYY-MM-DD HH:MM:SS'），
     所以截止时间也要按同一格式拼，不能直接用 ISO 串（带 T 和毫秒，字符串比较会错）。 */
  const cutoff = new Date(Date.now() - ttlDays * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
  const info = db
    .prepare(
      `DELETE FROM users
       WHERE is_guest = 1
         AND COALESCE(last_seen_at, created_at) < ?
         AND id NOT IN (SELECT user_id FROM feedbacks)`
    )
    .run(cutoff)
  return Number(info.changes ?? 0)
}

export function deleteSession(token: string): void {
  /* 同时删两种形态：哈希键（新会话）与原文（升级前残留的存量会话）。
     只删一种的话，退出登录在某些设备上会"看起来没生效"。 */
  const key = hashSessionToken(token)
  db.prepare(`DELETE FROM sessions WHERE token = ? OR token = ?`).run(key, token)
}

/**
 * 作废某个用户的**全部**会话（所有设备一起下线）。
 *
 * 什么时候必须调用它：任何"这个账号的控制权发生了转移"的时刻 ——
 *   1. 学号账号被教务登录接管（provisionStudentAccount 的 existing 分支）：
 *      有人可能抢先用别人的学号注册过本地账号，此时只轮换密码**不够** ——
 *      抢注者手里的旧 token 仍然有效，会和本人共用同一个账号，读走真实成绩与课表。
 *   2. 管理员重置密码：用户来求助"我号被盗了"，重置密码的语义就是"把对方踢下线"，
 *      不删会话等于什么都没做。
 *   3. 密码重置申请被批准（见 approvePasswordReset，那里是这套逻辑的第一个使用者）。
 *
 * 为什么不放进 setUserPassword：改密码本身不等于"要踢人"（例如用户自己在设置里改密码，
 * 通常希望其它设备保持登录）。所以把"改密码"和"作废会话"做成两个显式动作，
 * 由调用点决定要不要一起做 —— 这样每个调用点的意图在代码里一眼可见。
 */
export function revokeAllSessions(userId: number): number {
  const info = db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
  return Number(info.changes ?? 0)
}

export function getSessionUser(token: string): (User & { token: string }) | null {
  if (!token) return null
  const key = resolveSessionKey(token)
  const now = Date.now()
  /* ⚠️ 这里**刻意不查 u.avatar**。
     鉴权中间件 authenticate() 每个请求都会调它（连 /api/home 这种"几十次/分钟"的轮询也算），
     而 avatar 是一列最长 400KB 的 base64 data URL —— 等于每个请求都把大半兆字节
     从磁盘读进内存、再整体丢弃（去掉它时只是 SELECT 少一列，不改变任何返回形状）。
     需要头像的接口（/api/auth/me、登录响应）各自单独查完整用户行。
     用 `0 AS avatar` 占位而不是干脆删列：返回类型要求该字段存在，
     调用方若新增了对 avatar 的读取，拿到空串也远好过 undefined 引发的隐式"undefined"文案。 */
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.nickname, u.role, '' AS avatar, u.theme, u.onboarded, u.accent,
              u.is_guest AS isGuest, s.token, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(key, new Date(now).toISOString()) as (User & { token: string; expiresAt: string }) | undefined
  if (!row) return null

  /* 滑动续期：有效期 30 天，但"30 天"应该是**不活跃** 30 天才过期。
     此前是固定 30 天：一个天天用的用户也会在第 30 天被登出，而本项目的学号账号
     本地密码是随机串（见 provisionStudentAccount），被登出基本等于要找管理员。
     剩余不足 7 天才续，避免每个请求都写一次库。 */
  const remain = new Date(row.expiresAt).getTime() - now
  if (remain < SESSION_RENEW_BELOW_MS) {
    try {
      db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(
        new Date(now + SESSION_TTL_MS).toISOString(),
        key
      )
    } catch {
      /* 续期失败不影响本次请求 */
    }
  }
  return row
}

/* ---------------- 图形验证码 ---------------- */

/** 验证码有效期：10 分钟 */
const CAPTCHA_TTL_MS = 10 * 60 * 1000

/** 清掉已过期的验证码（已用过的最多滞留一个 TTL 周期），避免表无限增长 */
function purgeCaptchas(): void {
  db.prepare(`DELETE FROM captchas WHERE expires_at < ?`).run(new Date().toISOString())
}

export function createCaptcha(): { id: string; svg: string; expiresAt: string } {
  purgeCaptchas()
  const id = randomBytes(16).toString('hex')
  const code = makeCaptchaCode(4)
  const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS).toISOString()
  db.prepare(`INSERT INTO captchas (id, code, expires_at) VALUES (?, ?, ?)`).run(id, code, expiresAt)
  return { id, svg: renderCaptchaSvg(code), expiresAt }
}

/**
 * 校验并一次性消费验证码（大小写不敏感）。
 * 返回 true 表示通过；无论通过与否该验证码都会被标记使用，防止爆破。
 */
export function verifyCaptcha(id: string, input: string): boolean {
  const row = db.prepare(`SELECT code, expires_at AS expiresAt, used FROM captchas WHERE id = ?`).get(id) as
    | { code: string; expiresAt: string; used: number }
    | undefined
  if (!row) return false
  if (row.used === 1) return false
  db.prepare(`UPDATE captchas SET used = 1 WHERE id = ?`).run(id)
  if (new Date(row.expiresAt).getTime() < Date.now()) return false
  return row.code.trim().toLowerCase() === input.trim().toLowerCase()
}

/* 日历订阅 feed_token：每人一个，用于无需登录的 ICS 订阅地址 */
export function ensureFeedToken(userId: number): string {
  const row = db.prepare(`SELECT feed_token AS token FROM users WHERE id = ?`).get(userId) as { token: string | null } | undefined
  if (row?.token) return row.token
  const token = randomBytes(24).toString('hex')
  db.prepare(`UPDATE users SET feed_token = ? WHERE id = ?`).run(token, userId)
  return token
}

export function regenerateFeedToken(userId: number): string {
  const token = randomBytes(24).toString('hex')
  db.prepare(`UPDATE users SET feed_token = ? WHERE id = ?`).run(token, userId)
  return token
}

export function getUserByFeedToken(feedToken: string): User | null {
  const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE feed_token = ?`).get(feedToken) as User | undefined
  return row ?? null
}

/* ---------------- 每用户设置 ---------------- */

/**
 * 读用户设置。
 * 返回值已做「多学期归一化」：terms / currentTermId 一定存在，semester 是当前学期的镜像。
 * 归一化在内存里进行（不写库），因此存量数据无需迁移即可正确读取；
 * 真正落库发生在任何一次设置写入，或 scripts/migrate-terms.mts 批量回填时。
 */
export function getSettings(userId: number): Settings {
  const row = db.prepare(`SELECT data FROM user_settings WHERE user_id = ?`).get(userId) as { data: string } | undefined
  if (row) {
    /* ⚠️ 解析必须被兜住。user_settings.data 是整块 JSON 列，一旦某一行坏掉
       （手工改库、旧版本迁移中途中断、磁盘位翻转），裸 JSON.parse 会抛 SyntaxError，
       而 getSettings 被几乎所有课表/DDL/成绩接口调用 —— 表现为**这个用户所有页面都 500**，
       且他自己没有任何办法恢复（改设置也要先读出来）。这里降级为出厂默认，
       让用户至少能打开页面、重新保存一次设置把坏行覆盖掉。
       不在这里顺手写回库：getSettings 在 GET 路径上被高频调用，写操作应该由调用方决定。 */
    try {
      return normalizeSettings(JSON.parse(row.data) as Settings)
    } catch (e) {
      console.error(`[settings] 用户 #${userId} 的设置行损坏，已降级为默认值`, e)
    }
  }
  /* 没有记录（或记录损坏）→ 出厂默认（口径来自 semesterDefaults.ts，与迁移脚本共用同一份） */
  return normalizeSettings(defaultSettings() as Settings)
}

export function setSettings(userId: number, data: Settings): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data`
  ).run(userId, JSON.stringify(data))
}

/* ---------------- 示例数据播种（已下线） ----------------

   历史实现说明（2026-09-05 移除）：
   早期版本会在「用户注册」和「管理员点击补种」两个时机调用 seedDemoForUser()，
   往新账号里写 5 门示例课程 + 5 条示例 DDL，帮新用户快速看到界面效果。
   实际使用中发现：示例内容与用户真实课表混杂，用户需要先删一批假数据才能开始用，
   反而增加上手成本。因此本版本起：
     - 注册不再写入任何示例课程/DDL（新账号课表与 DDL 均为空，由用户自行导入）；
     - 管理员后台的「补种示例数据」入口连同 `POST /api/admin/seed-demo` 一并移除；
     - 论坛示例帖保留（seedForumDemo）：论坛是公共内容区，有几条示例帖能让新用户看懂玩法。
   注意：移除播种不影响已有账号——已写入的示例数据仍在库里，用户可自行删除。
*/
