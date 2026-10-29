import { useState, type DragEvent } from 'react'
import type { Task, Urgency } from '../types'
import TaskItem from './TaskItem'

export interface TaskListItem {
  task: Task
  urgency?: Urgency
  /** 该条正在"完成动画"中（划掉 → 收起 → 移入已完成区），用于禁用拖拽/重复点击 */
  completing?: boolean
  /** 该条刚从待办完成、新落到"已完成区"，播放入场动画 */
  justDone?: boolean
}

interface TaskListProps {
  items: TaskListItem[]
  onReorder: (orderedIds: number[]) => void
  onToggle?: (task: Task) => void
  onEdit?: (task: Task) => void
  onDelete?: (task: Task) => void
  /** 逾期任务快捷「顺延到明天」 */
  onPostpone?: (task: Task) => void
  /** 单条「加入系统日历提醒」（仅原生壳里传入，网页端不传即不显示该按钮） */
  onAddCalendar?: (task: Task) => void
  /** 已写进系统日历的任务 id（用于点亮列表里的日历图标） */
  inCalendarIds?: number[]
  /** 点卡片主体打开详情（透传给 TaskItem） */
  onOpen?: (task: Task) => void
}

/**
 * 可拖拽排序的任务列表（HTML5 拖拽，桌面端可用）。
 * 拖拽调整顺序后通过 onReorder 提交新顺序。
 */
export default function TaskList({
  items, onReorder, onToggle, onEdit, onDelete, onPostpone, onAddCalendar, inCalendarIds, onOpen
}: TaskListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  function moveItem(fromIndex: number, delta: number) {
    const toIndex = fromIndex + delta
    if (toIndex < 0 || toIndex >= items.length) return
    const next = [...items]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    onReorder(next.map((i) => i.task.id))
  }

  function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault()
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null)
      return
    }
    const next = [...items]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(targetIndex, 0, moved)
    setDragIndex(null)
    onReorder(next.map((i) => i.task.id))
  }

  return (
    <div className="task-list">
      {items.map((it, i) => (
        <div
          key={it.task.id}
          draggable
          onDragStart={(e) => {
            setDragIndex(i)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', String(it.task.id))
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(e) => handleDrop(e, i)}
          onDragEnd={() => setDragIndex(null)}
          className={`task-drag${dragIndex === i ? ' dragging' : ''}`}
          title="拖动或使用上下箭头可调整顺序"
        >
          <TaskItem
            task={it.task}
            urgency={it.urgency}
            completing={it.completing}
            justDone={it.justDone}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
            onPostpone={onPostpone}
            onAddCalendar={onAddCalendar}
            inCalendar={inCalendarIds?.includes(it.task.id)}
            onOpen={onOpen}
            onMoveUp={items.length > 1 && i > 0 && !it.completing ? () => moveItem(i, -1) : undefined}
            onMoveDown={items.length > 1 && i < items.length - 1 && !it.completing ? () => moveItem(i, 1) : undefined}
          />
        </div>
      ))}
    </div>
  )
}
