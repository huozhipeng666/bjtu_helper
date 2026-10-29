/**
 * 时间冲突提示条 —— 课表导入预览与课程表单共用，保证同一份冲突数据在两处长得一样。
 *
 * 只负责渲染，不负责判定（判定在 lib/conflicts.ts）。文案由调用方通过 format 注入：
 * 导入预览是「A 与 B 冲突」，课程表单是「与已有课程 B 冲突」，措辞不同但版式一致。
 */
import type { ConflictPair, ConflictSubject } from '../lib/conflicts'

interface ConflictBannerProps<T extends ConflictSubject> {
  conflicts: ConflictPair<T>[]
  /** 标题，如「检测到 2 处时间冲突」 */
  title: string
  /** 单条冲突的文案 */
  format: (pair: ConflictPair<T>) => string
  /** 底部中性色说明（可选） */
  note?: string
  /** 最多列几条，多余的折叠为「另有 N 条」。默认 5，避免长列表把弹窗撑爆 */
  max?: number
}

export default function ConflictBanner<T extends ConflictSubject>({
  conflicts,
  title,
  format,
  note,
  max = 5
}: ConflictBannerProps<T>) {
  if (conflicts.length === 0) return null
  const shown = conflicts.slice(0, max)
  const rest = conflicts.length - shown.length

  return (
    <div className="conflict-banner" style={{ marginBottom: 10 }}>
      <div className="conflict-banner-title">⚠ {title}</div>
      <ul className="conflict-banner-list">
        {shown.map((p, i) => (
          <li key={i}>{format(p)}</li>
        ))}
        {rest > 0 && <li>另有 {rest} 条冲突未列出</li>}
      </ul>
      {note && <div className="conflict-banner-note">{note}</div>}
    </div>
  )
}
