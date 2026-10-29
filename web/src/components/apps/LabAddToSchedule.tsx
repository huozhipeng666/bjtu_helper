/**
 * 「把实验加进课表 / DDL」的交互层 —— 物理实验与演示实验两个应用页共用。
 *
 * ## 为什么抽成共享模块
 *
 * 两个页面的数据形状完全一样（日期 + 第几节 + 实验名 + 地点/教师），转换规则全在
 * 服务端（server/src/labToSchedule.ts）。前端如果各写一份按钮与文案，迟早会出现
 * 「物理实验页说已加入、演示实验页说没加入」这种漂移。所以这里只留一份：
 * 状态（哪些已加入）、请求、结果文案、按钮渲染，两个页面各自 `useLabAdder(platform)` 即可。
 *
 * ## 为什么按钮要区分「课表」和「DDL」
 *
 * 两者语义不同，不是冗余：
 *   - 加课表 = 让它出现在周课表里（按学期周次表落到第 N 周周几第几大节）；
 *   - 加 DDL = 截止时间取实验结束时刻，用于「到点该在实验室」的提醒。
 * 有人只要其中一种（比如课表已经排满、只想留个提醒），所以两个按钮分开，
 * 另外给一个「一键两个都加」的批量入口。
 */
import { useCallback, useMemo, useState } from 'react'
import {
  addLabsToSchedule,
  removeLabsFromSchedule,
  type LabAddResult,
  type LabAddTarget,
  type LabRemoveTarget
} from '../../api'

export interface LabAddItem {
  name: string
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  period: number
}

/**
 * epoch 秒（UTC+8 零点）→ `YYYY-MM-DD`。
 *
 * ⚠️ 必须按 UTC+8 取日期，与服务端 `labToSchedule.labDateISO` 完全同口径 ——
 * 这个字符串是「哪一条实验」的身份标识（用于逐条加入与去重），
 * 一旦前端按本地时区算、服务端按 UTC+8 算，跨时区或夏令时下就会对不上。
 */
export function labDayISO(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 一条实验的身份键，与服务端路由里拼的键一致：`日期|节次|名称` */
export function labItemKey(item: LabAddItem): string {
  return `${labDayISO(item.date)}|${item.period}|${item.name}`
}

export interface LabAddNotice {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/** 把服务端返回的计数翻译成一句人话 */
export function describeLabAddResult(r: LabAddResult, target: LabAddTarget): LabAddNotice {
  const parts: string[] = []
  if (target !== 'task') parts.push(r.added.courses > 0 ? `课表新增 ${r.added.courses} 节` : '课表无新增')
  if (target !== 'course') parts.push(r.added.tasks > 0 ? `DDL 新增 ${r.added.tasks} 条` : 'DDL 无新增')

  const skipped = r.skipped.courses + r.skipped.tasks
  let text = parts.join('，')
  if (skipped > 0) text += `；${skipped} 条已存在，已跳过`

  if (r.unresolved.length > 0) {
    const first = r.unresolved[0]
    const more = r.unresolved.length > 1 ? ` 等 ${r.unresolved.length} 条` : ''
    return {
      kind: 'warn',
      text: `${text}；${first.date}「${first.name}」${more}没能加进课表：${first.reason}`
    }
  }
  return { kind: r.added.courses + r.added.tasks > 0 ? 'ok' : 'warn', text }
}

export interface LabAdder {
  /** 正在进行的请求标识（'' = 空闲），用于禁用按钮与显示"加入中…" */
  busy: string
  notice: LabAddNotice | null
  setNotice: (n: LabAddNotice | null) => void
  /** 已确认在课表里的实验键 */
  addedCourses: Set<string>
  /** 已确认有 DDL 的实验键 */
  addedTasks: Set<string>
  /** items 为空 = 处理快照里的全部实验（服务端默认只加今天及以后） */
  add: (items: LabAddItem[] | null, target: LabAddTarget, busyKey: string) => Promise<void>
  /** 取消导入：删掉该平台导入的课程 / DDL（只动本站数据库，不依赖校园网出口） */
  remove: (target: LabRemoveTarget, busyKey: string) => Promise<void>
}

export function useLabAdder(platform: 'physicslab' | 'phydemo'): LabAdder {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<LabAddNotice | null>(null)
  const [courseKeys, setCourseKeys] = useState<string[]>([])
  const [taskKeys, setTaskKeys] = useState<string[]>([])

  const addedCourses = useMemo(() => new Set(courseKeys), [courseKeys])
  const addedTasks = useMemo(() => new Set(taskKeys), [taskKeys])

  const add = useCallback(
    async (items: LabAddItem[] | null, target: LabAddTarget, busyKey: string) => {
      if (busy) return
      setBusy(busyKey)
      setNotice(null)
      try {
        const r = await addLabsToSchedule(platform, items ? { target, items } : { target })
        /* ⚠️ 只能用 courseKeys / taskKeys，不能用 r.keys：
           r.keys 里含「扫到了但落不了周」的实验（放假周、学期外、节次表外），
           拿它当"已加入"会让那些实验显示成「✓ 已在课表」并被 disabled ——
           用户既加不进去、也点不了重试。这两个数组只含真正写入（或已存在）的。 */
        if (target !== 'task') setCourseKeys((prev) => [...new Set([...prev, ...r.courseKeys])])
        if (target !== 'course') setTaskKeys((prev) => [...new Set([...prev, ...r.taskKeys])])
        setNotice(describeLabAddResult(r, target))
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : '加入失败，请稍后重试' })
      } finally {
        setBusy('')
      }
    },
    [busy, platform]
  )

  /**
   * 取消导入。
   *
   * 与 add 的差别：它**不打学校站点**（服务端只删本站的行），所以不会有
   * 出口离线/超时的问题，正常几百毫秒就回来。移除成功后把本地的"已加入"
   * 标记一起清掉，否则按钮会停留在勾选态。
   */
  const remove = useCallback(
    async (target: LabRemoveTarget, busyKey: string) => {
      if (busy) return
      setBusy(busyKey)
      setNotice(null)
      try {
        const r = await removeLabsFromSchedule(platform, target)
        if (target !== 'task') setCourseKeys([])
        if (target !== 'course') setTaskKeys([])
        const n = r.removed.courses + r.removed.tasks
        setNotice(
          n > 0
            ? {
                kind: 'ok',
                text: `已移除 ${r.removed.courses} 节课程、${r.removed.tasks} 条 DDL`
              }
            : { kind: 'warn', text: '课表与 DDL 里没有找到这门平台的导入记录（可能之前就移除过）' }
        )
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : '移除失败，请稍后重试' })
      } finally {
        setBusy('')
      }
    },
    [busy, platform]
  )

  return { busy, notice, setNotice, addedCourses, addedTasks, add, remove }
}

/** 结果提示条（成功 / 部分未加入 / 失败三态） */
export function LabAddNoticeBar({ notice, onClose }: { notice: LabAddNotice | null; onClose: () => void }) {
  if (!notice) return null
  return (
    <div className={`lab-add-notice is-${notice.kind}`} role="status">
      <span>{notice.text}</span>
      <button type="button" className="lab-add-notice-close" aria-label="关闭提示" onClick={onClose}>
        ×
      </button>
    </div>
  )
}

/** 顶部批量入口：一次把（今天及以后的）全部实验加进课表 + DDL */
export function LabAddAllBar({ adder, count }: { adder: LabAdder; count: number }) {
  const disabled = !!adder.busy || count === 0
  return (
    <div className="lab-add-all">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={disabled}
        onClick={() => void adder.add(null, 'both', 'all')}
      >
        {adder.busy === 'all' ? '加入中…' : '一键加入课表 + DDL'}
      </button>
      <span className="lab-add-all-hint">
        按你设置里的作息与学期周次换算，只加今天及以后的实验；重复点不会产生重复条目
      </span>
    </div>
  )
}

/**
 * 「取消导入」入口。
 *
 * 为什么必须两步确认：它一次性删掉该平台**所有**导入的课程与 DDL，
 * 误点的代价是用户要手动重建整张课表。所以先展开一条说明，写清匹配规则
 * （只删以「物理实验 · 」开头的条目，自己手建的课不受影响），再点确定才执行。
 *
 * 与「加入」不同，它不打学校站点（服务端只删本站数据库的行），
 * 所以校园网出口离线时照样能用 —— 文案里也说明了这一点，避免用户以为要等。
 */
export function LabRemoveBar({ adder, label }: { adder: LabAdder; label: string }) {
  const [confirming, setConfirming] = useState(false)
  const busy = adder.busy === 'remove'

  if (!confirming) {
    return (
      <div className="lab-remove-bar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!!adder.busy}
          onClick={() => setConfirming(true)}
        >
          取消导入
        </button>
        <span className="lab-add-all-hint">把之前加入课表 / DDL 的{label}实验一次性移除</span>
      </div>
    )
  }

  return (
    <div className="lab-remove-bar is-confirming">
      <span className="lab-remove-warn">
        将删除所有以「{label} · 」开头的课程与 DDL（自己手动添加的不受影响）。确定移除吗？
      </span>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={() => {
          void adder.remove('both', 'remove').finally(() => setConfirming(false))
        }}
      >
        {busy ? '移除中…' : '确定移除'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
        取消
      </button>
    </div>
  )
}

/** 单条实验的两个按钮：加入课表 / 加入 DDL，已加入的显示为勾选态 */
export function LabAddButtons({ adder, item }: { adder: LabAdder; item: LabAddItem }) {
  const key = labItemKey(item)
  const inCourse = adder.addedCourses.has(key)
  const inTask = adder.addedTasks.has(key)
  return (
    <div className="lab-add-row">
      <button
        type="button"
        className={`btn btn-sm ${inCourse ? 'btn-ghost is-done' : 'btn-ghost'}`}
        disabled={!!adder.busy || inCourse}
        onClick={() => void adder.add([item], 'course', `c:${key}`)}
      >
        {adder.busy === `c:${key}` ? '加入中…' : inCourse ? '✓ 已在课表' : '加入课表'}
      </button>
      <button
        type="button"
        className={`btn btn-sm ${inTask ? 'btn-ghost is-done' : 'btn-ghost'}`}
        disabled={!!adder.busy || inTask}
        onClick={() => void adder.add([item], 'task', `t:${key}`)}
      >
        {adder.busy === `t:${key}` ? '加入中…' : inTask ? '✓ 已有 DDL' : '加入 DDL'}
      </button>
    </div>
  )
}
