import { useEffect, useState } from 'react'
import type { StationMessage } from '../types'
import { listMessages, readAllMessages, readMessage } from '../api'
import { fmtAgo } from '../lib/date'
import { IconChevronLeft, IconChevronRight } from '../icons'
import MailboxNotice from './MailboxNotice'

interface MessageCenterProps {
  onBack: () => void
  /** 点开反馈回复类消息 → 跳到对应工单 */
  onOpenFeedback: (id: number) => void
  /** 点开情侣共同计划类消息 → 打开情侣课表（游客会被 App 引导登录） */
  onOpenCouple?: () => void
  /** 点开数据变动类消息 → 打开「应用」目录（用户再去对应应用看明细） */
  onOpenApps?: () => void
  /** 点顶部的「校园邮箱」行 → 打开邮箱应用（含新邮件数） */
  onOpenMailbox?: () => void
  /** 未读数变化时通知上层（红点要同步） */
  onUnreadChanged: () => void
}

/**
 * 站内信收件箱。
 *
 * 已读时机：**点开消息时**标记已读，而不是进入列表就全部已读。
 * 后者会让用户"看了一眼列表但没读内容"的消息也变成已读，红点清空后再也找不到，
 * 是通知中心最常见的体验事故。
 *
 * 消息分四类，点击去向不同（由服务端下发的 `type` 决定，前端不猜）：
 *   feedback_reply —— 打开对应工单
 *   couple_plan    —— 打开情侣课表（共同计划板块）
 *   data_change    —— 打开「应用」目录（用户自己去对应应用看变动明细）
 *   system         —— 只标记已读，不跳转
 *
 * 顶部另有一行「校园邮箱」（新邮件数 + 直达邮箱）：邮件提醒原本挤在「本周」页
 * 首屏的状态条里，而它本质就是一类通知，归到这里才符合心智，也把首屏让给 DDL 与课程。
 */
export default function MessageCenter({
  onBack,
  onOpenFeedback,
  onOpenCouple,
  onOpenApps,
  onOpenMailbox,
  onUnreadChanged
}: MessageCenterProps) {
  const [items, setItems] = useState<StationMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  function reload() {
    setLoaded(false)
    listMessages(false)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoaded(true))
  }

  useEffect(reload, [])

  async function open(m: StationMessage) {
    // 先本地置已读（乐观更新，避免等一次往返才消红点）
    if (!m.read) {
      setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, read: true } : x)))
      try {
        await readMessage(m.id)
        onUnreadChanged()
      } catch {
        /* 标记失败不回滚：下次进列表会从服务端拿到真实状态，不值得为此弹错 */
      }
    }
    if (m.type === 'feedback_reply' && m.feedbackId !== null) onOpenFeedback(m.feedbackId)
    else if (m.type === 'couple_plan') onOpenCouple?.()
    else if (m.type === 'data_change') onOpenApps?.()
  }

  async function markAll() {
    try {
      await readAllMessages()
      setItems((prev) => prev.map((x) => ({ ...x, read: true })))
      onUnreadChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const hasUnread = items.some((m) => !m.read)

  return (
    <div className="subpage">
      <div className="subpage-head">
        <button className="icon-btn" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={20} />
        </button>
        <h3>消息通知</h3>
        {hasUnread && (
          <button className="pill-btn" onClick={() => void markAll()}>
            全部已读
          </button>
        )}
      </div>

      {/* 校园邮箱：新邮件数 + 直达。放列表最上面是因为它和下面的站内信
          一样属于"通知"，只是来源在校内邮箱系统里。 */}
      {onOpenMailbox && <MailboxNotice onOpenMailbox={onOpenMailbox} />}

      {!loaded && <div className="empty-hint" style={{ padding: 16 }}>加载中…</div>}
      {loaded && error && <div className="form-error">{error}</div>}
      {loaded && items.length === 0 && <div className="empty-hint" style={{ padding: 16 }}>暂时没有消息</div>}

      {loaded &&
        items.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`msg-row${m.read ? '' : ' unread'}`}
            onClick={() => void open(m)}
          >
            <div className="msg-row-main">
              <div className="msg-row-title">
                {!m.read && <span className="msg-dot" aria-label="未读" />}
                {m.title}
              </div>
              {m.body && <div className="msg-row-body">{cleanBody(m.body)}</div>}
              <div className="msg-row-when">{fmtAgo(m.createdAt)}</div>
            </div>
            {(m.type === 'feedback_reply' || m.type === 'couple_plan' || m.type === 'data_change') && (
              <IconChevronRight size={18} />
            )}
          </button>
        ))}
    </div>
  )
}

/**
 * 消息正文里带一个机器可读锚点 `#[plan:<id>]`（服务端写入，供前端知道点击去向）。
 * 它对人没有意义，展示前必须剥掉 —— 否则用户会在通知里看到一行 `#[plan:12]`。
 * 这里只剥离，不用它做跳转：跳转目的地已经由 `type` 表达了，
 * 两个来源都用来判断反而会互相矛盾。
 */
function cleanBody(body: string): string {
  return body.replace(/\n?#\[plan:\d+\]/g, '').trim()
}
