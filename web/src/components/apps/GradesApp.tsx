/**
 * 成绩查询（「应用」→ 学习）。
 *
 * 数据来自服务端 /api/grades（由 /api/mis/sync 落库）。
 * 默认统计（加权平均 / 学分 / 挂科数）**由服务端算好**，本页只展示 ——
 * 前端不复刻算法，否则两侧一旦不一致，用户会在两个地方看到不同的平均分。
 *
 * 排版（2026-10-14 改版，参照 KMP 参考仓库的 GradeScreen / GradeTypeColors）：
 *  - 顶部汇总卡：加权平均做大数字，计分课程 / 总学分 / 不及格做小格；
 *  - 列表行：课名（去掉教务前后缀）+ 类别色片 + 教师 · 学期 · 学分，右侧分数大号、挂科红；
 *  - 有详情（分数构成）的行可点开展开。
 *
 * 三个刻意的展示决定：
 *  1. **未知类别不归入任何一个统计桶**，单独列出来。把 unknown 混进必修会让
 *     学分统计虚高，进而误导毕业审核判断。
 *  2. 五级制成绩（A/A- 等）按「代表分数」折算后计入加权平均（2026-10-14 起，
 *     对齐官方「加权平均成绩」口径与用户核对值）；映射不到的等级（"通过"等
 *     两级制）不参与计算，绝不默认取任何值。
 *  3. 体育课以独立色片标注。它的学分与算法和普通课略有不同，混看容易误导。
 *
 * 2026-10-20 参照上游 KMP 版补齐两项能力（上游有、本仓库没有）：
 *  - **按课程性质筛选与勾选**：教务把「必修/限选/任选/体育」混在一张表里，
 *    算保研/评奖加权时通常只看必修+限选。上游允许按性质过滤并逐类开关。
 *  - **自选课程计算**：任意勾选若干门课，实时重算加权平均。
 *    这是"如果我重修这门，绩点会变成多少"这类问题的唯一解，
 *    服务端的全局统计永远回答不了。
 *
 * ⚠️ 一旦进入「自选课程计算」，顶部数字就**不再来自服务端**，而是本地现算。
 *    两条路径的口径必须完全一致（同一张 GRADE_REPRESENTATIVE、同样的
 *    "无学分不计入加权"规则），否则用户会看到切换模式时数字莫名变化。
 *    下面 computeStatsOf() 就是这份唯一实现，两种模式共用它。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Grade, GradeCourseType } from '../../types'
import { listGrades, type GradeStats } from '../../api'
import { useAbortController, isAbortError } from '../../lib/useAbortController'
import AppShell from './AppShell'
import AppState from './AppState'
import type { AppEntryHostProps } from './types'

const TYPE_LABEL: Record<string, string> = {
  required: '必修',
  limited: '限选',
  elective: '任选',
  pe: '体育',
  unknown: '未分类'
}

/** 性质筛选项的固定顺序 —— 与教务表头一致，不按数据出现顺序（否则每次都不一样） */
const TYPE_ORDER: GradeCourseType[] = ['required', 'limited', 'elective', 'pe', 'unknown']

type SortOrder = 'original' | 'originalReversed' | 'ascending' | 'descending'

const SORT_LABEL: Record<SortOrder, string> = {
  original: '默认排序',
  originalReversed: '默认倒序',
  ascending: '分数从低到高',
  descending: '分数从高到低'
}

/**
 * 显示用课名：去掉教务的类别前缀（前 8 字符）与班级后缀（后 4 字符）。
 * 与 server/src/grades.ts 的 `displayCourseName` 同一规则（≤12 字符不动，
 * 避免把本来就短的课名切坏）。改动会让与统计口径的观感不一致，非必要不要动。
 */
function displayName(raw: string): string {
  const s = raw.trim()
  if (s.length <= 12) return s
  return s.slice(8, s.length - 4).trim() || s
}

/**
 * 五级制成绩的「代表分数」折算表。
 *
 * ⚠️ 必须与 `server/src/grades.ts` 的 `GRADE_REPRESENTATIVE` 逐项一致 ——
 *    不一致会导致「全部学期」与「筛选某学期」两个视图用的口径不同，
 *    同一门课的数字对不上，用户会以为统计错了。改动请两处一起改。
 */
const GRADE_REPRESENTATIVE: Record<string, number> = {
  A: 95,
  'A-': 87,
  'B+': 83,
  B: 79,
  'B-': 76,
  'C+': 73,
  C: 69,
  'C-': 66,
  'D+': 63,
  D: 60,
  F: 30
}

/** 单门课参与统计的分数：百分制用实际分数；五级制用代表分数；其余 null（不参与） */
function statScoreOf(g: { courseScore: number | null; scoreText: string }): number | null {
  if (g.courseScore !== null) return g.courseScore
  return GRADE_REPRESENTATIVE[g.scoreText.trim().toUpperCase()] ?? null
}

/** 前端重算的结果。字段与服务端 GradeStats 同名，便于两种模式共用展示层。 */
interface ComputedStats {
  counted: number
  weightedAverage: number | null
  average: number | null
  totalCredits: number
  failed: number
}

/**
 * 本地统计（唯一实现）。
 *
 * 口径与 `server/src/grades.ts` 的 `computeStats` 保持一致：
 *  - `totalCredits` 是所有课（含无分数课）的学分之和 —— 这是"已修学分"，与是否出分无关；
 *  - `counted` / `average` / `failed` 只统计**有分数**的课；
 *  - `weightedAverage` 只统计**有分数且有学分**的课（学分 0 的课权重为 0，
 *    纳进去会让分母多出一门，等于偷偷改变了结果）。
 */
function computeStatsOf(list: Grade[]): ComputedStats {
  let credits = 0
  let wSum = 0
  let wCr = 0
  let sSum = 0
  let sCnt = 0
  let failed = 0
  for (const g of list) {
    const cr = g.courseCredits ?? 0
    credits += cr
    const s = statScoreOf(g)
    if (s === null) continue
    sSum += s
    sCnt += 1
    if (s < 60) failed += 1
    if (cr > 0) {
      wSum += s * cr
      wCr += cr
    }
  }
  return {
    counted: sCnt,
    weightedAverage: wCr > 0 ? Math.round((wSum / wCr) * 10) / 10 : null,
    average: sCnt > 0 ? Math.round((sSum / sCnt) * 100) / 100 : null,
    totalCredits: Math.round(credits * 10) / 10,
    failed
  }
}

function sortGrades(list: Grade[], order: SortOrder): Grade[] {
  if (order === 'original' || order === 'originalReversed') {
    return order === 'originalReversed' ? [...list].reverse() : list
  }
  // 无分数的排在最后（不参与排序比较 —— 否则会把 null 当成 0 排到最前）
  const withScore = list.filter((g) => g.courseScore !== null)
  const noScore = list.filter((g) => g.courseScore === null)
  withScore.sort((a, b) =>
    order === 'ascending'
      ? (a.courseScore as number) - (b.courseScore as number)
      : (b.courseScore as number) - (a.courseScore as number)
  )
  return [...withScore, ...noScore]
}

/** 学期键（"2025-2026 第1学期"），空学期返回 '' */
function termKeyOf(g: Grade): string {
  return [g.courseYear, g.semester].filter(Boolean).join(' ')
}

export default function GradesApp({ onBack, onToast, refreshKey }: AppEntryHostProps) {
  const [items, setItems] = useState<Grade[]>([])
  const [stats, setStats] = useState<GradeStats | null>(null)
  const [lastSyncedCount, setLastSyncedCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [order, setOrder] = useState<SortOrder>('original')
  /** 学期筛选：'' = 全部 */
  const [term, setTerm] = useState('')
  /** 展开的行（显示分数构成详情） */
  const [openId, setOpenId] = useState<string | null>(null)

  /* ---------- 2026-10-20 新增：性质筛选 + 自选课程计算 ---------- */
  /**
   * 勾选中的课程性质集合。
   * 默认**全部选中** —— 但语义上要区分"全选"与"用户手动全选过"：
   * 前者跟随后续数据变化，后者不跟随。用一个 null 表示"全选"，显式集合表示用户自己挑的。
   */
  const [typeFilter, setTypeFilter] = useState<Set<GradeCourseType> | null>(null)
  /** 是否处于「自选课程计算」模式 */
  const [freeMode, setFreeMode] = useState(false)
  /** 自选模式下的勾选课程 id */
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const begin = useAbortController()

  const load = useCallback(async () => {
    setLoading(true)
    const ac = begin()
    try {
      const r = await listGrades(ac.signal)
      if (ac.signal.aborted) return
      setItems(r.items)
      setStats(r.stats)
      setLastSyncedCount(r.lastSyncedCount)
    } catch (e) {
      if (ac.signal.aborted || isAbortError(e)) return
      onToast(e instanceof Error ? e.message : '加载成绩失败')
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [begin, onToast])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  /** 可选学期列表（"2025-2026 第1学期" 这种） */
  const terms = useMemo(() => {
    const set = new Set<string>()
    for (const g of items) {
      const t = termKeyOf(g)
      if (t) set.add(t)
    }
    return [...set]
  }, [items])

  /** 实际出现在数据里的性质种类（order 固定，只保留真有课的） */
  const availableTypes = useMemo(() => {
    const seen = new Set(items.map((g) => g.courseType))
    return TYPE_ORDER.filter((t) => seen.has(t))
  }, [items])

  /** 当前生效的性质集合（null = 全选） */
  const activeTypes = useMemo(
    () => typeFilter ?? new Set<GradeCourseType>(availableTypes),
    [typeFilter, availableTypes]
  )

  /** 学期 + 性质双重过滤后的结果，未排序 */
  const filtered = useMemo(() => {
    return items.filter((g) => {
      if (term && termKeyOf(g) !== term) return false
      return activeTypes.has(g.courseType)
    })
  }, [items, term, activeTypes])

  const shown = useMemo(() => sortGrades(filtered, order), [filtered, order])

  /** 自选模式下的课程集合（已按 id 过滤到当前列表内） */
  const pickedList = useMemo(() => items.filter((g) => picked.has(g.id)), [items, picked])

  /** 顶部数字来源：自选模式现算，否则服务端（筛选了学期/性质时也要现算） */
  const currentStats: ComputedStats | null = useMemo(() => {
    if (!stats) return null
    if (freeMode) return computeStatsOf(pickedList)
    /* 没有任何筛选 → 直接用服务端的全局统计（唯一权威来源）。
       一旦筛选，就必须现算，否则"筛选后 5 门课"配的是"全部 40 门"的平均分。 */
    if (!term && activeTypes.size === availableTypes.length) return stats
    return computeStatsOf(filtered)
  }, [stats, freeMode, pickedList, term, activeTypes, availableTypes, filtered])

  /** 汇总卡副标题：说清这个数字由哪些课算出来的 */
  const scopeHint = useMemo(() => {
    if (freeMode) return `自选 ${pickedList.length} 门课程`
    const parts: string[] = []
    if (term) parts.push(term)
    if (activeTypes.size !== availableTypes.length) {
      const names = availableTypes.filter((t) => activeTypes.has(t)).map((t) => TYPE_LABEL[t])
      parts.push(names.length > 0 ? names.join('/') : '无性质')
    }
    return parts.length > 0 ? `${parts.join(' · ')} · ${shown.length} 门课程` : `${shown.length} 门课程`
  }, [freeMode, pickedList.length, term, activeTypes, availableTypes, shown.length])

  /* ---------- 性质筛选交互 ---------- */

  function toggleType(t: GradeCourseType) {
    const cur = new Set(activeTypes)
    if (cur.has(t)) cur.delete(t)
    else cur.add(t)
    /* 全选回去了就归位成 null，这样后续数据变化仍能自动包含新性质 */
    setTypeFilter(cur.size === availableTypes.length ? null : cur)
  }

  function selectAllTypes() {
    setTypeFilter(null)
  }

  function clearTypes() {
    setTypeFilter(new Set())
  }

  /* ---------- 自选课程交互 ---------- */

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 全选**当前筛选结果**（不是全部课程 —— 用户已经用筛选表达过意图了） */
  function pickAllFiltered() {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const g of filtered) next.add(g.id)
      return next
    })
  }

  function clearPicks() {
    setPicked(new Set())
  }

  /** 进入自选模式：默认把当前筛选结果带上，避免进去先看到空图 */
  function enterFreeMode() {
    if (picked.size === 0) {
      const seed = new Set<string>()
      for (const g of filtered) if (statScoreOf(g) !== null) seed.add(g.id)
      setPicked(seed)
    }
    setFreeMode(true)
  }

  return (
    <AppShell
      title="成绩查询"
      onBack={onBack}
      lead="数据来自本科教务。五级制成绩（A/A- 等）按等级区间的代表分数折算后计入加权平均；两级制（通过/不通过）不参与计算。"
    >
      {loading ? (
        <AppState kind="loading" title="正在加载成绩…" />
      ) : items.length === 0 ? (
        <AppState
          kind="empty"
          title={lastSyncedCount === null ? '还没有同步过成绩' : '教务暂未返回成绩数据'}
          hint={
            lastSyncedCount === null
              ? '到「应用 → 数据同步」用学号登录一次即可拉取。'
              : '可能本学期尚未出分，等出分后再同步一次。'
          }
        />
      ) : (
        <>
          {currentStats && (
            <div className="grade-summary">
              <div className="grade-big">
                <span className="grade-big-num">{currentStats.weightedAverage ?? '—'}</span>
                <span className="grade-big-label">
                  学分加权平均{freeMode ? '（自选）' : ''}
                </span>
              </div>
              <div className="grade-figs">
                <div className="grade-fig">
                  <span className="grade-fig-num">{currentStats.counted}</span>
                  <span className="grade-fig-label">计分课程</span>
                </div>
                <div className="grade-fig">
                  <span className="grade-fig-num">{currentStats.totalCredits}</span>
                  <span className="grade-fig-label">总学分</span>
                </div>
                <div className={`grade-fig${currentStats.failed > 0 ? ' is-warn' : ''}`}>
                  <span className="grade-fig-num">{currentStats.failed}</span>
                  <span className="grade-fig-label">不及格</span>
                </div>
              </div>
              <div className="grade-summary-sub">{scopeHint}</div>
            </div>
          )}

          {(terms.length > 1 || items.length > 6) && (
            <div className="grade-filters">
              {terms.length > 1 && (
                <select className="select grade-select" value={term} onChange={(e) => setTerm(e.target.value)}>
                  <option value="">全部学期</option>
                  {terms.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="select grade-select"
                value={order}
                onChange={(e) => setOrder(e.target.value as SortOrder)}
              >
                {(Object.keys(SORT_LABEL) as SortOrder[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ---------- 按课程性质筛选 ---------- */}
          {availableTypes.length > 1 && (
            <div className="grade-type-filter">
              <div className="grade-type-chips">
                {availableTypes.map((t) => {
                  const on = activeTypes.has(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`grade-type-chip grade-type-${t}${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleType(t)}
                    >
                      {TYPE_LABEL[t]}
                    </button>
                  )
                })}
              </div>
              <div className="grade-type-actions">
                <button
                  type="button"
                  className="grade-link"
                  onClick={selectAllTypes}
                  disabled={activeTypes.size === availableTypes.length}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="grade-link"
                  onClick={clearTypes}
                  disabled={activeTypes.size === 0}
                >
                  全部清空
                </button>
              </div>
            </div>
          )}

          {/* ---------- 自选课程计算 ---------- */}
          <div className="grade-free-bar">
            <label className="cal-toggle grade-free-toggle">
              <input
                type="checkbox"
                checked={freeMode}
                onChange={(e) => (e.target.checked ? enterFreeMode() : setFreeMode(false))}
              />
              <span>
                <b>自选课程计算</b>
                <em>勾选任意课程，实时重算加权平均</em>
              </span>
            </label>
            {freeMode && (
              <div className="grade-free-actions">
                <button type="button" className="grade-link" onClick={pickAllFiltered}>
                  全选当前
                </button>
                <button type="button" className="grade-link" onClick={clearPicks} disabled={picked.size === 0}>
                  全部清空
                </button>
              </div>
            )}
          </div>

          <section className="apps-group">
            <div className="profile-section-title">
              成绩明细 <span className="hw-count">{shown.length}</span>
            </div>
            {shown.length === 0 ? (
              <div className="app-hint">当前筛选条件下没有课程。</div>
            ) : (
              <div className="grade-list">
                {shown.map((g) => {
                  const open = openId === g.id
                  const hasDetail = !!g.detail.trim()
                  const isPicked = picked.has(g.id)
                  return (
                    <div
                      key={g.id}
                      className={`grade-row${open ? ' is-open' : ''}${freeMode && isPicked ? ' is-picked' : ''}`}
                    >
                      {freeMode && (
                        <label className="grade-pick">
                          <input
                            type="checkbox"
                            checked={isPicked}
                            onChange={() => togglePick(g.id)}
                            aria-label={`选择 ${displayName(g.courseName)}`}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="grade-main"
                        onClick={() => {
                          if (hasDetail) setOpenId(open ? null : g.id)
                        }}
                      >
                        <div className="grade-line">
                          <span className="grade-name">{displayName(g.courseName)}</span>
                          <span className={`grade-type grade-type-${g.courseType}`}>
                            {TYPE_LABEL[g.courseType] ?? '未分类'}
                          </span>
                        </div>
                        <div className="grade-sub">
                          {[
                            g.courseTeacher,
                            termKeyOf(g),
                            g.courseCredits !== null ? `${g.courseCredits} 学分` : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </button>
                      <span
                        className={`grade-score${
                          g.courseScore !== null && g.courseScore < 60 ? ' is-fail' : ''
                        }`}
                      >
                        {g.courseScore !== null ? g.courseScore : g.scoreText || '—'}
                      </span>
                      {open && hasDetail && <div className="grade-detail">{g.detail}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {freeMode && (
            <div className="app-note">
              自选的统计只在本次浏览内生效，不会改动服务端的成绩数据。
              未选任何课程时显示「—」，不会退化成 0 分。
            </div>
          )}
        </>
      )}
    </AppShell>
  )
}
