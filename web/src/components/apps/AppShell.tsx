/**
 * 应用子页的公共外壳：返回栏 + 标题 + 内容区。
 *
 * 抽出来的理由：9 个应用子页如果各写一遍返回栏，将来要调
 * 吸顶高度 / 安全区 / 返回键行为（`useBackStep`）就得改 9 处。
 */
import type { ReactNode } from 'react'
import { IconChevronLeft } from '../../icons'

interface AppShellProps {
  title: string
  onBack: () => void
  /** 标题右侧的动作按钮（可选） */
  action?: ReactNode
  /** 顶部说明文案（可选） */
  lead?: ReactNode
  children: ReactNode
}

export default function AppShell({ title, onBack, action, lead, children }: AppShellProps) {
  return (
    <div className="app-detail">
      <div className="subpage-head">
        <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={22} />
        </button>
        <h3>{title}</h3>
        {action}
      </div>
      {lead && <div className="app-note">{lead}</div>}
      {children}
    </div>
  )
}
