/**
 * 校历（「应用」→ 学习）。
 *
 * ## 两个数据源，分工明确
 *
 * 1. **学校权威校历**（`GET /api/calendar/academic`，免登录）——
 *    `bksy.bjtu.edu.cn/Admin/SemesterTranPage.aspx` 公开的学业日历。
 *    它能回答本地数据回答不了的两件事：
 *      - 某周是「休」（学校明确放假，如国庆、校运会）还是「压根不是学期内」；
 *      - 学期第一周周一是哪天 —— 用户填错开学日时这是唯一能对照的基准。
 *
 * 2. **本地周次表**（`settings.semester.weeks`）—— 导入课表时一并拿到的
 *    「第 N 周 ↔ 日期」映射，周视图靠它换算教学周。
 *
 * 两者**都显示**，不互相覆盖：本地表是用户课表的实际口径（改了会牵动
 * 全部课程周次），权威校历是事实基准。当两者对不上时给出提示，让用户
 * 自己去「设置 → 学期设置」核对，而不是由我们偷偷改数据。
 *
 * 为什么不做「下载 PDF 校历」：学校官方校历是公众号图文 / 图片，
 * 服务端代抓要处理图片代理与版权问题，收益低。这里改为**可导出 .ics**，
 * 用户可以导入手机日历 —— 对"知道哪天放假"这个真实需求来说更实用。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Settings, SemesterWeek } from '../../types'
import type { AcademicCalendarPayload, AcademicWeek } from '../../api'
import { getAcademicCalendar, getSettings } from '../../api'
import { saveBlob } from '../../lib/saveFile'
import { IconDownload, IconRefresh } from '../../icons'
import AppShell from './AppShell'
import AppState from './AppState'
import type { AppEntryHostProps } from './types'

/** 周次 → 中文日期（"3/2"） */
function md(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${Number(m[2])}/${Number(m[3])}`
}

/** 判断"今天"是否落在这一周内 */
function isCurrentWeek(w: SemesterWeek, today: string): boolean {
  return today >= w.beginDate && today <= w.endDate
}

/** 权威周的状态文案 */
const KIND_LABEL: Record<AcademicWeek['kind'], string> = {
  teaching: '教学周',
  holiday: '放假',
  gap: '非学期'
}

export default function CalendarApp({ onBack, onToast }: AppEntryHostProps) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [official, setOfficial] = useState<AcademicCalendarPayload | null>(null)
  const [officialError, setOfficialError] = useState<string | null>(null)
  const [officialLoading, setOfficialLoading] = useState(true)
  /** 手动刷新权威校历的计数器（失败后用户点重试） */
  const [officialNonce, setOfficialNonce] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await getSettings()
        if (alive) setSettings(s)
      } catch (e) {
        if (alive) onToast(e instanceof Error ? e.message : '加载校历失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [onToast])

  /* 权威校历独立请求：它挂了不能连带本地周次表一起白屏 ——
     本地表才是课表换算的依据，学校站点抽风是常态。 */
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setOfficialLoading(true)
    void (async () => {
      try {
        const r = await getAcademicCalendar(ac.signal)
        if (!alive) return
        setOfficial(r)
        setOfficialError(null)
      } catch (e) {
        if (!alive || ac.signal.aborted) return
        setOfficialError(e instanceof Error ? e.message : '校历服务不可用')
        setOfficial(null)
      } finally {
        if (alive) setOfficialLoading(false)
      }
    })()
    return () => {
      alive = false
      ac.abort()
    }
  }, [officialNonce])

  const weeks = settings?.semester?.weeks ?? null
  const today = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }, [])

  const teachingWeeks = (weeks ?? []).filter((w) => w.week >= 1 && w.hasClass)
  const holidayWeeks = (weeks ?? []).filter((w) => !w.hasClass)

  /**
   * 开学日是否与权威校历一致。
   *
   * 只比较"第一个教学周的周一"，错开一天以内不算不一致（用户可能手填成
   * 学期第一周的周日）。判断放在这里而不是服务端：服务端不知道用户填了什么。
   */
  const startDateMismatch = useMemo(() => {
    const localStart = settings?.semester?.startDate
    const officialStart = official?.current?.firstMonday
    if (!localStart || !officialStart || !weeks || weeks.length === 0) return null
    if (localStart === officialStart) return null
    return { local: localStart, official: officialStart }
  }, [settings, official, weeks])

  /** 导出 .ics（整学期每个教学周一条全天事件） */
  async function exportIcs() {
    if (!weeks || weeks.length === 0) return
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//bjtu-helper//calendar//CN',
      'CALSCALE:GREGORIAN'
    ]
    for (const w of weeks) {
      const start = w.beginDate.replace(/-/g, '')
      // DTEND 是排他的：用 endDate +1 天才是"这一周结束"
      const d = new Date(`${w.endDate}T00:00:00`)
      d.setDate(d.getDate() + 1)
      const p = (n: number) => String(n).padStart(2, '0')
      const endExclusive = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
      const title = w.hasClass ? `第 ${w.week} 周` : '假期（无课周）'
      lines.push(
        'BEGIN:VEVENT',
        `UID:bjtu-week-${w.week}-${start}@bjtu-helper`,
        `DTSTAMP:${start}T000000Z`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${endExclusive}`,
        `SUMMARY:${title}`,
        'END:VEVENT'
      )
    }
    lines.push('END:VCALENDAR')

    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' })
    /* ⚠️ 走 saveBlob：Android WebView 里 <a download> 点了没反应。
       .ics 尤其重要 —— App 用户导出后要能真的在文件管理器里找到它再导入日历。 */
    const r = await saveBlob(blob, `${settings?.semester?.name ?? '校历'}.ics`)
    onToast(r.ok ? '已导出，可导入手机日历' : r.message)
  }

  if (loading) {
    return (
      <AppShell title="校历" onBack={onBack}>
        <AppState kind="loading" title="正在加载周次表…" />
      </AppShell>
    )
  }

  /* 权威校历区块（本地周次表缺失时也显示 —— 这可能是用户唯一的周次来源） */
  const officialSection = (
    <section className="apps-group">
      <div className="profile-section-title">学校权威校历</div>
      {officialLoading ? (
        <AppState kind="loading" title="正在查询学校校历…" />
      ) : officialError ? (
        <AppState
          kind="error"
          title="学校校历暂时不可用"
          hint={`${officialError}。下面的本地周次表仍然可用，只是没有「放假周」的权威判断。`}
          onRetry={() => setOfficialNonce((n) => n + 1)}
          retryLabel="重试"
        />
      ) : official?.current ? (
        <>
          <div className="cal-official-head">
            <span className="cal-official-title">{official.current.title}</span>
            {official.week && (
              <span className="cal-official-week">
                {official.week.kind === 'teaching'
                  ? `第 ${official.week.teachingWeek} 教学周`
                  : official.week.kind === 'holiday'
                    ? '放假周'
                    : '非教学周'}
              </span>
            )}
          </div>
          <div className="cal-official-meta">
            共 {official.current.totalWeeks} 个教学周 · 第一周周一{' '}
            {official.current.firstMonday ? md(official.current.firstMonday) : '未知'}
          </div>
          {/* 与本地周次表对照：只提示，不自动改 —— 改开学日会牵动全部课程周次 */}
          {startDateMismatch && (
            <div className="cal-warn">
              本地学期开学日是 {md(startDateMismatch.local)}，学校校历第一周周一是{' '}
              {md(startDateMismatch.official)}，相差{' '}
              {Math.abs(
                Math.round(
                  (new Date(`${startDateMismatch.local}T00:00:00`).getTime() -
                    new Date(`${startDateMismatch.official}T00:00:00`).getTime()) /
                    86400000
                )
              )}{' '}
              天。周次可能整体偏一周，可到「设置 → 学期设置」核对。
            </div>
          )}
          <div className="cal-active-week">
            <span className="cal-active-label">本周</span>
            <span className="cal-active-range">
              {md(official.week?.monday ?? official.today)} – {md(official.week?.sunday ?? official.today)}
            </span>
            {official.week && (
              <span className={`cal-active-kind is-${official.week.kind}`}>{KIND_LABEL[official.week.kind]}</span>
            )}
          </div>
        </>
      ) : (
        <AppState kind="empty" title="当前日期不在任何学期内" hint="学校校历里没有覆盖今天的学期，可能是假期。" />
      )}
      <button
        type="button"
        className="btn-ghost cal-refresh"
        onClick={() => setOfficialNonce((n) => n + 1)}
        disabled={officialLoading}
      >
        <IconRefresh size={15} />
        {officialLoading ? '刷新中…' : '刷新校历'}
      </button>
    </section>
  )

  if (!weeks || weeks.length === 0) {
    return (
      <AppShell title="校历" onBack={onBack}>
        {officialSection}
        <AppState
          kind="empty"
          title="还没有本地周次数据"
          hint="到「应用 → 数据同步」或课表页导入一次课表，就会一并拿到本学期的周次表。"
        />
      </AppShell>
    )
  }

  return (
    <AppShell
      title="校历"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" onClick={() => void exportIcs()} aria-label="导出日历" title="导出 .ics">
          <IconDownload size={19} />
        </button>
      }
      lead={`${settings?.semester?.name ?? '本学期'} · 共 ${weeks.length} 周（教学 ${teachingWeeks.length} 周）`}
    >
      {officialSection}

      <section className="apps-group">
        <div className="profile-section-title">本地周次表</div>
        <div className="cal-list">
          {weeks.map((w) => {
            const cur = isCurrentWeek(w, today)
            return (
              <div key={`${w.week}-${w.beginDate}`} className={`cal-row${cur ? ' is-current' : ''}${w.hasClass ? '' : ' is-holiday'}`}>
                <span className="cal-week">{w.hasClass ? `第 ${w.week} 周` : '假期'}</span>
                <span className="cal-range">
                  {md(w.beginDate)} – {md(w.endDate)}
                </span>
                {cur && <span className="cal-now">本周</span>}
              </div>
            )
          })}
        </div>
      </section>

      {holidayWeeks.length > 0 && (
        <div className="app-note">
          标记为「假期」的周次学校不排课、也不算教学周，因此周次与日期的对应不会因放假而整体错位。
        </div>
      )}
    </AppShell>
  )
}
