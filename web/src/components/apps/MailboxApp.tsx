/**
 * 校园邮箱（「应用」→ 校园服务）—— 收件箱 + 写信/回复。
 *
 * 数据链路见 server/src/mailbox.ts（Coremail 中转，接口移植自 KMP 参考仓库）。
 * 本页做：登录 → 收件箱列表 → 邮件详情 → 附件下载 → **写信 / 回复 / 发送**。
 *
 * ## 2026-10-20：补上写信（上游有、本仓库原先没有）
 *
 * 发送是**两步**：先 `beginCompose` 建草稿拿 id，再 `sendMail` 投递。
 * 拆开的原因：投递失败时草稿还在，用户改一改能重发；一步到位失败就全丢了。
 * 「取消」会调 `discardCompose` 清掉草稿，不让它堆在用户的草稿箱里。
 *
 * ## 为什么正文只支持纯文本
 *
 * Coremail 的编辑器是富文本，但富文本要在服务端拼 HTML 白名单，
 * 而本项目服务端没有 sanitizer（也不想为这一个功能引依赖）。
 * 所以只支持纯文本，由服务端转义后转成 `<br>` 分隔的 HTML —— 宁可少个功能，
 * 也不能让用户在不知情的情况下发出被剥掉内容的邮件。
 * **附件同样不支持**：上传要另走一遍 multipart，且静默丢掉附件比明说没有更糟。
 *
 * 会话策略（2026-10-14 会话池）：打开时先探测 —— 任一教务应用登录过一次的会话
 * 会留在池里（不活跃 2 小时），这里直接复用（"打开应用自动登录"）；没有才显示登录表单。
 * 离开页面**不销毁**会话（其他应用还要用）；「退出」按钮才会销毁共享会话。
 */
import { useEffect, useRef, useState } from 'react'
import {
  beginCompose, destroyMisSession, discardCompose, downloadMailAttachment,
  listMails, misLogin, readMail, sendMail
} from '../../api'
import { probeSessionSid } from '../../lib/misSession'
import { saveBlob } from '../../lib/saveFile'
import type { MailDetail, MailSummary } from '../../types'
import { MAILBOX_URL } from '../../lib/appRegistry'
import { IconDownload, IconRefresh, IconSend } from '../../icons'
import AppShell from './AppShell'
import AppState from './AppState'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import type { AppEntryHostProps } from './types'

type Phase = 'login' | 'list' | 'detail' | 'compose'

const PAGE_SIZE = 30

/** "2026-10-14 10:30:12" → "10/14 10:30"（非今年补年份前缀） */
function fmtTime(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/.exec(s.trim())
  if (!m) return s
  const prefix = m[1] === String(new Date().getFullYear()) ? '' : `${m[1]}-`
  return `${prefix}${Number(m[2])}/${Number(m[3])}${m[4] ? ` ${m[4]}` : ''}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function MailboxApp({ onBack, onToast }: AppEntryHostProps) {
  const [phase, setPhase] = useState<Phase>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /* 回到登录态时 +1，让 MisLoginForm 换一张验证码（保留已填的学号密码） */
  const [loginKey, setLoginKey] = useState(0)

  const [messages, setMessages] = useState<MailSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loadingList, setLoadingList] = useState(false)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  /** 打开页面时的会话池探测中（命中则跳过登录表单直接进入） */
  const [probing, setProbing] = useState(true)

  const sidRef = useRef('')
  /** 当前打开的邮件 id —— 详情加载失败后「重新加载」要能原样再请求一次 */
  const openIdRef = useRef('')

  /* ---------------- 写信状态 ---------------- */
  const [compose, setCompose] = useState<{
    draftId: string
    replyToId: string | null
    to: string
    cc: string
    bcc: string
    subject: string
    text: string
    showCc: boolean
  } | null>(null)
  const [composeSending, setComposeSending] = useState(false)
  const [composeError, setComposeError] = useState('')

  /*
   * ⚠️ 卸载时不再销毁会话（2026-10-14 会话池）：课件 / 成绩单 / 数据同步
   * 还要复用同一份登录；不活跃 2 小时由服务端 TTL 兜底清理。
   */

  /* 打开页面：先探测会话池 —— 有可复用登录直接进收件箱（"自动登录"），没有才显示登录表单。
     验证码由 MisLoginForm 自己拉（内部去重，不会重复消耗学校侧配额）。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) {
        try {
          const r = await listMails(found.sid, 0, PAGE_SIZE)
          if (cancelled) return
          sidRef.current = found.sid
          setTotal(r.total)
          setMessages(r.messages)
          setPhase('list')
          setProbing(false)
          return
        } catch {
          /* 学校侧会话可能已先失效：静默回退到登录表单，让用户重新登录一次 */
        }
      }
      if (cancelled) return
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 会话类错误 → 回登录页并换一张验证码；其他错误就地提示 */
  function fail(err: unknown, fallback: string) {
    const msg = err instanceof Error ? err.message : fallback
    setError(msg)
    if (/会话/.test(msg)) {
      sidRef.current = ''
      setPhase('login')
      setLoginKey((k) => k + 1)
    }
  }

  async function loadList(reset: boolean) {
    const start = reset ? 0 : messages.length
    setLoadingList(true)
    setError('')
    try {
      if (!sidRef.current) {
        setPhase('login')
        setLoginKey((k) => k + 1)
        return
      }
      const r = await listMails(sidRef.current, start, PAGE_SIZE)
      setTotal(r.total)
      setMessages((prev) => (reset ? r.messages : [...prev, ...r.messages]))
      setPhase('list')
    } catch (err) {
      fail(err, '收件箱加载失败')
    } finally {
      setLoadingList(false)
    }
  }

  async function handleLogin(cred: MisLoginCredential) {
    setError('')
    setBusy(true)
    try {
      await misLogin(cred)
      sidRef.current = cred.sid
      await loadList(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      /* 登录失败（密码错 / 验证码已用掉）→ 换一张新验证码 */
      setLoginKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  async function openMail(m: MailSummary) {
    openIdRef.current = m.id
    setPhase('detail')
    setDetail(null)
    setLoadingDetail(true)
    setError('')
    try {
      const d = await readMail(sidRef.current, m.id)
      setDetail(d)
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, isRead: true } : x)))
    } catch (err) {
      fail(err, '邮件加载失败')
    } finally {
      setLoadingDetail(false)
    }
  }

  /** 详情页「重新加载」：用记住的 id 原样再请求一次（不依赖 list 里是否还有这条） */
  async function reloadDetail() {
    const id = openIdRef.current
    if (!id) return
    setDetail(null)
    setLoadingDetail(true)
    setError('')
    try {
      const d = await readMail(sidRef.current, id)
      setDetail(d)
    } catch (err) {
      fail(err, '邮件加载失败')
    } finally {
      setLoadingDetail(false)
    }
  }

  async function onDownloadAttachment(att: { id: string; name: string }) {
    if (!att.id || !detail) {
      onToast('该附件缺少下载标识')
      return
    }
    setBusy(true)
    try {
      const blob = await downloadMailAttachment(sidRef.current, detail.id, att.id, att.name)
      /* ⚠️ 走 saveBlob：Android WebView 里 <a download> 点了没反应 */
      const r = await saveBlob(blob, att.name)
      onToast(r.message)
    } catch (err) {
      onToast(err instanceof Error ? err.message : '附件下载失败')
    } finally {
      setBusy(false)
    }
  }

  function exitSession() {
    if (sidRef.current) destroyMisSession(sidRef.current).catch(() => undefined)
    sidRef.current = ''
    setMessages([])
    setTotal(0)
    setDetail(null)
    setError('')
    setCompose(null)
    setPhase('login')
    setLoginKey((k) => k + 1)
  }

  /* ---------------- 写信 / 回复 ---------------- */

  /**
   * 打开写信界面。
   * `replyTo` 有值就是回复（预填收件人与引用正文），没有就是新邮件。
   *
   * 先建草稿再显示界面而不是反过来：草稿 id 是投递凭据，
   * 而且回复的预填内容（收件人/引用正文）只有平台知道。
   */
  async function openCompose(replyTo: MailDetail | null) {
    setError('')
    setBusy(true)
    try {
      const r = await beginCompose(sidRef.current, replyTo ? replyTo.id : null)
      setCompose({
        draftId: r.draft.id,
        replyToId: replyTo ? replyTo.id : null,
        /* 回复时优先用平台预填的收件人（=原发件人），它是权威的；
           平台没给就退回详情里的 from */
        to: (r.draft.to.length > 0 ? r.draft.to : replyTo?.from ?? []).join(', '),
        cc: r.draft.cc.join(', '),
        bcc: r.draft.bcc.join(', '),
        subject: r.draft.subject || (replyTo ? `回复：${replyTo.subject}` : ''),
        /* 引用正文由平台生成（含原始邮件与分隔线）；用户可自行删改 */
        text: r.draft.bodyText,
        showCc: r.draft.cc.length > 0
      })
      setPhase('compose')
    } catch (err) {
      fail(err, '打开写信界面失败')
    } finally {
      setBusy(false)
    }
  }

  /** 取消写信：尽力清掉服务端草稿，然后回列表 */
  async function cancelCompose() {
    const c = compose
    setCompose(null)
    setPhase('list')
    if (c) await discardCompose(sidRef.current, c.draftId).catch(() => undefined)
  }

  async function submitCompose() {
    const c = compose
    if (!c) return
    if (!c.to.trim()) {
      setComposeError('请填写收件人')
      return
    }
    setComposeSending(true)
    setComposeError('')
    try {
      await sendMail({
        sid: sidRef.current,
        draftId: c.draftId,
        to: c.to,
        cc: c.cc,
        bcc: c.bcc,
        subject: c.subject,
        text: c.text,
        replyTo: c.replyToId
      })
      setCompose(null)
      onToast('邮件已发送')
      /* 回列表并刷新：新邮件在「已发送」里，收件箱不需要动，
         但顺手刷一次能让用户确认自己没有写错收件人（连发两封的代价更高） */
      setPhase('list')
      void loadList(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发送失败'
      setComposeError(msg)
      /* 会话失效：草稿已经没意义了，直接丢掉并回登录页 */
      if (/会话/.test(msg)) {
        setCompose(null)
        setPhase('login')
        setLoginKey((k) => k + 1)
      }
    } finally {
      setComposeSending(false)
    }
  }

  /* ---------------- 会话池探测中（打开页面的第一瞬间） ---------------- */
  if (probing) {
    return (
      <AppShell title="校园邮箱" onBack={onBack}>
        <AppState kind="loading" title="正在检查登录状态…" hint="如果之前登录过教务，会直接复用，不必再输验证码。" />
      </AppShell>
    )
  }

  /* ---------------- 登录阶段 ---------------- */
  if (phase === 'login') {
    return (
      <AppShell
        title="校园邮箱"
        onBack={onBack}
        lead="登录学校统一身份认证后，在应用内收发校内邮件（支持附件下载、写信与回复；暂不支持发附件）。"
      >
        <MisLoginForm
          busy={busy}
          error={error}
          refreshToken={loginKey}
          submitLabel="登录并打开收件箱"
          onLogin={handleLogin}
        />
        <div className="app-note is-tight">
          邮箱随学校统一身份认证开通。也可以直接打开
          <a className="mail-fallback-link" href={MAILBOX_URL} target="_blank" rel="noopener noreferrer">
            网页版邮箱
          </a>
          。
        </div>
      </AppShell>
    )
  }

  /* ---------------- 列表阶段 ---------------- */
  if (phase === 'list') {
    return (
      <AppShell
        title="校园邮箱"
        onBack={onBack}
        action={
          <div className="app-head-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void openCompose(null)}
            >
              <IconSend size={15} /> 写邮件
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void loadList(true)}
              aria-label="刷新"
              disabled={loadingList}
            >
              <IconRefresh size={19} />
            </button>
            <button type="button" className="btn-ghost" onClick={exitSession}>退出</button>
          </div>
        }
        lead={`收件箱 · 共 ${total} 封`}
      >
        {error && (
          <AppState
            kind="error"
            title={error}
            hint="教务会话可能已过期，重新登录一次通常就能恢复。"
            onRetry={() => void loadList(true)}
            retryLabel="重新加载"
          />
        )}
        {loadingList && messages.length === 0 ? (
          <AppState kind="loading" title="正在打开收件箱…" />
        ) : messages.length === 0 ? (
          !error && <AppState kind="empty" title="收件箱是空的" hint="有新邮件时会出现在这里。" />
        ) : (
          <>
            <div className="mail-list">
              {messages.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mail-row${m.isRead ? '' : ' is-unread'}`}
                  onClick={() => void openMail(m)}
                >
                  <div className="mail-top">
                    <span className="mail-sender">{m.sender || '（未知发件人）'}</span>
                    <span className="mail-time">{fmtTime(m.sentAt)}</span>
                  </div>
                  <div className="mail-subject">
                    {!m.isRead && <span className="mail-dot" aria-hidden="true" />}
                    {m.subject || '(无主题)'}
                    {m.hasAttachments && <span className="mail-att">附件</span>}
                  </div>
                  {m.preview && <div className="mail-preview">{m.preview}</div>}
                </button>
              ))}
            </div>
            {messages.length < total && (
              <div className="app-actions">
                <button type="button" className="btn-ghost" disabled={loadingList} onClick={() => void loadList(false)}>
                  {loadingList ? '加载中…' : `加载更多（已显示 ${messages.length} / ${total}）`}
                </button>
              </div>
            )}
          </>
        )}
      </AppShell>
    )
  }

  /* ---------------- 写信阶段 ---------------- */
  if (phase === 'compose' && compose) {
    return (
      <AppShell
        title={compose.replyToId ? '回复邮件' : '写邮件'}
        onBack={() => void cancelCompose()}
        action={
          <div className="app-head-actions">
            <button
              type="button"
              className="btn-ghost mail-send-btn"
              disabled={composeSending}
              onClick={() => void submitCompose()}
            >
              <IconSend size={15} /> {composeSending ? '发送中…' : '发送'}
            </button>
          </div>
        }
        lead="正文为纯文本，不支持附件。发送后可在「网页版邮箱 → 已发送」里查看。"
      >
        {composeError && (
          <div className="mail-compose-error">
            {composeError}
            <a className="mail-fallback-link" href={MAILBOX_URL} target="_blank" rel="noopener noreferrer">
              改用网页版
            </a>
          </div>
        )}
        <div className="mail-compose">
          <label className="mail-field">
            <span className="mail-field-label">收件人</span>
            <input
              className="mail-input"
              value={compose.to}
              onChange={(e) => setCompose({ ...compose, to: e.target.value })}
              placeholder="多个地址用逗号分隔"
              autoComplete="off"
              inputMode="email"
            />
          </label>

          {/* 抄送默认折叠：新邮件大部分用不到，但回复时平台可能已经填了 */}
          {compose.showCc ? (
            <label className="mail-field">
              <span className="mail-field-label">抄送</span>
              <input
                className="mail-input"
                value={compose.cc}
                onChange={(e) => setCompose({ ...compose, cc: e.target.value })}
                placeholder="多个地址用逗号分隔"
                autoComplete="off"
                inputMode="email"
              />
            </label>
          ) : (
            <button
              type="button"
              className="mail-cc-toggle"
              onClick={() => setCompose({ ...compose, showCc: true })}
            >
              + 添加抄送
            </button>
          )}

          <label className="mail-field">
            <span className="mail-field-label">主题</span>
            <input
              className="mail-input"
              value={compose.subject}
              onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
              placeholder="（可留空）"
              autoComplete="off"
            />
          </label>

          <label className="mail-field mail-field-grow">
            <span className="mail-field-label">正文</span>
            <textarea
              className="mail-textarea"
              value={compose.text}
              onChange={(e) => setCompose({ ...compose, text: e.target.value })}
              placeholder="在这里输入正文…"
              rows={12}
            />
          </label>
        </div>

        <div className="app-note is-tight">
          发送前请确认收件人 —— 邮件发出去无法撤回。
        </div>
      </AppShell>
    )
  }

  /* ---------------- 详情阶段 ---------------- */
  return (
    <AppShell
      title="邮件"
      onBack={() => {
        setPhase('list')
        setDetail(null)
        setError('')
      }}
    >
      {loadingDetail ? (
        <AppState kind="loading" title="正在加载邮件内容…" />
      ) : !detail ? (
        <AppState
          kind="error"
          title={error || '邮件内容不可用'}
          hint="可能已被撤回或删除。返回列表刷新一次试试。"
          onRetry={() => void reloadDetail()}
          retryLabel="重新加载"
        />
      ) : (
        <>
          <div className="card profile-card mail-detail-head">
            <div className="mail-detail-subject">{detail.subject || '(无主题)'}</div>
            <div className="mail-detail-meta">
              <span>发件人：{detail.from.join(', ') || '（未知）'}</span>
              {detail.sentAt && <span>时间：{detail.sentAt}</span>}
              <span>收件人：{detail.to.join(', ')}</span>
              {detail.cc.length > 0 && <span>抄送：{detail.cc.join(', ')}</span>}
            </div>
          </div>
          <div className="mail-body">{detail.bodyText || '（正文为空）'}</div>
          <div className="app-actions mail-detail-acts">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void openCompose(detail)}
            >
              <IconSend size={15} /> 回复
            </button>
          </div>
          {detail.attachments.length > 0 && (
            <section className="apps-group">
              <div className="profile-section-title">
                附件 <span className="hw-count">{detail.attachments.length}</span>
              </div>
              {detail.attachments.map((att, i) => (
                <div className="mail-att-row" key={att.id || `${att.name}-${i}`}>
                  <span className="mail-att-name">{att.name}</span>
                  {att.sizeBytes !== null && att.sizeBytes > 0 && (
                    <span className="mail-att-size">{fmtSize(att.sizeBytes)}</span>
                  )}
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy || !att.id}
                    onClick={() => void onDownloadAttachment(att)}
                  >
                    <IconDownload size={15} /> 下载
                  </button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </AppShell>
  )
}
