/**
 * 物理实验 —— wlsy.bjtu.edu.cn（ASP.NET WebForms，GBK 编码）的实验安排。
 *
 * 数据形态与 CITEL / 物理在线完全不同：这里不是 Moodle，没有「作业」概念，
 * 只有一张「我已选/待上的物理实验」表（日期 × 节次 × 实验名 × 地点 × 教师）。
 * 上游 KMP 项目里它挂在「实验」分类下，与演示实验并列但互不相干：
 *   物理实验 = 教务处实验选课系统的常规实验课；
 *   演示实验 = physpace 上的演示实验室预约（见 PhyDemoApp）。
 *
 * 服务端把 GBK 页面解码 + 解析成条目数组，这里按日期分组展示，
 * 节次时间用服务端下发的 PHYSICS_LAB_TIME_RANGES 对齐显示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from './AppShell'
import AppState from './AppState'
import PlatformAccountGate from './PlatformAccountGate'
import { AppEntryHostProps } from './types'
import { getPhysicsLabs, PHYSICS_LAB_TIME_RANGES, type PhysicsLab } from '../../api'
import { IconRefresh } from '../../icons'
import { LabAddAllBar, LabAddButtons, LabAddNoticeBar, LabRemoveBar, useLabAdder } from './LabAddToSchedule'

function periodLabel(p: number): string {
  const range = PHYSICS_LAB_TIME_RANGES[p - 1]
  return range ? `第 ${p} 节（${range}）` : `第 ${p} 节`
}

function dayKey(sec: number): string {
  const d = new Date(sec * 1000)
  if (isNaN(d.getTime())) return '时间未知'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function PhysicsLabApp({ onBack }: AppEntryHostProps) {
  const [tick, setTick] = useState(0)
  return (
    <AppShell
      title="物理实验"
      onBack={onBack}
      action={
        <button type="button" className="icon-btn" aria-label="刷新" onClick={() => setTick((t) => t + 1)}>
          <IconRefresh />
        </button>
      }
    >
      <PlatformAccountGate
        platform="physicslab"
        lead="物理实验（wlsy.bjtu.edu.cn）是教务的实验选课系统，账号与教务系统不通用，需要单独绑定一次。"
      >
        <PhysicsLabBody key={tick} />
      </PlatformAccountGate>
    </AppShell>
  )
}

function PhysicsLabBody() {
  const [labs, setLabs] = useState<PhysicsLab[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /* 「加入课表 / DDL」的状态与请求都在共享 hook 里（与演示实验页同一份实现） */
  const adder = useLabAdder('physicslab')

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError('')
    try {
      const r = await getPhysicsLabs(force)
      setLabs(r.data)
    } catch (err) {
      setLabs(null)
      setError(err instanceof Error ? err.message : '物理实验数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  /* 按日期分组，同一天内按节次排序；未来的日期在前（最近的实验最相关） */
  const days = useMemo(() => {
    const byDay = new Map<string, PhysicsLab[]>()
    for (const l of labs ?? []) {
      const k = dayKey(l.date)
      const arr = byDay.get(k)
      if (arr) arr.push(l)
      else byDay.set(k, [l])
    }
    const nowSec = Date.now() / 1000
    return [...byDay.entries()]
      .map(([day, items]) => ({ day, items: items.sort((a, b) => a.period - b.period), future: items[0].date >= nowSec }))
      .sort((a, b) => {
        if (a.future !== b.future) return a.future ? -1 : 1
        return a.future ? a.day.localeCompare(b.day) : b.day.localeCompare(a.day)
      })
  }, [labs])

  /* 批量加入只统计"今天及以后"的，与服务端默认口径一致（过去的实验加进课表没有意义） */
  const upcoming = useMemo(() => {
    const nowSec = Date.now() / 1000
    return (labs ?? []).filter((l) => l.date >= nowSec)
  }, [labs])

  if (loading && !labs) {
    return <AppState kind="loading" title="正在从物理实验系统拉取安排…" />
  }

  if (error) {
    return <AppState kind="error" title="物理实验数据加载失败" hint={error} onRetry={() => void load(true)} retryLabel="重试" />
  }

  return (
    <>
      <div className="plat-summary">
        <span>共 {(labs ?? []).length} 次实验</span>
        <button type="button" className="btn-ghost plat-summary-force" onClick={() => void load(true)} disabled={loading}>
          {loading ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      {(labs ?? []).length > 0 && <LabAddAllBar adder={adder} count={upcoming.length} />}
      {(labs ?? []).length > 0 && <LabRemoveBar adder={adder} label="物理实验" />}
      <LabAddNoticeBar notice={adder.notice} onClose={() => adder.setNotice(null)} />

      {days.length === 0 && (
        <AppState kind="empty" title="没有查到物理实验安排" hint="如果你确实选了实验课，可能是账号不对，或学校页面暂时打不开。" />
      )}

      {days.map((d) => (
        <section className="plat-group" key={d.day}>
          <div className="plat-group-head is-static">
            <span className="plat-group-name">{d.day}</span>
            <span className="plat-group-meta">{d.future ? '待进行' : '已结束'}</span>
          </div>
          {d.items.map((l, i) => (
            <article className="plat-task" key={`${l.date}-${l.period}-${i}`}>
              <div className="plat-task-head">
                <span className="plat-task-title">{l.name}</span>
              </div>
              <div className="plat-task-badges">
                <span className="tag is-kind">{periodLabel(l.period)}</span>
                {l.location && <span className="tag">{l.location}</span>}
                {l.teacher && <span className="tag">{l.teacher}</span>}
              </div>
              {/* 已结束的实验不给「加入」按钮：加进课表/DDL 都没有意义（服务端也会忽略过去的） */}
              {d.future && <LabAddButtons adder={adder} item={l} />}
            </article>
          ))}
        </section>
      ))}

      <p className="app-hint">
        数据来自物理实验选课系统（wlsy.bjtu.edu.cn，GBK 页面），服务端缓存 5 分钟。
        选课、退课与请假请以原系统为准。
      </p>
    </>
  )
}
