import type { Task, Urgency } from '../types'
import { relativeDueText } from '../lib/date'
import { PRIORITY_COLOR, PRIORITY_LABEL, TYPE_LABEL } from '../constants'
import { IconCalendar } from '../icons'
import Modal from './Modal'

interface TaskDetailModalProps {
  /** 要展示的任务；null 表示弹窗已关（保留 Modal 的退场动画） */
  task: Task | null
  /** 未完成任务的紧迫度，用于截止倒计时文案与配色；已完成不传 */
  urgency?: Urgency
  onClose: () => void
  onToggle?: (task: Task) => void
  onEdit?: (task: Task) => void
  onDelete?: (task: Task) => void
  /** 逾期任务的快捷「顺延到明天」；非逾期/已完成不显示 */
  onPostpone?: (task: Task) => void
  /** 「加入系统日历提醒」（仅原生壳里传入） */
  onAddCalendar?: (task: Task) => void
  /** 该条是否已经写进过系统日历（影响日历按钮文案） */
  inCalendar?: boolean
}

/** 紧迫度 → 颜色，与列表里 .task-urgent.* 的配色保持一致 */
const URGENCY_COLOR: Record<Urgency, string> = {
  overdue: 'var(--danger)',
  today: 'var(--warn)',
  tomorrow: 'var(--amber)',
  thisWeek: 'var(--accent-2)',
  upcoming: 'var(--accent-2)'
}

/**
 * 任务详情弹窗：DDL 列表卡片空间有限（标题最多两行），点卡片主体在这里看全量信息 ——
 * 完整标题、课程、优先级、截止时间与倒计时、备注，以及一排常用操作。
 */
export default function TaskDetailModal({
  task,
  urgency,
  onClose,
  onToggle,
  onEdit,
  onDelete,
  onPostpone,
  onAddCalendar,
  inCalendar
}: TaskDetailModalProps) {
  const done = task?.status === 'done'
  const countdown = task && !done && urgency ? relativeDueText(task.dueDate, task.dueTime, urgency) : ''
  const notes = task?.notes?.trim() ?? ''

  return (
    <Modal
      open={task !== null}
      title="任务详情"
      onClose={onClose}
      footer={
        task && (
          <>
            {onDelete && (
              <button className="btn btn-danger" onClick={() => onDelete(task)}>
                删除
              </button>
            )}
            {onPostpone && !done && urgency === 'overdue' && (
              <button className="btn btn-ghost" onClick={() => onPostpone(task)} title="截止日期改为明天">
                顺延到明天
              </button>
            )}
            {onAddCalendar && !done && (
              <button
                className="btn btn-ghost"
                onClick={() => onAddCalendar(task)}
                title={inCalendar ? '已加入系统日历（点击可按最新截止时间更新）' : '加入系统日历提醒'}
              >
                {inCalendar ? '更新日历提醒' : '加入日历提醒'}
              </button>
            )}
            {onEdit && (
              <button className="btn btn-soft" onClick={() => onEdit(task)}>
                编辑
              </button>
            )}
            {onToggle && (
              <button className="btn btn-primary" onClick={() => onToggle(task)}>
                {done ? '取消完成' : '完成'}
              </button>
            )}
          </>
        )
      }
    >
      {task && (
        <div className="task-detail">
          <div className={`task-detail-title${done ? ' done' : ''}`}>{task.title}</div>

          <div className="task-detail-chips">
            <span className="chip">{TYPE_LABEL[task.type]}</span>
            <span className="chip">
              <span className="dot" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: PRIORITY_COLOR[task.priority], marginRight: 5 }} />
              {PRIORITY_LABEL[task.priority]}优先级
            </span>
            {task.courseName && (
              <span className="chip">
                <span className="dot" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: task.color ?? '#5e6673', marginRight: 5 }} />
                {task.courseName}
              </span>
            )}
            <span className="chip">{done ? '已完成' : '进行中'}</span>
          </div>

          <div className="task-detail-due">
            <IconCalendar size={15} />
            <span>{task.dueTime ? `${task.dueDate} ${task.dueTime}` : task.dueDate}</span>
            {countdown && urgency && (
              <span className="task-detail-countdown" style={{ color: URGENCY_COLOR[urgency] }}>
                {countdown}
              </span>
            )}
          </div>

          <div className={`task-detail-notes${notes ? '' : ' empty'}`}>
            {notes || '未填写备注'}
          </div>
        </div>
      )}
    </Modal>
  )
}
