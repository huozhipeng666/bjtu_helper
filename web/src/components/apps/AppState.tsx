import type { ReactNode } from 'react'

/**
 * 应用子页的「三态」统一占位。
 *
 * 背景：9 个应用子页原先全部拿 `.app-empty` 一个类兼作「加载中 / 出错 / 空数据」，
 * 三者长得一模一样 —— 出错时用户看不出是网络问题还是真没内容，也看不出能重试。
 * 这里按语义拆成三种，各配不同的图标底色与文案层级。
 *
 * 用法：
 *   <AppState kind="loading" title="正在加载资料列表…" />
 *   <AppState kind="error" title={error} onRetry={reload} />
 *   <AppState kind="empty" title="这门课没有上传任何资料" hint="老师上传后会出现在这里。" />
 */
export type AppStateKind = 'loading' | 'error' | 'empty'

export interface AppStateProps {
  kind: AppStateKind
  /** 主文案：一句话说清现在是什么状态 */
  title: string
  /** 次要说明：为什么这样、下一步做什么。可选 */
  hint?: string
  /** 传入则在下方渲染一个重试按钮（只对 error 有意义） */
  onRetry?: () => void
  retryLabel?: string
  /** 需要更复杂的自定义内容时用（例如「去登录」按钮组） */
  children?: ReactNode
}

/** 三种状态各用一个内联 SVG，避免为几个图标把 icons.tsx 再扩一圈 */
function StateIcon({ kind }: { kind: AppStateKind }) {
  if (kind === 'loading') {
    /* 转圈交给 CSS 的 .app-spinner，这里只放一个空心圆环 */
    return <span className="app-spinner" aria-hidden="true" />
  }
  if (kind === 'error') {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="16.4" r="1.05" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4.2 7.6A1.6 1.6 0 0 1 5.8 6h4.1l1.7 2h6.6a1.6 1.6 0 0 1 1.6 1.6v8.8A1.6 1.6 0 0 1 18.2 20H5.8a1.6 1.6 0 0 1-1.6-1.6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function AppState({ kind, title, hint, onRetry, retryLabel = '重试', children }: AppStateProps) {
  return (
    <div className={`app-state is-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <span className="app-state-ico">
        <StateIcon kind={kind} />
      </span>
      <p className="app-state-title">{title}</p>
      {hint && <p className="app-state-hint">{hint}</p>}
      {children}
      {onRetry && (
        <button type="button" className="btn-ghost app-state-btn" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}
