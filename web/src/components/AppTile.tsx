/**
 * 「应用」页的单个磁贴。
 *
 * 视觉规格对齐参考仓库 `MoreWorkspace.kt` 的 `ApplicationTileCard`：
 *   最小高度 104 / 圆角 20 / 图标底 40×40 圆角 12（强调色 12% 透明度）/ 标题 17px SemiBold
 *
 * 三个有意为之的取舍：
 *  1. 未开放（status='soon'）的磁贴**照常渲染但半透明且不可点** —— 而不是直接不显示。
 *     用户需要知道"这个功能存在但还没做"，直接隐藏会让人以为我们没这项能力。
 *  2. 强调色只上在图标底上（图标 + 12% 底），**标题保持正文色**。
 *     整个卡片染色会在 4 列网格里糊成一片色块，可读性反而下降。
 *  3. 角标文案只对 'beta' 显示「需登录学校系统」之类的诚实提示，不用模糊的"新"。
 */
import type { AppEntry } from '../lib/appRegistry'
import { AppTileIcon } from './AppTileIcon'

interface AppTileProps {
  entry: AppEntry
  onClick: (entry: AppEntry) => void
}

const STATUS_BADGE: Record<AppEntry['status'], string | null> = {
  ready: null,
  beta: '需登录',
  soon: '即将上线'
}

export default function AppTile({ entry, onClick }: AppTileProps) {
  const disabled = entry.status === 'soon'
  const badge = STATUS_BADGE[entry.status]

  return (
    <button
      type="button"
      className={`app-tile${disabled ? ' is-disabled' : ''}`}
      /* ⚠️ 用 aria-disabled 而不是 disabled 属性：仍可聚焦，读屏能读到"即将上线"，
         而 disabled 按钮在很多读屏器里会被整个跳过，用户就永远不知道有这么个功能。 */
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return
        onClick(entry)
      }}
    >
      <span className="app-tile-ico" data-cat={entry.category}>
        <AppTileIcon name={entry.icon} size={22} />
      </span>
      <span className="app-tile-title">{entry.title}</span>
      <span className="app-tile-sub">{entry.subtitle}</span>
      {badge && <span className={`app-tile-badge${disabled ? ' is-soon' : ''}`}>{badge}</span>}
    </button>
  )
}
