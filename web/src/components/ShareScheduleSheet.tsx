/**
 * 「分享课表」弹层（设计稿图3）。
 *
 * 四个开关控制分享图里**包含什么**：地点 / 教师 / 非本周课程 / 起止周次。
 * 为什么这些必须是开关而不是固定内容：课表截图会流到班级群、朋友圈甚至校外，
 * 教室与教师属于"我可能不想让所有人知道"的信息（比如某人在外校借读、或不想暴露导师）。
 * 让用户自己决定带出去什么，比替他决定更负责。
 *
 * 交互流程：**调设置 → 点「预览分享图」→ 全屏预览 → 长按图片保存到相册**。
 * 为什么先弹预览、而不是直接给「保存到相册」：
 *   分享图是发出去就收不回来的东西。让用户在保存前看到**完整的成品**
 *   （而不是设置弹层里一张看不清的小图），是"别把带教室的表发到群里"的最后一道闸。
 * 预览与长按保存的细节见 components/ShareImagePreview.tsx。
 *
 * ⚠️ 分享图的配色是**固定浅色**（见 lib/shareImage.ts 的说明），不跟随深色主题：
 * 它是发给别人的产物，不是自己的界面。
 */
import { useEffect, useState } from 'react'
import type { Period, WeekData } from '../types'
import { getWeek } from '../api'
import {
  canvasToBlob,
  canvasToDataUrl,
  drawScheduleImage,
  saveOrShareImage,
  type ShareImageOptions
} from '../lib/shareImage'
import Modal from './Modal'
import ShareImagePreview from './ShareImagePreview'
import Switch from './Switch'
import { IconRefresh } from '../icons'

interface ShareScheduleSheetProps {
  open: boolean
  /** 当前展示的那一周（与课表页所见一致，避免"分享的不是我正在看的表"） */
  week: WeekData
  periods: Period[]
  onClose: () => void
  onToast?: (msg: string) => void
}

const DEFAULT_OPTS: ShareImageOptions = {
  showLocation: true,
  showTeacher: false,
  showInactive: false,
  showWeeks: false
}

export default function ShareScheduleSheet({ open, week, periods, onClose, onToast }: ShareScheduleSheetProps) {
  const [opts, setOpts] = useState<ShareImageOptions>(DEFAULT_OPTS)
  /** 预览图：data URL（长按可保存，见 ShareImagePreview 的说明） */
  const [previewSrc, setPreviewSrc] = useState('')
  /** 同一张图的 Blob —— 兜底「保存到相册」按钮与 navigator.share 都要用它 */
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /**
   * 「显示非本周课程」需要 inactiveCourses —— 而课表页默认不请求它（见 api.getWeek 注释）。
   * 这里按需补一次请求，而不是让课表页无脑带上：多数用户打开分享只是想发本周的课，
   * 为了一次可能不用的开关让每次翻周都多传一倍数据，不划算。
   */
  const [inactiveWeek, setInactiveWeek] = useState<WeekData | null>(null)
  const [loadingInactive, setLoadingInactive] = useState(false)

  // 换一周：清掉旧预览，避免分享出"上一周"的表
  useEffect(() => {
    setInactiveWeek(null)
    setPreviewSrc('')
    setPreviewBlob(null)
    setPreviewOpen(false)
  }, [week.date])

  // 关掉设置弹层时，压在它上面的预览层也要一起收，否则会留下一层关不掉的浮层
  useEffect(() => {
    if (!open) setPreviewOpen(false)
  }, [open])

  /** 取"带非本周课程"的那份数据（已取过则复用） */
  async function ensureInactive(): Promise<WeekData | null> {
    if (inactiveWeek) return inactiveWeek
    setLoadingInactive(true)
    try {
      const w = await getWeek(week.date, undefined, { inactive: true })
      setInactiveWeek(w)
      return w
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载非本周课程失败')
      return null
    } finally {
      setLoadingInactive(false)
    }
  }

  async function withData(): Promise<WeekData | null> {
    if (!opts.showInactive) return week
    return await ensureInactive()
  }

  function accentHue(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-h').trim()
    const n = Number(raw)
    return Number.isFinite(n) ? n : 166
  }

  function fileName(): string {
    const label = week.weekNumber > 0 ? `第${week.weekNumber}周` : week.weekState === 'holiday' ? '放假周' : '课表'
    return `课表-${label}.png`
  }

  /** 生成分享图并打开预览层 */
  async function doPreview() {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const data = await withData()
      if (!data) return
      const canvas = drawScheduleImage(data, periods, opts, accentHue())
      // 预览用 dataURL（长按可保存），保存按钮用 Blob（下载 / 系统分享都要它）
      const [blob, src] = [await canvasToBlob(canvas), canvasToDataUrl(canvas)]
      setPreviewBlob(blob)
      setPreviewSrc(src)
      setPreviewOpen(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '图片生成失败')
    } finally {
      setBusy(false)
    }
  }

  /** 预览层底部的兜底保存（桌面浏览器 / 不弹长按菜单的 WebView） */
  async function doSave() {
    if (!previewBlob) return
    try {
      const r = await saveOrShareImage(previewBlob, fileName())
      if (r === 'downloaded') onToast?.('已保存图片，可在浏览器下载中查看')
      else if (r === 'shared') onToast?.('已发送')
      else if (r === 'failed') setErr('保存失败：请改用长按图片保存，或用系统浏览器打开本站')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    }
  }

  function set<K extends keyof ShareImageOptions>(key: K, v: ShareImageOptions[K]) {
    setOpts((prev) => ({ ...prev, [key]: v }))
    /* 任一开关变化后旧图就过期了：一并清掉并收掉预览层，
       避免"看到的和将要保存的不一致"—— 用户改完开关会重新点预览。 */
    setPreviewSrc('')
    setPreviewBlob(null)
    setPreviewOpen(false)
  }

  return (
    <>
      <Modal open={open} title="分享课表" onClose={onClose}>
        <p className="sheet-lead">
          {week.weekNumber > 0
            ? `第 ${week.weekNumber} 周 · ${week.weekStart.slice(5).replace('-', '.')} — ${week.weekEnd.slice(5).replace('-', '.')}`
            : week.weekState === 'holiday'
              ? '放假周 · 无课程安排'
              : '当前周次'}
        </p>

        <div className="set-list">
          <div className="set-row">
            <div className="set-row-main">
              <div className="set-row-title">显示上课地点</div>
              <div className="set-row-sub">关闭后分享图将隐藏教室信息</div>
            </div>
            <Switch checked={opts.showLocation} onChange={(v) => set('showLocation', v)} label="显示上课地点" />
          </div>

          <div className="set-row">
            <div className="set-row-main">
              <div className="set-row-title">显示任课教师</div>
              <div className="set-row-sub">关闭后分享图将隐藏教师信息</div>
            </div>
            <Switch checked={opts.showTeacher} onChange={(v) => set('showTeacher', v)} label="显示任课教师" />
          </div>

          <div className="set-row">
            <div className="set-row-main">
              <div className="set-row-title">显示非本周课程</div>
              <div className="set-row-sub">开启后以灰色显示本周不上课的课程</div>
            </div>
            <Switch
              checked={opts.showInactive}
              onChange={(v) => set('showInactive', v)}
              label="显示非本周课程"
              disabled={loadingInactive}
            />
          </div>

          <div className="set-row">
            <div className="set-row-main">
              <div className="set-row-title">显示开始结束周</div>
              <div className="set-row-sub">显示课程起止周次，保留单双周与离散周说明</div>
            </div>
            <Switch checked={opts.showWeeks} onChange={(v) => set('showWeeks', v)} label="显示开始结束周" />
          </div>
        </div>

        {err && (
          <div className="form-error" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}
        {loadingInactive && (
          <div className="sheet-lead" style={{ marginTop: 10 }}>
            正在读取非本周课程…
          </div>
        )}

        {/* 只留一个动作：先出预览，保存交给预览层（长按 / 兜底按钮）。
            分成"预览"和"保存"两个平级按钮会让人跳过预览直接存，
            而这一步的存在意义恰恰是让人**先看一眼**。 */}
        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ marginTop: 16 }}
          onClick={() => void doPreview()}
          disabled={busy}
        >
          <IconRefresh size={16} />
          {busy ? '生成中…' : previewSrc ? '重新生成分享图' : '预览分享图'}
        </button>
      </Modal>

      <ShareImagePreview
        open={previewOpen && !!previewSrc}
        src={previewSrc}
        onClose={() => setPreviewOpen(false)}
        onSave={doSave}
      />
    </>
  )
}
