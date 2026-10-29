/**
 * 考试时间窗口计算（纯函数，无 React 依赖，便于离线回归测试）。
 *
 * 为什么要单独成模块：这里藏着一个**反直觉但真实存在**的坑 ——
 * 教务系统抓回来的考试经常只有开始时间、没有结束时间。如果结束时刻直接回落到开始时刻，
 * 那么考试窗口长度就是 0：`isOngoing` 恒为 false、`isPassed` 在开考那一刻立刻变 true。
 * 表现出来就是「考试刚开始，冲刺卡片就消失了」—— 而那一刻恰恰是学生最需要看考场座位号的时候。
 * 因此缺结束时间时按一个合理的默认时长补出一个窗口。
 */
import type { Exam } from '../types'
import { parseISODate } from './date'

/** 缺结束时间时假定的考试时长（分钟） */
export const DEFAULT_EXAM_MINUTES = 120

/** 完全没有时间信息时，假定的开考时刻（当天 09:00） */
const FALLBACK_HOUR = 9

export interface ExamWindow {
  startDt: Date
  endDt: Date
  /** 结束时刻是推算出来的（教务没给结束时间），UI 应据此弱化表述 */
  endEstimated: boolean
}

function hasTime(v: string | undefined | null): boolean {
  return Boolean(v && v.includes(':'))
}

/** 把 YYYY-MM-DD + HH:mm 合成 Date；time 非法时回落到当天 09:00 */
export function dtAt(dateStr: string, time: string | undefined | null): Date {
  const d = parseISODate(dateStr)
  if (hasTime(time)) {
    const [h, m] = String(time).split(':').map(Number)
    d.setHours(h || 0, m || 0, 0, 0)
  } else {
    d.setHours(FALLBACK_HOUR, 0, 0, 0)
  }
  return d
}

/**
 * 计算一场考试的起止窗口。
 *
 * 返回 null 表示这条记录**不可用**（日期解析失败）。为什么必须显式排除而不是"凑合显示"：
 *   非法日期会算出 Invalid Date，`getTime()` 得到 NaN。而 NaN 参与比较恒为 false，
 *   于是 `isPassed = now > endDt` 永远是 false —— 这条考试因此**永远不会过期**，
 *   永久占据首页顶部，且倒计时会显示成「即将在 NaN 分钟后开考！」。
 *   服务端其实已经用 isValidISODate 卡住了写入，这里是防御性兜底
 *   （手工改库、将来导入逻辑回归、旧数据迁移都可能绕过校验）。
 */
export function examWindow(exam: Exam): ExamWindow | null {
  const startDt = dtAt(exam.examDate, exam.startTime)
  if (Number.isNaN(startDt.getTime())) return null

  if (hasTime(exam.endTime)) {
    const endDt = dtAt(exam.examDate, exam.endTime)
    if (endDt.getTime() > startDt.getTime()) {
      return { startDt, endDt, endEstimated: false }
    }
  }
  return {
    startDt,
    endDt: new Date(startDt.getTime() + DEFAULT_EXAM_MINUTES * 60_000),
    endEstimated: true
  }
}

export interface ExamTimeline extends ExamWindow {
  exam: Exam
  /** 开考时刻就是今天 */
  isToday: boolean
  /** 此刻正在考试中 */
  isOngoing: boolean
  /** 整场考试已经结束 */
  isPassed: boolean
  /** 距开考的毫秒数（已开考为负） */
  diffMs: number
}

/** 把考试列表整理成带时间状态的列表；顺带按「进行中优先，其余按开考时间升序」排好序 */
export function buildExamTimeline(exams: Exam[], now: Date): ExamTimeline[] {
  const nowMs = now.getTime()
  const out: ExamTimeline[] = []
  for (const exam of exams) {
    const win = examWindow(exam)
    // 日期坏掉的记录直接丢弃：显示出来只会是 NaN 且永不过期
    if (!win) continue
    const isOngoing = nowMs >= win.startDt.getTime() && nowMs <= win.endDt.getTime()
    const isPassed = nowMs > win.endDt.getTime()
    if (isPassed) continue
    out.push({
      exam,
      ...win,
      isToday: win.startDt.toDateString() === now.toDateString(),
      isOngoing,
      isPassed,
      diffMs: win.startDt.getTime() - nowMs
    })
  }
  return out.sort((a, b) => {
    if (a.isOngoing !== b.isOngoing) return a.isOngoing ? -1 : 1
    return a.startDt.getTime() - b.startDt.getTime()
  })
}

/** 倒计时文案 + 配色档位（抽出来是为了让"开考前一小时该变红"这类规则可被测试） */
export function countdownOf(item: ExamTimeline, now: Date): { label: string; level: 'ongoing' | 'soon' | 'today' | 'later' } {
  if (item.isOngoing) {
    if (item.endEstimated) return { label: '正在考试中', level: 'ongoing' }
    const remainMin = Math.max(1, Math.floor((item.endDt.getTime() - now.getTime()) / 60_000))
    return { label: `正在考试中（还剩 ${remainMin} 分钟）`, level: 'ongoing' }
  }
  const totalMinutes = Math.max(0, Math.floor(item.diffMs / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const mins = totalMinutes % 60
  if (days > 0) return { label: `距开考：${days} 天 ${hours} 小时`, level: 'later' }
  if (hours > 0) return { label: `距开考：${hours} 小时 ${mins} 分`, level: 'today' }
  return { label: `即将在 ${Math.max(1, mins)} 分钟后开考！`, level: 'soon' }
}
