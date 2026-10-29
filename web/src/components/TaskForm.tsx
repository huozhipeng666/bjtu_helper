import { useEffect, useId, useState, type FormEvent } from 'react'
import type { Course, Task } from '../types'
import { createTask, getCourses, updateTask } from '../api'
import { toISODate } from '../lib/date'
import {
  addTaskToCalendar, hasNativeCalendarBridge, isTaskInCalendar,
  markTaskInCalendar, readTaskCalendarPref, writeTaskCalendarPref
} from '../lib/calendarBridge'
import Modal from './Modal'

interface TaskFormProps {
  initial: Task | null
  onSaved: () => void
  onClose: () => void
  /** 用于提示「是否已写进系统日历」 */
  onToast?: (msg: string) => void
}

export default function TaskForm({ initial, onSaved, onClose, onToast }: TaskFormProps) {
  /** label 与输入框的关联 id 前缀：新建/编辑各挂一份时固定 id 会重复，用 useId 保证唯一 */
  const uid = useId()
  const editing = !!initial
  /* 只有原生 WebView 壳才具备「写系统日历」的能力。
     网页端受沙箱限制拿不到日历权限，显示这个开关只会误导，所以直接隐藏。 */
  const nativeCalendar = hasNativeCalendarBridge()
  /** 编辑时这条是否已经在系统日历里（本地标记）—— 在的话保存后自动按新时间更新 */
  const wasInCalendar = editing && initial ? isTaskInCalendar(initial.id) : false
  /**
   * 新建时是否顺手写进系统日历；默认沿用上次选择（存在 localStorage）。
   * 编辑态默认不勾：只有用户明确要加，或这条本来就在日历里（走自动更新）时才写。
   */
  const [addToCalendar, setAddToCalendar] = useState(() => (editing ? false : nativeCalendar && readTaskCalendarPref()))
  /** 保存时是否要把这条 DDL 写/更新到系统日历 */
  const syncCalendar = nativeCalendar && (wasInCalendar || addToCalendar)
  const [courses, setCourses] = useState<Course[]>([])
  const [title, setTitle] = useState(initial?.title ?? '')
  const [type, setType] = useState<Task['type']>(initial?.type ?? 'homework')
  const [courseId, setCourseId] = useState<string>(initial?.courseId ? String(initial.courseId) : '')
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? toISODate(new Date()))
  const [dueTime, setDueTime] = useState(initial?.dueTime ?? '23:59')
  const [priority, setPriority] = useState<Task['priority']>(initial?.priority ?? 'medium')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getCourses()
      .then(setCourses)
      .catch(() => setCourses([]))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!title.trim()) {
      setError('请填写任务标题')
      return
    }
    if (!dueDate) {
      setError('请选择截止日期')
      return
    }
    setSubmitting(true)
    try {
      const body = {
        title: title.trim(),
        type,
        courseId: courseId === '' ? null : Number(courseId),
        dueDate,
        dueTime: dueTime || '',
        priority,
        notes: notes.trim()
      }
      let saved: Task
      if (initial) saved = await updateTask(initial.id, body)
      else saved = await createTask(body)

      /* 勾了「加入系统日历提醒」：把这一条写成日历事件（编辑时是更新那一条）。
         原生侧按任务 id 去重，所以新建/编辑反复保存都只对应日历里的一个事件。
         没授权时 App 会自己弹系统授权框，事件先排队，用户点「允许」后自动补写。 */
      if (syncCalendar) {
        const r = addTaskToCalendar(saved)
        if (r.ok) {
          markTaskInCalendar(saved.id)
          onToast?.(r.status === 'updated' ? '已更新系统日历提醒' : '已加入系统日历提醒')
        } else if (r.status === 'pending') {
          onToast?.('已弹出日历授权框：点「允许」后这条 DDL 会自动写进日历')
        } else if (r.status === 'blocked') {
          onToast?.('日历权限被拒绝：请在系统设置里为「交大小助手」打开日历权限')
        } else {
          onToast?.(`日历提醒写入失败：${r.message}`)
        }
      }

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
      title={editing ? '编辑任务' : '添加任务'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="task-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="task-form" onSubmit={handleSubmit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor={`${uid}-title`}>
            标题<span className="required">*</span>
          </label>
          <input
            id={`${uid}-title`}
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：高数作业 P45 第1-12题"
            autoFocus
          />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-type`}>类型</label>
            <select id={`${uid}-type`} className="select" value={type} onChange={(e) => setType(e.target.value as Task['type'])}>
              <option value="homework">作业</option>
              <option value="exam">考试</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-course`}>关联课程</label>
            <select id={`${uid}-course`} className="select" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">无</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-due-date`}>
              截止日期<span className="required">*</span>
            </label>
            <input id={`${uid}-due-date`} className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-due-time`}>截止时间</label>
            <input id={`${uid}-due-time`} className="input" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-priority`}>优先级</label>
          <select id={`${uid}-priority`} className="select" value={priority} onChange={(e) => setPriority(e.target.value as Task['priority'])}>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-notes`}>备注</label>
          <textarea id={`${uid}-notes`} className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="选填" />
        </div>

        {/* 日历提醒（仅原生壳）：勾了就顺手把这条 DDL 写进手机系统日历，
            系统会在截止时间前提醒，App 不在前台也能收到。选择会被记住，下次默认沿用。
            编辑态：已经在日历里的那条不给勾选框（桥没有删除能力，取消勾选也删不掉），
            改成一句说明——保存时会自动按新的截止时间更新。 */}
        {nativeCalendar && !editing && (
          <label className="cal-toggle">
            <input
              type="checkbox"
              checked={addToCalendar}
              onChange={(e) => {
                setAddToCalendar(e.target.checked)
                writeTaskCalendarPref(e.target.checked) // 记住选择，之后不必每次手动改
              }}
            />
            <span>
              <b>加入系统日历提醒</b>
              <em>
                保存后由 App 申请日历权限，并在手机日历里为这条 DDL 创建一个事件：有截止时间就提前 2 小时提醒，
                只有日期则当天 00:00 起提前 12 小时提醒。
              </em>
            </span>
          </label>
        )}
        {nativeCalendar && editing && wasInCalendar && (
          <p className="cal-note">这条 DDL 已在系统日历里：保存后会按新的截止时间更新那一条提醒。</p>
        )}
        {nativeCalendar && editing && !wasInCalendar && (
          <label className="cal-toggle">
            <input type="checkbox" checked={addToCalendar} onChange={(e) => setAddToCalendar(e.target.checked)} />
            <span>
              <b>加入系统日历提醒</b>
              <em>保存后由 App 申请日历权限，为这条 DDL 在手机日历里建一个带提醒的事件。</em>
            </span>
          </label>
        )}
      </form>
    </Modal>
  )
}
