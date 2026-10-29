/**
 * 「应用」页 —— 功能目录。
 *
 * 信息架构照搬参考仓库的 `AppSection` 目录模型（学习 / 校园服务 / 工具），
 * 但**不照搬**它的底栏可配置模型：我们是 Web，底栏固定 4 项不开放配置，
 * 「应用」通过 App.tsx 的全屏子页机制进入（与「空闲课表」「情侣课表」同一模式）。
 *
 * 为什么要有搜索：
 * 目前 11 个条目一屏放得下，但目录只会越来越长（每加一个校园子系统就 +1）。
 * 等到 20+ 再补搜索，用户已经养成"翻着找"的习惯了。现在加成本几乎为零。
 */
import { useMemo, useState } from 'react'
import { APP_ENTRIES, groupedEntries, type AppEntry } from '../lib/appRegistry'
import AppTile from '../components/AppTile'
import AppState from '../components/apps/AppState'
import { IconChevronLeft, IconSearch, IconClose } from '../icons'

interface AppsViewProps {
  onBack: () => void
  onOpen: (entry: AppEntry) => void
  /** 游客点受保护功能时的统一引导 */
  onRequireLogin?: () => void
  isGuest?: boolean
}

export default function AppsView({ onBack, onOpen, onRequireLogin, isGuest }: AppsViewProps) {
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return groupedEntries()
    const hit = APP_ENTRIES.filter(
      (e) => e.title.toLowerCase().includes(kw) || e.subtitle.toLowerCase().includes(kw)
    )
    return groupedEntries(hit)
  }, [q])

  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="apps-view">
      {/* 返回栏沿用项目既有写法（subpage-head + btn-back + h3），
          不新造 subheader —— 那套吸顶/安全区逻辑已经在 styles.css 里调好了。 */}
      <div className="subpage-head">
        <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={22} />
        </button>
        <h3>应用</h3>
      </div>

      <div className="apps-search">
        <IconSearch size={17} />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索功能"
          aria-label="搜索功能"
        />
        {q && (
          <button type="button" className="apps-search-clear" onClick={() => setQ('')} aria-label="清空">
            <IconClose size={15} />
          </button>
        )}
      </div>

      {isGuest && (
        <button type="button" className="apps-guest-tip" onClick={onRequireLogin}>
          用学号登录后，成绩、作业、课件等需要用学校账号的功能才会开放
        </button>
      )}

      {total === 0 ? (
        <AppState
          kind="empty"
          title={`没有匹配「${q}」的功能`}
          hint="试试更短的关键词，或清空搜索看全部功能。"
        >
          <button type="button" className="btn-ghost app-state-btn" onClick={() => setQ('')}>
            清空搜索
          </button>
        </AppState>
      ) : (
        groups.map((g) => (
          <section key={g.meta.key} className="apps-group">
            <div className="profile-section-title">
              {g.meta.title}
              {/* 搜索时能看到每组还剩几个，比只列标题更有用 */}
              {q.trim() && <span className="apps-group-count">{g.items.length}</span>}
            </div>
            <div className="app-grid">
              {g.items.map((e) => (
                <AppTile key={e.id} entry={e} onClick={onOpen} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
