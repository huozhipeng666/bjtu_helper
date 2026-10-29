import { useCallback, useEffect, useRef, useState } from 'react'
import type { MyFeedbackStats, ThemeMode, User } from '../types'
import {
  getCalendarToken, getMyFeedbackStats, getTasks, getUnreadMessageCount,
  regenerateCalendarToken, updateProfile
} from '../api'
import { compressAvatar, initialOf } from '../lib/avatar'
import { ACCENT_PRESETS } from '../lib/theme'
import { useBackStep } from '../lib/back'
import { FEEDBACK_STATUS_LABEL } from '../constants'
import {
  IconCalendar, IconCheck, IconChevronRight, IconDownload, IconEdit, IconGear, IconGrid,
  IconHeart, IconHelp, IconHome, IconMail, IconMoon, IconRefresh, IconSend, IconSun,
  IconTicket, IconUser, IconUsers
} from '../icons'
import {
  addTaskToCalendar, calendarPermissionState, hasNativeCalendarBridge,
  markTaskInCalendar, openCalendarPermissionSettings
} from '../lib/calendarBridge'
import { saveBlob } from '../lib/saveFile'
import { appBridge, isInAppShell } from '../lib/systemBrowser'
import { requestManualUpdateCheck, shellVersion } from '../lib/appUpdate'
import FeedbackForm from '../components/FeedbackForm'
import FeedbackInbox from '../components/FeedbackInbox'
import FeedbackDetail from '../components/FeedbackDetail'
import MessageCenter from '../components/MessageCenter'

interface ProfileViewProps {
  user: User
  /** 资料保存成功后回写（昵称/头像/主题） */
  onSaved: (u: User) => void
  onLogout: () => void
  /** 管理员进入后台管理（仅 admin 角色显示入口） */
  onOpenAdmin?: () => void
  /** 打开「空闲课表」（多人时间协作）；游客由 App 统一引导登录 */
  onOpenShareGroups?: () => void
  /** 打开「情侣课表」（默认停在「今日」页签） */
  onOpenCouple?: () => void
  /** 打开「情侣课表」并直接落在「共同计划」页签（点共同计划类通知时走这条） */
  onOpenCouplePlans?: () => void
  /** 打开「应用」目录页（作业 / 成绩 / 课件 / 校园卡 / 校园网…） */
  onOpenApps?: () => void
  /** 直接打开「校园邮箱」应用（消息通知顶部的邮件入口） */
  onOpenMailbox?: () => void
  /** 未读消息数变化（读了一条 / 全部已读）时通知 App 重拉底栏角标 */
  onUnreadChanged?: () => void
  /** 全局 toast（提交成功等提示） */
  onToast?: (msg: string) => void
  /** 游客点「登录 / 注册」时由 App 弹出登录层 */
  onRequireLogin?: () => void
}

/** 个人中心的子页；null = 首页 */
type SubPage =
  | { kind: 'messages' }
  | { kind: 'compose' }
  | { kind: 'inbox' }
  | { kind: 'detail'; id: number }
  | null

const THEME_OPTS: { mode: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { mode: 'light', label: '浅色', icon: <IconSun size={18} /> },
  { mode: 'dark', label: '深色', icon: <IconMoon size={18} /> },
  { mode: 'system', label: '跟随系统', icon: <IconRefresh size={18} /> }
]

/**
 * 个人中心（底栏第 4 个 tab 的全页版本）。
 *
 * 为什么从弹层改成全页：原来的 ProfileSheet 只有头像/主题/日历三块，做成底部弹层够用。
 * 现在要容纳「消息通知 + 联系管理员 + 我的反馈记录 + 外观 + 日历 + 帮助」六个模块，
 * 弹层里会变成一条要滚很久的长列表，且和底栏 tab 的切换语义冲突（弹层挡住底栏）。
 *
 * 子页（消息 / 提交反馈 / 反馈列表 / 反馈详情）在**本组件内部**用状态切换，不提升到 App：
 * 它们是个人中心的内部导航，只有「个人中心」这一个入口，提上去只会让 App 多出四个
 * 互相排斥的布尔状态。返回键由下面的 useBackStep 统一接管（子页开时压栈，关闭时弹栈）。
 */
export default function ProfileView({
  user,
  onSaved,
  onLogout,
  onOpenAdmin,
  onOpenShareGroups,
  onOpenCouple,
  onOpenCouplePlans,
  onOpenApps,
  onOpenMailbox,
  onUnreadChanged,
  onToast,
  onRequireLogin
}: ProfileViewProps) {
  /** 未登录游客：身份是服务端签发的一次性账号，界面要明确告诉他"数据还没保存" */
  const isGuest = !!user.isGuest
  const [sub, setSub] = useState<SubPage>(null)
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState(user.nickname)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [feedToken, setFeedToken] = useState('')
  const [calMsg, setCalMsg] = useState('')
  /** 批量写日历进行中：期间禁用按钮，避免重复点击产生重复事件 */
  const [calBusy, setCalBusy] = useState(false)
  const [unread, setUnread] = useState(0)
  const [fbStats, setFbStats] = useState<MyFeedbackStats>({ total: 0, replied: 0, pending: 0 })
  /** 从详情页返回后需要刷新列表 / 统计 */
  const [fbRefreshKey, setFbRefreshKey] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 拉取顶部的两个徽标数据（未读消息数、我的反馈统计） */
  const refreshBadges = useCallback(() => {
    getUnreadMessageCount()
      .then((r) => setUnread(r.count))
      .catch(() => {})
    getMyFeedbackStats()
      .then(setFbStats)
      .catch(() => {})
  }, [])

  useEffect(refreshBadges, [refreshBadges])

  useEffect(() => {
    getCalendarToken()
      .then((r) => setFeedToken(r.feedToken))
      .catch(() => {})
  }, [])

  /* 子页开启时注册一个返回步骤：按返回键先回个人中心首页，而不是直接切 tab */
  useBackStep(sub !== null, () => setSub(null))

  const displayName = user.nickname || user.username

  async function saveNickname() {
    const n = nickDraft.trim()
    if (!n) {
      setErr('昵称不能为空')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const { user: u } = await updateProfile({ nickname: n })
      onSaved(u)
      setEditingNick(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function onPickAvatar(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      const dataUrl = await compressAvatar(file)
      const { user: u } = await updateProfile({ avatar: dataUrl })
      onSaved(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '头像上传失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeAvatar() {
    setBusy(true)
    setErr('')
    try {
      const { user: u } = await updateProfile({ avatar: null })
      onSaved(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleTheme(mode: ThemeMode) {
    setErr('')
    try {
      const { user: u } = await updateProfile({ theme: mode })
      onSaved(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '主题保存失败')
    }
  }

  /** 切换自选主题色（强调色），跟随账号保存 */
  async function handleAccent(h: number) {
    setErr('')
    try {
      const { user: u } = await updateProfile({ accent: String(h) })
      onSaved(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '主题色保存失败')
    }
  }

  const feedUrl = feedToken ? `${window.location.origin}/api/calendar/${feedToken}.ics` : ''
  const nativeBridge = hasNativeCalendarBridge()

  // 网页回退：下载 .ics → 系统日历打开并授权导入（比 webcal:// 直达在多数浏览器更稳）
  //
  // ⚠️ 不能直接 `<a download href={feedUrl}>`：Android WebView 里点了没反应，
  // App 用户永远拿不到 .ics。改成先 fetch 字节再走 saveBlob（原生壳会写进下载目录）。
  async function importIcs() {
    if (!feedUrl || calBusy) return
    setCalBusy(true)
    setCalMsg('')
    try {
      const res = await fetch(feedUrl + '?download=1', { credentials: 'omit' })
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`)
      const blob = await res.blob()
      const r = await saveBlob(blob, 'bjtu-ddl.ics')
      setCalMsg(r.ok ? '已导出 .ics，请用系统「日历」打开即可导入并授权提醒' : r.message)
    } catch (e) {
      setCalMsg(e instanceof Error ? e.message : '导出失败，请稍后重试')
    } finally {
      setCalBusy(false)
    }
  }

  // 有原生 WebView 壳时：App 自己申请系统日历权限，再为每一条未完成 DDL
  // 单独写入一个日历事件（各自带提醒），而不是只写一条占位。
  //
  // 2026-10-20 改：不再先写一条「权限检查」探测事件（那会在用户日历里留垃圾），
  // 直接写第一条 DDL —— 没授权时原生壳自己弹系统授权框，并把事件排队，
  // 用户点「允许」后自动补写（返回 pending 就是这个状态）。
  async function writeNativeCalendar() {
    if (calBusy) return
    if (calendarPermissionState() === 'blocked') {
      if (window.confirm('日历权限已被拒绝，系统不会再弹授权框。\n需要到「设置 → 应用 → 交大小助手 → 权限」里手动打开日历权限，是否现在前往？')) {
        openCalendarPermissionSettings()
      }
      return
    }
    // 同一 DDL 重复写入会更新原事件（原生侧按 uid 去重），但整批同步仍会改动已有事件的时间/提醒
    if (!window.confirm('将为每条「未完成 DDL」在系统日历里创建一个事件并附带提醒。\n已在日历里的同一条会按最新截止时间更新，不会重复。\n\n（只想给单条 DDL 加提醒：在 DDL 列表里点它右侧的日历图标即可）')) return
    setCalBusy(true)
    setCalMsg('')
    try {
      const tasks = await getTasks({ status: 'pending' })
      if (tasks.length === 0) {
        setCalMsg('当前没有待完成的 DDL 可写入')
        return
      }
      let ok = 0
      let pending = 0
      const failed: string[] = []
      for (const t of tasks) {
        const r = addTaskToCalendar(t)
        if (r.ok) {
          ok += 1
          markTaskInCalendar(t.id)
        } else if (r.status === 'pending') {
          pending += 1
        } else {
          failed.push(`${t.title}（${r.message}）`)
        }
      }
      setCalMsg(
        pending > 0
          ? `已在系统弹窗中申请日历权限：点「允许」后这 ${pending} 条 DDL 会自动写进日历`
          : failed.length === 0
            ? `已为 ${ok} 条 DDL 各写入一个日历提醒`
            : `已写入 ${ok}/${tasks.length} 条${failed.length ? `，失败：${failed.slice(0, 2).join('、')}` : ''}`
      )
    } catch (e) {
      setCalMsg(e instanceof Error ? e.message : '写入日历失败')
    } finally {
      setCalBusy(false)
    }
  }

  async function copyFeed() {
    try {
      await navigator.clipboard?.writeText(feedUrl)
      setCalMsg('已复制订阅地址')
    } catch {
      setCalMsg('复制失败，请长按地址手动复制')
    }
  }

  async function regenFeed() {
    try {
      const r = await regenerateCalendarToken()
      setFeedToken(r.feedToken)
      setCalMsg('已生成新订阅地址，旧地址将失效')
    } catch (e) {
      setCalMsg(e instanceof Error ? e.message : '操作失败')
    }
  }

  /* ---------------- 子页 ---------------- */

  if (sub?.kind === 'messages') {
    return (
      <MessageCenter
        onBack={() => setSub(null)}
        onOpenFeedback={(id) => setSub({ kind: 'detail', id })}
        /* 点共同计划类通知 → 离开个人中心、打开情侣课表。
           为什么不留在个人中心里展示计划：计划本身有接受/婉拒等交互，
           塞进通知列表会变成"通知里又嵌一个操作面板"，语义重叠。 */
        onOpenCouple={() => {
          setSub(null)
          ;(onOpenCouplePlans ?? onOpenCouple)?.()
        }}
        /* 数据变动类通知 → 离开个人中心、打开「应用」目录。
           不直接跳到具体某个应用：变动可能来自作业/成绩/课表多个域，
           由用户自己在目录里选要看的那个，比替他决定更稳。 */
        onOpenApps={() => {
          setSub(null)
          onOpenApps?.()
        }}
        /* 消息通知顶部的「校园邮箱」行 → 离开个人中心、直接打开邮箱应用。
           和上面同一条路径（先关子页再开应用），返回键才能落回应用目录。 */
        onOpenMailbox={
          onOpenMailbox
            ? () => {
                setSub(null)
                onOpenMailbox()
              }
            : undefined
        }
        /* 读完消息（单条 / 全部已读）后既要刷新本页徽标，也要通知 App 重拉底栏角标。
           少了后半程，底栏红点会一直亮到下次切后台或 30s 节流到期 ——
           用户读到"红点还在"，就会认为红点坏了。 */
        onUnreadChanged={() => {
          refreshBadges()
          onUnreadChanged?.()
        }}
      />
    )
  }

  if (sub?.kind === 'compose') {
    return (
      <FeedbackForm
        onBack={() => setSub(null)}
        onSubmitted={(id) => {
          refreshBadges()
          setFbRefreshKey((k) => k + 1)
          onToast?.('反馈已提交，管理员会尽快处理')
          setSub({ kind: 'detail', id })
        }}
      />
    )
  }

  if (sub?.kind === 'inbox') {
    return (
      <FeedbackInbox
        onBack={() => setSub(null)}
        onOpen={(id) => setSub({ kind: 'detail', id })}
        onCompose={() => setSub({ kind: 'compose' })}
        refreshKey={fbRefreshKey}
      />
    )
  }

  if (sub?.kind === 'detail') {
    return (
      <FeedbackDetail
        id={sub.id}
        onBack={() => {
          setFbRefreshKey((k) => k + 1)
          refreshBadges()
          setSub({ kind: 'inbox' })
        }}
      />
    )
  }

  /* ---------------- 首页 ---------------- */

  return (
    <div className="profile-page">
      {/* 头像 + 昵称 */}
      <div className="profile-user">
        <button
          type="button"
          className="pv-avatar-btn"
          onClick={() => fileRef.current?.click()}
          title="点击更换头像"
          aria-label="更换头像"
        >
          {user.avatar ? (
            <img className="pv-avatar-img" src={user.avatar} alt={displayName} />
          ) : (
            <span className="pv-avatar">{initialOf(displayName)}</span>
          )}
          <span className="pv-avatar-badge">{busy ? '…' : '换'}</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void onPickAvatar(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="pv-info">
          {editingNick ? (
            <div className="nick-edit">
              <input
                className="input"
                value={nickDraft}
                maxLength={16}
                onChange={(e) => setNickDraft(e.target.value)}
                autoFocus
              />
              <button className="pill-btn ok" onClick={() => void saveNickname()} disabled={busy}>
                <IconCheck size={16} />
              </button>
              <button
                className="pill-btn"
                onClick={() => {
                  setEditingNick(false)
                  setNickDraft(user.nickname)
                }}
                disabled={busy}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="pv-name-row">
              <span className="pv-name">{displayName}</span>
              <button
                className="pv-edit"
                onClick={() => {
                  setNickDraft(user.nickname)
                  setEditingNick(true)
                }}
                aria-label="编辑昵称"
              >
                <IconEdit size={15} />
              </button>
            </div>
          )}
          <div className="pv-role">
            {isGuest ? '游客（未登录）' : user.role === 'admin' ? '管理员' : '同学'}
            {user.avatar && (
              <button className="pv-remove" onClick={() => void removeAvatar()} disabled={busy}>
                移除头像
              </button>
            )}
          </div>
        </div>
      </div>

      {err && <div className="form-error" style={{ margin: '4px 2px 0' }} role="alert">{err}</div>}

      {/* 游客：把"登录后数据才保存"这件事放在最显眼的位置。
          未登录能用是刻意的设计，但"能用"不等于"数据安全" —— 游客账号是临时的
          （14 天不活跃会被回收），换设备 / 清缓存就找不回来，必须说清楚。 */}
      {isGuest && (
        <button type="button" className="profile-admin-entry" onClick={() => onRequireLogin?.()}>
          <IconUser size={18} />
          <span className="pa-main">登录 / 注册，保存我的数据</span>
          <span className="pa-sub">当前是游客模式 · 换设备或清缓存后会丢失</span>
        </button>
      )}

      {/* 管理员：后台管理入口（底栏不放「管理」tab） */}
      {user.role === 'admin' && onOpenAdmin && (
        <button type="button" className="profile-admin-entry" onClick={onOpenAdmin}>
          <IconGear size={18} />
          <span className="pa-main">后台管理</span>
          <span className="pa-sub">用户 · 反馈 · 权限</span>
        </button>
      )}

      {/* 三个主入口 */}
      <div className="profile-section-title">我的</div>
      <div className="pv-entries">
        <button type="button" className="pv-entry" onClick={() => setSub({ kind: 'messages' })}>
          <span className="pv-entry-ico"><IconMail size={20} /></span>
          <span className="pv-entry-main">
            <span className="pv-entry-title">消息通知</span>
            <span className="pv-entry-sub">
              {unread > 0 ? `${unread} 条未读` : '管理员回复会在这里通知你'}
            </span>
          </span>
          {unread > 0 && <span className="pv-badge">{unread > 99 ? '99+' : unread}</span>}
          <IconChevronRight size={18} />
        </button>

        <button type="button" className="pv-entry" onClick={() => setSub({ kind: 'compose' })}>
          <span className="pv-entry-ico"><IconSend size={20} /></span>
          <span className="pv-entry-main">
            <span className="pv-entry-title">联系管理员</span>
            <span className="pv-entry-sub">报错、建议、使用问题都可以提</span>
          </span>
          <IconChevronRight size={18} />
        </button>

        <button type="button" className="pv-entry" onClick={() => setSub({ kind: 'inbox' })}>
          <span className="pv-entry-ico"><IconTicket size={20} /></span>
          <span className="pv-entry-main">
            <span className="pv-entry-title">我的反馈</span>
            <span className="pv-entry-sub">
              {fbStats.total === 0
                ? '还没有提交过反馈'
                : `共 ${fbStats.total} 条 · ${FEEDBACK_STATUS_LABEL.replied} ${fbStats.replied} · ${FEEDBACK_STATUS_LABEL.pending} ${fbStats.pending}`}
            </span>
          </span>
          <IconChevronRight size={18} />
        </button>
      </div>

      {/* 应用：校园各子系统的统一入口。
          为什么放「我的」而不是底栏第 5 个 tab：底栏四个位置留给**每天都用**的功能
          （课表/DDL），而应用是"要去办事时才进"的目录页 —— 低频、目标明确。
          与「时间协作」同理：按使用频率而非功能重要性决定入口位置。 */}
      {onOpenApps && (
        <>
          <div className="profile-section-title">应用</div>
          <div className="pv-entries">
            <button type="button" className="pv-entry" onClick={onOpenApps}>
              <span className="pv-entry-ico"><IconGrid size={20} /></span>
              <span className="pv-entry-main">
                <span className="pv-entry-title">全部应用</span>
                <span className="pv-entry-sub">作业、成绩、课件、校园卡、校园网…</span>
              </span>
              <IconChevronRight size={18} />
            </button>
          </div>
        </>
      )}

      {/* 时间协作：把课表换算成"忙闲"再与别人对齐 —— 这两件事都是**关系型**功能，
          与上面的「消息 / 联系管理员 / 我的反馈」同属"我和别人"，因此放在一起。
          底栏不为它们加 tab：低频（一学期用几次），而底栏四个位置留给每天都用的功能。 */}
      {(onOpenShareGroups || onOpenCouple) && (
        <>
          <div className="profile-section-title">时间协作</div>
          <div className="pv-entries">
            {onOpenShareGroups && (
              <button type="button" className="pv-entry" onClick={onOpenShareGroups}>
                <span className="pv-entry-ico"><IconUsers size={20} /></span>
                <span className="pv-entry-main">
                  <span className="pv-entry-title">空闲课表</span>
                  <span className="pv-entry-sub">找到大家都有空的时间，不共享具体课程</span>
                </span>
                <IconChevronRight size={18} />
              </button>
            )}
            {onOpenCouple && (
              <button type="button" className="pv-entry" onClick={onOpenCouple}>
                <span className="pv-entry-ico"><IconHeart size={20} /></span>
                <span className="pv-entry-main">
                  <span className="pv-entry-title">情侣课表</span>
                  <span className="pv-entry-sub">共同空闲、课表对比与双人倒计时</span>
                </span>
                <IconChevronRight size={18} />
              </button>
            )}
          </div>
        </>
      )}

      {/* 外观主题 */}
      <div className="profile-section-title">外观</div>
      <div className="card profile-card">
        <div className="field-label">深色 / 浅色</div>
        <div className="theme-seg">
          {THEME_OPTS.map((o) => (
            <button
              key={o.mode}
              type="button"
              className={`theme-opt${user.theme === o.mode ? ' active' : ''}`}
              onClick={() => void handleTheme(o.mode)}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
        <div className="field-label" style={{ marginTop: 14 }}>主题色</div>
        <div className="accent-row" role="radiogroup" aria-label="主题色">
          {ACCENT_PRESETS.map((a) => {
            const current = user.accent && user.accent !== '' ? user.accent : '166'
            return (
              <button
                key={a.h}
                type="button"
                className={`accent-dot${current === String(a.h) ? ' active' : ''}`}
                style={{ background: `hsl(${a.h} 55% 46%)` }}
                onClick={() => void handleAccent(a.h)}
                title={a.label}
                aria-label={`主题色：${a.label}`}
                aria-pressed={current === String(a.h)}
              />
            )
          })}
        </div>
      </div>

      {/* 通知：本地日历（原生壳优先：为每条 DDL 各写一个事件）+ 网页 .ics 导入回退 */}
      <div className="profile-section-title">到期提醒</div>
      <div className="card profile-card">
        <div className="notif-head">
          <IconCalendar size={18} />
          <div>
            <div className="notif-title">{nativeBridge ? '本地日历（原生）' : '日历提醒'}</div>
            <div className="notif-sub">
              {nativeBridge
                ? '已连接原生壳：点下面的按钮由 App 直接申请日历权限，授权后为每条未完成的 DDL 建一个带提醒的日历事件（也可在 DDL 列表里单条添加）'
                : '网页端无法直接写系统日历：下载 .ics 用「日历」打开即可授权导入（每条 DDL 一个事件）'}
            </div>
          </div>
        </div>

        {nativeBridge ? (
          <button
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => void writeNativeCalendar()}
            disabled={calBusy}
          >
            <IconCheck size={16} />
            {calBusy ? '正在写入 DDL…' : '申请日历权限并写入全部 DDL'}
          </button>
        ) : (
          <button
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => void importIcs()}
            disabled={!feedToken || calBusy}
          >
            <IconDownload size={16} />
            {calBusy ? '正在导出…' : '导入到系统日历（.ics）'}
          </button>
        )}

        <div className="notif-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copyFeed()}>
            复制订阅地址
          </button>
          {!nativeBridge && (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void importIcs()}
            >
              下载 .ics
            </button>
          )}
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void regenFeed()}>
            重置
          </button>
        </div>
        {!nativeBridge && feedToken && (
          <input
            readOnly
            className="input notif-url"
            value={feedUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        {calMsg && <div className="notif-msg">{calMsg}</div>}
      </div>

      {/* 帮助 / 常见问题 */}
      <div className="profile-section-title">
        <IconHelp size={16} style={{ marginRight: 6, verticalAlign: '-3px' }} />
        帮助
      </div>
      <div className="card profile-card help-card">
        <details className="faq-item">
          <summary>怎么把课表导进来？</summary>
          <p>课表页点「课表导入」：默认从「智慧课程平台」读取（也可切换到本科教务），用学号 + MIS 密码登录即可自动读取课名、时间、教室与学分；也支持拍照识别或手动添加单门课。</p>
        </details>
        <details className="faq-item">
          <summary>放假周的周数为什么对得上？</summary>
          <p>用「智慧课程平台」来源导入时会一并同步平台的校历周次表。国庆等放假周不排课、平台也不计教学周，本站按校历映射周次，放假周显示「放假无课程」，不会出现「第 0 教学周」这类错位。若改用「本科教务」导入（它只给「第 N 周」），放假之后的周次可能整体偏一周，可在「设置 → 学期设置」核对开学日。</p>
        </details>
        <details className="faq-item">
          <summary>考试怎么自动提醒？</summary>
          <p>在「DDL」页点「一键添加考试信息」，登录教务系统抓取本学期考试，系统会自动生成一条高优先级 DDL 倒计时，临近考试会提醒。</p>
        </details>
        <details className="faq-item">
          <summary>教务账号密码安全吗？</summary>
          <p>导入用的学号 / 密码仅用于本次登录抓取，提交后服务端瞬时使用、不落库；应用登录密码经哈希存储，无法还原明文。</p>
        </details>
        <details className="faq-item">
          <summary>我的数据存在哪里？</summary>
          <p>存在你部署的服务器 SQLite 数据库里，可随时在后台导出与备份；删除课程不会连带删除已生成的 DDL。</p>
        </details>
        <details className="faq-item">
          <summary>忘记密码 / 发现 bug / 想提建议怎么办？</summary>
          <p>点上面的「联系管理员」提交一条反馈，管理员会收到通知并在站内回复你；也可以点「消息通知」查看历史回复。</p>
        </details>
      </div>

      {/* 官网首页
          应用本身在 /app，官网在 /，两边是分开的 —— 应用里没有别的地方能回到官网，
          而"下载安装包、常见问题、联系方式、支持作者"这些都只在官网有，所以在这里留个入口。
          ⚠️ 地址必须带 `?home=1`：首页的入口分流脚本对带这个参数的访问不做跳转，
             否则本应用的用户点进去会被立刻弹回 /app —— 点了等于没点。
          用 <a> 而不是 button：真正的链接可以长按复制、可以新标签打开，也不依赖 JS。 */}
      <div className="profile-section-title">关于</div>
      <div className="pv-entries">
        {/* 检查更新：只有 App 壳里才有意义（浏览器里版本号跟着页面刷新走，没有"装了什么版本"）。
            v1.7+ 的壳自带原生 checkUpdate（弹原生对话框）；更早的壳没有这个桥，
            改由网页侧的更新门处理（lib/appUpdate.ts + components/AppUpdateGate.tsx），
            否则 1.3~1.6 的用户在这里连一行"检查更新"都看不到。 */}
        {isInAppShell() && (
          <button
            className="pv-entry"
            type="button"
            onClick={() => (appBridge()?.checkUpdate ? appBridge()!.checkUpdate!() : requestManualUpdateCheck())}
          >
            <span className="pv-entry-ico"><IconRefresh size={20} /></span>
            <span className="pv-entry-main">
              <span className="pv-entry-title">检查更新</span>
              <span className="pv-entry-sub">
                当前 App 版本 v{appBridge()?.versionName?.() || shellVersion().versionName || '—'} · 有新版本会在这里提示
              </span>
            </span>
            <IconChevronRight size={18} />
          </button>
        )}
        <a className="pv-entry" href="/?home=1">
          <span className="pv-entry-ico"><IconHome size={20} /></span>
          <span className="pv-entry-main">
            <span className="pv-entry-title">官网首页</span>
            <span className="pv-entry-sub">下载安装包 · 常见问题 · 联系与支持</span>
          </span>
          <IconChevronRight size={18} />
        </a>
      </div>

      {/* 游客没有"退出账号"可言（他本来就没登录），给他登录入口；真实账号才是退出 */}
      {isGuest ? (
        <button className="btn btn-primary btn-block" style={{ marginTop: 16 }} onClick={() => onRequireLogin?.()}>
          登录 / 注册
        </button>
      ) : (
        <button className="btn btn-danger btn-block" style={{ marginTop: 16 }} onClick={onLogout}>
          退出账号
        </button>
      )}

      {/* 底部留白：避免最后一行被底栏盖住 */}
      <div className="profile-tail" />
    </div>
  )
}
