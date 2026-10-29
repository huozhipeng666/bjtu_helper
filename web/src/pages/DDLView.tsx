import { useEffect, useMemo, useRef, useState } from 'react'
import type { Course, Task, TaskType, Urgency } from '../types'
import { clearDoneTasks, deleteTask, getCourses, getTasks, reorderTasks, toggleTask, updateTask } from '../api'
import { addDays, endOfWeek, toISODate } from '../lib/date'
import { sectionOf, sectionTasks, urgencyOfSection, type SectionKey } from '../lib/ddlSections'
import { useSessionState } from '../lib/sessionState'
import { buzz } from '../lib/haptics'
import {
  addTaskToCalendar, calendarPermissionState, hasNativeCalendarBridge,
  markTaskInCalendar, openCalendarPermissionSettings, readTasksInCalendar
} from '../lib/calendarBridge'
import TaskList from '../components/TaskList'
import { TaskListSkeleton } from '../components/Skeleton'
import TaskDetailModal from '../components/TaskDetailModal'
import ExamMisImport from '../components/ExamMisImport'
import { IconPlus, IconBook } from '../icons'

interface DDLViewProps {
  refreshKey: number
  onMutated: () => void
  onEditTask: (task: Task) => void
  onAddTask: () => void
  onToast?: (msg: string) => void
  /** 需要登录的入口（考务导入）：返回 true 可继续，false 表示已弹出登录层 */
  onRequireLogin?: () => boolean
  /** 登录完成后由 App 发出的一次性信号：自动打开考务导入弹窗 */
  autoOpenImport?: 'exam' | null
  onAutoOpenHandled?: () => void
}

type StatusFilter = 'all' | 'overdue' | 'today' | 'week' | 'done'

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'overdue', label: '逾期' },
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'done', label: '已完成' }
]

/* 今日截止排在已逾期前面：先看今天要交什么，再翻历史的逾期账 */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'today', label: '今日截止' },
  { key: 'overdue', label: '已逾期' },
  { key: 'tomorrow', label: '明天' },
  { key: 'thisWeek', label: '本周稍后' },
  { key: 'later', label: '更晚' }
]

export default function DDLView({
  refreshKey,
  onMutated,
  onEditTask,
  onAddTask,
  onToast,
  onRequireLogin,
  autoOpenImport,
  onAutoOpenHandled
}: DDLViewProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  /* 评审 C1（2026-10-23）：三个筛选器用 sessionStorage 持久化 —— 切 tab 重挂后还原，
     不再「筛到某门课 → 切走 → 回来回到全部」。 */
  const [statusFilter, setStatusFilter] = useSessionState<StatusFilter>('ddl.status', 'all')
  const [courseFilter, setCourseFilter] = useSessionState<number | 'all'>('ddl.course', 'all')
  const [typeFilter] = useSessionState<TaskType | 'all'>('ddl.type', 'all')
  const [misOpen, setMisOpen] = useState(false)
  /** 详情弹窗正在展示的任务 id。任务对象按 id 实时从 tasks 里查：刷新后内容自动跟上，任务被删则弹窗自动关 */
  const [detailId, setDetailId] = useState<number | null>(null)
  /** 原生壳里才有「写系统日历」的能力（网页拿不到日历权限），没有桥就不显示相关入口 */
  const nativeCalendar = hasNativeCalendarBridge()
  /** 已经写进过系统日历的任务 id（本地标记，只用于点亮列表里的日历图标） */
  const [calIds, setCalIds] = useState<number[]>(() => (nativeCalendar ? readTasksInCalendar() : []))

  /** 打开考务导入。游客被 onRequireLogin 拦下，登录完成后由 autoOpenImport 补开 */
  function openExamImport() {
    if (onRequireLogin && !onRequireLogin()) return
    setMisOpen(true)
  }

  /** 消费 App 的一次性「登录完了，把考务导入打开」信号 */
  useEffect(() => {
    if (autoOpenImport !== 'exam') return
    setMisOpen(true)
    onAutoOpenHandled?.()
  }, [autoOpenImport, onAutoOpenHandled])
  const [error, setError] = useState('')
  /** 首次加载完成前显示骨架屏；之后的刷新（增删改）不再打断列表 */
  const [loaded, setLoaded] = useState(false)
  /** 正在播放"完成动画"的任务 id：划掉 → 收起，短暂延迟后再真正切 done */
  const [completingId, setCompletingId] = useState<number | null>(null)
  /** 刚从待办切到 done、落在已完成区的任务 id：给它一个下坠入场动画 */
  const [justDoneId, setJustDoneId] = useState<number | null>(null)
  const completingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清掉未触发的定时器，避免 setState 在卸载后执行
  useEffect(
    () => () => {
      if (completingTimer.current) clearTimeout(completingTimer.current)
      if (justDoneTimer.current) clearTimeout(justDoneTimer.current)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    /* 用 AbortController 真正取消在途请求：cancelled 只保证「不写状态」，请求仍会在后台跑完、白占带宽 */
    const ac = new AbortController()
    Promise.all([getTasks(undefined, ac.signal), getCourses(ac.signal)])
      .then(([t, c]) => {
        if (!cancelled) {
          setTasks(t)
          setCourses(c)
          setError('')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [refreshKey])

  // 课程筛选自愈：选中的课程被删除后（id 失效），回落「全部课程」，避免整页空白
  useEffect(() => {
    if (typeof courseFilter === 'number' && !courses.some((c) => c.id === courseFilter)) {
      setCourseFilter('all')
    }
  }, [courseFilter, courses, setCourseFilter])

  const todayISO = toISODate(new Date())
  const weekEndISO = toISODate(endOfWeek(new Date()))

  const { groups, done, overdueCount, urgencyById } = useMemo(() => {
    const base = tasks.filter(
      (t) => (courseFilter === 'all' || t.courseId === courseFilter) && (typeFilter === 'all' || t.type === typeFilter)
    )
    return sectionTasks(base, todayISO, weekEndISO)
  }, [tasks, courseFilter, typeFilter, todayISO, weekEndISO])

  // 过滤显示：已完成的筛选项只展示「已完成」列表，待办分组一律收起
  const filteredSections = SECTIONS.filter((s) => {
    if (statusFilter === 'done') return false
    if (statusFilter === 'overdue') return s.key === 'overdue'
    if (statusFilter === 'today') return s.key === 'today'
    if (statusFilter === 'week') return s.key === 'overdue' || s.key === 'today' || s.key === 'tomorrow' || s.key === 'thisWeek'
    return true
  }).filter((s) => groups.get(s.key)!.length > 0)

  const showDone = statusFilter === 'all' || statusFilter === 'done'
  const doneList = showDone ? done : []

  /** 详情弹窗展示的任务与其紧迫度（已完成不给紧迫度） */
  const detailTask = detailId !== null ? (tasks.find((t) => t.id === detailId) ?? null) : null
  const detailUrgency: Urgency | undefined =
    detailTask && detailTask.status !== 'done' ? urgencyOfSection(sectionOf(detailTask.dueDate, todayISO, weekEndISO)) : undefined

  /**
   * 完成/取消完成。
   * - 取消完成（done→pending）：立即切换，不做动画。
   * - 标记完成（pending→done）：先给该条播"划掉 → 向下收起"的完成动画（completingId），
   *   动画结束后才真正调接口；刷新后该任务落到"已完成区"，再由 justDoneId 给它一个
   *   从上方轻微下坠的入场动画，视觉上就是"从待办区沉到底部已完成区"。
   */
  async function handleToggle(t: Task) {
    // 动画进行中防重复
    if (completingId === t.id) return
    if (t.status === 'done') {
      try {
        await toggleTask(t.id)
        onMutated()
      } catch (err) {
        onToast?.(err instanceof Error ? err.message : '更新状态失败，请重试')
      }
      return
    }
    // 先播完成动画（时长与 CSS .task-item.completing 对齐 ~0.46s），随后真正切换
    buzz(10)
    setCompletingId(t.id)
    completingTimer.current = setTimeout(async () => {
      try {
        await toggleTask(t.id)
        setCompletingId(null)
        onMutated()
        // 成功时在已完成区入场
        setJustDoneId(t.id)
        justDoneTimer.current = setTimeout(() => setJustDoneId(null), 600)
      } catch (err) {
        // 失败回滚：解除完成中标记，保留原待办状态，并给出提示
        setCompletingId(null)
        onToast?.(err instanceof Error ? err.message : '完成任务失败，请检查网络')
      }
    }, 460)
  }
  async function handleDelete(t: Task) {
    if (!window.confirm(`确定删除「${t.title}」吗？`)) return
    try {
      await deleteTask(t.id)
      onMutated()
      onToast?.(`已删除「${t.title}」`)
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '删除失败')
    }
  }
  async function handleReorder(ids: number[]) {
    try {
      await reorderTasks(ids)
      onMutated()
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '更新排序失败')
    }
  }

  /** 逾期任务一键顺延：截止日期改成明天，截止时间保持不变 */
  async function handlePostpone(t: Task) {
    try {
      const tomorrow = toISODate(addDays(new Date(), 1))
      await updateTask(t.id, { dueDate: tomorrow })
      onMutated()
      onToast?.(`「${t.title}」已顺延到明天`)
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '顺延失败')
    }
  }

  /** 一键清空已完成：确认后删除全部 done 任务 */
  async function handleClearDone() {
    if (done.length === 0) return
    if (!window.confirm(`确定清空 ${done.length} 条已完成的任务吗？此操作不可恢复。`)) return
    try {
      const r = await clearDoneTasks()
      onMutated()
      onToast?.(`已清空 ${r.deleted} 条已完成任务`)
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : '清空失败')
    }
  }

  /**
   * 单条 DDL → 系统日历（带提醒）。
   *
   * 只有原生壳里才有这个能力：网页拿不到系统日历权限，浏览器里连按钮都不显示。
   * 没授权时**由 App 自己弹系统授权框**，事件先排队，用户点「允许」后原生侧自动补写；
   * 同一条 DDL 反复点不会重复 —— 原生侧按任务 id 更新那一条事件。
   */
  function handleAddCalendar(t: Task) {
    const r = addTaskToCalendar(t)
    if (r.ok) {
      markTaskInCalendar(t.id)
      setCalIds(readTasksInCalendar())
      onToast?.(r.status === 'updated' ? '已按最新截止时间更新日历提醒' : '已加入系统日历提醒')
      return
    }
    if (r.status === 'pending') {
      onToast?.('已弹出日历授权框：点「允许」后这条 DDL 会自动写进日历')
      return
    }
    if (r.status === 'blocked') {
      const go = window.confirm(
        '日历权限被拒绝，系统不会再弹授权框。\n需要到「设置 → 应用 → 交大小助手 → 权限」里手动打开日历权限。\n\n是否现在前往设置？'
      )
      if (go) openCalendarPermissionSettings()
      return
    }
    onToast?.(`加入日历失败：${r.message}`)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div className="page-title" style={{ margin: '14px 2px 0' }}>DDL</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-soft btn-sm" onClick={openExamImport} title="登录教务系统抓取本学期考试并自动生成 DDL">
            <IconBook size={16} />
            一键添加考试信息
          </button>
          <button className="btn btn-primary btn-sm" onClick={onAddTask}>
            <IconPlus size={16} />
            添加任务
          </button>
        </div>
      </div>
      <p className="ddl-count">
        {tasks.length} 条 · 按截止时间排列
        {overdueCount > 0 && (
          <>
            {' '}· <span style={{ color: 'var(--danger)' }}>{overdueCount}</span> 条逾期
          </>
        )}
      </p>

      <div className="filter-tabs">
        {STATUS_TABS.map((s) => (
          <button key={s.key} className={`filter-tab${statusFilter === s.key ? ' active' : ''}`} onClick={() => setStatusFilter(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="chips">
        <button className={`chip${courseFilter === 'all' ? ' active' : ''}`} onClick={() => setCourseFilter('all')}>
          全部课程
        </button>
        {courses.map((c) => (
          <button key={c.id} className={`chip${courseFilter === c.id ? ' active' : ''}`} onClick={() => setCourseFilter(c.id)}>
            <span className="dot" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: c.color, marginRight: 5 }} />
            {c.name}
          </button>
        ))}
      </div>

      {nativeCalendar && (
        <p className="ddl-cal-hint">
          {calendarPermissionState() === 'blocked'
            ? '日历权限已被拒绝：点任务右侧的日历图标可前往系统设置开启'
            : '点任务右侧的日历图标：App 会申请日历权限，并在截止前提醒你'}
        </p>
      )}

      {error && <div className="card">加载失败：{error}</div>}
      {!error && !loaded && <TaskListSkeleton rows={4} />}
      {!error && loaded && tasks.length === 0 && <div className="card" style={{ color: 'var(--text-2)' }}>还没有任务，点右上角「添加任务」记下第一条截止时间</div>}
      {!error && loaded && tasks.length > 0 && filteredSections.length === 0 && doneList.length === 0 && (
        <div className="card" style={{ color: 'var(--text-2)' }}>没有符合筛选条件的任务</div>
      )}

      {!error &&
        filteredSections.map((s) => (
          <div key={s.key} style={{ marginBottom: 16 }}>
            <div className="section-head" style={{ margin: '8px 2px 10px' }}>
              <h2 style={{ fontSize: 15 }}>{s.label}</h2>
              <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{groups.get(s.key)!.length} 项</span>
            </div>
            <TaskList
              items={groups.get(s.key)!.map((t) => ({
                task: t,
                urgency: urgencyById.get(t.id) ?? 'upcoming',
                completing: completingId === t.id
              }))}
              onReorder={handleReorder}
              onToggle={handleToggle}
              onEdit={onEditTask}
              onDelete={handleDelete}
              onPostpone={handlePostpone}
              onAddCalendar={nativeCalendar ? handleAddCalendar : undefined}
              inCalendarIds={calIds}
              onOpen={(t) => setDetailId(t.id)}
            />
          </div>
        ))}

      {!error && showDone && doneList.length > 0 && (
        <div key="done" style={{ marginBottom: 16 }}>
          <div className="section-head" style={{ margin: '8px 2px 10px' }}>
            <h2 style={{ fontSize: 15 }}>已完成</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{doneList.length} 项</span>
              <button className="mini-btn" onClick={handleClearDone} title="删除全部已完成任务">
                清空
              </button>
            </div>
          </div>
          <TaskList
            items={doneList.map((t) => ({ task: t, justDone: justDoneId === t.id }))}
            onReorder={handleReorder}
            onToggle={handleToggle}
            onEdit={onEditTask}
            onDelete={handleDelete}
            onOpen={(t) => setDetailId(t.id)}
          />
        </div>
      )}

      {misOpen && (
        <ExamMisImport
          onClose={() => setMisOpen(false)}
          onImported={(r) => {
            setMisOpen(false)
            onMutated()
            onToast?.(`已导入 ${r.imported} 场考试，自动生成 DDL ${r.taskCreated} 条（复用 ${r.taskReused} 条）`)
          }}
        />
      )}

      {/*
        点卡片主体弹出的任务详情。完成/编辑时先关弹窗：完成动画要播在列表里，
        编辑则会叠开 TaskForm，两层弹窗叠着既挡视线又抢焦点。
        删除/顺延/加日历不先关：删除等确认成功后任务消失、弹窗自动关；
        顺延后任务还在（挪去明天分组），弹窗里的截止时间会实时更新。 */}
      {detailId !== null && (
        <TaskDetailModal
          task={detailTask}
          urgency={detailUrgency}
          onClose={() => setDetailId(null)}
          onToggle={(t) => {
            setDetailId(null)
            handleToggle(t)
          }}
          onEdit={(t) => {
            setDetailId(null)
            onEditTask(t)
          }}
          onDelete={handleDelete}
          onPostpone={handlePostpone}
          onAddCalendar={nativeCalendar ? handleAddCalendar : undefined}
          inCalendar={detailTask ? calIds.includes(detailTask.id) : false}
        />
      )}
    </div>
  )
}
