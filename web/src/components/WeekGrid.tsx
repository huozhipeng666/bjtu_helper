import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Period, WeekCourse, WeekData } from '../types'
import { weekdayCN } from '../lib/date'
import { hexToRgba } from '../constants'

interface WeekGridProps {
  week: WeekData
  periods: Period[]
  onEditCourse: (c: WeekCourse) => void
  /**
   * 紧凑视图：压一档行高，**并让周一~周日一屏看全**（7 列平分容器宽度、不横滑）。
   * 两件事必须同时做 —— 只压行高不放弃列宽下限的话，7 列仍需 576px，
   * 用户在 430px 手机上还是得左右滑动才能看到周五，那这个开关就失去意义了。
   */
  compact?: boolean
  /** 按需显示周末：分别隐藏当前周没有可见课程的周六、周日两列（设计稿图2） */
  autoWeekend?: boolean
  /** 显示非本周课程：把本学期有课、本周不上的课以灰色画出来（设计稿图2） */
  showInactive?: boolean
  /**
   * 行高覆盖（px）。null / 缺省 = 按「节数 + 紧凑档」自动推导。
   * 由「课表显示」里的行高滑杆写入（对齐竞品 34~92dp 的可调区间）。
   */
  rowHeight?: number | null
  /** 块内是否显示地点 / 教师 / 学分（默认 地点✅ 教师✅ 学分❌） */
  showLocation?: boolean
  showTeacher?: boolean
  showCredit?: boolean
  /** 午休 / 晚休通栏分隔带（默认开） */
  showBreaks?: boolean
}

/** 完整显示的最小节次数：课表默认 1-7 大节，即使某天没课也把格子留出来 */
const DEFAULT_ROWS = 7

/** 左侧时间轴宽度：竞品是 36dp（比我们原 52px 窄 30%），这里取 44px 兼顾中文「节」字 */
const AXIS_W = 44
/**
 * 紧凑档的时间轴宽度。
 *
 * 紧凑视图的**契约是「周一~周日一屏看全、不许横滑」**，所以横向每一 px 都要抠：
 * 430px 视口下可用宽度只有 396px（两侧各 16px 内边距 + 1px 边框 ×2），
 * 轴从 44px 收到 34px，7 列就各多分 1.4px。看着少，但列宽总共只有 ~52px，
 * 相当于给每列多出 2.7% 的正文宽度，长课名能不能放下常常就差这一点。
 * 34px 是「08:00」在 9px tabular-nums 下（≈23px）留出余量的最小宽度。
 */
const AXIS_W_COMPACT = 34
/** 每列最小宽度：列多到挤不下才允许横滑。
    76px 是实测定的：块内要放「课名 / @地点 / 教师」三行，
    「@计算中心 205」这类长地点在 72px 列宽下只差 1px 就被省略号吃掉，
    给到 76px（配合块内左右各 4px 内边距）刚好放下。
    ⚠️ 这个下限**只用于标准档**。紧凑档必须放弃它，否则 7 列 = 576px > 396px，
       用户还是得横滑 —— 那就违背了紧凑视图存在的意义（见 minWidth 处的注释）。 */
const COL_MIN = 76
/** 分隔带高度 */
const BREAK_H = 22
/** 课程块上下各留的间隙，相邻两块合计 4px（与竞品 2dp×2 一致） */
const BLOCK_GAP = 4

/** 判定为「休息段」的最小时间间隔（分钟）：小于此值只算普通课间，不插分隔带 */
const BREAK_MIN_GAP = 50

function toMin(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
}

function isTime(hm: string | undefined): hm is string {
  return !!hm && /^\d{2}:\d{2}$/.test(hm)
}

/** 一个纵向槽位：要么是一节，要么是一条通栏分隔带 */
type Slot =
  | { kind: 'p'; period: number; h: number }
  | { kind: 'b'; label: string; h: number }

/**
 * 经典"周视图"时间网格：左侧节次时间轴 + 周一~周日 7 列。
 * 用 CSS Grid 铺出 header + 每节一行的时间轴，课程块在各自天列里
 * 按节次区间用 absolute 定位成色块（跨节自动合并成大块）。
 *
 * ── 2026-10-08 紧凑化改造（对齐竞品 Nexio课程表）────────────────────
 * 1) **行高体系压缩**：标准 84~112px → 64~80px，紧凑 58~78px → 44~54px。
 *    竞品整个课表建立在「每节 54dp」上，12 节一屏看完大半天；我们原来比它松一倍。
 * 2) **左侧时间轴改三行制**：节次 / 开始 / 结束（竞品做法）。开始时间由轴承担后，
 *    块内就不再需要重复写时间了 —— 这是"块内能多放一行课名"的来源。
 * 3) **块内信息改三段式**：课名（加粗·课程色）→ @地点 → 教师。
 *    时间与学分移出块内（时间在轴上、学分进详情/可选角标）。
 * 4) **午休 / 晚休通栏分隔带**：按节次时间的**实际间隔**推导，间隔 ≥50min 才插一条。
 *    竞品是写死「上午/下午/晚上节数」，我们按数据推导，任何学校的作息都能自适应。
 * 5) **课程色块改为「低饱和同色底 + 同色文字」**，去掉左侧色条。
 * 6) **紧凑档横向也一屏装下 7 天**：放弃每列 76px 的下限，7 列平分容器宽度。
 *    只压行高是不够的 —— 行高压扁了，周五还是被顶在屏幕外，得横滑才看得见。
 *
 * 节次范围：**完整渲染 1..N**（N = 节次设置长度与本周最大节次取大者），
 * 不再按"有课的区间"压缩高度——压缩版本会让空档消失，看不出哪几节没课，
 * 也容易让人误以为课没导全。行高随行数自适应，避免完整显示后页面过长。
 *
 * 「现在」指示线：在今天的列里按当前时间画一条红线（每 60s 刷新），
 * 正在进行的课程块同时描边，一眼看出上到第几节。
 */
export default function WeekGrid({
  week,
  periods,
  onEditCourse,
  compact = false,
  autoWeekend = false,
  showInactive = false,
  rowHeight: rowHeightOverride = null,
  showLocation = true,
  showTeacher = true,
  showCredit = false,
  showBreaks = true
}: WeekGridProps) {
  // 当前分钟数：定时刷新让指示线跟着时间走
  const [nowMin, setNowMin] = useState(() => {
    const n = new Date()
    return n.getHours() * 60 + n.getMinutes()
  })
  useEffect(() => {
    const t = setInterval(() => {
      const n = new Date()
      setNowMin(n.getHours() * 60 + n.getMinutes())
    }, 60_000)
    return () => clearInterval(t)
  }, [])

  /**
   * 布局模型：行高 + 纵向槽位表（节 / 分隔带）。
   *
   * 为什么把"槽位"单独算出来：分隔带会插入到节与节之间，其后所有节次的
   * 纵向偏移都会整体下移。课程块、时间轴、「现在」指示线三处都必须用
   * **同一套偏移**，否则会出现"块和它的时间对不上"这种最难查的错位。
   * 所以这里一次性算出 topOf(节次) 供三处共用。
   */
  const layout = useMemo(() => {
    let maxPeriod = 0
    for (const d of week.days) {
      for (const c of d.courses) {
        if (c.endPeriod > maxPeriod) maxPeriod = c.endPeriod
      }
      // 灰色（非本周）课程也可能排在更晚的节次上，行数要把它算进来，否则会被裁掉
      for (const c of d.inactiveCourses ?? []) {
        if (c.endPeriod > maxPeriod) maxPeriod = c.endPeriod
      }
    }
    // 节次表来自设置（默认 7 大节），课程排得更晚时以课程为准，保证不漏课
    const start = 1
    const end = Math.max(DEFAULT_ROWS, periods.length, maxPeriod, 1)
    const rows = Array.from({ length: end - start + 1 }, (_, i) => start + i)
    const n = rows.length

    /* 行高：用户滑杆 > 紧凑档自动 > 标准档自动。
       行数越多行高越小，完整显示的同时控制总高度。

       ⚠️ 光压行高是不够的：块内还有内边距 + 行距 + 三行内容，
       单节课的块压到 44px 时，长课名一折行就被 overflow:hidden 裁掉，
       观感上还几乎看不出"紧凑"（用户会以为开关没生效）。
       所以紧凑档必须**同时**收掉块内留白 —— 那部分在 styles.css 的
       `.weekgrid.compact .wg-block` 里，两处要一起改，别只动一边。 */
    const auto = compact
      ? n <= 4
        ? 54
        : n <= 6
          ? 50
          : 44
      : n <= 4
        ? 80
        : n <= 6
          ? 72
          : 64
    const rowHeight = rowHeightOverride != null && rowHeightOverride > 0 ? rowHeightOverride : auto

    // 节次时间表：轴要显示「开始 + 结束」两行，所以两个都要
    const times = new Map<number, { start: string; end: string }>()
    for (const p of periods) times.set(p.index, { start: p.start, end: p.end })

    // 分隔带：只在**相邻两节的实际时间间隔**够大时插一条（≥50min）
    const breaksBefore = new Map<number, string>()
    if (showBreaks) {
      for (let i = 0; i < rows.length - 1; i++) {
        const a = times.get(rows[i])
        const b = times.get(rows[i + 1])
        if (!a || !b || !isTime(a.end) || !isTime(b.start)) continue
        if (toMin(b.start) - toMin(a.end) < BREAK_MIN_GAP) continue
        /* 按下一节的开始时刻判断是哪一段休息：
           <12:00 算上午课间、12:00~17:00 算午休、≥17:00 算晚休。
           （用「下一节开始时间」而不是上一节结束时间，是因为 11:40 下课、
             13:30 上课这种作息，用下课时间会把午休判成"上午课间"。） */
        const hh = Number(b.start.slice(0, 2))
        breaksBefore.set(rows[i + 1], hh >= 17 ? '晚休' : hh >= 12 ? '午休' : '休息')
      }
    }

    const slots: Slot[] = []
    const topOf = new Map<number, number>()
    let acc = 0
    for (const p of rows) {
      const label = breaksBefore.get(p)
      if (label) {
        slots.push({ kind: 'b', label, h: BREAK_H })
        acc += BREAK_H
      }
      topOf.set(p, acc)
      slots.push({ kind: 'p', period: p, h: rowHeight })
      acc += rowHeight
    }
    return { start, end, rows, rowHeight, slots, topOf, totalH: acc, times }
  }, [week, periods, compact, rowHeightOverride, showBreaks])

  const { rowHeight, slots, topOf, times } = layout
  const nSlots = slots.length
  const axisW = compact ? AXIS_W_COMPACT : AXIS_W
  /** 第 p 节的下沿（含该节整行高度） */
  const bottomOf = (p: number) => (topOf.get(p) ?? 0) + rowHeight

  /**
   * 实际渲染的列。
   *
   * 「按需显示周末」只可能隐藏**周六、周日**（索引 5、6），工作日永远保留 ——
   * 工作日是课表的主体，哪怕没课也要留出位置（否则用户会以为"周一到周五被藏了"）。
   * 判断"有没有可见课程"时要把灰色课算进来：如果周末有课只是本周不上，
   * 藏掉反而让人以为那门课消失了。
   */
  const visibleDays = useMemo(() => {
    if (!autoWeekend) return week.days
    return week.days.filter((d, i) => {
      if (i < 5) return true
      if (d.courses.length > 0) return true
      if (showInactive && (d.inactiveCourses?.length ?? 0) > 0) return true
      return false
    })
  }, [week.days, autoWeekend, showInactive])

  const todayCol = visibleDays.findIndex((d) => d.isToday)

  /** 同一格里叠了多门课的起始节次 —— 用来在块右下角点一枚小圆点（竞品做法） */
  const stackedStarts = useMemo(() => {
    const s = new Set<string>()
    for (const d of visibleDays) {
      const seen = new Map<number, number>()
      for (const c of d.courses) seen.set(c.startPeriod, (seen.get(c.startPeriod) ?? 0) + 1)
      for (const [p, n] of seen) if (n > 1) s.add(`${d.date}#${p}`)
    }
    return s
  }, [visibleDays])

  /**
   * 「现在」指示线的定位：与课程块共用 topOf 偏移，
   * 因此线只出现在"今天"列，且时间落在第一节开始～最后一节结束之间；
   * 处于某节内按比例偏移，落在节次间隙（如午休）则吸附到下一节的开头。
   */
  const nowLine = useMemo(() => {
    if (todayCol < 0) return null
    const timed = periods.filter((p) => isTime(p.start) && isTime(p.end))
    if (timed.length === 0) return null
    const sorted = [...timed].sort((a, b) => a.index - b.index)
    const firstStart = toMin(sorted[0].start)
    const lastEnd = Math.max(...sorted.map((p) => toMin(p.end)))
    if (nowMin < firstStart || nowMin > lastEnd) return null
    let idx: number | null = null
    let frac = 0
    for (const p of sorted) {
      const s = toMin(p.start)
      const e = toMin(p.end)
      if (nowMin >= s && nowMin <= e) {
        idx = p.index
        frac = (nowMin - s) / Math.max(1, e - s)
        break
      }
    }
    if (idx === null) {
      // 节次间隙：吸附到下一个还没开始的节的开头
      const next = sorted.find((p) => toMin(p.start) > nowMin)
      if (!next) return null
      idx = next.index
      frac = 0
    }
    const base = topOf.get(idx)
    if (base == null) return null
    return { top: base + frac * rowHeight }
  }, [todayCol, periods, nowMin, topOf, rowHeight])

  return (
    <div className="weekgrid-scroll">
      <div
        className={`weekgrid${compact ? ' compact' : ''}`}
        style={{
          /* 天列一律 minmax(0, 1fr) 而不是 1fr：
             1fr 等价于 minmax(auto, 1fr)，那个 auto 下限取的是**内容最小宽度**，
             块内若是 nowrap 的长地点/教师名，就会把整列顶宽、把最后一天挤出屏幕。
             显式写 0 下限，列宽才完全由容器决定。 */
          gridTemplateColumns: `${axisW}px repeat(${visibleDays.length}, minmax(0, 1fr))`,
          /* 槽位表把分隔带也算进来，所以这里不能再用 repeat(n, h) */
          gridTemplateRows: `auto ${slots.map((s) => `${s.h}px`).join(' ')}`,
          /* ── 横滑策略（紧凑档 / 标准档的**根本差别**）────────────────────
             标准档：保留每列 76px 下限，列多到挤不下就允许横滑。读起来宽松，
                     代价是 430px 手机上只看得到 4 列半，周五要去划。
             紧凑档：minWidth 归 0，7 列平分容器宽度，**周一~周日一屏全在**，
                     不出现横向滚动条。这就是「紧凑视图」存在的意义 ——
                     用户点它图的是"一眼看全整周"，如果还要横滑，这个开关就白点了。
             另外 ≤5 列（开了「按需显示周末」且周末没课）时用 0 覆盖 CSS 里的下限，
             交给 1fr 摊满容器 —— 隐藏周末的初衷就是"少滑一点"，不能反而把它顶出屏幕。 */
          minWidth: !compact && visibleDays.length >= 6 ? axisW + visibleDays.length * COL_MIN : 0
        }}
      >
        {/* 左上角：本周提示（放假周没有教学周号，显示「放假」而不是「第0周」） */}
        <div className="wg-corner" style={{ gridRow: 1, gridColumn: 1 }}>
          {week.weekState === 'holiday' ? '放假' : week.weekNumber > 0 ? `第${week.weekNumber}周` : '—'}
        </div>

        {/* 星期表头 */}
        {visibleDays.map((d, idx) => (
          <div
            key={d.date}
            className={`wg-dow${idx === todayCol ? ' today' : ''}`}
            style={{ gridRow: 1, gridColumn: idx + 2 }}
          >
            <span className="wg-dow-name">{weekdayCN(d.weekday)}</span>
            <span className="wg-dow-date">{Number(d.date.slice(8, 10))}</span>
          </div>
        ))}

        {/* 时间轴列：节次 / 开始 / 结束 三行（竞品做法，开始时间由轴承担） */}
        {slots.map((s, i) =>
          s.kind !== 'p' ? null : (
            <div key={`ax-${s.period}`} className="wg-axis" style={{ gridRow: i + 2, gridColumn: 1 }}>
              <span className="wg-axis-p">{s.period}</span>
              {times.get(s.period) && (
                <>
                  <span className="wg-axis-t">{times.get(s.period)!.start}</span>
                  <span className="wg-axis-t wg-axis-end">{times.get(s.period)!.end}</span>
                </>
              )}
            </div>
          )
        )}

        {/* 午休 / 晚休通栏分隔带：横跨时间轴与所有天列 */}
        {showBreaks &&
          slots.map((s, i) =>
            s.kind !== 'b' ? null : (
              <div
                key={`br-${i}`}
                className="wg-break"
                style={{ gridRow: i + 2, gridColumn: '1 / -1' }}
                aria-hidden
              >
                <span className="wg-break-label">{s.label}</span>
              </div>
            )
          )}

        {/* 每一天内容列（跨 header 下的全部槽位行） */}
        {visibleDays.map((d, idx) => {
          const inactive = showInactive ? (d.inactiveCourses ?? []) : []
          const has = d.courses.length > 0 || inactive.length > 0
          return (
            <div
              key={d.date}
              className={`wg-day${idx === todayCol ? ' today' : ''}${idx % 2 ? ' alt' : ''}${has ? '' : ' empty'}`}
              style={{ gridRow: `2 / span ${nSlots}`, gridColumn: idx + 2 }}
            >
              {!has && (
                <div className="wg-empty-row">
                  <span>—</span>
                </div>
              )}
              {/* 灰色块先画：本周的课永远盖在它上面，不会出现"灰块挡住真课" */}
              {inactive.map((c, i) => {
                const top = topOf.get(c.startPeriod) ?? 0
                const h = Math.max(rowHeight - BLOCK_GAP, bottomOf(c.endPeriod) - top - BLOCK_GAP)
                return (
                  <div
                    key={`inactive-${c.id}-${i}`}
                    className="wg-block inactive"
                    style={{ top, height: h, '--c': '#9e9e9e' } as CSSProperties}
                    title={`${c.name}（本周不上）`}
                  >
                    <span className="wg-block-name">{c.name}</span>
                  </div>
                )
              })}
              {d.courses.map((c) => {
                const top = topOf.get(c.startPeriod) ?? 0
                const h = Math.max(rowHeight - BLOCK_GAP, bottomOf(c.endPeriod) - top - BLOCK_GAP)
                // 今天这列里正在进行中的课：描边提示
                const ongoing =
                  idx === todayCol &&
                  isTime(c.startTime) &&
                  isTime(c.endTime) &&
                  nowMin >= toMin(c.startTime) &&
                  nowMin <= toMin(c.endTime)
                const stacked = stackedStarts.has(`${d.date}#${c.startPeriod}`)
                return (
                  <button
                    key={c.id}
                    className={`wg-block${ongoing ? ' ongoing' : ''}`}
                    style={
                      {
                        top,
                        height: h,
                        /* 课程色 + 低饱和同色底都由 CSS 读这两个变量，
                           文字色在深/浅主题下分别派生（见 styles.css） */
                        '--c': c.color,
                        '--c-bg': hexToRgba(c.color, 0.16)
                      } as CSSProperties
                    }
                    onClick={() => onEditCourse(c)}
                    title={`${c.name}${c.location ? ' · ' + c.location : ''}${c.teacher ? ' · ' + c.teacher : ''}`}
                  >
                    <span className="wg-block-name">{c.name}</span>
                    {(showLocation && c.location) || (showTeacher && c.teacher) || showCredit ? (
                      <span className="wg-block-meta">
                        {showLocation && c.location && <span className="wg-block-loc">@{c.location}</span>}
                        {showTeacher && c.teacher && <span className="wg-block-teacher">{c.teacher}</span>}
                        {showCredit && c.credits != null && (
                          <span className="wg-block-credit">{c.credits}学分</span>
                        )}
                      </span>
                    ) : null}
                    {stacked && <span className="wg-block-dot" aria-hidden />}
                  </button>
                )
              })}
              {idx === todayCol && nowLine && (
                <div className="wg-now" style={{ top: nowLine.top }} aria-hidden>
                  <span className="wg-now-dot" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
