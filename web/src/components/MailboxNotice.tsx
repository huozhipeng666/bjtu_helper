/**
 * 消息通知页顶部的「校园邮箱」入口：显示新邮件数，点一下直接进邮箱应用。
 *
 * ## 为什么从「本周」页搬到这里
 *
 * 它原本是本周页的一行三格状态条（新邮件 / 校园卡余额 / 校园网余额），
 * 占着首屏最贵的位置。可这三条都是**低频、临时**的信息：余额一周看一次就够，
 * 而首屏真正该给的是 DDL 和课程。现在：
 *   - 校园卡 / 校园网余额只在「应用」里看（各自点进去就是明细）；
 *   - 邮件提醒属于"通知"，搬进「消息通知」与站内信并列才符合用户心智。
 *
 * ## 为什么它自己探测会话
 *
 * 通知中心本身不需要 MIS 会话（站内信走本站接口），而这条要打学校接口。
 * 让 MessageCenter 去持有 sid 会把「是否登录过教务」塞进通知的数据流里；
 * 这里失败只是少一行，拿不到就静静不显示 —— 与原来的首页状态条同口径。
 */
import { useEffect, useState } from 'react'
import { getHomeStatus, type HomeStatus, type HomeStatusFlags } from '../api'
import { probeSessionSid } from '../lib/misSession'
import { IconMail, IconChevronRight } from '../icons'

/** 探测结果的进程内缓存：应用内切页不该反复打 /api/mis/session */
let probeCache: { at: number; sid: string } | null = null
const PROBE_TTL_MS = 60_000

async function resolveSid(): Promise<string | null> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.sid
  const p = await probeSessionSid()
  if (!p) {
    probeCache = null
    return null
  }
  probeCache = { at: Date.now(), sid: p.sid }
  return p.sid
}

interface MailboxNoticeProps {
  /** 点这一行 → 打开「校园邮箱」应用 */
  onOpenMailbox: () => void
}

export default function MailboxNotice({ onOpenMailbox }: MailboxNoticeProps) {
  const [status, setStatus] = useState<HomeStatus | null>(null)
  const [flags, setFlags] = useState<HomeStatusFlags | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      const sid = await resolveSid()
      if (!sid || cancelled) return
      try {
        const r = await getHomeStatus(sid, ac.signal)
        if (!cancelled) {
          setStatus(r.status)
          setFlags(r.flags)
        }
      } catch {
        /* 会话可能刚过期：清掉探测缓存，下次进来重探 */
        probeCache = null
        if (!cancelled) {
          setStatus(null)
          setFlags(null)
        }
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  /* 不因为拿不到新邮件数就整行消失：
     这一行的首要作用是「通知中心里能进邮箱」这个入口本身，新邮件数只是附注。
     老状态条拿不到就 return null 是对的（那一行还占着首屏），搬到这里则相反 ——
     入口藏起来，用户就再也找不到邮箱在哪儿了。 */
  const mail = status ? Number.parseInt(status.newMailCount, 10) : NaN
  const hasNew = flags?.hasNewMail === true
  const mailLabel = Number.isFinite(mail) ? String(mail) : (status?.newMailCount ?? '')

  return (
    <button
      type="button"
      className={`mailbox-row${hasNew ? ' has-new' : ''}`}
      onClick={onOpenMailbox}
      aria-label={hasNew ? `校园邮箱，${mailLabel} 封新邮件` : '校园邮箱'}
    >
      <span className="mailbox-ico">
        <IconMail size={16} />
        {hasNew && <span className="mailbox-dot" aria-hidden="true" />}
      </span>
      <span className="mailbox-main">
        <span className="mailbox-title">校园邮箱</span>
        <span className="mailbox-sub">交大邮箱里的通知、作业与教务来信</span>
      </span>
      {hasNew ? (
        <span className="mailbox-count">{mailLabel} 封新邮件</span>
      ) : (
        <span className="mailbox-sub">{flags ? '已读完' : '去看看'}</span>
      )}
      <IconChevronRight size={17} />
    </button>
  )
}
