/**
 * 拍照识别课表 —— 选择入口。
 *
 * 用户拍下 / 选择课表照片后，前端压缩（复用头像压缩工具，长边 1600、
 * JPEG 0.85，文字清晰且体积通常 <1MB），提交给服务端即可拿到 jobId，
 * 识别在服务端后台异步执行，**本组件随即把 jobId 交给 App 层统一接管**
 * （onStartBackground）并关闭弹窗——由课表页悬浮球继续显示进度，
 * 识别完成后再打开「确认导入」预览。用户随时可关掉导入、切到别的页，
 * 识别不会因此中断，完成后回到课表页点悬浮球即可确认导入。
 *
 * 提交阶段若直接失败（如未配置识别服务 / 达小时上限 / 网络错误），
 * 会停留在本弹窗把错误展示给用户，由用户决定重拍或取消。
 *
 * 注意：识别结果不做整表替换预览在这里完成——覆盖导入、勾选、二次确认
 * 统一收敛到 PhotoReviewModal（由悬浮球点开触发），避免两套重复逻辑。
 */
import { useEffect, useRef, useState } from 'react'
import { getRecognizePhotoStatus, submitRecognizePhoto } from '../api'
import { compressAvatar } from '../lib/avatar'
import { IconCamera } from '../icons'
import Modal from './Modal'

interface CoursePhotoImportProps {
  onClose: () => void
  /** 提交成功拿到 jobId 后调用，交由 App 后台接管（转课表页悬浮球轮询）。 */
  onStartBackground: (jobId: string) => void
}

/** 尚未提交时的一个可重试错误（未配置 / 达上限 / 网络等），与"已转后台"区分 */
interface SubmitFailure {
  msg: string
  /** true 时提示"可稍后重新打开导入，后台任务仍在跑" */
  mayBeRunning: boolean
}

export default function CoursePhotoImport({ onClose, onStartBackground }: CoursePhotoImportProps) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false) // 压缩 + 提交阶段，禁用重复提交
  const [failure, setFailure] = useState<SubmitFailure | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  /** 提交令牌：组件卸载 / 连续重拍后，迟到回调不再落地 */
  const submitToken = useRef(0)

  useEffect(() => {
    // 仅用于进门提示是否可用；即便查不到也不阻塞，真正提交时会报错
    getRecognizePhotoStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(null))
    return () => {
      submitToken.current++ // 卸载即使迟到的回调失效
    }
  }, [])

  // 注意：不做"打开弹窗自动弹出相机/相册"。iOS Safari 要求 file input 的
  // click 必须发生在真实用户手势调用栈里，程序化 click（setTimeout）会被
  // 降级成相册选择器。这里的「拍照」「从相册选择」都是真实点击，iOS 可区分。

  async function handleFile(file: File | undefined | null) {
    if (!file || busy) return
    setFailure(null)
    let dataUrl: string
    try {
      dataUrl = await compressAvatar(file, 1600, 0.85)
    } catch (err) {
      setFailure({ msg: err instanceof Error ? err.message : '图片处理失败', mayBeRunning: false })
      return
    }
    const token = ++submitToken.current
    setBusy(true)
    try {
      // 提交立刻返回 jobId（几十毫秒），识别在服务端后台跑，绕开长连接/网关超时
      const { jobId } = await submitRecognizePhoto(dataUrl)
      if (token !== submitToken.current) return // 已被重拍/关闭，忽略
      // 转后台：关闭弹窗，交 App 用悬浮球继续轮询
      onStartBackground(jobId)
      onClose()
    } catch (err) {
      if (token !== submitToken.current) return
      const msg = err instanceof Error ? err.message : '识别提交失败，请重试'
      const mayBeRunning = /504|超时|网络|fetch|加载失败/i.test(msg)
      setFailure({
        msg: mayBeRunning ? `${msg}。识别耗时较长或网络抖动，后台任务可能仍在运行，稍后到课表页看悬浮球即可。` : msg,
        mayBeRunning
      })
    } finally {
      if (token === submitToken.current) setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="拍照识别课表"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          取消
        </button>
      }
    >
      {configured === false && (
        <div className="form-error" style={{ marginBottom: 10 }}>
          服务器尚未配置识别服务（VISION_API_KEY），暂时无法使用拍照识别，请联系管理员。
        </div>
      )}
      {failure && (
        <div className="form-error" style={{ marginBottom: 10 }}>
          {failure.msg}
          {failure.mayBeRunning && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              可以直接关掉本窗口，去课表页看悬浮球是否有结果。
            </div>
          )}
        </div>
      )}

      {busy ? (
        <div style={{ textAlign: 'center', padding: '18px 0 10px' }}>
          <div className="ocr-progress" aria-hidden="true">
            <div className="ocr-progress-bar" />
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 12.5, margin: '10px 0 0', lineHeight: 1.7 }}>
            正在提交并转后台识别…通常 10~60 秒；课表较复杂时可能需要 1~3 分钟。
            <br />
            提交成功后会自动转后台，识别期间可自由切到别的页面，完成后课表页会出现悬浮球提示你确认导入。
          </p>
        </div>
      ) : (
        <div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 14px', lineHeight: 1.7 }}>
            拍下教务系统的课表页面（截图也可以），自动识别课程、时间、地点、单双周与教师。
            识别在服务器后台进行，完成后在课表页点悬浮球即可核对并确认导入，不会直接改你的课表。
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => cameraRef.current?.click()}>
              <IconCamera size={18} />
              拍照
            </button>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => galleryRef.current?.click()}>
              从相册选择
            </button>
          </div>
          <ul style={{ color: 'var(--text-2)', fontSize: 12, margin: '14px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
            <li>尽量拍正、拍全整张课表，避免倾斜和反光</li>
            <li>教务系统里直接截图上传，识别最准</li>
            <li>导入会覆盖当前课表（原有课程将被清除）</li>
            <li>每小时最多识别 10 次</li>
          </ul>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <input
            ref={galleryRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      )}
    </Modal>
  )
}
