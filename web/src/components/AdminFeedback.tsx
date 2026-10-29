import { useCallback, useEffect, useState } from 'react'
import type { Feedback, FeedbackReply, FeedbackStats, FeedbackStatus, FeedbackType } from '../types'
import { getFeedbackDetail, getFeedbackStats, listAllFeedbacks, replyFeedback, setFeedbackStatus } from '../api'
import { fmtAgo } from '../lib/date'
import { FEEDBACK_STATUS_LABEL, FEEDBACK_TYPE_LABEL } from '../constants'
import Modal from './Modal'
import { IconSearch } from '../icons'

const TYPE_OPTS: { v: FeedbackType | ''; label: string }[] = [
  { v: '', label: '全部类型' },
  { v: 'bug', label: FEEDBACK_TYPE_LABEL.bug },
  { v: 'suggestion', label: FEEDBACK_TYPE_LABEL.suggestion },
  { v: 'consult', label: FEEDBACK_TYPE_LABEL.consult },
  { v: 'other', label: FEEDBACK_TYPE_LABEL.other }
]

const STATUS_OPTS: { v: FeedbackStatus | ''; label: string }[] = [
  { v: '', label: '全部状态' },
  { v: 'pending', label: FEEDBACK_STATUS_LABEL.pending },
  { v: 'replied', label: FEEDBACK_STATUS_LABEL.replied },
  { v: 'closed', label: FEEDBACK_STATUS_LABEL.closed }
]

/**
 * 管理端「反馈管理」。
 *
 * 排序刻意交给服务端（待处理优先浮顶），前端不再二次排序 ——
 * 否则筛选 + 分页时"看到的顺序"和"服务端给的顺序"会不一致，
 * 出现"明明有 20 条待处理，第一页却全是已回复"这类让人怀疑数据丢了的现象。
 */
export default function AdminFeedback() {
  const [items, setItems] = useState<Feedback[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<FeedbackStats | null>(null)
  const [type, setType] = useState<FeedbackType | ''>('')
  const [status, setStatus] = useState<FeedbackStatus | ''>('')
  const [q, setQ] = useState('')
  /* 评审 C4（2026-10-23）：搜索 300ms 防抖。此前每个字符都并行发 2 个请求，
     输一串关键词就是十几次并发（防抖范式见 SyncApp 的同步进度轮询）。 */
  const [qDebounced, setQDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ feedback: Feedback; replies: FeedbackReply[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState(false)

  const PAGE_SIZE = 100

  const reload = useCallback(() => {
    const ac = new AbortController()
    setLoading(true)
    setError('')
    Promise.all([
      listAllFeedbacks(
        { type: type || undefined, status: status || undefined, q: qDebounced.trim() || undefined, limit: PAGE_SIZE },
        ac.signal
      ),
      getFeedbackStats(ac.signal)
    ])
      .then(([list, s]) => {
        setItems(list.items)
        setTotal(list.total)
        setStats(s)
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [type, status, qDebounced])

  useEffect(reload, [reload])

  /* 评审 C5（2026-10-23）：超过一页时支持「加载更多」。此前固定 limit:100 又无提示，
     total>100 时旧工单完全不可见，管理员会以为数据丢了。 */
  async function loadMore() {
    if (loadingMore || items.length >= total) return
    const ac = new AbortController()
    setLoadingMore(true)
    try {
      const list = await listAllFeedbacks(
        {
          type: type || undefined,
          status: status || undefined,
          q: qDebounced.trim() || undefined,
          limit: PAGE_SIZE,
          offset: items.length
        },
        ac.signal
      )
      setItems((prev) => {
        const seen = new Set(prev.map((f) => f.id))
        return [...prev, ...list.items.filter((f) => !seen.has(f.id))]
      })
      setTotal(list.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoadingMore(false)
    }
  }

  async function openDetail(id: number) {
    setOpenId(id)
    setDetail(null)
    setReplyText('')
    setDetailLoading(true)
    try {
      setDetail(await getFeedbackDetail(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  function closeDetail() {
    setOpenId(null)
    setDetail(null)
    setReplyText('')
  }

  async function sendReply() {
    if (openId === null || !replyText.trim()) return
    setBusy(true)
    setError('')
    try {
      await replyFeedback(openId, replyText.trim())
      setReplyText('')
      /* 重新拉详情与列表：回复会同时改状态并写入用户的站内信，
         只更新本地 state 容易出现"列表状态还是待处理、详情已回复"的不一致。 */
      setDetail(await getFeedbackDetail(openId))
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '回复失败')
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(next: FeedbackStatus) {
    if (openId === null) return
    setBusy(true)
    setError('')
    try {
      await setFeedbackStatus(openId, next)
      setDetail(await getFeedbackDetail(openId))
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const f = detail?.feedback

  return (
    <div>
      <div className="page-title" style={{ margin: '14px 2px 0' }}>反馈管理</div>
      <p className="page-sub">
        用户在「个人中心 → 联系管理员」提交的问题与建议，共 {total} 条
        {stats ? ` · 待处理 ${stats.pending}` : ''}
      </p>

      {stats && (
        <div className="stat-grid">
          <div className="stat-card">
            <span className="stat-num">{stats.pending}</span>
            <span className="stat-label">待处理</span>
            <span className="stat-sub">需要尽快回复</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.replied}</span>
            <span className="stat-label">已回复</span>
            <span className="stat-sub">等待用户确认</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.closed}</span>
            <span className="stat-label">已关闭</span>
            <span className="stat-sub">处理完毕</span>
          </div>
          <div className="stat-card">
            <span className="stat-num">{stats.byType.bug}</span>
            <span className="stat-label">Bug 报错</span>
            <span className="stat-sub">
              建议 {stats.byType.suggestion} · 咨询 {stats.byType.consult}
            </span>
          </div>
        </div>
      )}

      <div className="admin-toolbar">
        <div className="admin-search">
          <IconSearch size={15} />
          <input
            className="admin-search-input"
            placeholder="搜索标题或内容"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索反馈"
          />
        </div>
        <div className="admin-filters">
          <select
            className="select admin-select"
            value={type}
            onChange={(e) => setType(e.target.value as FeedbackType | '')}
            aria-label="按类型筛选"
          >
            {TYPE_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <select
            className="select admin-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as FeedbackStatus | '')}
            aria-label="按状态筛选"
          >
            {STATUS_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="card" style={{ color: 'var(--text-2)' }}>加载中…</div>}

      {!loading && items.length === 0 && (
        <div className="card" style={{ color: 'var(--text-2)', fontSize: 13 }}>
          {total === 0 ? '还没有收到任何反馈。' : '没有符合筛选条件的反馈。'}
        </div>
      )}

      {!loading &&
        items.map((it) => (
          <button key={it.id} type="button" className="fb-row" onClick={() => void openDetail(it.id)}>
            <div className="fb-row-main">
              <div className="fb-row-title">{it.title}</div>
              <div className="fb-row-meta">
                <span className={`fb-chip fb-chip-${it.status}`}>{FEEDBACK_STATUS_LABEL[it.status]}</span>
                <span className="fb-chip fb-chip-type">{FEEDBACK_TYPE_LABEL[it.type]}</span>
                <span>#{it.id}</span>
                <span>{it.author}</span>
                <span>{fmtAgo(it.createdAt)}</span>
                {it.images.length > 0 && <span>· {it.images.length} 张图</span>}
                {it.replyCount > 0 && <span>· {it.replyCount} 条回复</span>}
                {it.migratedFromPostId !== null && <span className="fb-chip fb-chip-type">论坛迁移</span>}
              </div>
            </div>
          </button>
        ))}

      {/* 评审 C5：还有更多时给「加载更多」，别让旧工单不可见又无提示 */}
      {!loading && items.length < total && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ margin: '4px auto 16px', display: 'block' }}
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? '加载中…' : `加载更多（还剩 ${total - items.length} 条）`}
        </button>
      )}

      <Modal open={openId !== null} title={f ? `反馈 #${f.id}` : '反馈详情'} onClose={closeDetail}>
        {detailLoading && <div style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</div>}

        {f && (
          <>
            <div className="fb-detail-title">{f.title}</div>
            <div className="fb-row-meta" style={{ marginBottom: 10 }}>
              <span className={`fb-chip fb-chip-${f.status}`}>{FEEDBACK_STATUS_LABEL[f.status]}</span>
              <span className="fb-chip fb-chip-type">{FEEDBACK_TYPE_LABEL[f.type]}</span>
              <span>{f.author}（id {f.userId}）</span>
              <span>{f.createdAt}</span>
            </div>

            <div className="fb-detail-contact">联系方式：{f.contact || '未填写'}</div>

            <p className="fb-detail-body">{f.content}</p>

            {f.images.length > 0 && (
              <div className="fb-detail-imgs">
                {f.images.map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer noopener">
                    <img src={url} alt={`截图 ${i + 1}`} />
                  </a>
                ))}
              </div>
            )}

            {f.migratedFromPostId !== null && (
              <div className="fb-detail-note">由原论坛帖子 #{f.migratedFromPostId} 迁移而来。</div>
            )}

            <div className="profile-section-title" style={{ marginTop: 16 }}>
              回复记录{detail && detail.replies.length > 0 ? `（${detail.replies.length}）` : ''}
            </div>
            {detail && detail.replies.length === 0 && (
              <div className="empty-hint" style={{ padding: 8 }}>还没有回复过</div>
            )}
            <div className="fb-replies">
              {detail?.replies.map((r) => (
                <div key={r.id} className="fb-reply">
                  <div className="fb-reply-head">
                    <span className="fb-reply-who">{r.admin}</span>
                    <span className="fb-reply-when">{fmtAgo(r.createdAt)}</span>
                  </div>
                  <p className="fb-reply-body">{r.content}</p>
                </div>
              ))}
            </div>

            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="admin-reply">回复用户</label>
              <textarea
                id="admin-reply"
                className="textarea"
                style={{ minHeight: 90 }}
                value={replyText}
                maxLength={5000}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="回复后会立即给用户发一条站内信通知"
              />
            </div>

            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => void changeStatus('pending')} disabled={busy}>
                标为待处理
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void changeStatus('closed')} disabled={busy}>
                关闭工单
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void sendReply()}
                disabled={busy || !replyText.trim()}
              >
                {busy ? '提交中…' : '发送回复'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
