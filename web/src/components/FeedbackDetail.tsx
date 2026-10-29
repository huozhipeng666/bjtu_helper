import { useEffect, useState } from 'react'
import type { Feedback, FeedbackReply } from '../types'
import { getFeedbackDetail } from '../api'
import { fmtAgo } from '../lib/date'
import { FEEDBACK_STATUS_LABEL, FEEDBACK_TYPE_LABEL } from '../constants'
import { IconChevronLeft } from '../icons'

interface FeedbackDetailProps {
  id: number
  onBack: () => void
}

/** 工单详情（用户视角）：我的描述 + 管理员回复时间线 */
export default function FeedbackDetail({ id, onBack }: FeedbackDetailProps) {
  const [data, setData] = useState<{ feedback: Feedback; replies: FeedbackReply[] } | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    setLoaded(false)
    setError('')
    getFeedbackDetail(id, ac.signal)
      .then(setData)
      .catch((e) => {
        if (ac.signal.aborted) return
        setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoaded(true)
      })
    return () => ac.abort()
  }, [id])

  const f = data?.feedback

  return (
    <div className="subpage">
      <div className="subpage-head">
        <button className="icon-btn" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={20} />
        </button>
        <h3>反馈详情</h3>
      </div>

      {!loaded && <div className="empty-hint" style={{ padding: 16 }}>加载中…</div>}
      {loaded && error && <div className="form-error">{error}</div>}

      {f && (
        <>
          <div className="card fb-detail">
            <div className="fb-detail-title">{f.title}</div>
            <div className="fb-row-meta">
              <span className={`fb-chip fb-chip-${f.status}`}>{FEEDBACK_STATUS_LABEL[f.status]}</span>
              <span className="fb-chip fb-chip-type">{FEEDBACK_TYPE_LABEL[f.type]}</span>
              <span>{fmtAgo(f.createdAt)}</span>
            </div>

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

            {f.contact && <div className="fb-detail-contact">联系方式：{f.contact}</div>}

            {/* 迁移来源提示：这类工单不是"用户新提的问题"，管理员回复时也需要知道上下文 */}
            {f.migratedFromPostId !== null && (
              <div className="fb-detail-note">
                这条记录由原「论坛」的帖子迁移而来（原帖 #{f.migratedFromPostId}）。
              </div>
            )}
          </div>

          <div className="profile-section-title">
            管理员回复{data.replies.length > 0 ? `（${data.replies.length}）` : ''}
          </div>

          {data.replies.length === 0 ? (
            <div className="empty-hint" style={{ padding: 12 }}>
              {f.status === 'closed' ? '该工单已关闭，没有回复记录。' : '还没有回复，管理员看到后会尽快处理。'}
            </div>
          ) : (
            <div className="fb-replies">
              {data.replies.map((r) => (
                <div key={r.id} className="fb-reply">
                  <div className="fb-reply-head">
                    <span className="fb-reply-who">{r.admin}</span>
                    <span className="fb-reply-when">{fmtAgo(r.createdAt)}</span>
                  </div>
                  <p className="fb-reply-body">{r.content}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
