/**
 * 拍照识别「异步任务」管理器。
 *
 * 背景：识别要调用外部视觉大模型（GLM-4.6V），单轮可能 >60s，含深度思考 + 查漏两轮
 * 上限更高。若 HTTP 请求同步等待，nginx `proxy_read_timeout`（默认 60s，此前未配置）会
 * 在 Express 处理完之前就返回 504，导致前端收到「请求失败（HTTP 504）」而服务端其实还在算。
 *
 * 方案：把识别改造成「提交即返回 jobId」的异步任务 —— POST 只做图片/限流校验并立刻
 * 返回 `{ jobId }`（几十毫秒），GLM 调用在后台执行，前端轮询状态接口拿结果。
 * 好处：HTTP 链路只剩毫秒级往返，彻底绕开任何代理超时；前端可获得真实的「识别中」进度。
 *
 * 存储用进程内 Map（与 OCR 限流同一策略：重启即清）。任务带过期时间，轮询接口按用户隔离。
 */
import type { Period } from './types.js'

export type RecognizeJobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface RecognizeJob {
  id: string
  userId: number
  status: RecognizeJobStatus
  /** 面向用户的进度文案，便于前端显示"正在识别第 1/2 轮…" */
  phase: string
  /** 成功时的结果（沿用 RecognizeResult 结构，由回调写入） */
  result?: { courses: unknown[]; errors: unknown[]; model: string }
  error?: string
  createdAt: number
  updatedAt: number
}

/** 任务在内存中的存活时长：太短怕轮询还没拉完就被清，太长占内存。10 分钟足够。 */
const JOB_TTL_MS = 10 * 60 * 1000

const jobs = new Map<string, RecognizeJob>()

function newId(): string {
  // 客户端不可枚举，用随机 + 时间戳；不暴露自增序号
  return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** 创建任务记录（不执行）。调用方随后应 startRecognizeJob 真正开始后台处理。 */
export function createRecognizeJob(userId: number): RecognizeJob {
  prune()
  const job: RecognizeJob = {
    id: newId(),
    userId,
    status: 'pending',
    phase: '排队中…',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs.set(job.id, job)
  return job
}

export function getRecognizeJob(jobId: string, userId: number): RecognizeJob | undefined {
  const job = jobs.get(jobId)
  if (!job || job.userId !== userId) return undefined // 越权/不存在一律视为无
  if (Date.now() - job.updatedAt > JOB_TTL_MS) {
    // 过期即删，避免用户拿一个旧 jobId 反复轮询
    jobs.delete(jobId)
    return undefined
  }
  return job
}

/** 标记开始执行（running）。幂等：仅 pending 可进入 running。 */
export function markRecognizeRunning(job: RecognizeJob, phase: string): void {
  if (job.status !== 'pending') return
  job.status = 'running'
  job.phase = phase
  job.updatedAt = Date.now()
}

/** 标记成功。返回 true 表示确实发生过状态变更（便于上层判断是否要清理其它）。 */
export function markRecognizeDone(job: RecognizeJob, result: NonNullable<RecognizeJob['result']>): void {
  job.status = 'done'
  job.result = result
  job.phase = '识别完成'
  job.updatedAt = Date.now()
}

export function markRecognizeFailed(job: RecognizeJob, error: string): void {
  job.status = 'failed'
  job.error = error
  job.phase = '识别失败'
  job.updatedAt = Date.now()
}

/** 轮询阶段变化。运行中阶段推进（第 1 轮 / 第 2 轮）需要 vision 层回调，这里提供辅助。 */
export function updateRecognizePhase(job: RecognizeJob, phase: string): void {
  if (job.status !== 'running') return
  job.phase = phase
  job.updatedAt = Date.now()
}

/** 清理过期任务（调用时机：每次新任务创建 / 轮询时惰性）。 */
function prune(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (now - j.updatedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

/**
 * 返回该用户的活跃任务数（用于限制一个人不要同时堆太多识别任务）。
 *
 * ⚠️ 必须只数 `queued` / `running`：此前这里数的是**全部**任务（含 done / failed），
 * 而任务要 10 分钟才过期 —— 于是"10 分钟内成功识别 3 次"之后，第 4 次会被
 * 429 挡住并提示"已有识别任务在进行中"，但实际一个都没在跑。
 * 这类"文案与事实不符"的错误最容易被当成产品 bug。
 */
export function activeJobCount(userId: number): number {
  let n = 0
  for (const j of jobs.values()) {
    if (j.userId === userId && (j.status === 'pending' || j.status === 'running')) n++
  }
  return n
}
