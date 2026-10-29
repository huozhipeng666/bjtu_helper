import { useEffect, useState } from 'react'
import type { MonthData, Task } from '../types'
import { deleteTask, getMonth, reorderTasks, toggleTask } from '../api'
import { parseISODate, toISODate, weekdayCN } from '../lib/date'
import TaskList from '../components/TaskList'
import { TaskListSkeleton } from '../components/Skeleton'

interface MonthViewProps {
  refreshKey: number
  onMutated: () => void
  onEditTask: (task: Task) => void
  /** 全局 toast（评审 C2：写操作失败要让用户看见，而不是静默装成功） */
  onToast?: (msg: string) => void
}

const WEEKDAY_HEADER = ['一', '二', '三', '四', '五', '六', '日']

export default function MonthView({ refreshKey, onMutated, onEditTask, onToast }: MonthViewProps) {
  const [cursor, setCursor] = useState<string>(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [data, setData] = useState<MonthData | null>(null)
  const [selected, setSelected] = useState<string>(toISODate(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setLoading(true)
    getMonth(cursor, ac.signal)
      .then((m) => {
        if (!cancelled) {
          setData(m)
          // 若当前 selected 不在返回的 42 格日历中，兜底对齐到今天或当月第 1 天，防止底部任务栏消失
          setSelected((prev) => {
            if (m.cells.some((c) => c.date === prev)) return prev
            const today = m.cells.find((c) => c.isToday)
            const firstInMonth = m.cells.find((c) => c.inMonth)
            return today?.date || firstInMonth?.date || m.cells[0]?.date || prev
          })
          setError('')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [cursor, refreshKey])

  function moveMonth(delta: number) {
    const d = parseISODate(cursor)
    const nd = new Date(d.getFullYear(), d.getMonth() + delta, 1)
    const nextCursor = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-01`
    setCursor(nextCursor)
    const todayISO = toISODate(new Date())
    // 切换月份后保持 selected 同步对齐：若切到了今天所在月份则选今天，否则默认选新月份第 1 天
    setSelected((prev) => {
      if (todayISO.startsWith(nextCursor.slice(0, 7))) return todayISO
      if (prev.startsWith(nextCursor.slice(0, 7))) return prev
      return nextCursor
    })
  }

  function goCurrentMonth() {
    const now = new Date()
    setCursor(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
    setSelected(toISODate(new Date()))
  }

  /* 评审 C2：三个写操作失败必须提示 —— 静默会让用户以为操作成功了（下次重拉弹回），
     与 DDLView 同口径。 */
  async function handleToggle(t: Task) {
    try {
      await toggleTask(t.id)
      onMutated()
    } catch (err) {
      onToast?.(err instanceof Error ? `操作失败：${err.message}` : '操作失败，请重试')
    }
  }

  async function handleDelete(t: Task) {
    if (!window.confirm(`确定删除「${t.title}」吗？`)) return
    try {
      await deleteTask(t.id)
      onMutated()
    } catch (err) {
      onToast?.(err instanceof Error ? `删除失败：${err.message}` : '删除失败，请重试')
    }
  }

  async function handleReorder(ids: number[]) {
    try {
      await reorderTasks(ids)
      onMutated()
    } catch (err) {
      onToast?.(err instanceof Error ? `排序保存失败：${err.message}` : '排序保存失败')
    }
  }

  const selectedCell = data?.cells.find((c) => c.date === selected)
  const isCurrentMonth = data
    ? `${data.year}-${String(data.month).padStart(2, '0')}` ===
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    : false

  return (
    <div>
      <div className="week-toolbar">
        <div className="week-nav">
          <button className="btn btn-ghost btn-sm" onClick={() => moveMonth(-1)} aria-label="上个月">
            ‹
          </button>
          <span className="week-range">{data ? `${data.year}年${data.month}月` : '…'}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => moveMonth(1)} aria-label="下个月">
            ›
          </button>
        </div>
        {!isCurrentMonth && (
          <button className="btn btn-ghost btn-sm" onClick={goCurrentMonth}>
            回到本月
          </button>
        )}
        {data && (
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
            {data.semester.name} · 点日期查看当日任务
          </span>
        )}
      </div>

      {error && <div className="empty-hint">加载失败：{error}（请确认后端已启动）</div>}
      {!error && loading && !data && <TaskListSkeleton rows={3} />}
      {!error && data && (
        <>
          <div className="month-grid-wrap">
            <div className="month-grid">
              {WEEKDAY_HEADER.map((w) => (
                <div key={w} className="month-weekday">
                  {w}
                </div>
              ))}
              {data.cells.map((c) => (
                <div
                  key={c.date}
                  className={`month-cell${c.inMonth ? '' : ' outside'}${c.isToday ? ' today' : ''}${
                    selected === c.date ? ' selected' : ''
                  }`}
                  onClick={() => setSelected(c.date)}
                >
                  <div className="mc-head">
                    <span className="mc-num">{Number(c.date.slice(8, 10))}</span>
                    {/* 放假周整周不排课，明确标出来，免得用户以为课表没导入 */}
                    {c.holiday ? (
                      <span className="mc-courses" style={{ color: 'var(--warn)' }} title="放假周：学校未安排课程">
                        放假
                      </span>
                    ) : (
                      c.courseCount > 0 && (
                        <span className="mc-courses" title={`${c.courseCount} 门课`}>
                          {c.courseCount} 节
                        </span>
                      )
                    )}
                  </div>
                  <div className="mc-chips">
                    {c.tasks.slice(0, 3).map((t) => (
                      <div key={t.id} className={`mc-chip ${t.status === 'done' ? 'done' : t.urgency}`} title={t.title}>
                        {t.status === 'done' ? '✓ ' : ''}
                        {t.title}
                      </div>
                    ))}
                    {c.tasks.length > 3 && <div className="mc-more">+{c.tasks.length - 3} 项</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedCell && (
            <div className="day-section" style={{ marginTop: 18 }}>
              <h4>
                <span>
                  {selectedCell.date.slice(5, 7)}月{selectedCell.date.slice(8, 10)}日
                </span>
                <span>{weekdayCN(selectedCell.weekday)}</span>
                {selectedCell.isToday && <span className="badge today">今天</span>}
                {selectedCell.holiday && <span className="badge neutral">放假无课程</span>}
                <span className="badge neutral">
                  {selectedCell.tasks.filter((t) => t.status !== 'done').length} 项待办
                </span>
              </h4>
              {selectedCell.tasks.length === 0 ? (
                <div className="empty-hint">
                  {selectedCell.holiday ? '这一天在放假周，学校未安排课程，也没有任务' : '这一天没有任务'}
                </div>
              ) : (
                <TaskList
                  items={selectedCell.tasks.map((t) => ({ task: t, urgency: t.urgency }))}
                  onReorder={handleReorder}
                  onToggle={handleToggle}
                  onEdit={onEditTask}
                  onDelete={handleDelete}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
