import { useEffect, useMemo, useState } from 'react'
import { useAbortController } from '../lib/useAbortController'
import type { ActivityLevel, Course, User, UserRole } from '../types'
import {
  AdminStats, AdminUser, AdminUserActivity, createAdminUser, deleteAdminUser, getAdminStats,
  getAdminUserActivity, getAdminUsers, resetAdminUserPassword, updateAdminUser,
  getAdminUserCourses, type AdminUserCourses
} from '../api'
import { IconPlus, IconChevronLeft, IconSearch } from '../icons'
import Modal from '../components/Modal'
import AdminFeedback from '../components/AdminFeedback'
import { FEEDBACK_STATUS_LABEL, FEEDBACK_TYPE_LABEL } from '../constants'
import { weekdayCN, fmtAgo, fmtDateTimeCN, parseServerTime } from '../lib/date'
import { compressWeeks } from '../lib/weeks'
import { PASSWORD_MIN } from '../lib/authConstraints'

interface AdminViewProps {
  currentUser: User
  /** 从个人中心进入时提供返回；不传则无返回行 */
  onBack?: () => void
}

/** 后台的两个板块：用户管理 / 反馈管理 */
type AdminSection = 'users' | 'feedback'

/* 活跃度分级 → 文案 + 样式类。分级由服务端判定（口径见 server/src/index.ts 的 activityLevel），
   这里只负责展示，避免前后端各判一套导致同一个用户在两处显示不同结论。 */
const LEVEL_META: Record<ActivityLevel, { label: string; cls: string; hint: string }> = {
  active: { label: '活跃', cls: 'lvl-active', hint: '3 天内有动作' },
  normal: { label: '一般', cls: 'lvl-normal', hint: '14 天内有动作' },
  silent: { label: '沉默', cls: 'lvl-silent', hint: '超过 14 天没动静' },
  never: { label: '从未', cls: 'lvl-never', hint: '没有任何活跃记录' }
}

type SortKey = 'activity' | 'created' | 'content'
type RoleFilter = 'all' | 'admin' | 'user'

const SORT_LABEL: Record<SortKey, string> = {
  activity: '最近活跃',
  created: '注册时间',
  content: '内容产出'
}

/** 周次文案：优先精确周集合（如 "1,3,5…周"），否则 全学期/单周/双周 摘要 */
function weekRangeText(c: Course): string {
  if (c.weeks && c.weeks.length > 0) return `${compressWeeks(c.weeks)} 周`
  const typeText = c.weekType === 'odd' ? '单周' : c.weekType === 'even' ? '双周' : ''
  return `${c.weekStart}-${c.weekEnd} 周${typeText ? ` · ${typeText}` : ''}`
}

/** 服务端时间字符串 → 时间戳（越小越久远；空值记 0，排序时自然沉底） */
function tsOf(s: string | null | undefined): number {
  return parseServerTime(s)?.getTime() ?? 0
}

export default function AdminView({ currentUser, onBack }: AdminViewProps) {
  const [section, setSection] = useState<AdminSection>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  /* 2026-10-23（评审 A6）：列表改分页拉取，total 是服务端的全量账号数（排除游客）。 */
  const [total, setTotal] = useState(0)
  const [moreLoading, setMoreLoading] = useState(false)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const begin = useAbortController()
  const [showCreate, setShowCreate] = useState(false)
  const [nu, setNu] = useState({ username: '', password: '', role: 'user' as UserRole })

  /* 列表筛选/排序状态。放在前端而不是每改一次就请求后端：
     管理员后台的用户量是百级，一次拉全量再本地过滤比反复打接口更快，
     也不会出现"输入搜索词时列表闪烁"。数据量真涨到千级以上再改成服务端分页。 */
  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [sort, setSort] = useState<SortKey>('activity')

  /* 原先 load() 没有任何竞态守卫：管理员连续建号/删号会触发多次 load，
     先发的响应后到时会把新列表覆盖成旧列表（且会在组件卸载后写状态）。
     改用 begin() 取消上一次在途请求，并在每个 setState 前判 aborted。 */
  function load() {
    const ac = begin()
    setLoading(true)
    Promise.all([getAdminUsers({ signal: ac.signal }), getAdminStats(ac.signal)])
      .then(([u, s]) => {
        if (ac.signal.aborted) return
        setUsers(u.items)
        setTotal(u.total)
        setStats(s)
        setError('')
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
  }
  useEffect(load, [])

  /** 追加下一页（评审 A6）：已在途时忽略重复点击；竞态守卫与 load() 同款。 */
  async function loadMore() {
    if (moreLoading || users.length >= total) return
    const ac = begin()
    setMoreLoading(true)
    try {
      const page = await getAdminUsers({ offset: users.length, signal: ac.signal })
      if (ac.signal.aborted) return
      setUsers((prev) => {
        /* 以 id 去重合并：load() 的刷新可能与「加载更多」交错 */
        const seen = new Set(prev.map((u) => u.id))
        return [...prev, ...page.items.filter((u) => !seen.has(u.id))]
      })
      setTotal(page.total)
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      if (!ac.signal.aborted) setMoreLoading(false)
    }
  }

  function toast(m: string) {
    setMsg(m)
    setTimeout(() => setMsg(''), 2500)
  }

  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const arr = users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false
      if (!kw) return true
      return u.username.toLowerCase().includes(kw) || (u.nickname ?? '').toLowerCase().includes(kw)
    })
    if (sort === 'activity') arr.sort((a, b) => tsOf(b.lastActivityAt) - tsOf(a.lastActivityAt))
    else if (sort === 'created') arr.sort((a, b) => tsOf(b.createdAt) - tsOf(a.createdAt))
    else
      arr.sort(
        (a, b) =>
          b.feedbackCount + b.courseCount + b.taskCount -
          (a.feedbackCount + a.courseCount + a.taskCount)
      )
    return arr
  }, [users, q, roleFilter, sort])

  async function handleCreate() {
    setError('')
    if (nu.username.trim().length < 3 || nu.password.length < PASSWORD_MIN) {
      setError(`用户名至少 3 字符，密码至少 ${PASSWORD_MIN} 位`)
      return
    }
    try {
      await createAdminUser({ username: nu.username.trim(), password: nu.password, role: nu.role })
      toast('已创建用户')
      setNu({ username: '', password: '', role: 'user' })
      setShowCreate(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    }
  }

  async function handleToggleRole(u: AdminUser) {
    const next: UserRole = u.role === 'admin' ? 'user' : 'admin'
    try {
      await updateAdminUser(u.id, { role: next })
      toast(next === 'admin' ? '已设为管理员' : '已取消管理员')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  async function handleResetPassword(u: AdminUser) {
    const p = window.prompt(`为「${u.username}」设置新密码（至少 ${PASSWORD_MIN} 位）`)
    if (!p) return
    if (p.length < PASSWORD_MIN) {
      setError(`密码至少 ${PASSWORD_MIN} 位`)
      return
    }
    try {
      await resetAdminUserPassword(u.id, p)
      toast('密码已重置')
    } catch (e) {
      setError(e instanceof Error ? e.message : '重置失败')
    }
  }

  async function handleDelete(u: AdminUser) {
    if (u.id === currentUser.id) {
      setError('不能删除当前登录的管理员账号')
      return
    }
    if (!window.confirm(`确定删除用户「${u.username}」吗？其课表与 DDL 将一并删除。`)) return
    try {
      await deleteAdminUser(u.id)
      toast('已删除用户')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  /** 正在查看课表的用户；null=弹窗关闭 */
  const [scheduleOf, setScheduleOf] = useState<AdminUserCourses | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleErr, setScheduleErr] = useState('')

  async function handleViewSchedule(u: AdminUser) {
    setScheduleErr('')
    setScheduleOpen(true)
    setScheduleOf(null)
    try {
      setScheduleOf(await getAdminUserCourses(u.id))
    } catch (e) {
      setScheduleErr(e instanceof Error ? e.message : '加载课表失败')
    }
  }

  /* ---------------- 活跃度详情 ---------------- */

  const [activityOpen, setActivityOpen] = useState(false)
  const [activity, setActivity] = useState<AdminUserActivity | null>(null)
  const [activityErr, setActivityErr] = useState('')
  /** 记录当前查看的是谁：弹窗标题在加载完成前也要能显示用户名 */
  const [activityTarget, setActivityTarget] = useState<AdminUser | null>(null)

  async function handleViewActivity(u: AdminUser) {
    setActivityErr('')
    setActivityOpen(true)
    setActivity(null)
    setActivityTarget(u)
    try {
      setActivity(await getAdminUserActivity(u.id))
    } catch (e) {
      setActivityErr(e instanceof Error ? e.message : '加载活跃度失败')
    }
  }

  return (
    <div>
      {onBack && (
        <button className="btn-back" onClick={onBack}>
          <IconChevronLeft size={18} />
          返回
        </button>
      )}

      {/* 后台分两个板块。用分段控件而不是底栏 tab：后台是低频入口，
          再往底栏加 tab 会把 4 个常用 tab 挤成 5 个。 */}
      <div className="admin-seg" role="tablist" aria-label="后台板块">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'users'}
          className={`admin-seg-item${section === 'users' ? ' active' : ''}`}
          onClick={() => setSection('users')}
        >
          用户管理
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'feedback'}
          className={`admin-seg-item${section === 'feedback' ? ' active' : ''}`}
          onClick={() => setSection('feedback')}
        >
          反馈管理
          {stats && stats.feedbackPending > 0 && <span className="admin-seg-badge">{stats.feedbackPending}</span>}
        </button>
      </div>

      {section === 'feedback' ? (
        <AdminFeedback />
      ) : (
        <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div className="page-title" style={{ margin: '14px 2px 0' }}>用户管理</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate((v) => !v)}>
            <IconPlus size={16} />
            新增用户
          </button>
        </div>
      </div>
      <p className="page-sub">
        共 {total} 个账号
        {users.length < total ? `（已显示 ${users.length}）` : ''}
        {stats ? ` · 7 日活跃 ${stats.active7d} · 管理员 ${stats.adminCount}` : ''} · 你当前为管理员
      </p>

      {/* 概览卡片：先给结论（现在有多少人、多少人在用），再看名单。
          比一上来就铺 90 行用户列表更容易判断"产品是否在被使用"。 */}
      {stats && (
        <div className="stat-grid">
          <div className="stat-card">
            <span className="stat-num">{stats.totalUsers}</span>
            <span className="stat-label">总用户</span>
            {/* 游客账号不计入总用户（清个缓存就多一个，算进来会让这个数字失去意义），
                但让人知道库里还有多少待回收的一次性账号 */}
            <span className="stat-sub">管理员 {stats.adminCount} · 游客 {stats.guestCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.active7d}</span>
            <span className="stat-label">7 日活跃</span>
            <span className="stat-sub">30 日 {stats.active30d}</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.newToday}</span>
            <span className="stat-label">今日新增</span>
            <span className="stat-sub">7 日 {stats.new7d}</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.feedbackPending}</span>
            <span className="stat-label">待处理反馈</span>
            <span className="stat-sub">共收到 {stats.feedbackCount} 条</span>
          </div>
        </div>
      )}

      {/* 筛选工具栏 */}
      <div className="admin-toolbar">
        <div className="admin-search">
          <IconSearch size={15} />
          <input
            className="admin-search-input"
            placeholder="搜索账号或昵称"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索用户"
          />
        </div>
        <div className="admin-filters">
          <select className="select admin-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as RoleFilter)} aria-label="按角色筛选">
            <option value="all">全部角色</option>
            <option value="admin">仅管理员</option>
            <option value="user">仅普通用户</option>
          </select>
          <select className="select admin-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序方式">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>按{SORT_LABEL[k]}</option>
            ))}
          </select>
        </div>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>新增用户</h2>
          <div className="field">
            <label>邮箱 / 学号</label>
            <input className="input" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="field">
              <label>密码</label>
              <input className="input" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            </div>
            <div className="field">
              <label>角色</label>
              <select className="select" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as UserRole })}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleCreate}>
            创建
          </button>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
      {msg && <div style={{ color: 'var(--accent-2)', fontSize: 13, marginBottom: 8 }}>{msg}</div>}
      {loading && <div className="card" style={{ color: 'var(--text-2)' }}>加载中…</div>}

      {!loading && visible.length === 0 && (
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>
          {users.length === 0 ? '还没有任何用户。' : '没有符合筛选条件的用户。'}
        </div>
      )}

      {!loading &&
        visible.map((u) => {
          const meta = LEVEL_META[u.level] ?? LEVEL_META.never
          return (
            <div key={u.id} className="task-item admin-row">
              <div className="task-main">
                <div className="task-title admin-account">
                  {u.username}
                  {u.id === currentUser.id && <span style={{ color: 'var(--accent-2)', fontSize: 12, marginLeft: 6 }}>（我）</span>}
                </div>
                <div className="task-meta">
                  <span className={`chip ${u.role === 'admin' ? 'active' : ''}`} style={{ padding: '2px 10px' }}>
                    {u.role === 'admin' ? '管理员' : '用户'}
                  </span>
                  <span className={`lvl-badge ${meta.cls}`} title={meta.hint}>{meta.label}</span>
                  <span className="admin-active-time">
                    {u.lastActivityAt ? `${fmtAgo(u.lastActivityAt)}活跃` : '从未活跃'}
                  </span>
                </div>
                <div className="task-meta admin-metrics">
                  <span>课 {u.courseCount}</span>
                  <span>DDL {u.taskCount}</span>
                  <span>反馈 {u.feedbackCount}</span>
                  {u.feedbackPending > 0 && <span className="admin-pending">待处理 {u.feedbackPending}</span>}
                </div>
              </div>
              <div className="admin-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void handleViewActivity(u)}>
                  活跃度
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void handleViewSchedule(u)}>
                  查看课表
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handleToggleRole(u)}>
                  {u.role === 'admin' ? '取消管理员' : '设为管理员'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handleResetPassword(u)}>
                  重置密码
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u)}>
                  删除
                </button>
              </div>
            </div>
          )
        })}

      {/* 评审 A6：还有更多账号时给一个「加载更多」 */}
      {!loading && users.length < total && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ margin: '4px auto 16px', display: 'block' }}
          onClick={() => void loadMore()}
          disabled={moreLoading}
        >
          {moreLoading ? '加载中…' : `加载更多（还剩 ${total - users.length} 个）`}
        </button>
      )}

      {/* 查看某个用户的课表：只读，按周一→周日分组 */}
      <Modal
        open={scheduleOpen}        title={scheduleOf ? `课表 · ${scheduleOf.user.nickname || scheduleOf.user.username}` : '课表'}
        onClose={() => {
          setScheduleOpen(false)
          setScheduleOf(null)
          setScheduleErr('')
        }}
      >
        {scheduleErr && <div className="form-error" style={{ marginBottom: 10 }}>{scheduleErr}</div>}
        {!scheduleOf && !scheduleErr && <div style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>}
        {scheduleOf && (
          <>
            <p style={{ margin: '0 0 10px', color: 'var(--text-3)', fontSize: 12, lineHeight: 1.6 }}>
              账号 {scheduleOf.user.username} · 共 {scheduleOf.courses.length} 条上课安排（只读，不可编辑）
            </p>
            {scheduleOf.courses.length === 0 ? (
              <div style={{ color: 'var(--text-2)', fontSize: 13 }}>这个用户还没有导入任何课程。</div>
            ) : (
              [1, 2, 3, 4, 5, 6, 7].map((d) => {
                const list = scheduleOf.courses.filter((c) => c.dayOfWeek === d)
                if (list.length === 0) return null
                return (
                  <div key={d} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)', margin: '0 2px 6px' }}>
                      {weekdayCN(d)}
                    </div>
                    <div className="card" style={{ padding: '6px 12px' }}>
                      {list.map((c) => (
                        <div key={c.id} className="course-row">
                          <span className="bar" style={{ background: c.color }} />
                          <div className="cr-main">
                            <div className="cr-name">{c.name}</div>
                            <div className="cr-loc">
                              {c.location || '未填地点'}
                              {c.teacher ? ` · ${c.teacher}` : ''} · {weekRangeText(c)}
                            </div>
                          </div>
                          <span className="cr-time">
                            {c.startPeriod}-{c.endPeriod} 节
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })
            )}
          </>
        )}
      </Modal>

      {/* 用户活跃度详情 */}
      <Modal
        open={activityOpen}
        title={`活跃度 · ${activityTarget?.nickname || activityTarget?.username || ''}`}
        onClose={() => {
          setActivityOpen(false)
          setActivity(null)
          setActivityTarget(null)
          setActivityErr('')
        }}
      >
        {activityErr && <div className="form-error" style={{ marginBottom: 10 }}>{activityErr}</div>}
        {!activity && !activityErr && <div style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>}
        {activity && (
          <>
            <div className="stat-grid stat-grid-sm">
              <div className="stat-card">
                <span className="stat-num">{activity.counts.feedbacks}</span>
                <span className="stat-label">反馈</span>
              </div>
              <div className="stat-card">
                <span className="stat-num">{activity.counts.feedbackPending}</span>
                <span className="stat-label">待处理</span>
              </div>
              <div className="stat-card">
                <span className="stat-num">{activity.counts.courses}</span>
                <span className="stat-label">课程</span>
              </div>
              <div className="stat-card">
                <span className="stat-num">{activity.counts.tasks}</span>
                <span className="stat-label">DDL</span>
              </div>
            </div>

            <div className="activity-rows">
              <div className="activity-row">
                <span className="activity-k">活跃度</span>
                <span className={`lvl-badge ${LEVEL_META[activity.level].cls}`}>{LEVEL_META[activity.level].label}</span>
              </div>
              <div className="activity-row">
                <span className="activity-k">最后活跃</span>
                <span className="activity-v">
                  {activity.lastActivityAt ? `${fmtDateTimeCN(activity.lastActivityAt)}（${fmtAgo(activity.lastActivityAt)}）` : '从未活跃'}
                </span>
              </div>
              <div className="activity-row">
                <span className="activity-k">最后访问</span>
                <span className="activity-v">{fmtDateTimeCN(activity.user.lastSeenAt)}</span>
              </div>
              <div className="activity-row">
                <span className="activity-k">注册时间</span>
                <span className="activity-v">{fmtDateTimeCN(activity.user.createdAt)}</span>
              </div>
            </div>

            <div className="activity-section-title">最近动态</div>
            {activity.recent.length === 0 ? (
              <div style={{ color: 'var(--text-2)', fontSize: 13 }}>这个用户还没有提交过反馈。</div>
            ) : (
              <div className="activity-recent">
                {activity.recent.map((r) => (
                  <div key={`${r.kind}-${r.id}`} className="activity-item">
                    <span className="activity-kind kind-post">反馈</span>
                    <div className="activity-item-main">
                      <div className="activity-item-text">{r.text}</div>
                      <div className="activity-item-meta">
                        {FEEDBACK_TYPE_LABEL[r.feedbackType]} · {FEEDBACK_STATUS_LABEL[r.status]} · {fmtAgo(r.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>
        </>
      )}
    </div>
  )
}
