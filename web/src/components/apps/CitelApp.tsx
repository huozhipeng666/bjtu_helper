/**
 * CITEL 作业 —— citel.bjtu.edu.cn/mlsv3（Moodle）的课程作业列表。
 *
 * 与「课程平台作业」（智慧课程平台 bksy）的区别：CITEL 是**独立的 Moodle 站**，
 * 账号密码与统一身份认证无关，所以走 PlatformAccountGate 绑定独立账号，
 * 不走教务会话池。上游 KMP 项目里这也是一个独立入口。
 *
 * 数据是一次全量快照（服务端 5 分钟 TTL 缓存）：课程列表走 AJAX 分页，
 * 每门课的作业活动逐个拉，最后按「开放时间 / 截止时间 / 迟交政策 / 提交状态」
 * 归一成列表。编程练习（mod/programming）与书面作业（mod/assign）的详情
 * 结构不同，服务端已分别解析，这里只负责展示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from './AppShell'
import AppState from './AppState'
import PlatformAccountGate from './PlatformAccountGate'
import { AppEntryHostProps } from './types'
import { getCitelSnapshot, type CitelSnapshot, type CitelTask } from '../../api'
import { daysUntilEpoch, fmtEpoch } from '../../lib/date'
import { IconRefresh } from '../../icons'

type Filter = 'all' | 'pending' | 'done'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待完成' },
  { key: 'done', label: '已提交' }
]

/** 待完成优先，其次按截止时间升序；没写截止的排最后 */
function taskSort(a: CitelTask, b: CitelTask): number {
  if (a.submitted !== b.submitted) return a.submitted ? 1 : -1
  if (a.dueTime != null && b.dueTime != null) return a.dueTime - b.dueTime
  if (a.dueTime != null) return -1
  if (b.dueTime != null) return 1
  return b.id - a.id
}

export default function CitelApp({ onBack }: AppEntryHostProps) {
  const [tick, setTick] = useState(0)
  return (
    <AppShell
      title="CITEL 作业"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" aria-label="刷新" onClick={() => setTick((t) => t + 1)}>
          <IconRefresh />
        </button>
      }
    >
      <PlatformAccountGate
        platform="citel"
        lead="CITEL 是独立的 Moodle 站点（citel.bjtu.edu.cn/mlsv3），账号与教务系统不通用，需要单独绑定一次。"
      >
        <CitelBody key={tick} />
      </PlatformAccountGate>
    </AppShell>
  )
}

function CitelBody() {
  const [snap, setSnap] = useState<CitelSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [openCourse, setOpenCourse] = useState<number | 0>(0)

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError('')
    try {
      const r = await getCitelSnapshot(force)
      setSnap(r.data)
    } catch (err) {
      setSnap(null)
      setError(err instanceof Error ? err.message : 'CITEL 数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const groups = useMemo(() => {
    const tasks = snap?.tasks ?? []
    const shown = tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.submitted : !t.submitted))
    const byCourse = new Map<number, { name: string; tasks: CitelTask[] }>()
    for (const t of shown.sort(taskSort)) {
      let g = byCourse.get(t.courseId)
      if (!g) {
        g = { name: t.courseName, tasks: [] }
        byCourse.set(t.courseId, g)
      }
      g.tasks.push(t)
    }
    /* 有待交作业的课排前面，其次按课程名 */
    return [...byCourse.entries()]
      .map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => {
        const pa = a.tasks.some((t) => !t.submitted) ? 0 : 1
        const pb = b.tasks.some((t) => !t.submitted) ? 0 : 1
        return pa - pb || a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
  }, [snap, filter])

  const pending = (snap?.tasks ?? []).filter((t) => !t.submitted).length

  if (loading && !snap) {
    return <AppState kind="loading" title="正在从 CITEL 拉取作业…" hint="首次加载会逐课查询，可能需要十几秒。" />
  }

  if (error) {
    return <AppState kind="error" title="CITEL 数据加载失败" hint={error} onRetry={() => void load(true)} retryLabel="重试" />
  }

  return (
    <>
      <div className="plat-summary">
        <span>{(snap?.courses ?? []).length} 门课</span>
        <span>{(snap?.tasks ?? []).length} 项作业</span>
        <span className={pending > 0 ? 'is-warn' : ''}>{pending} 项待完成</span>
        <button type="button" className="btn-ghost plat-summary-force" onClick={() => void load(true)} disabled={loading}>
          {loading ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      <div className="chip-row">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`chip${filter === f.key ? ' is-on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {groups.length === 0 && (
        <AppState kind="empty" title={filter === 'all' ? 'CITEL 上没有查到作业' : '没有符合条件的作业'} hint="换一个筛选条件，或点「强制刷新」重新拉取。" />
      )}

      {groups.map((g) => {
        const open = openCourse === g.id
        return (
          <section className="plat-group" key={g.id}>
            <button type="button" className="plat-group-head" onClick={() => setOpenCourse(open ? 0 : g.id)}>
              <span className="plat-group-name">{g.name}</span>
              <span className="plat-group-meta">{g.tasks.length} 项</span>
            </button>
            {open &&
              g.tasks.map((t) => (
                <article className="plat-task" key={t.id}>
                  <div className="plat-task-head">
                    <a className="plat-task-title" href={t.url} target="_blank" rel="noreferrer">
                      {t.title}
                    </a>
                  </div>
                  <div className="plat-task-badges">
                    {t.programming && <span className="tag is-kind">编程练习</span>}
                    <span className={`tag ${t.submitted ? 'is-done' : 'is-pending'}`}>{t.submitted ? '已提交' : '未提交'}</span>
                    {t.grade && <span className="tag is-grade">{t.grade}</span>}
                    {t.status && <span className="tag">{t.status}</span>}
                  </div>
                  <div className="plat-task-times">
                    <span>开放：{t.openTime != null ? fmtEpoch(t.openTime) : '未注明'}</span>
                    <span className={t.dueTime != null && !t.submitted && daysUntilEpoch(t.dueTime) < 0 ? 'is-overdue' : ''}>
                      截止：{t.dueTime != null ? fmtEpoch(t.dueTime) : '未注明'}
                      {t.dueTime != null && !t.submitted && (
                        <em className="plat-due-rel">
                          {daysUntilEpoch(t.dueTime) >= 0 ? `还剩 ${daysUntilEpoch(t.dueTime)} 天` : `已截止 ${-daysUntilEpoch(t.dueTime)} 天`}
                        </em>
                      )}
                    </span>
                  </div>
                  {(t.discountTime != null || t.allowLate != null) && (
                    <div className="plat-task-late">
                      {t.discountTime != null && (
                        <span>
                          迟交至 {fmtEpoch(t.discountTime)} 扣 {t.discount != null ? `${t.discount}%` : '一定比例'}
                        </span>
                      )}
                      {t.allowLate === false && <span>不接受迟交</span>}
                    </div>
                  )}
                </article>
              ))}
          </section>
        )
      })}

      <p className="app-hint">
        数据来自 CITEL（Moodle）课程页面，服务端缓存 5 分钟；点「强制刷新」会重新向学校查询。
        作业详情与提交请点标题跳转 CITEL 原页面完成。
      </p>
    </>
  )
}
