/**
 * 考试安排（「应用」→ 学习）。
 *
 * 为什么要独立一页：考试在 DDL 列表里只是「一条任务」，看不出"这周有几门、
 * 哪天连考、教室在哪、座位号多少"。抓回来的考试本身带着日期/时间/地点/座位，
 * 按考试该有的样子排出来，比混在待办里有用得多。
 *
 * 和 DDL 的关系（**别做成两套数据**）：
 *  - 本页只读 `GET /api/exams`（MIS 抓取 + 手动添加都在这个表）；
 *  - 「加进 DDL」复用 `POST /api/exams/:id/to-task`，转过的会回写 taskId，
 *    所以按钮要能显示"已加入"而不是重复建任务；
 *  - 导出 .ics 用 `web/src/lib/icsExport.ts` 的 `examToEvents`，
 *    和「导出课表」走同一个生成器（别再写第三份 ICS 拼装）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Exam } from '../../types'
import { getExams, examToTask } from '../../api'
import { useAbortController, isAbortError } from '../../lib/useAbortController'
import { IconRefresh } from '../../icons'
import { examWindow } from '../../lib/examWindow'
import { examToEvents, buildCalendar } from '../../lib/icsExport'
import { saveText } from '../../lib/markdownExport'
import AppShell from './AppShell'
import AppState from './AppState'
import type { AppEntryHostProps } from './types'

/** 距离考试还有几天 → 紧迫度分组。今天/明天要单独拎出来，那是"今晚得复习"的紧急度。 */
type Bucket = 'today' | 'tomorrow' | 'week' | 'later' | 'past'

const BUCKET_META: Record<Bucket, { label: string; cls: string }> = {
  today: { label: '今天', cls: 'is-today' },
  tomorrow: { label: '明天', cls: 'is-soon' },
  week: { label: '一周内', cls: 'is-week' },
  later: { label: '更远', cls: '' },
  past: { label: '已结束', cls: 'is-past' }
}

/** 本地今天的 0 点（用本地时区，不能用 toISOString —— 会跑到 UTC 去，半夜差一天） */
function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** "2026-01-07" → 本地 0 点 Date */
function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}

function daysFromToday(examDate: string): number | null {
  const d = parseDay(examDate)
  if (!d) return null
  const diff = d.getTime() - startOfToday().getTime()
  return Math.round(diff / 86400000)
}

function bucketOf(examDate: string, endTime: string): Bucket {
  const n = daysFromToday(examDate)
  if (n === null) return 'later'
  if (n < 0) return 'past'
  if (n === 0) {
    /* 今天但已经考完（有结束时间且早于此刻）→ 归到"已结束"，
       否则一整天都挂在"今天"里，下午考完了晚上还在提醒 */
    if (endTime) {
      const t = /^(\d{1,2}):(\d{2})/.exec(endTime)
      if (t) {
        const end = new Date()
        end.setHours(Number(t[1]), Number(t[2]), 0, 0)
        if (end.getTime() < Date.now()) return 'past'
      }
    }
    return 'today'
  }
  if (n === 1) return 'tomorrow'
  if (n <= 7) return 'week'
  return 'later'
}

const BUCKET_ORDER: Bucket[] = ['today', 'tomorrow', 'week', 'later', 'past']

export default function ExamsApp({ onBack, onToast, refreshKey }: AppEntryHostProps) {
  const [exams, setExams] = useState<Exam[]>([])
  const [loading, setLoading] = useState(true)
  const [hidePast, setHidePast] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const begin = useAbortController()

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      const ac = begin()
      try {
        const list = await getExams(ac.signal)
        if (ac.signal.aborted) return
        setExams(list)
      } catch (e) {
        if (ac.signal.aborted || isAbortError(e)) return
        if (!silent) onToast(e instanceof Error ? e.message : '加载考试安排失败')
      } finally {
        if (!ac.signal.aborted && !silent) setLoading(false)
      }
    },
    [begin, onToast]
  )

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  /** 按紧迫度分组，组内按日期+时间升序 */
  const groups = useMemo(() => {
    const map = new Map<Bucket, Exam[]>()
    for (const e of exams) {
      const b = bucketOf(e.examDate, e.endTime)
      const arr = map.get(b)
      if (arr) arr.push(e)
      else map.set(b, [e])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const k = (x: Exam) => `${x.examDate} ${x.startTime || '99:99'}`
        return k(a).localeCompare(k(b))
      })
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, items: map.get(b)! }))
  }, [exams])

  const visibleGroups = useMemo(
    () => (hidePast ? groups.filter((g) => g.bucket !== 'past') : groups),
    [groups, hidePast]
  )

  const upcomingCount = useMemo(
    () => exams.filter((e) => bucketOf(e.examDate, e.endTime) !== 'past').length,
    [exams]
  )

  /** 单场考试加入 DDL */
  const addToDdl = async (e: Exam) => {
    if (e.taskId) {
      onToast('这场考试已经在 DDL 里了')
      return
    }
    setBusy(`ddl-${e.id}`)
    try {
      const r = await examToTask(e.id)
      /* 回写 taskId：不回写的话按钮点了没变化，用户会以为没成功 */
      setExams((prev) => prev.map((x) => (x.id === e.id ? { ...x, taskId: r.taskId } : x)))
      onToast('已加入 DDL')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '加入失败')
    } finally {
      setBusy(null)
    }
  }

  /** 全部导出为 .ics */
  const exportIcs = async () => {
    if (exams.length === 0) {
      onToast('还没有考试可以导出')
      return
    }
    setBusy('export')
    try {
      const events = examToEvents(exams)
      const cal = buildCalendar(events, '考试安排')
      const r = await saveText('考试安排.ics', cal, 'text/calendar;charset=utf-8')
      onToast(r.ok ? `已导出 ${events.length} 场考试` : '导出失败')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusy(null)
    }
  }

  const renderExam = (e: Exam) => {
    const b = bucketOf(e.examDate, e.endTime)
    const meta = BUCKET_META[b]
    const w = examWindow(e)
    const n = daysFromToday(e.examDate)
    return (
      <div className={`exam-card${b === 'past' ? ' is-past' : ''}`} key={e.id}>
        <div className="exam-card-top">
          <span className={`exam-badge ${meta.cls}`}>{meta.label}</span>
          {n !== null && n >= 0 && (
            <span className="exam-countdown">{n === 0 ? '就在今天' : `${n} 天后`}</span>
          )}
          {e.source === 'manual' && <span className="exam-src">手动添加</span>}
        </div>
        <div className="exam-course">{e.courseName || '未命名考试'}</div>
        <div className="exam-meta">
          <span>
            {e.examDate}
            {e.startTime ? ` ${e.startTime}` : ''}
            {e.endTime ? `–${e.endTime}` : ''}
            {!e.startTime && ' （时间待定）'}
            {w?.endEstimated && e.startTime && ' （结束时间推算）'}
          </span>
          {e.location && <span>· {e.location}</span>}
          {e.seat && <span>· 座位 {e.seat}</span>}
        </div>
        {e.note && <div className="exam-note">{e.note}</div>}
        <div className="exam-acts">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy === `ddl-${e.id}` || !!e.taskId}
            onClick={() => void addToDdl(e)}
          >
            {e.taskId ? '已加入 DDL' : busy === `ddl-${e.id}` ? '添加中…' : '加入 DDL'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <AppShell
      title="考试安排"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" onClick={() => void load()} aria-label="刷新">
          <IconRefresh size={19} />
        </button>
      }
      lead={
        <>
          考试数据在「应用 → 数据同步」时从教务一并拉取。
          {exams.length > 0 && ` 目前有 ${upcomingCount} 场未结束。`}
        </>
      }
    >
      {loading ? (
        <AppState kind="loading" title="正在加载考试安排…" />
      ) : exams.length === 0 ? (
        <AppState
          kind="empty"
          title="还没有考试安排"
          hint="到「应用 → 数据同步」用学号登录一次即可拉取本学期考试。教务通常期中前后才公布。"
        />
      ) : (
        <>
          <div className="exam-toolbar">
            <label className="hw-check">
              <input
                type="checkbox"
                checked={hidePast}
                onChange={(e) => setHidePast(e.target.checked)}
              />
              隐藏已结束
            </label>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy === 'export'}
              onClick={() => void exportIcs()}
            >
              {busy === 'export' ? '导出中…' : '导出 .ics'}
            </button>
          </div>
          {visibleGroups.length === 0 ? (
            <AppState
              kind="empty"
              title="没有未结束的考试"
              hint="取消上面的「隐藏已结束」可以看到历史考试。"
            />
          ) : (
            visibleGroups.map((g) => (
              <section className="apps-group" key={g.bucket}>
                <div className="profile-section-title">
                  {BUCKET_META[g.bucket].label}
                  <span className="hw-count">{g.items.length} 场</span>
                </div>
                {g.items.map(renderExam)}
              </section>
            ))
          )}
        </>
      )}
    </AppShell>
  )
}
