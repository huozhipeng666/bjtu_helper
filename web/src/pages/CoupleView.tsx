/**
 * 情侣课表（设计稿图4）。
 *
 * 与「空闲课表」的关系：同一套群组模型（share_groups.kind = 'couple'，固定 2 人），
 * 差别只在**多了一个可选的信息层** —— 双方各自决定要不要把课程明细（课名/地点/教师）给对方看。
 * 所以这个页面能画出「TA 的课程」，而群组页只能画出"谁有空"。
 *
 * 为什么不做成"空闲课表"的一个 tab：两者的**核心问题**不同。
 *   空闲课表问的是"我们几个什么时候都有空"（N 人，协作排期）；
 *   情侣课表问的是"我们现在能不能见面 / 下次见面是什么时候"（2 人，日常节奏）。
 *   后者要的是"现在""今天""明天"这种即时视角，塞进前者的周网格里会两头都不好用。
 *
 * ## 「共同计划」的数据一致性（改造后）
 *
 * 计划是**服务端权威**的双人共享实体（`share_plans` 表，见 server/src/plans.ts）：
 *   - 双方看到的是同一条记录，不是各存一份副本；
 *   - 发起 / 接受 / 婉拒 / 改期 / 取消都会给对方投站内信；
 *   - 状态机由服务端判定，写操作返回整条 plan，本页**直接用它覆盖本地状态**，
 *     不做乐观猜测 —— 猜错会造成"我这边已确认、对方那边还待确认"的假一致。
 *
 * 刷新时机（三重保证对方改动能被我看到）：
 *   ① 进入页面时拉一次（`load`）；
 *   ② 每次切到「共同计划」Tab 时再拉一次（对方可能刚在别的设备上确认过）；
 *   ③ 本页任何写操作成功后用返回值就地更新，并顺带静默重拉一次（对齐对方可能的并发改动）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CouplePlan, PlanStatus, ShareDetail, ShareGroupSummary, ShareMemberView } from '../types'
import {
  cancelCouplePlan, createCouple, createCouplePlan, createTask, getCouple, joinCouple,
  listCouplePlans, respondCouplePlan, setSharePrivacy, syncShareGroup, unbindCouple, updateCouplePlan, updateShareGroup
} from '../api'
import { useBackStep } from '../lib/back'
import { addDays, daysBetween, parseISODate, toISODate, weekdayCN } from '../lib/date'
import { useNowMinute } from '../lib/useNowMinute'
import Modal from '../components/Modal'
import Switch from '../components/Switch'
import { IconBolt, IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconClose, IconHeart, IconMapPin, IconPlus, IconShare } from '../icons'

interface CoupleViewProps {
  onBack: () => void
  onToast: (msg: string) => void
  /** 游客由 App 统一引导登录；返回 false 表示已弹登录层 */
  onRequireLogin?: () => boolean
  /** 新建了 DDL（"约这个时间"）后让 App 刷新其它页面 */
  onMutated?: () => void
  /**
   * 进入时默认停在哪个页签。
   * 从「消息通知」里的共同计划通知点进来时传 `'plan'` —— 用户点的是"某个计划"的通知，
   * 落在「今日」还要他自己再切一次 tab，是多余的一步。
   */
  initialTab?: Tab
}

/** 一个"共同空闲时段" */
interface FreeSlot {
  weekday: number
  startPeriod: number
  endPeriod: number
  startTime: string
  endTime: string
}

/**
 * 发起/编辑计划的表单草稿。
 * 与 CouplePlan 分开：草稿里的时间可能只填了一部分、可能不合法，
 * 用同一套类型会让人误以为草稿可以直接当计划用。
 */
interface PlanDraft {
  title: string
  planDate: string
  startTime: string
  endTime: string
  location: string
  note: string
}

type Tab = 'today' | 'free' | 'plan'
type Sub = null | 'countdown' | 'compare'

const TABS: { key: Tab; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'free', label: '一起有空' },
  { key: 'plan', label: '共同计划' }
]

/** 今天的星期（1=周一 … 7=周日） */
function todayWeekday(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

/** 某个日期属于哪个教学周（不在任何教学周内时返回 null，例如放假周） */
function weekOf(detail: ShareDetail, iso: string): number | null {
  const hit = detail.weekOptions.find((o) => o.week !== null && iso >= o.beginDate && iso <= o.endDate)
  return hit?.week ?? null
}

/**
 * 把「第 N 教学周的星期 W」换算成具体日期（YYYY-MM-DD）。
 *
 * 为什么不能直接用「今天 + (W - 今天星期)」：空闲时段是挂在**教学周**上的
 * （viewWeek），而用户看到的"本周"可能是放假周或跨周的。
 * 用教学周的起始日（周一）加上偏移才是正确的日期 —— 直接按自然周推算，
 * 会在放假周之后整体偏一周（这正是本项目在课表周次上踩过的同一个坑）。
 */
function slotDateOf(detail: ShareDetail, week: number | null, weekday: number): string {
  const opt = week == null ? null : detail.weekOptions.find((o) => o.week === week)
  if (!opt) return toISODate(new Date())
  return toISODate(addDays(parseISODate(opt.beginDate), weekday - 1))
}

/** 某成员在某教学周某天是否被占用 */
function isBusy(m: ShareMemberView, week: number, weekday: number, period: number): boolean {
  const ranges = m.busy[String(week)]?.[String(weekday)]
  if (!ranges || ranges.length === 0) return false
  return ranges.some(([s, e]) => period >= s && period <= e)
}

/**
 * 算出某天双方都空闲的**连续时段**。
 * 必须合并连续节次再换算成时间：逐节列出来会得到"09:55-10:35、10:40-11:20"这种碎片，
 * 而用户想知道的是"我们 09:55 到 11:20 都有空"。
 */
function freeSlots(detail: ShareDetail, week: number, weekday: number): FreeSlot[] {
  const two = detail.members.filter((m) => m.synced && m.sameTerm)
  if (two.length < 2) return []
  const rows = detail.periods
  if (rows.length === 0) return []
  const free: number[] = []
  for (const p of rows) {
    const busy = two.some((m) => isBusy(m, week, weekday, p.index))
    if (!busy) free.push(p.index)
  }
  const out: FreeSlot[] = []
  let i = 0
  while (i < free.length) {
    let j = i
    while (j + 1 < free.length && free[j + 1] === free[j] + 1) j++
    const startP = free[i]
    const endP = free[j]
    const sp = rows.find((r) => r.index === startP)
    const ep = rows.find((r) => r.index === endP)
    out.push({
      weekday,
      startPeriod: startP,
      endPeriod: endP,
      startTime: sp?.start ?? '',
      endTime: ep?.end ?? ''
    })
    i = j + 1
  }
  return out
}

/** 某成员"此刻"的状态：正在上哪门课 / 下一节课几点开始 */
function currentState(m: ShareMemberView | undefined, week: number, weekday: number, hm: string) {
  if (!m) return { busy: false, text: '课表未同步' }
  const today = m.courses.filter((c) => c.dayOfWeek === weekday && (c.weeks.length === 0 || c.weeks.includes(week)))
  const sorted = [...today].sort((a, b) => a.startPeriod - b.startPeriod)
  const ongoing = sorted.find((c) => c.startTime && c.endTime && hm >= c.startTime && hm <= c.endTime)
  if (ongoing) return { busy: true, text: `正在上 ${ongoing.name}` }
  const next = sorted.find((c) => c.startTime && c.startTime > hm)
  if (next) return { busy: false, text: `${next.startTime} 开始 ${next.name}` }
  return { busy: false, text: '今天没有课了' }
}

function fmtDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`
}

/* ---------------- 共同计划的状态展示口径 ----------------
   状态文案与配色集中在两处（这里 + styles.css 的 .plan-badge），
   新增状态只需在这两个地方各加一项，不会散落在各个 JSX 分支里。 */
const PLAN_STATUS_TEXT: Record<PlanStatus, string> = {
  pending: '待确认',
  accepted: '已确认',
  declined: '已婉拒',
  cancelled: '已取消'
}

/** 计划是否"已经结束"（决定它沉底、并以灰调展示） */
function isPlanClosed(p: CouplePlan): boolean {
  return p.status === 'declined' || p.status === 'cancelled'
}

/** 计划的时间文案：「5月20日 14:00-16:00 · 图书馆」 */
function planWhen(p: CouplePlan): string {
  const d = fmtDay(p.planDate)
  if (!p.startTime) return d
  return p.endTime ? `${d} ${p.startTime}-${p.endTime}` : `${d} ${p.startTime}`
}

/** 距今天还有几天（负数 = 已过） */
function planDaysAway(p: CouplePlan): number {
  return daysBetween(toISODate(new Date()), p.planDate)
}

export default function CoupleView({ onBack, onToast, onRequireLogin, onMutated, initialTab }: CoupleViewProps) {
  const [couple, setCouple] = useState<ShareGroupSummary | null>(null)
  const [detail, setDetail] = useState<ShareDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const [sub, setSub] = useState<Sub>(null)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'today')
  const [dayOffset, setDayOffset] = useState(0)

  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [secretDraft, setSecretDraft] = useState('')
  const [dialogErr, setDialogErr] = useState('')
  const [privacyOpen, setPrivacyOpen] = useState(false)

  /* ---- 共同计划 ---- */
  const [plans, setPlans] = useState<CouplePlan[]>([])
  const [plansLoading, setPlansLoading] = useState(false)
  /** 正在发起计划的初始值：从空闲时段点「约这个时间」时预填日期与起止时间 */
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null)
  /** 正在编辑的计划（null = 新建）；编辑复用同一个弹层，字段与新建一致 */
  const [planEditingId, setPlanEditingId] = useState<number | null>(null)
  /** 单条计划正在提交（接受/婉拒/取消），避免重复点击 */
  const [planBusyId, setPlanBusyId] = useState<number | null>(null)

  useBackStep(sub !== null, () => setSub(null))

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await getCouple()
      setCouple(r.couple)
      setDetail(r.detail ?? null)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 拉取共同计划。
   *
   * `silent` 用于写操作后的对齐刷新（不闪 loading，避免列表整块跳动）。
   * 单独一个函数而不是塞进 load()：计划接口在未绑定时返回空数组而非报错，
   * 与 getCouple 的"未绑定"分支解耦，绑定失败也不会连带把计划列表清空。
   */
  const loadPlans = useCallback(async (silent = false) => {
    if (!silent) setPlansLoading(true)
    try {
      const r = await listCouplePlans()
      setPlans(r.plans)
    } catch {
      /* 计划拉取失败不覆盖已有列表：用户上一秒看到的计划不该因为一次网络抖动消失 */
    } finally {
      if (!silent) setPlansLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* 绑定关系就绪后拉一次计划 */
  useEffect(() => {
    if (couple) void loadPlans()
  }, [couple, loadPlans])

  /* 切到「共同计划」Tab 时再拉一次 —— 对方可能刚在别的设备上发起或确认了计划 */
  useEffect(() => {
    if (tab === 'plan') void loadPlans(true)
  }, [tab, loadPlans])

  const me = detail?.members.find((m) => m.isMe)
  const partner = detail?.members.find((m) => !m.isMe)
  const today = toISODate(new Date())
  const viewDate = toISODate(addDays(parseISODate(today), dayOffset))
  /* 评审 C7：用 useNowMinute 的时钟（30s 步进 + 回前台对齐）代替渲染期读表的 nowHM()，
     「正在上 X 课」不再停在页面打开时刻。dayOffset===0 时星期也跟着真实时钟走。 */
  const nowClock = useNowMinute()
  const viewWeekday = dayOffset === 0 ? nowClock.weekday : (nowClock.weekday + dayOffset - 1) % 7 + 1
  const viewWeek = detail ? weekOf(detail, viewDate) : null

  const todaySlots = useMemo(
    () => (detail && viewWeek != null ? freeSlots(detail, viewWeek, viewWeekday) : []),
    [detail, viewWeek, viewWeekday]
  )

  const weekSlots = useMemo(() => {
    if (!detail || viewWeek == null) return [] as FreeSlot[]
    const out: FreeSlot[] = []
    for (let wd = 1; wd <= 7; wd++) out.push(...freeSlots(detail, viewWeek, wd))
    return out
  }, [detail, viewWeek])

  /* ---------------- 绑定流程 ---------------- */

  async function doCreate() {
    if (onRequireLogin && !onRequireLogin()) return
    setBusy(true)
    setDialogErr('')
    try {
      const r = await createCouple('我和 TA')
      setCreateOpen(false)
      onToast('已创建，把密钥发给 TA 即可绑定')
      setSecretDraft(r.group.secret)
      await load(true)
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function doJoin() {
    const secret = secretDraft.trim().toUpperCase()
    if (secret.length < 4) {
      setDialogErr('请输入完整的密钥')
      return
    }
    if (onRequireLogin && !onRequireLogin()) return
    setBusy(true)
    setDialogErr('')
    try {
      await joinCouple(secret)
      setJoinOpen(false)
      setSecretDraft('')
      onToast('已绑定，记得同步课表')
      await load(true)
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : '绑定失败')
    } finally {
      setBusy(false)
    }
  }

  async function doSync() {
    if (!couple || busy) return
    setBusy(true)
    try {
      await syncShareGroup(couple.id)
      onToast('已同步我的课表')
      await load(true)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '同步失败')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 共同计划：写操作 ----------------

     统一约定：**用服务端返回的 plan 覆盖本地那一条**，不做乐观猜测。
     状态机的合法迁移只有服务端知道（比如"pending 时对方能接受、我却只能取消"），
     本地猜错就会显示成一个服务端并不认可的状态，造成两端不一致。
     每个写操作成功后都静默重拉一次列表：既对齐对方并发做的改动，也让排序回到正确位置。 */

  /** 用返回的 plan 就地替换列表里的同一条（找不到就插到最前，容忍列表还没加载完） */
  function applyPlan(next: CouplePlan) {
    setPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === next.id)
      if (idx === -1) return [next, ...prev]
      const copy = [...prev]
      copy[idx] = next
      return copy
    })
  }

  async function savePlan(draft: PlanDraft) {
    if (!couple || busy) return
    setBusy(true)
    try {
      const body = {
        title: draft.title.trim(),
        planDate: draft.planDate,
        startTime: draft.startTime,
        endTime: draft.endTime,
        location: draft.location.trim(),
        note: draft.note.trim()
      }
      if (planEditingId != null) {
        const { plan } = await updateCouplePlan(planEditingId, body)
        applyPlan(plan)
        /* 服务端在"改期/改标题"时会把计划退回 pending —— 文案要说清这一点，
           否则用户会以为改完还是已确认，而对方其实需要重新点一次。 */
        onToast(plan.status === 'pending' ? '已修改，等 TA 重新确认' : '已保存')
      } else {
        const { plan } = await createCouplePlan(body)
        applyPlan(plan)
        onToast('已发出邀请，等 TA 确认')
      }
      setPlanDraft(null)
      setPlanEditingId(null)
      void loadPlans(true)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  /** 接受 / 婉拒（只有非发起人能用；服务端也会 403 拦自问自答） */
  async function doRespond(p: CouplePlan, action: 'accept' | 'decline') {
    if (planBusyId != null) return
    setPlanBusyId(p.id)
    try {
      const { plan } = await respondCouplePlan(p.id, action)
      applyPlan(plan)
      onToast(action === 'accept' ? '已确认，双方都会收到提醒' : '已婉拒，可以换个时间再约')
      void loadPlans(true)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '操作失败')
      /* 失败很可能是"对方刚在别处改过状态"导致 409 —— 重拉一次让界面回到真实状态 */
      void loadPlans(true)
    } finally {
      setPlanBusyId(null)
    }
  }

  async function doCancelPlan(p: CouplePlan) {
    if (planBusyId != null) return
    setPlanBusyId(p.id)
    try {
      const { plan } = await cancelCouplePlan(p.id)
      applyPlan(plan)
      onToast('已取消')
      void loadPlans(true)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '取消失败')
      void loadPlans(true)
    } finally {
      setPlanBusyId(null)
    }
  }

  /**
   * 把一条计划也写进**我自己的 DDL**（可选，不改变计划本身）。
   *
   * 为什么保留这个动作：计划板块里的提醒走站内信，只在打开本站时看得到；
   * 而 DDL 能通过日历订阅（.ics）落到系统日历里，是真正会弹到手机上的提醒。
   * 两者互补，所以做成"计划照旧共享、额外给自己留一份本地提醒"，
   * 而不是把计划本身塞进 DDL（那样对方就看不到了 —— 正是改造前的问题）。
   */
  async function planToMyDdl(p: CouplePlan) {
    if (planBusyId != null) return
    setPlanBusyId(p.id)
    try {
      await createTask({
        title: p.title,
        courseId: null,
        type: 'other',
        dueDate: p.planDate,
        dueTime: p.startTime || null,
        priority: 'medium',
        notes: `与 ${partner?.nickname ?? 'TA'} 的共同计划${p.location ? ` · ${p.location}` : ''}`
      })
      onToast('已加入你的 DDL（会随日历订阅提醒）')
      onMutated?.()
    } catch (e) {
      onToast(e instanceof Error ? e.message : '添加失败')
    } finally {
      setPlanBusyId(null)
    }
  }

  async function shareSecret() {
    if (!couple) return
    const text = `绑定「情侣课表」，密钥：${couple.secret}`
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> }
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: '情侣课表', text })
        return
      } catch {
        /* 取消或不支持 → 退回复制 */
      }
    }
    try {
      await navigator.clipboard.writeText(text)
      onToast('已复制邀请文案')
    } catch {
      onToast('分享失败，请手动复制密钥')
    }
  }

  /* ---------------- 未绑定 ---------------- */
  if (loading) {
    return (
      <Shell onBack={onBack}>
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>
      </Shell>
    )
  }

  if (err) {
    return (
      <Shell onBack={onBack}>
        <div className="card">
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>
          <button className="btn btn-soft btn-sm" style={{ marginTop: 10 }} onClick={() => void load()}>
            重试
          </button>
        </div>
      </Shell>
    )
  }

  if (!couple || !detail) {
    return (
      <Shell onBack={onBack}>
        <div className="couple-hero">
          <div className="couple-hero-icon">
            <IconHeart size={26} filled />
          </div>
          <div className="couple-hero-title">情侣课表</div>
          <div className="couple-hero-sub">
            把课表绑在一起：看共同的空闲时间、对方的课程安排，约好下一次见面。
          </div>
        </div>

        <div className="share-cta">
          <button type="button" className="share-cta-btn primary" onClick={() => { setDialogErr(''); setCreateOpen(true) }}>
            <IconHeart size={20} />
            <span className="share-cta-main">
              <strong>创建并邀请 TA</strong>
              <em>生成绑定密钥</em>
            </span>
          </button>
          <button type="button" className="share-cta-btn" onClick={() => { setDialogErr(''); setJoinOpen(true) }}>
            <IconBolt size={20} />
            <span className="share-cta-main">
              <strong>输入 TA 的密钥</strong>
              <em>加入已创建的绑定</em>
            </span>
          </button>
        </div>

        <p className="sheet-lead" style={{ marginTop: 14, lineHeight: 1.7 }}>
          绑定后默认只共享「空闲时间」，课程名称、教室与教师由各自在「隐私」里决定是否展示。
        </p>

        <BindDialogs
          createOpen={createOpen}
          joinOpen={joinOpen}
          busy={busy}
          err={dialogErr}
          secretDraft={secretDraft}
          setSecretDraft={setSecretDraft}
          onCloseCreate={() => setCreateOpen(false)}
          onCloseJoin={() => setJoinOpen(false)}
          onCreate={() => void doCreate()}
          onJoin={() => void doJoin()}
        />
      </Shell>
    )
  }

  /* ---------------- 已绑定 ---------------- */
  const meState = currentState(me, viewWeek ?? 0, viewWeekday, nowClock.hm)
  const taState = currentState(partner, viewWeek ?? 0, viewWeekday, nowClock.hm)
  const taCourses = (partner?.courses ?? []).filter(
    (c) => c.dayOfWeek === viewWeekday && viewWeek != null && (c.weeks.length === 0 || c.weeks.includes(viewWeek))
  )

  if (sub === 'countdown') {
    return (
      <Shell onBack={onBack} title="双人倒计时" onLeft={() => setSub(null)}>
        <CountdownPage
          couple={couple}
          onSave={async (patch) => {
            setBusy(true)
            try {
              await updateShareGroup(couple.id, patch)
              onToast('已保存')
              await load(true)
            } catch (e) {
              onToast(e instanceof Error ? e.message : '保存失败')
            } finally {
              setBusy(false)
            }
          }}
          busy={busy}
        />
      </Shell>
    )
  }

  if (sub === 'compare') {
    return (
      <Shell onBack={onBack} title="课表对比" onLeft={() => setSub(null)}>
        <ComparePage detail={detail} me={me} partner={partner} />
      </Shell>
    )
  }

  return (
    <Shell onBack={onBack}>
      {/* 绑定信息卡 */}
      <div className="couple-card">
        <div className="couple-card-main">
          <div className="couple-avatar">
            <IconHeart size={22} filled />
          </div>
          <div className="couple-info">
            <div className="couple-kicker">已绑定情侣课表</div>
            <div className="couple-name">
              {me?.nickname ?? '我'} 和 {partner?.nickname ?? 'TA'}
            </div>
            <div className="couple-sub">
              {viewWeek == null
                ? '本周放假，暂无课程安排'
                : todaySlots.length > 0
                  ? `今天有 ${todaySlots.length} 个共同空闲时段`
                  : '今天没有共同空闲时段'}
            </div>
          </div>
        </div>
        <div className="couple-actions">
          <button type="button" className="couple-action" onClick={() => void shareSecret()}>
            <IconShare size={16} />
            <span>分享</span>
          </button>
          <button type="button" className="couple-action" onClick={() => setPrivacyOpen(true)}>
            <span className="couple-action-dot" />
            <span>隐私</span>
          </button>
        </div>
      </div>

      {/* 未同步提示 */}
      {(me?.synced === false || partner?.synced === false) && (
        <div className="card" style={{ background: 'var(--warn-soft)', marginBottom: 10 }}>
          <div style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13.5 }}>
            {me?.synced === false ? '你还没有同步课表' : `${partner?.nickname ?? 'TA'} 还没有同步课表`}
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 4, lineHeight: 1.6 }}>
            共同空闲需要双方都同步后才能算出来。
          </div>
          {me?.synced === false && (
            <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={busy} onClick={() => void doSync()}>
              {busy ? '同步中…' : '同步我的课表'}
            </button>
          )}
        </div>
      )}
      {me?.synced && partner?.synced && partner.sameTerm === false && (
        <div className="card" style={{ background: 'var(--warn-soft)', marginBottom: 10 }}>
          <div style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13.5 }}>你们同步的学期不一致</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 4, lineHeight: 1.6 }}>
            TA 同步的是「{partner.termName}」，与你的「{detail.semester.termName}」对不上，共同空闲暂时无法计算。
            等 TA 切换到当前学期后再同步一次即可。
          </div>
        </div>
      )}

      {/* 两个入口 */}
      <div className="couple-entries">
        <button type="button" className="couple-entry" onClick={() => setSub('countdown')}>
          <span className="ce-icon pink">纪</span>
          <span className="ce-main">
            <span className="ce-title">双人倒计时</span>
            <span className="ce-sub">纪念日、生日与下次见面</span>
          </span>
          <IconChevronRight size={16} />
        </button>
        <button type="button" className="couple-entry" onClick={() => setSub('compare')}>
          <span className="ce-icon green">比</span>
          <span className="ce-main">
            <span className="ce-title">课表对比</span>
            <span className="ce-sub">查看重叠课程与共同空闲</span>
          </span>
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* 三个 tab */}
      <div className="filter-tabs" style={{ marginBottom: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'today' && (
        <>
          <div className="couple-days">
            {[0, 1].map((off) => {
              const iso = toISODate(addDays(parseISODate(today), off))
              return (
                <button
                  key={off}
                  type="button"
                  className={`couple-day${dayOffset === off ? ' active' : ''}`}
                  onClick={() => setDayOffset(off)}
                >
                  {off === 0 ? '今天' : '明天'} {fmtDay(iso)}
                </button>
              )
            })}
          </div>

          <div className="couple-cols">
            <div className="couple-col">
              <div className="couple-col-head">我</div>
              <div className={`couple-state${meState.busy ? ' busy' : ''}`}>{meState.busy ? '上课中' : '现在有空'}</div>
              <div className="couple-state-sub">{meState.text}</div>
            </div>
            <div className="couple-col ta">
              <div className="couple-col-head">{partner?.nickname ?? 'TA'}</div>
              <div className={`couple-state${taState.busy ? ' busy' : ''}`}>{taState.busy ? '上课中' : '现在有空'}</div>
              <div className="couple-state-sub">{taState.text}</div>
            </div>
          </div>

          <div className="couple-section-head">
            <span>{partner?.nickname ?? 'TA'} 的课程</span>
            <em>
              {dayOffset === 0 ? '今天' : '明天'} · {fmtDay(viewDate)} · {taCourses.length} 门
            </em>
          </div>
          {taCourses.length === 0 ? (
            <div className="card" style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
              {partner?.showDetail === false
                ? `${partner?.nickname ?? 'TA'} 关闭了课程明细共享，只能看到空闲时间。`
                : '这一天 TA 没有课。'}
            </div>
          ) : (
            taCourses.map((c, i) => (
              <div key={`${c.name}-${i}`} className="course-card" style={{ cursor: 'default' }}>
                <span className="cc-bar" style={{ background: c.color }} />
                <div className="cc-main">
                  <div className="cc-name">{c.name}</div>
                  <div className="cc-line">
                    {c.startTime}-{c.endTime}
                    {c.location ? ` · ${c.location}` : ''}
                  </div>
                </div>
              </div>
            ))
          )}
        </>
      )}

      {tab === 'free' && (
        <>
          {weekSlots.length === 0 ? (
            <div className="card" style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
              {viewWeek == null
                ? '本周放假，没有课也没有共同空闲可算。'
                : '本周暂时没有共同空闲时段 —— 双方课表都比较满，可以试试在「课表对比」里看看具体安排。'}
            </div>
          ) : (
            weekSlots.map((s, i) => (
              <div key={`${s.weekday}-${s.startPeriod}-${i}`} className="free-slot-row">
                <span className="fsr-day">{weekdayCN(s.weekday)}</span>
                <span className="fsr-time">
                  {s.startTime} - {s.endTime}
                </span>
                <span className="fsr-len">第 {s.startPeriod}-{s.endPeriod} 节</span>
              </div>
            ))
          )}
        </>
      )}

      {tab === 'plan' && (
        <>
          <p className="sheet-lead" style={{ lineHeight: 1.7 }}>
            发起约会或时间安排，双方都能在这里看到同一条计划；
            对方接受后，到点前双方都会收到提醒。
          </p>

          {/* 发起入口：主按钮打开空白表单；下面的空闲时段可一键预填，省去手打日期时间 */}
          <button
            type="button"
            className="btn btn-primary btn-block"
            style={{ marginBottom: 12 }}
            disabled={busy || partner == null}
            onClick={() => {
              setPlanEditingId(null)
              setPlanDraft({
                title: `和 ${partner?.nickname ?? 'TA'} 见面`,
                planDate: toISODate(new Date()),
                startTime: '',
                endTime: '',
                location: '',
                note: ''
              })
            }}
          >
            <IconPlus size={16} /> 发起一个新计划
          </button>
          {partner == null && (
            <p className="sheet-lead" style={{ marginTop: -6, marginBottom: 12 }}>
              等 TA 输入密钥绑定后就可以发起计划了。
            </p>
          )}

          {/* 计划列表 */}
          {plansLoading && plans.length === 0 ? (
            <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>
          ) : plans.length === 0 ? (
            <div className="card" style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
              还没有共同计划。点上面的按钮发起一个，或从下面的空闲时段里挑一个直接约。
            </div>
          ) : (
            plans.map((p) => {
              const closed = isPlanClosed(p)
              const days = planDaysAway(p)
              const rowBusy = planBusyId === p.id
              return (
                <div key={p.id} className={`plan-card${closed ? ' closed' : ''}`}>
                  <div className="plan-card-head">
                    <span className="plan-title">{p.title}</span>
                    <span className={`plan-badge ${p.status}`}>{PLAN_STATUS_TEXT[p.status]}</span>
                  </div>
                  <div className="plan-meta">
                    <span className="plan-meta-item">
                      <IconClock size={13} /> {planWhen(p)}
                      {!closed && days >= 0 && (
                        <em className="plan-away">{days === 0 ? '就是今天' : `还有 ${days} 天`}</em>
                      )}
                    </span>
                    {p.location && (
                      <span className="plan-meta-item">
                        <IconMapPin size={13} /> {p.location}
                      </span>
                    )}
                  </div>
                  <div className="plan-by">
                    由 {p.isMine ? '我' : p.createdByName} 发起
                    {p.status === 'pending' && !p.isMine ? ' · 等你确认' : ''}
                    {p.status === 'pending' && p.isMine ? ` · 等 ${p.otherName} 确认` : ''}
                  </div>
                  {p.note && <div className="plan-note">{p.note}</div>}

                  {/* 动作区：按钮由服务端下发的 myActions 决定，前端不复刻状态机 */}
                  {p.myActions.length > 0 && (
                    <div className="plan-actions">
                      {p.myActions.includes('accept') && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={rowBusy}
                          onClick={() => void doRespond(p, 'accept')}
                        >
                          <IconCheck size={14} /> 接受
                        </button>
                      )}
                      {p.myActions.includes('decline') && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={rowBusy}
                          onClick={() => void doRespond(p, 'decline')}
                        >
                          <IconClose size={14} /> 婉拒
                        </button>
                      )}
                      {p.myActions.includes('edit') && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={rowBusy}
                          onClick={() => {
                            setPlanEditingId(p.id)
                            setPlanDraft({
                              title: p.title,
                              planDate: p.planDate,
                              startTime: p.startTime,
                              endTime: p.endTime,
                              location: p.location,
                              note: p.note
                            })
                          }}
                        >
                          改期
                        </button>
                      )}
                      {p.myActions.includes('cancel') && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm plan-cancel"
                          disabled={rowBusy}
                          onClick={() => void doCancelPlan(p)}
                        >
                          取消
                        </button>
                      )}
                      {/* 可选：给自己留一条本地 DDL，走日历订阅弹到手机（不改变共享计划本身） */}
                      {!closed && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={rowBusy}
                          onClick={() => void planToMyDdl(p)}
                        >
                          加入我的 DDL
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}

          {/* 空闲时段快捷发起：把本周的共同空闲列出来，点一下即预填表单 */}
          {weekSlots.length > 0 && (
            <>
              <div className="couple-section-head" style={{ marginTop: 18 }}>
                <span>从共同空闲里挑一个</span>
                <em>本周</em>
              </div>
              {weekSlots.map((s, i) => {
                /* 空闲时段只有"周几 + 时间"，换算成具体日期要用本周（viewWeek）的起始日 */
                const slotDate = slotDateOf(detail, viewWeek, s.weekday)
                return (
                  <div key={`${s.weekday}-${s.startPeriod}-${i}`} className="free-slot-row">
                    <span className="fsr-day">{weekdayCN(s.weekday)}</span>
                    <span className="fsr-time">
                      {s.startTime} - {s.endTime}
                    </span>
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      disabled={busy || partner == null}
                      onClick={() => {
                        setPlanEditingId(null)
                        setPlanDraft({
                          title: `和 ${partner?.nickname ?? 'TA'} 见面`,
                          planDate: slotDate,
                          startTime: s.startTime,
                          endTime: s.endTime,
                          location: '',
                          note: ''
                        })
                      }}
                    >
                      约这个时间
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </>
      )}

      {/* 隐私设置 */}
      <Modal open={privacyOpen} title="隐私" onClose={() => setPrivacyOpen(false)}>
        <div className="set-list">
          <div className="set-row">
            <div className="set-row-main">
              <div className="set-row-title">共享我的课程明细</div>
              <div className="set-row-sub">
                关闭后 {partner?.nickname ?? 'TA'} 只能看到你的空闲时间，看不到课名、教室与教师
              </div>
            </div>
            <Switch
              checked={me?.showDetail === true}
              label="共享我的课程明细"
              disabled={busy}
              onChange={async (v) => {
                setBusy(true)
                try {
                  await setSharePrivacy(couple.id, v)
                  onToast(v ? '已开启课程明细共享' : '已关闭课程明细共享')
                  await load(true)
                } catch (e) {
                  onToast(e instanceof Error ? e.message : '设置失败')
                } finally {
                  setBusy(false)
                }
              }}
            />
          </div>
        </div>
        <div className="field-label" style={{ marginTop: 16 }}>绑定密钥</div>
        <div className="share-secret-row">
          <span className="share-secret-val">{couple.secret}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(couple.secret)
                onToast('密钥已复制')
              } catch {
                onToast('复制失败，请长按手动复制')
              }
            }}
          >
            复制
          </button>
        </div>
        <button
          className="btn btn-danger btn-block"
          type="button"
          style={{ marginTop: 16 }}
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('解除绑定后双方都会失去这张情侣课表，且无法恢复。确定解除吗？')) return
            setBusy(true)
            try {
              await unbindCouple()
              onToast('已解除绑定')
              setPrivacyOpen(false)
              await load(true)
            } catch (e) {
              onToast(e instanceof Error ? e.message : '解除失败')
            } finally {
              setBusy(false)
            }
          }}
        >
          解除绑定
        </button>
      </Modal>

      {/* 发起 / 编辑计划（新建与改期复用同一个表单） */}
      <PlanFormModal
        draft={planDraft}
        partnerName={partner?.nickname ?? 'TA'}
        editing={planEditingId != null}
        busy={busy}
        onChange={setPlanDraft}
        onClose={() => {
          setPlanDraft(null)
          setPlanEditingId(null)
        }}
        onSubmit={() => {
          if (planDraft) void savePlan(planDraft)
        }}
      />

      <BindDialogs
        createOpen={createOpen}
        joinOpen={joinOpen}
        busy={busy}
        err={dialogErr}
        secretDraft={secretDraft}
        setSecretDraft={setSecretDraft}
        onCloseCreate={() => setCreateOpen(false)}
        onCloseJoin={() => setJoinOpen(false)}
        onCreate={() => void doCreate()}
        onJoin={() => void doJoin()}
      />
    </Shell>
  )
}

/** 页面外壳：返回栏 + 标题（子页时标题随之变化） */
function Shell({
  onBack,
  title = '情侣课表',
  onLeft,
  children
}: {
  onBack: () => void
  title?: string
  onLeft?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="couple-page">
      <div className="subpage-head">
        <button type="button" className="btn-back" onClick={onLeft ?? onBack} aria-label="返回">
          <IconChevronLeft size={22} />
        </button>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  )
}

/**
 * 发起 / 编辑计划的表单弹层。
 *
 * 为什么新建与改期共用一个组件：字段完全一致，差别只在标题与提示语。
 * 拆成两个会让"改期"那条路径少校验一个字段也无人察觉。
 *
 * 校验放在前端只做**即时可用性**（标题非空），真正的合法性（时间格式、
 * 起止先后、状态是否允许改）一律由服务端判定 —— 前端再抄一遍必然与服务端漂移。
 */
function PlanFormModal({
  draft,
  partnerName,
  editing,
  busy,
  onChange,
  onClose,
  onSubmit
}: {
  draft: PlanDraft | null
  partnerName: string
  editing: boolean
  busy: boolean
  onChange: (d: PlanDraft) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const open = draft !== null
  const d = draft ?? { title: '', planDate: '', startTime: '', endTime: '', location: '', note: '' }
  return (
    <Modal
      open={open}
      title={editing ? '修改计划' : '发起计划'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" type="button" onClick={onSubmit} disabled={busy || !d.title.trim()}>
            {busy ? '保存中…' : editing ? '保存修改' : '发出邀请'}
          </button>
        </>
      }
    >
      <div className="field-label">标题</div>
      <input
        className="input"
        value={d.title}
        maxLength={40}
        placeholder={`和 ${partnerName} 见面`}
        onChange={(e) => onChange({ ...d, title: e.target.value })}
      />
      <div className="field-label" style={{ marginTop: 12 }}>日期</div>
      <input
        type="date"
        className="input"
        value={d.planDate}
        onChange={(e) => onChange({ ...d, planDate: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="field-label">开始</div>
          <input
            type="time"
            className="input"
            value={d.startTime}
            onChange={(e) => onChange({ ...d, startTime: e.target.value })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className="field-label">结束</div>
          <input
            type="time"
            className="input"
            value={d.endTime}
            onChange={(e) => onChange({ ...d, endTime: e.target.value })}
          />
        </div>
      </div>
      <div className="field-label" style={{ marginTop: 12 }}>地点（选填）</div>
      <input
        className="input"
        value={d.location}
        maxLength={40}
        onChange={(e) => onChange({ ...d, location: e.target.value })}
      />
      <div className="field-label" style={{ marginTop: 12 }}>备注（选填）</div>
      <input
        className="input"
        value={d.note}
        maxLength={200}
        onChange={(e) => onChange({ ...d, note: e.target.value })}
      />
      <p className="sheet-lead" style={{ marginTop: 12, lineHeight: 1.7 }}>
        {editing
          ? '改动时间、标题或地点后，计划会退回「待确认」，TA 需要重新确认一次。'
          : `发出后 ${partnerName} 会收到通知，TA 接受后双方都会在到点前收到提醒。`}
      </p>
    </Modal>
  )
}

/** 创建 / 加入绑定的两个弹层（未绑定态与已绑定态都会渲染，抽出来避免写两遍） */
function BindDialogs({
  createOpen,
  joinOpen,
  busy,
  err,
  secretDraft,
  setSecretDraft,
  onCloseCreate,
  onCloseJoin,
  onCreate,
  onJoin
}: {
  createOpen: boolean
  joinOpen: boolean
  busy: boolean
  err: string
  secretDraft: string
  setSecretDraft: (v: string) => void
  onCloseCreate: () => void
  onCloseJoin: () => void
  onCreate: () => void
  onJoin: () => void
}) {
  return (
    <>
      <Modal
        open={createOpen}
        title="创建情侣课表"
        onClose={onCloseCreate}
        footer={
          <>
            <button className="btn btn-ghost" type="button" onClick={onCloseCreate} disabled={busy}>
              取消
            </button>
            <button className="btn btn-primary" type="button" onClick={onCreate} disabled={busy}>
              {busy ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        {err && <div className="form-error" style={{ marginBottom: 10 }}>{err}</div>}
        <p className="sheet-lead" style={{ lineHeight: 1.7 }}>
          创建后会生成一串 6 位密钥，把它发给 TA，TA 输入后即完成绑定。
          绑定后默认只共享空闲时间，课程明细由各自在「隐私」里决定。
        </p>
      </Modal>

      <Modal
        open={joinOpen}
        title="输入 TA 的密钥"
        onClose={onCloseJoin}
        footer={
          <>
            <button className="btn btn-ghost" type="button" onClick={onCloseJoin} disabled={busy}>
              取消
            </button>
            <button className="btn btn-primary" type="button" onClick={onJoin} disabled={busy}>
              {busy ? '绑定中…' : '绑定'}
            </button>
          </>
        }
      >
        {err && <div className="form-error" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="field-label">绑定密钥</div>
        <input
          className="input"
          value={secretDraft}
          maxLength={12}
          placeholder="6 位字母数字"
          autoCapitalize="characters"
          onChange={(e) => setSecretDraft(e.target.value.toUpperCase())}
        />
      </Modal>
    </>
  )
}

/** 双人倒计时：纪念日 / 生日 / 下次见面 */
function CountdownPage({
  couple,
  onSave,
  busy
}: {
  couple: ShareGroupSummary
  onSave: (patch: { anniversary?: string | null; birthday?: string | null; nextMeet?: string | null }) => void
  busy: boolean
}) {
  const today = toISODate(new Date())
  const items: { key: 'anniversary' | 'birthday' | 'nextMeet'; label: string; hint: string; value: string | null }[] = [
    { key: 'anniversary', label: '纪念日', hint: '在一起的日子', value: couple.anniversary },
    { key: 'birthday', label: 'TA 的生日', hint: '别忘了准备礼物', value: couple.birthday },
    { key: 'nextMeet', label: '下次见面', hint: '约定好的那一天', value: couple.nextMeet }
  ]
  return (
    <div>
      <p className="sheet-lead" style={{ lineHeight: 1.7 }}>
        填好日期后双方都能看到倒计时；日期保存在服务端，换设备也在。
      </p>
      {items.map((it) => {
        const days = it.value ? daysBetween(today, it.value) : null
        return (
          <div key={it.key} className="countdown-card">
            <div className="cd-main">
              <div className="cd-label">{it.label}</div>
              <div className="cd-hint">{it.hint}</div>
            </div>
            <div className="cd-right">
              {days !== null && (
                <div className="cd-days">
                  {days === 0 ? '就是今天' : days > 0 ? `还有 ${days} 天` : `已过 ${-days} 天`}
                </div>
              )}
              <input
                type="date"
                className="input cd-input"
                value={it.value ?? ''}
                disabled={busy}
                onChange={(e) => onSave({ [it.key]: e.target.value || null })}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 课表对比：双方课程 + 共同空闲概览 */
function ComparePage({
  detail,
  me,
  partner
}: {
  detail: ShareDetail
  me: ShareMemberView | undefined
  partner: ShareMemberView | undefined
}) {
  const today = toISODate(new Date())
  const week = weekOf(detail, today)
  const rows = detail.periods

  /** 重叠课程：双方课名相同（同一门课） */
  const overlapNames = useMemo(() => {
    if (!me || !partner) return []
    const mine = new Set(me.courses.map((c) => c.name))
    return [...new Set(partner.courses.filter((c) => mine.has(c.name)).map((c) => c.name))]
  }, [me, partner])

  if (!me?.synced || !partner?.synced) {
    return <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>双方都同步课表后才能对比。</div>
  }
  if (week == null) {
    return <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>今天不在教学周内（放假或未开学）。</div>
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="field-label">本周共同空闲</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8 }}>
          {(() => {
            let total = 0
            for (let wd = 1; wd <= 7; wd++) total += freeSlots(detail, week, wd).length
            return total === 0 ? '本周没有共同空闲时段' : `共 ${total} 段，见「一起有空」页`
          })()}
        </div>
        {overlapNames.length > 0 && (
          <>
            <div className="field-label" style={{ marginTop: 14 }}>重叠课程（{overlapNames.length}）</div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8 }}>{overlapNames.join('、')}</div>
          </>
        )}
      </div>

      <div className="field-label">逐节对照</div>
      {rows.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>还没有设置节次时间，无法逐节对照。</div>
      ) : (
        <div className="compare-table">
          <div className="ct-head">节次</div>
          <div className="ct-head">我</div>
          <div className="ct-head">{partner.nickname}</div>
          {rows.map((p) => {
            const mineBusy = isBusy(me, week, todayWeekday(), p.index)
            const taBusy = isBusy(partner, week, todayWeekday(), p.index)
            const both = !mineBusy && !taBusy
            return (
              <div key={p.index} className={`ct-row${both ? ' both-free' : ''}`}>
                <div className="ct-cell axis">
                  {p.index}
                  <em>{p.start}</em>
                </div>
                <div className="ct-cell">{mineBusy ? '有课' : '空'}</div>
                <div className="ct-cell">{taBusy ? '有课' : '空'}</div>
              </div>
            )
          })}
        </div>
      )}
      <p className="sheet-lead" style={{ marginTop: 10 }}>对照的是今天（{fmtDay(today)} · {weekdayCN(todayWeekday())}）。</p>
    </div>
  )
}
