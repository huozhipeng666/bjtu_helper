/**
 * 周视图顶部的「学分汇总卡」。
 *
 * 为什么按「课程名去重」统计：
 *  - 一条课程记录 = 某门课在某天某节次的"一次上课"（见 CourseForm / MIS 解析），
 *    一门课每周上多次（如周一+周三各一次）会存成多条记录，且每条都带完整学分；
 *  - 若直接对所有记录求和会翻倍（一门 3 学分的课周上 2 次会算成 6）；
 *  - 因此以课程名为去重键：每门课只取一次学分计入"学期总学分"。
 *
 * 提供三个口径：
 *  1. 学期总学分 —— 优先用教务官方总学分（officialCredits，来自 AA"共 X 学分"）；
 *     没有官方值时回退为全部已录入课程（含当前没在上的）去重后求和；
 *  2. 本周修读学分 —— 本周实际在上的课程去重后求和（与下方周网格呼应）；
 *  3. 缺学分课程 —— 去重后仍未填学分的课程，提示补填。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Course, WeekData } from '../types'
import { getCourses } from '../api'

interface CreditSummaryCardProps {
  week: WeekData
  /** 数据变化（导入/增删改）后 ++ 触发重新拉取 */
  refreshKey: number
  /** 教务官方总学分（来自 MIS 导入写回的 settings.officialCredits）；为空则回退按课程累加 */
  officialCredits?: number | null
}

export default function CreditSummaryCard({ week, refreshKey, officialCredits }: CreditSummaryCardProps) {
  const [courses, setCourses] = useState<Course[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCourses()
      .then((c) => {
        if (!cancelled) {
          setCourses(c)
          setError('')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  /**
   * 以课程名为键归并：返回 [{name, credits, color}]，一门课一条。
   * 同一门课多条记录（不同天/节）的学分理论上一致，取第一个非空的；
   * 首条没填学分但后条填了时，用后条补上。
   */
  const merged = useMemo(() => {
    const map = new Map<string, { name: string; credits: number | null; color: string }>()
    for (const c of courses) {
      const cur = map.get(c.name)
      if (!cur) {
        map.set(c.name, { name: c.name, credits: c.credits ?? null, color: c.color })
        continue
      }
      if (cur.credits == null && c.credits != null) {
        cur.credits = c.credits
        cur.color = c.color
      }
    }
    return [...map.values()].sort((a, b) => {
      // 已填学分的排前面（更整齐），同态按名称
      const ao = a.credits == null ? 1 : 0
      const bo = b.credits == null ? 1 : 0
      if (ao !== bo) return ao - bo
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  }, [courses])

  const withCredits = useMemo(() => merged.filter((m) => m.credits != null), [merged])
  const missing = useMemo(() => merged.filter((m) => m.credits == null), [merged])
  /** 按课程累加口径的学期总学分 */
  const computedTotal = useMemo(
    () => withCredits.reduce((sum, m) => sum + (m.credits as number), 0),
    [withCredits]
  )
  /** 是否使用教务官方总学分作为权威口径 */
  const useOfficial = officialCredits != null
  const headlineTotal = useOfficial ? (officialCredits as number) : computedTotal

  /** 本周实际在上的课程名集合（week.days 已按周次/单双周过滤），用于"本周修读学分" */
  const weekNames = useMemo(() => {
    const s = new Set<string>()
    for (const d of week.days) for (const c of d.courses) s.add(c.name)
    return s
  }, [week])
  /** 本周在上的去重课程里，已填学分者求和 */
  const weekTotal = useMemo(
    () => merged.filter((m) => weekNames.has(m.name) && m.credits != null).reduce((sum, m) => sum + (m.credits as number), 0),
    [merged, weekNames]
  )
  const weekWith = merged.filter((m) => weekNames.has(m.name) && m.credits != null).length
  const weekMiss = merged.filter((m) => weekNames.has(m.name) && m.credits == null).length

  if (error) return null // 拉课程失败不打断周视图，静默降级

  return (
    <div
      className="card"
      style={{
        marginBottom: 10,
        padding: '12px 14px',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-weak)'
      }}
    >
      {/* 头部：三项口径 + 展开开关 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          cursor: merged.length > 0 ? 'pointer' : 'default',
          userSelect: 'none'
        }}
        onClick={() => merged.length > 0 && setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent-2)' }}>学分</span>
        <span className="cc-stat">
          <b>{headlineTotal}</b> 总学分
          {useOfficial && (
            <em className="cc-badge" title="来自教务系统课表页上方摘要">
              教务
            </em>
          )}
        </span>
        <span className="cc-stat"><b>{weekTotal}</b> 本周</span>
        {missing.length > 0 && (
          <span className="cc-stat cc-miss"><b>{missing.length}</b> 门缺学分</span>
        )}
        {merged.length > 0 && (
          <span
            className="cc-caret"
            style={{ transform: open ? 'rotate(180deg)' : 'none', marginLeft: 'auto' }}
            aria-hidden="true"
          >
            ▾
          </span>
        )}
      </div>

      {/* 展开明细 */}
      {open && merged.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--accent-weak)', paddingTop: 8 }}>
          {useOfficial && computedTotal !== headlineTotal && (
            <div className="cc-sub">
              教务官方总学分 <b>{headlineTotal}</b>；按本页已录课程学分合计 <b>{computedTotal}</b>
              {missing.length > 0 && `（还有 ${missing.length} 门未填学分，故合计偏低）`}
            </div>
          )}
          {weekTotal > 0 && (
            <div className="cc-sub">
              本周修读 <b>{weekTotal}</b> 学分（{weekWith} 门；{weekMiss > 0 ? `还有 ${weekMiss} 门未填学分` : '已全部填写'}）
            </div>
          )}
          <ul className="cc-list">
            {merged.map((m) => {
              const has = m.credits != null
              const inWeek = weekNames.has(m.name)
              return (
                <li key={m.name} className="cc-li">
                  <span className="cc-dot" style={{ background: has ? m.color : 'var(--border)' }} />
                  <span className="cc-name" style={{ fontWeight: inWeek ? 600 : 400 }}>
                    {m.name}
                    {inWeek && <em className="cc-thisweek">本周</em>}
                  </span>
                  <span className="cc-val">
                    {has ? (
                      <span style={{ color: 'var(--accent-2)', fontWeight: 700 }}>{m.credits} 学分</span>
                    ) : (
                      <span style={{ color: 'var(--warn)', fontSize: 12 }}>未填</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          {missing.length > 0 && (
            <div style={{ color: 'var(--warn)', fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
              有 {missing.length} 门课还没填学分（点课程编辑补上）——只影响上表"按课程合计"与本周修读，
              {useOfficial ? '不改变左上角教务官方总学分。' : '不填则总学分偏低。'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
