import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Course, Settings, Task, ThemeMode, User } from './types'
import {
  clearToken, getSettings, getToken, logout, markOnboarded, me, setToken, getUnreadMessageCount,
  ensureGuestSession, getGuestPending, claimGuest, getHome, getTasks, type GuestDataCounts, type GuestClaimMode
} from './api'
import AuthView from './pages/AuthView'
import HomeView from './pages/HomeView'
import ErrorBoundary from './components/ErrorBoundary'
import Modal from './components/Modal'
import BootShell from './components/BootShell'
import { useRecognizer } from './lib/recognizer'
import NavBar from './components/NavBar'
/* 骨架屏只有两百来字节，且首页本来就要用 HomeSkeleton；用它给懒加载的 tab 做
   fallback，比复用空块 .page-loading 好得多 —— 切 tab 时先看到形状再看到内容，
   不会有"点了没反应"的空窗。 */
import { ScheduleSkeleton, TaskListSkeleton, HomeSkeleton } from './components/Skeleton'
import { useBackStep, armRootBackGuard, useEdgeSwipeBack, consumeInternalPop } from './lib/back'
import { applyAccent, applyTheme, storeAccent, storeTheme, watchSystemTheme, readStoredTheme, DEFAULT_ACCENT } from './lib/theme'
import { initialOf } from './lib/avatar'
import { IconHome, IconList, IconSchedule, IconUser } from './icons'
import { useOnlineStatus, useOfflineCapable, onServiceWorkerUpdate } from './lib/pwa'
import { BOOT_REASSURANCE, bootFailureMessage, decideBootFailure, statusOf, withTransientRetry } from './lib/authRecovery'
import { findEntry } from './lib/appRegistry'
import { hasWidgetBridge, pushWidgetSnapshot } from './lib/widgetBridge'
import { readUserSnapshot, writeUserSnapshot, clearUserSnapshot, pruneUserSnapshots } from './lib/userCache'

/* ---------------- 低频页面按需加载 ----------------
 *
 * 这几个页面的源码合计约占 web/src 的 40%（实测 321KB / 795KB），但绝大多数用户
 * 一周都不会打开一次：管理后台只有管理员用，情侣课表/空闲课表是"一学期几次"，
 * 应用目录里的 6 个工具各自低频。此前它们全部被打进首屏那唯一的 chunk（461KB），
 * 每个访客都要下载、解析、执行一遍。
 *
 * 拆成动态 import 后，它们在真正打开时才拉。Vite 会自动给它们各自切出独立 chunk
 * （文件名带 hash，可长缓存）。注意这些组件都有 default export，`lazy` 才能直接用。 */
const AdminView = lazy(() => import('./pages/AdminView'))
const SettingsView = lazy(() => import('./pages/SettingsView'))
const ShareView = lazy(() => import('./pages/ShareView'))
const CoupleView = lazy(() => import('./pages/CoupleView'))
const AppsView = lazy(() => import('./pages/AppsView'))
const AppEntryHost = lazy(() => import('./components/AppEntryHost'))
const PhotoReviewModal = lazy(() => import('./components/PhotoReviewModal'))

/* ---------------- 首屏只留「本周」，其余三个常驻 tab 也按需加载 ----------------
 *
 * 为什么连底栏 tab 也要拆：底栏 4 个 tab 只是"入口常驻"，不代表"代码必须常驻"。
 * 实测（esbuild metafile）首屏 chunk 里 ScheduleView 13.7KB、DDLView 8.5KB、
 * ProfileView 18.3KB 的压缩前代码，加上它们专属的依赖（WeekGrid / MonthView /
 * CourseMisImport / ExamMisImport / FeedbackForm / MessageCenter …）合计约 90KB。
 * 而启动后**只会渲染其中一个 tab**，另外三个是纯下载 + 解析 + 执行开销。
 *
 * ⚠️ 代价是切 tab 时会有一次几百毫秒的 chunk 拉取。因此配合两件事缓解：
 *   1. `idlePrefetch()` —— 首屏画完后在浏览器空闲时把这些 chunk 预热进 HTTP 缓存，
 *      用户真去点时是从缓存里读，几乎无感（见下方 useEffect）。
 *   2. 每个 tab 都有骨架屏 fallback，不会出现空白页。
 * 语义上这仍是 SPA 的懒路由，只是把"必须等"换成了"先看见、后填充"。 */
const ScheduleView = lazy(() => import('./pages/ScheduleView'))
const DDLView = lazy(() => import('./pages/DDLView'))
const ProfileView = lazy(() => import('./pages/ProfileView'))

/* 浮层与表单：全部只在用户触发时才需要，没有理由进首屏。
 * CourseForm 7.9KB / TaskForm 5.5KB / CoursePhotoImport 4.4KB / LoginSheet(含 AuthForm)
 * 9KB+ / OnboardingGuide 2.5KB —— 合计约 30KB，而首屏一次都用不到。
 * LoginSheet 尤其值得拆：它带着整块 AuthForm（登录/注册/学号登录/验证码）。 */
const CourseForm = lazy(() => import('./components/CourseForm'))
const TaskForm = lazy(() => import('./components/TaskForm'))
const CoursePhotoImport = lazy(() => import('./components/CoursePhotoImport'))
const CourseMisImport = lazy(() => import('./components/CourseMisImport'))
const LoginSheet = lazy(() => import('./components/LoginSheet'))
const OnboardingGuide = lazy(() => import('./components/OnboardingGuide'))
const RecogFab = lazy(() => import('./components/RecogFab'))

/**
 * 空闲时预热 chunk：首屏画完后，在浏览器空闲里把上面这些动态 import 提前拉下来。
 *
 * 为什么必须等 idle 而不是紧跟首屏：这些 chunk 会和白屏无关，但会**抢带宽**。
 * 4G 下单条连接的有效吞吐有限，首屏还没落定时就并发拉 90KB，等于把 LCP 往后推。
 * requestIdleCallback 的 timeout 兜底保证最迟 2.5s 内一定开始 —— 即使用户在
 * 完全空闲前就点了 tab，那次 import 也是幂等的（同一个 promise，不会重复下载）。
 */
function idlePrefetch(tasks: (() => Promise<unknown>)[]) {
  const run = () => {
    for (const t of tasks) void t().catch(() => {})
  }
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof ric === 'function') ric(run, { timeout: 2500 })
  else setTimeout(run, 1200)
}

/** 懒加载 chunk 的占位：不做骨架屏，只留一个与内容区同色的空块，避免闪烁 */
function PageFallback() {
  return <div className="page-loading" aria-busy="true" />
}

/**
 * 每个页面外面的一层「隔离带」：ErrorBoundary + Suspense。
 *
 * 为什么要按页面隔离：整页只有一个边界时，任何一个页面的渲染异常都会让**整个应用**
 * 变成错误页（底栏也没了，用户连切走都做不到）。按页隔离后，坏的是"这一页"，
 * 底栏还能用、可以切到别的 tab —— 这对"某条脏数据导致某页必崩"的场景是决定性的。
 * `key` 由调用方给（各分支已经有稳定的 key），保证切页时边界自动复位。
 *
 * `fallback` 默认是空块；三个常驻 tab 现在都是懒加载的，切过去要等一次 chunk
 * 下载，空白几百毫秒会被当成"点了没反应"，所以它们各自传了同构骨架屏。
 */
function Page({ title, children, fallback }: { title?: string; children: React.ReactNode; fallback?: React.ReactNode }) {
  return (
    <ErrorBoundary title={title}>
      <Suspense fallback={fallback ?? <PageFallback />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

type Tab = 'week' | 'schedule' | 'ddl' | 'profile'

/** 底栏从左到右的顺序。页面切换动画靠它判断"往左切还是往右切"，
 *  必须与 navItems 里的顺序保持一致（两者都只增不减地挂在底栏上）。 */
const TAB_ORDER: Tab[] = ['week', 'schedule', 'ddl', 'profile']

/* ---------------- hash 深度链接（评审 C8 / 功能 F6，2026-10-23） ----------------
 * URL 形态：`#/week` `#/schedule` `#/ddl` `#/profile`、应用目录 `#/apps`、
 * 具体应用 `#/apps/<entryId>`。带来的能力：刷新不丢页面、可分享"第 8 周课表"
 * 这类入口、系统返回键/浏览器后退可以回到上一个 tab。
 * 设置/管理/空闲课表/情侣课表这些**一次性全屏层**不进 hash（打开时 hash 落回底层
 * tab）—— 它们是覆盖态不是目的地，塞进 URL 会让分享出去的链接落在层内空白页。 */
const HASH_TABS: readonly Tab[] = ['week', 'schedule', 'ddl', 'profile']

function parseTabHash(): { tab: Tab; showApps: boolean; appPage: string | null } {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (!h) return { tab: 'week', showApps: false, appPage: null }
  const [head, sub] = h.split('/')
  if ((HASH_TABS as readonly string[]).includes(head)) {
    return { tab: head as Tab, showApps: false, appPage: null }
  }
  if (head === 'apps') {
    /* entryId 需要是注册过的应用，防随机串落进兜底分支 */
    const entry = sub && findEntry(sub) ? sub : null
    return { tab: 'week', showApps: true, appPage: entry }
  }
  return { tab: 'week', showApps: false, appPage: null }
}

/**
 * 需要登录才能用的动作。
 *
 * 为什么是这几个：它们要么花**真钱或真额度**，要么**跨账号共享数据** ——
 * 课表导入会登录学校门户（消耗学校侧风控额度、也是撞库放大器），
 * 拍照导入会调用视觉大模型（按次计费），教务导入考试同理；
 * 空闲课表 / 情侣课表则是把课表交给**别人**看，而游客账号 14 天不活跃即被回收，
 * 用它加入群组等于给群主塞进一个随时会消失的成员（服务端 requireRealUser 同样拦）。
 * 其余功能（看课表、加课、记 DDL、改学期设置、反馈）游客都能正常用。
 *
 * ⚠️ 这里只是前端的**引导**：真正的拦截在服务端 requireRealUser（返回 403）。
 * 前端藏按钮挡不住任何人，所以任何"安全"判断都不要只写在这里。
 */
type GuestAction = 'mis' | 'photo' | 'exam' | 'share' | 'couple'

/** 三个动作对应的引导文案：说清"登录能得到什么"，而不是干巴巴一句"请先登录" */
const LOGIN_REASON: Record<GuestAction, string> = {
  mis: '登录后即可用学号一键导入本学期课表，自动读取课名、时间、教室与学分。',
  photo: '登录后即可拍照识别课表截图，自动生成课程。',
  exam: '登录后即可从教务系统抓取本学期考试安排，并一键生成 DDL。',
  share: '登录后即可创建/加入空闲课表群组 —— 共享需要稳定账号，游客身份会被定期回收。',
  couple: '登录后即可绑定情侣课表，两个人的课表会保存在各自账号里。'
}

/** 迁移结果 → toast 文案 */
function claimToast(r: { courses: number; tasks: number; exams: number }): string {
  const parts: string[] = []
  if (r.courses > 0) parts.push(`${r.courses} 门课程`)
  if (r.tasks > 0) parts.push(`${r.tasks} 条 DDL`)
  if (r.exams > 0) parts.push(`${r.exams} 场考试`)
  return parts.length > 0 ? `已保留未登录期间的${parts.join('、')}` : '登录成功'
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [booted, setBooted] = useState(false)
  /* 评审 C8：初始 tab / 应用子页从 URL hash 恢复 —— 刷新不再恒落回「本周」，
     分享 #/apps/mailbox 这类链接能直达。 */
  const [tab, setTab] = useState<Tab>(() => parseTabHash().tab)
  /**
   * 上一次的 tab 在底栏里的序号，用来判断"往左切还是往右切"。
   * 只给页面切换动画挑方向用（见 .anim-content 的 data-nav-dir），
   * 不参与任何业务逻辑，所以用 ref 而不是 state —— 换 tab 本身已经会触发重渲染。
   */
  /**
   * 上一次的 tab 在底栏里的序号，用来判断"往左切还是往右切、跳了几格"。
   * 只给页面切换动画挑方向用（见 .anim-content 的 data-nav-dir / --nav-shift），
   * 不参与任何业务逻辑，所以用 ref 而不是 state —— 换 tab 本身已经会触发重渲染。
   */
  const prevTabIdxRef = useRef(TAB_ORDER.indexOf(parseTabHash().tab))
  /**
   * 入场动画的方向与位移量，一次算完（两件事都依赖"和上一格差了几步"，
   * 拆成两个 useMemo 就得靠两条 ref 各自记账，先后顺序一错就会算出错误的方向）。
   *
   * 用 useMemo 在渲染期算而不是放 effect —— effect 要等一帧后才跑，
   * 那时 .anim-content 的入场动画已经开始播了，挂上去的属性也赶不上。
   *
   * 位移量随"跳了几格"变大：1 格 18px、2 格 24px、3 格 30px。
   * 和底栏那颗水珠同一个道理 —— 从「本周」直接点到「我的」，
   * 水珠是横穿三格甩过去的，内容如果只挪 18px 就接不上那个动势。
   * 上限 30px：再大页面就像在"整屏滑动"，而这里只是换 tab，不是分页器。
   */
  const navMotion = useMemo(() => {
    const next = TAB_ORDER.indexOf(tab)
    const prev = prevTabIdxRef.current
    prevTabIdxRef.current = next
    if (prev < 0 || next < 0 || prev === next) return { dir: 0, shift: 18 }
    const steps = Math.min(3, Math.abs(next - prev))
    return { dir: next > prev ? 1 : -1, shift: 18 + (steps - 1) * 6 }
  }, [tab])
  const [showSettings, setShowSettings] = useState(false)
  /** 管理员后台：入口在个人中心（底栏保持 4 个常用 tab） */
  const [showAdmin, setShowAdmin] = useState(false)
  /**
   * 空闲课表 / 情侣课表：两个全屏子页，入口在「我的」与课表页。
   * 为什么不给它们各加一个底栏 tab：底栏四个 tab 是"每天都要用"的功能，
   * 而这两个是**低频协作型**功能（一学期用几次），挤掉一个常用 tab 不划算。
   */
  const [showShare, setShowShare] = useState(false)
  const [showCouple, setShowCouple] = useState(false)
  /**
   * 「应用」目录页：同样是一个全屏子页。
   * 为什么不用底栏第 5 个 tab：底栏四个位置留给"每天都要用"的功能
   * （本周 / 课表 / DDL / 我的），「应用」是**功能索引**、低频，塞进底栏
   * 会挤掉一个常用入口。入口在「我的」页，与「时间协作」同一处理方式。
   */
  const [showApps, setShowApps] = useState<boolean>(() => parseTabHash().showApps)
  /**
   * 从「应用」目录进入的具体应用子页（null = 停在目录页）。
   * 为什么不给每个应用建一个 `showXxx` 布尔量：应用会持续增加，
   * 每加一个就要在 App 里加一个 state + 一个渲染分支，很快就失控。
   * 用一个联合类型字符串收敛，新增应用只改这里和下面那处 switch。
   */
  const [appPage, setAppPage] = useState<string | null>(() => parseTabHash().appPage)
  /**
   * 打开情侣课表时默认停在哪个页签。
   * 从「消息通知」的共同计划通知点进来时置 `'plan'`（直接看计划）；
   * 其余入口（「我的」页的入口按钮）保持 `undefined`，即默认的「今日」。
   */
  const [coupleInitialTab, setCoupleInitialTab] = useState<'today' | 'free' | 'plan' | undefined>(undefined)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  /** 启动时的暂时性失败（限流/服务端故障/断网）。有值时显示重试页，**且本地 token 不会被清** */
  const [bootFailure, setBootFailure] = useState<{ message: string; status: number } | null>(null)
  /** 点「重试」时 +1，重新跑一遍启动流程 */
  const [bootRetryKey, setBootRetryKey] = useState(0)
  /**
   * 用户明确要求「使用其他账号登录」。
   *
   * 为什么需要单独一个状态，而不是"清掉 token 再跑一遍启动流程"：
   *   启动流程在无 token 时会**自动签发游客账号**。所以"清 token 重跑"的结果是
   *   用户静默变成了游客、直接进了主界面，根本看不到登录页 —— 按钮的承诺没兑现。
   *   网络不通时更糟：游客也建不出来，又弹回失败页，看起来像按钮坏了。
   *   这个标记让启动流程**跳过游客建号**，直接把登录页露出来。
   */
  const [forceLogin, setForceLogin] = useState(false)
  const [toast, setToast] = useState('')
  /** toast 退场中：先播 200ms 下沉淡出，再真正卸载 */
  const [toastLeaving, setToastLeaving] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setToastLeaving(false)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (toastHideTimer.current) clearTimeout(toastHideTimer.current)
    toastTimer.current = setTimeout(() => setToastLeaving(true), 2500)
    toastHideTimer.current = setTimeout(() => {
      setToast('')
      setToastLeaving(false)
    }, 2720)
  }, [])

  // 卸载时清掉 toast 定时器
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      if (toastHideTimer.current) clearTimeout(toastHideTimer.current)
    },
    []
  )

  /* ---------------- 未读站内信角标 ----------------

     为什么必须放在 App 层：站内信是**权威通知链路**（管理员回复、成绩/作业变动、
     共同计划提醒都走它），但此前只有进「我的」页才拉一次未读数 ——
     用户不点进去就永远不知道有新消息，"主动提醒"变成了"主动查看"。
     现在底栏「我的」上直接带数字，登录后拉一次，回到前台再拉（30s 节流）。

     ⚠️ 红点必须"读完就消失"，所以这里直接用服务端未读数，不做本地水位线。
     曾经把它改成"本次进入应用以来的最高未读数（只增不减）"，结果是：
     用户在消息通知里读完了所有消息，底栏红点却要等重新进入应用才消失 ——
     看起来像"红点坏了"。红点的语义就是"现在还有未读"，读完就该灭。
     真正会让红点"卡住"的不是这里，而是**读消息后没人通知 App 重新拉一次**：
     MessageCenter 读完消息只回调给 ProfileView 刷新它自己的小徽标，
     App 层的 unread 完全不知情，只能等 30s 节流或切后台再回前台。
     现在 ProfileView 把 onUnreadChanged 一路透传到 App（见 handleUnreadChanged），
     读完消息立刻强制重拉。 */
  const [unread, setUnread] = useState(0)
  const unreadFetchedAt = useRef(0)

  const refreshUnread = useCallback((force = false) => {
    const now = Date.now()
    if (!force && now - unreadFetchedAt.current < 30_000) return
    unreadFetchedAt.current = now
    getUnreadMessageCount()
      /* ⚠️ 接口返回的是 `{ count: number }`（见 api.ts 的 getUnreadMessageCount），不是裸数字。
         这里曾经写成 `typeof n === 'number' ? n : 0` —— 那个判断恒为假，未读数永远是 0，
         底栏「我的」上的红点从来没亮过：站内信、共享申请、管理员回复全部静默送达。
         现在取 `.count`，并对形状不符/负数做兜底。 */
      .then((r) => {
        const n = typeof r?.count === 'number' && r.count > 0 ? r.count : 0
        setUnread(n)
      })
      .catch(() => {
        /* 未读数拿不到不影响任何功能，静默 */
      })
  }, [])

  useEffect(() => {
    /* 身份变化（登录 / 切号 / 退出）时立即重拉一次未读数 */
    setUnread(0)
    if (!user) return
    refreshUnread(true)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshUnread()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [user?.id, refreshUnread])

  /** 读消息后由 ProfileView / MessageCenter 一路透传过来的"未读变了"信号。
      必须**强制**重拉（跳过 30s 节流），否则用户读完消息底栏红点要等半分钟才灭。 */
  const handleUnreadChanged = useCallback(() => {
    refreshUnread(true)
  }, [refreshUnread])

  /* ---------------- 桌面小组件数据推送（Android 壳 v1.8+） ----------------

     触发时机：登录态变化（user.id）与任何数据变更（refreshKey，所有页面的
     onMutated 都汇到这里）。断网 / 限流时静默放弃 —— 小组件继续显示上一次快照，
     绝不能因为小组件而打扰网页内的用户。

     为什么在 App 层单独取数而不复用 HomeView 的数据：
     - 各页面只持有自己那一份（本周页有课表、DDL 页只有任务），谁都不完整；
     - 用户在 DDL 页勾完一条就切走时，本周页根本没挂载，没有可复用的取数时机。
     仅在壳里（有 BjtuWidget 桥）才发这两个请求，浏览器用户零开销；
     600ms 防抖把"批量导入/连续勾选"的变更风暴合并成一次推送。 */
  const widgetUserId = user?.id
  useEffect(() => {
    if (widgetUserId === undefined || !hasWidgetBridge()) return
    let cancelled = false
    const timer = setTimeout(() => {
      Promise.all([getHome(), getTasks()])
        .then(([home, tasks]) => {
          if (!cancelled) pushWidgetSnapshot(home, tasks)
        })
        .catch(() => {
          /* 静默：取数失败保留小组件上一次的快照 */
        })
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [widgetUserId, refreshKey])

  /* 新版本已接管：提示用户刷新（懒加载 chunk 换名后，旧页面可能拉到不存在的文件） */
  useEffect(() => {
    return onServiceWorkerUpdate(() => {
      showToast('已更新到新版本，刷新后生效')
    })
  }, [showToast])

  const [courseOpen, setCourseOpen] = useState(false)
  const [courseInitial, setCourseInitial] = useState<Course | null>(null)
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskInitial, setTaskInitial] = useState<Task | null>(null)
  const [photoImportOpen, setPhotoImportOpen] = useState(false)
  /** 课表导入弹窗（智慧课程平台 / 本科教务）。挂在 App 层而不是课表页，
      这样新手指引、本周页空态引导卡都能直接打开它，不依赖当前 tab。 */
  const [misImportOpen, setMisImportOpen] = useState(false)
  /** 新用户引导浮层：me()/登录返回 onboarded=0 时弹出一次（**游客不弹**，见 boot 处注释） */
  const [showOnboarding, setShowOnboarding] = useState(false)

  /* ---------------- 未登录游客模式 ---------------- */

  /** 游客点了需要登录的入口时弹出的登录层；null = 没弹 */
  const [loginPrompt, setLoginPrompt] = useState<{ reason: string } | null>(null)
  /** 被登录打断的那个动作，登录+迁移完成后自动续跑（避免用户再点一次） */
  const [pendingAction, setPendingAction] = useState<GuestAction | null>(null)
  /**
   * 让子页面自动打开某个导入弹窗。
   * 为什么不用 pendingAction 直接驱动：课表导入的 open 状态在 ScheduleView 内部、
   * 考务导入在 DDLView 内部，App 拿不到 setter。用一个一次性信号交给对应页面消费。
   */
  const [autoImport, setAutoImport] = useState<GuestAction | null>(null)
  /** 登录后双方都有数据时的三选一（合并 / 覆盖 / 不用了） */
  const [claimDialog, setClaimDialog] = useState<{
    guestToken: string
    guest: GuestDataCounts
    target: GuestDataCounts
  } | null>(null)

  // 课表拍照识别：后台统一轮询 + 课表页悬浮球（jobId 持久化，刷新可恢复）
  const { job: recogJob, claim: claimRecog, dismiss: dismissRecog } = useRecognizer()
  const [fabReviewOpen, setFabReviewOpen] = useState(false)

  /* 各页面（本周 / DDL / 月视图）都自带 getOverview 拉取，App 层不再重复缓存一份 overview：
     之前这份数据唯一用途是驱动浏览器通知，通知入口移除后即为死状态。 */

  const loadAppData = useCallback(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {})
  }, [])

  /* 评审 C3（2026-10-23）：会话中途 401 的统一出口。token 被吊销（管理员重置密码 /
     学号接管 —— 都是已实现的机制）后，api.ts 会派发全局事件，这里弹登录引导。
     此前所有页面只会显示各自的「加载失败」，用户不知道自己已被登出。
     事件本身已在 api.ts 排除登录/游客通道自身的 401，不会连环弹窗。 */
  useEffect(() => {
    const onSessionExpired = () => {
      setLoginPrompt({ reason: '登录状态已失效（密码可能被重置，或账号已在其他设备重新登录），请重新登录以继续。' })
    }
    window.addEventListener('bjtu:session-expired', onSessionExpired)
    return () => window.removeEventListener('bjtu:session-expired', onSessionExpired)
  }, [])

  /* 评审 C8：hash ↔ {tab, appPage} 单向写同步（replaceState，不压历史条目）。
     为什么不用 pushState：lib/back.ts 已经用 pushState/popstate 自管一套"应用内
     返回步骤"（弹层、应用子页的 Android 返回键），再往同一历史栈压 hash 条目会
     让两层机制互相吞返回键。所以 hash 只承担"刷新保持 + 可分享"，
     返回键语义完全交给 back.ts。外部导航（书签/别的 tab 切回来）用 hashchange
     把 hash 读回状态，保证不出现"URL 是 A、页面是 B"。 */
  useEffect(() => {
    const h = showApps
      ? appPage
        ? `#/apps/${appPage}`
        : '#/apps'
      : `#/${tab}`
    if (window.location.hash !== h) history.replaceState(null, '', h)
  }, [tab, showApps, appPage])

  useEffect(() => {
    const onHashChange = () => {
      /* 这次回退如果是 UI 关浮层自己造的（见 lib/back.ts 的 internalPopPending），
         它带回的 URL 是关浮层之前那一页，拿它重置状态会把用户刚点开的页面顶掉
         （典型：消息通知点「校园邮箱」→ 又被切回个人中心）。跳过即可 ——
         紧接着上面那个 effect 会把 hash 重新写成当前真实页面。 */
      if (consumeInternalPop()) return
      const p = parseTabHash()
      setTab(p.tab)
      setShowApps(p.showApps)
      setAppPage(p.appPage)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  /* 启动流程（2026-10-04 起未登录也能用）：
       有 token → me() 校验
         ├─ 成功 → 正常进入（游客 token 也走这条，user.isGuest 决定界面差异）
         └─ 失败 → 清 token，落到「无 token」分支
       无 token → 静默签发一个游客账号
         ├─ 成功 → 正常进入
         └─ 失败 → 整页 AuthView 兜底（断网 / 被限流 / 隐私模式禁 localStorage）

     ⚠️ AuthView 这条兜底**不能删**：它是"游客建号失败时唯一的可用入口"，
     也是"我就是要直接登录老账号"的正式路径。 */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const token = getToken()
      /* 先把上一次的用户快照画上去，再去校验 token。
         实测：不这么做时，真实界面要等到 me() 回来（冷启动 4G 下多 460ms）。
         快照只用于"先画出来"，**不参与任何权限判断** —— 见 lib/userCache.ts。
         pruneUserSnapshots 顺手清掉过期账号留下的桶（游客 token 每次重签都是新桶）。 */
      const snapshot = token ? readUserSnapshot(token) : null
      if (snapshot) {
        setUser(snapshot)
        applyUserAppearance(snapshot)
        /* 立即放行到主界面：顶栏头像/昵称、底栏、骨架化的首页都能画了。
           数据接口会各自发请求，拿到就填、失败就显示各自的错误态。 */
        setBooted(true)
      }
      if (token) pruneUserSnapshots(token)
      if (token) {
        try {
          /* 对暂时性失败做有限重试：每次发布都会重启服务约 1~3 秒，
             恰好在这窗口打开页面的用户不该因此被登出（更不该被清 token）。 */
          /* ⚠️ me() 与 getSettings() 必须**并行**：getSettings 只需要 localStorage 里
             已有的 token，不依赖 me() 的返回值。此前是 me() → 再 getSettings()，
             等于在 4G 上白丢一个 RTT（100ms 左右），而且首屏要等这两跳都结束才开始渲染。
             getSettings 失败不影响登录流程（设置拿不到就用默认值）。 */
          const [{ user }, settings] = await Promise.all([
            withTransientRetry(() => me()),
            getSettings().catch(() => null)
          ])
          if (cancelled) return
          setUser(user)
          writeUserSnapshot(token, user)
          if (settings) setSettings(settings)
          /* 新手指引只给**真实账号**弹：游客是"路过看看"，上来先甩一个全屏引导
             反而挡住他想看的东西；等他真注册/登录了，再按 onboarded 弹一次。 */
          if (!user.onboarded && !user.isGuest) setShowOnboarding(true)
          applyUserAppearance(user)
          return
        } catch (err) {
          /* ⚠️ 这里曾经是 `catch { clearToken() }` —— 一把抓的写法造成过一个真实事故：
             校园网抖动/被限流（429）/服务端 5xx 都会被当成"登录失效"，直接把本地 token 抹掉，
             用户被静默登出且无法自愈（重开还是登录页，而本校学生多用学号+教务密码，多数不记得密码）。
             现在只认 401：只有凭据**真的**无效才清 token；其余一律保留并提示重试。 */
          const status = statusOf(err)
          if (decideBootFailure(status) === 'clear-token') {
            clearToken()
            clearUserSnapshot(token)
            if (!cancelled) setUser(null)
          } else {
            /* 有快照时**不**弹重试整页：用户已经进到界面里了，再把他拽回"暂时没能加载"
               是一次明显的倒退。各页面自己的请求失败会显示各自的提示，那是更合适的位置。 */
            if (!cancelled && !snapshot) setBootFailure({ message: bootFailureMessage(status), status })
            return
          }
        }
      }
      /* 用户已明确要求"用其他账号登录"：跳过游客建号，直接把登录页露出来。
         这一步不能省 —— 否则会静默签发游客账号，用户根本看不到登录页。 */
      if (forceLogin) return

      try {
        const res = await ensureGuestSession()
        if (cancelled) return
        setToken(res.token)
        setUser(res.user)
        /* 游客身份也存快照：它同样要等一次网络往返才能拿到，而游客是**首访用户**
           的默认状态 —— 恰恰是最需要"打开就能看见界面"的那批人。 */
        writeUserSnapshot(res.token, res.user)
        loadAppData()
      } catch (err) {
        /* 游客账号签发失败（断网 / 被限流 / 隐私模式禁 localStorage）：
           user 保持 null，下面会退回整页 AuthView —— 那是最后一道可用入口。
           但要把原因说清楚，否则用户只看到登录页会以为"我的账号没了"。 */
        if (!cancelled) {
          const status = statusOf(err)
          if (status !== 401) setBootFailure({ message: bootFailureMessage(status), status })
        }
      }
    })().finally(() => {
      if (!cancelled) setBooted(true)
    })
    return () => {
      cancelled = true
    }
  }, [loadAppData, bootRetryKey, forceLogin])

  /* 空闲预热其余 tab 的 chunk。
   *
   * 时机刻意放在 booted 之后：此时首屏的结构已经提交，用户看到的是「加载中…」
   * 或骨架屏；再晚一点（等数据回来、首屏内容填满）也更好，但那时用户可能已经
   * 自己去点 tab 了，预热的收益就浪费了。booted 之后立刻排一个 idle 任务，
   * 浏览器空闲（通常就是等数据的网络空窗）时开始下载，理论上不抢首屏带宽。
   *
   * 只预热首屏会用到的那几个：ScheduleView / DDLView / ProfileView。
   * 表单类（CourseForm 等）用户可能几十秒后才点，交给 HTTP 缓存按需拉；
   * 一次预热 90KB 已经会占掉 4G 两百多毫秒的带宽，不宜再多。 */
  useEffect(() => {
    if (!booted) return
    idlePrefetch([
      () => import('./pages/ScheduleView'),
      () => import('./pages/DDLView'),
      () => import('./pages/ProfileView')
    ])
  }, [booted])

  /* 评审 C6（2026-10-23）：getSettings 只在**会改写 settings** 的操作后才有意义
     （MIS 整表导入写官方学分/学期、切换学期）。勾 DDL、删任务这类纯业务写操作
     附带的那一跳是纯浪费 —— 现在按需触发：调用方传 { settings: true } 才刷。 */
  const handleMutated = useCallback((opts?: { settings?: boolean }) => {
    setRefreshKey((k) => k + 1)
    if (opts?.settings) {
      getSettings()
        .then(setSettings)
        .catch(() => {})
    }
  }, [])

  /* ---------------- 登录 + 游客数据迁移 ---------------- */

  /**
   * 登录/注册成功后的统一入口。
   *
   * 关键顺序：**先读出旧 token（= 游客 token）再 setToken(新 token)**。
   * 反过来的话，游客身份就再也找不回来了 —— 用户在未登录期间排的课表会变成孤儿数据，
   * 只能等 14 天 TTL 回收时被删掉，而他本人看到的是"登录一下课表全没了"。
   */
  async function handleAuthed(token: string, u: User) {
    const prevToken = getToken()
    const wasGuest = !!user?.isGuest
    setToken(token)
    setUser(u)
    /* 新账号立刻落一份快照：下次打开就不用等 me() 了。
       同时清掉被替换掉的那个身份的快照（游客桶），否则会白留一份永远读不到的垃圾。 */
    writeUserSnapshot(token, u)
    if (prevToken && prevToken !== token) clearUserSnapshot(prevToken)
    /* 登录成功了，登录页的强制态要撤掉，否则它会在登出后一直压着游客流程 */
    setForceLogin(false)
    setBootFailure(null)
    if (!u.onboarded) setShowOnboarding(true)
    applyUserAppearance(u)
    setLoginPrompt(null)
    /* 有被登录打断的动作时**不要切到「本周」**：用户是在课表页点「课表导入」被拦下的，
       把他扔回首页再自动弹导入框，上下文是断的。 */
    if (!pendingAction) setTab('week')
    loadAppData()

    if (!wasGuest || !prevToken || prevToken === token) {
      finishAuthFlow()
      return
    }

    /* 把未登录期间的数据迁到新账号。失败不能影响登录本身 —— 最坏情况是
       "数据没迁过来"，而"登录失败"要严重得多。 */
    try {
      const pending = await getGuestPending(prevToken)
      if (!pending.hasGuest) {
        // 游客什么都没做（只是逛了逛）：直接把它扔掉，不打扰用户
        await claimGuest(prevToken, 'discard').catch(() => {})
        finishAuthFlow()
        return
      }
      const target = pending.target!
      const targetHasData = target.courses + target.tasks + target.exams > 0
      if (!targetHasData) {
        /* 目标账号是空的（新注册 / 老账号还没建过课表）→ 静默整体接管。
           这是最常见也最该"无感"的一条路径：用户不该为了一件必然的事做选择。 */
        const r = await claimGuest(prevToken, 'merge')
        showToast(claimToast(r))
        finishAuthFlow()
        return
      }
      // 两边都有数据 → 必须问：覆盖会删掉他账号里已有的课表，不能替他决定
      setClaimDialog({ guestToken: prevToken, guest: pending.guest!, target })
    } catch {
      showToast('登录成功，但未登录期间的数据未能自动保留')
      finishAuthFlow()
    }
  }

  /** 迁移流程结束后的收尾：刷新数据 + 续跑被登录打断的那个动作 */
  function finishAuthFlow() {
    handleMutated()
    const a = pendingAction
    if (!a) return
    setPendingAction(null)
    /* 空闲课表 / 情侣课表是整页，不能走 autoImport（那是给"页面内弹窗"用的一次性信号）——
       直接在这里把对应页面打开，效果同样是"用户不必再点一次"。 */
    if (a === 'share') {
      setShowShare(true)
      return
    }
    if (a === 'couple') {
      setShowCouple(true)
      return
    }
    /* 课表导入弹窗也直接在 App 层打开。
       绝不能靠 autoImport 切到课表页再让那页开弹窗：引导层关闭时会 history.back()，
       历史回退触发的 hashchange 会把 tab 重设回「本周」，刚切过去的课表页立刻被卸掉，
       表现为「点了导入什么都没发生」。 */
    if (a === 'mis') {
      setMisImportOpen(true)
      return
    }
    setAutoImport(a)
  }

  /** 用户在「合并 / 覆盖 / 不用了」里做出选择 */
  async function resolveClaim(mode: GuestClaimMode) {
    const d = claimDialog
    setClaimDialog(null)
    if (!d) return
    try {
      const r = await claimGuest(d.guestToken, mode)
      showToast(mode === 'discard' ? '已登录' : claimToast(r))
    } catch {
      showToast('数据保留失败，可在「我的」页重试或联系管理员')
    }
    finishAuthFlow()
  }

  /** 用户按 Esc / 点遮罩 / 返回键关闭弹窗：仅退出弹窗，绝不执行 destructive 的 discard */
  function cancelClaim() {
    setClaimDialog(null)
    showToast('已登录（暂未合并未登录期间的数据）')
    finishAuthFlow()
  }

  /**
   * 需要登录的入口统一走这里。
   * @returns true = 已登录可继续；false = 已弹出登录层，调用方应立即返回
   */
  function requireLogin(action: GuestAction): boolean {
    if (!user?.isGuest) return true
    setPendingAction(action)
    setLoginPrompt({ reason: LOGIN_REASON[action] })
    return false
  }

  /**
   * 「应用」目录 → 具体应用：置 appPage，由下面的分支渲染。
   * （校园邮箱曾是「外链新标签打开」；2026-10-14 起改为站内只读客户端，
   *  在页面内完成 登录 → 回收箱列表 → 详情 → 附件。）
   */
  function openAppEntry(entry: { id: string }) {
    /* 「消息通知」顶部的校园邮箱行也能直接跳邮箱，那条路不经过 AppsView，
       showApps 还是 false —— 不一起置 true 的话 appPage 设了也没人渲染。 */
    setShowApps(true)
    setAppPage(entry.id)
  }

  // 主题监听器句柄：仅「跟随系统」时需要常驻监听，切换或登出时回收
  const themeWatchRef = useRef<() => void>()
  /** 把主题偏好落到页面，并持久化 + 视情况挂系统监听 */
  function applyThemePref(mode: ThemeMode) {
    applyTheme(mode)
    storeTheme(mode)
    themeWatchRef.current?.()
    themeWatchRef.current = undefined
    if (mode === 'system') {
      themeWatchRef.current = watchSystemTheme(() => applyTheme(readStoredTheme()))
    }
  }

  /** 深浅色 + 自选主题色一起落地（登录 / 资料保存后调用） */
  function applyUserAppearance(u: User) {
    applyThemePref(u.theme)
    const accent = u.accent && u.accent !== '' ? u.accent : DEFAULT_ACCENT
    applyAccent(accent)
    storeAccent(accent)
  }

  /** 个人中心保存资料（昵称/头像/主题）后回写顶部状态 */
  function handleProfileSaved(u: User) {
    setUser(u)
    applyUserAppearance(u)
  }

  async function handleLogout() {
    const prevToken = getToken()
    try {
      await logout()
    } catch {
      /* 忽略 */
    }
    clearToken()
    /* 快照必须跟着 token 一起清：否则在同一台设备上"登出→另一个人登录"时，
       新账号的启动快照还没写入前，理论上仍可能读到上一份（桶是按 token 分的，
       正常情况下读不到，但用户若手工把旧 token 塞回来就会命中）。 */
    clearUserSnapshot(prevToken)
    setUser(null)
    setSettings(null)
    setFabReviewOpen(false)
    setLoginPrompt(null)
    setClaimDialog(null)
    setPendingAction(null)
    setAutoImport(null)
    setShowShare(false)
    setShowCouple(false)
    dismissRecog() // 清理后台识别轮询与该用户留下的任务

    /* 登出后回到**游客态**而不是登录页：未登录本来就能用，
       把人推到登录页等于登出一次就用不了 App 了。
       拿不到游客账号时（断网/限流）才退回整页登录。 */
    try {
      const res = await ensureGuestSession()
      setToken(res.token)
      setUser(res.user)
      writeUserSnapshot(res.token, res.user)
      setTab('week')
    } catch {
      /* 拿不到游客账号 → user 保持 null，退回整页登录（见渲染分支） */
    }
  }

  function openNewTask() {
    setTaskInitial(null)
    setTaskOpen(true)
  }
  function openEditTask(t: Task) {
    setTaskInitial(t)
    setTaskOpen(true)
  }
  function openNewCourse() {
    setCourseInitial(null)
    setCourseOpen(true)
  }
  function openEditCourse(c: Course) {
    setCourseInitial(c)
    setCourseOpen(true)
  }
  function closeCourse() {
    setCourseOpen(false)
    setCourseInitial(null)
  }
  function closeTask() {
    setTaskOpen(false)
    setTaskInitial(null)
  }

  const navItems: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'week', label: '本周', icon: <IconHome size={22} /> },
    { key: 'schedule', label: '课表', icon: <IconSchedule size={22} /> },
    { key: 'ddl', label: 'DDL', icon: <IconList size={22} /> },
    /* 论坛已整体下架（2026-10-01），第 4 个 tab 换成「我的」（个人中心全页）。
       未读站内信角标挂在这里：站内信是管理员回复与数据变动的**唯一**送达渠道，
       用户不进「我的」就看不到，所以要在底栏上先给出信号。
       角标 = 服务端未读数，读完消息立刻消失（读完由 MessageCenter → ProfileView →
       App 的 onUnreadChanged 链路强制重拉，见 handleUnreadChanged）。 */
    { key: 'profile', label: '我的', icon: <IconUser size={22} />, badge: unread }
  ]

  /** 结束新手指引：点「开始使用」与按返回键走同一条路径，避免跳过的人下次登录又被拦一次 */
  const finishOnboarding = useCallback(async () => {
    setShowOnboarding(false)
    try {
      await markOnboarded()
      setUser((prev) => (prev ? { ...prev, onboarded: 1 } : prev))
    } catch {
      /* 引导已关闭，标记失败不影响使用，下次登录可能再弹一次 */
    }
  }, [])

  /**
   * 一键导入课表：新手指引第二步、本周页空课表引导卡、游客被拦下后补开，都走这里。
   *
   * 为什么由 App 直接渲染 CourseMisImport，而不是切到课表页再发一次性信号：
   * 引导层（以及 Modal、UseBackStep 管理的浮层）关闭时会 `history.back()` 撤销自己压入的
   * 历史条目，随之而来的 hashchange 会把 tab 从 schedule 重设回 week ——
   * 刚切过去的课表页当场被卸掉，用户看到的是"点了导入没有任何反应"。
   * 弹窗由 App 渲染就没有这个问题：它不依赖当前 tab，关掉引导也不影响它。
   */
  function startImportCourses() {
    if (showOnboarding) void finishOnboarding()
    if (!requireLogin('mis')) return
    setMisImportOpen(true)
  }

  /* 移动端返回：按打开顺序逐层回退（管理/设置/新手指引），最上层不退出应用。
     弹层类（Modal / 课程表单…）在各自组件内部注册；
     个人中心的子页（消息 / 反馈…）由 ProfileView 内部注册，这里不管。 */
  useBackStep(showAdmin, () => setShowAdmin(false))
  useBackStep(showSettings, () => setShowSettings(false))
  useBackStep(showShare, () => setShowShare(false))
  useBackStep(showCouple, () => setShowCouple(false))
  /* 新手指引是全屏浮层，不注册的话返回键会被最上层守卫吞掉 —— 用户既退不出也关不掉浮层，
     看起来就是"按返回没反应"。这里让返回等价于「开始使用」（跳过引导）。 */
  useBackStep(showOnboarding, () => void finishOnboarding())

  /* 页面内左缘右滑兜底：系统手势（Android 全面屏 / iOS 边缘）不接管边缘时才由它接手，
     两者互斥，不会同一次滑动触发两次返回。详见 lib/back.ts。 */
  useEdgeSwipeBack()

  /* 把顶栏实测高度写进 --topbar-h，供吸顶元素（详情页返回栏 / 评论输入条）算 top。
     为什么不用纯 CSS：顶栏高度里含 env(safe-area-inset-top)，刘海机 47px、普通机 0，
     而且昵称长短会让内容换行改变高度。只有实测才能在所有机型上都对齐。
     ResizeObserver 而非 resize 事件：顶栏高度也会因字体加载、横竖屏、折叠屏展开而变化，
     这些都不触发 window.resize。 */
  const topbarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = topbarRef.current
    if (!el) return
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height)
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', `${h}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [user])

  /* 最上层再返回：只有在 App 壳提供了退出桥时才做「再按一次退出」。
     浏览器里无法关闭标签页（也不该关），保持静默吞掉即可，不要假装能退出。 */
  const exitArmedRef = useRef(false)
  useEffect(() => {
    if (!user) return
    armRootBackGuard(() => {
      const bridge = (window as unknown as { BjtuApp?: { exit?: () => void } }).BjtuApp
      if (!bridge?.exit) return true
      if (exitArmedRef.current) {
        bridge.exit() // 第二次：真正退出（返回值已无意义，不再补历史）
        return false
      }
      exitArmedRef.current = true
      showToast('再按一次退出')
      setTimeout(() => {
        exitArmedRef.current = false
      }, 2000)
      return true
    })
  }, [user, showToast])

  /* 网络与离线能力。
     ⚠️ 这两个 hook 必须放在下面的提前 return **之前**。
        App 有 3 个渲染阶段：booted=false → user=null → user 就绪。若写在 `if (!user) return`
        之后，前两个阶段根本执行不到它们，第三阶段 hook 数量突然从 N 变成 N+2，
        React 会抛 "Rendered more hooks than during the previous render" 并卸载整棵树 ——
        表现就是首屏"加载中"闪一下后整页变成深色空白（body 背景还在，但 #root 空了）。
        这个现象极易被误诊成"Service Worker 缓存坏了 / JS 没加载"。
        常驻防护见 scripts/test-hook-order.mts（已接入 verify.mjs）。 */
  const isOnline = useOnlineStatus()
  const offlineCapable = useOfflineCapable()

  if (!booted) {
    /* 与 web/index.html 里 #root 内的静态骨架是**同一个东西**（BootShell 与那段
       标记同构）。HTML 到达时浏览器画的是静态那份；React 接管后再画这份。
       此前这里是一行「加载中…」，问题在于：静态骨架画出来之后 JS 一执行，
       屏幕会先退化成一行灰字、再变成骨架、最后才是内容 —— 三次跳变，
       每次都像"页面重载了"。同一个外壳就不会有这种回退。 */
    return <BootShell />
  }

  /* 暂时性启动失败（限流 / 5xx / 断网）：**保留本地 token**，只提示重试。
     绝不能落到下面的 AuthView —— 那会让用户以为"我的账号被退出了"，
     而实际上他只是遇到了一次网络抖动。 */
  if (bootFailure && !user && !forceLogin) {
    return (
      <div className="auth-screen" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 4 }}>📡</div>
        <h1 style={{ fontSize: 19, margin: '0 0 8px' }}>暂时没能加载</h1>
        <p style={{ color: 'var(--text-2)', fontSize: 13.5, margin: '0 0 6px', lineHeight: 1.65 }}>
          {bootFailure.message}
        </p>
        <p style={{ color: 'var(--text-3)', fontSize: 12.5, margin: '0 0 18px' }}>{BOOT_REASSURANCE}</p>
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={() => {
            setBootFailure(null)
            setBooted(false)
            setBootRetryKey((k) => k + 1)
          }}
        >
          重试
        </button>
        <button
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: 10 }}
          onClick={() => {
            /* 用户明确要求换号：这时才清 token，属于用户自己的选择。
               同时置 forceLogin 让启动流程**不要**再自动签发游客 —— 否则用户
               会静默变成游客直接进主界面，压根看不到登录页。 */
            clearToken()
            setBootFailure(null)
            setForceLogin(true)
          }}
        >
          使用其他账号登录
        </button>
      </div>
    )
  }

  /* !user 现在只发生在一种情况：**游客账号也拿不到**（断网 / 被限流 / 隐私模式禁 localStorage）。
     正常访客启动时会静默拿到游客身份，走下面的主界面。 */
  if (!user) {
    return <AuthView onAuthed={handleAuthed} />
  }

  const isGuest = !!user.isGuest

  return (
    <div className="app">
      <div className="topbar" ref={topbarRef}>
        {/* 顶栏头像：点击直接切到「我的」tab（原来是弹层入口，个人中心改为全页后统一走 tab） */}
        <button className="brand" onClick={() => setTab('profile')} aria-label="个人中心" title="个人中心">
          {user.avatar ? (
            <img className="brand-avatar" src={user.avatar} alt={user.nickname || user.username} />
          ) : (
            <span className="brand-avatar-fallback">{initialOf(user.nickname || user.username)}</span>
          )}
          <span className="brand-text">
            <span className="brand-name">
              {user.nickname || user.username}
              {isGuest && <span className="guest-chip">游客</span>}
            </span>
            {/* 游客态把副标题改成一句说明，承担"告诉用户数据现在只在这台设备上"的职责 */}
            <span className="brand-sub">{isGuest ? '未登录 · 数据待保存' : '个人中心'}</span>
          </span>
        </button>
        {isGuest && (
          <button className="guest-login-btn" onClick={() => setLoginPrompt({ reason: '登录后课表、DDL、考试都会保存到你的账号，换设备也能看到。' })}>
            登录 / 注册
          </button>
        )}
      </div>

      {!isOnline && (
        <div
          role="status"
          style={{
            /* 必须用主题里真实存在的变量：--warn-soft / --warn 在深浅两套主题下都有定义，
               而临时编造的 --warn-bg 之类并不存在，只能靠硬编码兜底 —— 浅色主题下会很难看。 */
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            borderBottom: '1px solid var(--warn)',
            padding: '7px 14px',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontWeight: 500
          }}
        >
          <span>📡</span>
          <span>
            {offlineCapable
              ? '离线模式 · 显示的是上次缓存的数据，修改需联网后才会保存'
              : '当前没有网络连接 · 联网后即可继续使用'}
          </span>
        </div>
      )}

      {showSettings ? (
        <div className="content anim-content" key="settings">
          <Page title="设置页出了点问题">
            <SettingsView
              settings={settings}
              onBack={() => setShowSettings(false)}
              onSaved={(s) => {
                setSettings(s)
                showToast('设置已保存')
                /* s 就是刚保存的最新设置，无需再打一跳 getSettings（评审 C6） */
                handleMutated()
              }}
              /* 切换当前学期后：课表/本周/月视图都要按新学期重新取数，
                 handleMutated({ settings: true }) 会 bump refreshKey 并重取 settings，正好覆盖 */
              onTermChanged={() => {
                showToast('已切换学期')
                handleMutated({ settings: true })
              }}
              onLogout={handleLogout}
            />
          </Page>
        </div>
      ) : showAdmin ? (
        <div className="content anim-content" key="admin">
          <Page title="管理页出了点问题">
            <AdminView currentUser={user} onBack={() => setShowAdmin(false)} />
          </Page>
        </div>
      ) : showShare ? (
        <div className="content anim-content" key="share">
          <Page title="空闲课表页出了点问题">
            <ShareView
              onBack={() => setShowShare(false)}
              onToast={showToast}
              onRequireLogin={() => requireLogin('share')}
            />
          </Page>
        </div>
      ) : showApps ? (
        <div className="content anim-content" key="apps">
          <Page title="应用页出了点问题">
            {appPage ? (
              /* 应用子页：返回键回目录，而不是直接回主界面 —— 与用户的空间感一致。 */
              <AppEntryHost
                entryId={appPage}
                onBack={() => setAppPage(null)}
                onToast={showToast}
                refreshKey={refreshKey}
                onMutated={handleMutated}
              />
            ) : (
              <AppsView
                onBack={() => setShowApps(false)}
                isGuest={!!user?.isGuest}
                onRequireLogin={() => {
                  setPendingAction(null)
                  setLoginPrompt({ reason: '登录后即可使用成绩、作业、课件等需要学校账号的功能。' })
                }}
                onOpen={(entry) => {
                  /* 需要登录的功能：游客点按先引导登录（与课表导入、空闲课表同一策略）。
                     真正的拦截在服务端 requireRealUser，这里只是引导。 */
                  if (entry.needLogin && user?.isGuest) {
                    setPendingAction(null)
                    setLoginPrompt({ reason: `「${entry.title}」需要学校账号才能使用，登录后即可打开。` })
                    return
                  }
                  openAppEntry(entry)
                }}
              />
            )}
          </Page>
        </div>
      ) : showCouple ? (
        <div className="content anim-content" key="couple">
          <Page title="情侣课表页出了点问题">
            <CoupleView
              onBack={() => setShowCouple(false)}
              onToast={showToast}
              onRequireLogin={() => requireLogin('couple')}
              onMutated={handleMutated}
              initialTab={coupleInitialTab}
            />
          </Page>
        </div>
      ) : (
        <div
          className="content anim-content"
          key={tab}
          data-nav-dir={navMotion.dir}
          style={{ '--nav-shift': `${navMotion.shift}px` } as React.CSSProperties}
        >
          {/* fallback 按当前 tab 选骨架：这三个页面都是懒加载的，切过去时要等一次
              chunk 下载。空白几百毫秒会被当成"点了没反应"，骨架屏则和内容同构。 */}
          <Page
            title="这一页出了点问题"
            fallback={tab === 'schedule' ? <ScheduleSkeleton /> : tab === 'ddl' ? <TaskListSkeleton rows={5} /> : <HomeSkeleton />}
          >
          {tab === 'week' && (
            <HomeView
              settings={settings}
              refreshKey={refreshKey}
              onMutated={handleMutated}
              onEditTask={openEditTask}
              onEditCourse={openEditCourse}
              onGotoSchedule={() => setTab('schedule')}
              onGotoDDL={() => setTab('ddl')}
              /* 空课表引导：直接走「课表导入」（默认智慧课程平台），
                 不把用户丢到课表页再自己找按钮。 */
              onImportCourses={startImportCourses}
              /* 手动加一条 DDL 游客也能用（游客库同样能存，登录后再合并），
                 与 DDL 页的「新建」同一条路径，不做登录拦截。 */
              onNewTask={openNewTask}
              onToast={showToast}
            />
          )}
          {tab === 'schedule' && (
            <ScheduleView
              settings={settings}
              refreshKey={refreshKey}
              onMutated={handleMutated}
              onEditTask={openEditTask}
              onEditCourse={openEditCourse}
              onAddCourse={openNewCourse}
              onImportPhoto={() => {
                /* 拍照导入要花钱（视觉大模型按次计费）→ 游客先登录 */
                if (!requireLogin('photo')) return
                setPhotoImportOpen(true)
              }}
              onOpenSettings={() => setShowSettings(true)}
              /* 课表页自己的「课表导入」按钮也交给 App 层的同一个弹窗：
                 这里必须经过 requireLogin，游客会在登录完成后由 finishAuthFlow 补开。 */
              onOpenMisImport={() => startImportCourses()}
              onRequireLogin={() => requireLogin('mis')}
              onOpenShareGroups={() => {
                if (!requireLogin('share')) return
                setShowShare(true)
              }}
              onToast={showToast}
            />
          )}
          {tab === 'ddl' && (
            <DDLView
              refreshKey={refreshKey}
              onMutated={handleMutated}
              onEditTask={openEditTask}
              onAddTask={openNewTask}
              onToast={showToast}
              autoOpenImport={autoImport === 'exam' ? 'exam' : null}
              onAutoOpenHandled={() => setAutoImport(null)}
              onRequireLogin={() => requireLogin('exam')}
            />
          )}
          {tab === 'profile' && (
            <ProfileView
              user={user}
              onSaved={handleProfileSaved}
              onLogout={handleLogout}
              onToast={showToast}
              onOpenAdmin={() => setShowAdmin(true)}
              onOpenShareGroups={() => {
                if (!requireLogin('share')) return
                setShowShare(true)
              }}
              onOpenCouple={() => {
                if (!requireLogin('couple')) return
                setCoupleInitialTab(undefined)
                setShowCouple(true)
              }}
              onOpenCouplePlans={() => {
                if (!requireLogin('couple')) return
                setCoupleInitialTab('plan')
                setShowCouple(true)
              }}
              onOpenApps={() => setShowApps(true)}
              onOpenMailbox={() => openAppEntry({ id: 'mailbox' })}
              onUnreadChanged={handleUnreadChanged}
              onRequireLogin={() => {
                setLoginPrompt({ reason: '登录后课表、DDL、考试都会保存到你的账号，换设备也能看到。' })
              }}
            />
          )}
          </Page>
        </div>
      )}

      {!showSettings && !showAdmin && !showShare && !showCouple && !showApps && (
        <NavBar
          items={navItems}
          active={tab}
          onChange={(k) => setTab(k as Tab)}
          onActiveReselect={() => {
            // 再次点击当前 tab：重拉本页数据并回到顶部（当作"刷新"）
            setRefreshKey((k) => k + 1)
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        />
      )}

      {/* 下面这些浮层/表单都是懒加载的，必须各自包一层 Suspense：
          它们在事件回调里被 setState 打开，属于"同步输入引发的更新"，没有边界时
          React 会抛 "A component suspended while responding to synchronous input"。
          fallback 全部用 null：都是盖在内容之上的浮层，下载的几百毫秒里什么都不显示，
          比先闪一个空框再换成真内容稳。 */}
      {courseOpen && (
        <Suspense fallback={null}>
          <CourseForm settings={settings} initial={courseInitial} onSaved={handleMutated} onClose={closeCourse} />
        </Suspense>
      )}
      {taskOpen && (
        <Suspense fallback={null}>
          <TaskForm initial={taskInitial} onSaved={handleMutated} onClose={closeTask} onToast={showToast} />
        </Suspense>
      )}
      {/* 课表导入弹窗：挂在 App 层，新手指引、本周页空态卡、课表页按钮共用同一个。
          它自带 Modal（Portal 到 body），不受当前 tab 与浮层层级影响。 */}
      {misImportOpen && (
        <Suspense fallback={null}>
          <CourseMisImport
            onClose={() => setMisImportOpen(false)}
            onImported={(opts) => {
              setMisImportOpen(false)
              handleMutated(opts)
              showToast('课程已导入')
            }}
          />
        </Suspense>
      )}

      {photoImportOpen && (
        <Suspense fallback={null}>
          <CoursePhotoImport
            onStartBackground={(jobId) => claimRecog(jobId)}
            onClose={() => setPhotoImportOpen(false)}
          />
        </Suspense>
      )}

      {/* 课表页后台识别悬浮球：仅当存在活跃识别任务时渲染（本就在 schedule 页显示） */}
      {recogJob && tab === 'schedule' && (
        <Suspense fallback={null}>
          <RecogFab
            job={recogJob}
            onClick={() => {
              // 识别完成（有结果）→ 点开确认导入
              if (recogJob.status === 'done' && recogJob.result) setFabReviewOpen(true)
              // 识别失败 → 提示原因并收尾悬浮球
              else if (recogJob.status === 'failed') {
                showToast(recogJob.error || '识别失败，请重试')
                dismissRecog()
              }
              // 识别中：点击无操作（仅展示进度）
            }}
            onDismiss={dismissRecog}
          />
        </Suspense>
      )}

      {/* 悬浮球点开：核对识别结果并覆盖导入；导入成功后清掉后台任务。
          PhotoReviewModal 现在是懒加载的，必须包 Suspense —— 否则首次打开会抛
          "A component suspended while responding to synchronous input"。
          fallback 用 null：这是浮层，加载几百毫秒期间什么都不显示比闪一下空白更稳。 */}
      {fabReviewOpen && recogJob?.result && (
        <Suspense fallback={null}>
          <PhotoReviewModal
            result={recogJob.result}
            onImported={() => {
              handleMutated()
              showToast('课程已导入')
              setFabReviewOpen(false)
              dismissRecog()
            }}
            onClose={() => {
              setFabReviewOpen(false)
              // 完成查看：用户不再需要悬浮球时收尾（若 job 已 done）
              dismissRecog()
            }}
          />
        </Suspense>
      )}

      {toast && (
        <div key={toast} className={`toast${toastLeaving ? ' leaving' : ''}`}>
          {toast}
        </div>
      )}

      {/* 游客点了需要登录的入口 → 就地弹登录层，登录完成后原动作自动继续（见 finishAuthFlow） */}
      {loginPrompt && (
        <Suspense fallback={null}>
          <LoginSheet
            reason={loginPrompt.reason}
            onAuthed={handleAuthed}
            onClose={() => {
              setLoginPrompt(null)
              setPendingAction(null) // 用户放弃了这个动作，别在他下次登录时突然弹出来
            }}
          />
        </Suspense>
      )}

      {/* 登录后双方都有数据：必须让用户选，不能替他决定（覆盖会删掉他账号里已有的课表） */}
      {claimDialog && (
        <Modal open title="保留未登录期间的数据？" onClose={cancelClaim}>
          <p className="subpage-lead" style={{ marginBottom: 12 }}>
            你在未登录期间有 {claimDialog.guest.courses} 门课程、{claimDialog.guest.tasks} 条 DDL
            {claimDialog.guest.exams > 0 ? `、${claimDialog.guest.exams} 场考试` : ''}，
            而当前账号里已有 {claimDialog.target.courses} 门课程、{claimDialog.target.tasks} 条 DDL。
          </p>
          <div className="claim-options">
            <button className="claim-option primary" onClick={() => void resolveClaim('merge')}>
              <strong>合并保留</strong>
              <span>两边的课程与 DDL 都留下，重复的自动去重（推荐）</span>
            </button>
            <button className="claim-option" onClick={() => void resolveClaim('replace')}>
              <strong>用未登录期间的数据覆盖</strong>
              <span>清空当前账号已有的课程、DDL 与考试，换成刚才那份</span>
            </button>
            <button
              className="claim-option"
              onClick={() => {
                if (window.confirm('确定不保留未登录期间的数据吗？未登录期间记录的课程与 DDL 将被丢弃。')) {
                  void resolveClaim('discard')
                }
              }}
            >
              <strong>不用了</strong>
              <span>保留当前账号原样，丢弃未登录期间的数据</span>
            </button>
          </div>
        </Modal>
      )}

      {showOnboarding && user && (
        <Suspense fallback={null}>
          <OnboardingGuide
            nickname={user.nickname}
            onDone={finishOnboarding}
            onImportCourses={startImportCourses}
          />
        </Suspense>
      )}
    </div>
  )
}
