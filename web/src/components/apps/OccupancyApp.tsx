/**
 * 教室占用 —— 教务 `room_view` 的「教室 × 7 天 × 7 节」占用矩阵。
 *
 * 与「教室人数」的区别（两个应用并存，别合并）：
 *   本页回答「这一周这间教室被排课/考试/实验占掉了哪些节次」，需要教务会话；
 *   教室人数回答「此刻这间教室有多少人」，第三方公开接口、免登录。
 *
 * 上一版「空闲教室」就是本功能的错误实现（路径缺 /timeholdresult/ 段、
 * 把 49 格矩阵当三列解析），2026-10-14 下架；这里按教务真实页面结构重做。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppShell from './AppShell'
import AppState from './AppState'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import { AppEntryHostProps } from './types'
import {
  getClassroomOccupancy, listOccupancyBuildings, misLogin,
  type OccupancyBuilding, type OccupancyKind, type OccupancyRoom, type OccupancySemesterOption
} from '../../api'
import { IconChevronLeft, IconChevronRight, IconRefresh } from '../../icons'
import { probeSessionSid } from '../../lib/misSession'

const LAST_BUILDING_KEY = 'bjtu.occupancy.lastBuildingId'

/** 与 server/src/classroomOccupancy.ts 的 OCCUPANCY_KIND_LABEL 一致（服务端也会回传一份） */
const KIND_LABEL: Record<OccupancyKind, string> = {
  free: '空闲',
  scheduled: '排课',
  rescheduled: '调课',
  exam: '考试',
  experiment: '实验',
  other: '其他安排',
  unknown: '未知'
}

/** 图例顺序：先讲「被占了」，再讲空 */
const KIND_ORDER: OccupancyKind[] = ['scheduled', 'rescheduled', 'exam', 'experiment', 'other', 'unknown', 'free']

const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日']

function cellOf(room: OccupancyRoom, weekday: number, period: number): OccupancyKind {
  return room.cells[`${weekday}-${period}`] ?? 'free'
}

/** 一间教室本周被占用的节次数（不含空闲格）。列表页按它排序找空教室。 */
function busyCount(room: OccupancyRoom): number {
  let n = 0
  for (let w = 1; w <= 7; w += 1) {
    for (let p = 1; p <= 7; p += 1) {
      if (cellOf(room, w, p) !== 'free') n += 1
    }
  }
  return n
}

export default function OccupancyApp({ onBack }: AppEntryHostProps) {
  const [phase, setPhase] = useState<'probing' | 'login' | 'ready'>('probing')
  const [loginKey, setLoginKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sidRef = useRef('')

  const [buildings, setBuildings] = useState<OccupancyBuilding[]>([])
  const [slotTimes, setSlotTimes] = useState<string[]>([])
  const [buildingId, setBuildingId] = useState('')
  const [week, setWeek] = useState(1)
  const [rooms, setRooms] = useState<OccupancyRoom[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loadedKey, setLoadedKey] = useState('')
  /** 只看有空位的教室 */
  const [onlyFree, setOnlyFree] = useState(false)
  /** 展开的教室（点行进详情） */
  const [openRoom, setOpenRoom] = useState('')
  /** 学期下拉：'' = 教务默认（跟随教务选中的学期） */
  const [semesters, setSemesters] = useState<OccupancySemesterOption[]>([])
  const [term, setTerm] = useState('')
  const reqSeq = useRef(0)

  /* 打开页面：先探测会话池，有可复用登录直接进矩阵（"自动登录"） */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) {
        sidRef.current = found.sid
        setPhase('ready')
        return
      }
      setPhase('login')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* 教学楼清单是静态数据，不需要登录 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await listOccupancyBuildings()
        if (cancelled) return
        setBuildings(r.buildings)
        setSlotTimes(r.slotTimes)
        if (r.buildings.length > 0) {
          let remembered = ''
          try {
            remembered = localStorage.getItem(LAST_BUILDING_KEY) ?? ''
          } catch {
            remembered = ''
          }
          const hit = r.buildings.find((b) => b.id === remembered)
          setBuildingId(hit ? hit.id : r.buildings[0].id)
        }
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : '教学楼清单加载失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async (sid: string, bId: string, w: number, t: string) => {
    if (!sid || !bId) return
    const seq = ++reqSeq.current
    setLoading(true)
    setLoadError('')
    try {
      const r = await getClassroomOccupancy(sid, w, bId, t || undefined)
      // 乱序响应守卫：用户连点周次时只认最后一次
      if (seq !== reqSeq.current) return
      setRooms(r.rooms)
      setLoadedKey(`${bId}-${w}-${t}`)
      if (r.slotTimes.length > 0) setSlotTimes(r.slotTimes)
      // 学期下拉随占用响应一起下发（教务页面同一次请求里就有），省一次往返
      if (r.semesters && r.semesters.all.length > 0) setSemesters(r.semesters.all)
    } catch (err) {
      if (seq !== reqSeq.current) return
      const msg = err instanceof Error ? err.message : '教室占用查询失败'
      setRooms([])
      setLoadError(msg)
      if (/会话/.test(msg)) {
        sidRef.current = ''
        setPhase('login')
        setLoginKey((k) => k + 1)
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  /* 会话就绪 + 选好楼之后加载 */
  useEffect(() => {
    if (phase !== 'ready' || !buildingId) return
    void load(sidRef.current, buildingId, week, term)
  }, [phase, buildingId, week, term, load])

  async function handleLogin(cred: MisLoginCredential) {
    setBusy(true)
    setError('')
    try {
      await misLogin(cred)
      sidRef.current = cred.sid
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
      setLoginKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  function pickBuilding(id: string) {
    setBuildingId(id)
    setOpenRoom('')
    try {
      localStorage.setItem(LAST_BUILDING_KEY, id)
    } catch {
      /* 隐私模式下 localStorage 会抛，忽略即可 —— 记住选择只是便利 */
    }
  }

  function shiftWeek(delta: number) {
    setWeek((w) => Math.min(53, Math.max(1, w + delta)))
    setOpenRoom('')
  }

  const shown = useMemo(() => {
    const list = onlyFree ? rooms.filter((r) => busyCount(r) < 49) : rooms
    // 空得越多越靠前，方便直接找能用的教室
    return [...list].sort((a, b) => {
      const d = busyCount(a) - busyCount(b)
      return d !== 0 ? d : a.room.localeCompare(b.room, 'zh-Hans-CN', { numeric: true })
    })
  }, [rooms, onlyFree])

  const buildingName = buildings.find((b) => b.id === buildingId)?.name ?? ''

  if (phase === 'probing') {
    return (
      <AppShell title="教室占用" onBack={onBack}>
        <AppState kind="loading" title="正在检查教务登录状态…" />
      </AppShell>
    )
  }

  if (phase === 'login') {
    return (
      <AppShell
        title="教室占用"
        onBack={onBack}
        lead="教室占用来自教务系统，需要先登录一次。登录后课表、成绩、邮箱等应用会共用这份登录。"
      >
        <MisLoginForm
          busy={busy}
          error={error}
          refreshToken={loginKey}
          submitLabel="登录并查询"
          busyLabel="正在登录…"
          onLogin={handleLogin}
        />
      </AppShell>
    )
  }

  const detail = openRoom ? rooms.find((r) => r.room === openRoom) : undefined

  return (
    <AppShell
      title="教室占用"
      onBack={onBack}
      action={
        <button
          type="button"
          className="icon-btn"
          aria-label="刷新"
          disabled={loading || !buildingId}
          onClick={() => void load(sidRef.current, buildingId, week, term)}
        >
          <IconRefresh />
        </button>
      }
    >
      <div className="occ-controls">
        <label className="occ-field">
          <span className="occ-field-label">教学楼</span>
          <select
            className="select occ-select"
            value={buildingId}
            onChange={(e) => pickBuilding(e.target.value)}
            disabled={buildings.length === 0}
          >
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>

        {semesters.length > 1 && (
          <label className="occ-field">
            <span className="occ-field-label">学期</span>
            <select
              className="select occ-select"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value)
                setOpenRoom('')
              }}
            >
              <option value="">跟随教务当前学期</option>
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        )}

        <div className="occ-week">
          <button type="button" className="icon-btn" aria-label="上一周" onClick={() => shiftWeek(-1)} disabled={week <= 1}>
            <IconChevronLeft />
          </button>
          <span className="occ-week-label">第 {week} 周</span>
          <button type="button" className="icon-btn" aria-label="下一周" onClick={() => shiftWeek(1)} disabled={week >= 53}>
            <IconChevronRight />
          </button>
        </div>
      </div>

      <div className="occ-legend">
        {KIND_ORDER.map((k) => (
          <span key={k} className={`occ-legend-item is-${k}`}>
            <i className="occ-legend-dot" aria-hidden="true" />
            {KIND_LABEL[k]}
          </span>
        ))}
      </div>

      <label className="cal-toggle occ-only-free">
        <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
        只看有空位的教室
      </label>

      {loadError && (
        <AppState
          kind="error"
          title="教室占用查询失败"
          hint={loadError}
          onRetry={() => void load(sidRef.current, buildingId, week, term)}
        />
      )}

      {!loadError && loading && rooms.length === 0 && (
        <AppState kind="loading" title="正在查询教室占用…" />
      )}

      {!loadError && !loading && rooms.length === 0 && loadedKey && (
        <AppState
          kind="empty"
          title={`${buildingName} 第 ${week} 周没有查到教室`}
          hint="这栋楼可能本周没有排课，或教务把该楼在小节里标注为不开放。"
        />
      )}

      {detail && (
        <section className="occ-detail" aria-label={`${detail.room} 占用详情`}>
          <div className="occ-detail-head">
            <h4>{detail.room}</h4>
            <span className="occ-cap">{detail.capacity > 0 ? `容量 ${detail.capacity} 人` : '容量未知'}</span>
            <button type="button" className="btn-ghost occ-detail-close" onClick={() => setOpenRoom('')}>
              收起
            </button>
          </div>
          <table className="occ-matrix">
            <thead>
              <tr>
                <th scope="col" className="occ-corner">节次</th>
                {WEEKDAY_SHORT.map((d) => (
                  <th key={d} scope="col">周{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 7 }, (_, pi) => {
                const period = pi + 1
                return (
                  <tr key={period}>
                    <th scope="row" className="occ-period">
                      <span className="occ-period-num">第 {period} 节</span>
                      <span className="occ-period-time">{slotTimes[pi] ?? ''}</span>
                    </th>
                    {Array.from({ length: 7 }, (_, wi) => {
                      const kind = cellOf(detail, wi + 1, period)
                      return (
                        <td key={wi} className={`occ-cell is-${kind}`} title={`周${WEEKDAY_SHORT[wi]} 第${period}节 ${KIND_LABEL[kind]}`}>
                          {kind === 'free' ? '' : KIND_LABEL[kind]}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {!loadError && shown.length > 0 && (
        <ul className="occ-list">
          {shown.map((r) => {
            const busy = busyCount(r)
            return (
              <li key={r.room}>
                <button
                  type="button"
                  className={`occ-row${openRoom === r.room ? ' is-open' : ''}`}
                  onClick={() => setOpenRoom(openRoom === r.room ? '' : r.room)}
                >
                  <span className="occ-name">{r.room}</span>
                  <span className="occ-row-meta">
                    {r.capacity > 0 && <span className="occ-cap">{r.capacity} 座</span>}
                    <span className={`occ-busy${busy >= 49 ? ' is-full' : busy === 0 ? ' is-free' : ''}`}>
                      {busy >= 49 ? '整周已满' : busy === 0 ? '整周空闲' : `占用 ${busy}/49 节`}
                    </span>
                  </span>
                  <span className="occ-bar" aria-hidden="true">
                    <span className="occ-bar-fill" style={{ width: `${Math.round((busy / 49) * 100)}%` }} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {!loadError && !loading && rooms.length > 0 && shown.length === 0 && (
        <AppState kind="empty" title="没有符合条件的教室" hint="取消「只看有空位的教室」再看看。" />
      )}

      <p className="app-hint">
        数据来自教务系统的教室使用查询，按教学周显示；占用数据即查即弃，本站不缓存。
        与「教室人数」不同 —— 那个查的是此刻教室里有多少人。
      </p>
    </AppShell>
  )
}
