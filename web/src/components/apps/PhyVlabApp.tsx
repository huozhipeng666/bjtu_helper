/**
 * 物理在线作业 —— phyvlab.bjtu.edu.cn（Moodle）的课程作业列表。
 *
 * 与 CITEL 一样是独立账号的 Moodle 站，但页面结构不同（这里是
 * /my/courses.php 卡片 + course/view.php 的 li.activity）， upstream KMP
 * 项目里两个入口也是分开的。提交状态要点开单个作业才拉得到
 * （/mod/assign/view.php 的提交状态表），所以详情按需加载，不进快照。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from './AppShell'
import AppState from './AppState'
import PlatformAccountGate from './PlatformAccountGate'
import { AppEntryHostProps } from './types'
import {
  getPhyVlabAssignmentDetail, getPhyVlabSnapshot,
  type PhyVlabActivity, type PhyVlabAssignmentDetail, type PhyVlabSnapshot
} from '../../api'
import { IconRefresh } from '../../icons'

type Filter = 'all' | 'pending' | 'done'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待完成' },
  { key: 'done', label: '已完成' }
]

export default function PhyVlabApp({ onBack }: AppEntryHostProps) {
  const [tick, setTick] = useState(0)
  return (
    <AppShell
      title="物理在线作业"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" aria-label="刷新" onClick={() => setTick((t) => t + 1)}>
          <IconRefresh />
        </button>
      }
    >
      <PlatformAccountGate
        platform="phyvlab"
        lead="物理在线（phyvlab.bjtu.edu.cn）是独立的 Moodle 站点，账号与教务系统不通用，需要单独绑定一次。"
      >
        <PhyVlabBody key={tick} />
      </PlatformAccountGate>
    </AppShell>
  )
}

function PhyVlabBody() {
  const [snap, setSnap] = useState<PhyVlabSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError('')
    try {
      const r = await getPhyVlabSnapshot(force)
      setSnap(r.data)
    } catch (err) {
      setSnap(null)
      setError(err instanceof Error ? err.message : '物理在线数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const groups = useMemo(() => {
    const acts = (snap?.activities ?? []).filter((a) =>
      filter === 'all' ? true : filter === 'done' ? a.completed : !a.completed
    )
    const byCourse = new Map<number, { name: string; acts: PhyVlabActivity[] }>()
    for (const a of acts) {
      let g = byCourse.get(a.courseId)
      if (!g) {
        g = { name: a.courseName, acts: [] }
        byCourse.set(a.courseId, g)
      }
      g.acts.push(a)
    }
    return [...byCourse.entries()].map(([id, g]) => ({ id, ...g }))
  }, [snap, filter])

  const pending = (snap?.activities ?? []).filter((a) => !a.completed).length

  if (loading && !snap) {
    return <AppState kind="loading" title="正在从物理在线拉取作业…" hint="首次加载会逐课查询，可能需要十几秒。" />
  }

  if (error) {
    return <AppState kind="error" title="物理在线数据加载失败" hint={error} onRetry={() => void load(true)} retryLabel="重试" />
  }

  return (
    <>
      <div className="plat-summary">
        <span>{(snap?.courses ?? []).length} 门课</span>
        <span>{(snap?.activities ?? []).length} 项作业</span>
        <span className={pending > 0 ? 'is-warn' : ''}>{pending} 项待完成</span>
        <button type="button" className="btn-ghost plat-summary-force" onClick={() => void load(true)} disabled={loading}>
          {loading ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      <div className="chip-row">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`chip${filter === f.key ? ' is-on' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {groups.length === 0 && (
        <AppState kind="empty" title={filter === 'all' ? '物理在线上没有查到作业' : '没有符合条件的作业'} hint="换一个筛选条件，或点「强制刷新」重新拉取。" />
      )}

      {groups.map((g) => (
        <section className="plat-group" key={g.id}>
          <div className="plat-group-head is-static">
            <span className="plat-group-name">{g.name}</span>
            <span className="plat-group-meta">{g.acts.length} 项</span>
          </div>
          {g.acts.map((a) => (
            <ActivityRow key={a.id} activity={a} />
          ))}
        </section>
      ))}

      <p className="app-hint">
        数据来自物理在线（Moodle）课程页面，服务端缓存 5 分钟；点「强制刷新」会重新向学校查询。
        提交状态在点开作业时实时查询，完成后请回到物理在线原页面确认。
      </p>
    </>
  )
}

/** 单个作业行；点「提交状态」才拉详情（不在快照里） */
function ActivityRow({ activity }: { activity: PhyVlabActivity }) {
  const [detail, setDetail] = useState<PhyVlabAssignmentDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function loadDetail() {
    if (detail || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await getPhyVlabAssignmentDetail(activity.id)
      setDetail(r.detail)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '详情加载失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="plat-task">
      <div className="plat-task-head">
        <a className="plat-task-title" href={activity.url} target="_blank" rel="noreferrer">
          {activity.title}
        </a>
      </div>
      <div className="plat-task-badges">
        <span className={`tag ${activity.completed ? 'is-done' : 'is-pending'}`}>{activity.completed ? '已完成' : '待完成'}</span>
        {activity.dueTimestamp != null && (
          <span className="tag">{fmtDue(activity.dueTimestamp, activity.completed)}</span>
        )}
      </div>
      {(activity.openText || activity.dueText) && (
        <div className="plat-task-times">
          {activity.openText && <span>开放：{activity.openText}</span>}
          {activity.dueText && <span>截止：{activity.dueText}</span>}
        </div>
      )}
      <div className="plat-task-actions">
        <button type="button" className="btn-ghost" onClick={() => void loadDetail()} disabled={busy}>
          {busy ? '查询中…' : detail ? '刷新提交状态' : '查看提交状态'}
        </button>
      </div>
      {err && <div className="form-error">{err}</div>}
      {detail && (
        <dl className="plat-detail">
          <div>
            <dt>提交状态</dt>
            <dd>{detail.submissionStatus ?? '未知'}</dd>
          </div>
          <div>
            <dt>成绩</dt>
            <dd>{detail.gradeText ?? '暂未公布'}</dd>
          </div>
          {detail.files.length > 0 && (
            <div>
              <dt>已交文件</dt>
              <dd>{detail.files.join('、')}</dd>
            </div>
          )}
        </dl>
      )}
    </article>
  )
}

function fmtDue(sec: number, done: boolean): string {
  const d = new Date(sec * 1000)
  if (isNaN(d.getTime())) return '截止：见页面'
  const p = (n: number) => String(n).padStart(2, '0')
  const text = `截止 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  if (done) return text
  const days = Math.floor((sec * 1000 - Date.now()) / 86_400_000)
  if (days < 0) return `${text}（已截止 ${-days} 天）`
  if (days === 0) return `${text}（今天截止）`
  return `${text}（还剩 ${days} 天）`
}
