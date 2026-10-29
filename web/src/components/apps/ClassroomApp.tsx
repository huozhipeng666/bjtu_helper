/**
 * 教室人数估计（「应用」→ 校园服务）。
 *
 * 数据源：服务端 /api/classroom/capacity → 第三方公开接口
 * `http://yaya.csoci.com:2333/api/classnum/?building=<楼名>`。
 * 免登录、不碰学校会话，所以本页对游客也开放。
 *
 * ⚠️ 与已下线的「空闲教室」是两个功能，别混：
 *   - 空闲教室（2026-10-14 下线）= 查教务课表得出「哪间教室没课」；
 *   - 本页 = 第三方摄像头/门禁估算的「这间教室此刻大概有多少人」。
 *   数据是估算值，页面上必须如实说明，不能让用户当成准确人数。
 *
 * 三个刻意的展示决定：
 *  1. **不缓存**：服务端即查即弃，前端也不做 stale-while-revalidate。
 *     人数是几分钟量级会变的东西，给一个"上次看到"的旧数字比不给更糟。
 *  2. 数据窗口时间（第三方给的 `effectiveStart`–`effectiveEnd`）**必须显示**。
 *     用户看到"20:23 的数据"就知道这是快照，不会以为是实时刷新的。
 *  3. 「有空位」筛选按 `used < capacity` 判定，与上游一致。使用率百分比只用来
 *     着色，不参与排序比较 —— 第三方给的百分比有取整，排序会不稳定。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getClassroomCapacity,
  listClassroomBuildings,
  type ClassroomBuildingInfo,
  type ClassroomRoom
} from '../../api'
import { isAbortError } from '../../lib/useAbortController'
import { IconRefresh, IconSearch } from '../../icons'
import AppShell from './AppShell'
import AppState from './AppState'
import type { AppEntryHostProps } from './types'

/** 上次选的教学楼 —— 用户几乎总是查同一栋楼，每次重选很烦 */
const LAST_BUILDING_KEY = 'bjtu.classroom.lastBuilding'

type SortKey = 'name' | 'usedDesc' | 'freeDesc' | 'capacityDesc'

const SORT_LABEL: Record<SortKey, string> = {
  name: '按教室名',
  usedDesc: '按已用人数',
  freeDesc: '按空位数',
  capacityDesc: '按容量'
}

/** 使用率 → 色调档位。只影响颜色，不影响任何计算。 */
function toneOf(r: ClassroomRoom): 'low' | 'mid' | 'high' | 'full' {
  if (r.capacity > 0 && r.used >= r.capacity) return 'full'
  if (r.usagePercent >= 70) return 'high'
  if (r.usagePercent >= 35) return 'mid'
  return 'low'
}

function sortRooms(list: ClassroomRoom[], key: SortKey): ClassroomRoom[] {
  const arr = [...list]
  switch (key) {
    case 'name':
      /* 教室名是「SY101」「东102」这种，用 localeCompare + numeric 才能让
         SY2 排在 SY10 前面（默认字典序会反过来）。 */
      return arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    case 'usedDesc':
      return arr.sort((a, b) => b.used - a.used || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    case 'freeDesc':
      return arr.sort(
        (a, b) => b.capacity - b.used - (a.capacity - a.used) || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      )
    case 'capacityDesc':
      return arr.sort((a, b) => b.capacity - a.capacity || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  }
}

export default function ClassroomApp({ onBack }: AppEntryHostProps) {
  const [buildings, setBuildings] = useState<string[]>([])
  const [building, setBuilding] = useState<string>(() => {
    try {
      return localStorage.getItem(LAST_BUILDING_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [info, setInfo] = useState<ClassroomBuildingInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  /** 只看还有空位的教室 */
  const [onlyFree, setOnlyFree] = useState(false)
  const [query, setQuery] = useState('')

  /* 只保留最后一次请求的结果：切楼/切筛选很快时，先发的请求可能后到，
     用 Ref 里的序号做守卫，避免"点了 A 楼却显示 B 楼数据"。 */
  const reqSeq = useRef(0)

  /* ---------- 教学楼清单（只需取一次） ---------- */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await listClassroomBuildings()
        if (!alive) return
        setBuildings(r.buildings)
        /* 没有记住过的楼 → 默认第一栋（学校习惯顺序，不是字典序） */
        setBuilding((cur) => (cur && r.buildings.includes(cur) ? cur : r.buildings[0] ?? ''))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '教学楼清单加载失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* ---------- 某栋楼的教室人数 ---------- */
  const load = useCallback(
    async (b: string) => {
      if (!b) return
      const seq = ++reqSeq.current
      setLoading(true)
      setError(null)
      try {
        const r = await getClassroomCapacity(b)
        if (reqSeq.current !== seq) return
        setInfo({ building: r.building, effectiveStart: r.effectiveStart, effectiveEnd: r.effectiveEnd, rooms: r.rooms })
        try {
          localStorage.setItem(LAST_BUILDING_KEY, b)
        } catch {
          /* 隐私模式下 localStorage 会抛，忽略即可 —— 只是记不住上次选择 */
        }
      } catch (e) {
        if (reqSeq.current !== seq) return
        if (isAbortError(e)) return
        setInfo(null)
        setError(e instanceof Error ? e.message : '教室人数获取失败')
      } finally {
        if (reqSeq.current === seq) setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (building) void load(building)
  }, [building, load])

  const rooms = info?.rooms ?? []

  const shown = useMemo(() => {
    let list = rooms
    if (onlyFree) list = list.filter((r) => r.capacity > 0 && r.used < r.capacity)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q))
    return sortRooms(list, sortKey)
  }, [rooms, onlyFree, query, sortKey])

  const totals = useMemo(() => {
    let used = 0
    let cap = 0
    let free = 0
    for (const r of rooms) {
      used += r.used
      cap += r.capacity
      if (r.capacity > 0 && r.used < r.capacity) free += 1
    }
    return { used, cap, free, count: rooms.length }
  }, [rooms])

  const picker = (
    <div className="chips cls-buildings" role="tablist" aria-label="教学楼">
      {buildings.map((b) => (
        <button
          key={b}
          type="button"
          role="tab"
          aria-selected={b === building}
          className={`chip${b === building ? ' active' : ''}`}
          onClick={() => setBuilding(b)}
          disabled={loading && b === building}
        >
          {b}
        </button>
      ))}
    </div>
  )

  const action = (
    <button
      type="button"
      className="icon-btn"
      onClick={() => void load(building)}
      disabled={loading || !building}
      aria-label="刷新"
      title="刷新"
    >
      <IconRefresh size={19} />
    </button>
  )

  /* 教学楼清单都还没拿到 → 可能是服务端挂了，整页只显示这个错误 */
  if (error && buildings.length === 0) {
    return (
      <AppShell title="教室人数" onBack={onBack}>
        <AppState kind="error" title={error} hint="这个功能依赖第三方接口，对方不可用时只能等。" />
      </AppShell>
    )
  }

  return (
    <AppShell
      title="教室人数"
      onBack={onBack}
      action={action}
      lead="人数由第三方平台按教室摄像头/门禁估算，仅供参考，不是精确值。本页不缓存，每次查看都会重新拉取。"
    >
      {picker}

      {loading && !info ? (
        <AppState kind="loading" title="正在查询教室人数…" />
      ) : error ? (
        <AppState kind="error" title={error} onRetry={() => void load(building)} />
      ) : rooms.length === 0 ? (
        <AppState kind="empty" title="这栋楼暂时没有数据" hint="可能是第三方还没采集到，换一栋楼或稍后刷新。" />
      ) : (
        <>
          <div className="cls-summary">
            <div className="cls-sum-row">
              <span className="cls-sum-label">数据窗口</span>
              <span className="cls-sum-value">
                {info?.effectiveStart} – {info?.effectiveEnd}
              </span>
            </div>
            <div className="cls-sum-figs">
              <div className="cls-fig">
                <span className="cls-fig-num">{totals.count}</span>
                <span className="cls-fig-label">教室</span>
              </div>
              <div className="cls-fig">
                <span className="cls-fig-num">{totals.used}</span>
                <span className="cls-fig-label">在座</span>
              </div>
              <div className="cls-fig">
                <span className="cls-fig-num">{totals.cap}</span>
                <span className="cls-fig-label">总容量</span>
              </div>
              <div className="cls-fig">
                <span className="cls-fig-num">{totals.free}</span>
                <span className="cls-fig-label">有空位</span>
              </div>
            </div>
          </div>

          <div className="cls-filters">
            <label className="cls-search">
              <IconSearch size={16} />
              <input
                type="search"
                value={query}
                placeholder="搜索教室名"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索教室名"
              />
            </label>
            <select className="select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <label className="cal-toggle cls-only-free">
            <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
            <span>
              <b>只看有空位的教室</b>
              <em>排掉已经坐满的</em>
            </span>
          </label>

          <section className="apps-group">
            <div className="profile-section-title">
              教室明细 <span className="hw-count">{shown.length}</span>
            </div>
            {shown.length === 0 ? (
              <div className="app-hint">当前筛选条件下没有匹配的教室。</div>
            ) : (
              <div className="cls-list">
                {shown.map((r) => {
                  const tone = toneOf(r)
                  const free = r.capacity > 0 ? Math.max(0, r.capacity - r.used) : 0
                  return (
                    <div key={r.name} className={`cls-row is-${tone}`}>
                      <div className="cls-row-head">
                        <span className="cls-name">{r.name}</span>
                        <span className={`cls-badge is-${tone}`}>
                          {tone === 'full' ? '可能已满' : `空 ${free}`}
                        </span>
                      </div>
                      <div className="cls-row-sub">
                        <span className="cls-nums">
                          {r.used} / {r.capacity} 人
                        </span>
                        <span className="cls-pct">{Math.round(r.usagePercent)}%</span>
                      </div>
                      <div className="cls-bar" aria-hidden="true">
                        <span
                          className="cls-bar-fill"
                          style={{ width: `${Math.max(0, Math.min(100, r.usagePercent))}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <div className="app-note">
            这个接口走 HTTP 明文传输，学校网络之外也能访问；如果需要更稳妥的连接方式，可等学校提供 HTTPS
            入口。数据本身不含任何个人身份信息。
          </div>
        </>
      )}
    </AppShell>
  )
}
