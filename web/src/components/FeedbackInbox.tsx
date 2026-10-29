import { useEffect, useState } from 'react'
import type { Feedback } from '../types'
import { listMyFeedbacks } from '../api'
import { fmtAgo } from '../lib/date'
import { FEEDBACK_STATUS_LABEL, FEEDBACK_TYPE_LABEL } from '../constants'
import { IconChevronLeft, IconChevronRight, IconSend } from '../icons'

interface FeedbackInboxProps {
  onBack: () => void
  onOpen: (id: number) => void
  /** 新建反馈（列表为空时的引导按钮） */
  onCompose: () => void
  /** 从详情页返回后需要刷新（管理员可能刚回复过） */
  refreshKey: number
}

/** 我的反馈记录：我提交过的全部工单，按时间倒序 */
export default function FeedbackInbox({ onBack, onOpen, onCompose, refreshKey }: FeedbackInboxProps) {
  const [items, setItems] = useState<Feedback[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    setLoaded(false)
    listMyFeedbacks(ac.signal)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => {
        if (!ac.signal.aborted) setLoaded(true)
      })
    return () => ac.abort()
  }, [refreshKey])

  return (
    <div className="subpage">
      <div className="subpage-head">
        <button className="icon-btn" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={20} />
        </button>
        <h3>我的反馈</h3>
        <button className="icon-btn" onClick={onCompose} aria-label="新建反馈" title="新建反馈">
          <IconSend size={19} />
        </button>
      </div>

      {!loaded && <div className="empty-hint" style={{ padding: 16 }}>加载中…</div>}

      {loaded && items.length === 0 && (
        <div className="fb-empty">
          <p>还没有提交过反馈</p>
          <button className="btn btn-primary btn-sm" onClick={onCompose}>
            联系管理员
          </button>
        </div>
      )}

      {loaded &&
        items.map((f) => (
          <button key={f.id} type="button" className="fb-row" onClick={() => onOpen(f.id)}>
            <div className="fb-row-main">
              <div className="fb-row-title">{f.title}</div>
              <div className="fb-row-meta">
                <span className={`fb-chip fb-chip-${f.status}`}>{FEEDBACK_STATUS_LABEL[f.status]}</span>
                <span className="fb-chip fb-chip-type">{FEEDBACK_TYPE_LABEL[f.type]}</span>
                <span>{fmtAgo(f.createdAt)}</span>
                {f.replyCount > 0 && <span>· {f.replyCount} 条回复</span>}
              </div>
            </div>
            <IconChevronRight size={18} />
          </button>
        ))}
    </div>
  )
}
