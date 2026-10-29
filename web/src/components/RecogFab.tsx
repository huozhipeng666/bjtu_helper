import type { RecogJob } from '../lib/recognizer'
import { IconCamera } from '../icons'

interface RecogFabProps {
  job: RecogJob
  onClick: () => void
  onDismiss: () => void
}

/**
 * 课表页悬浮球：识别后台进行 / 已完成待确认时的常驻入口。
 * 识别中显示流动动画 + 提示文案；完成后变"查看结果"胶囊。
 * 仅当存在活跃识别任务时由 App 渲染（固定在课表页）。
 */
export default function RecogFab({ job, onClick, onDismiss }: RecogFabProps) {
  const done = job.status === 'done'
  const failed = job.status === 'failed'
  const busy = job.status === 'pending' || job.status === 'running'

  return (
    <div className={`recog-fab ${done ? 'done' : ''}${failed ? 'failed' : ''}`}>
      <button className="recog-fab-main" onClick={onClick} aria-label="查看识别进度">
        <span className="recog-fab-ico">
          {busy ? (
            <span className="recog-spin" />
          ) : done ? (
            '✓'
          ) : failed ? (
            '!'
          ) : (
            <IconCamera size={18} />
          )}
        </span>
        <span className="recog-fab-txt">
          {busy ? (
            <>
              <span className="recog-title">正在识别课表</span>
              <span className="recog-sub">正在调用智谱视觉大模型，请等待 1~3 分钟</span>
            </>
          ) : done ? (
            <>
              <span className="recog-title">识别完成</span>
              <span className="recog-sub">点此查看结果并确认导入</span>
            </>
          ) : (
            <>
              <span className="recog-title">识别失败</span>
              <span className="recog-sub">点此查看原因</span>
            </>
          )}
        </span>
      </button>
      {busy && (
        <button className="recog-fab-x" onClick={onDismiss} aria-label="放弃本次识别，关闭悬浮球">
          ✕
        </button>
      )}
    </div>
  )
}
