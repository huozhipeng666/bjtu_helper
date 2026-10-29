import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import {
  db, getSettings, setSettings, createUser, getUserByUsername, verifyPassword,
  createSession, deleteSession, getSessionUser, findUser, countUsers,
  ensureFeedToken, regenerateFeedToken, getUserByFeedToken, updateProfile, getDisplayName,
  createCaptcha, verifyCaptcha, markOnboarded, dataDirPath, purgeExpired, touchLastSeen,
  setUserPassword, hashPassword, revokeAllSessions, setUserPasswordHash,
  recordClientError, listClientErrors, tx,
  /* 密码重置申请（学号账号没有可用本地密码，只能靠管理员核实后批准） */
  createPasswordReset, listPendingPasswordResets, getPasswordReset,
  approvePasswordReset, rejectPasswordReset, countPendingPasswordResets,
  /* 一次性游客账号（未登录体验） */
  createGuestUser, getGuestIdByToken, countUserData, hasGuestData, claimGuestData,
  purgeStaleGuests, countGuests, usernameTaken, GUEST_TTL_DAYS, type ClaimMode
} from './db.js'
import { CredError, logCredTransportPolicy, openCredEnvelope, publicKeyInfo, readCredField } from './credCrypto.js'
import { encryptSecret } from './credAtRest.js'
import { sweepPlaintextCredentials } from './credMigration.js'
import { buildSecurityHeaders, healthDetailAllowed, publicHealthPayload, resolveListenHost } from './securityHeaders.js'
import { makeSlidingWindowLimiter, makeFanoutTracker, sweepCounterMap } from './rateLimit.js'
import { checkPasswordStrength } from './passwordPolicy.js'
import { checkImageConsistency } from './imageType.js'
import { addTerm, setCurrentOfficialCredits, switchTerm, updateTerm } from './terms.js'
import { sweepOrphanUploads } from './uploads.js'
import {
  HttpError, getCourse, getMonthData, getOverview, getTask, getWeekData, listCourses, listTasks,
  listExams, createExam, deleteExam, replaceExams, examToTask, type ExamInput
} from './lib.js'
import {
  createCouple, createShareGroup, disbandShareGroup, getCoupleGroup, getShareDetail,
  joinCouple, joinShareGroup, leaveShareGroup, listMyShareGroups, removeShareMember,
  rotateShareSecret, setShareMemberPrivacy, syncShareMember, unbindCouple, updateShareGroup
} from './share.js'
import {
  listPlans, createPlan, respondPlan, updatePlan, cancelPlan,
  findDueReminders, markReminded, notifyDueReminder
} from './plans.js'
import {
  createFeedback, listMyFeedbacks, myFeedbackStats, getFeedbackDetail, getFeedbackById,
  listAllFeedbacks, feedbackStats, replyToFeedback, setFeedbackStatus,
  listMessages, unreadMessageCount, markMessageRead, markAllMessagesRead,
  notifyAdminsByMail, FEEDBACK_TYPES, FEEDBACK_STATUSES,
  type FeedbackType, type FeedbackStatus
} from './feedback.js'
import {
  listHomeworks, upsertHomeworks, homeworkFingerprint,
  getHomeworkDetail, getHomeworkAttachmentPath, upsertHomeworkDetail
} from './homework.js'
import {
  listGrades, replaceGrades, computeStats, gradesFingerprint,
  AA_REPORT_CARD_URL, type ReportCardLanguage
} from './grades.js'
import {
  recordDomainChanges, snapshotCount, detectDataChanges, domainLabel, type DataChange
} from './changes.js'
import { mailStatus } from './smtp.js'
import { buildTaskIcs } from './calendar.js'
import { isValidISODate, isValidTime, localStamp, toISODate } from './date.js'
import { IMAGE_MAX_CHARS, VisionError, isVisionConfigured, recognizeSchedule, visionModelName } from './vision.js'
import {
  createRecognizeJob, getRecognizeJob, markRecognizeDone, markRecognizeFailed,
  markRecognizeRunning, updateRecognizePhase, activeJobCount, type RecognizeJob
} from './recognizeJob.js'
import {
  MisError, type MisErrorKind, countMisSessions, destroyMisSession, findUserMisSession, startMisSession, misLogin, misFetchCourses,
  misFetchExams, misFetchAll, misFetchBksyTimetable, misFetchReportCard, rebindMisSession, misFetchHomeStatus,
  misFetchOccupancy, misFetchOccupancySemesters
} from './mis.js'
import {
  bksyFetchCourseware, bksyDownloadCourseware, bksyListCoursesForCourseware,
  bksyExportCoursewareDirectory
} from './courseware.js'
import { buildZip, zipDirEntry } from './zip.js'
import {
  misMailboxAttachment, misMailboxBeginCompose, misMailboxCancelCompose, misMailboxList,
  misMailboxRead, misMailboxSend
} from './mailbox.js'
import {
  CLASSROOM_BUILDINGS, ClassroomParseError, fetchClassroomCapacity, isKnownBuilding
} from './classroom.js'
import {
  HomeStatusParseError, describeHomeStatusError
} from './homeStatus.js'
import {
  ClassroomOccupancyParseError, OCCUPANCY_BUILDINGS, OCCUPANCY_KIND_LABEL, SLOT_TIME_RANGES
} from './classroomOccupancy.js'
import {
  AcademicCalendarParseError, fetchAcademicCalendar
} from './academicCalendar.js'
import {
  bksySso, bksySessionId, bksyFetchSemesters, bksyFetchCourses,
  bksyFetchHomeworks, bksyFetchHomeworkDetail, bksyDownloadHomeworkAttachment
} from './bksy.js'
import {
  bksySubmitHomework, bksyUploadHomeworkFile,
  MAX_SUBMIT_NOTE_LENGTH, MAX_TOTAL_UPLOAD_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES
} from './homeworkSubmit.js'
import {
  getMisSession, MisError as _MisError, MIS_ORIGIN
} from './mis.js'
import {
  ACCOUNT_PLATFORMS, ACCOUNT_PLATFORM_LABEL, accountPlatformLabel, isAccountPlatform,
  listAccounts, readAccount, upsertAccount, deleteAccount, type AccountPlatform
} from './independentAccounts.js'
import {
  fetchCitelSnapshot, verifyCitelAccount
} from './platformCitel.js'
import {
  fetchPhyVlabAssignmentDetail, fetchPhyVlabSnapshot, verifyPhyVlabAccount
} from './platformPhyvlab.js'
import {
  fetchPhysicsLabSnapshot, verifyPhysicsLabAccount
} from './platformPhysicslab.js'
import {
  fetchPhyDemoBookings, verifyPhyDemoAccount
} from './platformPhydemo.js'
import { PlatformError } from './platformHttp.js'
import {
  buildCourseDraft, buildTaskDraft, labDateISO,
  type LabCourseDraft, type LabEntry, type LabSource, type LabTaskDraft
} from './labToSchedule.js'
import { applyLabDrafts, removeLabDrafts } from './labImport.js'
import { campusRelayPoll, campusRelayResult, deviceRelayPoll, deviceRelayResult, relayStatus, withTransportUser } from './campusRelay.js'

/** 课件路由用的会话查找器：把模块私有的 sessions.get 暴露成更友好的错误信息。 */
function requireSession(sid: string, userId: number) {
  const s = getMisSession(sid)
  if (!s || s.userId !== userId) throw new _MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new _MisError('尚未完成 MIS 登录')
  return s
}
import type {
  Course, Period, Task, TaskStatus, TaskType, Priority, WeekType, UserRole, User, ThemeMode, Exam, Term, SemesterWeek
} from './types.js'

const app = express()
/* 评审 D4（2026-10-23）：不再响应 `X-Powered-By: Express`。
   指纹收敛——攻击者据此精确匹配 Express 已知漏洞/CVE，收益为零、纯风险。 */
app.disable('x-powered-by')

/* ---------------- 进程级兜底 ----------------

   为什么必须有这两行：Express 4 **不**捕获 async handler 里的 rejection。
   只要有人在一个 async 路由的 try 之外抛了错（曾经真实发生过：/api/report-card
   的 lang 校验写在了 try 外），Promise 就会变成 unhandledRejection，
   而 Node ≥15 的默认行为是**直接退出进程** —— 表现为"某个接口一被调用，全站 502 几秒"。

   两个 handler 的语义**刻意不同**：
   - unhandledRejection：记日志，不退出。异步失败几乎总是发生在某个请求的上下文里，
     Express 已把该请求留给它自己的 catch/超时，进程本体状态没有被破坏。
   - uncaughtException：**标记降级 + 主动退出**。同步异常会从任意栈帧抛出来，最典型的是
     `db.exec('BEGIN IMMEDIATE')` 已执行、但后续步骤没被 try 住（见 db.ts 的 tx() 注释）——
     此时这个连接会一直停在事务里，之后**所有写操作**都返回
     "cannot start a transaction within a transaction"，而读操作一切正常。
     换句话说进程进入"半死"状态：用户看到的是"能打开、但什么都存不上"，而日志里
     一条 CRASH 都没有。重启成本约 3 秒，远小于让脏连接持续写库。

   降级信号同时暴露在 /api/health（503 + reason=degraded），运维与部署脚本能立刻看到。 */
let degraded = false

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] 未捕获的 Promise rejection（已忽略，进程继续运行）：', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获的同步异常（标记降级，3 秒后退出交给 systemd 重启）：', err)
  if (degraded) return
  degraded = true
  /* 给在途请求 3 秒把响应写完，再退出。unref 保证这个定时器本身不会吊住进程。 */
  setTimeout(() => {
    console.error('[fatal] 降级后主动退出，等待进程管理器拉起')
    process.exit(1)
  }, 3_000).unref()
})

/* 声明反向代理可信跳数。生产是 nginx 与 Node 同机（systemd 直跑，nginx 反代 127.0.0.1:3001）。

   ⚠️ 这里**不能**写成数字 1 —— 那等于把限流交给攻击者。
   nginx 的 $proxy_add_x_forwarded_for 是把客户端自带的 X-Forwarded-For **追加**在前面，
   于是 XFF = "攻击者伪造值, 真实IP"；而 trust proxy = 1 的语义是「从右往左跳过 1 跳
   可信代理」，跳掉真实 IP 后返回给 req.ip 的恰好就是攻击者自己填的那个值。
   后果：验证码 30/min、登录 30/min、MIS 匿名 60/hour 这些基于 IP 的闸门，
   只要每次请求轮换 X-Forwarded-For 就能完全绕过（实测 60 次请求 0 次被拦）。

   'loopback' 的语义是「只信任环回地址」。proxy-addr 把 [对端地址, ...XFF 倒序] 排成一条链，
   从最右的对端地址起，只要当前项可信就往左再走一格，最后停在第一个非环回地址上。
   生产里 XFF 最右一项是 nginx 填的 $remote_addr = 真实客户端公网 IP（非环回），
   于是链条停在那里，攻击者塞在它左边的伪造值永远取不到 → req.ip 恒为真实客户端 IP。
   同时它也解决了「不声明 trust proxy 时 req.ip 恒为 127.0.0.1、全站共用一个限流桶」
   这个老问题（那正是当初改成数字 1 的动机）。

   ⚠️ 上面这条推理依赖「$remote_addr 不是环回地址」，所以**没法在单机上验证**：
   本地把客户端和模拟 nginx 都跑在 127.0.0.1 时，$remote_addr 就是环回、会被判为可信，
   链条继续往左走到伪造值，实测 60 次轮换伪造请求 0 次被拦。这是测试环境的假象，
   不是线上行为。真正能兜住一切的还是下面这条 nginx 侧的覆盖式 XFF —— 覆盖之后
   伪造头根本进不到 Node，本地也能复现（实测 30 次后开始 429）。

   配套改动：deploy/nginx-server.conf 已把 X-Forwarded-For 从「追加」改为「覆盖」
   （$remote_addr），双重保险 —— 即便将来忘了这里的设置，伪造头也进不来。

   容器化部署（nginx 与 Node 不同机，Node 看到的对端是网桥地址而非环回）时，
   'loopback' 会把所有请求判成同一个网桥 IP，退化成共用一个桶；此时显式设
   TRUST_PROXY=1，并务必确认 nginx 侧是覆盖而非追加 XFF。 */
const trustProxyRaw = (process.env.TRUST_PROXY ?? '').trim()
/* TRUST_PROXY 允许填跳数（1、2）或 Express 支持的关键字（loopback）。
   纯数字才转成 number，其余原样透传，避免 'loopback' 被 Number() 变成 NaN。 */
app.set('trust proxy', trustProxyRaw === '' ? 'loopback' : /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : trustProxyRaw)

/* CORS：生产单端口同时托管 web/dist 与 API，开发环境走 vite proxy（/api → :3001），
   两者都是同源访问，因此默认不输出任何 CORS 头即可。
   仅当显式配置 CORS_ORIGINS（逗号分隔的白名单）时才放行，避免默认 * 让任意站点
   可携带被窃取的 token 调用 API。 */
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: false }))
}

/* 请求体上限：**默认 64kb，大 body 只对白名单路由开放**。

   此前是全局 `express.json({ limit: '8mb' })`。而 body-parser 会**先把整个 body
   读进内存再解析**，所以最坏情况下一个并发请求就能吃掉 8MB 内存 —— 登录、DDL 增删改
   这些几 KB 的接口也一样。校园网整栋楼共用一个出口，一个脚本就能把内存打满。

   为什么用 `type` 分流，而不是"全局小的、路由级大的"：
   body-parser 是「先到先得」——一旦全局中间件已经把 body 解析掉，
   后面路由级那个看到 `req.body` 已存在就直接跳过，8mb 那行等于没写。
   这里改成：全局只吃**普通 JSON**（排除识别/头像这类带 base64 图片的路径），
   大 body 由各自的路由级 json() 负责。这样新增接口默认被 64kb 兜住，
   只有显式列进这里的路径才会放宽。 */
const LARGE_BODY_PATHS = [
  '/api/courses/recognize-photo', // 课表截图（base64，前端压到长边 1600 后通常 <1MB）
  '/api/courses/recognize-lab-photo', // 实验课表截图（已下线，保留以免旧客户端拿到 413）
  '/api/auth/profile', // 头像 data URL（AVATAR_MAX_CHARS = 400KB，前端已压缩）
  '/api/feedback/upload', // 反馈图片（服务端上限 3MB 二进制 → base64 约 4MB）
  /* 作业提交：文件以 base64 走 JSON（不引 multipart 解析器）。
     服务端总量上限 6MB → base64 后 8MB，加 JSON 开销约 8.1MB。 */
  '/api/homework/submit',
  /* 校园网中继回传的响应体：页面最大 4MB（MAX_BODY_BYTES）→ base64 约 5.4MB。
     设备通道（手机原生桥）走同一个形状，**必须一并列出** —— 漏掉它的表现是
     「手机上明明取到了页面，服务端却一直等到出口超时」，因为 413 是全局 64kb
     解析器在路由之前就拒掉的，任务就这样丢了。 */
  '/api/campus-relay/result',
  '/api/campus-relay/device/result'
]
const needsLargeBody = (path: string): boolean => LARGE_BODY_PATHS.some((p) => path.startsWith(p))

/**
 * 大 body 路由用的解析器。
 *
 * 8MB 是给识别/头像/反馈用的；作业提交单独一档 10MB ——
 * 这个数字不是随手定的：`deploy/nginx-server.conf` 里
 * `client_max_body_size 10m`，Express 这边再多也没意义（nginx 会先 413）。
 * 服务端的作业文件总量上限 6MB 就是为了让 base64 后的 8MB 落在 10m 以内。
 */
const largeJson = express.json({ limit: '8mb' })
const submitJson = express.json({ limit: '10mb' })

app.use((req, res, next) => {
  if (req.path.startsWith('/api/homework/submit')) return submitJson(req, res, next)
  return needsLargeBody(req.path) ? largeJson(req, res, next) : next()
})
app.use(express.json({ limit: '64kb' }))

/**
 * 安全响应头。
 *
 * 为什么不引 helmet：本项目的响应头需求很窄（没有第三方域、没有 cookies 依赖），
 * 手写这几条比多引一个依赖更可控，也不会在升级时被默认值变化影响。
 *
 * CSP 的取舍说明（每一项都是按本项目实际情况定的，不是照抄的模板）：
 *  - `script-src 'self' 'sha256-...'`（哈希由 renderApp 运行时算出，见下）：
 *      index.html 里的防闪脚本 /theme-init.js 会被内联进 HTML，省掉一次同步的
 *     渲染阻塞请求。内联脚本必须靠哈希/随机数放行，而本项目的 CSP 是静态字符串、
 *     脚本内容又装在 web/dist（构建产物），所以哈希只能在启动/首次请求时对文件算一次。
 *      为什么不改用 nonce：nonce 必须每个响应都不同，而 /app 的 HTML 是要被 ETag
 *      缓存的（内容不变就 304），加 nonce 会让它每次都变，等于放弃缓存。
 *      `'self'` 保留：其余的 <script src="/assets/..."> 仍是外链。
 *  - `style-src 'self' 'unsafe-inline'`：前端有 255 处 `style={{}}` 内联样式（进度条、主题色等），
 *     必须放开 unsafe-inline 否则样式全丢。内联样式的注入危害远小于脚本，可接受。
 *  - `img-src 'self' data: blob:`：头像存 data URL、论坛图片走本域 /uploads/、预览用 blob。
 *  - `connect-src 'self'`：API 全部同源；开发环境页面由 Vite 自己托管，不受本头约束。
 *  - `worker-src 'self'` / `manifest-src 'self'`：PWA 用。Service Worker 与 manifest 找不到
 *     专属指令时会回落到 default-src，因此**不加也能跑**；显式写出来是为了让"允许 SW"这件事
 *     在配置里一眼可见 —— 将来若有人把 default-src 收紧成 'none'，这里不会被连带打断。
 *  - 无第三方域（已核实无 @import / CDN / 外部字体），所以 default-src 可以直接锁 'self'。
 *  - HSTS 不在这里下发：`Strict-Transport-Security` 由 nginx 的 443 server 块负责
 *    （见 deploy/nginx-server.conf）。放在应用层的话 HTTP 响应也会带上它，
 *    而浏览器会忽略非 HTTPS 响应里的 HSTS —— 白发一趟，还容易让人误判"已经生效了"。
 */
/* /theme-init.js 会被内联进 /app 的 HTML（见 renderApp），内联脚本必须靠 sha256
   在 CSP 里放行。哈希按文件 mtime 缓存；文件不存在就返回 null，此时 CSP 只有 'self'，
   renderApp 也不会内联 —— 两边由同一个判据驱动，不会出现"内联了但没放行"。 */
const themeInitFile = join(process.cwd(), 'web', 'dist', 'theme-init.js')
let themeInitHashCache: { key: string; hash: string } | null = null
function themeInitHash(): string | null {
  try {
    const key = String(statSync(themeInitFile).mtimeMs)
    if (themeInitHashCache && themeInitHashCache.key === key) return themeInitHashCache.hash
    const hash = 'sha256-' + createHash('sha256').update(readFileSync(themeInitFile, 'utf8')).digest('base64')
    themeInitHashCache = { key, hash }
    return hash
  } catch {
    return null
  }
}

app.use((_req, res, next) => {
  /* 头清单与逐条理由都在 securityHeaders.ts 里（抽成纯函数是为了能回归）。
     script-src 是唯一"动态"的一项：/theme-init.js 会被内联进 /app 的 HTML，
     内联脚本必须靠 sha256 放行。 */
  const headers = buildSecurityHeaders(themeInitHash())
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  next()
})

/* ---------------- 访问日志 ----------------

   为什么必须有一条：此前全仓只有 23 条 console.*（都是定时任务与 fail()），
   用户说"很慢 / 打不开 / 报错了"时，除了翻 journald 里零星的堆栈之外无迹可查。
   排查成本最高的一类问题恰恰是"偶发、不可复现、只在某个接口上"。

   设计取舍：
   - **一行一条 JSON**，交给 journald 收集（`journalctl -u bjtu-helper -o cat | grep '"s":500'`）。
     不上 Prometheus / Sentry：90 个用户、单机部署，多一个服务就是多一个故障点。
   - **不记 body、不记 Authorization、不记 query 串**（密码在 body 里，token 在头里）。
   - **路径要脱敏**：ICS 订阅地址把 token 放在路径里（/api/calendar/<48hex>.ics），
     原样记下来等于把"可直接订阅的凭据"写进日志，所以对这一段做替换。
   - 慢请求打 `[slow]` 标记（阈值 500ms）：MIS 抓取/视觉模型已改成异步任务，
     正常请求不该超过它；真超了就是值得看一眼的信号。
   - `ACCESS_LOG=0` 可关（本地跑测试时避免刷屏）。 */
const ACCESS_LOG = process.env.ACCESS_LOG !== '0'
const SLOW_MS = 500

/** 把路径里可能带凭据的段替换成 ***，避免把 token 写进日志 */
function redactPath(path: string): string {
  /* /api/calendar/<token> 与 /api/calendar/<token>.ics */
  const feed = path.match(/^\/api\/calendar\/([^/]+)$/)
  if (feed && !['token', 'feed'].includes(feed[1])) return '/api/calendar/***'
  return path
}

if (ACCESS_LOG) {
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint()
    res.on('finish', () => {
      try {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
        const entry = {
          t: new Date().toISOString(),
          m: req.method,
          p: redactPath(req.originalUrl.split('?')[0] ?? ''),
          s: res.statusCode,
          ms: Math.round(ms * 10) / 10,
          u: (req as AuthedRequest).user?.id ?? 0,
          ip: req.ip ?? '-',
          ...(ms > SLOW_MS ? { slow: true } : {})
        }
        console.log(`[req] ${JSON.stringify(entry)}`)
      } catch {
        /* 日志失败绝不影响响应 */
      }
    })
    next()
  })
}

/* 论坛图片目录：/uploads 静态托管（必须在 SPA fallback 之前注册）。
   文件名由服务端随机生成，不接受客户端路径，杜绝目录穿越。 */
const uploadsDir = join(dataDirPath, 'uploads')
mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', immutable: true }))
/* 静态目录没命中的 /uploads 请求直接 404，避免回退到 SPA 的 index.html（图片 src 加载失败时表现更直观） */
app.use('/uploads', (_req, res) => {
  res.status(404).end()
})

const PORT = Number(process.env.PORT ?? 3001)

/* ICP 备案号：域名备案后工信部要求首页底部展示，并链接到 beian.miit.gov.cn。
   走环境变量而不是写死在 HTML 里 —— 换域名/换主体时改配置即可，不用重新构建前端。

   ⚠️ 清洗规则**不能**用 [^A-Za-z0-9-]：备案号里带着中文，典型形态是
   `京ICP备12345678号-1`，按 ASCII 白名单过滤会把"京""备""号"全删掉，
   只剩 `ICP12345678` —— 号码是错的，而页面上看不出任何异常。
   这里只剔除真正会破坏 HTML 的字符（< > & " ' ` 与反斜杠）以及控制字符，
   其余原样保留。 */
const ICP_LICENSE = (process.env.ICP_LICENSE ?? '')
  .trim()
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '')

/* ---------------- helpers ---------------- */

type AuthedRequest = Request & {
  user?: {
    id: number
    username: string
    nickname: string
    role: UserRole
    avatar: string | null
    theme: ThemeMode
    onboarded: number
    /* 自选主题色（色相 0-359，NULL = 默认）。authenticate 中间件会一并挂上，
       此前这里漏了该字段，导致 `tsc --noEmit` 报「accent 不存在于类型」（存量欠账）。 */
    accent: string | null
    /* 是否为一次性游客账号。requireRealUser 依据它拦住高成本接口
       （教务导入、拍照识别），countUsers / 管理员查询依据它排除游客。 */
    isGuest: boolean
  }
}

function fail(res: Response, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
  } else if (err instanceof CredError) {
    /* 凭据信封类错误（解不开 / kid 过期 / 超长）都是**客户端提交的问题**，
       必须在 fail 里统一映射成 400。若漏掉这一支，它会掉进下面的兜底分支被记成
       服务端 500 并打一条 console.error，既污染日志又误导排障方向。 */
    res.status(400).json({ error: err.message })
  } else if (err instanceof MisError) {
    /* 教务侧错误（统一身份认证拒绝、账号未激活、跳转异常、响应过大…）与 CredError 同理：
       它们描述的是"上游/输入的问题"，不是本服务的 bug。此前只有写了自己 catch 的
       路由会调 misFail()，一旦走 asyncRoute 的兜底就会掉进 500 —— 用户看到
       "服务器内部错误"，而真正原因（密码错、账号未激活、学校门户超时）全被埋了。
       放在 fail() 里统一映射，两条路径行为一致。
       2026-10-23 起（评审 A9）按 kind 细分状态码：input 400 / network 503 / upstream 502。 */
    res.status(MIS_ERROR_STATUS[err.kind]).json({ error: err.message })
  } else if (err instanceof PlatformError) {
    /* 四个独立平台（CITEL / 物理在线 / 物理实验 / 演示实验）的错误码语义比
       MIS 细：parse / network 映射 502（上游页面改版或站点不可达，重试通常无解），
       login-failed 映射 400（凭据错，用户能自己修），rate-limited 429。
       放在 fail() 里而不是每个路由各写一遍 catch，理由同 MisError。 */
    const status = PLATFORM_HTTP_STATUS[err.code] ?? 502
    res.status(status).json({ error: err.message, code: err.code })
  } else {
    console.error(err)
    res.status(500).json({ error: '服务器内部错误' })
  }
}

function intParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '无效的 id')
  return n
}

/**
 * async 路由的兜底包装。
 *
 * ⚠️ 为什么需要它：Express 4 **不**捕获 async handler 返回的 Promise rejection。
 *    一个 async 路由里只要有一处 await 之后抛错、而那段代码不在 try 里，
 *    这个 rejection 就没人接收 —— 请求会一直挂着（客户端等到超时才收到 nginx 的 504），
 *    同时 process.on('unhandledRejection') 记一条日志。现行代码靠"每个 handler 自己写
 *    try/catch + fail()" 规避，但那是**靠人记性**的：新增路由忘了写就静默挂起，
 *    而且 `res.json()` 之后才抛的错，即使在 try 里也救不回来（响应已经发出）。
 *
 *    这层包装把"有没有 try"变成结构性保证：同步抛错、async rejection、
 *    res 已发送后再抛错（只记日志、不二次响应）三种情况都被正确处理。
 *    handler 自己仍然可以写 try/catch（文案更精确），这里只是兜住漏网的那些。
 */
type AnyHandler = (req: Request, res: Response, next: NextFunction) => unknown

function asyncRoute(fn: AnyHandler): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next)
      /* 同步返回值不是 Promise（普通 handler）→ 同步错误已被上面的 try 捕获，直接结束 */
      if (!out || typeof (out as Promise<unknown>).then !== 'function') return
      ;(out as Promise<unknown>).then(undefined, (err: unknown) => {
        /* 响应头已发出时不能再 res.status().json()，否则 Express 抛 ERR_HTTP_HEADERS_SENT
           并把真正的错误盖掉。这种情况下只能记日志 + 断开连接，让客户端感知到异常。 */
        if (res.headersSent) {
          console.error('[asyncRoute] 响应已发出后抛错：', err)
          res.destroy()
          return
        }
        fail(res, err)
      })
    } catch (err) {
      if (res.headersSent) {
        console.error('[asyncRoute] 响应已发出后同步抛错：', err)
        res.destroy()
        return
      }
      fail(res, err)
    }
  }
}

function getToken(req: Request): string {
  const h = req.headers.authorization ?? ''
  return h.replace(/^Bearer\s+/i, '').trim()
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = getToken(req)
  if (!token) throw new HttpError(401, '未登录')
  const user = getSessionUser(token)
  if (!user) throw new HttpError(401, '登录已失效，请重新登录')
  ;(req as AuthedRequest).user = {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    /* getSessionUser 出于性能不再取 avatar 列（最长 400KB，每个请求都读一遍不值得），
       这里显式置空，保证 AuthedRequest.user 的形状不变。需要头像的接口自己查库
       （/api/auth/me、登录/注册响应走 publicUser / findUser）。 */
    avatar: user.avatar ?? '',
    theme: user.theme,
    onboarded: user.onboarded,
    accent: user.accent,
    isGuest: !!user.isGuest
  }
  /* 记录最后活跃时间（管理员「活跃度看板」的数据源）。
     放在这里而不是各路由里：只要带了有效 token 的请求都算"在用"，无需逐接口埋点。
     内部有 60s 节流，不会每个请求都写库（详见 db.ts touchLastSeen）。
     写失败不能影响主流程——活跃度是运营数据，不是业务数据。

     游客同样要写：purgeStaleGuests 就是按 last_seen_at 判断"这个一次性账号多久没来了"，
     不写的话所有游客都会被当成"从未活跃"而立刻回收。 */
  try {
    touchLastSeen(user.id)
  } catch {
    /* 忽略 */
  }
  next()
}

function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if ((req as AuthedRequest).user?.role !== 'admin') throw new HttpError(403, '需要管理员权限')
  next()
}

/**
 * 只允许**真实账号**访问（游客会被 403 拦下）。
 *
 * 为什么必须有它、而不能只靠前端隐藏按钮：
 *   - `/api/mis/*` 会真实登录学校门户（消耗学校侧风控额度，也是撞库放大器）；
 *   - `/api/courses/recognize-photo` 会真实调用视觉大模型（真金白银）。
 * 前端把按钮藏起来挡不住任何人 —— 拿到游客 token 直接 curl 一样能打。
 * 所以"需要登录"必须是一条服务端事实，前端引导只是配套的 UX。
 *
 * ⚠️ `/api/auth/mis/*`（匿名教务登录）**不能**挂它：那条路径本身就是登录通道，
 * 它的职责是"校验通过后给你一个真实账号"，挂上就死锁了。
 */
function requireRealUser(req: Request, _res: Response, next: NextFunction): void {
  if ((req as AuthedRequest).user?.isGuest) {
    throw new HttpError(403, '该功能需要登录后使用')
  }
  next()
}

const WEEK_TYPES: WeekType[] = ['all', 'odd', 'even']
const TASK_TYPES: TaskType[] = ['homework', 'exam', 'other']
const PRIORITIES: Priority[] = ['high', 'medium', 'low']
const STATUSES: TaskStatus[] = ['pending', 'done']
const COURSE_COLORS = [
  '#4f7cff', '#ff6b6b', '#20c997', '#ffa94d', '#845ef7',
  '#f783ac', '#12b886', '#ffd43b', '#4dabf7', '#e8590c'
]

function validateCourseBody(body: Record<string, unknown>, partial: boolean): Partial<Course> {
  const out: Partial<Course> = {}
  const req = (key: string) => (partial ? key in body : true)

  if (req('name')) {
    const name = String(body.name ?? '').trim()
    if (!name) throw new HttpError(400, '课程名称不能为空')
    out.name = name
  }
  if ('teacher' in body) out.teacher = String(body.teacher ?? '')
  if ('location' in body) out.location = String(body.location ?? '')
  if (req('dayOfWeek')) {
    const d = Number(body.dayOfWeek)
    if (!Number.isInteger(d) || d < 1 || d > 7) throw new HttpError(400, 'dayOfWeek 需为 1-7')
    out.dayOfWeek = d
  }
  if (req('startPeriod') || req('endPeriod')) {
    const s = Number(body.startPeriod)
    const e = Number(body.endPeriod)
    if (!Number.isInteger(s) || s < 1) throw new HttpError(400, 'startPeriod 非法')
    if (!Number.isInteger(e) || e < s) throw new HttpError(400, 'endPeriod 需 >= startPeriod')
    out.startPeriod = s
    out.endPeriod = e
  }
  if (req('weekStart') || req('weekEnd')) {
    const ws = Number(body.weekStart)
    const we = Number(body.weekEnd)
    if (!Number.isInteger(ws) || ws < 1) throw new HttpError(400, 'weekStart 非法')
    if (!Number.isInteger(we) || we < ws) throw new HttpError(400, 'weekEnd 需 >= weekStart')
    out.weekStart = ws
    out.weekEnd = we
  }
  if (req('weekType')) {
    if (!WEEK_TYPES.includes(body.weekType as WeekType)) throw new HttpError(400, 'weekType 需为 all/odd/even')
    out.weekType = body.weekType as WeekType
  }
  if (req('weeks')) {
    // 精确周集合：null/缺省 = 走「区间+单双周」旧口径；给了就必须是 1-60 的周号数组。
    // 写库时同步派生 weekStart/weekEnd/weekType 兼容摘要（min/max/奇偶性）。
    if (body.weeks === null || body.weeks === undefined || body.weeks === '') {
      out.weeks = null
    } else {
      if (!Array.isArray(body.weeks)) throw new HttpError(400, 'weeks 需为周号数组')
      const set = new Set<number>()
      for (const w of body.weeks) {
        const n = Number(w)
        if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'weeks 中的周号需为 1-60 的整数')
        set.add(n)
      }
      if (set.size === 0) throw new HttpError(400, 'weeks 不能为空数组')
      const weeks = [...set].sort((a, b) => a - b)
      out.weeks = weeks
      out.weekStart = weeks[0]
      out.weekEnd = weeks[weeks.length - 1]
      const allOdd = weeks.every((w) => w % 2 === 1)
      const allEven = weeks.every((w) => w % 2 === 0)
      out.weekType = allOdd ? 'odd' : allEven ? 'even' : 'all'
    }
  }
  if ('color' in body) {
    const c = String(body.color ?? '')
    out.color = /^#[0-9a-fA-F]{6}$/.test(c) ? c : COURSE_COLORS[0]
  }
  if ('credits' in body) {
    const cr = body.credits
    // 可空数值：null / '' 表示未填；填了就必须是正数（允许 0.5 这类半学分）
    if (cr === null || cr === '' || cr === undefined) {
      out.credits = null
    } else {
      const n = Number(cr)
      if (!Number.isFinite(n) || n < 0 || n > 30) throw new HttpError(400, 'credits 需为 0-30 的数值')
      out.credits = n
    }
  }
  if ('gradingPolicy' in body) {
    out.gradingPolicy = String(body.gradingPolicy ?? '').trim().slice(0, 500)
  }
  return out
}

function validateTaskBody(body: Record<string, unknown>, partial: boolean): Partial<Task> {
  const out: Partial<Task> = {}
  const req = (key: string) => (partial ? key in body : true)

  if (req('title')) {
    const title = String(body.title ?? '').trim()
    if (!title) throw new HttpError(400, '任务标题不能为空')
    out.title = title
  }
  if ('courseId' in body) {
    const cid = body.courseId
    out.courseId = cid === null || cid === '' ? null : Number(cid)
    if (out.courseId !== null && (!Number.isInteger(out.courseId) || out.courseId <= 0))
      throw new HttpError(400, 'courseId 非法')
  }
  if (req('type')) {
    if (!TASK_TYPES.includes(body.type as TaskType)) throw new HttpError(400, 'type 需为 homework/exam/other')
    out.type = body.type as TaskType
  }
  if (req('dueDate')) {
    const d = String(body.dueDate ?? '')
    if (!isValidISODate(d)) throw new HttpError(400, 'dueDate 需为合法日期 YYYY-MM-DD')
    out.dueDate = d
  }
  if ('dueTime' in body) {
    const t = String(body.dueTime ?? '')
    if (t !== '' && !isValidTime(t)) throw new HttpError(400, 'dueTime 需为 HH:mm')
    out.dueTime = t
  }
  if (req('priority')) {
    if (!PRIORITIES.includes(body.priority as Priority)) throw new HttpError(400, 'priority 需为 high/medium/low')
    out.priority = body.priority as Priority
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status as TaskStatus)) throw new HttpError(400, 'status 需为 pending/done')
    out.status = body.status as TaskStatus
  }
  if ('notes' in body) out.notes = String(body.notes ?? '')
  return out
}

function validatePeriods(periods: unknown): Period[] {
  if (!Array.isArray(periods) || periods.length === 0) throw new HttpError(400, 'periods 需为非空数组')
  const out: Period[] = []
  const seenIndices = new Set<number>()
  for (const p of periods) {
    const idx = Number((p as Period).index)
    const start = String((p as Period).start)
    const end = String((p as Period).end)
    if (!Number.isInteger(idx) || idx < 1) throw new HttpError(400, '节次 index 非法')
    if (seenIndices.has(idx)) throw new HttpError(400, `节次序号 ${idx} 重复`)
    seenIndices.add(idx)
    if (!isValidTime(start) || !isValidTime(end)) throw new HttpError(400, '节次时间需为 HH:mm')
    out.push({ index: idx, start, end })
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

function uid(req: Request): number {
  return (req as AuthedRequest).user!.id
}

/**
 * 返回给客户端的用户对象。
 * **绝不包含 passwordHash**。注册 / 登录 / 教务登录三处发 token 的地方共用它，
 * 免得上线后加字段时三处写法漂移（历史上就出现过某处漏带 onboarded 导致引导重复弹）。
 */
function publicUser(u: User): Record<string, unknown> {
  return {
    id: u.id, username: u.username, nickname: u.nickname, role: u.role,
    avatar: u.avatar, theme: u.theme, onboarded: u.onboarded, accent: u.accent,
    /* 游客标记：前端据此显示「游客」徽标、把导入入口换成登录引导。
       注意**不是**安全边界 —— 真正的拦截在 requireRealUser（服务端）。 */
    isGuest: !!u.isGuest
  }
}

/**
 * 取请求体里可能的凭据信封。
 *
 * 客户端（小程序与网页端）会把学号/密码/确认密码打包成 RSA-OAEP 密文放在 body.credEnc，
 * 旧版页面与缓存中的旧 JS 仍发明文 —— openCredEnvelope 对「没有信封」返回 null，
 * 两种情况都能走下去。信封**存在但解不开**时抛 CredError，由 fail 映射成 400。
 */
function credentialEnvelope(body: Record<string, unknown>): Record<string, string> | null {
  return openCredEnvelope(body.credEnc)
}

/* ---------------- routes ---------------- */

/**
 * 健康检查详情是否可见。判定逻辑与逐条理由见 securityHeaders.ts:healthDetailAllowed。
 *
 * 一句话版本：配了 HEALTH_DETAIL_TOKEN 就只认令牌；没配就只放行「本机直连且不带
 * 任何转发头」的调试请求（带 XFF 说明是从 nginx 反代进来的，不认）。
 */
function wantsHealthDetail(req: Request): boolean {
  return healthDetailAllowed({
    token: process.env.HEALTH_DETAIL_TOKEN ?? '',
    provided: String(req.get('x-health-token') ?? ''),
    wantDetail: req.query.detail === '1',
    peer: req.socket.remoteAddress ?? '',
    hasForwardedHeader:
      req.headers['x-forwarded-for'] !== undefined ||
      req.headers['x-real-ip'] !== undefined ||
      req.headers.forwarded !== undefined
  })
}

app.get('/api/health', (req, res) => {
  /* mail 只暴露"是否就绪"，不含任何凭据（host/port 是运维自填的，不算秘密，
     但也不给外部探测者用来指路，因此只回数量级信息）。

     其余字段的用途：部署脚本与人工排障需要能区分"进程活着但库坏了"和"进程活着且健康"。
     所以这里真的执行一次 `SELECT 1`（极便宜），并把 uptime / 内存 / 会话数带出来 ——
     这些足以判断"是不是内存涨了 / 会话表是不是被灌了"。
     ⚠️ 刻意**不做** PRAGMA integrity_check：它会锁库，放到健康检查里等于给自己埋雷。

     🔒 但这四项**不属于匿名访客**：version 直接对上"这版有没有已知漏洞"，
     uptimeSec/sessions/rssMb 能推断重启时机、活跃用户规模、以及"打多大能把进程打挂"。
     所以默认只回 {ok, db, mail}，要详情必须带运维令牌（HEALTH_DETAIL_TOKEN）。
     兼容旧调用方：部署脚本只 grep `"ok":true`，smoke 只断言 `ok`，都照旧。 */
  const mail = mailStatus()
  let dbOk = true
  try {
    db.prepare('SELECT 1').get()
  } catch {
    dbOk = false
  }
  let sessions = 0
  try {
    sessions = Number((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c ?? 0)
  } catch {
    /* 忽略：库刚坏时这一项没意义，dbOk 已经为 false */
  }
  /* 降级态（uncaughtException 之后）：库可能是"能读不能写"的半死状态，
     只回 db=ok 会让探活误判为健康。两者任一异常都返回 503。 */
  const healthy = dbOk && !degraded
  const full = {
    ok: healthy,
    ...(degraded ? { reason: 'degraded' } : {}),
    version: process.env.APP_VERSION ?? '0.1.0',
    uptimeSec: Math.round(process.uptime()),
    db: dbOk ? 'ok' : 'error',
    sessions,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    mail: { configured: mail.configured }
  }
  res.status(healthy ? 200 : 503).json(publicHealthPayload(full, wantsHealthDetail(req)))
})

/**
 * 凭据加密公钥（**公开接口，无需鉴权**）。
 *
 * 为什么可以公开：这是 RSA 公钥，本就是给未登录的「本校学生登录 / 游客注册」用的，
 * 拿着它只能**加密**、不能解密。私钥永远不离开进程。
 *
 * 为什么返回 JWK 的 n/e 而不是 PEM/SPKI：小程序端没有任何 ASN.1 能力，
 * 给 n/e 的话客户端只需 base64url → BigInt 就能直接做模幂运算，省掉一整个
 * DER 解析器（那是最容易写错、又最难在真机上定位的一部分）。
 * 原理与对拍方式见 server/src/credCrypto.ts 顶部注释。
 *
 * Cache-Control: no-store —— 密钥随进程重启轮换（未注入 CRED_PRIVATE_KEY_PEM 时），
 * 而客户端已按 kid 做内存缓存与请求去重，这里再叠一层 HTTP 缓存只会让换钥后
 * 客户端长时间抱着旧 kid 反复失败。响应体积很小，不值得缓存。
 */
app.get('/api/crypto/key', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.json(publicKeyInfo())
  } catch (err) {
    fail(res, err)
  }
})

/* auth */

/**
 * 图形验证码签发。做了简单的 IP 限流（60 秒内最多 30 次），
 * 防止被反复调用撑爆 captchas 表。
 */
const captchaLimit = makeSlidingWindowLimiter(60_000, 30)

app.get('/api/auth/captcha', (req, res) => {
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!captchaLimit.hit(ip)) throw new HttpError(429, '获取验证码过于频繁，请稍后再试')
    const c = createCaptcha()
    res.set('Cache-Control', 'no-store')
    res.json({ id: c.id, svg: c.svg, expiresAt: c.expiresAt })
  } catch (err) {
    fail(res, err)
  }
})

/* 登录限流：两道闸门，各自解决不同的问题。
   ① per-IP 30 次/分钟 —— 粗粒度的 DoS 闸门。阈值刻意放宽：校园网出口常常多用户共用一个
      公网 IP（NAT），按 IP 卡太紧会把正常同学误伤——这类"误伤全体"的坑本项目已经踩过一次
      （见 trust proxy 一节），所以这里只把它当兜底，不做主力防护。
   ② per-(IP + 账号) 5 次失败/5 分钟 —— 主力防撞库。**只在密码错误时计数**，登录成功即清零，
      因此正常用户频繁登录（甚至换设备反复登）不会受到影响。

      ⚠️ key 里必须带 IP，不能只用账号名。只按账号名计数时，任何人发 5 次错密码
      就能把**别人的账号**锁 5 分钟（实测：受害者用正确密码也返回 429），
      管理员账号可以被一个循环永久锁死 —— 限流本身变成了免费的 DoS 按钮。
      加上 IP 维度后，攻击者只能锁住「他自己这个 IP + 该账号」的组合，锁不到别人。
      代价是分布式撞库时每个 IP 各有 5 次额度，但那正是 ① 与全局闸门要兜的场景；
      两害相权，可被外部触发的账号锁定是更严重的问题。
      （前提：req.ip 必须可信，见 trust proxy 一节 —— 否则攻击者轮换 XFF 即可绕过本闸门。） */
const loginIpLimit = makeSlidingWindowLimiter(60_000, 30)
const loginFailLimit = makeSlidingWindowLimiter(5 * 60_000, 5)

/* 注册限流：注册是**唯一**能凭空创建账号的入口，而它此前没有任何闸门 ——
   只剩"图形验证码"这一道，而验证码的答案曾经以明文写在 SVG 的 <text> 里（见 captcha.ts）。
   验证码修好之后仍然需要限流：任何人都可以写脚本试 4 位码。

   三道闸门，各自负责一件事：
   ① per-IP 60 次/小时 —— 单机脚本刷号的硬闸门；
   ② 全局 200 次/小时 —— 分布式刷号时的总闸门（**只统计成功的注册**，
      否则攻击者用 200 次失败请求就能把全站注册锁一小时，那是给自己造 DoS）；
   ③ 验证码失败 20 次/10 分钟/IP —— 防止对着一个验证码反复试。

   ⚠️ 为什么 per-IP 是 60 而不是 10：校园网整栋楼共用一个公网出口 IP（NAT），
   开学季一个班三十几个人在同一小时内注册是完全正常的。阈值定得太紧，
   被挡住的是"同一栋楼的正常同学"，而攻击者换个出口就绕过了 —— 这种限流只会误伤。
   真正的兜底是 ② 的全局额度与 ③ 的验证码失败计数。
   （这条推理与密码重置接口的注释同源：那里也刻意放宽了 per-IP。） */
const registerIpLimit = makeSlidingWindowLimiter(3600_000, 60)
const registerGlobalLimit = makeSlidingWindowLimiter(3600_000, 200)
const REGISTER_GLOBAL_KEY = 'register:global'
const captchaFailLimit = makeSlidingWindowLimiter(10 * 60_000, 20)

const THEMES: ThemeMode[] = ['light', 'dark', 'system']
/** data URL 形式的头像，字符长度上限（约 300KB 二进制） */
const AVATAR_MAX_CHARS = 400 * 1024

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!registerIpLimit.hit(ip)) throw new HttpError(429, '注册过于频繁，请稍后再试')
    if (registerGlobalLimit.isBlocked(REGISTER_GLOBAL_KEY)) {
      throw new HttpError(429, '当前注册人数较多，请稍后再试')
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    /* 凭据三件套（账号/密码/确认密码）优先从加密信封里取；昵称与验证码不是机密，照常明文 */
    const secret = credentialEnvelope(body)
    const username = readCredField(body, secret, 'username').trim()
    const password = readCredField(body, secret, 'password')
    const confirmPassword = readCredField(body, secret, 'confirmPassword')
    const nickname = String(body.nickname ?? '').trim()
    const captchaId = String(body.captchaId ?? '')
    const captchaCode = String(body.captchaCode ?? '').trim()

    if (nickname.length < 1 || nickname.length > 16) throw new HttpError(400, '昵称需 1-16 个字符')
    if (/[\p{C}]/u.test(nickname)) throw new HttpError(400, '昵称不能包含控制字符')
    if (username.length < 3) throw new HttpError(400, '账号需至少 3 个字符（可用邮箱或学号）')
    /* 密码强度走唯一出口（passwordPolicy.ts）：长度 + 弱口令黑名单 + 不得含账号。
       三处调用点（注册 / 后台建号 / 后台重置）必须都走它，避免策略漂移。 */
    const weak = checkPasswordStrength(password, { username })
    if (weak) throw new HttpError(400, weak)
    if (confirmPassword !== password) throw new HttpError(400, '两次输入的密码不一致')
    // 验证码：生产环境强制；非生产环境仅当显式设置 DISABLE_CAPTCHA=1 时跳过（供本地冒烟测试使用）
    const skipCaptcha = process.env.NODE_ENV !== 'production' && process.env.DISABLE_CAPTCHA === '1'
    if (!skipCaptcha) {
      if (!captchaId || !captchaCode) throw new HttpError(400, '请填写验证码')
      /* 失败计数要在**校验之前**判：否则攻击者可以先试 1000 次再看自己有没有被限。
         注意 verifyCaptcha 内部无论对错都会把该验证码标记为已用（一次性），
         所以这里统计的是"换验证码重试"的次数 —— 那正是脚本的行为特征。 */
      if (captchaFailLimit.isBlocked(ip)) throw new HttpError(429, '验证码错误次数过多，请 10 分钟后再试')
      if (!verifyCaptcha(captchaId, captchaCode)) {
        captchaFailLimit.hit(ip)
        throw new HttpError(400, '验证码错误或已失效，请点击图片刷新')
      }
    }

    /* 查重必须用 usernameTaken（**包含游客**）：getUserByUsername 会排除游客，
       万一有人注册到某个游客的随机账号名就会放行，随后撞 username UNIQUE 约束变成 500。 */
    if (usernameTaken(username)) throw new HttpError(409, '该账号已存在')
    /* countUsers() 已排除游客 —— 游客不算"首个用户"，第一个**真实注册**的才是管理员 */
    const first = countUsers() === 0
    const role: UserRole = first ? 'admin' : 'user'
    const user = await createUser(username, password, role, nickname)
    /* 全局额度**只在成功建号后**计数：这样攻击者的失败请求烧不掉全站的注册额度
       （否则 200 次带错验证码的请求就能把注册锁一小时）。 */
    registerGlobalLimit.hit(REGISTER_GLOBAL_KEY)
    /* 注册也是明确的活跃信号（否则刚注册的账号在管理员后台显示"从未活跃"） */
    try { touchLastSeen(user.id, true) } catch { /* 忽略 */ }
    const token = createSession(user.id)
    res.status(201).json({ token, user: publicUser(user) })
  } catch (err) {
    fail(res, err)
  }
}))

/**
 * 登录计时等长用的假散列。
 *
 * 格式与真实 `salt:hash` 完全一致（16 字节盐的 hex + 32 字节散列的 hex），
 * 这样 verifyPassword 走的是**同一条代码路径**：同样的 scrypt 参数、同样的 timingSafeEqual。
 * 值本身无关紧要 —— 没人知道明文，任何一个密码都算不出这个散列，所以永远返回 false。
 *
 * 为什么是模块级常量而不是每次现算：现算要额外一次 scrypt，反而让"账号不存在"更慢。
 */
const TIMING_EQUALIZER_HASH =
  '00000000000000000000000000000000:' + '0'.repeat(64)

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const secret = credentialEnvelope(body)
    const username = readCredField(body, secret, 'username').trim()
    const password = readCredField(body, secret, 'password')
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!loginIpLimit.hit(ip)) throw new HttpError(429, '尝试过于频繁，请稍后再试')

    const failKey = `${ip}|${username.toLowerCase()}`
    if (loginFailLimit.isBlocked(failKey)) {
      throw new HttpError(429, '连续登录失败次数过多，请 5 分钟后再试')
    }

    const u = getUserByUsername(username)
    /* ⚠️ "账号不存在"也必须跑一次同样代价的 scrypt，且**只跑一次**就等于失败。
       此前写的是 `if (!u || !(await verifyPassword(...)))` —— 短路求值让账号不存在时
       **完全不做散列**，于是响应时间直接把"这个学号注册过没有"泄露出去
       （scrypt 默认参数约 30~100ms，网络抖动只有几 ms，用几十次采样就能稳定区分）。
       本项目账号就是学号，等于把学生名单做成了可枚举的 oracle ——
       文案层面刻意做的那层"账号或密码错误"同一文案就白做了。
       这里始终执行一次 verifyPassword：账号不存在时拿一个固定假散列去比，
       结果必然是 false，但耗时与真实账号一致。 */
    const storedHash = u?.passwordHash ?? TIMING_EQUALIZER_HASH
    const passwordOk = await verifyPassword(password, storedHash)
    if (!u || !passwordOk) {
      loginFailLimit.hit(failKey)
      throw new HttpError(401, '账号或密码错误')
    }
    /* 登录成功清零失败计数，避免用户改对了密码却仍被自己之前的失败次数挡住 */
    loginFailLimit.reset(failKey)

    /* 登录是明确的活跃信号：force 立即落库，不受 60s 节流影响，
       否则刚登录的用户在管理员后台会短暂显示成"从未活跃"。 */
    try { touchLastSeen(u.id, true) } catch { /* 忽略 */ }

    const token = createSession(u.id)
    res.json({ token, user: publicUser(u) })
  } catch (err) {
    fail(res, err)
  }
}))

app.post('/api/auth/logout', (req, res) => {
  const token = getToken(req)
  if (token) deleteSession(token)
  res.json({ ok: true })
})

/* ---------------- 忘记密码：申请重置 ---------------- */

/**
 * 申请限流。
 *
 * ⚠️ 阈值刻意放宽：校园网整栋楼共用一个公网出口 IP，如果按"每人"的直觉去设 per-IP 额度
 * （比如 5 次/半小时），那么同一时刻只要有 6 个同学来重置密码，第 6 个就会被挡住 ——
 * 而这条通道服务的是**本来就登不上去的人**，挡掉他们等于把人锁死。
 * 滥用这一接口能造成的最大危害只是"给管理员塞几条待审记录"（批不批由管理员核实身份后决定），
 * 所以真正的兜底放在全局额度上，per-IP 只防止单机刷屏。
 */
const resetReqIpLimit = makeSlidingWindowLimiter(30 * 60_000, 30)
/** 全局兜底：即便被分布式刷，也不会把待审队列冲垮 */
const resetReqGlobalLimit = makeSlidingWindowLimiter(3600_000, 500)

/**
 * 提交密码重置申请（**匿名** —— 用户正是因为登不上去才来这里的）。
 *
 * 设计取舍（为什么不做"邮件自助重置"）：
 *   · 线上 SMTP 未配置，邮件根本发不出去；
 *   · 且本校学生账号是走教务登录自动建的，本地密码是一串随机数，
 *     他们的问题不是"忘了密码"，而是"从来没有过密码"。
 *   所以走「用户自选新密码 → 管理员核实身份后批准」，全程没有密码经过管理员。
 *
 * 三条刻意的约定：
 *   1. **账号不存在也返回成功**：否则这个匿名接口就成了账号枚举器
 *      （本项目的账号是学号，枚举出来就是一份学生名单）。
 *   2. **游客账号不受理**：游客本来就是匿名的，无法核实身份，也没有重置的意义。
 *   3. 新密码强度走唯一的 checkPasswordStrength 出口，与注册/后台重置保持一致。
 */
app.post('/api/auth/password-reset', asyncRoute(async (req, res) => {
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()

    const body = (req.body ?? {}) as Record<string, unknown>
    const username = String(body.username ?? '').trim()
    const newPassword = String(body.newPassword ?? '')
    const contact = String(body.contact ?? '').trim().slice(0, 60)
    const note = String(body.note ?? '').trim().slice(0, 200)

    /* ⚠️ 顺序是安全属性，不要"优化"回旧写法。
       这里曾经是「先 hit 两个限流桶 → 再校验 body」。而全局桶（500/h）**从不清零**，
       于是一个匿名攻击者每秒扔一条 `{}`（body 校验必然失败）就能把全局桶打满：
       一小时内**所有真实用户**提交重置都会收到「当前提交人数较多」。
       而重置是这个站点唯一的找回密码通道（账号是教务自动建的、本地密码是随机数），
       封掉它等于把被锁的人彻底锁死。
       现在：先做零成本的字段校验（不占桶），通过后才记账。 */
    if (username.length < 3) throw new HttpError(400, '请填写学号或邮箱')
    /* 联系方式是核实身份的唯一途径，必须留 */
    if (contact.length < 2) throw new HttpError(400, '请留下联系方式（QQ / 微信 / 手机号），管理员需要向你核实身份')

    if (!resetReqIpLimit.hit(ip)) throw new HttpError(429, '提交过于频繁，请稍后再试')
    if (!resetReqGlobalLimit.hit('global')) throw new HttpError(429, '当前提交人数较多，请稍后再试')

    const u = getUserByUsername(username)
    if (u) {
      /* 密码强度校验只对"真实存在的账号"做：对不存在的账号也校验的话，
         攻击者能靠错误文案的差异反推账号是否存在。 */
      const weak = checkPasswordStrength(newPassword, { username })
      if (weak) throw new HttpError(400, weak)
      createPasswordReset(u.id, await hashPassword(newPassword), contact, note)
    } else {
      /* 账号不存在：同样走一遍密码强度校验，耗时与成功路径接近，避免计时侧信道；
         然后照样返回成功文案。 */
      checkPasswordStrength(newPassword, { username })
    }

    res.json({
      ok: true,
      message: '申请已提交。管理员核实身份后会批准，届时用你刚才设置的新密码登录即可。'
    })
  } catch (err) {
    fail(res, err)
  }
}))

/* 管理员侧：查看 / 批准 / 驳回 */
app.get('/api/admin/password-resets', authenticate, requireAdmin, (_req, res) => {
  try {
    res.json({ requests: listPendingPasswordResets(), pending: countPendingPasswordResets() })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/admin/password-resets/:id/approve', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    const target = getPasswordReset(id)
    if (!target) throw new HttpError(404, '申请不存在')
    /* 幂等保护在 approvePasswordReset 内部（以 status='pending' 为更新条件），
       并发重复点击只有一次会生效。 */
    const ok = approvePasswordReset(id, (req as AuthedRequest).user!.id)
    if (!ok) throw new HttpError(409, '这条申请已经被处理过了')
    res.json({ ok: true, username: target.username })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/admin/password-resets/:id/reject', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    const ok = rejectPasswordReset(id, (req as AuthedRequest).user!.id)
    if (!ok) throw new HttpError(409, '这条申请已经被处理过了')
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/* ---------------- 一次性游客账号（未登录体验） ----------------

   完整设计见 db.ts 的 createGuestUser / claimGuestData / purgeStaleGuests 注释。
   接口层有三条刻意约定：
     1. **建号不要验证码**：未登录体验的全部意义就是零摩擦；防滥用靠 per-IP 限流 + TTL 回收。
     2. **建号必须幂等**：已带有效游客 token 的请求直接回原 token。否则每次刷新页面都新建一个
        账号 —— 数据库里账号数×N 还是小事，用户"刷新一下课表就没了"才是致命的。
     3. **claim 的游客 token 走 `X-Guest-Token` 头**，不复用 Authorization：登录之后
        Authorization 已经是新账号的 token，两个身份必须能同时出现在一个请求里。
*/

/** 游客建号限流：per-IP 20 次/小时 + 全局 3000 次/天。
    校园网 NAT 下同一出口 IP 有很多人，per-IP 阈值刻意放宽；真正的兜底是 TTL 回收。 */
const guestIpLimit = makeSlidingWindowLimiter(3600_000, 20)
const guestGlobalLimit = makeSlidingWindowLimiter(24 * 3600_000, 3000)

app.post('/api/auth/guest', (req, res) => {
  try {
    /* 幂等分支：已持有效游客会话 → 原样返回，不重复建号 */
    const existing = getToken(req)
    if (existing) {
      const guestId = getGuestIdByToken(existing)
      if (guestId) {
        const u = findUser(guestId)
        if (u) {
          res.json({ token: existing, user: publicUser(u) })
          return
        }
      }
    }

    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!guestIpLimit.hit(ip)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    if (!guestGlobalLimit.hit('global')) throw new HttpError(429, '当前访问人数较多，请稍后再试')

    const user = createGuestUser()
    res.status(201).json({ token: createSession(user.id), user: publicUser(user) })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 登录后探测：游客侧有没有值得迁移的数据、目标账号侧又有多少。
 *
 * 前端据 `hasGuest` 与两侧数量决定：静默整体接管（目标为空）还是
 * 弹「合并 / 覆盖 / 不用了」（双方都有数据）。
 */
app.get('/api/auth/guest/pending', authenticate, requireRealUser, (req, res) => {
  try {
    const guestId = getGuestIdByToken(String(req.get('X-Guest-Token') ?? ''))
    if (!guestId) {
      res.json({ ok: true, hasGuest: false })
      return
    }
    const guest = countUserData(guestId)
    res.json({ ok: true, hasGuest: hasGuestData(guest), guest, target: countUserData(uid(req)) })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 把游客数据迁移到当前登录账号，成功后游客账号被删除。
 *
 * 游客 token 是**唯一的所有权证明** —— 它只存在于发起这次登录的那个浏览器的
 * localStorage 里（32 字节随机），所以"迁移谁的"这件事不需要额外的校验。
 * 迁移完成后该 token 随游客账号一起失效，重复调用会拿到 409（可安全重试）。
 */
app.post('/api/auth/guest/claim', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const guestToken = String(body.guestToken ?? req.get('X-Guest-Token') ?? '')
    const mode = String(body.mode ?? 'merge') as ClaimMode
    if (mode !== 'merge' && mode !== 'replace' && mode !== 'discard') {
      throw new HttpError(400, 'mode 需为 merge / replace / discard')
    }
    const guestId = getGuestIdByToken(guestToken)
    if (!guestId) throw new HttpError(409, '未找到可迁移的游客数据（可能已迁移或已过期）')
    res.json({ ok: true, ...claimGuestData(guestId, uid(req), mode) })
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/auth/me', authenticate, (req, res) => {
  /* 单个用户行（含 avatar）从库里取一次：authenticate() 为了省带宽与内存
     已经不再取 avatar 列（它跑在每个请求上），而 /me 是前端启动时"我要我的完整资料"的
     唯一入口，必须给全。找不到用户说明会话与用户行不一致（账号刚被删），按 401 处理。 */
  const full = findUser(uid(req))
  if (!full) throw new HttpError(401, '登录已失效，请重新登录')
  res.json({ user: publicUser(full) })
})

/**
 * 标记新用户引导已看过。
 * 放在服务端而不是 localStorage：换手机 / 清缓存后不会再弹一次，
 * 同时老用户（注册早于该功能）也只会被打扰一次。
 */
app.post('/api/auth/onboarded', authenticate, (req, res) => {
  try {
    markOnboarded(uid(req))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/* 个人资料：昵称 / 头像 / 主题，一次可更新任意子集 */
app.put('/api/auth/profile', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: { nickname?: string; avatar?: string | null; theme?: ThemeMode; accent?: string | null } = {}

    if ('nickname' in body) {
      const n = String(body.nickname ?? '').trim()
      if (n.length < 1 || n.length > 16) throw new HttpError(400, '昵称需 1-16 个字符')
      if (/[\p{C}]/u.test(n)) throw new HttpError(400, '昵称不能包含控制字符')
      patch.nickname = n
    }
    if ('avatar' in body) {
      const raw = body.avatar
      if (raw === null || raw === '') {
        patch.avatar = null
      } else {
        const a = String(raw).trim()
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) {
          throw new HttpError(400, '头像格式不支持，仅接受 png / jpeg / webp')
        }
        if (a.length > AVATAR_MAX_CHARS) throw new HttpError(413, '头像过大，请压缩后再上传')
        /* 与 /api/feedback/upload 同口径校验真实字节（M-1）。
           头像虽是 data URL 存在库里、不是落盘文件，但"声明 png 实为 SVG"的风险同源：
           将来任何一处把它当文件导出/转存，伪装内容就会跟着走出去。
           只校验**本次提交**的值，库里的存量头像不受影响，因此无迁移风险。 */
        const b64 = a.slice(a.indexOf(',') + 1)
        const declaredMime = /^data:(image\/[a-z]+);base64,/.exec(a)![1]
        const avatarIssue = checkImageConsistency(declaredMime, Buffer.from(b64, 'base64'))
        if (avatarIssue) throw new HttpError(400, `头像${avatarIssue}`)
        patch.avatar = a
      }
    }
    if ('theme' in body) {
      const t = String(body.theme) as ThemeMode
      if (!THEMES.includes(t)) throw new HttpError(400, '主题需为 light / dark / system')
      patch.theme = t
    }
    if ('accent' in body) {
      const raw = body.accent
      if (raw === null || raw === '') {
        patch.accent = null
      } else {
        const a = String(raw).trim()
        if (!/^(?:[0-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9])$/.test(a) || Number(a) > 359) {
          throw new HttpError(400, '主题色需为 0-359 的色相数值')
        }
        patch.accent = a
      }
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可更新的字段')

    res.json({ user: updateProfile(userId, patch) })
  } catch (err) {
    fail(res, err)
  }
})

/* settings */
app.get('/api/settings', authenticate, (req, res) => {
  res.json(getSettings(uid(req)))
})

/**
 * 校验并归一化学期周次表（智慧课程平台课表导入时写入，见 misFetchBksyTimetable）。
 *
 * 传 `null` 是**有意义的**：表示「这个学期没有周次表，按线性口径解释周次」。
 * 教务（AA）导入走的就是这条 —— 它给不出周次表，若沿用上一次智慧平台留下的表，
 * 换学期后就可能拿旧表去解释新课表，周次会整体错位。宁可退回线性（旧行为）也不能错配。
 */
function parseSemesterWeeks(raw: unknown): SemesterWeek[] | null {
  if (raw === null) return null
  if (!Array.isArray(raw)) throw new HttpError(400, 'weeks 需为数组或 null')
  if (raw.length > 80) throw new HttpError(400, '周次表过长（最多 80 项）')
  const out: SemesterWeek[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new HttpError(400, '周次项格式非法')
    const o = item as Record<string, unknown>
    const week = Number(o.week)
    const beginDate = String(o.beginDate ?? '')
    const endDate = String(o.endDate ?? '')
    if (!Number.isInteger(week) || week < 0 || week > 80) throw new HttpError(400, '周次号需为 0-80 的整数')
    if (!isValidISODate(beginDate) || !isValidISODate(endDate)) throw new HttpError(400, '周次起止日期需为合法日期')
    if (endDate < beginDate) throw new HttpError(400, '周次的结束日不能早于起始日')
    out.push({ week, beginDate, endDate, hasClass: Boolean(o.hasClass) })
  }
  return out.sort((a, b) => a.week - b.week)
}

/**
 * 更新设置。
 *
 * 多学期改造后这里的语义变成：改的是**当前学期**的信息。
 * 因此不再手工拼 `next` 对象，而是走 terms.ts 的 updateTerm ——
 * 它会把改动同步进 terms 数组里对应那一项（**id 不变**），并刷新 semester 镜像。
 * id 必须保持稳定：课程通过 term id 归属学期，id 一变课程就成孤儿了。
 */
app.put('/api/settings', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const body = req.body ?? {}
    let next = getSettings(userId)
    if ('semester' in body) {
      const s = body.semester as Record<string, unknown>
      const name = 'name' in s ? String(s.name ?? '').trim() : next.semester.name
      const startDate = 'startDate' in s ? String(s.startDate ?? '') : next.semester.startDate
      const totalWeeks = 'totalWeeks' in s ? Number(s.totalWeeks) : next.semester.totalWeeks
      if (!name) throw new HttpError(400, '学期名称不能为空')
      if (!isValidISODate(startDate)) throw new HttpError(400, '开学日期需为合法日期')
      if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 60)
        throw new HttpError(400, '总周数需为 1-60')
      const patch: Partial<Omit<Term, 'id'>> = { name, startDate, totalWeeks }
      /* 只在显式带了 weeks 时才动周次表：手工改开学日不该把导入来的周次表抹掉 */
      if ('weeks' in s) patch.weeks = parseSemesterWeeks(s.weeks)
      next = updateTerm(next, next.currentTermId!, patch)
    }
    if ('periods' in body) {
      next = { ...next, periods: validatePeriods(body.periods) }
    }
    setSettings(userId, next)
    res.json(getSettings(userId))
  } catch (err) {
    fail(res, err)
  }
})

/* ---------------- 学期（多学期支持） ----------------

   为什么需要这些接口：单学期模型下，课程存的是「第 N 周」这种相对周号，
   下学期改开学日会让**全部历史课程**的周次显示整体偏移。引入 Term 后，
   课程归属到具体学期，切换学期不再影响其它学期。

   所有写操作都通过 terms.ts 的纯函数完成，保证 terms 与 semester 镜像一致。 */

/** 校验并归一化学期入参（新建与修改共用） */
function parseTermInput(
  raw: Record<string, unknown>,
  base?: { name: string; startDate: string; totalWeeks: number }
): { name: string; startDate: string; totalWeeks: number } {
  const name = ('name' in raw ? String(raw.name ?? '') : base?.name ?? '').trim()
  const startDate = 'startDate' in raw ? String(raw.startDate ?? '') : (base?.startDate ?? '')
  const totalWeeks = 'totalWeeks' in raw ? Number(raw.totalWeeks) : (base?.totalWeeks ?? 0)
  if (!name) throw new HttpError(400, '学期名称不能为空')
  if (name.length > 40) throw new HttpError(400, '学期名称过长（最多 40 字）')
  if (!isValidISODate(startDate)) throw new HttpError(400, '开学日期需为合法日期')
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 60) throw new HttpError(400, '总周数需为 1-60')
  return { name, startDate, totalWeeks }
}

/** 统计每个学期的课程数（term 为 NULL 的存量课程计入当前学期） */
function termCourseCounts(userId: number, currentTermId: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT term, COUNT(*) AS c FROM courses WHERE user_id = ? GROUP BY term`)
    .all(userId) as { term: string | null; c: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.term ?? currentTermId] = (out[r.term ?? currentTermId] ?? 0) + r.c
  return out
}

function termListPayload(userId: number): { terms: (Term & { courseCount: number })[]; currentTermId: string } {
  const s = getSettings(userId)
  const counts = termCourseCounts(userId, s.currentTermId!)
  return {
    terms: (s.terms ?? []).map((t) => ({ ...t, courseCount: counts[t.id] ?? 0 })),
    currentTermId: s.currentTermId!
  }
}

app.get('/api/terms', authenticate, (req, res) => {
  try {
    res.json(termListPayload(uid(req)))
  } catch (err) {
    fail(res, err)
  }
})

/** 新建学期。默认同时切换过去（setCurrent 默认 true）—— 建新学期通常就是为了开始用它 */
app.post('/api/terms', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const input = parseTermInput(body)
    const makeCurrent = body.setCurrent !== false
    const { settings: next, term } = addTerm(getSettings(userId), { ...input, makeCurrent })
    setSettings(userId, next)
    /* 响应直接回「写后重读」的列表（含 currentTermId 与各学期课程数），避免前端自己算 */
    res.status(201).json({ term, ...termListPayload(userId) })
  } catch (err) {
    fail(res, err)
  }
})

/** 修改某个学期（含非当前学期）。id 不变，因此课程归属不受影响 */
app.put('/api/terms/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const id = String(req.params.id)
    const s = getSettings(userId)
    const target = (s.terms ?? []).find((t) => t.id === id)
    if (!target) throw new HttpError(404, '学期不存在')
    const input = parseTermInput((req.body ?? {}) as Record<string, unknown>, target)
    setSettings(userId, updateTerm(s, id, input))
    res.json(termListPayload(userId))
  } catch (err) {
    fail(res, err)
  }
})

/** 切换当前学期（不动数据，只改「看哪个学期」） */
app.put('/api/terms/:id/current', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const id = String(req.params.id)
    const s = getSettings(userId)
    /* 先做存在性校验再切换：switchTerm 内部抛的是普通 Error，会被兜底成 500。
       「学期不存在」是客户端的 404，不该报给用户「服务器内部错误」。 */
    if (!(s.terms ?? []).some((t) => t.id === id)) throw new HttpError(404, '学期不存在')
    setSettings(userId, switchTerm(s, id))
    res.json(termListPayload(userId))
  } catch (err) {
    fail(res, err)
  }
})

/* courses */
app.get('/api/courses', authenticate, (req, res) => {
  const userId = uid(req)
  /* 只返回当前学期的课，与页面所见一致；切换学期后这里随之变化 */
  res.json(listCourses(userId, getSettings(userId).currentTermId))
})

app.post('/api/courses', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const c = validateCourseBody(req.body ?? {}, false)
    /* 课程归属「当前学期」：这样切换学期后，旧学期的课不会被按新开学日重新解释 */
    const term = getSettings(userId).currentTermId ?? null
    const info = db
      .prepare(
        `INSERT INTO courses (user_id, name, teacher, location, day_of_week, week_start, week_end, week_type, weeks, start_period, end_period, color, credits, term, grading_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, c.name!, c.teacher ?? '', c.location ?? '', c.dayOfWeek!, c.weekStart!, c.weekEnd!, c.weekType ?? 'all',
        c.weeks ? JSON.stringify(c.weeks) : null,
        c.startPeriod!, c.endPeriod!, c.color ?? COURSE_COLORS[0], c.credits ?? null, term,
        c.gradingPolicy ?? '')
    res.status(201).json(getCourse(userId, Number(info.lastInsertRowid)))
  } catch (err) {
    fail(res, err)
  }
})

app.put('/api/courses/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const id = intParam(req.params.id)
    if (!getCourse(userId, id)) throw new HttpError(404, '课程不存在')
    const c = validateCourseBody(req.body ?? {}, true)
    const sets: string[] = []
    const params: SQLInputValue[] = []
    const map: Record<string, string> = {
      name: 'name', teacher: 'teacher', location: 'location', dayOfWeek: 'day_of_week',
      weekStart: 'week_start', weekEnd: 'week_end', weekType: 'week_type',
      startPeriod: 'start_period', endPeriod: 'end_period', color: 'color', credits: 'credits',
      gradingPolicy: 'grading_policy'
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in c) {
        sets.push(`${col} = ?`)
        params.push(c[k as keyof Course] as string | number | null)
      }
    }
    // weeks 是数组，不能走上面的通用映射，需序列化为 JSON 文本
    if ('weeks' in c) {
      sets.push('weeks = ?')
      params.push(c.weeks ? JSON.stringify(c.weeks) : null)
    }
    if (sets.length === 0) throw new HttpError(400, '没有可更新的字段')
    params.push(id, userId)
    db.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params)
    res.json(getCourse(userId, id))
  } catch (err) {
    fail(res, err)
  }
})

app.delete('/api/courses/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    db.prepare('DELETE FROM courses WHERE id = ? AND user_id = ?').run(intParam(req.params.id), userId)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 拍照导入专用：整表替换课程。
 *
 * 需求：拍照导入后只保留本次识别结果，清除该用户原有全部课程。
 * 放在一个事务里「先删后插」——任何一步失败整体回滚，
 * 不会出现"旧课删光了、新课没写进去"这种最坏情况。
 */
app.post('/api/courses/import-replace', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as { courses?: unknown; officialCredits?: unknown }
    if (!Array.isArray(body.courses)) throw new HttpError(400, 'courses 需为数组')
    if (body.courses.length === 0) throw new HttpError(400, '没有要导入的课程')
    if (body.courses.length > 100) throw new HttpError(400, '一次最多导入 100 门课程')

    // 可选：教务导入带来的官方总学分（非拍照/手动导入场景不要传）。合法范围 0-300。
    let officialCredits: number | null | undefined
    if (body.officialCredits !== undefined && body.officialCredits !== null) {
      const oc = Number(body.officialCredits)
      if (!Number.isFinite(oc) || oc < 0 || oc > 300) {
        throw new HttpError(400, 'officialCredits 需为 0-300 的数值')
      }
      officialCredits = oc
    }

    const parsed = body.courses.map((item, i) => {
      if (typeof item !== 'object' || item === null) throw new HttpError(400, `第 ${i + 1} 门课程数据非法`)
      try {
        return validateCourseBody(item as Record<string, unknown>, false)
      } catch (err) {
        const msg = err instanceof HttpError ? err.message : '字段非法'
        throw new HttpError(400, `第 ${i + 1} 门课程：${msg}`)
      }
    })

    /* 整表替换只影响「当前学期」：不删其它学期的课程。
       这也让用户可以先切到新学期再导入，历史课表原样保留。 */
    const term = getSettings(userId).currentTermId ?? null

    /* 整表替换会 DELETE + INSERT，课程 id 全变 —— 而「成绩占比」是用户**手工填的**，
       教务系统不会提供。若不做保留，用户每次重新导入课表都会静默丢掉自己写的备注。
       这里先按自然键（课名 + 星期 + 起止节次 + 精确周集合）把旧值抓下来，插入时再贴回去。
       键的构成与 db.ts 中 claimGuestData 的 courseKey 保持一致口径。 */
    const prevAnnotations = new Map<string, string>()
    for (const row of db
      .prepare(
        `SELECT name, day_of_week, start_period, end_period, weeks,
                COALESCE(grading_policy, '') AS grading_policy
         FROM courses WHERE user_id = ? AND (term = ? OR term IS NULL)`
      )
      .all(userId, term) as {
      name: string
      day_of_week: number
      start_period: number
      end_period: number
      weeks: string | null
      grading_policy: string
    }[]) {
      if (!row.grading_policy) continue
      const key = `${row.name}|${row.day_of_week}|${row.start_period}|${row.end_period}|${row.weeks ?? ''}`
      prevAnnotations.set(key, row.grading_policy)
    }

    const insert = db.prepare(
      `INSERT INTO courses (user_id, name, teacher, location, day_of_week, week_start, week_end, week_type, weeks, start_period, end_period, color, credits, term, grading_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /* ⚠️ res.json() 必须留在 try/catch **之外**。
       此前 COMMIT 与 res.json() 在同一个 try 里：只要 res.json 抛错（客户端已经断开、
       或响应序列化失败），catch 就会对一个**已提交**的事务执行 ROLLBACK ——
       SQLite 会回 500 级错误并让连接停在"无事务"状态，随后的写入全部失败。
       事务边界与 HTTP 边界要分开：提交之后就只剩"发响应"，发不出去也不该回滚。 */
    db.exec('BEGIN IMMEDIATE')
    let deleted = 0
    try {
      deleted = Number(
        db.prepare(`DELETE FROM courses WHERE user_id = ? AND (term = ? OR term IS NULL)`).run(userId, term).changes ?? 0
      )
      for (const c of parsed) {
        const weeksJson = c.weeks ? JSON.stringify(c.weeks) : null
        // 同一门课：把用户之前手写的成绩占比带回来
        const kept = prevAnnotations.get(
          `${c.name}|${c.dayOfWeek}|${c.startPeriod}|${c.endPeriod}|${weeksJson ?? ''}`
        )
        insert.run(
          userId, c.name!, c.teacher ?? '', c.location ?? '', c.dayOfWeek!, c.weekStart!, c.weekEnd!,
          c.weekType ?? 'all', weeksJson, c.startPeriod!, c.endPeriod!,
          c.color ?? COURSE_COLORS[0], c.credits ?? null, term,
          kept ?? ''
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      /* ROLLBACK 自己也可能失败（事务已被 SQLite 自动回滚），不能让它盖掉原始错误 */
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 已经不在事务里了，忽略 */
      }
      throw err
    }
    // 官方总学分写入「当前学期」（保留其他字段与其它学期的记录），供课表页学分卡作为权威总学分展示
    if (officialCredits !== undefined) {
      setSettings(userId, setCurrentOfficialCredits(getSettings(userId), officialCredits))
    }
    res.json({ ok: true, deleted, imported: parsed.length, courses: listCourses(userId, term) })
  } catch (err) {
    fail(res, err)
  }
})

/* 拍照识别课表：图片 → 视觉大模型 → 结构化课程（不入库，前端确认后才逐条建课） */

/** 简单限流：识别要调外部付费/限额服务，每人每小时最多 10 次（内存计数，重启清零） */
const OCR_WINDOW_MS = 60 * 60 * 1000
const OCR_LIMIT = 10
const ocrHits = new Map<number, number[]>()

app.get('/api/courses/recognize-photo/status', authenticate, requireRealUser, (_req, res) => {
  res.json({ configured: isVisionConfigured(), model: visionModelName() })
})

/**
 * 提交识别任务（异步）：HTTP 只做快速校验并立刻返回 jobId（几十毫秒），
 * GLM 视觉调用在后台执行，前端轮询 GET /recognize-photo/:jobId 拿结果。
 * 彻底绕开 nginx proxy_read_timeout（默认 60s）对长请求的 504 掐断。
 * 兼容说明：图片/限流校验仍在此处同步做，错误立即返回，不占后台任务。
 */
app.post('/api/courses/recognize-photo', authenticate, requireRealUser, (req, res) => {
  try {
    const userId = uid(req)
    if (!isVisionConfigured()) {
      throw new HttpError(503, '拍照识别功能未启用：服务器未配置 VISION_API_KEY，请联系管理员')
    }
    const now = Date.now()
    const hits = (ocrHits.get(userId) ?? []).filter((t) => now - t < OCR_WINDOW_MS)
    if (hits.length >= OCR_LIMIT) throw new HttpError(429, '识别次数已达上限（每小时 10 次），请稍后再试')
    hits.push(now)
    ocrHits.set(userId, hits)
    /* 与 misAllowed 同因：ocrHits 的键是**每个用过识别的用户 id**，只增不减。
       一次识别就走得到一个 id，长期运行必然攒满（见 rateLimit.ts 的 sweepCounterMap）。 */
    sweepCounterMap(ocrHits, OCR_WINDOW_MS, now)
    // 防止一个人瞬间堆多个识别任务：每个用户最多保留 3 个进行中/排队任务
    if (activeJobCount(userId) >= 3) throw new HttpError(429, '已有识别任务在进行中，请稍后再试')

    const image = String((req.body ?? {}).image ?? '')
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw new HttpError(400, '图片格式不支持，仅接受 png / jpeg / webp')
    }
    if (image.length > IMAGE_MAX_CHARS) throw new HttpError(413, '图片过大，请重新拍摄一张更聚焦课表的照片')

    const job = createRecognizeJob(userId)
    const s = getSettings(userId)
    const periods = s.periods
    const totalWeeks = s.semester.totalWeeks

    // 后台执行：不 await，避免占用本请求；异常写回 job，前端轮询可见
    runRecognition(job, image, periods, totalWeeks)

    res.status(202).json({ ok: true, jobId: job.id })
  } catch (err) {
    fail(res, err)
  }
})

/** 查询识别任务状态。返回轻量 JSON，快速轮询用。 */
app.get('/api/courses/recognize-photo/:jobId', authenticate, requireRealUser, (req, res) => {
  const userId = uid(req)
  const job = getRecognizeJob(String(req.params.jobId ?? ''), userId)
  if (!job) {
    res.status(404).json({ ok: false, error: '识别任务不存在或已过期，请重新提交' })
    return
  }
  const body: {
    ok: boolean
    jobId: string
    status: RecognizeJob['status']
    phase: string
    result?: unknown
    error?: string
  } = { ok: true, jobId: job.id, status: job.status, phase: job.phase }
  if (job.status === 'done' && job.result) body.result = job.result
  if (job.status === 'failed') {
    body.ok = false
    body.error = job.error
  }
  res.json(body)
})

/** 在后台跑完整识别；把进度/结果/错误写回 job。捕获一切异常，绝不 unhandled。 */
function runRecognition(job: RecognizeJob, image: string, periods: Period[], totalWeeks: number): void {
  // 让调用栈先返回（保证 POST 已响应），下一拍再真正开跑
  setImmediate(async () => {
    try {
      markRecognizeRunning(job, '正在初始化识别…')
      const result = await recognizeSchedule(image, { periods, totalWeeks }, (phase) => updateRecognizePhase(job, phase))
      markRecognizeDone(job, { courses: result.courses as unknown[], errors: result.errors as unknown[], model: result.model })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '识别服务异常'
      markRecognizeFailed(job, err instanceof VisionError ? msg : msg)
    }
  })
}

/* ==================== MIS 一键导入课表 ====================
 * 用户直接登录学校 MIS 系统（统一身份认证 SSO，2026-10 起无验证码，密码走 SM2），
 * 服务端代理拉取 AA 教务「我的课表」并解析成结构化课程。
 * 学号/密码仅在请求内瞬时使用，MIS 会话只存内存（15 分钟 TTL）。
 */

/**
 * 限流：MIS 登录是对学校门户的真实请求。窗口分两类（2026-10-21 调整）：
 *
 * ① **登录动作本身**：1 分钟 15 次（`MIS_LOGIN_WINDOW_MS` × `MIS_LIMIT`）。
 *    原先是 10 次/小时，正常用户重试几次就把自己锁一整小时，线上投诉集中在这里。
 *    按分钟计有两个好处：日常重试（手滑打错密码、SSO 会话失效重开）完全够用；
 *    而"锁 1 分钟"和"锁 1 小时"对误伤的体感差距是数量级的。
 *    真正防长时间占用学校门户配额的是下面 ② 的滑动小时窗，不受本调整影响。
 *
 * ② **会话额度**：1 小时滑动窗口（`MIS_WINDOW_MS`），匿名 60/小时/IP + 全局 400/小时。
 *    这是防"把服务器变成刷学校门户的肉鸡"的主力闸门，与 ① 互补。
 *
 * 计数键从 userId 改成字符串：因为「本校学生登录」必须在**未登录**状态下就能发起
 * （那时还没有本地账号，也就没有 userId）。登录用户按 `u{id}` 计，
 * 匿名请求按 `ip:{ip}` 计 —— 校园网出口是 NAT，同一 IP 有很多同学，
 * 所以匿名额度按 IP 算天然偏紧，但那正是我们想要的方向：匿名通道本来就该更保守。
 */
const MIS_WINDOW_MS = 60 * 60 * 1000
/** 登录动作的窗口（1 分钟）与额度：原先 10 次/小时 → 15 次/分钟 */
const MIS_LOGIN_WINDOW_MS = 60 * 1000
const MIS_LIMIT = 15
/**
 * 匿名（未登录）通道的额度。
 *
 * ⚠️ 这里踩过一次坑，写下来免得后人再调回去：最初设成 6 次/小时/IP，理由是"匿名通道
 * 该更严"。但**忘了算一次典型登录要花掉几次**——一次登录要开一次 SSO 会话，密码打错
 * 会让 mis.ts 销毁整个会话（必须重新开一个），也就是**每次重试 = 1 次额度**。
 * 手滑三下就见底；再加上校园网出口 NAT（成千上万同学共用一个公网 IP，见上方注释），
 * 6 次/小时等于"有人试错三次，全楼同学一起被挡 15 分钟"。
 *
 * 所以拆成两道互补的闸门：
 *   · per-IP 60/小时 —— 只当**滥用兜底**，刻意放宽以免误伤 NAT 后的正常用户；
 *   · 全局 400/小时 —— 真正的**主力防护**：无论攻击者换多少 IP，学校门户在单位时间内
 *     被我们代理的请求总量都有硬上限。这才是"别把服务器变成刷学校门户的肉鸡"要防的事。
 * 计数键共用一个 Map，见 misAllowed()。
 */
const MIS_ANON_LIMIT = 60
const MIS_ANON_GLOBAL_LIMIT = 400
/** 匿名额度的全局计数键（与 per-IP 的 `ip:{ip}` 键共用一个 Map） */
const MIS_ANON_GLOBAL_KEY = 'anon:global'
const misHits = new Map<string, number[]>()

/**
 * 按**学号**维度的失败计数闸门（2026-10-03 安全审计 P1 修复）。
 *
 * ── 先纠正一个很容易搞错的点 ──────────────────────────────────────
 * 本站账号密码登录有一道 `loginFailLimit`（5 次/5 分钟，per IP+账号），但它**只挂在
 * `/api/auth/login` 上**。学号登录走的是完全不同的匿名接口 `/api/auth/mis/login`，
 * 此前**没有任何按学号的闸门**——它的额度全靠第 1 步 `/api/auth/mis/session` 的
 * per-IP 60/小时 + 全局 400/小时。所以"攻击者烧掉 5 次额度把受害者锁住"这条路径
 * 并不存在（原审计报告把两个接口的限流混为一谈了，此处更正）。
 *
 * ── 那真正的风险是什么 ───────────────────────────────────────────
 * 两条，都比"锁死账号"更麻烦：
 *
 * ① **撞库**：攻击者遍历学号 + 弱口令组合打 `/api/auth/mis/login`。per-IP 60/小时
 *    看着宽，但**换个 IP 就重置**，而 IP 恰恰是攻击者最廉价的可变资源（代理池、
 *    校园网里被攻陷的机器）。全局 400/小时是唯一真正封顶的闸门。
 *
 * ② **凭据填充放大**：SSO 登录是本服务替用户向学校门户发的真实请求。若不按学号收口，
 *    一个学号就能被无限次尝试，而每次尝试都在消耗学校门户的容忍度——
 *    触发学校的风控/锁定，**受害者本人反而登录不了**。这才是真正的伤害。
 *
 * ── 为什么只在**失败**时计数 ──────────────────────────────────────
 * 与 `loginFailLimit` 同一套语义：成功即清零。SSO 会话一次性、手滑重试很常见
 * （密码输错），只在失败时计数才不会误伤正常用户。
 *
 * ── 为什么阈值定 15、窗口是 1 分钟（2026-10-21 调整） ─────────────────
 * 原先是 10 次/小时。问题出在窗口太长：SSO 失败会销毁整个会话（必须重新开一个），
 * 一次"手滑 + 会话失效"的连锁就能烧掉十几次额度，之后**整整一小时**登录不了 ——
 * 线上投诉基本都是这个。
 *
 * 改成 15 次/分钟：日常重试完全够用，被挡住也只需等 1 分钟，体感差一个数量级。
 * 安全性没有实质性削弱：防密码猜测从来不是靠"每小时几次"这种长窗口（那对
 * "低频慢速撞库"无效），真正的护栏是下面的 `misFanout` 广度闸门 + 匿名全局 400/小时。
 * 单号在 1 分钟内最多 15 次尝试，对学校门户的瞬时压力与原先 10 次/小时持平。
 */
const MIS_STUNO_WINDOW_MS = 60 * 1000
const MIS_STUNO_FAIL_LIMIT = 15
const misStuNoFailLimit = makeSlidingWindowLimiter(MIS_STUNO_WINDOW_MS, MIS_STUNO_FAIL_LIMIT)

function misAllowed(key: string, limit: number = MIS_LIMIT, windowMs: number = MIS_WINDOW_MS): boolean {
  const now = Date.now()
  const hits = (misHits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    misHits.set(key, hits)
    return false
  }
  hits.push(now)
  misHits.set(key, hits)
  /* ⚠️ 必须清扫：这是**手写**的 Map 限流器，键里带 IP（`ip:{ip}`）和游客 id，
     而它们**永不重复**。不清扫的话每个访问过的 IP 都会留下一个数组永久驻留内存——
     校园网 NAT 后面一天几万个出口、再加上扫描器的 IP，一个月就能攒出几十万条。
     与 ocrHits 同一处理：超过阈值时整体扫一遍，只删"窗口内已无记录"的键。
     这一步是 O(键数)，但只在 Map 超过阈值时才触发，摊到每次请求近乎零成本。 */
  sweepCounterMap(misHits, MIS_WINDOW_MS, now)
  return true
}

/** 已登录用户的限流键 */
function misKeyForUser(userId: number): string {
  return 'u' + userId
}

/** 未登录用户的限流键（按 IP） */
function misKeyForIp(req: Request): string {
  return 'ip:' + (req.ip || req.socket.remoteAddress || 'unknown').toString()
}

/**
 * 广度撞库闸门：**同一 IP 在窗口内命中过多少个不同的学号**（2026-10-03 P1 修复之二）。
 *
 * ── 为什么 per-stuNo 闸门不够 ─────────────────────────────────────
 * `misStuNoFailLimit` 只压住"盯一个号猛撞"。但撞库的真实形态是**广度**：
 * 一个学号一次，沿学号列表往下滚，每个号只试 1~2 个常见口令。
 * 这样每个学号都没超自己的额度，per-stuNo 闸门一次都不触发——
 * 实测 14 个不同学号各打1 次，全部畅通无阻地打到了学校门户。
 *
 * ── 为什么用"不同学号数"而不是"失败总次数"当指标 ─────────────────
 * 总次数天然分不清攻击与正常用户：宿舍里几个同学同时用学校密码登录，计数也涨。
 * 但"**失败横跨了多少个不同学号**"是撞库独有的指纹——
 * 正常人的失败只会集中在**自己那一个**学号上，永远不会横跨。
 * 所以这个指标对NAT 无害，对撞库极敏感。
 *
 * ── 阈值 20 怎么来的（以及为什么不再是 8）─────────────────────────
 * ⚠️ 本项目是**校园网 NAT** 场景，代码多处注释都强调"成千上万同学共用一个公网出口"。
 *    所以这个阈值**不能按"一间宿舍几个人"来定**——那是严重低估：
 *    在这个 IP 上，只要一小时内累计出现过 8 个不同学号的失败，整栋楼就一起被挡。
 *    初版定 8 就是踩了这个坑。
 *
 *    定 20 的依据是取"能证明是异常"的下限：per-IP 会话额度是 60/小时，
 *    也就是单个 IP 一小时内**最多**只有 60 次登录机会。20 次失败横跨 20 个不同学号，
 *    相当于把这个 IP 三分之一的额度全用在"猜别人的号"上 —— 正常共用出口不会这样。
 *
 *    **per-stuNo 闸门才是主力**（单账号 15 次/分钟，不受 NAT 影响）；
 *    本闸门只是"单个 IP 明显在扫号"的粗筛，阈值偏保守是为了不误伤 NAT。
 *    真要放宽/关掉，改 MIS_FANOUT_LIMIT 即可（设成 >= 60 等于关闭）。
 *
 * ── 实现要点 ─────────────────────────────────────────────────────
 * 逻辑抽到 `rateLimit.ts` 的 `makeFanoutTracker`，因为它有**必须被单测覆盖的性质**：
 * 计数要随窗口自然过期。初版用 `Set` 内联实现，只增不减 ——
 * 等于给每个 IP 攒了一份永不过期的学号黑名单，NAT 出口会被永久封死。
 * 抽出来并支持注入时钟后，`scripts/test-rate-limit.mts` 才能在不等待真实时间的前提下
 * 验证"过期"这条性质。改这段务必跑那个测试。
 */
const MIS_FANOUT_LIMIT = 20
const MIS_FANOUT_WINDOW_MS = 60 * 60 * 1000
const misFanout = makeFanoutTracker(MIS_FANOUT_LIMIT, MIS_FANOUT_WINDOW_MS)

/**
 * 记一次"某学号登录失败"，并判断该 IP 是否已呈现广度撞库特征。
 *
 * @returns true = 继续放行去打学校门户；false = 应就地拦下
 *
 * ⚠️ 这里**只判"广度"，不判失败总次数**。早先一版同时判了次数，结果两道闸门
 *    职责重叠、阈值还打架（fanout 8 次 vs per-stuNo 限额），连带两个可见副作用：
 *      · 单号撞库的实际阈值被压到 9 次，与文档承诺的 10 次不符；
 *      · 拦下时提前 throw，`misStuNoFailLimit.hit()` 被跳过 → 计数变少，
 *        受害者用正确密码反而能登录进去，行为不可预期。
 *    现在分工明确：**单号深挖 = misStuNoFailLimit；广度扩散 = 本函数**。
 */
function misFanoutGuard(ip: string, stuNo: string): boolean {
  return misFanout.hit(ip, stuNo.toLowerCase())
}

/** 惰性清扫：足迹已全空的来源条目直接删掉，避免 Map 无限增长 */
setInterval(() => misFanout.sweep(), 10 * 60 * 1000).unref()

/** MisError.kind → HTTP 状态码（评审 A9，2026-10-23）：
    此前统一 400 —— 学校门户宕机时用户收到「400 请求有问题」，方向全错。
    input 400（用户能自己修）；network 503（上游不可达，稍后重试）；
    upstream 502（门户响应异常/改版，重试通常无解）。 */
const MIS_ERROR_STATUS: Record<MisErrorKind, number> = {
  input: 400,
  network: 503,
  upstream: 502
}

function misFail(res: Response, err: unknown): void {
  if (err instanceof MisError) res.status(MIS_ERROR_STATUS[err.kind]).json({ error: err.message })
  else fail(res, err)
}

/* ==================== 「本校学生登录」匿名通道 ====================
 * 和上面 /api/mis/* 走的是**同一套**统一身份认证登录逻辑（mis.ts），区别只有两点：
 *   ① 不需要本地登录态 —— 用户此刻还没有本地账号，所以不能挂 authenticate；
 *   ② 登录成功后顺手把本地账号建出来 / 取出来，并直接签发 token。
 * 复用而不是另写一份，是为了让"登录成功但课表导入失败"这类中间态在两条路径上
 * 表现完全一致（第 3 步 /api/mis/courses 仍是同一个接口）。
 */

/**
 * 学号账号的本地密码：32 字节随机值，**从不返回给任何客户端**。
 *
 * 它存在的唯一理由是满足 users.password_hash 的非空约束 —— 学号账号的**唯一入口是
 * 教务登录**，本地密码永远是"没人知道的一串随机数"。见 provisionStudentAccount。
 */
function randomLocalPassword(): string {
  return randomBytes(32).toString('hex')
}

/** 昵称规整：教务返回的姓名拿来当昵称，去控制字符、按**码点**截断到 16 字，空则回退学号 */
function normalizeNickname(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\p{C}]/gu, '').trim()
  /* 用 Array.from 按码点切，避免 .slice 把代理对从中间劈开产生半个 emoji/生僻字 */
  const chars = Array.from(cleaned)
  if (chars.length > 0) return chars.slice(0, 16).join('')
  return Array.from(fallback).slice(0, 16).join('')
}

/**
 * 学号 → 本地账号（get-or-create）。
 *
 * ── 为什么"已存在也要轮换密码" ──────────────────────────────────
 * 游客注册允许任意用户名，所以有人可以**抢先用别人的学号 + 自己的密码**注册一个账号。
 * 等真正的学号主人来做「本校学生登录」时，我们刚刚已经让学校 CAS 校验过他的身份 ——
 * 学校背书"他就是这个学号的主人"，这个账号理应归他。轮换密码正是把抢先注册者踢出去
 * 的动作：从那以后旧密码失效，而主人走教务登录不受任何影响。
 *
 * 若只"取"不"轮换"，抢先注册者可以继续用自己设的密码登录，**看到主人导入的真实课表**，
 * 这是实打实的数据泄露。
 *
 * 副作用是学号账号从此**只能走教务登录**，这与"学号账号由学校身份背书"的预期正好一致。
 * 轮换会多花一次 scrypt（数十毫秒），对登录这种低频操作可以接受。
 */
async function provisionStudentAccount(
  stuNo: string,
  displayName: string
): Promise<{ user: User; created: boolean }> {
  const existing = getUserByUsername(stuNo)
  if (existing) {
    /* hashPassword 挪到事务外（异步 scrypt 不能夹在同步 tx() 里），三连写包成一个事务：
       否则任一步失败会留下「密码已换、旧 token 仍有效」的中间态 —— 恰是下面注释
       声称要堵的泄露窗口。与 approvePasswordReset 的事务口径对齐。 */
    const hash = await hashPassword(randomLocalPassword())
    tx(() => {
      setUserPasswordHash(existing.id, hash)
      /* ⚠️ 只轮换密码是不够的：注册时会签发 token（30 天有效），抢注者手里那个 token
         不会因为密码变了而失效 —— 他会和学号主人**共用同一个账号**，
         用 GET /api/grades、/api/courses 读走本人的真实数据。
         所以这里必须把该用户的全部会话作废，否则上面注释承诺的"踢出去"并没有发生。 */
      revokeAllSessions(existing.id)
      /* 昵称只补"默认值"，不覆盖用户改过的。
         为什么不无脑写成教务姓名：昵称在个人资料页可以自己改，每次走教务登录都被打回
         学校姓名会很烦（改一次被打回一次）。判据用「昵称是否等于账号名」—— createUser
         在没有昵称时正是这样回退的，所以这就是"用户从没碰过昵称"的信号。
         副作用：抢注者故意设的昵称会留着，这可以接受 —— 安全上要解决的（把他锁在门外）
         已经由上面的密码轮换做掉了，昵称留给账号主人自己去改。 */
      if (existing.nickname === existing.username) {
        const nick = normalizeNickname(displayName, stuNo)
        if (nick !== existing.nickname) updateProfile(existing.id, { nickname: nick })
      }
    })
    const refreshed = findUser(existing.id)
    if (!refreshed) throw new HttpError(500, '账号状态异常，请重试')
    return { user: refreshed, created: false }
  }
  /* 2026-10-23 修（D3）：不再把「第一个用户」自动授为 admin。
     原逻辑 `countUsers() === 0 → 'admin'` 意味着重装/换库后第一个匿名教务登录者
     （匿名通道限流远宽于注册口）silently 拿到全站管理员。管理员只走注册口或显式提升。 */
  const role: UserRole = 'user'
  const user = await createUser(stuNo, randomLocalPassword(), role, normalizeNickname(displayName, stuNo))
  return { user, created: true }
}

/**
 * 第 1 步（匿名）：开一个 MIS 会话，拿到统一身份认证登录页的前置参数。
 *
 * 2026-10 学校把 MIS 的登录从 `cas.bjtu.edu.cn`（图形算术验证码）换成了
 * `sso.bjtu.edu.cn` 的新 SSO（**没有验证码**，密码走 SM2 加密）。
 * 所以本接口不再返回验证码图片，只返回 sid —— 前端拿它去提交学号密码。
 */
app.get('/api/auth/mis/session', (req, res) => {
  try {
    if (!misAllowed(misKeyForIp(req), MIS_ANON_LIMIT)) {
      throw new HttpError(429, `登录尝试过于频繁（每小时 ${MIS_ANON_LIMIT} 次），请稍后再试`)
    }
    /* 全局闸门是主力防护，放在 per-IP 之后判：先让正常用户被 IP 额度挡住（文案更贴切），
       真出现分布式滥用时才由它兜底。注意它**同样会占用一次 per-IP 额度**，
       属于轻微的双重计数，换来的是不会给攻击者留"先探全局是否已满"的空子。 */
    if (!misAllowed(MIS_ANON_GLOBAL_KEY, MIS_ANON_GLOBAL_LIMIT)) {
      throw new HttpError(429, '当前登录人数较多，请稍后再试')
    }
    startMisSession(0)
      .then((r) => {
        res.set('Cache-Control', 'no-store')
        res.json({ ok: true, sid: r.sid })
      })
      .catch((err) => misFail(res, err))
  } catch (err) {
    misFail(res, err)
  }
})

/**
 * 第 2 步（匿名）：提交学号/密码 → 校验统一身份认证 → 建号/取号 → 签发本站 token。
 *
 * 顺序很关键，不能图省事把建号提到前面：
 *   SSO 通过**之前**绝不写数据库，否则每次密码打错都会在库里留下一个垃圾账号。
 *   所以先以匿名身份（userId=0）登录，确认身份后才 provision，最后把会话过继给真实 userId。
 */
app.post('/api/auth/mis/login', asyncRoute(async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const sid = String(body.sid ?? '').trim()
    if (!sid) throw new HttpError(400, '缺少 MIS 会话标识，请重新获取登录会话')

    /* 学号与教务密码来自加密信封。两端都支持：
       小程序自己实现 RSA（无 WebCrypto）；网页端用 crypto.subtle（见 web/src/lib/credEnvelope.ts）。
       旧版页面/缓存里的旧 JS 仍会发明文，readCredField 保留明文回退以兼容。 */
    const secret = credentialEnvelope(body)
    const stuNo = readCredField(body, secret, 'username').trim()
    const password = readCredField(body, secret, 'password')
    if (!stuNo || !password) throw new HttpError(400, '请填写学号和密码')

    /* userId=0 = 匿名会话，与课表导入走完全相同的 SSO 流程与错误文案 */
    const stuNoFailKey = 'stuno:' + stuNo.toLowerCase()
    /* 闸门放在真正去打学校门户**之前**：撞库者在这里就该被挡住，
       否则每次尝试都会变成一次对学校系统的真实请求（放大攻击 + 触发学校风控）。 */
    if (misStuNoFailLimit.isBlocked(stuNoFailKey)) {
      throw new HttpError(
        429,
        `该学号登录失败次数过多（1 分钟内 ${MIS_STUNO_FAIL_LIMIT} 次），请 1 分钟后再试；若非本人操作请尽快修改教务密码`
      )
    }

    let profile: Awaited<ReturnType<typeof misLogin>>
    try {
      profile = await misLogin(sid, 0, stuNo, password)
    } catch (err) {
      /* 只有真的打学校门户失败才计数；参数缺失、会话失效这类本地错误不计。
         两道闸门都在这里记失败：单号猛撞 + 广度撞库。 */
      if (err instanceof MisError) {
        /* ⚠️ 两个计数器都必须记上，顺序也有讲究：
           先记 per-stuNo，再判广度。之前写成「广度不过就 throw」，导致 throw 之后
           `misStuNoFailLimit.hit()` 永远执行不到 —— 攻击者被广度闸门拦下的那些请求
           反而**没有**计入单号额度，计数与实际失败次数对不上。
           现在：先无条件记账，再根据广度结果决定是否提前拦下。 */
        misStuNoFailLimit.hit(stuNoFailKey)
        const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
        if (!misFanoutGuard(ip, stuNo)) {
          throw new HttpError(
            429,
            '检测到短时间多次尝试不同学号，已暂停本次登录。如非本人操作请及时修改教务密码'
          )
        }
      }
      throw err
    }
    /* 登录成功清零，让改对密码的用户不被自己之前的失败次数挡住 */
    misStuNoFailLimit.reset(stuNoFailKey)

    /* 走到这里说明学校已确认"这个人就是这个学号"，此时才动数据库 */
    const { user, created } = await provisionStudentAccount(stuNo, profile.name)

    /* 把刚登录成功的 MIS 会话从匿名名下过继给真实账号：
       紧接着的第 3 步 /api/mis/courses 会以真实 userId 校验会话归属，
       不过继就会直接报"会话不存在或已过期"。 */
    if (!rebindMisSession(sid, 0, user.id)) {
      throw new HttpError(409, '登录会话已被占用，请重新获取登录会话')
    }

    try { touchLastSeen(user.id, true) } catch { /* 忽略 */ }

    res.json({
      ok: true,
      token: createSession(user.id),
      user: publicUser(user),
      sid,
      profile,
      created
    })
  } catch (err) {
    misFail(res, err)
  }
}))

/** 第 1 步：开一个 MIS 会话（新 SSO 无验证码，只返回 sid）。
 *
 * 2026-10-23 修：原为 GET。下面 2105 行附近还有一个同路径的 GET（会话池探测）
 * 按 Express 注册顺序永远不可达，导致探测恒返回 has:false ——「一次登录，全部应用
 * 可用」失效、每次打开教务应用都真实打一遍学校 SSO。开会话是副作用，改为 POST
 * （与 DELETE /api/mis/session 动词语义一致），GET 原路径留给探测。 */
app.post('/api/mis/session', authenticate, requireRealUser, (req, res) => {
  try {
    const userId = uid(req)
    if (!misAllowed(misKeyForUser(userId), MIS_LIMIT, MIS_LOGIN_WINDOW_MS)) throw new HttpError(429, `MIS 登录次数已达上限（每分钟 ${MIS_LIMIT} 次），请稍后再试`)
    startMisSession(userId)
      .then((r) => res.json({ ok: true, sid: r.sid }))
      .catch((err) => misFail(res, err))
  } catch (err) {
    misFail(res, err)
  }
})

/** 第 2 步：提交学号/密码，完成统一身份认证登录并返回身份信息 */
app.post('/api/mis/login', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const sid = String(body.sid ?? '')

    /* ⚠️ 学号与教务密码来自**加密信封**，与 /api/auth/mis/login 完全同一套协议。
       2026-10-20 修：这里原本直接读 body.username / body.password，而网页端自
       「凭据信封」上线后只发 `{ sid, credEnc }`（站点切 https 后 crypto.subtle 一定可用，
       服务端又开了 CRED_REQUIRE_ENCRYPTED=1），于是本路由永远只看到空字符串，
       1~2ms 内就回 400「请填写学号和密码」——
       **数据同步 / 课件下载 / 成绩单 / 校园邮箱四个应用全部登不进去**。
       日志特征：`POST /api/mis/login 400 ms<3` 连着刷，而同一时刻
       `POST /api/auth/mis/login` 是 200（那条路由早就改成读信封了）。
       readCredField 保留明文回退，未更新的旧页面/缓存 JS 仍可用。 */
    const secret = credentialEnvelope(body)
    const username = readCredField(body, secret, 'username').trim()
    const password = readCredField(body, secret, 'password')

    const profile = await misLogin(sid, userId, username, password)
    res.json({ ok: true, ...profile })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 会话池探测（2026-10-14）：查询当前用户是否有可复用的教务登录。
 *
 * 教务类应用（课件 / 邮箱 / 成绩单 / 数据同步）打开时先调本接口：
 *   - `has: true` → 前端直接拿 sid 使用（= "打开应用自动登录"，不用再输学号/密码/验证码）；
 *   - `has: false` → 显示登录表单；登录一次后该会话写进池子，
 *     其他教务应用也能复用（"一次登录，全部应用可用"）。
 *
 * 纯内存查询（不碰学校门户、不消耗风控额度）。只返回**调用者本人**的会话。
 * 与 DELETE /api/mis/session（显式退出）配对使用。
 */
app.get('/api/mis/session', authenticate, requireRealUser, (req, res) => {
  const s = findUserMisSession(uid(req))
  if (!s) {
    res.json({ ok: true, has: false })
    return
  }
  res.json({ ok: true, has: true, sid: s.id, name: s.profile?.name ?? '' })
})

/** 第 3 步：拉取并解析本学期课表（会话保留在池中，供其他教务应用复用） */
app.post('/api/mis/courses', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String((req.body ?? {}).sid ?? '')
    const { courses, totalCredits, semester } = await misFetchCourses(sid, userId)
    // semester：教务页面识别到的开学日/总周数（可能全为 null），由前端决定是否同步到用户设置
    res.json({ ok: true, courses, totalCredits, semester })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 第 3 步（课表，**默认口径**）：从「本科生院教学服务平台 → 智慧课程平台 → 课表」
 * 抓取整学期课表，并一并带回**权威周次表**（每周的起止日期 + 是否有课）。
 *
 * 为什么默认用它而不是 /api/mis/courses（教务 AA）：AA 只给「第 N 周」相对周号，
 * 「第 N 周是哪几天」靠开学日线性推算 —— 学校放假的那一周不排课也不算教学周，
 * 推算会从放假之后整体错位一周。智慧平台直接给周次表，周次与日期的对应以它为准。
 *
 * 返回体里的 `weeks` 由前端写进学期设置（`PUT /api/settings`），周/月视图据此
 * 把日期换算成教学周；落在周次表空档里的日期即为放假周，前端显示「放假无课程」。
 *
 * 学分仍来自教务（课表格子不含学分），拿不到只记 `aaError`，不影响课表导入。
 *
 * 前端默认走本路由；2026-10-07 ~ 10-14 该平台故障期间曾临时默认 AA 路由，平台恢复后已改回。
 */
app.post('/api/mis/timetable', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String((req.body ?? {}).sid ?? '')
    const periods = getSettings(userId).periods
    const result = await misFetchBksyTimetable(sid, userId, periods)
    res.json({ ok: true, ...result })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 第 3 步（合并）：一次会话同时同步「本科教务课表（AA）」与「智慧教学平台」。
 *
 * 为什么要合并成一个接口：两者共用同一套 CAS 登录态，分开调用要走两遍登录流程；
 * 合并后一次登录把两侧一起拉回来。2026-10-14 会话池改造后会话会保留复用
 * （见 mis.ts 的 AUTHED_IDLE_TTL_MS 注释），但合并仍是**最省额度**的路径。
 * 返回体里两个平台各自带成功标记，单边失败不影响另一边。
 *
 * 智慧教学平台部分含：当前学期（beginDate/endDate，可作学期设置的权威来源）、
 * 课程列表、以及作业/课程设计/实验报告（为作业查看与提交功能铺路）。
 */
app.post('/api/mis/sync', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String((req.body ?? {}).sid ?? '')
    const result = await misFetchAll(sid, userId)

    /* 作业落库 + 变动检测。
       ⚠️ 这一步失败**绝不能**让整个同步请求失败：
       用户花了一次学校侧风控额度才拿到的课表/学分数据，凭什么因为
       我们自己的落库写失败就一起丢掉？所以整段 best-effort，
       失败只记 stderr（与 plans.ts 的 notifyPlan 同一策略）。

       同时产出的 dataChanges 会在响应里回给前端，用于展示「本次变了什么」。 */
    let changes: DataChange[] = []
    if (result.bksy.ok && result.bksy.homeworks.length > 0) {
      try {
        upsertHomeworks(userId, result.bksy.homeworks)
        changes = changes.concat(
          recordDomainChanges(userId, 'homework', homeworkFingerprint(userId), '课程平台作业')
        )
      } catch (e) {
        console.warn(`[sync] 作业落库失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    /* 成绩落库。
       ⚠️ 只有 ln / lr **两类都成功**才允许整批替换（replaceGrades 会先 DELETE）。
       单类成功就替换，会让另一类成绩在页面上凭空消失 —— 用户会以为教务清空了数据。 */
    if (result.grades.ok) {
      try {
        replaceGrades(userId, result.grades.items)
        changes = changes.concat(
          recordDomainChanges(userId, 'grades', gradesFingerprint(listGrades(userId)), '成绩')
        )
      } catch (e) {
        console.warn(`[sync] 成绩落库失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    res.json({ ok: true, ...result, dataChanges: changes })
  } catch (err) {
    misFail(res, err)
  }
}))

/* ==================== 课程平台作业 ====================
 * 列表 / 详情 / 附件下载是**读**，数据由 /api/mis/sync 落库。
 *
 * ## 2026-10-20：补上「提交作业」（上游有、本仓库原先没有）
 *
 * 提交是**写**，且是覆盖式的：平台会删掉旧记录再写新记录，没有撤回接口。
 * 因此这里的态度与读接口完全不同：
 *   - 必须显式 `confirm: true`，前端要二次确认后才发；
 *   - 提交后**立刻**回读一次作业列表，用平台自己的 `subStatus` / `submitCount`
 *     确认真的生效了，不依赖回执（回执说 success 但列表没变等于没提交）；
 *   - 失败时明确告诉用户「上一次的提交可能已被清空」。
 *
 * 协议细节见 homeworkSubmit.ts 的文件头（端点 / 回执判据 / 双层编码）。
 */

/** 作业列表（按截止时间升序；含服务端算好的截止状态与是否已提交） */
app.get('/api/homework', authenticate, requireRealUser, (req, res) => {
  const userId = uid(req)
  const items = listHomeworks(userId).map((h) => ({
    ...h,
    typeLabel: h.homeworkType === 0 ? '作业' : h.homeworkType === 1 ? '课程设计' : '实验报告'
  }))
  res.json({
    ok: true,
    items,
    /* 上次同步的条目数：前端用它区分「还没同步过」与「同步过但这门课没作业」 */
    lastSyncedCount: snapshotCount(userId, 'homework')
  })
})

/**
 * 作业详情（正文 + 老师附件列表）。
 *
 * ⚠️ 需要 MIS 会话（`sid`）：详情接口要 `(upId, courseId, teacherId)` 三元组，
 *   而 teacherId 只存在于课程列表里 —— 我们不为了详情去落库一份课程快照，
 *   改为每次实时拉取。代价是每次展开要几秒，所以有 `homework_details` 缓存：
 *   `?refresh=1` 强制重拉（用户手动刷新），否则命中缓存直接返回。
 *
 * ⚠️ 提交作业见下面 /api/homework/submit —— 它需要 `confirm: true`。
 */
app.get('/api/homework/detail', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const upId = Number(req.query.upId ?? 0)
    const refresh = String(req.query.refresh ?? '') === '1'
    if (!Number.isInteger(upId) || upId <= 0) throw new HttpError(400, 'upId 非法')

    const item = listHomeworks(userId).find((h) => h.upId === upId)
    if (!item) throw new HttpError(404, '作业不存在（可能已被老师撤回，请重新同步）')

    if (!refresh) {
      const cached = getHomeworkDetail(userId, upId)
      if (cached) {
        res.json({ ok: true, cached: true, detail: cached })
        return
      }
    }

    if (!sid) throw new HttpError(400, '需要 MIS 会话（sid）才能拉取作业详情')
    const s = requireSession(sid, userId)
    if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)

    // teacherId 从课程列表现取：作业行的 course_id 对得上，拿不到就明确报错
    const semesters = await bksyFetchSemesters(s.jar, s.bksySessionId)
    const current = semesters.find((x) => x.current) ?? semesters[0]
    if (!current) throw new HttpError(502, '智慧教学平台未返回学期信息')
    const courses = await bksyFetchCourses(s.jar, s.bksySessionId, current.xqCode)
    const course = courses.find((c) => c.id === item.courseId)
    if (!course || course.teacherId == null) {
      throw new HttpError(502, '未找到该作业所属课程（可能是往期课程，详情暂不支持）')
    }

    const detail = await bksyFetchHomeworkDetail(
      s.jar, s.bksySessionId, upId, item.courseId, course.teacherId, item.content
    )
    upsertHomeworkDetail(userId, upId, detail.content, detail.attachments)
    res.json({ ok: true, cached: false, detail: getHomeworkDetail(userId, upId) })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 下载老师附件（二进制中转）。
 *
 * 与课件/成绩单同一模式：平台附件要带 `sessionid` 头才能取，
 * 浏览器直连拿不到，服务端代抓再以 Blob 吐回。
 */
app.get('/api/homework/attachment', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const upId = Number(req.query.upId ?? 0)
    const attachmentId = Number(req.query.id ?? 0)
    if (!Number.isInteger(upId) || upId <= 0) throw new HttpError(400, 'upId 非法')
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) throw new HttpError(400, '附件 id 非法')

    const meta = getHomeworkAttachmentPath(userId, upId, attachmentId)
    if (!meta) throw new HttpError(404, '附件不存在，请先展开作业详情')

    const s = requireSession(sid, userId)
    if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)
    const r = await bksyDownloadHomeworkAttachment(s.jar, s.bksySessionId, upId, attachmentId, meta.fileName)

    const encoded = encodeURIComponent(r.fileName)
    res.setHeader('Content-Type', r.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${r.fileName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encoded}`
    )
    res.send(r.bytes)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 提交作业（上传文件 + 投递说明）。
 *
 * ## 为什么必须 `confirm: true`
 *
 * 覆盖式写入且不可撤回。前端会先弹确认框，确认后才带上这个字段。
 * 没有它就直接拒 —— 这样即使前端某个调用点漏了确认逻辑，也不会静默提交。
 *
 * ## 为什么文件走 base64 JSON 而不是 multipart
 *
 * 本项目的 body-parser 只有 `express.json`（`server/src/index.ts` 的
 * LARGE_BODY_PATHS 一节），引 multipart 解析器等于为一个功能加依赖。
 * base64 膨胀 4/3，配合 10 MB 单文件上限，最坏 16 MB 的 JSON ——
 * 这条路由用的是 10mb 档（submitJson），其它大 body 路由是 8mb 档、普通接口 64kb。
 *
 * ## 为什么提交后要回读
 *
 * 平台回执 `{"flag":"success"}` 只是"请求被接受"。历史缺陷就是只看 HTTP 2xx
 * （更弱的判据）把失败当成功。这里用平台自己的 `submitCount` / `subStatus`
 * 做独立验证：回执说成功但列表没变 = 没提交上，照样报错。
 */
app.post('/api/homework/submit', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as {
      sid?: unknown; upId?: unknown; note?: unknown; confirm?: unknown
      files?: unknown
    }
    if (body.confirm !== true) {
      throw new HttpError(400, '提交作业不可撤回，请先确认（confirm: true）')
    }
    const sid = String(body.sid ?? '')
    const upId = Number(body.upId ?? 0)
    if (!Number.isInteger(upId) || upId <= 0) throw new HttpError(400, 'upId 非法')
    const note = String(body.note ?? '')
    if (note.length > MAX_SUBMIT_NOTE_LENGTH) {
      throw new HttpError(400, `提交说明过长（最多 ${MAX_SUBMIT_NOTE_LENGTH} 字）`)
    }

    /* 作业必须存在于本地库：courseId / homeworkType 都从它取，
       也顺带挡住"提交一个已被老师撤回的作业"。 */
    const item = listHomeworks(userId).find((h) => h.upId === upId)
    if (!item) throw new HttpError(404, '作业不存在（可能已被老师撤回，请重新同步）')

    if (!Array.isArray(body.files) || body.files.length === 0) {
      throw new HttpError(400, '请至少选择一个要提交的文件')
    }
    if (body.files.length > MAX_UPLOAD_FILES) {
      throw new HttpError(400, `一次最多提交 ${MAX_UPLOAD_FILES} 个文件`)
    }
    const uploads: { fileName: string; contentType: string; bytes: Buffer }[] = []
    let totalBytes = 0
    for (const raw of body.files) {
      const f = (raw ?? {}) as { name?: unknown; type?: unknown; data?: unknown }
      const name = String(f.name ?? '').trim()
      if (!name) throw new HttpError(400, '文件名不能为空')
      /* 文件名只留基名：`../` 与路径分隔符会出现在平台的下载链接里 */
      if (/[/\\]/.test(name) || name === '.' || name === '..') {
        throw new HttpError(400, `文件名非法：${name}`)
      }
      const data = String(f.data ?? '')
      /* 前端用 FileReader 读成 data URL，这里剥掉前缀；纯 base64 也接受 */
      const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
      const bytes = Buffer.from(b64, 'base64')
      if (bytes.length === 0) throw new HttpError(400, `文件「${name}」是空的`)
      if (bytes.length > MAX_UPLOAD_BYTES) {
        throw new HttpError(400, `文件「${name}」超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
      }
      totalBytes += bytes.length
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        throw new HttpError(400, `文件总大小超过 ${Math.floor(MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024)} MB`)
      }
      uploads.push({ fileName: name, contentType: String(f.type ?? '') || 'application/octet-stream', bytes })
    }

    const s = requireSession(sid, userId)
    if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)

    /* ① 逐个上传。任一失败就整体中止 —— 只传了一半就投递会得到
       "作业缺文件"的提交，比完全不提交更糟。 */
    const receipts = []
    for (const f of uploads) {
      receipts.push(await bksyUploadHomeworkFile(s.jar, s.bksySessionId, upId, f))
    }

    /* ② 投递 */
    await bksySubmitHomework(s.jar, s.bksySessionId, {
      upId,
      courseId: item.courseId,
      homeworkType: item.homeworkType,
      note,
      receipts
    })

    /* ③ 回读验证：从平台重新拉这门课的作业列表，找这一条 */
    let verified: { submitCount: number; subStatus: string } | null = null
    try {
      const semesters = await bksyFetchSemesters(s.jar, s.bksySessionId)
      const current = semesters.find((x) => x.current) ?? semesters[0]
      if (current) {
        const fresh = await bksyFetchHomeworks(
          s.jar, s.bksySessionId, item.courseId, item.homeworkType as 0 | 1 | 2
        )
        const hit = fresh.find((h) => h.upId === upId)
        if (hit) verified = { submitCount: hit.submitCount, subStatus: hit.subStatus }
      }
    } catch {
      /* 回读失败不影响"已提交"这个事实（投递回执已经 success），
         但要把 verified=null 明确回给前端，让它提示用户自己去平台确认。 */
    }

    res.json({
      ok: true,
      submittedFiles: receipts.length,
      verified,
      /* verified 为空时前端必须显示这句 —— 不能让用户以为"提交一定成功了" */
      hint: verified ? '已提交并确认生效' : '已提交，但未能回读确认，请到课程平台核对'
    })
  } catch (err) {
    misFail(res, err)
  }
}))

/* ==================== 成绩 ====================
 * 数据只读：由 /api/mis/sync 落库，这里只负责查询与统计。
 * 统计（加权平均、学分、挂科数）在服务端算好，前端不复刻 —— 否则两侧算法
 * 一旦不一致，用户会在两个地方看到不同的平均分。
 */

app.get('/api/grades', authenticate, requireRealUser, (req, res) => {
  const userId = uid(req)
  const items = listGrades(userId)
  res.json({
    ok: true,
    items,
    stats: computeStats(items),
    lastSyncedCount: snapshotCount(userId, 'grades')
  })
})

/**
 * 成绩单 PDF 下载（中转）。
 *
 * ⚠️ 为什么必须服务端中转：PDF 需要 AA 的登录会话（cookie 在服务端），
 * 前端直接拿链接过去会被踢到登录页 —— 下载到的是一个 HTML 登录页而不是 PDF。
 *
 * ⚠️ 这是**写权限级**能力（成绩单可用于正式申请材料），所以：
 *   - 挂 requireRealUser（游客不可用）
 *   - lang 白名单校验（不接受任意 type 参数，防 SSRF/越权取其他文件）
 *   - 校验响应确实是 PDF（魔数 %PDF），否则说明会话失效
 */
app.get('/api/report-card', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  /* ⚠️ async handler 里的**所有**同步校验都必须写在 try 内。
     Express 4 只捕获同步 throw；async 函数里 try 之外的异常会变成 unhandledRejection，
     而 Node ≥15 默认 `--unhandled-rejections=throw` → **整个进程退出**。
     这里曾经把 lang 白名单校验写在了 try 之外：任何一个已登录用户请求
     `?lang=xx`（甚至前端拼错一个字符）就能让全站 502，直到 systemd 把它拉起来。 */
  try {
    const userId = uid(req)
    const lang = String(req.query.lang ?? 'zh')
    if (lang !== 'zh' && lang !== 'en') throw new HttpError(400, 'lang 需为 zh 或 en')

    const sid = String(req.query.sid ?? '')
    const buf = await misFetchReportCard(sid, userId, lang as ReportCardLanguage)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="transcript-${lang}-${toISODate(new Date())}.pdf"`
    )
    res.send(buf)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 空闲教室（教务占用矩阵）—— 仍为下线状态（2026-10-14）。
 *
 * 下架原因：实现方向有误（教务真实页面是「教室 × 7 天 × 7 节」占用矩阵，
 * 路径含 /timeholdresult/ 段、教学楼用数字 id），且无法用真实登录态联调，
 * 与用户确认后直接下架。保留路由返回 410，避免缓存旧前端的用户看到白屏/500。
 *
 * ⚠️ 注意与下面的「教室人数」区分 —— 那是**另一个**功能：
 *   本路由查「哪个教室有课」（需要教务会话），
 *   `/api/classroom/capacity` 查「教室里现在有多少人」（第三方公开接口，免登录）。
 *   两者数据源、语义、鉴权完全不同，不要因为名字像就合并。
 */
app.post('/api/classroom', authenticate, requireRealUser, (_req, res) => {
  res.status(410).json({ error: '空闲教室功能已下线，请更新到最新版本。' })
})

/* ==================== 教室人数（第三方公开接口） ====================
 *
 * 数据源：`http://yaya.csoci.com:2333/api/classnum/?building=<楼名>`
 * 免登录、无凭据、不碰学校会话。详见 server/src/classroom.ts 的安全边界说明。
 *
 * ⚠️ 故意**不挂** authenticate / requireRealUser：
 *   接口本身公开，第三方也拿不到任何身份信息；要求登录只会平白多一道摩擦。
 *   但代码里仍然不传任何 Cookie，确保"公开"名副其实。
 *
 * ⚠️ 故意**不缓存**：数据是第三方最近一次轮询窗口的快照，缓存等于喂假数据。
 *
 * 2026-10-23 修（评审 A3）：补一道 per-IP 限流。此前本路由完全匿名、无限流，
 * 而每次请求都真实打第三方 `yaya.csoci.com:2333` —— 匿名用户可以把它当放大代理用。
 * 口径与 `/api/calendar/academic` 一致（12 次/分/IP）：正常刷新远达不到。
 */

const classroomCapacityLimit = makeSlidingWindowLimiter(60_000, 12)

app.get('/api/classroom/buildings', (_req, res) => {
  res.json({ ok: true, buildings: CLASSROOM_BUILDINGS })
})

app.get('/api/classroom/capacity', asyncRoute(async (req, res) => {
  /* ⚠️ async handler 的同步校验必须写在 try 内，否则 Express 4 捕获不到，
     会变成 unhandledRejection 打挂整个进程（见 /api/report-card 的同款注释）。 */
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!classroomCapacityLimit.hit(ip)) throw new HttpError(429, '教室人数查询过于频繁，请稍后再试')
    const building = String(req.query.building ?? '').trim()
    if (!building) throw new HttpError(400, '缺少 building 参数')
    if (!isKnownBuilding(building)) throw new HttpError(400, '未知教学楼')
    const info = await fetchClassroomCapacity(building)
    res.json({ ok: true, ...info })
  } catch (err) {
    /* 结构异常与网络失败分开报：前者是"接口改名了"，后者是"接口/网络挂了"，
       用户能采取的动作不同（等 vs 反馈）。 */
    if (err instanceof ClassroomParseError) {
      res.status(502).json({ error: err.message })
      return
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    res.status(502).json({ error: err instanceof Error ? err.message : '教室人数获取失败' })
  }
}))

/* ==================== 学业日历（权威教学周） ====================
 *
 * 学校在 bksy.bjtu.edu.cn/Admin/SemesterTranPage.aspx 公开完整学业日历：
 * 每一周是不是教学周、有没有「休」（放假），以及每周周一日期。
 *
 * **免登录**（上游同样走 `executePublic`），所以不挂 authenticate —— 游客也能看
 * 「今天是第几教学周」。这也让本仓库第一次有了「放假周」的权威判断依据：
 * 之前只靠用户手填起始日线性推算，学校一放假（那一周不排课也不算教学周），
 * 之后的所有周号都会整体偏大。
 *
 * ⚠️ 不缓存 + 不落库：一次请求 690KB，但一学期只变几次；缓存反而要在
 *    「学校改校历了」时提供刷新入口。前端自己做 sessionStorage 短缓存。
 *
 * ⚠️ 但要限流：这个页面有 690KB，无鉴权的公开 GET 很容易被刷成出口带宽黑洞
 *    （学校那台单机也扛不住）。每 IP 每分钟 12 次 —— 正常用户手动刷新远达不到，
 *    而「前端 useEffect 打成循环」这类 bug 会在第 13 次被挡住而不是拖垮学校站点。
 */

const academicCalendarLimit = makeSlidingWindowLimiter(60_000, 12)

app.get('/api/calendar/academic', asyncRoute(async (req, res) => {
  try {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString()
    if (!academicCalendarLimit.hit(ip)) throw new HttpError(429, '校历查询过于频繁，请稍后再试')
    const data = await fetchAcademicCalendar()
    res.json({
      ok: true,
      today: data.today,
      current: data.current
        ? {
            id: data.current.id,
            title: data.current.title,
            academicYear: data.current.academicYear,
            term: data.current.term,
            firstMonday: data.current.weeks.find((w) => w.kind === 'teaching')?.monday ?? null,
            totalWeeks: data.current.weeks.reduce(
              (max, w) => (w.teachingWeek !== null && w.teachingWeek > max ? w.teachingWeek : max),
              0
            )
          }
        : null,
      week: data.week,
      semesters: data.semesters.map((s) => ({
        id: s.id,
        title: s.title,
        academicYear: s.academicYear,
        term: s.term,
        weeks: s.weeks.length
      }))
    })
  } catch (err) {
    /* HttpError 必须原样透出（429 限流 / 400 参数错）。写在这里而不是让外层兜底：
       这个 catch 会把**所有**异常都改写成 502，不单独放行就等于限流失效。 */
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    if (err instanceof AcademicCalendarParseError) {
      res.status(502).json({ error: err.message })
      return
    }
    res.status(502).json({ error: err instanceof Error ? err.message : '校历获取失败' })
  }
}))

/* ==================== 课件（智慧课程平台） ====================
 *
 * 课件列表与下载。**完全实时**，不落库 —— 文件名/大小随时会变、下载状态也会变，
 * 缓存反而误导用户。代价是每次都要重走 SSO，但「数据同步」已经做了一次 SSO，
 * 用户在「应用 → 课件」新开就会话则是额外的 CAS 登录（前端要引导）。
 *
 * ⚠️ MIS 会话是一次性的 —— 这两个接口的会话会与「数据同步」互相冲突。
 *   所以这里**不复用 sync 的会话**：让用户单独登录（与「成绩单」同一模式）。
 *
 * ⚠️ `courseId` 等课程元数据必须从 sync 的 bksy.courses 里来，前端不要自己构造。
 *   抓取器需要 courseNumber/groupId/semesterCode 三个字段，sync 的 bksy 已经准备好。
 */

app.post('/api/courseware/list', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as {
      sid?: unknown; course?: unknown; parentId?: unknown
    }
    const sid = String(body.sid ?? '')
    const course = body.course as
      | { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string }
      | undefined
    const parentId = String(body.parentId ?? '0')
    if (!parentId || parentId.length > 32) throw new HttpError(400, 'parentId 非法')
    if (!course || !course.id || !course.courseNumber || !course.groupId || !course.semesterCode) {
      throw new HttpError(400, 'course 字段不完整（请从 sync 的 bksy.courses 里取）')
    }

    const s = requireSession(sid, userId)
    if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)
    const list = await bksyFetchCourseware(s.jar, s.bksySessionId, course, parentId)
    res.json(list)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 列出本学期可浏览课件的课程（轻量版，不走 sync）。
 * 与 `/api/courseware/list` 共用同一个 sid，**sid 在整个课件会话内复用**。
 */
app.get('/api/courseware/courses', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const s = requireSession(sid, userId)
    if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
    if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)
    const courses = await bksyListCoursesForCourseware(s.jar, s.bksySessionId)
    res.json({ courses })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 下载课件文件 —— 二进制中转。
 *
 * ⚠️ 与 `/api/report-card` 同样的会话逻辑：智慧课程平台资源服务**只认 URL 里的令牌**，
 *   浏览器直接拼链接拿不到 cookie 里的 session；服务端代抓再以 Blob 形式吐回前端。
 */
/**
 * 真正把课件文件吐给客户端（被「带 Bearer 头的接口」和「浏览器直下的票据路由」共用）。
 *
 * 为什么抽出来：App 壳里点下载改走系统浏览器之后，同一条下载逻辑有两个入口 ——
 * 一个带登录态（网页 / fetch），一个只带短命票据（浏览器，拿不到 Authorization 头）。
 * 两边各写一份的话，文件名编码、Content-Type 这些细节迟早会漂移。
 */
async function streamCoursewareFile(
  res: Response, userId: number, sid: string, rpId: string, name: string
): Promise<void> {
  const s = requireSession(sid, userId)
  if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
  if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)
  const r = await bksyDownloadCourseware(s.jar, s.bksySessionId, rpId, name)
  // 文件名要走 RFC 5987 编码以防中文/特殊字符出问题
  const encoded = encodeURIComponent(r.fileName)
  res.setHeader('Content-Type', r.contentType)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${r.fileName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encoded}`
  )
  res.send(r.bytes)
}

app.get('/api/courseware/download', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const rpId = String(req.query.rpId ?? '')
    const name = String(req.query.name ?? '课件.bin').slice(0, 120)
    if (!rpId || rpId.length > 64) throw new HttpError(400, 'rpId 非法')
    await streamCoursewareFile(res, userId, sid, rpId, name)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 整目录导出 —— 递归展开 + 打包 zip 一次下载。
 *
 * ⚠️ 为什么是服务端打包：Web 版没有「选一个本地目录往里写」的能力
 *   （File System Access API 只在 Chromium 且要用户手势选目录），
 *   唯一能保留目录层级的做法是服务端压成 zip。
 *
 * ⚠️ 这个请求**可能跑很久**（几十个文件、每个都要先取票据再下载）。
 *   所以设了硬上限（文件数 200 / 总大小 500MB / 深度 12 层），
 *   触到上限时**照样返回 zip**，但在响应头里标出 `X-Export-Truncated`，
 *   让前端明确告诉用户「这不是完整导出」—— 静默截断比报错更糟。
 *
 * ⚠️ `parentId` 为 `0` 表示整门课。传某个文件夹 id 就只导那一个子树。
 */
interface CoursewareCourseRef {
  id: number; name: string; courseNumber: string; groupId: string; semesterCode: string
}

/**
 * 计数信号量（评审 A4，2026-10-23）：整目录导出是当前唯一能 OOM 的路径 ——
 * zip 在内存攒齐（源文件 + 产物，峰值 ≈ 1GB），而 `/dl/cwz/:id` 票据 10 分钟内
 * 可重复使用、可并发，几个并发导出就能把进程内存打穿。闸门 per-user 1 / 全局 2。
 * 中期改造方向是流式 zip，在那之前先用并发上限兜底。
 */
class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
  }
  release(): void {
    this.active--
    this.queue.shift()?.()
  }
}

const zipExportSlots = new Semaphore(2)
/** 正在进行整目录导出的 userId 集合（per-user 并发 1） */
const zipExportBusyUsers = new Set<number>()

async function runZipExportGated<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  if (zipExportBusyUsers.has(userId)) throw new HttpError(429, '已有一次导出在进行中，请稍后再试')
  await zipExportSlots.acquire()
  /* 等全局槽位期间同一用户可能已经插队开始，再看一眼避免 per-user 超卖 */
  if (zipExportBusyUsers.has(userId)) {
    zipExportSlots.release()
    throw new HttpError(429, '已有一次导出在进行中，请稍后再试')
  }
  zipExportBusyUsers.add(userId)
  try {
    return await fn()
  } finally {
    zipExportBusyUsers.delete(userId)
    zipExportSlots.release()
  }
}

async function streamCoursewareZip(
  res: Response, userId: number, sid: string,
  course: CoursewareCourseRef, parentId: string, zipName: string
): Promise<void> {
  const s = requireSession(sid, userId)
  if (!s.bksyLoggedIn) await bksySso(s.jar, MIS_ORIGIN)
  if (!s.bksySessionId) s.bksySessionId = await bksySessionId(s.jar)

  const r = await bksyExportCoursewareDirectory(s.jar, s.bksySessionId, course, parentId)
  if (r.files.length === 0) {
    // 一个文件都没下到：区隔「全是未开放下载」和「下载全失败」，别让用户以为导成功了
    if (r.skipped.length > 0 && r.failed.length === 0) {
      throw new MisError('这个目录里的文件都未开放下载，无法导出')
    }
    if (r.failed.length > 0) {
      throw new MisError(`文件下载全部失败：${r.failed[0].reason}`)
    }
    throw new MisError('这个目录里没有可导出的文件')
  }

  const entries = [
    ...r.emptyDirs.map((p) => zipDirEntry(p)),
    ...r.files.map((f) => ({ path: f.path, data: f.bytes }))
  ]
  const zip = buildZip(entries)

  /*
   * 跳过/失败清单不能塞进响应头 —— 中文文件名必须编码，几十个名字会超过头长度限制。
   * 放进一个自定义头里只放计数，明细由前端在导出前的预检接口拿。
   */
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('X-Export-Skipped', String(r.skipped.length))
  res.setHeader('X-Export-Failed', String(r.failed.length))
  res.setHeader('X-Export-Truncated', r.truncated ? '1' : '0')
  res.setHeader('X-Export-Files', String(r.files.length))
  const encoded = encodeURIComponent(`${zipName}.zip`)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="courseware.zip"; filename*=UTF-8''${encoded}`
  )
  // 自定义头要显式暴露给前端，否则 fetch 读不到（同源也读不到非简单响应头）
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, X-Export-Skipped, X-Export-Failed, X-Export-Truncated, X-Export-Files'
  )
  res.send(zip.bytes)
}

app.get('/api/courseware/export', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const parentId = String(req.query.parentId ?? '0').slice(0, 32)
    const zipName = String(req.query.name ?? '课件导出').slice(0, 60) || '课件导出'
    let course: CoursewareCourseRef
    try {
      course = JSON.parse(String(req.query.course ?? '{}'))
    } catch {
      throw new HttpError(400, 'course 参数不是合法 JSON')
    }
    if (!course || !course.id || !course.courseNumber || !course.groupId || !course.semesterCode) {
      throw new HttpError(400, 'course 字段不完整（请从 sync 的 bksy.courses 里取）')
    }
    await runZipExportGated(userId, () => streamCoursewareZip(res, userId, sid, course, parentId, zipName))
  } catch (err) {
    misFail(res, err)
  }
}))

/* ==================== 浏览器直下：短命下载票据 ====================
 *
 * ## 为什么需要它
 *
 * App 壳（Android WebView）里没有下载管理器：网页里 `<a download>` 会被静默吞掉，
 * 只能把整个文件读成 base64 再交给原生桥写进 MediaStore。这条路有三个硬伤：
 *   ① 体积膨胀 33%，几十 MB 的课件会把 WebView 的 JS 堆顶爆；
 *   ② 全程没有任何进度，用户点完就是干等 —— 「App 里点下载没反应」的来源；
 *   ③ 写完之后只有一个 Toast，文件去哪儿了用户并不知道。
 *
 * 所以壳里改成：网页先换一张**短命票据**，再把 `/dl/cw/<票据>` 这个 URL 交给系统浏览器。
 * 浏览器自己有下载管理器（进度条 + 通知栏 + 断点），体验和网页版一致。
 *
 * ## 为什么不直接把 Bearer token 拼进 URL
 *
 * token 是 30 天有效的会话凭证，写进 URL 会留在浏览器历史、可能被日志/分享带出去，
 * 泄漏面远大于"下载一个课件"。票据则是：随机 32 位十六进制、10 分钟过期、
 * 只能换**一个已授权用户的一次具体下载**，且与用户 id 绑定（票据里的 userId
 * 决定了 `requireSession(sid, userId)` 能不能过）。
 *
 * ## 为什么放内存里而不落库
 *
 * 票据活 10 分钟，进程重启就全失效 —— 用户重开 App 再点一次即可，
 * 没有任何"必须持久化"的语义。落库反而多一张要清理的表。
 */
interface DownloadTicket {
  kind: 'file' | 'zip'
  userId: number
  sid: string
  /** 单文件：展示/回传给学校资源服务的文件名 */
  name: string
  rpId?: string
  parentId?: string
  course?: CoursewareCourseRef
  exp: number
}

const downloadTickets = new Map<string, DownloadTicket>()
const DOWNLOAD_TICKET_TTL_MS = 10 * 60 * 1000

function issueDownloadTicket(t: Omit<DownloadTicket, 'exp'>): string {
  const now = Date.now()
  /* 顺手清过期的：票据数量天然很小（每用户每次下载一张），这个循环是 O(未过期票据数) */
  for (const [k, v] of downloadTickets) if (v.exp <= now) downloadTickets.delete(k)
  const id = randomBytes(16).toString('hex')
  downloadTickets.set(id, { ...t, exp: now + DOWNLOAD_TICKET_TTL_MS })
  return id
}

function readDownloadTicket(id: string): DownloadTicket | null {
  const t = downloadTickets.get(id)
  if (!t) return null
  if (t.exp <= Date.now()) {
    downloadTickets.delete(id)
    return null
  }
  return t
}

/** 票据失效时给浏览器一个**能看懂**的页面（而不是一坨 JSON） */
function sendTicketError(res: Response, status: number, message: string): void {
  res.status(status).type('html').send(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>下载失败</title></head>'
    + '<body style="margin:0;padding:22vh 24px 0;text-align:center;'
    + 'font:16px/1.7 -apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#222">'
    + '<div style="font-size:17px;font-weight:600;margin-bottom:8px">下载链接已失效</div>'
    + '<div style="font-size:13px;color:#666;word-break:break-all">' + message + '</div>'
    + '<div style="font-size:13px;color:#666;margin-top:14px">回到 App 重新点一次「下载」即可。</div>'
    + '</body></html>'
  )
}

/** 换票据：单文件下载 */
app.post('/api/courseware/download-ticket', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  const userId = uid(req)
  const body = (req.body ?? {}) as { sid?: unknown; rpId?: unknown; name?: unknown }
  const sid = String(body.sid ?? '')
  const rpId = String(body.rpId ?? '')
  const name = String(body.name ?? '课件.bin').slice(0, 120)
  if (!rpId || rpId.length > 64) throw new HttpError(400, 'rpId 非法')
  /* 先验一次会话归属：票据是"免登录"的，签发时必须确认这个 sid 真的属于当前用户 */
  requireSession(sid, userId)
  const id = issueDownloadTicket({ kind: 'file', userId, sid, name, rpId })
  res.json({ path: `/dl/cw/${id}`, expiresIn: Math.floor(DOWNLOAD_TICKET_TTL_MS / 1000) })
}))

/** 换票据：整目录导出（zip） */
app.post('/api/courseware/export-ticket', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  const userId = uid(req)
  const body = (req.body ?? {}) as {
    sid?: unknown; parentId?: unknown; name?: unknown; course?: unknown
  }
  const sid = String(body.sid ?? '')
  const parentId = String(body.parentId ?? '0').slice(0, 32)
  const name = String(body.name ?? '课件导出').slice(0, 60) || '课件导出'
  const course = body.course as CoursewareCourseRef | undefined
  if (!course || !course.id || !course.courseNumber || !course.groupId || !course.semesterCode) {
    throw new HttpError(400, 'course 字段不完整（请从 sync 的 bksy.courses 里取）')
  }
  requireSession(sid, userId)
  const id = issueDownloadTicket({ kind: 'zip', userId, sid, name, parentId, course })
  res.json({ path: `/dl/cwz/${id}`, expiresIn: Math.floor(DOWNLOAD_TICKET_TTL_MS / 1000) })
}))

/*
 * 浏览器直下的两个公开入口。
 *
 * ⚠️ 刻意**不加 authenticate**：浏览器地址栏里的请求带不了 Authorization 头。
 *    身份完全由票据承载（随机 + 10 分钟 + 绑定 userId）。
 * ⚠️ 不加 `Cache-Control` 之外的任何鉴权兜底：票据一旦泄漏，10 分钟后自然失效。
 */
app.get('/dl/cw/:id', asyncRoute(async (req, res) => {
  const t = readDownloadTicket(String(req.params.id ?? ''))
  if (!t || t.kind !== 'file' || !t.rpId) {
    sendTicketError(res, 410, '链接已过期或无效')
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    await streamCoursewareFile(res, t.userId, t.sid, t.rpId, t.name)
  } catch (err) {
    if (res.headersSent) { res.destroy(); return }
    sendTicketError(res, 500, err instanceof Error ? err.message : '下载失败')
  }
}))

app.get('/dl/cwz/:id', asyncRoute(async (req, res) => {
  const t = readDownloadTicket(String(req.params.id ?? ''))
  if (!t || t.kind !== 'zip' || !t.course) {
    sendTicketError(res, 410, '链接已过期或无效')
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    await runZipExportGated(t.userId, () =>
      streamCoursewareZip(res, t.userId, t.sid, t.course!, t.parentId ?? '0', t.name))
  } catch (err) {
    if (res.headersSent) { res.destroy(); return }
    sendTicketError(res, err instanceof HttpError ? err.status : 500, err instanceof Error ? err.message : '导出失败')
  }
}))

/* ==================== 校园邮箱（只读中转，Coremail） ====================
 * 与「课件」同一策略：轻量登录、会话在页面停留期间复用、离开时前端销毁。
 * 只读：收件箱列表 / 邮件详情 / 附件下载（移植自 KMP 参考仓库的取证接口）；
 * 写信与发送刻意不做 —— 写操作风险远高于读。
 */

app.post('/api/mailbox/list', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as { sid?: unknown; start?: unknown; limit?: unknown }
    const sid = String(body.sid ?? '')
    const start = Number(body.start ?? 0)
    const limit = Number(body.limit ?? 30)
    const r = await misMailboxList(
      sid,
      userId,
      Number.isFinite(start) ? start : 0,
      Number.isFinite(limit) ? limit : 30
    )
    res.json(r)
  } catch (err) {
    misFail(res, err)
  }
}))

app.post('/api/mailbox/message', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as { sid?: unknown; id?: unknown }
    const sid = String(body.sid ?? '')
    const id = String(body.id ?? '')
    if (!id || id.length > 256) throw new HttpError(400, '邮件 id 非法')
    const r = await misMailboxRead(sid, userId, id)
    res.json(r)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 建写信草稿（新邮件 / 回复共用）。
 *
 * 返回的 draftId 是投递凭据，前端必须拿它去调 /api/mailbox/send。
 * 没有这一步的话投递接口就要自己建草稿，一旦投递失败草稿会留在用户
 * 邮箱里 —— 拆成两步才能在失败时由前端决定「重试」还是「放弃」。
 */
app.post('/api/mailbox/compose', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as { sid?: unknown; replyTo?: unknown }
    const sid = String(body.sid ?? '')
    const replyTo = body.replyTo == null ? null : String(body.replyTo)
    if (replyTo !== null && (!replyTo || replyTo.length > 256)) throw new HttpError(400, '被回复的邮件 id 非法')
    const r = await misMailboxBeginCompose(sid, userId, replyTo)
    res.json({ ok: true, draft: r })
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 发送邮件。地址/主题/正文的校验在 mailbox.ts 的 normalizeComposeInput 里，
 * 这里只做类型与长度兜底（防超大 body 打满内存）。
 */
app.post('/api/mailbox/send', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as {
      sid?: unknown; draftId?: unknown; to?: unknown; cc?: unknown
      bcc?: unknown; subject?: unknown; text?: unknown; replyTo?: unknown
    }
    const sid = String(body.sid ?? '')
    const draftId = String(body.draftId ?? '')
    if (!draftId || draftId.length > 128) throw new HttpError(400, '草稿编号非法')
    const to = String(body.to ?? '')
    const cc = String(body.cc ?? '')
    const bcc = String(body.bcc ?? '')
    const subject = String(body.subject ?? '')
    const text = String(body.text ?? '')
    /* 粗筛长度上限，真正的校验在 mailbox.ts —— 这里拦住明显异常的请求体 */
    if (to.length + cc.length + bcc.length > 8_000) throw new HttpError(400, '收件人过多')
    if (subject.length > 1_000) throw new HttpError(400, '主题过长')
    if (text.length > 1_100_000) throw new HttpError(400, '正文过长')
    const replyTo = body.replyTo == null ? null : String(body.replyTo)
    const r = await misMailboxSend(sid, userId, draftId, { to, cc, bcc, subject, body: text }, replyTo)
    res.json(r)
  } catch (err) {
    misFail(res, err)
  }
}))

/** 放弃草稿（用户在写信界面点「取消」，或发送失败后选择清理） */
app.post('/api/mailbox/discard', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as { sid?: unknown; draftId?: unknown }
    const sid = String(body.sid ?? '')
    const draftId = String(body.draftId ?? '')
    if (draftId.length > 128) throw new HttpError(400, '草稿编号非法')
    await misMailboxCancelCompose(sid, userId, draftId)
    res.json({ ok: true })
  } catch (err) {
    misFail(res, err)
  }
}))

app.get('/api/mailbox/attachment', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String(req.query.sid ?? '')
    const mid = String(req.query.mid ?? '')
    const part = String(req.query.part ?? '')
    const name = String(req.query.name ?? 'attachment.bin').slice(0, 160)
    if (!mid || mid.length > 256) throw new HttpError(400, '邮件 id 非法')
    if (!part || part.length > 128) throw new HttpError(400, '附件 id 非法')
    const r = await misMailboxAttachment(sid, userId, mid, part, name)
    const encoded = encodeURIComponent(r.fileName)
    res.setHeader('Content-Type', r.contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${r.fileName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encoded}`
    )
    res.send(r.bytes)
  } catch (err) {
    misFail(res, err)
  }
}))

/**
 * 第 3 步（考务）：抓取本学期考试安排。
 * 逐个探测 AA 考试页候选路径，命中即返回；全部未命中返回空数组（不报错），
 * 由前端区分「教务暂未公布」与「页面结构变化」两种提示。
 */
app.post('/api/mis/exams', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const userId = uid(req)
    const sid = String((req.body ?? {}).sid ?? '')
    const { exams, path, tried } = await misFetchExams(sid, userId)
    res.json({ ok: true, exams, path, tried })
  } catch (err) {
    misFail(res, err)
  }
}))

/** 退出登录 / 放弃导入：立刻销毁该会话与全部 cookie（其他应用下次打开需重新登录） */
app.delete('/api/mis/session', authenticate, requireRealUser, (req, res) => {
  const sid = String((req.body ?? {}).sid ?? req.query.sid ?? '')
  const ok = sid ? destroyMisSession(sid, uid(req)) : true
  res.json({ ok })
})

/* ==================== 考务（考试安排） ====================
 * 数据来源两条：教务系统抓取（/api/mis/exams）与手动添加。
 * 每条考试可「一键转 DDL」：生成/复用一条 type=exam 的高优先级任务。
 */

const EXAM_ROW_MAX = 60

function validateExamBody(body: Record<string, unknown>): ExamInput {
  const out: Partial<ExamInput> = {}

  {
    const name = String(body.courseName ?? '').trim()
    if (!name) throw new HttpError(400, '考试科目不能为空')
    if (name.length > EXAM_ROW_MAX) throw new HttpError(400, `考试科目最多 ${EXAM_ROW_MAX} 字`)
    out.courseName = name
  }
  {
    const d = String(body.examDate ?? '').trim()
    if (!isValidISODate(d)) throw new HttpError(400, '考试日期需为 YYYY-MM-DD')
    out.examDate = d
  }
  for (const key of ['startTime', 'endTime'] as const) {
    if (key in body) {
      const v = String(body[key] ?? '').trim()
      if (v && !isValidTime(v)) throw new HttpError(400, '考试时间需为 HH:mm 或留空')
      out[key] = v
    }
  }
  for (const key of ['location', 'seat', 'note'] as const) {
    if (key in body) {
      const v = String(body[key] ?? '').trim()
      if (v.length > EXAM_ROW_MAX) throw new HttpError(400, `字段「${key}」最多 ${EXAM_ROW_MAX} 字`)
      out[key] = v
    }
  }
  if ('source' in body) {
    const s = String(body.source ?? '')
    if (s !== 'mis' && s !== 'manual') throw new HttpError(400, 'source 需为 mis 或 manual')
    out.source = s
  }
  // 上面已保证 courseName / examDate 非空，这里收窄成完整输入
  return out as ExamInput
}

/** 列出考试（按日期升序） */
app.get('/api/exams', authenticate, (req, res) => {
  try {
    res.json(listExams(uid(req)))
  } catch (err) {
    fail(res, err)
  }
})

/** 手动添加一条考试 */
app.post('/api/exams', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const input = validateExamBody((req.body ?? {}) as Record<string, unknown>)
    const e = createExam(userId, { ...input, source: input.source ?? 'manual' })
    res.status(201).json(e)
  } catch (err) {
    fail(res, err)
  }
})

/** 删除一条考试（不会删除已生成的 DDL 任务，避免用户误删待办） */
app.delete('/api/exams/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    deleteExam(userId, intParam(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/** 单条考试转 DDL：已转过则复用原任务，返回任务详情 */
app.post('/api/exams/:id/to-task', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    /* 2026-10-23 修（评审 A8）：examToTask 内部是「插任务 + 回写 exams.task_id」两条写，
       包进事务避免中途失败留下无主任务。有自愈性（下次再转会复用/补写），优先级低；
       replaceExams 的批量路径本来就在 tx() 里调用它，不冲突（tx 不可嵌套，路由层是外层）。 */
    const r = tx(() => examToTask(userId, intParam(req.params.id)))
    if (!r) throw new HttpError(404, '考试不存在')
    res.json({ ok: true, ...r, task: getTask(userId, r.taskId) })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 整表覆盖导入 + 可选一键生成 DDL。
 * body: { exams: [...], createDdl?: boolean }
 * 事务执行：删光旧考试再写入新的；createDdl 为 true 时每场考试保证有一条 DDL（已存在则复用）。
 */
app.post('/api/exams/import', authenticate, requireRealUser, (req, res) => {
  try {
    const userId = uid(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const raw = body.exams
    if (!Array.isArray(raw)) throw new HttpError(400, 'exams 需为数组')
    if (raw.length > 200) throw new HttpError(400, '一次最多导入 200 场考试')
    const rows = raw.map((r) => validateExamBody((r ?? {}) as Record<string, unknown>))
    const createDdl = body.createDdl === true
    const result = replaceExams(userId, rows, { createDdl })
    res.json({ ok: true, ...result })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 物理实验课表（已下架，仅保留兼容占位） ====================
 * 该功能（实验教学教务管理系统的实验选课表导入与展示）已从产品中移除。
 * 数据库表 lab_courses 与用户已导入的实验数据**原样保留**，不做 DROP ——
 * 删表不可逆，而保留一张不再读写的表零成本；如确需彻底清理，请另行确认后手动删表。
 *
 * 这里保留同名路由，是为了让仍在运行的旧客户端（已安装的 Android APK、浏览器缓存里的
 * 老版本前端）不会因为 404 而报错或白屏：
 *   - 读接口返回空结果 → 旧客户端表现为"没有实验"，不崩；
 *   - 写接口返回 410 Gone → 明确告知功能已下线。
 */

/** 已下架功能的统一响应：410 Gone + 业务文案 */
function labRetired(res: Response): void {
  res.status(410).json({ error: '物理实验课表功能已下架' })
}

/** 列出实验：功能已下架，返回空列表（兼容旧客户端，避免 404 报错） */
app.get('/api/lab-courses', authenticate, (_req, res) => {
  res.json([])
})

/** 删除实验：功能已下架，空操作成功（旧客户端不会因报错中断） */
app.delete('/api/lab-courses/:id', authenticate, (_req, res) => {
  res.json({ ok: true })
})

/** 实验整表替换导入：功能已下架 */
app.post('/api/lab-courses/import-replace', authenticate, (_req, res) => {
  labRetired(res)
})

/** 实验选课表截图识别：功能已下架 */
app.post('/api/courses/recognize-lab-photo', authenticate, requireRealUser, (_req, res) => {
  labRetired(res)
})

/* tasks */
app.get('/api/tasks', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const { status, type, from, to } = req.query
    const filter: { status?: string; type?: string; from?: string; to?: string } = {}
    if (typeof status === 'string' && status) {
      if (!STATUSES.includes(status as TaskStatus)) throw new HttpError(400, 'status 非法')
      filter.status = status
    }
    if (typeof type === 'string' && type) {
      if (!TASK_TYPES.includes(type as TaskType)) throw new HttpError(400, 'type 非法')
      filter.type = type
    }
    if (typeof from === 'string' && from) {
      if (!isValidISODate(from)) throw new HttpError(400, 'from 非法')
      filter.from = from
    }
    if (typeof to === 'string' && to) {
      if (!isValidISODate(to)) throw new HttpError(400, 'to 非法')
      filter.to = to
    }
    res.json(listTasks(userId, filter))
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/tasks', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const t = validateTaskBody(req.body ?? {}, false)
    const info = db
      .prepare(
        `INSERT INTO tasks (user_id, title, course_id, type, due_date, due_time, priority, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, t.title!, t.courseId ?? null, t.type!, t.dueDate!, t.dueTime ?? '', t.priority ?? 'medium',
        t.status ?? 'pending', t.notes ?? '')
    res.status(201).json(getTask(userId, Number(info.lastInsertRowid)))
  } catch (err) {
    fail(res, err)
  }
})

app.put('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const id = intParam(req.params.id)
    if (!getTask(userId, id)) throw new HttpError(404, '任务不存在')
    const t = validateTaskBody(req.body ?? {}, true)
    const sets: string[] = []
    const params: SQLInputValue[] = []
    const map: Record<string, string> = {
      title: 'title', courseId: 'course_id', type: 'type', dueDate: 'due_date',
      dueTime: 'due_time', priority: 'priority', status: 'status', notes: 'notes'
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in t) {
        sets.push(`${col} = ?`)
        params.push(t[k as keyof Task] as string | number | null)
      }
    }
    if (sets.length === 0) throw new HttpError(400, '没有可更新的字段')
    params.push(id, userId)
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params)
    res.json(getTask(userId, id))
  } catch (err) {
    fail(res, err)
  }
})

app.delete('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(intParam(req.params.id), userId)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/tasks/:id/toggle', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const id = intParam(req.params.id)
    const t = getTask(userId, id)
    if (!t) throw new HttpError(404, '任务不存在')
    if (t.status === 'done') {
      db.prepare(`UPDATE tasks SET status = 'pending', done_at = NULL WHERE id = ? AND user_id = ?`).run(id, userId)
    } else {
      db.prepare(`UPDATE tasks SET status = 'done', done_at = datetime('now') WHERE id = ? AND user_id = ?`).run(id, userId)
    }
    res.json(getTask(userId, id))
  } catch (err) {
    fail(res, err)
  }
})

/* 手动拖拽排序：ids 顺序即目标顺序，sort_order 按 1..n 写入 */
app.post('/api/tasks/reorder', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const ids = (req.body ?? {}).ids
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'ids 需为非空数组')
    /* 上限 500：这是 N 条同步 UPDATE，8mb 的 body 能塞进十万个 id，
       足够把事件循环卡住好几秒（node:sqlite 是同步 API，期间全站排队）。
       500 远超任何真实用户的任务数。 */
    if (ids.length > 500) throw new HttpError(400, '一次最多重排 500 条任务')
    /* 先全量校验再写库：否则"前 3 条已改、第 4 条非法"会留下半新半旧的顺序。 */
    const parsed = ids.map((id) => {
      const n = Number(id)
      if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'ids 含非法值')
      return n
    })
    const stmt = db.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ? AND user_id = ?`)
    /* 事务：中途任何一条失败都整体回滚，不会出现"顺序改了一半"。
       这是本项目里最容易产生"数据半写"的写路径之一（N 条 UPDATE 裸奔）。 */
    tx(() => {
      parsed.forEach((id, i) => stmt.run(i + 1, id, userId))
    })
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/* 一键清空已完成任务：只删当前用户 status=done 的任务 */
app.post('/api/tasks/clear-done', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const info = db.prepare(`DELETE FROM tasks WHERE user_id = ? AND status = 'done'`).run(userId)
    res.json({ ok: true, deleted: Number(info.changes) })
  } catch (err) {
    fail(res, err)
  }
})

/* week + month + overview */
app.get('/api/week', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined
    if (date && !isValidISODate(date)) throw new HttpError(400, 'date 需为合法日期 YYYY-MM-DD')
    /* inactive=1：额外下发「本学期有课但本周不上」的课程（课表页「显示非本周课程」开关用）。
       做成显式开关而不是默认返回：这份数据通常是本周课程的一到两倍，而绝大多数用户并不需要。 */
    const includeInactive = req.query.inactive === '1'
    res.json(getWeekData(userId, date ?? toISODate(new Date()), { includeInactive }))
  } catch (err) {
    fail(res, err)
  }
})

/* 首页聚合：一次请求返回「本周 + 概览 + 考试」。
   为什么要有它：首页此前打 3 个接口（week / overview / exams），
   而这三个接口都要过一遍 authenticate（每次一次 sessions⋈users 查询），
   返回体里还各自带一份任务数据。合并后：1 次鉴权、1 个往返、数据只序列化一次。
   注意这**不是**"把 week 和 overview 的数据拼一起"那么简单 —— 两者共用同一份
   listTasks 结果，合并后服务端也少查一次库（见 getOverview/getWeekData 的实现）。 */
app.get('/api/home', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined
    if (date && !isValidISODate(date)) throw new HttpError(400, 'date 需为合法日期 YYYY-MM-DD')
    const day = date ?? toISODate(new Date())
    res.json({
      week: getWeekData(userId, day),
      overview: getOverview(userId),
      exams: listExams(userId)
    })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 首页账户状态：新邮件数 / 校园卡余额 / 校园网余额。
 *
 * 独立接口而不是塞进 `/api/home`：`/api/home` 是**每次进首页都调**的本地库查询
 * （毫秒级、离线可用），而这里要打学校接口（几百毫秒到几秒、需要 MIS 会话）。
 * 混在一起会让首页在本校接口抽风时整页加载失败。
 *
 * 前端策略：这个接口失败只把状态卡隐藏/标错，不影响首页其它内容。
 */
app.get('/api/home/status', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  const sid = String(req.query.sid ?? '')
  if (!sid) throw new HttpError(400, '缺少 sid（请先在应用内登录教务）')
  try {
    const r = await misFetchHomeStatus(sid, uid(req))
    res.json({ ok: true, ...r })
  } catch (err) {
    /* 解析失败是"学校接口变了"，不是用户的错 → 502 而不是 400 */
    if (err instanceof HomeStatusParseError) {
      res.status(502).json({ error: describeHomeStatusError(err) })
      return
    }
    misFail(res, err)
  }
}))

/* ==================== 教室占用（教务 room_view 占用矩阵） ====================
 *
 * 数据源：`{AA_ORIGIN}/classroom/timeholdresult/room_view/?zc=&jxlh=&zxjxjhh=`
 *   - `zc`     教学周次（1-53）
 *   - `jxlh`   教学楼**数字 ID**（见 server/src/classroomOccupancy.ts 的 OCCUPANCY_BUILDINGS）
 *   - `zxjxjhh` 学期 value（可选，省略 = 教务认为的当前学期）
 *
 * 这是「这一周这间教室被谁占了」，和下面 `/api/classroom/capacity` 的
 * 「此刻这间教室有多少人」**不是一回事**，别合并。
 *
 * ⚠️ 需要教务会话（sid），并且必须挂 requireRealUser —— 游客没有 MIS 账号。
 * ⚠️ 不缓存：占用数据即查即弃。
 */

app.get('/api/classroom/occupancy/buildings', (_req, res) => {
  res.json({ ok: true, buildings: OCCUPANCY_BUILDINGS, slotTimes: SLOT_TIME_RANGES })
})

app.get('/api/classroom/occupancy', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const sid = String(req.query.sid ?? '')
    if (!sid) throw new HttpError(400, '缺少 sid（请先在应用内登录教务）')
    const week = Number(req.query.week)
    if (!Number.isInteger(week)) throw new HttpError(400, 'week 需为整数（教学周次）')
    const buildingId = String(req.query.building ?? '').trim()
    if (!buildingId) throw new HttpError(400, '缺少 building 参数（教学楼 ID）')
    const semesterId = String(req.query.term ?? '').trim() || undefined
    const data = await misFetchOccupancy(sid, uid(req), week, buildingId, semesterId)
    res.json({ ok: true, ...data, slotTimes: SLOT_TIME_RANGES, kindLabels: OCCUPANCY_KIND_LABEL })
  } catch (err) {
    if (err instanceof ClassroomOccupancyParseError) {
      /* 解析失败是"教务页面改版了"，不是用户的错 → 502 */
      res.status(502).json({ error: `${err.message}（教务页面可能已改版）` })
      return
    }
    misFail(res, err)
  }
}))

app.get('/api/classroom/occupancy/semesters', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const sid = String(req.query.sid ?? '')
    if (!sid) throw new HttpError(400, '缺少 sid（请先在应用内登录教务）')
    const options = await misFetchOccupancySemesters(sid, uid(req))
    res.json({ ok: true, ...options })
  } catch (err) {
    misFail(res, err)
  }
}))

app.get('/api/month', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined
    if (date && !isValidISODate(date)) throw new HttpError(400, 'date 需为合法日期 YYYY-MM-DD')
    res.json(getMonthData(userId, date ?? toISODate(new Date())))
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/overview', authenticate, (req, res) => {
  res.json(getOverview(uid(req)))
})

/* admin：用户管理 */

/* ---------------- 活跃度口径（服务端统一定义，前端只负责展示） ----------------
   - 活跃时间 lastActivityAt = max(最后访问 last_seen_at, 最近发帖, 最近评论)
     为什么不是只看登录：有人只在网页上挂着一个长期会话（30 天），
     期间发过帖却从没重新登录 —— 只看 last_seen_at 反而会把他判成沉默用户。
   - 分级（阈值按"大学校园应用的访问频率"取，偏宽松，避免误伤周更用户）：
       active 活跃   ≤ 3 天
       normal 一般   ≤ 14 天
       silent 沉默   > 14 天
       never  从未   没有任何活跃痕迹（含本功能上线前的老用户）
   改阈值只改这里，前端不重复实现。 */

export type ActivityLevel = 'active' | 'normal' | 'silent' | 'never'

const ACTIVE_DAYS = 3
const NORMAL_DAYS = 14

/** 服务端时间（UTC, 'YYYY-MM-DD HH:mm:ss'）→ 时间戳；空/非法 → 0（便于直接取 max） */
function serverTimeMs(s: string | null | undefined): number {
  if (!s) return 0
  const t = Date.parse(`${s.replace(' ', 'T')}Z`)
  return Number.isNaN(t) ? 0 : t
}

/** 聚合出「最后活跃时间」：访问 / 提反馈 两者取最新 */
function lastActivityOf(row: { lastSeenAt: string | null; lastFeedbackAt: string | null }): string | null {
  const t = Math.max(serverTimeMs(row.lastSeenAt), serverTimeMs(row.lastFeedbackAt))
  return t > 0 ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : null
}

function activityLevel(lastActivityAt: string | null, nowMs: number): ActivityLevel {
  const t = serverTimeMs(lastActivityAt)
  if (t === 0) return 'never'
  const days = (nowMs - t) / 86_400_000
  if (days <= ACTIVE_DAYS) return 'active'
  if (days <= NORMAL_DAYS) return 'normal'
  return 'silent'
}

/** 活跃度明细所需的字段（列表与详情共用，避免两处 SQL 漂移）。
 *  论坛下架后，这里的"发帖/评论"口径换成"反馈工单" —— 否则活跃度看板里
 *  所有人的 postCount/commentCount 都会冻在历史值上，永远不再变化。 */
const ACTIVITY_COLS = `
  u.id, u.username, u.nickname, u.role, u.created_at AS createdAt,
  u.last_seen_at AS lastSeenAt,
  (SELECT COUNT(*) FROM courses   c WHERE c.user_id = u.id) AS courseCount,
  (SELECT COUNT(*) FROM tasks     t WHERE t.user_id = u.id) AS taskCount,
  (SELECT COUNT(*) FROM feedbacks f WHERE f.user_id = u.id) AS feedbackCount,
  (SELECT COUNT(*) FROM feedbacks f WHERE f.user_id = u.id AND f.status = 'pending') AS feedbackPending,
  (SELECT MAX(f.created_at) FROM feedbacks f WHERE f.user_id = u.id) AS lastFeedbackAt`

/* ⚠️ 必须排除一次性游客账号（u.is_guest = 0）：游客是"清个缓存就多一个"的一次性账号，
   混进来会把用户管理页刷成一屏无意义的 `guest:xxxx`，真正需要关注的用户被挤到看不见。
   注意反馈工单列表**不**做这个排除 —— 游客提的反馈也是要处理的工单。 */
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
  /* 2026-10-23 修（评审 A6）：本列表随注册数无界增长，是最先值得补分页的接口。
     每行还带 3 个相关子查询（课程/任务/反馈计数），全量拉取的成本比普通列表更高。
     limit 上限 500，前端「加载更多」翻页；total 供前端显示「共 N 个账号」。 */
  const rawLimit = Number(req.query.limit)
  const rawOffset = Number(req.query.offset)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 500) : 200
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE u.is_guest = 0`).get() as unknown as { n: number }
  ).n
  const rows = db
    .prepare(
      `SELECT ${ACTIVITY_COLS} FROM users u WHERE u.is_guest = 0 ORDER BY u.id LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as unknown as Array<{
    id: number; username: string; nickname: string; role: UserRole; createdAt: string
    lastSeenAt: string | null; courseCount: number; taskCount: number
    feedbackCount: number; feedbackPending: number; lastFeedbackAt: string | null
  }>
  const nowMs = Date.now()
  res.json({
    total,
    items: rows.map((r) => {
      const lastActivityAt = lastActivityOf(r)
      return { ...r, lastActivityAt, level: activityLevel(lastActivityAt, nowMs) }
    })
  })
})

/**
 * admin：全站概览统计（活跃度看板顶部卡片）。
 * 全部走 COUNT + 条件聚合，一次查询出齐，避免前端拿全量用户自己算。
 */
/* ⚠️ 所有用户口径都必须排除游客（is_guest = 0），否则"全站用户数 / 活跃数 / 新增数"
   会被一次性游客账号灌水，看板失去意义（游客清个缓存就多一个）。
   课程 / 任务数同样排除游客数据：它们属于一次性账号，最多 14 天后就会被回收，
   算进来只会让数字随时间抖动。反馈工单计数**不排除**（游客提的也是待处理的工单）。 */
app.get('/api/admin/stats', authenticate, requireAdmin, (_req, res) => {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE is_guest = 0)    AS totalUsers,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND role = 'admin') AS adminCount,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND last_seen_at >= datetime('now', '-7 days'))  AS active7d,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND last_seen_at >= datetime('now', '-30 days')) AS active30d,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND last_seen_at IS NULL) AS neverActive,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND created_at >= date('now'))                   AS newToday,
              (SELECT COUNT(*) FROM users WHERE is_guest = 0 AND created_at >= datetime('now', '-7 days'))    AS new7d,
              /* 一次性游客账号数：单独一列展示，让人知道"数据库里还有多少待回收的账号" */
              (SELECT COUNT(*) FROM users WHERE is_guest = 1) AS guestCount,
              (SELECT COUNT(*) FROM courses c JOIN users u ON u.id = c.user_id WHERE u.is_guest = 0) AS courseCount,
              (SELECT COUNT(*) FROM tasks   t JOIN users u ON u.id = t.user_id WHERE u.is_guest = 0) AS taskCount,
              /* 论坛下架后，概览里原本的帖子/评论计数已无意义（只减不增），
                 换成反馈工单口径：管理员最关心的"有多少条没人处理"。 */
              (SELECT COUNT(*) FROM feedbacks) AS feedbackCount,
              (SELECT COUNT(*) FROM feedbacks WHERE status = 'pending') AS feedbackPending,
              /* 待处理的密码重置申请：后台角标用量。走不通登录的用户全靠这条通道，
                 积压了要及时处理，所以放进概览里让它显眼。 */
              (SELECT COUNT(*) FROM password_resets WHERE status = 'pending') AS resetPending`
    )
    .get() as unknown as Record<string, number>
  res.json(row)
})

/**
 * admin：单个用户的活跃度明细（点列表行打开）。
 * recent 是「发帖 + 评论」合并后的最近动态，让管理员能看出这个账号到底在干什么，
 * 而不只是看一堆计数（计数只能回答"有多少"，回答不了"最近用不用"）。
 */
app.get('/api/admin/users/:id/activity', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    /* is_guest = 0：游客账号不在用户管理范围内，按「不存在」处理（与列表口径一致） */
    const row = db.prepare(`SELECT ${ACTIVITY_COLS} FROM users u WHERE u.id = ? AND u.is_guest = 0`).get(id) as unknown as ({
      id: number; username: string; nickname: string; role: UserRole; createdAt: string
      lastSeenAt: string | null; courseCount: number; taskCount: number
      feedbackCount: number; feedbackPending: number; lastFeedbackAt: string | null
    } | undefined)
    if (!row) throw new HttpError(404, '用户不存在')

    /* 最近动态：原来合并"发帖 + 评论"，论坛下架后改为该用户提交的反馈工单，
       并带上状态，管理员一眼能看出这人最近是在报错还是在提建议。 */
    const feedbacks = db
      .prepare(
        `SELECT f.id, f.title, f.type, f.status, f.created_at AS createdAt
         FROM feedbacks f WHERE f.user_id = ?
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT 10`
      )
      .all(id) as unknown as Array<{
        id: number; title: string; type: string; status: string; createdAt: string
      }>

    const recent = feedbacks.map((f) => ({
      kind: 'feedback' as const,
      id: f.id,
      text: f.title,
      feedbackType: f.type,
      status: f.status,
      createdAt: f.createdAt
    }))

    const lastActivityAt = lastActivityOf(row)
    res.json({
      user: {
        id: row.id, username: row.username, nickname: row.nickname, role: row.role,
        createdAt: row.createdAt, lastSeenAt: row.lastSeenAt
      },
      counts: {
        courses: row.courseCount,
        tasks: row.taskCount,
        feedbacks: row.feedbackCount,
        feedbackPending: row.feedbackPending
      },
      lastActivityAt,
      level: activityLevel(lastActivityAt, Date.now()),
      recent
    })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * admin：查看指定用户的课表。
 * 只读接口，供管理员排查「某用户课表是否导入成功」；课程按周一次序返回（listCourses 已排序）。
 */
app.get('/api/admin/users/:id/courses', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    const u = db
      .prepare(`SELECT id, username, nickname, role FROM users WHERE id = ? AND is_guest = 0`)
      .get(id) as { id: number; username: string; nickname: string; role: UserRole } | undefined
    if (!u) throw new HttpError(404, '用户不存在')
    /* 与用户自己在课表页所见保持一致：只看得到「当前学期」的课（多学期后不再是全部） */
    res.json({ user: u, courses: listCourses(id, getSettings(id).currentTermId) })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/admin/users', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    /* 凭据走统一信封（与登录/注册/教务登录同一条路）。
       `CRED_REQUIRE_ENCRYPTED=1` 的含义是"全站不再收明文密码"，后台建号若是例外，
       这个开关就名不副实：运维以为关了，实际还留着一条收明文的链路，
       而这条链路的请求体里带着**别人的**新密码。 */
    const secret = credentialEnvelope(body)
    const username = readCredField(body, secret, 'username').trim()
    const password = readCredField(body, secret, 'password')
    const nickname = String(body.nickname ?? '').trim()
    const role = ((body.role ?? 'user') as UserRole)
    if (username.length < 3) throw new HttpError(400, '用户名需至少 3 个字符')
    const weak = checkPasswordStrength(password, { username })
    if (weak) throw new HttpError(400, weak)
    if (role !== 'admin' && role !== 'user') throw new HttpError(400, '角色非法')
    if (usernameTaken(username)) throw new HttpError(409, '该账号已存在')
    const user = await createUser(username, password, role, nickname)
    res.status(201).json({ id: user.id, username: user.username, nickname: user.nickname, role })
  } catch (err) {
    fail(res, err)
  }
}))

app.put('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    if (!findUser(id)) throw new HttpError(404, '用户不存在')
    const body = req.body ?? {}
    const sets: string[] = []
    const params: SQLInputValue[] = []
    if ('username' in body) {
      const u = String(body.username ?? '').trim()
      if (u.length < 3) throw new HttpError(400, '用户名需至少 3 个字符')
      /* ⚠️ 查重必须在这里做，不能指望 UNIQUE 约束：
         约束会抛 SQLITE_CONSTRAINT，fail() 把它当未知错误映射成 **500**，
         管理员看到的提示是"服务器内部错误"，完全不知道是自己撞了名。
         另外要排除"改成自己的原名"这种空操作，否则管理员点一下保存就 409。
         用 usernameTaken（包含游客）——与注册口同一口径：游客也占着账号名，
         漏掉的话改名会撞进约束里，又绕回 500。 */
      const cur = findUser(id)
      if (u !== cur?.username && usernameTaken(u)) {
        throw new HttpError(409, '该账号已被占用')
      }
      sets.push('username = ?')
      params.push(u)
    }
    if ('role' in body) {
      const r = String(body.role) as UserRole
      if (r !== 'admin' && r !== 'user') throw new HttpError(400, '角色非法')
      sets.push('role = ?')
      params.push(r)
    }
    if (sets.length === 0) throw new HttpError(400, '没有可更新的字段')
    params.push(id)
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    res.json(findUser(id))
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/admin/users/:id/reset-password', authenticate, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const id = intParam(req.params.id)
    const body = (req.body ?? {}) as Record<string, unknown>
    /* 与建号同理：管理员重置密码也必须走信封，否则 CRED_REQUIRE_ENCRYPTED 有了例外。
       ⚠️ readCredField 必须在**任何写操作之前**调用 —— 它在强制态下会抛 400，
       如果先 setUserPassword 再读字段，密码已经被改掉了，状态码却还是 400，
       用户看到"失败"但密码已经变了（回归用例专门断言了这一条副作用）。 */
    const secret = credentialEnvelope(body)
    const password = readCredField(body, secret, 'password')
    /* 先把目标账号查出来，才能把"密码不得包含账号"一并校验 ——
       否则重置接口会变成绕过该策略的后门（设一个含账号的弱密码）。 */
    const target = findUser(id)
    if (!target) throw new HttpError(404, '用户不存在')
    const weak = checkPasswordStrength(password, { username: target.username })
    if (weak) throw new HttpError(400, weak)
    await setUserPassword(id, password)
    /* 重置密码的语义就是"把不认识的人踢下线"：用户来求助时说的通常是"我号被盗了"。
       只换密码不删会话，攻击者手里的 token 还能继续用 30 天 —— 等于什么都没做。
       与 approvePasswordReset（db.ts）保持同一语义。 */
    revokeAllSessions(id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
}))

/* 存量用户补种示例数据接口已移除：新用户注册不再写入示例课程/DDL，管理员后台也不需要补种按钮 */
app.delete('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    if (id === (req as AuthedRequest).user!.id) throw new HttpError(400, '不能删除当前登录的管理员账号')
    if (!findUser(id)) throw new HttpError(404, '用户不存在')
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 前端错误上报 ====================

   为什么需要它：React 的渲染异常会卸载整棵树（用户看到白屏），而控制台里的报错
   用户根本不会转述 —— 这类工单此前只能靠猜。前端在 window.onerror /
   unhandledrejection / ErrorBoundary 里调用这个接口，后台按时间倒序查看。

   三条刻意的设计：
   1. **不因为上报失败而报错**：这是诊断通道，不是业务通道。超限时静默丢弃（返回 ok），
      否则一个崩溃循环会变成"崩溃 + 上报失败 + 用户又看到一条报错"。
   2. **只存 message / 前 2KB 堆栈 / url / ua**：不存 DOM、不存用户数据、不存截图。
   3. 长度一律在**服务端**再截一次：前端截断不可信。 */
const clientErrorLimit = makeSlidingWindowLimiter(3600_000, 30)

app.post('/api/client-errors', (req, res) => {
  try {
    /* 2026-10-23 修（评审 A5）：改为**可选身份** + IP 限流。原实现挂了 authenticate，
       但表结构明说 user_id 允许 NULL（"登录页崩了就还没有 userId"）——
       最需要上报的场景（登录页崩溃 / token 失效后的白屏）恰好被 401 挡住，
       一条都进不来。限流键登录用户用 uid、匿名退回 IP。 */
    const body = (req.body ?? {}) as Record<string, unknown>
    const token = getToken(req)
    const user = token ? getSessionUser(token) : null
    const userId = user?.id ?? null
    if (!clientErrorLimit.hit(userId !== null ? `u${userId}` : `ip${req.ip || req.socket.remoteAddress || 'unknown'}`)) {
      res.json({ ok: true })
      return
    }
    const clip = (v: unknown, n: number): string => String(v ?? '').slice(0, n)
    const message = clip(body.message, 500).trim()
    if (!message) throw new HttpError(400, 'message 不能为空')
    recordClientError({
      userId,
      message,
      stack: clip(body.stack, 2000),
      url: clip(body.url, 300),
      ua: clip(body.ua, 300)
    })
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/admin/client-errors', authenticate, requireAdmin, (req, res) => {
  try {
    const raw = Number(req.query.limit ?? 100)
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 100
    res.json({ items: listClientErrors(limit) })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 个人中心：反馈工单 ==================== */

/* 反馈图片上传：与论坛时代的 /api/forum/upload 同一套逻辑（客户端压成 dataURL → 服务端解码存文件）。
   保留同一份白名单与体积上限；文件名仍由服务端随机生成，不接受客户端路径。 */
const UPLOAD_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])
const UPLOAD_MAX_BINARY = 3 * 1024 * 1024

/* 上传限流：这是全站**唯一直接写磁盘**的接口，此前只有 authenticate（游客也能调），
   单次 3MB、无次数上限 —— 建一个游客号就能循环写盘，孤儿清理要 24 小时后才回收。

   三道约束：
   ① 只允许真实账号（游客注册是免费的，20 个/小时/IP，等于无限磁盘配额）；
      游客仍可提交**纯文字**反馈，只是不能附图 —— 前端会给出对应提示；
   ② 每小时 30 张/用户（正常人一次反馈最多附 3~5 张）；
   ③ 全局每小时 300 张 —— 分布式刷号时的总闸门，避免把 ECS 磁盘写满。 */
const uploadLimit = makeSlidingWindowLimiter(3600_000, 30)
const uploadGlobalLimit = makeSlidingWindowLimiter(3600_000, 300)
const UPLOAD_GLOBAL_KEY = 'upload:global'

app.post('/api/feedback/upload', authenticate, requireRealUser, (req, res) => {
  try {
    if (!uploadLimit.hit(String(uid(req)))) {
      throw new HttpError(429, '上传过于频繁，请稍后再试')
    }
    if (!uploadGlobalLimit.hit(UPLOAD_GLOBAL_KEY)) {
      throw new HttpError(429, '当前上传人数较多，请稍后再试')
    }
    const data = String((req.body ?? {}).data ?? '')
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data)
    if (!m) throw new HttpError(400, '图片格式不正确')
    const [, mime, b64] = m
    if (!UPLOAD_ALLOWED.has(mime)) throw new HttpError(400, '仅支持 png / jpg / webp 图片')
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0) throw new HttpError(400, '图片内容为空')
    if (buf.length > UPLOAD_MAX_BINARY) throw new HttpError(400, '图片太大（压缩后仍超过 3MB）')
    /* 体积检查之后再嗅探：先做便宜的判断，避免为超大 buffer 白跑一遍解析。
       校验"真实字节"与"声明 MIME"是否一致 —— 声明可伪造，文件头不能。
       详见 imageType.ts 的说明（这是 M-1 的修复点）。 */
    const inconsistent = checkImageConsistency(mime, buf)
    if (inconsistent) throw new HttpError(400, inconsistent)
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    const name = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.${ext}`
    writeFileSync(join(uploadsDir, name), buf)
    res.status(201).json({ url: `/uploads/${name}` })
  } catch (err) {
    fail(res, err)
  }
})

/* 提交频率限制：10 条/小时/用户。
   反馈会触发一封发给管理员的邮件，不限流等于给任何人一个"用我们的邮箱刷屏"的入口。
   按**用户 id** 而不是 IP 计数：这里的滥用者是登录用户，IP 会因校园网 NAT 而误伤整个宿舍。 */
const feedbackLimit = makeSlidingWindowLimiter(60 * 60_000, 10)

app.post('/api/feedback', authenticate, (req, res) => {
  try {
    const userId = uid(req)
    if (!feedbackLimit.hit(String(userId))) {
      throw new HttpError(429, '提交太频繁了，请稍后再试')
    }
    const body = req.body ?? {}
    const typeRaw = String(body.type ?? 'other')
    const id = createFeedback(userId, {
      type: (FEEDBACK_TYPES as string[]).includes(typeRaw) ? (typeRaw as FeedbackType) : 'other',
      title: String(body.title ?? ''),
      content: String(body.content ?? ''),
      contact: String(body.contact ?? ''),
      images: Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === 'string') : []
    })
    /* 邮件提醒是 fire-and-forget：工单已落库，管理员在后台必然看得到，
       不该让用户为"发一封提醒"多等几秒 SMTP 往返（详见 feedback.ts 注释）。 */
    const created = getFeedbackById(id)
    if (created) notifyAdminsByMail(created)
    res.status(201).json({ id })
  } catch (err) {
    /* 这里不再需要"把纯 Error 降级成 400"的包装：createFeedback 的校验错误
       已经改成抛 HttpError（见 feedback.ts）。原先那层包装会把该函数内**任何**
       Error（包括 SQLite 的约束错误）都当 400 并把 message 回显给客户端。 */
    fail(res, err)
  }
})

app.get('/api/feedback/mine', authenticate, (req, res) => {
  try {
    res.json(listMyFeedbacks(uid(req)))
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/feedback/mine/stats', authenticate, (req, res) => {
  try {
    res.json(myFeedbackStats(uid(req)))
  } catch (err) {
    fail(res, err)
  }
})

/* 管理端列表：支持 type / status / q 筛选与分页 */
app.get('/api/feedback/admin', authenticate, requireAdmin, (req, res) => {
  try {
    const { type, status, q, limit, offset } = req.query
    /* 分页参数必须过 Number.isFinite：`?limit=abc` 会让 Number() 得到 NaN，
       而 NaN 一路传到 SQL 的 `LIMIT ?` 会抛 `datatype mismatch` —— 客户端参数写错
       却收到 500，日志里还留下一条看起来像"数据库坏了"的错误。 */
    const toInt = (v: unknown): number | undefined => {
      if (v === undefined || v === '') return undefined
      const n = Number(v)
      return Number.isFinite(n) ? Math.trunc(n) : undefined
    }
    res.json(
      listAllFeedbacks({
        type: (FEEDBACK_TYPES as string[]).includes(String(type)) ? (type as FeedbackType) : undefined,
        status: (FEEDBACK_STATUSES as string[]).includes(String(status)) ? (status as FeedbackStatus) : undefined,
        q: typeof q === 'string' && q.trim() ? q.trim() : undefined,
        limit: toInt(limit),
        offset: toInt(offset)
      })
    )
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/feedback/admin/stats', authenticate, requireAdmin, (_req, res) => {
  try {
    res.json(feedbackStats())
  } catch (err) {
    fail(res, err)
  }
})

/* 工单详情。权限判定在 getFeedbackDetail 内完成（本人或管理员），此处不再重复。 */
app.get('/api/feedback/:id', authenticate, (req, res) => {
  try {
    const viewer = (req as AuthedRequest).user!
    const detail = getFeedbackDetail(viewer.id, viewer.role === 'admin', intParam(req.params.id))
    if (!detail) throw new HttpError(404, '反馈不存在')
    res.json(detail)
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/feedback/:id/reply', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    const content = String((req.body ?? {}).content ?? '')
    const reply = replyToFeedback(uid(req), id, content)
    if (!reply) throw new HttpError(404, '反馈不存在')
    res.status(201).json(reply)
  } catch (err) {
    fail(res, err)
  }
})

app.patch('/api/feedback/:id/status', authenticate, requireAdmin, (req, res) => {
  try {
    const id = intParam(req.params.id)
    const status = String((req.body ?? {}).status ?? '')
    const ok = setFeedbackStatus(id, status as FeedbackStatus)
    if (!ok) throw new HttpError(404, '反馈不存在')
    res.json({ ok: true, status })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 个人中心：站内信 ==================== */

app.get('/api/messages', authenticate, (req, res) => {
  try {
    res.json(listMessages(uid(req), req.query.unread === '1'))
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/messages/unread-count', authenticate, (req, res) => {
  try {
    res.json({ count: unreadMessageCount(uid(req)) })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/messages/:id/read', authenticate, (req, res) => {
  try {
    markMessageRead(uid(req), intParam(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/messages/read-all', authenticate, (req, res) => {
  try {
    res.json({ ok: true, changed: markAllMessagesRead(uid(req)) })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 论坛兼容占位（功能已下架） ====================

   论坛于 2026-10-01 整体下架，由「个人中心」取代。但这些路由**不能直接删掉**：
   线上有已发布的 Android APK，以及浏览器里缓存了旧 index.html 的用户，
   删掉路由会让他们的请求变成 404 —— 论坛页会白屏或弹一个英文错误，
   而用户根本不知道该干什么。

   因此按项目的下架约定保留同名路由：
     - 读接口返回**空结果**（200 [] / {count:0}）→ 旧前端渲染成"还没有内容"的空状态，不报错；
     - 写接口返回 **410 Gone** + 中文说明 → 旧前端会把这句话展示给用户，起到"请升级"的引导作用。
   真实数据仍在 posts/comments 等表中（见 db.ts 的下架说明），只是不再对外暴露。 */

const FORUM_GONE = '论坛功能已下线，相关内容已迁移到「个人中心」。请更新到最新版本。'

/** 写接口统一 410 */
function forumGone(res: Response): void {
  res.status(410).json({ error: FORUM_GONE })
}

/* 读接口：一律返回空。为什么不是 410 —— 旧前端对列表请求失败的处理是弹 toast + 保持加载态，
   返回空数组才能让它安静地显示空状态，这是"不打扰用户"的选择。 */
app.get('/api/forum/topics', authenticate, (_req, res) => {
  res.json([])
})

app.get('/api/forum/topics/hot', authenticate, (_req, res) => {
  res.json([])
})

app.get('/api/forum/posts', authenticate, (_req, res) => {
  res.json([])
})

/* 详情页是"读单个资源"，没有合理的空对象可返回（返回 {} 会让旧前端渲染成空白详情页，
   比明确告知下线更让人困惑），因此这里也走 410。 */
app.get('/api/forum/posts/:id', authenticate, (_req, res) => {
  res.status(410).json({ error: FORUM_GONE })
})

app.get('/api/forum/notifications', authenticate, (_req, res) => {
  res.json([])
})

app.get('/api/forum/notifications/unread-count', authenticate, (_req, res) => {
  res.json({ count: 0 })
})

/* 写接口 */
app.post('/api/forum/upload', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/posts', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/posts/:id/like', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/posts/:id/bump', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/posts/:id/view', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/posts/:id/comments', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/notifications/:id/read', authenticate, (_req, res) => forumGone(res))
app.post('/api/forum/notifications/read-all', authenticate, (_req, res) => forumGone(res))
app.delete('/api/forum/posts/:id', authenticate, (_req, res) => forumGone(res))
app.delete('/api/forum/comments/:id', authenticate, (_req, res) => forumGone(res))
app.patch('/api/forum/posts/:id/pin', authenticate, (_req, res) => forumGone(res))

/* ==================== 共享课表（空闲课表 / 情侣课表） ====================

   两套形态共用这一组接口，靠 group.kind 区分（'group' = 多人空闲课表，'couple' = 情侣课表）。
   为什么不拆成两套接口：它们是同一套数据的两种视图（见 share.ts 文件头），
   拆开会让"同步""退出""密钥""人数门槛"这些规则各存一份，迟早改漏一边。

   ⚠️ 全部要求**真实账号**（requireRealUser），而不是只挂 authenticate：
   共享的本质是"把我的课表交给别人看"，而游客账号是 14 天不活跃即回收的临时身份 ——
   用游客身份加入群组，等于给群主塞进一个随时会消失的成员，密钥里还会积一堆查无此人的僵尸。
   前端对应地在 App 层做登录引导（GuestAction = 'share'），服务端这里才是真正的拦截。 */

/* 加入群组/绑定的限流：密钥只有 6 位（32 字符表 ≈ 1.07e9 种组合），
   而 join 是"猜中即入群"—— 不限流就能对着它做在线枚举。
   正常用户一辈子点不了几次，10 次/小时不会误伤；密钥空间也远大于 10 次/小时能覆盖的量。 */
const shareJoinLimit = makeSlidingWindowLimiter(3600_000, 10)

app.get('/api/share/groups', authenticate, requireRealUser, (req, res) => {
  try {
    res.json({ groups: listMyShareGroups(uid(req), 'group') })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/groups', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    res.status(201).json({ group: createShareGroup(uid(req), { name: body.name, kind: 'group', threshold: body.threshold }) })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/groups/join', authenticate, requireRealUser, (req, res) => {
  try {
    /* 密钥只有 6 位（32 个字符的字母表，约 1.07e9 种），且 join 是"猜中即入群"——
       不限流的话可以对着它做在线枚举。正常用户一辈子点不了几次，10 次/小时足够。 */
    if (!shareJoinLimit.hit(String(uid(req)))) {
      throw new HttpError(429, '加入群组尝试过于频繁，请稍后再试')
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const group = joinShareGroup(uid(req), body.secret, 'group')
    res.json({ ok: true, id: group.id })
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/share/groups/:id', authenticate, requireRealUser, (req, res) => {
  try {
    res.json(getShareDetail(uid(req), intParam(req.params.id)))
  } catch (err) {
    fail(res, err)
  }
})

app.put('/api/share/groups/:id', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const group = updateShareGroup(uid(req), intParam(req.params.id), body)
    res.json({ ok: true, group })
  } catch (err) {
    fail(res, err)
  }
})

/** 解散群组（群主）。成员"退出"走 leave，两者分开是为了让前端把后果说清楚 */
app.delete('/api/share/groups/:id', authenticate, requireRealUser, (req, res) => {
  try {
    disbandShareGroup(uid(req), intParam(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/** 同步我的课表：服务端读当前学期的课程生成忙闲快照（周次口径只在服务端实现一份） */
app.post('/api/share/groups/:id/sync', authenticate, requireRealUser, (req, res) => {
  try {
    const m = syncShareMember(uid(req), intParam(req.params.id))
    res.json({ ok: true, syncedAt: m.syncedAt })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/groups/:id/rotate-secret', authenticate, requireRealUser, (req, res) => {
  try {
    res.json({ ok: true, secret: rotateShareSecret(uid(req), intParam(req.params.id)) })
  } catch (err) {
    fail(res, err)
  }
})

/** 我自己的隐私开关：是否把课程明细共享给同群成员（仅情侣形态生效） */
app.put('/api/share/groups/:id/privacy', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const m = setShareMemberPrivacy(uid(req), intParam(req.params.id), body.showDetail === true)
    res.json({ ok: true, showDetail: m.showDetail === 1 })
  } catch (err) {
    fail(res, err)
  }
})

app.delete('/api/share/groups/:id/members/:memberId', authenticate, requireRealUser, (req, res) => {
  try {
    const r = removeShareMember(uid(req), intParam(req.params.id), intParam(req.params.memberId))
    res.json({ ok: true, disbanded: r.disbanded })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/groups/:id/leave', authenticate, requireRealUser, (req, res) => {
  try {
    const r = leaveShareGroup(uid(req), intParam(req.params.id))
    res.json({ ok: true, disbanded: r.disbanded })
  } catch (err) {
    fail(res, err)
  }
})

/* ---- 情侣课表（同一套群组模型，kind='couple'，固定 2 人） ---- */

app.get('/api/share/couple', authenticate, requireRealUser, (req, res) => {
  try {
    const summary = getCoupleGroup(uid(req))
    if (!summary) {
      res.json({ couple: null })
      return
    }
    res.json({ couple: summary, detail: getShareDetail(uid(req), summary.id) })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/couple', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    res.status(201).json({ group: createCouple(uid(req), body.name) })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/share/couple/join', authenticate, requireRealUser, (req, res) => {
  try {
    /* 与 /api/share/groups/join 共用同一道闸门：两个入口是同一套密钥枚举面。 */
    if (!shareJoinLimit.hit(String(uid(req)))) {
      throw new HttpError(429, '绑定尝试过于频繁，请稍后再试')
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const group = joinCouple(uid(req), body.secret)
    res.json({ ok: true, id: group.id })
  } catch (err) {
    fail(res, err)
  }
})

app.delete('/api/share/couple', authenticate, requireRealUser, (req, res) => {
  try {
    const summary = getCoupleGroup(uid(req))
    if (!summary) {
      res.json({ ok: true })
      return
    }
    unbindCouple(uid(req), summary.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/* ---- 共同计划（情侣课表的「共同计划」板块，真正的双人共享实体） ----
 *
 * 为什么挂在 /api/share/couple/plans 而不是 /api/share/groups/:id/plans：
 *   共同计划**只对情侣形态开放**（群组形态是"找大家都有空的时间"，不是"约会"）。
 *   路径写死 couple 就不必在每个处理里再判一次 group.kind，也就不会出现
 *   "群组误调计划接口"这种需要额外防御的分支。
 *   groupId 由服务端从「我的情侣绑定」推导，前端不传 —— 前端传 id 就成了越权入口。
 */

/** 我的共同计划列表（未绑定返回空数组，不报错：新用户第一次进来是正常状态，不是错误） */
app.get('/api/share/couple/plans', authenticate, requireRealUser, (req, res) => {
  try {
    const summary = getCoupleGroup(uid(req))
    if (!summary) {
      res.json({ plans: [] })
      return
    }
    res.json({ plans: listPlans(uid(req), summary.id) })
  } catch (err) {
    fail(res, err)
  }
})

/** 发起计划：新建永远是 pending，等对方确认（见 plans.ts 的 createPlan 注释） */
app.post('/api/share/couple/plans', authenticate, requireRealUser, (req, res) => {
  try {
    const summary = getCoupleGroup(uid(req))
    if (!summary) throw new HttpError(400, '还没有绑定情侣课表')
    const plan = createPlan(uid(req), summary.id, (req.body ?? {}) as Record<string, unknown>)
    res.status(201).json({ plan })
  } catch (err) {
    fail(res, err)
  }
})

/** 对方回应：接受 / 婉拒（只有非发起人能调） */
app.post('/api/share/couple/plans/:id/respond', authenticate, requireRealUser, (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    res.json({ plan: respondPlan(uid(req), intParam(req.params.id), body.action) })
  } catch (err) {
    fail(res, err)
  }
})

/** 修改计划（只有发起人；改时间/标题/地点会退回 pending 并通知对方重新确认） */
app.put('/api/share/couple/plans/:id', authenticate, requireRealUser, (req, res) => {
  try {
    res.json({ plan: updatePlan(uid(req), intParam(req.params.id), (req.body ?? {}) as Record<string, unknown>) })
  } catch (err) {
    fail(res, err)
  }
})

/** 取消计划（任一方；终态再取消是幂等返回当前行，不报错） */
app.delete('/api/share/couple/plans/:id', authenticate, requireRealUser, (req, res) => {
  try {
    res.json({ plan: cancelPlan(uid(req), intParam(req.params.id)) })
  } catch (err) {
    fail(res, err)
  }
})

/* ==================== 日历订阅 ==================== */

app.get('/api/calendar/token', authenticate, (req, res) => {
  res.json({ feedToken: ensureFeedToken(uid(req)) })
})

app.post('/api/calendar/token', authenticate, (req, res) => {
  res.json({ feedToken: regenerateFeedToken(uid(req)) })
})

/* 无需登录的 ICS 订阅地址：/api/calendar/<feedToken>.ics
   - 默认带 VALARM 闹钟（订阅后系统日历才会真的弹提醒）
   - ?alarms=0 可关闭闹钟
   - ?download=1 触发附件下载（否则 inline 展示） */
app.get('/api/calendar/:feed', (req, res) => {
  const feed = req.params.feed ?? ''
  const token = feed.endsWith('.ics') ? feed.slice(0, -4) : feed
  const user = getUserByFeedToken(token)
  if (!user) {
    res.status(404).type('text/plain').send('订阅地址无效')
    return
  }
  const tasks = listTasks(user.id, { status: 'pending' })
  const ics = buildTaskIcs(tasks, {
    alarms: req.query.alarms !== '0',
    calName: `交大小助手 · ${user.nickname || user.username} 的 DDL`
  })
  res.set('Content-Type', 'text/calendar; charset=utf-8')
  res.set(
    'Content-Disposition',
    'download' in req.query
      ? 'attachment; filename="bjtu-helper.ics"'
      : 'inline; filename="bjtu-helper.ics"'
  )
  res.send(ics)
})

/* ==================== 独立平台账号与数据（CITEL / 物理在线 / 物理实验 / 演示实验） ====================
 *
 * 这四个平台（见 server/src/independentAccounts.ts 的协议表）各有独立账号密码，
 * 与统一身份认证无关。数据路由的形状刻意统一：
 *
 *   GET  /api/accounts                     列出已绑账号（只回 hasPassword）
 *   PUT  /api/accounts/:platform           保存/更新账号（保存前探活验证）
 *   DELETE /api/accounts/:platform         解绑
 *   POST /api/accounts/:platform/verify    重新验证已存账号
 *   GET  /api/platforms/:platform/snapshot 拉全量数据（5 分钟 TTL 缓存，?force=1 绕过）
 *
 * ⚠️ 全程挂 requireRealUser：抓一次快照要打十几个上游请求，游客账号不能碰。
 * ⚠️ 密码永不回传（toPublic 只给 hasPassword），路由层拿到的 password 只在
 *    本次请求生命周期内存在，不进日志、不进订阅 feed。
 */

/** PlatformError.code → HTTP 状态码。parse/network 归 502：页面改版或站点不可达，重试无解 */
const PLATFORM_HTTP_STATUS: Record<string, number> = {
  'no-account': 400,
  'login-failed': 400,
  'session-expired': 401,
  parse: 502,
  network: 502,
  unavailable: 503,
  'rate-limited': 429
}

/** 四个客户端各自声明的 PlatformCred 结构完全一致，合成一张表用 */
type PlatformCred = { username: string; password: string }

/** 保存账号前的探活函数表。网络类失败不阻塞保存（见 PUT 路由内注释） */
const ACCOUNT_VERIFIERS: Record<AccountPlatform, (cred: PlatformCred) => Promise<void>> = {
  citel: verifyCitelAccount,
  phyvlab: verifyPhyVlabAccount,
  physicslab: verifyPhysicsLabAccount,
  phydemo: verifyPhyDemoAccount
}

/** 全量数据抓取器表（GET /api/platforms/:platform/snapshot 分发用） */
const PLATFORM_FETCHERS: Record<AccountPlatform, (userId: number, cred: PlatformCred) => Promise<unknown>> = {
  citel: (userId, cred) => fetchCitelSnapshot(userId, cred),
  phyvlab: (userId, cred) => fetchPhyVlabSnapshot(userId, cred),
  physicslab: (userId, cred) => fetchPhysicsLabSnapshot(userId, cred),
  phydemo: (userId, cred) => fetchPhyDemoBookings(userId, cred)
}

/* ---------------- 校园网中继（三个物理平台的唯一出口） ----------------
 *
 * 物理在线 / 物理实验 / 演示实验只对校园网开放，公网服务器直连会被学校防火墙
 * 丢包（背景见 `server/src/campusRelay.ts` 顶部）。这三个接口是给「校园网内的
 * 一台机器」用的，不是给普通用户用的：
 *
 *   POST /api/campus-relay/poll    中继取任务（长轮询，25s）
 *   POST /api/campus-relay/result  中继回传结果（base64 body）
 *   GET  /api/campus-relay/status  给用户/运维看中继是否在线
 *
 * 鉴权用共享密钥 `CAMPUS_RELAY_TOKEN`（环境变量），不走用户会话 ——
 * 中继是「机器身份」，与谁在用它无关。未配置密钥时这三个接口一律 401，
 * 三个平台退化为服务器直连（校园内网部署时依然可用）。
 */
app.post('/api/campus-relay/poll', asyncRoute(async (req, res) => {
  await campusRelayPoll(req, res)
}))
app.post('/api/campus-relay/result', (req, res) => {
  campusRelayResult(req, res)
})
/* 设备通道：手机 App 的原生 HTTP 桥。走用户登录态，只能取到自己发起的任务。 */
app.post('/api/campus-relay/device/poll', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  await deviceRelayPoll(req, res, uid(req))
}))
app.post('/api/campus-relay/device/result', authenticate, requireRealUser, (req, res) => {
  deviceRelayResult(req, res, uid(req))
})
app.get('/api/campus-relay/status', authenticate, requireRealUser, (_req, res) => {
  res.json({ ok: true, ...relayStatus() })
})

app.get('/api/accounts', authenticate, requireRealUser, (_req, res) => {
  res.json({ ok: true, platforms: ACCOUNT_PLATFORMS, labels: ACCOUNT_PLATFORM_LABEL, accounts: listAccounts(uid(_req)) })
})
app.put('/api/accounts/:platform', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const raw = String(req.params.platform ?? '')
    if (!isAccountPlatform(raw)) throw new HttpError(400, `未知平台：${raw}`)
    const body = (req.body ?? {}) as Record<string, unknown>
    const secret = credentialEnvelope(body)
    const username = readCredField(body, secret, 'username').trim()
    /* 密码允许传空串 = 只换用户名、沿用旧密码（语义见 independentAccounts.upsertAccount） */
    const password = readCredField(body, secret, 'password')
    if (!username) throw new HttpError(400, '账号不能为空')

    /* 保存前探活：密码写错时当场报错，比"落库后每次拉数据才炸"友好得多。
       但登录探活本身要打学校服务器，传 ?verify=0 可跳过（比如站点临时不可达、
       用户想先把凭据存下来）。 */
    let verified = true
    if (password && req.query.verify !== '0') {
      try {
        await withTransportUser(uid(req), () => ACCOUNT_VERIFIERS[raw]({ username, password }))
      } catch (err) {
        if (err instanceof PlatformError && (err.code === 'network' || err.code === 'unavailable' || err.code === 'rate-limited')) {
          /* 站点连不上 ≠ 凭据错。仍然保存，只是告诉前端"没验证成" */
          verified = false
        } else {
          throw new HttpError(400, `${ACCOUNT_PLATFORM_LABEL[raw]}账号验证失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const account = upsertAccount(uid(req), raw, username, password)
    res.json({ ok: true, account, verified })
  } catch (err) {
    fail(res, err)
  }
}))

app.delete('/api/accounts/:platform', authenticate, requireRealUser, (req, res) => {
  try {
    const raw = String(req.params.platform ?? '')
    if (!isAccountPlatform(raw)) throw new HttpError(400, `未知平台：${raw}`)
    const ok = deleteAccount(uid(req), raw)
    res.json({ ok })
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/accounts/:platform/verify', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const raw = String(req.params.platform ?? '')
    if (!isAccountPlatform(raw)) throw new HttpError(400, `未知平台：${raw}`)
    const acc = readAccount(uid(req), raw)
    if (!acc) throw new PlatformError(`尚未绑定${ACCOUNT_PLATFORM_LABEL[raw]}账号`, 'no-account')
    await withTransportUser(uid(req), () => ACCOUNT_VERIFIERS[raw](acc))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
}))

/* ---------------- 快照 TTL 缓存 ----------------

   为什么必须有：一次快照 = 1 次登录 + 十几次上游请求（CITEL 还要按课程逐个拉作业
   详情）。没有缓存时，用户连点五次"刷新"就是五次全量抓取，学校服务器那边看
   就是一个小型压测。5 分钟 TTL 是按"看一眼数据的间隔"取的，前端轮询/切页面
   重复命中同一份；真想强制刷新走 ?force=1。

   缓存键带 userId：不同用户的快照内容不同，且要把 A 的数据漏给 B 是安全事故。
   池子上限 500 条（与 PlatformSessionPool 对齐），超出先踢最旧的。 */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000
const SNAPSHOT_CACHE_MAX = 500
const snapshotCache = new Map<string, { at: number; data: unknown }>()

function snapshotCacheGet(key: string): unknown | undefined {
  const hit = snapshotCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(key)
    return undefined
  }
  return hit.data
}

function snapshotCacheSet(key: string, data: unknown): void {
  if (snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    /* Map 保序：最早插入的键就是最旧的，删到容量的 90% 止步（避免每次写都删一条） */
    const drop = Math.max(1, Math.floor(SNAPSHOT_CACHE_MAX * 0.1))
    let i = 0
    for (const k of snapshotCache.keys()) {
      snapshotCache.delete(k)
      if (++i >= drop) break
    }
  }
  snapshotCache.set(key, { at: Date.now(), data })
}

/**
 * 取某个平台的全量快照（走 5 分钟 TTL 缓存）。
 *
 * 抽成函数是为了让「一键加入课表 / DDL」复用同一份缓存：那个接口同样需要
 * 完整实验列表，如果它自己再打一遍上游，用户点一次按钮就是「页面加载一次 +
 * 加入再抓一次」两次全量登录 —— 而 wlsy / physpace 都只对校园网开放、出口还是
 * 手机中继，成本远高于普通 HTTP 请求。
 */
async function loadPlatformSnapshot(
  userId: number,
  platform: AccountPlatform,
  force: boolean
): Promise<{ data: unknown; cached: boolean }> {
  const key = `${userId}:${platform}`
  if (!force) {
    const cached = snapshotCacheGet(key)
    if (cached !== undefined) return { data: cached, cached: true }
  }
  const acc = readAccount(userId, platform)
  if (!acc) {
    throw new PlatformError(
      `尚未绑定${ACCOUNT_PLATFORM_LABEL[platform]}账号，请先在「设置 → 平台账号」中绑定`,
      'no-account'
    )
  }
  /* 带上「谁在请求」的上下文：三个物理站点只对校园网开放，
     出口可能是这位用户自己的手机（原生桥），见 campusRelay.ts */
  const data = await withTransportUser(userId, () => PLATFORM_FETCHERS[platform](userId, acc))
  snapshotCacheSet(key, data)
  return { data, cached: false }
}

/**
 * 平台类错误落一条日志。
 *
 * 为什么要有：这些失败以前只回给用户（前端弹一句「系统暂时不可用」），服务端
 * 一点痕迹都不留 —— 2026-10-22 那次「三个物理平台全线 503」就是只能靠猜，
 * 多花了一整轮排查。这里只记平台名 + 错误码 + 文案，**不记凭据、不记完整 URL**。
 */
function logPlatformFailure(platform: string, err: unknown): void {
  if (err instanceof PlatformError) {
    console.error(`[platform] ${platform} ${err.code}: ${err.message}`)
  }
}

app.get('/api/platforms/:platform/snapshot', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  const raw = String(req.params.platform ?? '')
  try {
    if (!isAccountPlatform(raw)) throw new HttpError(400, `未知平台：${raw}`)
    const { data, cached } = await loadPlatformSnapshot(uid(req), raw, req.query.force === '1')
    res.json({ ok: true, platform: raw, label: accountPlatformLabel(raw), data, cached })
  } catch (err) {
    logPlatformFailure(raw, err)
    fail(res, err)
  }
}))

/* ---------------- 物理实验 / 演示实验：一键加入课表 / DDL ----------------
 *
 * 为什么要做：实验数据在另一个系统（wlsy / physpace），课表和 DDL 在本站，
 * 用户拿到"10 月 23 日 第 4 节 分光计"之后还得自己手抄一遍 —— 抄错的代价是
 * 按错时间去实验室。这里把「日期 + 第几节」按**用户自己的作息表**换算成
 * 课表的大节与周次（规则见 labToSchedule.ts 顶部），一次点完。
 *
 * 两个目标的语义刻意不同：
 *   - 课表（course）：按学期周次表落到「第 N 周 周几 第几大节」，用于看课表；
 *   - DDL（task）：截止时间 = 实验结束时刻，用于"到点该出现在实验室"的提醒。
 * 两者可以一起加（target=both），也支持只加某一条（body.items 指定）。
 *
 * 幂等：按「名称+周几+周次+大节」/「标题+日期+时间」去重，重复点不会产生重复条目。
 */
const LAB_PLATFORMS = new Set(['physicslab', 'phydemo'])

app.post('/api/platforms/:platform/add-to-schedule', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  const raw = String(req.params.platform ?? '')
  try {
    if (!LAB_PLATFORMS.has(raw)) throw new HttpError(400, '该平台的数据不支持加入课表')
    const source = raw as LabSource
    const userId = uid(req)
    const body = (req.body ?? {}) as Record<string, unknown>

    const target = String(body.target ?? 'both')
    if (target !== 'course' && target !== 'task' && target !== 'both') {
      throw new HttpError(400, 'target 只能是 course / task / both')
    }
    const includePast = body.includePast === true

    /* 可选：只处理前端指定的几条（逐条按钮用）。键与前端一致：日期|节次|名称 */
    let wanted: Set<string> | null = null
    if (Array.isArray(body.items)) {
      if (body.items.length > 200) throw new HttpError(400, '一次最多处理 200 条实验')
      wanted = new Set(
        body.items
          .map((it) => (it ?? {}) as Record<string, unknown>)
          .map((it) => `${labDateISO(Number(it.date) || 0)}|${Number(it.period) || 0}|${String(it.name ?? '')}`)
      )
    }

    const { data, cached } = await loadPlatformSnapshot(userId, source, false)
    const labs = (Array.isArray(data) ? data : []) as LabEntry[]

    const settings = getSettings(userId)
    const terms = (settings.terms ?? []).map((t) => ({
      id: t.id,
      startDate: t.startDate,
      totalWeeks: t.totalWeeks,
      weeks: t.weeks ?? null
    }))
    const todayISO = toISODate(new Date())

    const courseDrafts: LabCourseDraft[] = []
    const taskDrafts: LabTaskDraft[] = []
    const unresolved: { name: string; date: string; reason: string }[] = []
    const handled: string[] = []
    /**
     * 真正落到课表 / DDL 的实验键。
     *
     * 与 `handled` 的区别是这次修的 bug 的核心：`handled` 表示"这次扫到并处理了"，
     * 而落不了周的实验（放假周 / 学期外 / 节次表外）**同样在 handled 里**。
     * 前端如果拿 handled 当"已加入"，那类实验就会显示成「✓ 已在课表」并被 disabled ——
     * 用户既加不进去也点不了重试。所以额外分开两个数组。
     */
    const courseKeys: string[] = []
    const taskKeys: string[] = []

    for (const lab of labs) {
      if (!lab || typeof lab.name !== 'string' || !lab.name) continue
      const dateISO = labDateISO(lab.date)
      const key = `${dateISO}|${lab.period}|${lab.name}`
      if (wanted && !wanted.has(key)) continue
      if (!includePast && dateISO < todayISO) continue
      handled.push(key)

      if (target === 'course' || target === 'both') {
        const built = buildCourseDraft(source, lab, {
          periods: settings.periods,
          terms,
          preferredTermId: settings.currentTermId ?? null,
          palette: COURSE_COLORS
        })
        if (built.draft) {
          courseDrafts.push(built.draft)
          courseKeys.push(key)
        } else {
          /* 落不了周（放假周 / 学期外 / 节次表外）：如实告知，不硬塞 */
          unresolved.push({ name: lab.name, date: dateISO, reason: built.reason })
        }
      }

      if (target === 'task' || target === 'both') {
        taskDrafts.push(buildTaskDraft(source, lab))
        taskKeys.push(key)
      }
    }

    /* 落库（单事务 + 按自然键去重）在 labImport.ts —— 单独成模块是为了能在临时库上做回归测试 */
    const written = applyLabDrafts(userId, courseDrafts, taskDrafts)

    res.json({
      ok: true,
      platform: raw,
      label: accountPlatformLabel(raw),
      cached,
      scanned: labs.length,
      handled: handled.length,
      added: { courses: written.courses.added, tasks: written.tasks.added },
      skipped: { courses: written.courses.skipped, tasks: written.tasks.skipped },
      unresolved,
      keys: handled,
      courseKeys,
      taskKeys
    })
  } catch (err) {
    logPlatformFailure(raw, err)
    fail(res, err)
  }
}))

/**
 * 取消导入：把某个平台**导入进来**的课程 / DDL 删掉。
 *
 * 与 add-to-schedule 成对：那边的"幂等"是好事（重复点不会多），但也意味着
 * 用户点错了、或者退课了，光靠再点一次是撤不回来的 —— 必须有显式的移除入口。
 * 识别方式见 `labImport.removeLabDrafts`（按标题前缀反查）。
 *
 * 不需要绑定账号、也不打学校站点：它只动本站的数据库，
 * 所以哪怕校园网出口离线也能用（"清掉之前导入的"不应该依赖学校系统可达）。
 */
app.post('/api/platforms/:platform/remove-from-schedule', authenticate, requireRealUser, (req, res) => {
  const raw = String(req.params.platform ?? '')
  try {
    if (!LAB_PLATFORMS.has(raw)) throw new HttpError(400, '该平台的数据不支持从课表移除')
    const body = (req.body ?? {}) as Record<string, unknown>
    const target = String(body.target ?? 'both')
    if (target !== 'course' && target !== 'task' && target !== 'both') {
      throw new HttpError(400, 'target 只能是 course / task / both')
    }
    const removed = removeLabDrafts(uid(req), raw as LabSource, target)
    res.json({ ok: true, platform: raw, removed })
  } catch (err) {
    fail(res, err)
  }
})

/** 物理在线：单个作业的提交状态/成绩详情（不在快照里，按需点开） */
app.get('/api/phyvlab/assignment/:id', authenticate, requireRealUser, asyncRoute(async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '无效的作业 ID')
    const userId = uid(req)
    const acc = readAccount(userId, 'phyvlab')
    if (!acc) throw new PlatformError('尚未绑定物理在线账号，请先在「设置 → 平台账号」中绑定', 'no-account')
    const detail = await withTransportUser(userId, () => fetchPhyVlabAssignmentDetail(userId, acc, id))
    res.json({ ok: true, detail })
  } catch (err) {
    fail(res, err)
  }
}))

/* 生产环境：托管前端构建产物（web/dist）
 *
 * ⚠️ 路由切分（2026-10-05 起）：`/` = 官网首页，`/app` = 应用本体。
 *    构建产物是两个独立 HTML：dist/landing.html 与 dist/index.html
 *    （双入口配置见 web/vite.config.ts）。
 *
 *    为什么切分：首页要"秒开 + 内容可被搜索引擎读到"，不适合塞进客户端渲染的 SPA；
 *    而应用是移动优先的 480px 外壳，也不适合直接当官网（桌面打开就是一条窄条）。
 *
 * ⚠️ 这里**刻意不做** UA 分流。
 *    原本考虑过按 Android WebView 的 UA 把 `/` 直接送去应用，让旧版 App（入口写死为 `/`）
 *    无感继续用。但 `; wv)` 这个标记微信、QQ 内置浏览器同样会带 —— 按它分流会让
 *    "在微信里点开官网链接"的正常访客直接被丢进应用界面、完全看不到首页。
 *    旧版 App 的兼容改由首页自己兜：它检测到 WebView 环境时会在最顶部显示一条
 *    「直接进入应用」的横幅（web/src/landing/landing.ts），判定在客户端、随时可调，
 *    也不影响正常浏览器访问的语义。
 */
if (process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC === '1') {
  const distDir = join(process.cwd(), 'web', 'dist')
  const downloadsDir = join(distDir, 'downloads')
  const landingFile = join(distDir, 'landing.html')
  const appFile = join(distDir, 'index.html')

  /** APK 版本清单（单一事实来源）。发新版只需替换文件 + 改这份 JSON，页面自动跟着变。 */
  interface ApkManifest {
    versionName: string
    versionCode: number
    fileName: string
    url: string
    sizeBytes: number
    sha256: string
    releasedAt: string
    packageName: string
    osRequirement: string
    changelog: string[]
  }

  const readApkManifest = (): ApkManifest | null => {
    try {
      const p = join(downloadsDir, 'manifest.json')
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, 'utf8')) as ApkManifest
    } catch {
      return null
    }
  }

  /* 静态资源托管。
     ⚠️ `index: false` 必须加：express.static 默认会把「目录请求」映射到目录下的 index.html，
        于是 `/` 在这里就被 dist/index.html 抢走了 —— 首页永远出不来，而且**不报任何错**，
        排查时表现为"明明改了首页，线上却毫无变化"。 */
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        /* 内容哈希命名的资产可以永久缓存（文件名变即内容变，不可能陈旧）；
           HTML 则必须每次回源校验（见下面的 no-cache），否则发版后用户会一直看到旧壳。
           这一条是"网页一更新、App 里的内容立刻跟着更新"的关键一环。 */
        if (/[\\/]assets[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      }
    })
  )

  /** HTML 一律不缓存：WebView 每次启动都会回源校验（未变则 304），保证内容实时同步 */
  const sendHtml = (res: Response, file: string): void => {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(file)
  }

  /* ---------------- 应用外壳：把 CSS 内联进 HTML ----------------
   *
   * 为什么：外链样式表是**渲染阻塞**资源 —— 浏览器会一直白屏到它下载并解析完，
   * 哪怕 HTML 里已经有内容。实测（4G 限速 + 4x CPU）改造后骨架在 219ms 就进了
   * DOM，但首次绘制被拖到 589ms，全部耗在那张 131KB（gzip 23KB）的 CSS 上。
   * 用户这时候看到的是纯白/纯黑一片，体感就是"点了没反应"。
   *
   * 内联之后，CSS 随 HTML 一起到达，首帧只剩 HTML 自身的传输时间。
   * 代价与取舍：
   *   - HTML 从 2KB 涨到约 155KB（gzip 约 25KB）。但这 25KB 与原来"先下 2KB、
   *     再下 23KB"的总量几乎相同，省下的是**一个串行的 RTT 与整段阻塞窗口**。
   *   - /app 是 no-cache（发版即生效），但带 ETag：内容不变时是 304 空响应，
   *     连这 25KB 都不用重传。所以内联**不会**造成重复下载。
   *   - 只对 /app 这么做。`/` 是官网（landing.html，另一张 CSS，且要 SEO），
   *     结构与这条路径无关，保持原样。
   *
   * 失败一律回退到原始 HTML：这属于"锦上添花"的优化，绝不能因为读不到 CSS
   * 或者 Vite 改了产物结构就让应用打不开。
   * ⚠️ 缓存必须同时按 HTML 与 CSS 的 mtime 失效：只看 HTML 的话，重新构建后
   *    index.html 与 CSS 的文件名会同时变（都带内容哈希），但万一只有 CSS 变
   *    就会一直吐旧样式 —— 那种"线上样式不更新"的问题极难排查。 */
  let appShellCache: { key: string; html: string } | null = null
  const renderApp = (): string => {
    const fallback = (): string => readFileSync(appFile, 'utf8')
    try {
      const html = readFileSync(appFile, 'utf8')
      /* Vite 注入的形式固定为 <link rel="stylesheet" crossorigin href="/assets/app-xxx.css">。
         用宽松匹配而不是写死 app- 前缀：产物名可能被改成别的（例如调整 rollupOptions
         的 entryFileNames），那时正则仍应命中，否则会静默退回"外链 CSS"的老行为。 */
      const m = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/)
      if (!m) return html
      const href = m[1]
      const cssPath = join(distDir, href.replace(/^\//, ''))
      /* ⚠️ 缓存键必须把 theme-init.js 也算进来。它被内联进 HTML，而 CSP 的 sha256
         是**按该文件当前内容**算的 —— 如果只改 theme-init.js（HTML 与 CSS 都没变），
         键不变就继续吐旧缓存，里面内联的还是**旧脚本**，而 CSP 头已换成新哈希，
         浏览器会拒绝执行那段内联脚本：防闪失效，用户看到「先白后黑」跳变，
         且不报任何服务端错误。这类"只在单独更新一个文件时出现"的问题极难排查，
         所以直接把它的 mtime 也纳入键（statSync 失败按 0 处理，不阻断渲染）。 */
      let themeMtime = 0
      try {
        themeMtime = statSync(themeInitFile).mtimeMs
      } catch {
        /* 没有该文件：不内联，键里用 0 即可 */
      }
      const key = `${statSync(appFile).mtimeMs}:${statSync(cssPath).mtimeMs}:${themeMtime}`
      if (appShellCache && appShellCache.key === key) return appShellCache.html
      const css = readFileSync(cssPath, 'utf8')
      /* `</style` 若出现在内容里会提前闭合标签；CSS 里不会出现，但转义一次更稳
         （多花不到 1KB，换掉一整类"样式截断"事故）。 */
      const safe = css.replace(/<\/style/gi, '<\\/style')
      /* ⚠️ 内联的 <style> 放在 **</body> 前**，不能留在原来 <link> 的位置（<head> 内）。
         原因：<head> 里的内联样式是**渲染阻塞**的 —— 浏览器必须把 131KB 全部解析完
         才肯画第一个像素，连早就在 head 里的 boot-* 骨架样式也一起等。而骨架本身
         一行应用 CSS 都不需要。实测（--cpu=4 --net=slow）：
           <head> 内联 → 骨架 374ms / 真实界面 872ms
           </body> 前   → 骨架 203ms / 真实界面 890ms
         即首屏可见内容早约 170ms，而真实界面时刻不变（差 18ms 在方差内）。
         为什么不会 FOUC：模块脚本已被上面那段挪到 <head>，模块脚本天然 defer
         （文档解析完才执行），所以 React 渲染真实界面时这段样式一定已解析完毕。
         找不到 </body> 就放回原处，宁可慢一点也不让样式丢失。 */
      let html2 = html
      if (html2.includes('</body>')) {
        html2 = html2.replace(m[0], '').replace('</body>', `<style>${safe}</style>\n  </body>`)
      } else {
        html2 = html2.replace(m[0], `<style>${safe}</style>`)
      }
      /* ⚠️ 把 /theme-init.js 内联进 head。
         它是防闪脚本（在 React 挂载前定好主题色，避免先白后黑跳变），必须是
         **同步、首次绘制前执行**的。之前它是 <script src> —— 一个同步的外链脚本，
         浏览器必须先下载完它才继续解析文档。CSS 搬到 body 末尾之后，它成了唯一的
         渲染阻塞资源：实测去掉它骨架 213ms → 98ms，内联后 94ms。
         内联需要 CSP 放行：把它的 sha256 记进 themeInitHash（见 CSP 那段的说明）。
         为什么不用 nonce：/app 的 HTML 靠 ETag 缓存，nonce 每响应一变就会让 304 失效。
         文件不存在就跳过内联（照旧走外链），哈希也一并清掉。 */
      try {
        const tagRe = /<script[^>]*src="\/theme-init\.js"[^>]*><\/script>/
        if (themeInitHash() !== null && tagRe.test(html2)) {
          const themeJs = readFileSync(themeInitFile, 'utf8')
          /* 转义 </script> 防提前闭合；脚本里不会有，但这个转义很便宜。
             ⚠️ CSP 哈希是对**原始文件字节**算的（themeInitHash 里就是这么算的），
             这里塞进 HTML 的是转义后的版本 —— 两者只在脚本真的含 "</script>"
             时才会不同，而那种情况本就不该出现。保持这个不变式：哈希永远按
             文件原文算，不要改成按内联后的字符串算。 */
          html2 = html2.replace(tagRe, `<script>${themeJs.replace(/<\/script/gi, '<\\/script')}</script>`)
        }
      } catch {
        /* 保留外链形式；CSP 里那个哈希此时是"多余但无害"的 */
      }
      /* ⚠️ 把 JS 的预加载提示搬到 <head> 最前面。
         原因：Vite 把 <script type="module"> 与它的 modulepreload 留在 </body> 前，
         而我们把 131KB 的 CSS 内联进了 HTML（现放在 </body> 前，但它与 head 里的
         内联防闪脚本一起，仍会推迟脚本标签被发现）—— 实测首屏 JS 因此被推迟约
         100ms 才发起请求。
         挪到 head 开头后，预扫描器在 HTML 刚到达时就能开始下载 JS，与 CSS 解析并行。
         只搬 modulepreload 与 module script 两类（不含 polyfill 之前的其它资源），
         末尾的原始位置保留一份 —— 重复的 modulepreload 命中缓存，代价为零。
         做失败就整体回退（这段是纯优化，不能因为它让页面打不开）。 */
      try {
        const hintRe = /<link[^>]*rel="modulepreload"[^>]*>|<script[^>]*type="module"[^>]*><\/script>/g
        const hints = html2.match(hintRe)
        if (hints && hints.length > 0) {
          /* 先把这些标签从原处删掉，再插到 <head> 开头，避免同一标签出现两次
             （script 重复出现会被执行两次，即使命中缓存也不能冒这个险）。 */
          html2 = html2.replace(hintRe, '')
          /* 插在 <meta charset> 之后而不是紧跟 <head>：charset 声明必须落在文档前
             1024 字节内，把一百多字节的 link 标签塞到它前面会让浏览器重新开始猜测编码
             —— 中文站点一旦猜错就是整页乱码，不值得为几十毫秒冒这个险。 */
          html2 = html2.replace(/<meta[^>]*charset[^>]*>/i, (mm) => mm + '\n    ' + hints.join('\n    '))
        }
      } catch {
        /* 保留原样 */
      }
      appShellCache = { key, html: html2 }
      return html2
    } catch {
      return fallback()
    }
  }

  /* 首页模板做两处极小的服务端替换：
     ① __SITE_ORIGIN__ → 真实 scheme://host；
     ② __ICP_LICENSE__ → ICP 备案号（见下方 ICP_LICENSE）。
     为什么 origin 不能直接用相对路径：OG 卡片（微信 / QQ 分享缩略图）与 canonical 规范网址
     都**要求绝对地址**，而站点现在还是 IP、域名几天后才到位 —— 写死 IP 会在换域名时集体失效，
     写死域名在域名到位前又是错的。按请求头 Host 动态生成，两个阶段都自动正确。
     ⚠️ 缓存必须按 mtime 失效，不能"读一次就不管了"：否则换了 landing.html 而没重启服务时，
        线上会一直吐旧首页 —— 而且不报任何错，是最难查的那种。 */
  let landingCache: { mtimeMs: number; text: string } | null = null
  const renderLanding = (origin: string): string => {
    const mtimeMs = statSync(landingFile).mtimeMs
    if (landingCache === null || landingCache.mtimeMs !== mtimeMs) {
      landingCache = { mtimeMs, text: readFileSync(landingFile, 'utf8') }
    }
    let html = landingCache.text.split('__SITE_ORIGIN__').join(origin)
    /* 备案号：工信部要求首页底部展示并链到 beian.miit.gov.cn。
       两个分支都要把块内注释一起处理掉 —— 那些注释写的是"怎么替换占位符"，
       是给维护者看的，不该随每个访客的首页发出去。
       ① 未配 ICP_LICENSE：整块删除。留一个空的 "ICP备" 比不展示更糟：既不合规，
          又会让访客以为是页面坏了。
       ② 已配：先剥掉块内注释，再替换占位符。
       正则只匹配 `.lp-foot-icp` 这一个 class，不会误伤页面其它注释；
       号码只放行 [A-Za-z0-9-]（见 ICP_LICENSE 定义），不会破坏 HTML 结构。 */
    if (ICP_LICENSE === '') {
      html = html.replace(/[ \t]*<div class="lp-wrap lp-foot-icp"[\s\S]*?<\/div>\n?/g, '')
    } else {
      html = html.replace(
        /(<div class="lp-wrap lp-foot-icp"[^>]*>)[\s\S]*?(<\/div>)/g,
        (_m, open: string, close: string) =>
          open + '<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer nofollow" data-icp-link>' + ICP_LICENSE + '</a>' + close
      )
    }
    return html
  }

  /* 首页。landing.html 缺失时回退到应用外壳，避免升级过程中出现 404 白页 */
  app.get('/', (req, res) => {
    if (!existsSync(landingFile)) return sendHtml(res, appFile)
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(renderLanding(`${req.protocol}://${req.get('host')}`))
  })

  /* 应用本体。返回的是 index.html，它的资源引用全部是绝对路径（Vite base 为 '/'），
     因此从 /app 这样的子路径打开也完全正常 —— 不会出现相对路径解析错位。
     这里走 renderApp：把 CSS 内联进 HTML，消掉首屏唯一的渲染阻塞请求。 */
  app.get('/app', (_req, res) => {
    /* 内联 CSS 后响应体有 150KB+，必须显式声明类型与不缓存。
       ETag 由 res.send 自动生成（内容哈希），所以重访是 304 空响应。 */
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(renderApp())
  })

  /* ---------------- APK 下载 ---------------- */

  /* 下载限流刻意放宽：大文件分发不是攻击面，这里只防"被当成流量放大器刷" */
  const downloadLimit = makeSlidingWindowLimiter(3600_000, 60)

  app.get('/download/manifest.json', (_req, res) => {
    const m = readApkManifest()
    if (!m) {
      res.status(404).json({ error: '安装包信息未发布' })
      return
    }
    /* 清单会随发版变化，不能缓存，否则页面上的版本号会滞后 */
    res.setHeader('Cache-Control', 'no-cache')
    res.json(m)
  })

  /* 固定入口：永远指向当前版本。给不解析清单的场景用（外链、二维码、旧页面） */
  app.get('/download/latest', (req, res) => {
    const m = readApkManifest()
    if (!m) {
      res.status(404).json({ error: '安装包信息未发布' })
      return
    }
    if (!downloadLimit.hit(req.ip ?? 'unknown')) {
      res.status(429).json({ error: '下载请求过于频繁，请稍后再试' })
      return
    }
    res.redirect(302, m.url)
  })

  /* 具体文件：**白名单**，只允许清单里登记的那一个文件名。
     绝不能把 :file 直接拼进路径 —— 那是目录穿越的经典入口（本项目 /uploads 遵循同一条原则）。 */
  app.get('/download/:file', (req, res) => {
    const m = readApkManifest()
    if (!m) {
      res.status(404).json({ error: '安装包信息未发布' })
      return
    }
    const asked = req.params.file
    if (asked !== m.fileName || /[\\/]/.test(asked)) {
      res.status(404).json({ error: '安装包不存在' })
      return
    }
    if (!downloadLimit.hit(req.ip ?? 'unknown')) {
      res.status(429).json({ error: '下载请求过于频繁，请稍后再试' })
      return
    }
    const abs = join(downloadsDir, m.fileName)
    if (!existsSync(abs)) {
      res.status(404).json({ error: '安装包文件缺失' })
      return
    }
    /* 显式指定 MIME：部分环境的 mime 库不给 .apk 映射，漏了会退化成
       application/octet-stream，个别国产浏览器会当成"未知文件"、不提供安装入口。
       Content-Disposition 交给 res.download 生成（中文文件名会被正确编码成 RFC 5987 形式）。 */
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.download(abs, `交大小助手-v${m.versionName}.apk`)
  })

  /* ---------------- SEO ---------------- */

  /* robots 与 sitemap 都按**请求头里的 Host** 动态生成，而不是写死域名：
     站点目前还是 IP + 明文 HTTP，硬编码域名会在换域名时全部失效；
     动态生成则换域名、上 HTTPS 都自动正确，不需要改代码。 */
  app.get('/robots.txt', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`
    res.setHeader('Cache-Control', 'no-cache')
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Allow: /',
        /* /app 是应用外壳，没有可被索引的正文；收录它只会在搜索结果里多出一堆空页面 */
        'Disallow: /app',
        'Disallow: /api/',
        'Disallow: /uploads/',
        'Disallow: /download/',
        '',
        `Sitemap: ${base}/sitemap.xml`,
        ''
      ].join('\n')
    )
  })

  app.get('/sitemap.xml', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`
    res.setHeader('Cache-Control', 'no-cache')
    res.type('application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
        '</urlset>\n'
    )
  })

  /* SPA 兜底：其余未知路径交给应用，由客户端自己决定显示什么。
     ⚠️ 顺序至关重要 —— 上面所有显式路由都必须在它**之前**注册，否则会被它整片吞掉。 */
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    if (req.path.startsWith('/download/')) {
      res.status(404).json({ error: '安装包不存在' })
      return
    }
    /* 走到这里说明静态目录没命中。若路径"看起来像一个静态文件"（最后一段带扩展名），
       就说明它确实不存在 —— 直接 404，不要回退成 HTML。
       否则 /og-cover.png 这类缺失资源会返回 200 + text/html：浏览器把它当图片解码失败，
       搜索引擎则会把这一堆路径当作重复页面收录。 */
    const last = req.path.split('/').pop() ?? ''
    if (/\.[a-z0-9]{2,5}$/i.test(last)) {
      res.status(404).type('text/plain').send('Not Found')
      return
    }
    sendHtml(res, appFile)
  })
}

/* fallback */
app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  /* 顺序很重要：先认业务错误，再认"框架层"错误（body-parser 抛的不是 HttpError）。 */
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof CredError) {
    res.status(400).json({ error: err.message })
    return
  }
  /* body-parser 的两类错误此前全被当成 500：客户端传一个截断的 JSON 或 9MB 图片，
     收到的是"服务器内部错误"并在服务端打一条带完整堆栈的日志 —— 既误导用户也污染日志。
     express.json() 抛的 SyntaxError / PayloadTooLargeError 自带 status（400 / 413），照用即可。 */
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const type = (err as { type?: string }).type
    const message = type === 'entity.too.large'
      ? '请求体过大（图片请压缩后再上传）'
      : type === 'entity.parse.failed'
        ? '请求体不是合法的 JSON'
        : '请求格式不正确'
    res.status(status).json({ error: message })
    return
  }
  console.error(err)
  res.status(500).json({ error: '服务器内部错误' })
})

/* 论坛示例内容播种已随论坛一并下线：posts 表仍在，但不再有新部署去写入演示数据。
   存量演示帖（若有）会在迁移脚本里一并转为反馈工单，或在迁移时手工排除。 */

/* 监听地址：默认 127.0.0.1（只对本机 nginx 开门）。
   之前是 app.listen(PORT) → Node 绑 0.0.0.0/:: → 整个内网可达，边界只剩云安全组一层。
   需要直接对外暴露时显式 HOST=0.0.0.0。判定逻辑与理由见 securityHeaders.ts:resolveListenHost。 */
const HOST = resolveListenHost(process.env.HOST)

const server = app.listen(PORT, HOST, () => {
  console.log(`bjtu-helper server listening on http://${HOST}:${PORT}`)

  /* 凭据传输策略：未开 CRED_REQUIRE_ENCRYPTED 时这里会打一条 WARN。
     放在启动日志里，是因为它是"上线后是否还在明文传教务密码"的唯一可见信号。
     ⚠️ 刻意不引入新环境变量来判断"对外是不是 https"—— 本项目没有 PUBLIC_ORIGIN 之类的约定，
     凭空加一个没人设的变量只会让告警永远显示 localhost。改为把"进程只监听本机端口"这个
     事实说清楚：真正对外是 http 还是 https 由 nginx 决定，日志里点明即可。 */
  logCredTransportPolicy(`${HOST}:${PORT}（对外协议由反代 nginx 决定）`)

  /* 存量明文凭据清扫（一次性，启动时跑）。
     独立平台密码本该是 AES-256-GCM 密文，但加密是 10-23 才上线的，老记录靠
     readAccount() 的**惰性迁移**收敛 —— 而惰性迁移只覆盖"用户还会去点那个平台"的行。
     线上实测：10 条凭据里 4 条到现在仍是明文，因为主人没再同步过。备份天天带走整库，
     那些密码就在备份里躺着。这里主动扫一遍，把剩下的明文加密回写，一轮之后清零。
     放在 listen 回调里而不是模块顶层：此时 db 已建表、密钥已可读，且失败不会挡住端口。 */
  try {
    const swept = sweepPlaintextCredentials(db, encryptSecret, (row, err) => {
      console.error(`[cred] ⚠️ 明文凭据迁移失败 id=${row.id} platform=${row.platform}`, err)
    })
    if (swept.migrated > 0) {
      console.log(`[cred] 存量明文凭据已加密 ${swept.migrated} 条（共扫描 ${swept.scanned} 条）`)
    }
    if (swept.failed > 0) {
      console.warn(`[cred] ⚠️ ${swept.failed} 条凭据仍是明文（加密失败，见上方错误）`)
    }
  } catch (e) {
    /* 清扫本身出问题不该挡住启动：服务能跑比"全部加密"更优先，但必须留痕。 */
    console.error('[cred] 存量明文凭据清扫失败', e)
  }

  /* 监听地址如果不是环回，就在日志里大声说一次：这是"3001 是否直接暴露"的唯一可见信号。
     默认值已是 127.0.0.1，出现这条 WARN 说明有人显式设了 HOST —— 那就该确认
     云安全组与 firewalld 是否真的挡在它前面，而不是依赖"我记得配过"。 */
  if (HOST !== '127.0.0.1' && HOST !== '::1') {
    console.warn(
      `[net] ⚠️ 监听 ${HOST}:${PORT} —— 该地址可能被本机之外访问到。` +
        '若前面有 nginx 反代，请改回 HOST=127.0.0.1；确需直连时请确认安全组/防火墙已限制来源。'
    )
  }

  /* 过期数据清理：sessions（30 天有效期）与 captchas（10 分钟）都只在写入时顺手清一次，
     长期运行必然积累过期行。每 10 分钟清一轮，只删 expires_at 已过期的行，无锁风险。
     .unref() 让定时器不阻止进程退出（否则 systemd stop 时进程会挂住）。

     同一轮里回收**长期不活跃的一次性游客账号**（默认 14 天，见 db.ts GUEST_TTL_DAYS）。
     必须自动回收：用户清个缓存 / 换个浏览器 / 开个无痕窗口就是一个新游客账号，
     只增不减的话 users 表会被一次性账号灌满，管理员看板的口径也会被污染。
     有反馈工单的游客会被跳过（管理员可能还在处理，账号一删工单跟着 CASCADE 消失）。

     周期与 TTL 都可用环境变量覆盖（`PURGE_INTERVAL_MS` / `GUEST_TTL_DAYS`）：
     生产用默认值；本地验证时把周期调成秒级、TTL 调成 0，就能在几秒内跑完
     "建号 → 变旧 → 被回收"整条链路，不必等 10 分钟。 */
  const purgeIntervalMs = Number(process.env.PURGE_INTERVAL_MS) || 10 * 60 * 1000
  const guestTtlDays = Number.isFinite(Number(process.env.GUEST_TTL_DAYS))
    ? Number(process.env.GUEST_TTL_DAYS)
    : GUEST_TTL_DAYS
  const purgeTimer = setInterval(
    () => {
      try {
        const { sessions, captchas, clientErrors } = purgeExpired()
        if (sessions > 0 || captchas > 0 || clientErrors > 0) {
          console.log(
            `[purge] 清理过期会话 ${sessions} 条、过期验证码 ${captchas} 条、30 天前的前端错误 ${clientErrors} 条`
          )
        }
        const guests = purgeStaleGuests(guestTtlDays)
        if (guests > 0) {
          console.log(`[purge] 回收 ${guestTtlDays} 天未活跃的一次性游客账号 ${guests} 个`)
        }
      } catch (e) {
        console.error('[purge] 清理过期数据失败', e)
      }
    },
    purgeIntervalMs
  )
  purgeTimer.unref()

  /* 孤儿图片清理：前端「选图即上传」，取消发帖会留下无人引用的文件。
     每小时扫一次，只删「无人引用且已存在超过 24 小时」的文件（见 uploads.ts 的说明）。 */
  const orphanTimer = setInterval(
    () => {
      try {
        const r = sweepOrphanUploads(uploadsDir)
        if (r.removed > 0) {
          console.log(`[orphan] 清理孤儿图片 ${r.removed} 个，释放 ${(r.freedBytes / 1024).toFixed(1)} KB`)
        }
      } catch (e) {
        console.error('[orphan] 孤儿图片清理失败', e)
      }
    },
    60 * 60 * 1000
  )
  orphanTimer.unref()

  /* 共同计划到点提醒：扫「已确认 + 已进入提醒窗口 + 尚未提醒」的计划，给**双方**各投一条站内信。
   *
   * 为什么是定时扫描而不是"创建时算好 setTimeout"：
   *   ① 进程重启会丢光所有内存里的 setTimeout —— 提醒静默消失，且没有任何痕迹；
   *   ② 计划随时可能被改期或取消，已排的定时器需要逐个追踪、撤销，是状态泄漏的经典来源；
   *   ③ 本轮询天然幂等（靠 reminder_sent_at 去重），多实例部署也不会重复发。
   * 代价是最多 `interval + window` 的延迟，对"约会提醒"这个场景完全可以接受。
   *
   * 窗口默认 2 小时、扫描每 5 分钟一次：既保证"提前量够用"，又保证同一计划
   * 不会因为窗口跨越两次扫描而发两遍（reminder_sent_at 是硬闸）。
   * 本地验证可用 PLAN_REMIND_WINDOW_HOURS / PLAN_REMIND_INTERVAL_MS 调快。 */
  const remindWindowHours = Number(process.env.PLAN_REMIND_WINDOW_HOURS) || 2
  const remindIntervalMs = Number(process.env.PLAN_REMIND_INTERVAL_MS) || 5 * 60 * 1000
  const planRemindTimer = setInterval(
    () => {
      try {
        /* ⚠️ 必须用 localStamp 而不是 toISOString：plan_date/start_time 存的是本地墙上时间，
           用 UTC 串当"现在"会凭空差 8 小时，提醒会整体失效（详见 date.ts 的注释）。 */
        const nowIso = localStamp()
        for (const due of findDueReminders(nowIso, remindWindowHours)) {
          /* 先抢标记再发信：并发/重复扫描时只有抢到的一方会投递，杜绝重复提醒。
             抢不到直接跳过，说明另一轮已经发过了。 */
          if (!markReminded(due.planId)) continue
          notifyDueReminder(due)
          console.log(`[plans] 已发出共同计划 #${due.planId} 的到点提醒（${due.planDate} ${due.startTime || '全天'}）`)
        }
      } catch (e) {
        console.error('[plans] 共同计划提醒扫描失败', e)
      }
    },
    remindIntervalMs
  )
  planRemindTimer.unref()
})

/* ---------------- 优雅停机 ----------------

   为什么不能直接退出：WAL 模式下，已 COMMIT 但还没 checkpoint 进主库的数据仍在 -wal 文件里。
   进程被 SIGKILL（或超时被 systemd 连坐）时，-wal 会完整保留，SQLite 下次打开能自行恢复 ——
   数据**不会丢**，但 -wal 会一直涨，且在备份脚本 `cp bjtu-helper.db` 时
   备份出来的文件**可能缺最新写入**（这是本项目最容易被忽略的运维陷阱）。

   所以在退出前做两件事，都是 ms 级：
     ① 停止接收新连接（server.close），等在途请求自然结束；
     ② `PRAGMA wal_checkpoint(TRUNCATE)` 把 -wal 合并回主库并清空，再关连接。

   超时兜底 8 秒：systemd 的 TimeoutStopSec 默认 90s，nginx 的 proxy_read_timeout 60s，
   8 秒足够任何正常请求收尾；拖不住的就直接退，别让 `systemctl restart` 卡住。
   重复信号（连按两次 Ctrl-C）立即强退，这是运维期望的行为。 */
let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) {
    console.warn(`[shutdown] 再次收到 ${signal}，立即退出`)
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[shutdown] 收到 ${signal}，停止接收新连接…`)

  const finish = (code = 0) => {
    try {
      const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
      if (r?.busy) console.warn('[shutdown] checkpoint 未完成（有其它连接在读），-wal 保留待下次恢复')
      db.close()
      console.log('[shutdown] 数据库已关闭，-wal 已合并')
    } catch (e) {
      /* 关库失败也不能阻止退出 —— 数据已在 WAL 里，下次启动会自动恢复 */
      console.error('[shutdown] 关库时出错（数据仍在 -wal，可恢复）：', e)
    }
    process.exit(code)
  }

  const force = setTimeout(() => {
    console.warn('[shutdown] 等待在途请求超时（8s），强制退出')
    finish(1)
  }, 8_000)
  force.unref()

  server.close(() => {
    clearTimeout(force)
    finish(0)
  })
  /* keep-alive 的空闲连接不会自己断，server.close 会一直等它们。
     这里主动切断**空闲**连接，在途的交给上面的超时兜底。 */
  server.closeIdleConnections?.()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
