/**
 * 课表拍照识别的「后台任务」状态管理。
 *
 * 识别在后端是进程内异步 job（TTL 10 分钟，jobId 全局可轮询）。
 * 前端不再把轮询锁在某个弹窗里——提交拿到 jobId 后交由本 hook 统一
 * 后台轮询，任意页面都能通过悬浮球看到进度并在完成后确认导入。
 *
 * jobId 用 localStorage 持久化：刷新/切页后仍能恢复轮询（只要后端
 * job 未过期）。识别完成或放弃后手动 dismiss 清理。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getRecognizeJobStatus,
  type RecognizeJobStatus,
  type RecognizePhotoResult
} from '../api'

export interface RecogJob {
  jobId: string
  status: RecognizeJobStatus
  /** 面向用户的进度文案，如"正在调用智谱视觉大模型…第 1/2 轮" */
  phase: string
  result?: RecognizePhotoResult
  error?: string
}

const KEY = 'bjtu-recog-job'

/** 识别完成但尚未确认导入/尚未被消费时的展示文案 */
export function recogActionLabel(job: RecogJob | null): string {
  if (!job) return ''
  if (job.status === 'done') return '识别完成，点击确认导入'
  if (job.status === 'failed') return '识别失败，点击查看'
  if (job.status === 'running') return '正在调用智谱视觉大模型…请等待 1~3 分钟'
  return '识别排队中…'
}

export function useRecognizer() {
  const [job, setJob] = useState<RecogJob | null>(null)
  // 记录"已完成但尚未消费（未打开确认/未 dismiss）"，用于悬浮球常驻提示
  const [pending, setPending] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jobRef = useRef<RecogJob | null>(null)
  const inFlightRef = useRef(false)
  const errorCountRef = useRef(0)
  jobRef.current = job

  const stopPoll = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    inFlightRef.current = false
    errorCountRef.current = 0
  }, [])

  const setJobAndPersist = useCallback((j: RecogJob | null) => {
    setJob(j)
    try {
      if (j) localStorage.setItem(KEY, j.jobId)
      else localStorage.removeItem(KEY)
    } catch {
      /* 忽略 */
    }
  }, [])

  /** 认领一个新的识别任务（提交拿到 jobId 后调用），开始后台链式轮询 */
  const claim = useCallback(
    (jobId: string) => {
      stopPoll()
      const j: RecogJob = { jobId, status: 'pending', phase: '排队中…' }
      setJobAndPersist(j)
      setPending(false)

      const schedulePoll = (delay: number) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(async () => {
          const cur = jobRef.current
          if (!cur || cur.jobId !== jobId) return
          if (inFlightRef.current) {
            // 上一轮请求尚未返回，避免并发重叠，下个周期重试
            schedulePoll(1000)
            return
          }

          inFlightRef.current = true
          try {
            const s = await getRecognizeJobStatus(cur.jobId)
            errorCountRef.current = 0
            const upd: RecogJob = {
              jobId: s.jobId,
              status: s.status,
              phase: s.phase ?? '',
              ...(s.result ? { result: s.result } : {}),
              ...(s.error ? { error: s.error } : {})
            }
            setJobAndPersist(upd)
            if (s.status === 'done' || s.status === 'failed') {
              setPending(true)
              stopPoll()
              return
            }
            // 正常进行中：下一轮 2 秒后请求（页面不可见时放宽到 4 秒）
            const nextDelay = document.hidden ? 4000 : 2000
            schedulePoll(nextDelay)
          } catch (err: unknown) {
            errorCountRef.current += 1
            const errMsg = err instanceof Error ? err.message : String(err)
            const isNotFoundOrExpired = /404|不存在|过期/i.test(errMsg)

            // 任务 404 不存在/过期，或者连续失败 6 次（约 15s），主动标记失败并终止轮询，避免悬浮球死循环挂死
            if (isNotFoundOrExpired || errorCountRef.current >= 6) {
              const finalError = isNotFoundOrExpired
                ? '识别任务已失效或已过期，请重新上传'
                : '网络连接异常，未能获取识别结果'
              setJobAndPersist({
                jobId: cur.jobId,
                status: 'failed',
                phase: '识别失败',
                error: finalError
              })
              setPending(true)
              stopPoll()
              return
            }

            // 偶发网络波动：稍作退避后重试
            schedulePoll(2500)
          } finally {
            inFlightRef.current = false
          }
        }, delay)
      }

      schedulePoll(1000)
    },
    [setJobAndPersist, stopPoll]
  )

  /** 识别结果已确认导入或用户主动放弃后清理 */
  const dismiss = useCallback(() => {
    stopPoll()
    setJobAndPersist(null)
    setPending(false)
  }, [setJobAndPersist, stopPoll])

  /** App 挂载时尝试从 localStorage 恢复一个尚未过期的任务继续轮询 */
  useEffect(() => {
    let restoredId = ''
    try {
      restoredId = localStorage.getItem(KEY) ?? ''
    } catch {
      restoredId = ''
    }
    if (restoredId) claim(restoredId)
    return stopPoll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 完成态（done/failed）常驻提示，直到 dismiss 或被消费 */
  const visible = !!job
  const canReview = !!job && job.status === 'done' && !!job.result

  return { job, pending, visible, canReview, claim, dismiss }
}
