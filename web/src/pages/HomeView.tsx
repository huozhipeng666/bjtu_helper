import { useEffect, useMemo, useState } from 'react'
import type { Course, Exam, Overview, Settings, Task, Urgency, WeekData } from '../types'
import { getHome, toggleTask } from '../api'
import { parseISODate, weekdayCN } from '../lib/date'
import { buzz } from '../lib/haptics'
import CountUp from '../components/CountUp'
import TaskItem from '../components/TaskItem'
import ExamSprintCard from '../components/ExamSprintCard'
import { HomeSkeleton } from '../components/Skeleton'
import { IconClock, IconMapPin, IconArrowRight, IconDownload, IconPlus } from '../icons'

interface HomeViewProps {
  settings: Settings | null
  refreshKey: number
  onMutated: () => void
  onEditTask: (task: Task) => void
  onEditCourse: (course: Course) => void
  onGotoSchedule: () => void
  onGotoDDL: () => void
  /** 空课表时的一键导入（智慧课程平台），由 App 打开课表导入弹窗 */
  onImportCourses: () => void
  /** 空 DDL 时直接新建一条（游客由 App 引导登录） */
  onNewTask?: () => void
  /** 全局 toast（评审 C2：勾选失败要让用户看见，而不是静默装成功） */
  onToast?: (msg: string) => void
}

function greeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 11) return '早上好'
  if (h >= 11 && h < 13) return '中午好'
  if (h >= 13 && h < 18) return '下午好'
  if (h >= 18 && h < 23) return '晚上好'
  return '夜深了'
}

function startDT(dateISO: string, hm: string): Date {
  const d = parseISODate(dateISO)
  const [h, m] = hm.split(':').map(Number)
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}

function fmtDayLabel(weekday: number, date: string): string {
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  return `${weekdayCN(weekday)} · ${m}月${d}日`
}

export default function HomeView({
  refreshKey,
  onMutated,
  onEditTask,
  onEditCourse,
  onGotoSchedule,
  onGotoDDL,
  onImportCourses,
  onNewTask,
  onToast
}: HomeViewProps) {
  const [week, setWeek] = useState<WeekData | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [exams, setExams] = useState<Exam[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    /* 用 AbortController 真正取消在途请求：cancelled 只保证「不写状态」，请求仍会在后台跑完、白占带宽 */
    const ac = new AbortController()
    /* 一个请求拿全「本周 + 概览 + 考试」。
       此前是 getWeek + getOverview + getExams 三个并发请求：多两个往返、
       服务端多两次鉴权、而且 week 与 overview 各自带一份任务数据（重复传输）。
       见 server/src/index.ts 的 /api/home。 */
    getHome(undefined, ac.signal)
      .then(({ week: w, overview: o, exams: ex }) => {
        if (!cancelled) {
          setWeek(w)
          setOverview(o)
          setExams(ex)
          setError('')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [refreshKey])

  // 定时刷新驱动倒计时与「下一节课」实时走动（每 30 秒更新一次）
  const [currentMs, setCurrentMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setCurrentMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const now = useMemo(() => new Date(currentMs), [currentMs])

  const { next, todayCourses, weekPending, totalPending, doneRatio, hasAnyCourse, hasAnyTask } = useMemo(() => {
    if (!week || !overview)
      return {
        next: null,
        todayCourses: [],
        weekPending: 0,
        totalPending: 0,
        doneRatio: 0,
        hasAnyCourse: true,
        hasAnyTask: true
      }
    const total = overview.counts.pending + overview.counts.done
    const doneRatio = total === 0 ? 0 : Math.round((overview.counts.done / total) * 100)
    const weekPending = week.days.reduce((acc, d) => acc + d.tasks.filter((t) => t.status !== 'done').length, 0)
    /* 本周一节课都没有 ⇒ 课表是空的，首屏应该直接给「一键导入」而不是"今天没有课"。
       注意不能用 todayCourses 判断：周日 / 放假周当天没课很正常，那不代表没课表。 */
    const hasAnyCourse = week.days.some((d) => d.courses.length > 0 || (d.inactiveCourses?.length ?? 0) > 0)
    const hasAnyTask = week.days.some((d) => d.tasks.length > 0) || total > 0

    const today = week.days.find((d) => d.isToday)
    const todayCourses = (today?.courses ?? []).slice().sort((a, b) => a.startPeriod - b.startPeriod)

    // 下一节课：从今天起找第一个未开始（或正在上）的课
    let next: { course: Course; dt: Date; label: string } | null = null
    for (const d of week.days) {
      const isToday = d.date === week.date
      if (!isToday && next) break
      for (const c of d.courses) {
        const dt = startDT(d.date, c.startTime)
        if (dt.getTime() >= now.getTime()) {
          if (!next || dt.getTime() < next.dt.getTime()) {
            const label = isToday ? `今天 ${c.startTime}-${c.endTime}` : `${weekdayCN(d.weekday)} ${c.startTime}-${c.endTime}`
            next = { course: c, dt, label }
          }
        }
      }
      if (isToday && next) break
    }
    return { next, todayCourses, weekPending, totalPending: overview.counts.pending, doneRatio, hasAnyCourse, hasAnyTask }
  }, [week, overview, now])

  const countdown = useMemo(() => {
    if (!next) return ''
    const ms = next.dt.getTime() - now.getTime()
    if (ms <= 0) return '现在上课 · 正在进行'
    const min = Math.floor(ms / 60000)
    const h = Math.floor(min / 60)
    const m = min % 60
    if (h <= 0) return `还有 ${m} 分钟`
    return `还有 ${h} 小时 ${m} 分`
  }, [next, now])

  /** 本周小结：完成件数 + 完成任务里最集中的一门课（数据来自本周已含的 done 任务） */
  const recap = useMemo(() => {
    if (!week) return null
    const doneTasks = week.days.flatMap((d) => d.tasks).filter((t) => t.status === 'done')
    if (doneTasks.length === 0) return null
    const byCourse = new Map<string, number>()
    for (const t of doneTasks) {
      if (t.courseName) byCourse.set(t.courseName, (byCourse.get(t.courseName) ?? 0) + 1)
    }
    let top: string | null = null
    let topN = 0
    for (const [name, n] of byCourse) {
      if (n > topN) {
        top = name
        topN = n
      }
    }
    return { count: doneTasks.length, top, topN }
  }, [week])

  // 待办里的紧急/临近项，用作顶部"要赶的 DDL"横幅
  // 上限固定 3 条：本周页首屏要留给课程卡片，横幅过高会把下一节课挤出可视区
  const urgentList = useMemo(() => {
    if (!overview) return []
    // 逾期优先，其次今日截止；各取前几条，去重 id
    const MAX_URGENT = 3
    const seen = new Set<number>()
    const out: { task: Task; urgent: Urgency }[] = []
    for (const t of overview.overdue) {
      if (out.length >= MAX_URGENT) break
      if (!seen.has(t.id)) { seen.add(t.id); out.push({ task: t, urgent: 'overdue' }) }
    }
    for (const t of overview.today) {
      if (out.length >= MAX_URGENT) break
      if (!seen.has(t.id)) { seen.add(t.id); out.push({ task: t, urgent: 'today' }) }
    }
    return out
  }, [overview])

  /** 给横幅条目标一行右侧的"剩余/逾期"文案 */
  function dueHint(t: Task, urgent: Urgency): string {
    if (urgent === 'overdue') {
      const n = Math.max(1, Math.round((new Date().getTime() - parseISODate(t.dueDate).getTime()) / 86400000))
      return `已逾期 ${n} 天`
    }
    if (t.dueTime) return `今天 ${t.dueTime} 截止`
    return '今天 23:59 截止'
  }

  function dotColor(urgent: Urgency): string {
    if (urgent === 'overdue') return 'var(--danger)'
    if (urgent === 'today') return 'var(--accent)'
    return 'var(--text-3)'
  }

  if (error) return <div className="card">加载失败：{error}</div>
  if (!week) return <HomeSkeleton />

  return (
    <div>
      <p className="greet">{greeting()}</p>
      <h1 className="big-count">
        这周还剩 <span className="num"><CountUp value={totalPending} /></span> 件
      </h1>
      <p className="week-sub">
        {/* 放假周没有教学周号（weekNumber=0），必须显式说清，否则「第 0 教学周」很奇怪 */}
        {week.weekState === 'holiday'
          ? '放假周 · 无课程'
          : week.weekState === 'before'
            ? '开学前 · 按第 1 周预览'
            : week.weekState === 'after'
              ? `本学期已结课（共 ${week.semester.totalWeeks} 周）`
              : `第 ${week.weekNumber} 教学周`}{' '}
        · {week.weekStart} - {week.weekEnd}
      </p>

      {/* 首屏顺序（2026-10-26 调整）：**课程 → DDL → 统计 → 考试 → 明细**。
          之前是 big-count → 考试 → 统计 → 进度 → DDL 横幅 → 下一节课，
          用户打开应用先看到一串数字，真正要处理的 DDL 和下一节课被压到需要滑动。
          现在先给"下一节课"和"要赶的 DDL"两块内容，统计与进度退到后面 ——
          它们是"回顾"，不是"待办"。 */}
      {next ? (
        <div className="card next-card">
          <div className="nc-left">
            <span className="tag">
              <span className="dot" style={{ background: next.course.color }} />
              下一节
            </span>
            <h3>{next.course.name}</h3>
            <div className="meta">
              <span>
                <IconClock size={15} />
                {next.label}
              </span>
              {next.course.location && (
                <span>
                  <IconMapPin size={15} />
                  {next.course.location}
                </span>
              )}
            </div>
            <div className="countdown">{countdown}</div>
          </div>
        </div>
      ) : (
        <div className="card">
          <span className="tag" style={{ color: 'var(--text-2)' }}>
            <span className="dot" style={{ background: 'var(--text-3)' }} />
            接下来
          </span>
          <h3 style={{ margin: '6px 0 4px' }}>
            {hasAnyCourse ? '本周没有更多课程了' : '还没有导入课表'}
          </h3>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
            {hasAnyCourse ? '去处理下面的 DDL 吧' : '导入后这里会显示下一节课和当周课表'}
          </span>
        </div>
      )}

      {/* 要赶的 DDL：逾期 + 今日截止的紧凑横幅，一眼看到最急的，不再沉到页底时间线。
          一条都没有时也要占位 —— 否则新用户完全不知道"这里以后会出现 DDL"，
          而且没有入口可以立刻加第一条。 */}
      <div className="card todo-banner">
        <div className="banner-head">
          <span className="banner-title">要赶的 DDL</span>
          <a onClick={onGotoDDL}>{hasAnyTask ? '全部任务 ›' : '去 DDL 页 ›'}</a>
        </div>
        {urgentList.length > 0 ? (
          <div className="banner-list">
            {urgentList.map(({ task, urgent }) => (
              <button key={task.id} className="banner-row" onClick={() => onEditTask(task)}>
                <span className="banner-dot" style={{ background: dotColor(urgent) }} />
                <span className="banner-name">{task.title}</span>
                <span className="banner-time" style={{ color: urgent === 'overdue' ? 'var(--danger)' : 'var(--text-2)' }}>
                  {dueHint(task, urgent)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="banner-empty">
            <span>暂时没有逾期或今日截止的 DDL。</span>
            {onNewTask && (
              <button type="button" className="btn btn-ghost banner-empty-btn" onClick={onNewTask}>
                <IconPlus size={15} />
                加一条
              </button>
            )}
          </div>
        )}
      </div>

      {/* 考试冲刺模式看板：有即将到来的考试时置顶放大展示倒计时、考场与座位号 */}
      <ExamSprintCard exams={exams} now={now} onManageExams={onGotoDDL} />

      {/* 空课表 / 空 DDL 的落地引导。
          为什么放在统计卡之前：新用户首屏全是 0 的时候，"0/0/0 + 0%" 是纯粹的
          视觉噪音，而真正该做的是导入课表。先给动作，再给数字。 */}
      {!hasAnyCourse && (
        <div className="card home-empty-card">
          <div className="hec-title">还没有课表</div>
          <p className="hec-sub">
            一键从智慧课程平台导入，课名、时间、教室、学分都会自动填好；也可以用拍照识别或手动添加。
          </p>
          <div className="hec-actions">
            <button type="button" className="btn btn-primary" onClick={onImportCourses}>
              <IconDownload size={17} />
              一键导入课表
            </button>
            <button type="button" className="btn btn-ghost" onClick={onGotoSchedule}>
              先去课表页
            </button>
          </div>
        </div>
      )}

      <div className="stats-row">
        <div className={`stat-card ${overview && overview.counts.overdue > 0 ? 'val-danger' : ''}`}>
          <div className="label">逾期</div>
          <div className="val">{overview?.counts.overdue ?? 0}</div>
        </div>
        <div className={`stat-card ${overview && overview.counts.today > 0 ? 'val-accent' : ''}`}>
          <div className="label">今日截止</div>
          <div className="val">{overview?.counts.today ?? 0}</div>
        </div>
        <div className="stat-card val-accent">
          <div className="label">本周待做</div>
          <div className="val">{weekPending}</div>
        </div>
      </div>

      {/* 本周完成进度条：比纯数字百分比更直观 */}
      <div className="progress-row">
        <div className="progress-track" role="progressbar" aria-valuenow={doneRatio} aria-valuemin={0} aria-valuemax={100} aria-label="本周完成进度">
          <div className="progress-fill" style={{ width: `${doneRatio}%` }} />
        </div>
        <span className="progress-num">{doneRatio}%</span>
      </div>

      <div className="section-head">
        <h2>今日课程</h2>
        <a onClick={onGotoSchedule}>完整课表</a>
      </div>
      {todayCourses.length === 0 ? (
        <div className="card home-empty-inline">
          <span>{hasAnyCourse ? '今天没有课' : '还没有课表'}</span>
          {!hasAnyCourse && (
            <button type="button" className="btn btn-ghost banner-empty-btn" onClick={onImportCourses}>
              <IconDownload size={15} />
              一键导入
            </button>
          )}
        </div>
      ) : (
        <div className="card">
          {todayCourses.map((c) => (
            <div key={c.id} className="course-row">
              <span className="bar" style={{ background: c.color }} />
              <div className="cr-main">
                <div className="cr-name">{c.name}</div>
                <div className="cr-loc">
                  {c.location}
                  {c.teacher ? ` · ${c.teacher}` : ''}
                </div>
              </div>
              <span className="cr-time">
                {c.startTime}-{c.endTime}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section-head">
        <h2>本周时间线</h2>
        <a onClick={onGotoDDL}>
          查看 DDL
          <IconArrowRight size={14} style={{ verticalAlign: 'middle' }} />
        </a>
      </div>
      {week.days.map((d) => {
        const notDone = d.tasks.filter((t) => t.status !== 'done')
        const dayCourses = d.courses.slice().sort((a, b) => a.startPeriod - b.startPeriod)
        return (
          <div key={d.date} className="timeline-day">
            <div className="td-head">
              <span className="td-label">
                {fmtDayLabel(d.weekday, d.date)}
                {d.isToday && <span style={{ color: 'var(--accent-2)', marginLeft: 6 }}>今天</span>}
              </span>
              <span className="td-count">{dayCourses.length} 节课</span>
            </div>
            {/* 每天的课也列出来：本周页是"一屏看全"的那一页，
                只给"3 节课"的数字等于让用户再点去课表页找，等于没聚合。 */}
            {dayCourses.length > 0 && (
              <div className="td-courses">
                {dayCourses.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="td-course"
                    style={{ borderLeftColor: c.color }}
                    onClick={() => onEditCourse(c)}
                  >
                    <span className="td-course-name">{c.name}</span>
                    <span className="td-course-time">{c.startTime}</span>
                  </button>
                ))}
              </div>
            )}
            {notDone.length === 0 ? (
              <div className="td-empty">{d.isToday ? '今天没有未完成的截止。' : '这一天没有 DDL。'}</div>
            ) : (
              <div className="task-list" style={{ marginTop: 4 }}>
                {notDone.map((t) => (
                  <TaskItem key={t.id} task={t} urgency={t.urgency} onToggle={onToggle} onEdit={onEditTask} />
                ))}
              </div>
            )}
          </div>
        )
      })}

      {recap && (
        <div className="card recap-card">
          <div className="recap-title">本周小结</div>
          <p className="recap-text">
            已经完成 <b>{recap.count}</b> 件事
            {recap.top && (
              <>
                ，{recap.top} 相关的最多（{recap.topN} 件）
              </>
            )}
            。
          </p>
        </div>
      )}
    </div>
  )

  async function onToggle(t: Task) {
    try {
      await toggleTask(t.id)
      buzz(10)
      onMutated()
    } catch (err) {
      /* 评审 C2：静默吞错 = 用户以为勾上了（下次重拉弹回）。与 DDLView 同口径提示。 */
      onToast?.(err instanceof Error ? `操作失败：${err.message}` : '操作失败，请重试')
    }
  }
}
