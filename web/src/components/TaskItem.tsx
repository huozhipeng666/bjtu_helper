import type { Task, Urgency } from '../types'
import { relativeDueText } from '../lib/date'
import { PRIORITY_COLOR, PRIORITY_LABEL, TYPE_LABEL } from '../constants'
import { IconCalendar, IconCheck, IconEdit, IconTrash, IconArrowUp, IconArrowDown } from '../icons'

interface TaskItemProps {
  task: Task
  urgency?: Urgency
  onToggle?: (task: Task) => void
  onEdit?: (task: Task) => void
  onDelete?: (task: Task) => void
  /** 逾期任务的快捷「顺延到明天」；非逾期/已完成不显示 */
  onPostpone?: (task: Task) => void
  /**
   * 「加入系统日历提醒」。只有原生壳里才有这个能力（网页拿不到日历权限），
   * 所以由调用方决定是否传 —— 传了才显示那个日历按钮。
   */
  onAddCalendar?: (task: Task) => void
  /** 该条是否已经写进过系统日历（本地标记，仅用于图标点亮） */
  inCalendar?: boolean
  /** 排序微调：上移 */
  onMoveUp?: () => void
  /** 排序微调：下移 */
  onMoveDown?: () => void
  /** 强制不显示右侧截止文案（如列表内重复） */
  hideDueText?: boolean
  /** 点卡片主体（标题/元信息区）打开详情；不传则卡片主体不可点 */
  onOpen?: (task: Task) => void
  /** 该条正处于"完成→收起→移入已完成区"的过渡中 */
  completing?: boolean
  /** 该条刚从待办完成、新落到"已完成区"，播放入场动画（下坠淡入） */
  justDone?: boolean
}

export default function TaskItem({
  task,
  urgency,
  onToggle,
  onEdit,
  onDelete,
  onPostpone,
  onAddCalendar,
  inCalendar,
  onMoveUp,
  onMoveDown,
  hideDueText,
  onOpen,
  completing,
  justDone
}: TaskItemProps) {
  const done = task.status === 'done'
  const urgencyText = !hideDueText && urgency ? relativeDueText(task.dueDate, task.dueTime, urgency) : ''
  const cls = [
    'task-item',
    done ? 'done' : '',
    completing ? 'completing' : '',
    justDone ? 'task-done-enter' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const hasActions = !!(onEdit || onDelete || onPostpone || onMoveUp || onMoveDown || (onAddCalendar && !done))
  return (
    <div className={cls}>
      {onToggle && (
        <button
          className={`task-check${done || completing ? ' done' : ''}`}
          onClick={() => onToggle(task)}
          disabled={completing}
          aria-label={done ? '标记为未完成' : '标记为完成'}
        >
          {done || completing ? <IconCheck size={13} /> : ''}
        </button>
      )}
      <div
        className="task-main"
        {...(onOpen
          ? {
              onClick: () => onOpen(task),
              role: 'button',
              tabIndex: 0,
              onKeyDown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen(task)
                }
              },
              'aria-label': `查看「${task.title}」详情`,
              style: { cursor: 'pointer' }
            }
          : {})}
      >
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <span className="prio-dot" style={{ background: PRIORITY_COLOR[task.priority] }} title={`优先级：${PRIORITY_LABEL[task.priority]}`} />
          <span className="task-type">{TYPE_LABEL[task.type]}</span>
          {task.courseName && (
            <span className="course-chip">
              <span className="dot" style={{ background: task.color ?? '#5e6673' }} />
              {task.courseName}
            </span>
          )}
          <span>{task.dueTime ? `${task.dueDate} ${task.dueTime}` : task.dueDate}</span>
        </div>
      </div>
      {(urgencyText || hasActions) && (
        <div className="task-right">
          {urgencyText && <span className={`task-urgent ${urgency}`}>{urgencyText}</span>}
          {hasActions && (
            <div className="task-actions">
              {onMoveUp && (
                <button className="icon-btn" onClick={onMoveUp} aria-label="上移任务" title="上移">
                  <IconArrowUp size={15} />
                </button>
              )}
              {onMoveDown && (
                <button className="icon-btn" onClick={onMoveDown} aria-label="下移任务" title="下移">
                  <IconArrowDown size={15} />
                </button>
              )}
              {onPostpone && !done && urgency === 'overdue' && (
                <button className="mini-btn" onClick={() => onPostpone(task)} title="截止日期改为明天">
                  顺延
                </button>
              )}
              {onAddCalendar && !done && (
                <button
                  className={`icon-btn cal-btn${inCalendar ? ' is-in' : ''}`}
                  onClick={() => onAddCalendar(task)}
                  aria-label={inCalendar ? '已加入系统日历，点击可更新' : '加入系统日历提醒'}
                  title={inCalendar ? '已加入系统日历（点击可按最新截止时间更新）' : '加入系统日历提醒'}
                >
                  <IconCalendar size={16} />
                </button>
              )}
              {onEdit && (
                <button className="icon-btn" onClick={() => onEdit(task)} aria-label="编辑">
                  <IconEdit size={16} />
                </button>
              )}
              {onDelete && (
                <button className="icon-btn danger" onClick={() => onDelete(task)} aria-label="删除">
                  <IconTrash size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
