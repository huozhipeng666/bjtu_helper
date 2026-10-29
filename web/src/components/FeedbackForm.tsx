import { useRef, useState } from 'react'
import type { FeedbackType } from '../types'
import { createFeedback, uploadFeedbackImage } from '../api'
import { compressAvatar } from '../lib/avatar'
import { FEEDBACK_TYPE_HINT, FEEDBACK_TYPE_LABEL } from '../constants'
import { IconChevronLeft, IconClose, IconPlus, IconSend } from '../icons'

interface FeedbackFormProps {
  onBack: () => void
  /** 提交成功：把新工单 id 交回上层（用于直接跳到详情） */
  onSubmitted: (id: number) => void
}

const TYPES: FeedbackType[] = ['bug', 'suggestion', 'consult', 'other']
const TITLE_MAX = 60
const CONTENT_MAX = 5000
const CONTACT_MAX = 60
const MAX_IMAGES = 9

/**
 * 「联系管理员」表单。
 *
 * 三个设计取舍：
 *  1. **类型用卡片而不是下拉**：四个选项加一句引导语直接铺开，用户不需要展开才知道有什么可选项，
 *     也就更容易选对分类 —— 分类选错会直接拖慢管理员的处理效率。
 *  2. **联系方式选填**：服务端 users 表没有邮箱字段，管理员无法主动发信。
 *     但强制填写会劝退只想随手报个 bug 的人，所以标注为选填并说明用途。
 *  3. **图片走「选图即上传」**（与旧论坛一致）：压缩后立刻传，拿到 /uploads 相对路径再随表单提交。
 *     代价是取消提交会留下孤儿文件（由 uploads.ts 的 24 小时清扫兜底），
 *     换来的是提交时不必等待整批图片上传。
 */
export default function FeedbackForm({ onBack, onSubmitted }: FeedbackFormProps) {
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  /** 选图：本地压缩 → 逐张上传 → 追加到预览；失败中断并提示 */
  async function onPickFiles(list: FileList | null | undefined) {
    if (!list || list.length === 0) return
    const room = MAX_IMAGES - images.length
    const files = Array.from(list).slice(0, room)
    if (files.length === 0) return
    setError('')
    setUploading(true)
    try {
      for (const f of files) {
        const dataUrl = await compressAvatar(f, 1280, 0.8)
        const r = await uploadFeedbackImage(dataUrl)
        setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, r.url]))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '图片上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function submit() {
    setError('')
    if (!title.trim()) {
      setError('请填写标题')
      return
    }
    if (!content.trim()) {
      setError('请描述一下遇到的问题')
      return
    }
    setSubmitting(true)
    try {
      const { id } = await createFeedback({
        type,
        title: title.trim(),
        content: content.trim(),
        contact: contact.trim(),
        images
      })
      onSubmitted(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="subpage">
      <div className="subpage-head">
        <button className="icon-btn" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={20} />
        </button>
        <h3>联系管理员</h3>
      </div>

      <p className="subpage-lead">
        遇到的问题、想要的功能都可以在这里提。提交后会生成一张工单，管理员回复时你会收到站内信通知。
      </p>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="profile-section-title">问题类型</div>
      <div className="fb-type-grid" role="radiogroup" aria-label="问题类型">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            className={`fb-type${type === t ? ' active' : ''}`}
            onClick={() => setType(t)}
          >
            <span className="fb-type-name">{FEEDBACK_TYPE_LABEL[t]}</span>
            <span className="fb-type-hint">{FEEDBACK_TYPE_HINT[t]}</span>
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="fb-title">标题</label>
        <input
          id="fb-title"
          className="input"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="一句话说清楚问题"
        />
        <div className="field-counter">{title.length}/{TITLE_MAX}</div>
      </div>

      <div className="field">
        <label htmlFor="fb-content">详细描述</label>
        <textarea
          id="fb-content"
          className="textarea"
          style={{ minHeight: 140 }}
          value={content}
          maxLength={CONTENT_MAX}
          onChange={(e) => setContent(e.target.value)}
          placeholder={
            '尽量写清楚这几点，能大幅加快定位速度：\n' +
            '· 在哪个页面 / 点了什么\n' +
            '· 期望看到什么，实际看到什么\n' +
            '· 什么时候开始的、是否每次都能复现'
          }
        />
        <div className="field-counter">{content.length}/{CONTENT_MAX}</div>
      </div>

      <div className="field">
        <label>截图（选填，最多 {MAX_IMAGES} 张）</label>
        <div className="cw-pick">
          {images.map((url, i) => (
            <div className="cw-pick-item" key={url}>
              <img src={url} alt={`截图 ${i + 1}`} />
              <button
                className="cw-pick-x"
                onClick={() => setImages((prev) => prev.filter((x) => x !== url))}
                aria-label="移除图片"
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <button className="cw-pick-add" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <span className="recog-spin" /> : <IconPlus size={18} />}
              <span>加图片</span>
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void onPickFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="fb-contact">联系方式（选填）</label>
        <input
          id="fb-contact"
          className="input"
          value={contact}
          maxLength={CONTACT_MAX}
          onChange={(e) => setContact(e.target.value)}
          placeholder="邮箱 / QQ / 微信，急事时管理员会直接找你"
        />
      </div>

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 16 }}
        onClick={() => void submit()}
        disabled={submitting || uploading}
      >
        <IconSend size={16} />
        {uploading ? '图片上传中…' : submitting ? '提交中…' : '提交反馈'}
      </button>
    </div>
  )
}
