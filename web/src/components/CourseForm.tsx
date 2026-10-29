import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import type { Course, Settings, WeekType } from '../types'
import { COURSE_COLORS } from '../constants'
import { createCourse, deleteCourse, getCourses, updateCourse } from '../api'
import Modal from './Modal'
import ConflictBanner from './ConflictBanner'
import { conflictsWith, describeConflict, type ConflictSubject } from '../lib/conflicts'
import { compressWeeks, expandWeeks } from '../lib/weeks'

interface CourseFormProps {
  settings: Settings | null
  initial: Course | null
  onSaved: () => void
  onClose: () => void
}

const WEEKDAY_OPTIONS = [
  { v: 1, label: '周一' },
  { v: 2, label: '周二' },
  { v: 3, label: '周三' },
  { v: 4, label: '周四' },
  { v: 5, label: '周五' },
  { v: 6, label: '周六' },
  { v: 7, label: '周日' }
]

export default function CourseForm({ settings, initial, onSaved, onClose }: CourseFormProps) {
  /**
   * label 与输入框的关联 id 前缀。
   * 「新建课程」和「编辑课程」都渲染本组件，两份同时挂载时固定 id 会重复 → useId 保证实例内唯一。
   */
  const uid = useId()
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [teacher, setTeacher] = useState(initial?.teacher ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [dayOfWeek, setDayOfWeek] = useState(initial?.dayOfWeek ?? 1)
  /**
   * 自由选周：精确周号集合是唯一提交口径（服务端同步派生 weekStart/End/Type 摘要）。
   * 编辑旧课程（只有区间+单双周）时先展开成集合，用户可在网格上任意增删。
   */
  const [weeks, setWeeks] = useState<number[]>(() => {
    if (initial?.weeks && initial.weeks.length > 0) return [...initial.weeks]
    return expandWeeks(
      initial?.weekStart ?? 1,
      initial?.weekEnd ?? (settings?.semester.totalWeeks ?? 16),
      initial?.weekType ?? 'all'
    )
  })
  const [startPeriod, setStartPeriod] = useState(initial?.startPeriod ?? 1)
  const [endPeriod, setEndPeriod] = useState(initial?.endPeriod ?? 2)
  const [color, setColor] = useState(initial?.color ?? COURSE_COLORS[0])
  /** 学分输入框保留字符串：空串=未填（null），避免 number 输入框清空时变成 0 */
  const [credits, setCredits] = useState(initial?.credits != null ? String(initial.credits) : '')
  /** 扩展字段：考核方式与成绩占比说明 */
  const [gradingPolicy, setGradingPolicy] = useState(initial?.gradingPolicy ?? '')
  const [showMore, setShowMore] = useState(Boolean(initial?.gradingPolicy))
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const periods = settings?.periods ?? []

  /**
   * 当前学期的其它课程，用于编辑时实时提示时间冲突。
   * 编辑场景要排除自己，否则「改自己的课」会和自己报冲突。
   * 拉取失败静默忽略：冲突提示是附加信息，不该因为一次请求失败而打断添加课程。
   */
  const [others, setOthers] = useState<Course[]>([])
  useEffect(() => {
    const ac = new AbortController()
    getCourses(ac.signal)
      .then((rows) => setOthers(rows.filter((c) => c.id !== initial?.id)))
      .catch(() => undefined)
    return () => ac.abort()
  }, [initial?.id])

  /**
   * 实时冲突检测：随「上课日 / 节次 / 周次」任一变化重算。
   * 课程名不参与判定（除了区分「冲突」与「重复」），所以名称是空的新建课程一样能查出冲突。
   * 节次区间非法（开始晚于结束）时不检测，避免拿一个无意义区间去比。
   */
  const conflicts = useMemo(() => {
    if (startPeriod > endPeriod || weeks.length === 0) return []
    const candidate: ConflictSubject = { name, dayOfWeek, startPeriod, endPeriod, weeks }
    return conflictsWith(candidate, others).sort(
      (x, y) => x.b.dayOfWeek - y.b.dayOfWeek || x.b.startPeriod - y.b.startPeriod
    )
  }, [name, dayOfWeek, startPeriod, endPeriod, weeks, others])

  /** 网格上界：学期总周数与已选周取大（编辑超出总周数的旧数据时不丢周） */
  const maxWeek = Math.max(settings?.semester.totalWeeks ?? 16, ...weeks, 1)

  function toggleWeek(w: number) {
    setWeeks((prev) =>
      prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort((a, b) => a - b)
    )
  }

  /** 快捷预设：全部 / 单周 / 双周 / 前8周 / 后8周 */
  function applyPreset(kind: 'all' | 'odd' | 'even' | 'first8' | 'last8') {
    const out: number[] = []
    for (let w = 1; w <= maxWeek; w++) {
      if (kind === 'odd' && w % 2 === 0) continue
      if (kind === 'even' && w % 2 === 1) continue
      if (kind === 'first8' && w > Math.min(8, maxWeek)) continue
      if (kind === 'last8' && w <= maxWeek - 8) continue
      out.push(w)
    }
    setWeeks(out)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) {
      setError('请填写课程名称')
      return
    }
    if (startPeriod > endPeriod) {
      setError('结束节次不能早于开始节次')
      return
    }
    if (weeks.length === 0) {
      setError('至少选择一个上课周')
      return
    }
    const sortedWeeks = [...new Set(weeks)].sort((a, b) => a - b)
    const allOdd = sortedWeeks.every((w) => w % 2 === 1)
    const allEven = sortedWeeks.every((w) => w % 2 === 0)
    const weekType: WeekType = allOdd ? 'odd' : allEven ? 'even' : 'all'
    let creditsValue: number | null = null
    if (credits.trim() !== '') {
      const n = Number(credits)
      if (!Number.isFinite(n) || n < 0 || n > 30) {
        setError('学分需为 0-30 的数值')
        return
      }
      creditsValue = n
    }
    setSubmitting(true)
    try {
      const body = {
        name: name.trim(),
        teacher: teacher.trim(),
        location: location.trim(),
        dayOfWeek,
        weekStart: sortedWeeks[0],
        weekEnd: sortedWeeks[sortedWeeks.length - 1],
        weekType,
        weeks: sortedWeeks,
        startPeriod,
        endPeriod,
        color,
        credits: creditsValue,
        gradingPolicy: gradingPolicy.trim()
      }
      if (initial) await updateCourse(initial.id, body)
      else await createCourse(body)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open
      title={editing ? '编辑课程' : '添加课程'}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <button
              type="button"
              className="btn btn-danger"
              style={{ marginRight: 'auto' }}
              disabled={submitting}
              onClick={async () => {
                if (!initial) return
                if (!window.confirm(`确定删除课程「${initial.name}」吗？关联任务将变为无课程。`)) return
                setSubmitting(true)
                try {
                  await deleteCourse(initial.id)
                  onSaved()
                  onClose()
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除失败')
                  setSubmitting(false)
                }
              }}
            >
              删除课程
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="course-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="course-form" onSubmit={handleSubmit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor={`${uid}-name`}>
            课程名称<span className="required">*</span>
          </label>
          {/* 不加 autoFocus：移动端一旦自动聚焦就会立刻弹出软键盘，把表单顶掉。
              用户主动点输入框才唤起键盘，符合"进入编辑页先看内容"的习惯。 */}
          <input id={`${uid}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：高等数学" />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-teacher`}>教师</label>
            <input id={`${uid}-teacher`} className="input" value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="选填" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-location`}>地点</label>
            <input id={`${uid}-location`} className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="如：逸夫楼203" />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-day-of-week`}>
            上课日<span className="required">*</span>
          </label>
          <select id={`${uid}-day-of-week`} className="select" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
            {WEEKDAY_OPTIONS.map((w) => (
              <option key={w.v} value={w.v}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            上课周<span className="required">*</span>
          </label>
          <div className="week-presets">
            <button type="button" onClick={() => applyPreset('all')}>全部</button>
            <button type="button" onClick={() => applyPreset('odd')}>单周</button>
            <button type="button" onClick={() => applyPreset('even')}>双周</button>
            <button type="button" onClick={() => applyPreset('first8')}>前 8 周</button>
            <button type="button" onClick={() => applyPreset('last8')}>后 8 周</button>
          </div>
          <div className="week-grid">
            {Array.from({ length: maxWeek }, (_, i) => i + 1).map((w) => (
              <button
                key={w}
                type="button"
                className={`week-chip${weeks.includes(w) ? ' selected' : ''}`}
                onClick={() => toggleWeek(w)}
                aria-pressed={weeks.includes(w)}
                aria-label={`第 ${w} 周`}
              >
                {w}
              </button>
            ))}
          </div>
          <div className="week-summary">
            {weeks.length > 0 ? `已选：第 ${compressWeeks(weeks)} 周（共 ${weeks.length} 周）` : '尚未选择任何周'}
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-credits`}>学分</label>
            <input
              id={`${uid}-credits`}
              className="input"
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
              placeholder="选填，如 2.5"
            />
          </div>
          <div className="field">
            <label>颜色</label>
            <div className="color-picker" style={{ paddingTop: 4 }}>
              {COURSE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch${c === color ? ' selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`颜色 ${c}`}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-start-period`}>开始节次</label>
            <select id={`${uid}-start-period`} className="select" value={startPeriod} onChange={(e) => setStartPeriod(Number(e.target.value))}>
              {periods.map((p) => (
                <option key={p.index} value={p.index}>
                  第{p.index}节 {p.start}-{p.end}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-end-period`}>结束节次</label>
            <select id={`${uid}-end-period`} className="select" value={endPeriod} onChange={(e) => setEndPeriod(Number(e.target.value))}>
              {periods.map((p) => (
                <option key={p.index} value={p.index}>
                  第{p.index}节 {p.start}-{p.end}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 扩展信息：考核与成绩占比（选填，默认折叠以免给主表单添负担） */}
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowMore((v) => !v)}
            style={{ width: '100%', justifyContent: 'space-between', padding: '8px 10px', fontSize: 13 }}
          >
            <span>考核与成绩占比（选填）</span>
            <span>{showMore ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showMore && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--bg-3)', borderRadius: 10 }}>
              <div className="field">
                <label htmlFor={`${uid}-grading-policy`}>考核与成绩占比说明</label>
                <input
                  id={`${uid}-grading-policy`}
                  className="input"
                  value={gradingPolicy}
                  onChange={(e) => setGradingPolicy(e.target.value)}
                  placeholder="如：平时出勤 30% + 大作业 30% + 期末 40%"
                  maxLength={500}
                />
              </div>
            </div>
          )}
        </div>

        {/* 放在表单末尾：用户刚调完节次/周次，目光还在下方，提示离「保存」最近 */}
        <ConflictBanner
          conflicts={conflicts}
          title={`与现有课程有 ${conflicts.length} 处时间重叠`}
          format={describeConflict}
          note="同一时段两门课不一定是错误（如分组上课、体育选修），这里只作提醒，不阻止保存。"
        />
      </form>
    </Modal>
  )
}
