/**
 * 演示实验预约 —— physpace.bjtu.edu.cn:8089/phydemo 的「我已预约」列表。
 *
 * 与物理实验（wlsy）的区别：演示实验是物理教学实验中心的**演示实验室**，
 * 在自建系统上预约（不是 Moodle、也不是 WebForms），账号独立。
 * 上游 KMP 项目只展示预约结果，不做预约动作 —— 本页同样只读：
 * 预约/取消要跳原系统，见页面底部链接。
 *
 * 实验名只有「光学」「近代与综合」两类（服务端白名单 PHYSICS_DEMO_NAMES），
 * 时段是固定的 6 个（PHYSICS_DEMO_TIMES），解析失败的服务端会丢弃而不是瞎猜。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from './AppShell'
import AppState from './AppState'
import PlatformAccountGate from './PlatformAccountGate'
import { AppEntryHostProps } from './types'
import { getPhyDemoBookings, PHYSICS_DEMO_TIMES, type PhysicsDemoBooking } from '../../api'
import { IconRefresh } from '../../icons'
import { LabAddAllBar, LabAddButtons, LabAddNoticeBar, LabRemoveBar, useLabAdder } from './LabAddToSchedule'

const PHYDEMO_ORIGIN = 'https://physpace.bjtu.edu.cn:8089/phydemo/'

function periodLabel(p: number): string {
  const range = PHYSICS_DEMO_TIMES[p - 1]
  return range ? `${range}` : `时段 ${p}`
}

function dayKey(sec: number): string {
  const d = new Date(sec * 1000)
  if (isNaN(d.getTime())) return '时间未知'
  const p = (n: number) => String(n).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 周${week}`
}

export default function PhyDemoApp({ onBack }: AppEntryHostProps) {
  const [tick, setTick] = useState(0)
  return (
    <AppShell
      title="演示实验预约"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" aria-label="刷新" onClick={() => setTick((t) => t + 1)}>
          <IconRefresh />
        </button>
      }
    >
      <PlatformAccountGate
        platform="phydemo"
        lead="演示实验（physpace.bjtu.edu.cn:8089/phydemo）是物理教学实验中心的演示实验室预约系统，账号独立，需要单独绑定一次。"
      >
        <PhyDemoBody key={tick} />
      </PlatformAccountGate>
    </AppShell>
  )
}

function PhyDemoBody() {
  const [bookings, setBookings] = useState<PhysicsDemoBooking[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /* 「加入课表 / DDL」的状态与请求都在共享 hook 里（与物理实验页同一份实现） */
  const adder = useLabAdder('phydemo')

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError('')
    try {
      const r = await getPhyDemoBookings(force)
      setBookings(r.data)
    } catch (err) {
      setBookings(null)
      setError(err instanceof Error ? err.message : '演示实验数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  /* 按日期分组，最近的在前 */
  const days = useMemo(() => {
    const byDay = new Map<string, PhysicsDemoBooking[]>()
    for (const b of bookings ?? []) {
      const k = dayKey(b.date)
      const arr = byDay.get(k)
      if (arr) arr.push(b)
      else byDay.set(k, [b])
    }
    return [...byDay.entries()]
      .map(([day, items]) => ({ day, items: items.sort((a, b) => a.period - b.period) }))
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [bookings])

  /* 批量加入只统计"今天及以后"的，与服务端默认口径一致 */
  const upcoming = useMemo(() => {
    const nowSec = Date.now() / 1000
    return (bookings ?? []).filter((b) => b.date >= nowSec)
  }, [bookings])

  if (loading && !bookings) {
    return <AppState kind="loading" title="正在查询演示实验预约…" />
  }

  if (error) {
    return <AppState kind="error" title="演示实验数据加载失败" hint={error} onRetry={() => void load(true)} retryLabel="重试" />
  }

  return (
    <>
      <div className="plat-summary">
        <span>共 {(bookings ?? []).length} 次预约</span>
        <button type="button" className="btn-ghost plat-summary-force" onClick={() => void load(true)} disabled={loading}>
          {loading ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      {(bookings ?? []).length > 0 && <LabAddAllBar adder={adder} count={upcoming.length} />}
      {(bookings ?? []).length > 0 && <LabRemoveBar adder={adder} label="演示实验" />}
      <LabAddNoticeBar notice={adder.notice} onClose={() => adder.setNotice(null)} />

      {days.length === 0 && (
        <AppState kind="empty" title="没有查到演示实验预约" hint="如果你预约过，可能是账号不对；新预约请到演示实验系统完成。" />
      )}

      {days.map((d) => (
        <section className="plat-group" key={d.day}>
          <div className="plat-group-head is-static">
            <span className="plat-group-name">{d.day}</span>
            <span className="plat-group-meta">{d.items.length} 节</span>
          </div>
          {d.items.map((b, i) => {
            const future = b.date >= Date.now() / 1000
            return (
              <article className="plat-task" key={`${b.date}-${b.period}-${i}`}>
                <div className="plat-task-head">
                  <span className="plat-task-title">{b.name}</span>
                </div>
                <div className="plat-task-badges">
                  <span className="tag is-kind">{periodLabel(b.period)}</span>
                  {b.teacher && <span className="tag">{b.teacher}</span>}
                </div>
                {/* 已结束的预约不给「加入」按钮（服务端也会忽略过去的） */}
                {future && <LabAddButtons adder={adder} item={b} />}
              </article>
            )
          })}
        </section>
      ))}

      <p className="app-hint">
        数据来自演示实验预约系统（physpace.bjtu.edu.cn:8089/phydemo），服务端缓存 5 分钟，本页只读。
        预约与取消请到
        <a href={PHYDEMO_ORIGIN} target="_blank" rel="noreferrer">演示实验系统</a>
        完成。
      </p>
    </>
  )
}
