import { useEffect, useMemo, useState } from 'react'
import type { Course, Settings, Task, Term, WeekData } from '../types'
import { deleteCourse, getCourses, getWeek } from '../api'
import { exportCoursesIcs } from '../lib/icsExport'
import { addDays, parseISODate, toISODate, weekdayCN } from '../lib/date'
import { useScheduleDisplay, DEFAULT_DISPLAY_PREFS } from '../lib/scheduleDisplay'
import { useSessionState } from '../lib/sessionState'
import MonthView from './MonthView'
import WeekGrid from '../components/WeekGrid'
import CreditSummaryCard from '../components/CreditSummaryCard'
import SwipeRow from '../components/SwipeRow'
import Modal from '../components/Modal'
import ScheduleDisplaySheet from '../components/ScheduleDisplaySheet'
import ShareScheduleSheet from '../components/ShareScheduleSheet'
import { ScheduleSkeleton } from '../components/Skeleton'
import {
  IconPlus, IconClock, IconMapPin, IconGear, IconCamera, IconBook, IconChart, IconSliders, IconShare, IconUsers,
  IconCalendar, IconRefresh
} from '../icons'

type ScheduleMode = 'day' | 'week' | 'month'

interface ScheduleViewProps {
  settings: Settings | null
  refreshKey: number
  /* 可选 settings 标记（评审 C6）：课表导入会改写学期设置，透传给 App 按需重取 */
  onMutated: (opts?: { settings?: boolean }) => void
  onEditTask: (task: Task) => void
  onEditCourse: (course: Course) => void
  onAddCourse: () => void
  onImportPhoto: () => void
  onOpenSettings: () => void
  /**
   * 需要登录的入口（目前只有「课表导入」）。
   * @returns true = 已登录可直接打开；false = 已经弹出登录层，调用方应立即返回。
   * 为什么由 App 传进来：游客态下"拦下来弹登录、登录完再自动打开"这套流程要跨页面存在，
   * 状态必须收在 App 一处，页面只负责问一句"能开吗"。
   */
  onRequireLogin?: () => boolean
  /** 打开课表导入弹窗（弹窗由 App 渲染，课表页只发信号） */
  onOpenMisImport?: () => void
  /** 打开「空闲课表」（群组）——入口放在课表页标题行，因为它是"课表的另一种看法" */
  onOpenShareGroups?: () => void
  /** 全局 toast（显示设置恢复、分享结果等提示） */
  onToast?: (msg: string) => void
}

/** 课表页顶部一句话标题：带周次 / 开学前 / 放假周 / 结课后 + 本周课程数（previewing=预览非本周时加标记） */
function weekStateLabel(week: WeekData | null, count: number, previewing = false): string {
  if (!week) return '加载中…'
  if (week.weekState === 'before')
    return `开学前 · 按第 1 周预览 · ${count} 门课 · 开学日 ${week.semester.startDate}`
  if (week.weekState === 'after') return `本学期已结课（共 ${week.semester.totalWeeks} 周）`
  /* 放假周：学校整周不排课，也不计入教学周 —— 必须说清「放假无课程」，
     否则用户看到空课表会以为导入失败了 */
  if (week.weekState === 'holiday') return `${previewing ? '预览 · ' : ''}放假周 · 无课程安排`
  return `${previewing ? '预览 · ' : ''}第 ${week.weekNumber} 教学周 · ${count} 门课`
}

/** 周次下拉的一项（教学周或放假周），已把展示文案与日期算好 */
interface WeekPick {
  /** 该周周一（YYYY-MM-DD），作为请求 /api/week 的 date */
  date: string
  label: string
  /** 是否就是「今天」所在的教学周 */
  live: boolean
  holiday: boolean
}

/** 把「第 N 周」在无周次表时的日期按旧口径（开学日 + 7×(N-1)）算出来 */
function linearWeekDate(startDate: string, week: number): string {
  return startDate ? toISODate(addDays(parseISODate(startDate), (week - 1) * 7)) : ''
}

/**
 * 构造周次下拉项。
 *
 * 优先用服务端从**周次表**推导出的 `weekOptions`（教学周 + 被跳过的放假周），
 * 这样下拉里会明确出现「放假周」一项，用户一眼能看出周次为什么从第 3 周跳到第 4 周。
 * 学期没有周次表时（存量数据 / 手工建的学期）回退到 1..totalWeeks 的旧列表。
 */
function buildWeekPicks(week: WeekData, liveWeekStart: string): WeekPick[] {
  if (week.weekOptions.length > 0) {
    return week.weekOptions.map((o) => ({
      date: o.beginDate,
      label:
        o.week === null
          ? `放假周（${o.beginDate.slice(5)} ~ ${o.endDate.slice(5)}）`
          : `第 ${o.week} 周（${o.beginDate.slice(5)} ~ ${o.endDate.slice(5)}）`,
      live: o.beginDate === liveWeekStart,
      holiday: o.week === null
    }))
  }
  const total = week.semester.totalWeeks ?? 16
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1
    const date = linearWeekDate(week.semester.startDate, n)
    return { date, label: `第 ${n} 周`, live: date === liveWeekStart, holiday: false }
  })
}

const MODE_TABS: { key: ScheduleMode; label: string }[] = [
  { key: 'day', label: '日视图' },
  { key: 'week', label: '周视图' },
  { key: 'month', label: '月视图' }
]

export default function ScheduleView({
  settings,
  refreshKey,
  onMutated,
  onEditTask,
  onEditCourse,
  onAddCourse,
  onImportPhoto,
  onOpenSettings,
  onRequireLogin,
  onOpenMisImport,
  onOpenShareGroups,
  onToast
}: ScheduleViewProps) {
  const [week, setWeek] = useState<WeekData | null>(null)
  /* 评审 C1（2026-10-23）：mode/selected/previewDate 是用户明确的视图选择，
     用 sessionStorage 持久化 —— 切 tab 重挂后还原，不再「翻到第 8 周 → 勾条 DDL
     → 回来回到第 1 周日视图」。 */
  const [selected, setSelected] = useSessionState<string>('schedule.selected', '')
  const [mode, setMode] = useSessionState<ScheduleMode>('schedule.mode', 'day')
  /**
   * 周视图预览的目标周 —— 存**该周的周一日期**（而非教学周号）。
   *
   * 为什么不用周号：放假周没有教学周号（学校跳过它），用周号就表达不了「预览放假周」；
   * 而日期是万能的 —— 服务端拿到日期自己查周次表就知道是教学周还是放假周。
   * null = 跟随今天（默认）。
   */
  const [previewDate, setPreviewDate] = useSessionState<string | null>('schedule.preview', null)
  /** 「今天」所在周的周一（只在默认态响应里更新），用于标记下拉里的「本周」与归一化回跳 */
  const [liveWeekStart, setLiveWeekStart] = useState('')
  const [error, setError] = useState('')
  /** 左滑点了删除后待确认的课程；确认弹窗关闭前不会真的调删除接口 */
  const [pendingDelete, setPendingDelete] = useState<Course | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  /* 课表显示偏好（图2）：存 localStorage，四项都只影响渲染 */
  const { prefs, update: updatePrefs, reset: resetPrefs } = useScheduleDisplay()
  const [displayOpen, setDisplayOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  /** 正在导出 .ics —— 防重复点击（导出要走一次 /api/courses，慢的时候有几百毫秒空窗） */
  const [exporting, setExporting] = useState(false)
  /** 导出用的学期：优先 terms 里的当前学期，退回镜像字段 semester */
  const currentTerm = useMemo<Term | null>(() => {
    const id = settings?.currentTermId
    const fromTerms = settings?.terms?.find((t) => t.id === id)
    if (fromTerms) return fromTerms
    const sem = settings?.semester
    if (sem?.startDate) {
      return {
        id: 'current',
        name: sem.name || '本学期',
        startDate: sem.startDate,
        totalWeeks: sem.totalWeeks
      }
    }
    return null
  }, [settings])

  /**
   * 打开课表导入。
   * 弹窗本身由 App 渲染（见 App 的 startImportCourses）：那里不依赖当前 tab，
   * 新手指引 / 本周页空态卡也能用同一个弹窗，不会因为浮层关闭时的历史回退被切走。
   * 游客会被 requireLogin 拦下，登录完成后由 finishAuthFlow 把这次点击补回来。
   */
  function openMisImport() {
    onOpenMisImport?.()
  }

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    /* inactive：只有开了「显示非本周课程」才多要这份数据（通常是本周课程的一两倍体积） */
    getWeek(previewDate ?? undefined, ac.signal, { inactive: prefs.showInactive })
      .then((w) => {
        if (cancelled) return
        setWeek(w)
        if (previewDate == null) setLiveWeekStart(w.weekStart)
        // 默认选中今天，否则选第一个有课的白天；预览切换后旧 selected 不在新周窗口时一并重置
        const today = w.days.find((d) => d.isToday) ?? w.days.find((d) => d.courses.length > 0)
        setSelected((prev) =>
          prev && w.days.some((d) => d.date === prev) ? prev : today?.date || w.days[0]?.date || ''
        )
        setError('')
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [refreshKey, previewDate, prefs.showInactive])

  const uniqueCourses = useMemo(() => {
    if (!week) return 0
    const ids = new Set<number>()
    week.days.forEach((d) => d.courses.forEach((c) => ids.add(c.id)))
    return ids.size
  }, [week])

  /* ---------- 导出到系统日历 ---------- */

  /**
   * 导出整学期课表为 .ics。
   *
   * 为什么要先拉一次 `getCourses()` 而不是直接用当前周的 `week.days`：
   * `week.days` 只含**当前这一周**上的课 —— 用它导出会得到一个只有 1 周、
   * 且遗漏了"本周没排但其他周有"课程的文件。必须拿整学期的完整课程表。
   *
   * 学期信息取 `settings.terms` 里的当前学期。取不到就退回 `settings.semester`
   * （老数据只有镜像字段、没有 terms 列表）。两者都没有时不导出 ——
   * 没有开学日就算不出任何一节课的具体日期。
   */
  async function handleExport() {
    if (exporting) return
    const term = currentTerm
    if (!term) {
      onToast?.('还没有设置学期开学日，无法导出课表')
      return
    }
    setExporting(true)
    try {
      const all = await getCourses()
      /* 只导出当前学期的课 —— 别的学期的课混进来会在日历里多出一堆幽灵事件 */
      const mine = all.filter((c) => !c.term || c.term === term.id)
      if (mine.length === 0) {
        onToast?.('当前学期没有课程可以导出')
        return
      }
      const r = await exportCoursesIcs(mine, settings?.periods ?? [], term)
      if (!r.ok) {
        onToast?.(r.message)
        return
      }
      const skipNote = r.skipped > 0 ? `，${r.skipped} 门因缺少节次时间未导出` : ''
      onToast?.(`已导出 ${r.count} 门课程${skipNote}`)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  /** 二次确认后才真正删除：删除不可撤销，关联任务会变成"无课程" */
  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteCourse(pendingDelete.id)
      setPendingDelete(null)
      onMutated()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  /** 切到某个周次项；若它恰好是「本周」则归一化回 null（跟随今天），避免状态与显示语义脱节 */
  function goWeekPick(pick: WeekPick | undefined) {
    if (!pick) return
    setPreviewDate(pick.date === liveWeekStart ? null : pick.date)
  }

  const selectedDay = week?.days.find((d) => d.date === selected)

  /**
   * 周次下拉项 + 当前所处位置。
   *
   * 依赖 `week`：`weekOptions` 由学期周次表推导，与「当前看的是哪一周」无关，
   * 所以切换预览时这份列表内容不变，只有选中项跟着变。
   */
  const weekPicks = useMemo(() => (week ? buildWeekPicks(week, liveWeekStart) : []), [week, liveWeekStart])
  const pickIdx = weekPicks.findIndex((p) => p.date === (previewDate ?? week?.weekStart))
  const currentPick = pickIdx >= 0 ? weekPicks[pickIdx] : undefined

  // ---------- 日视图（默认）：按天看课程列表 ----------
  function renderDay() {
    if (!week) return null
    return (
      <>
        <div className="days-strip">
          {week.days.map((d) => (
            <button
              key={d.date}
              className={`day-pill${selected === d.date ? ' active' : ''}${d.isToday ? ' today' : ''}`}
              onClick={() => setSelected(d.date)}
            >
              <span className="dp-dow">{weekdayCN(d.weekday)}</span>
              <span className="dp-date">{Number(d.date.slice(8, 10))}</span>
              <span className="dp-cellcount">{d.courses.length}</span>
            </button>
          ))}
        </div>

        {selectedDay && selectedDay.courses.length === 0 ? (
          <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>
            {week.weekState === 'holiday' ? '放假无课程' : '这一天没有课'}
            <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 12 }}>
              {week.weekState === 'holiday'
                ? '本周学校放假、不排课，也不计入教学周。'
                : '也可以看看整周安排。'}
            </div>
            <button className="btn btn-soft btn-sm" style={{ marginTop: 10 }} onClick={() => setMode('week')}>
              去周视图
            </button>
          </div>
        ) : (
          selectedDay?.courses.map((c) => (
            <SwipeRow
              key={c.id}
              onDelete={() => {
                setDeleteError('')
                setPendingDelete(c)
              }}
            >
              {/* 课程卡整体是"编辑这门课"的入口，所以要有按钮语义 + 键盘可达。
                  刻意不用 <button>：.course-card 只显式写了 background/border/padding/radius/gap，
                  而浏览器给 button 的默认样式还有 text-align:center、align-items:flex-start、
                  font-size:13.33px、color:buttontext —— 前者会把课名居中、把左侧色条（.cc-bar，
                  靠父级 flex 的 stretch 撑高）压成 0 高，后者会让深色主题下的文字颜色失真。
                  又不能改 styles.css（本次修复不动样式），所以保留 div，用 role/tabIndex/onKeyDown
                  补齐键盘与读屏支持：Enter 和空格都触发编辑，空格要 preventDefault 防止页面滚动。 */}
              <div
                className="course-card"
                role="button"
                tabIndex={0}
                onClick={() => onEditCourse(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onEditCourse(c)
                  }
                }}
              >
                <span className="cc-bar" style={{ background: c.color }} />
                <div className="cc-main">
                  <div className="cc-name">{c.name}</div>
                  <div className="cc-line">
                    <IconClock size={15} />
                    {c.startTime}-{c.endTime}
                  </div>
                  <div className="cc-line">
                    <IconMapPin size={15} />
                    {c.location}
                    {c.teacher ? ` · ${c.teacher}` : ''}
                  </div>
                  {/* 考核与成绩占比：作为附注贴着上方两行正文，刻意做得比正文更小更淡，
                      只用一行 + 省略号，避免这条"补充说明"抢占课程卡的有效信息空间 */}
                  {c.gradingPolicy && (
                    <div className="cc-grading" title={c.gradingPolicy}>
                      <IconChart size={13} />
                      <span className="cc-grading-text">{c.gradingPolicy}</span>
                    </div>
                  )}
                </div>
              </div>
            </SwipeRow>
          ))
        )}
      </>
    )
  }

  // ---------- 底部操作区（仅编辑场景多的日视图放，周视图顶部另有入口） ----------
  function renderActions() {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="btn btn-primary btn-block rec-btn" style={{ flex: 1 }} onClick={openMisImport}>
            <IconBook size={18} />
            课表导入
            <span className="rec-badge">推荐</span>
          </button>
          <button className="btn btn-ghost btn-block" style={{ flex: 1 }} onClick={onImportPhoto}>
            <IconCamera size={18} />
            拍照导入
          </button>
          <button className="btn btn-ghost btn-block" style={{ flex: 1 }} onClick={onAddCourse}>
            <IconPlus size={18} />
            添加课程
          </button>
        </div>
        <p style={{ color: 'var(--text-3)', fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
          「课表导入」用学号密码自动拉取本学期课表（默认走智慧课程平台，也可切换本科教务）；
          拍照导入适合研究生或课表页截图识别。
        </p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div className="page-title" style={{ margin: '14px 2px 0' }}>
          课表
        </div>
        <div className="sch-head-actions">
          {/* 导出到系统日历：把整学期课表写成 .ics。
              放在课表页而不是设置页，是因为"导出课表"这个动作的语境就在这里；
              藏到设置里用户根本找不到。
              只在有课时才出现 —— 空课表导出会得到一个空文件，
              用户会以为功能坏了。 */}
          {uniqueCourses > 0 && (
            <button
              className="topbar-btn"
              onClick={handleExport}
              disabled={exporting}
              aria-label="导出到系统日历"
              title="导出到系统日历"
            >
              {exporting ? <IconRefresh size={22} className="icon-spin" /> : <IconCalendar size={22} />}
            </button>
          )}
          {/* 空闲课表：课表的"另一种看法"（把课表换算成忙闲，和别人对齐时间），所以入口跟着课表走 */}
          {onOpenShareGroups && (
            <button className="topbar-btn" onClick={onOpenShareGroups} aria-label="空闲课表" title="空闲课表">
              <IconUsers size={22} />
            </button>
          )}
          <button className="topbar-btn" onClick={onOpenSettings} aria-label="学期设置" title="学期设置">
            <IconGear size={22} />
          </button>
        </div>
      </div>
      <p className="page-sub">{weekStateLabel(week, uniqueCourses, previewDate != null)}</p>

      {/* 视图切换：日 / 周 / 月 + 两个"就地改这张表"的动作（显示设置 / 分享） */}
      <div className="sch-toolbar">
        <div className="filter-tabs">
          {MODE_TABS.map((t) => (
            <button
              key={t.key}
              className={`filter-tab${mode === t.key ? ' active' : ''}`}
              onClick={() => setMode(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          /* 有任意一项非默认显示设置时给个角标式高亮 —— 否则用户改了紧凑视图后想不起在哪改的。
             逐项列举会漏（P1 新增了 5 个字段），所以直接和默认值整体比对。 */
          className={`topbar-btn${
            (Object.keys(DEFAULT_DISPLAY_PREFS) as (keyof typeof DEFAULT_DISPLAY_PREFS)[]).some(
              (k) => prefs[k] !== DEFAULT_DISPLAY_PREFS[k]
            )
              ? ' on'
              : ''
          }`}
          onClick={() => setDisplayOpen(true)}
          aria-label="课表显示"
          title="课表显示"
        >
          <IconSliders size={20} />
        </button>
        <button
          className="topbar-btn"
          onClick={() => setShareOpen(true)}
          disabled={!week}
          aria-label="分享课表"
          title="分享课表"
        >
          <IconShare size={20} />
        </button>
      </div>

      {/* 开学前/放假周/已结课 的直观提示：避免用户误以为"没导进去" */}
      {week && week.weekState !== 'active' && mode !== 'month' && (
        <div
          className="card"
          style={{ background: 'var(--warn-soft)', border: '1px solid transparent', marginBottom: 8 }}
        >
          <div style={{ fontWeight: 600, color: 'var(--warn)', fontSize: 13.5 }}>
            {week.weekState === 'before'
              ? `本学期还没开始（开学日 ${week.semester.startDate}）`
              : week.weekState === 'holiday'
                ? '放假无课程'
                : '本学期课程已结束'}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 4, lineHeight: 1.6 }}>
            {week.weekState === 'before' ? (
              <>
                当前在开学日之前，下方按「第 1 教学周」显示已导入的课程，开学后会自动切换到当周。若开学日设置不对，可到“设置 →
                学期设置”修改。
              </>
            ) : week.weekState === 'holiday' ? (
              <>
                本周（{week.weekStart} ~ {week.weekEnd}）学校放假、未安排课程，也不计入教学周
                —— 所以下一个教学周的课次不会整体前移，课表周次与日期依然对得上。
              </>
            ) : (
              <>已超过学期总周数（{week.semester.totalWeeks} 周），如需查看请调整学期设置。</>
            )}
          </div>
        </div>
      )}

      {error && <div className="card" role="alert">加载失败：{error}</div>}
      {!error && !week && <ScheduleSkeleton />}
      {!error && week && (
        <>
          {mode === 'day' && (
            <>
              {renderDay()}
              {renderActions()}
            </>
          )}

          {mode === 'week' && (
            <>
              {/* 周数切换：预览任意教学周 / 放假周（开学前、结课后也能翻看整学期安排） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="上一周"
                  disabled={pickIdx <= 0}
                  onClick={() => goWeekPick(weekPicks[pickIdx - 1])}
                >
                  ‹
                </button>
                <select
                  value={currentPick?.date ?? ''}
                  onChange={(e) => goWeekPick(weekPicks.find((p) => p.date === e.target.value))}
                  style={{
                    flex: 1,
                    maxWidth: 260,
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-2)',
                    fontSize: 13
                  }}
                  aria-label="选择预览的周次"
                >
                  {weekPicks.map((p) => (
                    <option key={p.date} value={p.date}>
                      {p.label}
                      {p.live ? ' · 本周' : ''}
                      {p.holiday ? ' · 无课程' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="下一周"
                  disabled={pickIdx < 0 || pickIdx >= weekPicks.length - 1}
                  onClick={() => goWeekPick(weekPicks[pickIdx + 1])}
                >
                  ›
                </button>
                {previewDate != null && (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setPreviewDate(null)}>
                    回到本周
                  </button>
                )}
              </div>
              {/* 学分汇总卡：教务官方总学分(如有) + 本周修读 + 缺学分提示（置于周网格上方） */}
              <CreditSummaryCard week={week} refreshKey={refreshKey} officialCredits={settings?.officialCredits ?? null} />
              {/* 放假周 / 无课时给引导（开学前=第 1 周预览为空，同样需要入口，不能只渲染空网格） */}
              {week.days.every((d) => d.courses.length === 0) ? (
                <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>
                  {week.weekState === 'holiday'
                    ? '放假无课程'
                    : week.weekState === 'before'
                      ? '第 1 教学周没有安排任何课程'
                      : '本周没有安排任何课程'}
                  <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 12 }}>
                    {week.weekState === 'holiday'
                      ? '本周学校放假、不排课，也不计入教学周 —— 下一个教学周的课次不会因此前移。'
                      : '用「课表导入」「拍照导入」或手动「添加课程」即可开始排课。'}
                  </div>
                  {week.weekState !== 'holiday' && <div style={{ marginTop: 10 }}>{renderActions()}</div>}
                </div>
              ) : (
                <>
                  <WeekGrid
                    week={week}
                    periods={settings?.periods ?? []}
                    onEditCourse={(c) => onEditCourse(c)}
                    compact={prefs.compact}
                    autoWeekend={prefs.autoWeekend}
                    showInactive={prefs.showInactive}
                    rowHeight={prefs.rowHeight}
                    showLocation={prefs.showLocation}
                    showTeacher={prefs.showTeacher}
                    showCredit={prefs.showCredit}
                    showBreaks={prefs.showBreaks}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn btn-primary btn-block rec-btn" style={{ flex: 1 }} onClick={openMisImport}>
                      <IconBook size={18} />
                      课表导入
                      <span className="rec-badge">推荐</span>
                    </button>
                    <button className="btn btn-ghost btn-block" style={{ flex: 1 }} onClick={onImportPhoto}>
                      <IconCamera size={18} />
                      拍照导入
                    </button>
                    <button className="btn btn-ghost btn-block" style={{ flex: 1 }} onClick={onAddCourse}>
                      <IconPlus size={18} />
                      添加课程
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {mode === 'month' && (
            <MonthView refreshKey={refreshKey} onMutated={onMutated} onEditTask={onEditTask} onToast={onToast} />
          )}
        </>
      )}

      {/* 删除二次确认：左滑只是唤出按钮，真正的删除必须在这里再确认一次 */}
      <Modal
        open={!!pendingDelete}
        title="删除课程"
        onClose={() => {
          if (deleting) return
          setPendingDelete(null)
          setDeleteError('')
        }}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              取消
            </button>
            <button type="button" className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        {deleteError && <div className="form-error" style={{ marginBottom: 10 }} role="alert">{deleteError}</div>}
        <p style={{ margin: '0 0 8px' }}>确定删除「{pendingDelete?.name}」吗？</p>
        <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          删除后无法恢复，该课程的所有上课安排都会从课表移除；挂在它名下的任务会保留，但变为「无课程」。
        </p>
      </Modal>

      {/* 课表显示（图2）：改完立刻反映到上面那张表，所以就地弹层而不是跳设置页 */}
      {displayOpen && (
        <ScheduleDisplaySheet
          open
          prefs={prefs}
          onChange={updatePrefs}
          onReset={() => {
            resetPrefs()
            onToast?.('已恢复默认显示设置')
          }}
          onClose={() => setDisplayOpen(false)}
        />
      )}

      {/* 分享课表（图3）：分享的是**当前正在看的这一周**，避免"截的不是我看到的表" */}
      {shareOpen && week && (
        <ShareScheduleSheet
          open
          week={week}
          periods={settings?.periods ?? []}
          onClose={() => setShareOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  )
}
