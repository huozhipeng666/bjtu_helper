import type { Overview, Task, Urgency } from '../types'
import TaskItem from './TaskItem'
import { IconClose } from '../icons'

interface ReminderPanelProps {
  overview: Overview | null
  notifyEnabled: boolean
  onClose: () => void
  onEnableNotify: () => void
  onEdit: (task: Task) => void
}

const GROUPS: { key: 'overdue' | 'today' | 'tomorrow' | 'thisWeek'; label: string; urgency: Urgency }[] = [
  { key: 'overdue', label: '已逾期', urgency: 'overdue' },
  { key: 'today', label: '今天截止', urgency: 'today' },
  { key: 'tomorrow', label: '明天截止', urgency: 'tomorrow' },
  { key: 'thisWeek', label: '本周稍后', urgency: 'thisWeek' }
]

/** 提醒底部抽屉：点击遮罩（面板外任意处）即可关闭 */
export default function ReminderPanel({ overview, notifyEnabled, onClose, onEnableNotify, onEdit }: ReminderPanelProps) {
  const hasAny =
    !!overview && (overview.overdue.length || overview.today.length || overview.tomorrow.length || overview.thisWeek.length)

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="reminder-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h3>提醒</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={20} />
          </button>
        </div>
        {!hasAny && <div className="empty">暂时没有要紧的截止，轻松了</div>}
        {overview &&
          GROUPS.map((g) => {
            const list = overview[g.key]
            if (list.length === 0) return null
            return (
              <div key={g.key}>
                <h4>{g.label}</h4>
                {list.slice(0, 5).map((t) => (
                  <TaskItem key={t.id} task={t} urgency={g.urgency} onEdit={onEdit} />
                ))}
              </div>
            )
          })}
        <div className="panel-actions">
          <button className="btn btn-ghost" onClick={onEnableNotify} disabled={notifyEnabled}>
            {notifyEnabled ? '通知已开启' : '开启浏览器通知'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
