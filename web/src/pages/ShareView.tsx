/**
 * 空闲课表（设计稿图5 列表页 + 图1 群组详情页）。
 *
 * 定位：**找到大家都有空的时间，不共享具体课程内容**。
 * 这条不是营销文案，而是本页最重要的设计约束 —— 群组形态下服务端根本不下发课名/教室/教师
 * （见 server/src/share.ts 文件头的隐私边界），所以这里能画出来的只有"谁在这格有空"。
 *
 * 为什么入口在「我的」页而不是底栏加第 5 个 tab：
 *   底栏的四个 tab 是"每天都要用"的功能（本周/课表/DDL/我的）。空闲课表是**低频、协作型**功能
 *   —— 一学期可能只用几次（约小组作业、约饭、约自习）。为它挤掉一个常用 tab 不划算，
 *   而放在「我的」页与「情侣课表」并列，正好归到同一类"关系与协作"里，语义也顺。
 *
 * 子页（列表 / 详情）在本组件内部切换，不提升到 App —— 理由同 ProfileView：
 * 它们是这一块功能的内部导航，提上去只会让 App 多出两个互斥状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShareDetail, ShareGroupSummary, ShareMemberView, WeekOption } from '../types'
import {
  createShareGroup, disbandShareGroup, getShareDetail, joinShareGroup, leaveShareGroup,
  listShareGroups, removeShareMember, rotateShareSecret, syncShareGroup, updateShareGroup
} from '../api'
import { useBackStep } from '../lib/back'
import { addDays, parseISODate, toISODate, weekdayCN } from '../lib/date'
import { MAX_GROUPS_PER_USER } from '../constants'
import { isAbortError, useAbortController } from '../lib/useAbortController'
import { saveBlob, type SaveResult } from '../lib/saveFile'
import Modal from './../components/Modal'
import { IconBolt, IconChevronLeft, IconChevronRight, IconPlus } from '../icons'

interface ShareViewProps {
  onBack: () => void
  onToast: (msg: string) => void
  /** 需要登录的入口（游客由 App 统一引导）；返回 false 表示已弹登录层，调用方应立即返回 */
  onRequireLogin?: () => boolean
}

type Sub = { kind: 'list' } | { kind: 'detail'; id: number }

/** 群组在列表里用的首字图标（图5：研究生 → 研、实验室小组 → 实） */
function initialOf(name: string): string {
  return [...name.trim()][0] ?? '组'
}

/** 成员色块：把一个人的忙闲状态画成一个小方块 */
function MemberDots({ members, max = 4 }: { members: ShareMemberView[]; max?: number }) {
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  return (
    <span className="sm-dots">
      {shown.map((m) => (
        <span key={m.id} className="sm-dot" style={{ background: m.color }} title={m.nickname} />
      ))}
      {rest > 0 && <span className="sm-dot-more">+{rest}</span>}
    </span>
  )
}

/** 判断某成员在某周某天某节是否被占用 */
function isBusy(m: ShareMemberView, week: number, weekday: number, period: number): boolean {
  const ranges = m.busy[String(week)]?.[String(weekday)]
  if (!ranges || ranges.length === 0) return false
  return ranges.some(([s, e]) => period >= s && period <= e)
}

/** 参与统计的成员：已同步、且学期与我的当前学期一致（跨学期比较会得出错误结论） */
function countableMembers(detail: ShareDetail): ShareMemberView[] {
  return detail.members.filter((m) => m.synced && m.sameTerm)
}

/** 找"今天"落在哪个周次项上（图1 默认展示当前周） */
function currentWeekOption(options: WeekOption[]): WeekOption | null {
  const today = toISODate(new Date())
  const hit = options.find((o) => o.week !== null && today >= o.beginDate && today <= o.endDate)
  if (hit) return hit
  // 假期/开学前：退回第一个教学周，保证页面永远有内容可看
  return options.find((o) => o.week !== null) ?? null
}

/** 导出为 CSV（Excel 可直接双击打开）。加 BOM 否则中文在 Excel 里是乱码 */
async function downloadCsv(filename: string, rows: string[][]): Promise<SaveResult> {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const text = rows.map((r) => r.map(escape).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' })
  /* ⚠️ 走 saveBlob：Android WebView 里 <a download> 点了没反应（详见 lib/saveFile.ts） */
  return saveBlob(blob, filename)
}

export default function ShareView({ onBack, onToast, onRequireLogin }: ShareViewProps) {
  const [sub, setSub] = useState<Sub>({ kind: 'list' })
  const [groups, setGroups] = useState<ShareGroupSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  /** 创建 / 加入弹层 */
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [secretDraft, setSecretDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogErr, setDialogErr] = useState('')

  useBackStep(sub.kind === 'detail', () => setSub({ kind: 'list' }))

  const reload = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const r = await listShareGroups()
        setGroups(r.groups)
        setErr('')
      } catch (e) {
        setErr(e instanceof Error ? e.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    void reload()
  }, [reload])

  async function doCreate() {
    const name = nameDraft.trim()
    if (!name) {
      setDialogErr('请给群组起个名字')
      return
    }
    if (onRequireLogin && !onRequireLogin()) return
    setBusy(true)
    setDialogErr('')
    try {
      const r = await createShareGroup({ name })
      setCreateOpen(false)
      setNameDraft('')
      onToast('群组已创建，把密钥发给同学即可加入')
      await reload(true)
      setSub({ kind: 'detail', id: r.group.id })
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function doJoin() {
    const secret = secretDraft.trim().toUpperCase()
    if (secret.length < 4) {
      setDialogErr('请输入完整的群组密钥')
      return
    }
    if (onRequireLogin && !onRequireLogin()) return
    setBusy(true)
    setDialogErr('')
    try {
      const r = await joinShareGroup(secret)
      setJoinOpen(false)
      setSecretDraft('')
      onToast('已加入群组，记得同步课表')
      await reload(true)
      setSub({ kind: 'detail', id: r.id })
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : '加入失败')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 列表页（图5） ---------------- */
  if (sub.kind === 'list') {
    const atLimit = groups.length >= MAX_GROUPS_PER_USER
    return (
      <div className="share-page">
        <div className="subpage-head">
          <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
            <IconChevronLeft size={22} />
          </button>
          <h3>空闲课表</h3>
        </div>

        <div className="share-hero">
          <div className="share-hero-text">
            <div className="share-hero-kicker">多人时间协作</div>
            <div className="share-hero-title">空闲课表</div>
            <div className="share-hero-sub">找到大家都有空的时间，不共享具体课程内容</div>
          </div>
          <div className="share-hero-art" aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>

        <div className="share-cta">
          <button
            type="button"
            className="share-cta-btn primary"
            onClick={() => {
              setDialogErr('')
              setCreateOpen(true)
            }}
          >
            <IconPlus size={20} />
            <span className="share-cta-main">
              <strong>创建群组</strong>
              <em>生成新的群组密钥</em>
            </span>
          </button>
          <button
            type="button"
            className="share-cta-btn"
            onClick={() => {
              setDialogErr('')
              setJoinOpen(true)
            }}
          >
            <IconBolt size={20} />
            <span className="share-cta-main">
              <strong>加入群组</strong>
              <em>输入好友分享的密钥</em>
            </span>
          </button>
        </div>

        <div className="share-section-head">
          <span className="share-section-title">我的群组</span>
          <span className="share-section-sub">
            {atLimit ? `已达上限 ${MAX_GROUPS_PER_USER} 个` : `最多可加入 ${MAX_GROUPS_PER_USER} 个`}
          </span>
          <span className="share-section-count">{groups.length}</span>
        </div>

        {loading && <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>}
        {!loading && err && (
          <div className="card">
            <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>
            <button className="btn btn-soft btn-sm" style={{ marginTop: 10 }} onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}
        {!loading && !err && groups.length === 0 && (
          <div className="card" style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
            还没有群组。创建一个，把密钥发给同学，大家各自同步课表后就能看到共同空闲时间。
          </div>
        )}

        {groups.map((g) => {
          const ratio = g.memberCount > 0 ? g.syncedCount / g.memberCount : 0
          return (
            <button
              key={g.id}
              type="button"
              className="share-group-card"
              onClick={() => setSub({ kind: 'detail', id: g.id })}
            >
              <span className="sgc-icon">{initialOf(g.name)}</span>
              <span className="sgc-main">
                <span className="sgc-title">
                  {g.name}
                  {g.isOwner && <span className="sgc-tag">群主</span>}
                </span>
                <span className="sgc-sub">
                  {g.memberCount} 位成员 · {g.syncedCount} 人已同步
                  {g.mySyncedAt == null && ' · 我还没同步'}
                </span>
                <span className="sgc-bar">
                  <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                </span>
              </span>
              <IconChevronRight size={18} />
            </button>
          )
        })}

        {/* 创建 */}
        <Modal
          open={createOpen}
          title="创建群组"
          onClose={() => {
            if (busy) return
            setCreateOpen(false)
          }}
          footer={
            <>
              <button className="btn btn-ghost" type="button" onClick={() => setCreateOpen(false)} disabled={busy}>
                取消
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void doCreate()} disabled={busy}>
                {busy ? '创建中…' : '创建'}
              </button>
            </>
          }
        >
          {dialogErr && <div className="form-error" style={{ marginBottom: 10 }}>{dialogErr}</div>}
          <div className="field-label">群组名称</div>
          <input
            className="input"
            value={nameDraft}
            maxLength={20}
            placeholder="如：实验室小组"
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <p className="sheet-lead" style={{ marginTop: 10 }}>
            创建后会生成一串 6 位密钥，同学用它加入即可；组内只会看到彼此的空闲时间，看不到具体课程。
          </p>
        </Modal>

        {/* 加入 */}
        <Modal
          open={joinOpen}
          title="加入群组"
          onClose={() => {
            if (busy) return
            setJoinOpen(false)
          }}
          footer={
            <>
              <button className="btn btn-ghost" type="button" onClick={() => setJoinOpen(false)} disabled={busy}>
                取消
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void doJoin()} disabled={busy}>
                {busy ? '加入中…' : '加入'}
              </button>
            </>
          }
        >
          {dialogErr && <div className="form-error" style={{ marginBottom: 10 }}>{dialogErr}</div>}
          <div className="field-label">群组密钥</div>
          <input
            className="input"
            value={secretDraft}
            maxLength={12}
            placeholder="6 位字母数字"
            autoCapitalize="characters"
            onChange={(e) => setSecretDraft(e.target.value.toUpperCase())}
          />
          <p className="sheet-lead" style={{ marginTop: 10 }}>密钥由群主分享给你，不区分大小写。</p>
        </Modal>
      </div>
    )
  }

  /* ---------------- 详情页（图1） ---------------- */
  return (
    <ShareDetailPage
      id={sub.id}
      onBack={() => {
        setSub({ kind: 'list' })
        void reload(true)
      }}
      onToast={onToast}
      onLeft={() => {
        setSub({ kind: 'list' })
        void reload(true)
      }}
    />
  )
}

interface DetailProps {
  id: number
  onBack: () => void
  onLeft: () => void
  onToast: (msg: string) => void
}

function ShareDetailPage({ id, onBack, onLeft, onToast }: DetailProps) {
  const [detail, setDetail] = useState<ShareDetail | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [week, setWeek] = useState<number | null>(null)
  const [threshold, setThreshold] = useState(0)
  const [manageOpen, setManageOpen] = useState(false)
  const [rosterOpen, setRosterOpen] = useState<{ weekday: number; period: number } | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [manageErr, setManageErr] = useState('')
  /** 门槛保存的防抖句柄：滑块拖动会连续触发，不能每动一下就发一个请求 */
  const thresholdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 详情请求的竞态闸。
   *
   * ⚠️ 为什么必须有：`load` 被 `silent` 刷新、改门槛/名称后的重拉、切群组时的新 id 反复触发。
   *    没有取消时，「先发的请求后返回」会把**另一个群组**的成员、密钥、忙闲表写进当前页面 ——
   *    这已经不是"数据旧了"，而是把 A 组的隐私快照显示在 B 组的界面里。
   *    begin() 会在每次新请求前取消上一次，下面每个 setState 前都判 aborted。
   */
  const beginDetail = useAbortController()

  const load = useCallback(
    async (silent = false) => {
      const ac = beginDetail()
      try {
        const d = await getShareDetail(id, ac.signal)
        if (ac.signal.aborted) return
        setDetail(d)
        setThreshold((prev) => (prev === 0 ? d.group.threshold : prev))
        setNameDraft((prev) => prev || d.group.name)
        setErr('')
      } catch (e) {
        /* 被取消不是失败：不要弹「加载失败」 */
        if (ac.signal.aborted || isAbortError(e)) return
        if (!silent) setErr(e instanceof Error ? e.message : '加载失败')
      }
    },
    [id, beginDetail]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () => () => {
      if (thresholdTimer.current) clearTimeout(thresholdTimer.current)
    },
    []
  )

  /* 默认定位到"今天"所在的周次项 */
  const options = detail?.weekOptions ?? []
  const defaultWeek = useMemo(() => currentWeekOption(options), [options])
  useEffect(() => {
    if (week === null && defaultWeek?.week != null) setWeek(defaultWeek.week)
  }, [defaultWeek, week])

  const activeWeek = week ?? defaultWeek?.week ?? 1
  const pickIdx = options.findIndex((o) => o.week === activeWeek)
  const countable = detail ? countableMembers(detail) : []
  const effectiveThreshold = threshold <= 0 ? countable.length : Math.min(threshold, Math.max(1, countable.length))

  /** 节次行：优先用设置里的节次表；为空时按成员忙闲的最大节次兜底 */
  const rows = useMemo(() => {
    if (!detail) return [] as { index: number; start: string }[]
    if (detail.periods.length > 0) return detail.periods.map((p) => ({ index: p.index, start: p.start }))
    let max = 0
    for (const m of detail.members) {
      const dayMap = m.busy[String(activeWeek)] ?? {}
      for (const k of Object.keys(dayMap)) {
        for (const [, e] of dayMap[k]) if (e > max) max = e
      }
    }
    return Array.from({ length: Math.max(1, max) }, (_, i) => ({ index: i + 1, start: '' }))
  }, [detail, activeWeek])

  /** 某个格子里的空闲成员 */
  function freeMembersAt(weekday: number, period: number): ShareMemberView[] {
    return countable.filter((m) => !isBusy(m, activeWeek, weekday, period))
  }

  async function doSync() {
    if (busy) return
    setBusy(true)
    try {
      await syncShareGroup(id)
      onToast('已同步我的课表')
      await load(true)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '同步失败')
    } finally {
      setBusy(false)
    }
  }

  function changeThreshold(v: number) {
    setThreshold(v)
    if (thresholdTimer.current) clearTimeout(thresholdTimer.current)
    thresholdTimer.current = setTimeout(() => {
      /* 门槛是群级设置，只有群主能改；成员拖动只影响自己这次的查看 */
      if (!detail?.group.isOwner) return
      void updateShareGroup(id, { threshold: v }).catch(() => {})
    }, 700)
  }

  async function copySecret() {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.group.secret)
      onToast('密钥已复制')
    } catch {
      onToast('复制失败，请长按密钥手动复制')
    }
  }

  async function shareSecret() {
    if (!detail) return
    const text = `加入「${detail.group.name}」的空闲课表，密钥：${detail.group.secret}`
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> }
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: '空闲课表', text })
        return
      } catch {
        /* 用户取消或环境不支持 → 退回复制 */
      }
    }
    try {
      await navigator.clipboard.writeText(text)
      onToast('已复制邀请文案')
    } catch {
      onToast('分享失败，请手动复制密钥')
    }
  }

  async function exportExcel() {
    if (!detail) return
    const opt = options.find((o) => o.week === activeWeek)
    const head = ['时段', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const body = rows.map((r) => {
      const cells = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
        const free = freeMembersAt(wd, r.index)
        if (free.length < effectiveThreshold || free.length === 0) return ''
        return `${free.length} 人（${free.map((m) => m.nickname).join('、')}）`
      })
      return [`第 ${r.index} 节${r.start ? ` ${r.start}` : ''}`, ...cells]
    })
    const meta = [
      [`${detail.group.name} · 空闲课表`],
      [`${detail.semester.termName}${opt?.week != null ? ` 第 ${opt.week} 周` : ''} ${opt ? `${opt.beginDate} ~ ${opt.endDate}` : ''}`],
      [`至少 ${effectiveThreshold} 人空闲 · 共 ${countable.length} 人已同步`],
      []
    ]
    const r = await downloadCsv(`${detail.group.name}-空闲课表.csv`, [...meta, head, ...body])
    onToast(r.ok ? '已导出，Excel 可直接打开' : r.message)
  }

  if (err) {
    return (
      <div className="share-page">
        <div className="subpage-head">
          <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
            <IconChevronLeft size={22} />
          </button>
          <h3>群组空闲课表</h3>
        </div>
        <div className="card">
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>
          <button className="btn btn-soft btn-sm" style={{ marginTop: 10 }} onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="share-page">
        <div className="subpage-head">
          <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
            <IconChevronLeft size={22} />
          </button>
          <h3>群组空闲课表</h3>
        </div>
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>
      </div>
    )
  }

  const stale = detail.members.filter((m) => m.synced && !m.sameTerm)
  const notSynced = detail.members.filter((m) => !m.synced)

  return (
    <div className="share-page">
      <div className="subpage-head">
        <button type="button" className="btn-back" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={22} />
        </button>
        <h3>群组空闲课表</h3>
      </div>

      {/* 群组信息卡 */}
      <div className="share-info-card">
        <div className="sic-head">
          <div>
            <div className="sic-kicker">空闲课表群组</div>
            <div className="sic-title">{detail.group.name}</div>
          </div>
          <button type="button" className="sic-manage" onClick={() => { setManageErr(''); setManageOpen(true) }}>
            管理
          </button>
        </div>

        <div className="sic-stats">
          <div className="sic-stat">
            <strong>{detail.group.memberCount}</strong>
            <span>成员</span>
          </div>
          <div className="sic-stat">
            <strong>{detail.group.syncedCount}</strong>
            <span>已同步</span>
          </div>
          <div className="sic-stat">
            <strong>{effectiveThreshold}</strong>
            <span>人数门槛</span>
          </div>
        </div>

        <div className="sic-secret">
          <div className="sic-secret-main">
            <span className="sic-secret-label">群组密钥</span>
            <span className="sic-secret-val">{detail.group.secret}</span>
          </div>
          <div className="sic-secret-actions">
            <button type="button" className="btn btn-soft btn-sm" onClick={() => void copySecret()}>
              复制
            </button>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => void shareSecret()}>
              分享
            </button>
          </div>
        </div>
      </div>

      {/* 我还没同步 / 有人学期不一致 的提醒：这两件事都会让下面的网格"看起来不对" */}
      {detail.group.mySyncedAt == null && (
        <div className="card" style={{ background: 'var(--warn-soft)', marginBottom: 10 }}>
          <div style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13.5 }}>你还没有同步课表</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 4, lineHeight: 1.6 }}>
            同步后组内才会把你的空闲时间算进去。
          </div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => void doSync()} disabled={busy}>
            {busy ? '同步中…' : '同步我的课表'}
          </button>
        </div>
      )}
      {stale.length > 0 && (
        <div className="card" style={{ background: 'var(--warn-soft)', marginBottom: 10 }}>
          <div style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13.5 }}>
            {stale.map((m) => m.nickname).join('、')} 的课表不是当前学期
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 4, lineHeight: 1.6 }}>
            他们同步的是「{stale[0].termName}」，与你的「{detail.semester.termName}」对不上，
            已从共同空闲里排除，避免算出一个不存在的时间。
          </div>
        </div>
      )}
      {notSynced.length > 0 && (
        <div className="card" style={{ marginBottom: 10, color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.6 }}>
          还有 {notSynced.length} 位成员没同步课表（{notSynced.map((m) => m.nickname).join('、')}），
          当前结果只基于已同步的 {countable.length} 人。
        </div>
      )}

      {/* 周次 + 导出 */}
      <div className="share-week-card">
        <div className="swc-row">
          <button
            type="button"
            className="swc-nav"
            aria-label="上一周"
            disabled={pickIdx <= 0}
            onClick={() => setWeek(options[pickIdx - 1]?.week ?? activeWeek)}
          >
            ‹
          </button>
          <div className="swc-center">
            <div className="swc-title">{activeWeek > 0 ? `第 ${activeWeek} 周` : '放假周'}</div>
            <div className="swc-sub">
              {(() => {
                const o = options.find((x) => x.week === activeWeek)
                return o ? `${o.beginDate.slice(5).replace('-', '.')} — ${o.endDate.slice(5).replace('-', '.')}` : detail.semester.termName
              })()}
            </div>
          </div>
          <button
            type="button"
            className="swc-nav"
            aria-label="下一周"
            disabled={pickIdx < 0 || pickIdx >= options.length - 1}
            onClick={() => setWeek(options[pickIdx + 1]?.week ?? activeWeek)}
          >
            ›
          </button>
        </div>
        <button type="button" className="btn btn-soft btn-sm swc-export" onClick={() => void exportExcel()}>
          导出 Excel
        </button>
      </div>

      {/* 人数门槛滑块 */}
      <div className="share-threshold">
        <div className="st-head">
          <span className="st-title">至少 {effectiveThreshold} 人空闲</span>
          <span className="st-sub">
            {threshold <= 0 ? '默认查看全部已同步成员共同空闲' : `共 ${countable.length} 人已同步`}
          </span>
        </div>
        <input
          type="range"
          className="st-range"
          min={0}
          max={Math.max(1, countable.length)}
          step={1}
          value={threshold}
          disabled={countable.length === 0}
          onChange={(e) => changeThreshold(Number(e.target.value))}
          aria-label="共同空闲的人数门槛"
        />
      </div>

      <div className="share-hint">点击空闲格子查看完整名单</div>

      {/* 共同空闲网格 */}
      {countable.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          还没有人同步课表。点上方「同步我的课表」，或把密钥发给同学，等大家同步后这里就会显示共同空闲时间。
        </div>
      ) : (
        <div className="share-grid-scroll">
          <div className="share-grid">
            <div className="sg-head">时段</div>
            {[1, 2, 3, 4, 5, 6, 7].map((wd) => {
              const o = options.find((x) => x.week === activeWeek)
              const dayDate = o ? dayDateOf(o.beginDate, wd) : ''
              const isToday = dayDate === toISODate(new Date())
              return (
                <div key={wd} className={`sg-head${isToday ? ' today' : ''}`}>
                  <span>{weekdayCN(wd)}</span>
                  <em>{dayDate ? dayDate.slice(5).replace('-', '.') : ''}</em>
                </div>
              )
            })}

            {rows.map((r) => (
              <FragmentRow
                key={r.index}
                row={r}
                activeWeek={activeWeek}
                effectiveThreshold={effectiveThreshold}
                freeMembersAt={freeMembersAt}
                onPick={(weekday) => setRosterOpen({ weekday, period: r.index })}
              />
            ))}
          </div>
        </div>
      )}

      {/* 名单弹层 */}
      <Modal
        open={!!rosterOpen}
        title="这段时间谁有空"
        onClose={() => setRosterOpen(null)}
      >
        {rosterOpen && (
          <RosterBody
            weekday={rosterOpen.weekday}
            period={rosterOpen.period}
            activeWeek={activeWeek}
            free={freeMembersAt(rosterOpen.weekday, rosterOpen.period)}
            busy={countable.filter((m) => isBusy(m, activeWeek, rosterOpen.weekday, rosterOpen.period))}
          />
        )}
      </Modal>

      {/* 管理弹层 */}
      <Modal
        open={manageOpen}
        title="群组管理"
        onClose={() => {
          if (busy) return
          setManageOpen(false)
        }}
      >
        {manageErr && <div className="form-error" style={{ marginBottom: 10 }}>{manageErr}</div>}

        <div className="field-label">群组名称</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={nameDraft}
            maxLength={20}
            disabled={!detail.group.isOwner}
            onChange={(e) => setNameDraft(e.target.value)}
          />
          {detail.group.isOwner && (
            <button
              className="btn btn-soft"
              type="button"
              disabled={busy || nameDraft.trim() === detail.group.name || !nameDraft.trim()}
              onClick={async () => {
                setBusy(true)
                setManageErr('')
                try {
                  await updateShareGroup(id, { name: nameDraft.trim() })
                  onToast('已保存')
                  await load(true)
                } catch (e) {
                  setManageErr(e instanceof Error ? e.message : '保存失败')
                } finally {
                  setBusy(false)
                }
              }}
            >
              保存
            </button>
          )}
        </div>

        <div className="field-label" style={{ marginTop: 16 }}>成员（{detail.members.length}）</div>
        <div className="share-member-list">
          {detail.members.map((m) => (
            <div key={m.id} className="share-member-row">
              {m.avatar ? (
                <img className="sm-avatar" src={m.avatar} alt={m.nickname} />
              ) : (
                <span className="sm-avatar-fallback" style={{ background: m.color }}>
                  {[...m.nickname][0] ?? '同'}
                </span>
              )}
              <span className="sm-name">
                {m.nickname}
                {m.isMe && '（我）'}
                {m.isOwner && <span className="sgc-tag">群主</span>}
              </span>
              <span className="sm-state">{m.synced ? '已同步' : '未同步'}</span>
              {(detail.group.isOwner || m.isMe) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    const label = m.isMe ? (m.isOwner ? '解散群组' : '退出群组') : `移除 ${m.nickname}`
                    if (!window.confirm(m.isOwner ? `确定${label}吗？解散后所有成员都会失去这个群组。` : `确定${label}吗？`)) return
                    setBusy(true)
                    setManageErr('')
                    try {
                      const r = await removeShareMember(id, m.id)
                      onToast(r.disbanded ? '群组已解散' : m.isMe ? '已退出群组' : '已移除成员')
                      setManageOpen(false)
                      if (r.disbanded || m.isMe) onLeft()
                      else await load(true)
                    } catch (e) {
                      setManageErr(e instanceof Error ? e.message : '操作失败')
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {m.isMe ? (m.isOwner ? '解散' : '退出') : '移除'}
                </button>
              )}
            </div>
          ))}
        </div>

        {detail.group.isOwner && (
          <>
            <div className="field-label" style={{ marginTop: 16 }}>密钥</div>
            <div className="share-secret-row">
              <span className="share-secret-val">{detail.group.secret}</span>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm('重置后旧密钥立即失效，已经加入的成员不受影响。确定重置吗？')) return
                  setBusy(true)
                  setManageErr('')
                  try {
                    await rotateShareSecret(id)
                    onToast('已生成新密钥')
                    await load(true)
                  } catch (e) {
                    setManageErr(e instanceof Error ? e.message : '重置失败')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                重置密钥
              </button>
            </div>
          </>
        )}

        {/* 非群主的退出入口放在最下面，与"解散"分开表述 —— 后果完全不同 */}
        {!detail.group.isOwner && (
          <button
            className="btn btn-danger btn-block"
            type="button"
            style={{ marginTop: 16 }}
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`确定退出「${detail.group.name}」吗？退出后需要重新用密钥加入。`)) return
              setBusy(true)
              try {
                await leaveShareGroup(id)
                onToast('已退出群组')
                onLeft()
              } catch (e) {
                setManageErr(e instanceof Error ? e.message : '退出失败')
              } finally {
                setBusy(false)
              }
            }}
          >
            退出群组
          </button>
        )}

        {detail.group.isOwner && (
          <button
            className="btn btn-danger btn-block"
            type="button"
            style={{ marginTop: 16 }}
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('解散后所有成员都会失去这个群组，且无法恢复。确定解散吗？')) return
              setBusy(true)
              try {
                await disbandShareGroup(id)
                onToast('群组已解散')
                onLeft()
              } catch (e) {
                setManageErr(e instanceof Error ? e.message : '解散失败')
              } finally {
                setBusy(false)
              }
            }}
          >
            解散群组
          </button>
        )}
      </Modal>
    </div>
  )
}

/** 网格的一行（一个节次）：左侧时段 + 7 天格子。
 *  activeWeek 保留在 props 类型里（调用方仍传），当前行渲染用不到。 */
function FragmentRow({
  row,
  effectiveThreshold,
  freeMembersAt,
  onPick
}: {
  row: { index: number; start: string }
  activeWeek: number
  effectiveThreshold: number
  freeMembersAt: (weekday: number, period: number) => ShareMemberView[]
  onPick: (weekday: number) => void
}) {
  return (
    <>
      <div className="sg-axis">
        <span className="sg-axis-p">{row.index}</span>
        {row.start && <span className="sg-axis-t">{row.start}</span>}
      </div>
      {[1, 2, 3, 4, 5, 6, 7].map((wd) => {
        const free = freeMembersAt(wd, row.index)
        const hit = free.length > 0 && free.length >= effectiveThreshold
        return (
          <button
            key={wd}
            type="button"
            className={`sg-cell${hit ? ' free' : ''}`}
            onClick={() => hit && onPick(wd)}
            disabled={!hit}
            aria-label={hit ? `${weekdayCN(wd)} 第 ${row.index} 节 ${free.length} 人空闲` : '无共同空闲'}
          >
            {hit && (
              <>
                <span className="sg-cell-num">{free.length}人</span>
                <MemberDots members={free} max={3} />
              </>
            )}
          </button>
        )
      })}
    </>
  )
}

function RosterBody({
  weekday,
  period,
  activeWeek,
  free,
  busy
}: {
  weekday: number
  period: number
  activeWeek: number
  free: ShareMemberView[]
  busy: ShareMemberView[]
}) {
  return (
    <div>
      <p className="sheet-lead">
        第 {activeWeek} 周 · {weekdayCN(weekday)} · 第 {period} 节
      </p>
      <div className="field-label">有空（{free.length}）</div>
      <div className="share-member-list">
        {free.map((m) => (
          <div key={m.id} className="share-member-row">
            <span className="sm-avatar-fallback" style={{ background: m.color }}>
              {[...m.nickname][0] ?? '同'}
            </span>
            <span className="sm-name">{m.nickname}{m.isMe && '（我）'}</span>
          </div>
        ))}
        {free.length === 0 && <div className="sheet-lead">这一节没有人有空</div>}
      </div>
      {busy.length > 0 && (
        <>
          <div className="field-label" style={{ marginTop: 14 }}>有课（{busy.length}）</div>
          <div className="share-member-list">
            {busy.map((m) => (
              <div key={m.id} className="share-member-row muted">
                <span className="sm-avatar-fallback" style={{ background: 'var(--bg-3)', color: 'var(--text-3)' }}>
                  {[...m.nickname][0] ?? '同'}
                </span>
                <span className="sm-name">{m.nickname}{m.isMe && '（我）'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 由某周周一推出第 n 天（1..7）的日期 */
function dayDateOf(weekStart: string, weekday: number): string {
  if (!weekStart) return ''
  return toISODate(addDays(parseISODate(weekStart), weekday - 1))
}
