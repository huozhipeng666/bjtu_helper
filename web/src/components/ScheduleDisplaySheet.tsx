/**
 * 「课表显示」设置弹层（设计稿图2 + 2026-10-08 对齐竞品 Nexio课程表 的可调项）。
 *
 * 全部偏好都只作用于**渲染**，不碰数据：
 *   紧凑视图      → 缩小周网格行高（快捷预设）
 *   卡片行高      → 连续可调 34~92px（对齐竞品滑杆区间），「自动」时按节数推导
 *   显示非本周课程 → 把本周不上（单双周/离散周/未开课）的课以灰色画在表上
 *   按需显示周末   → 隐藏当前周没有任何可见课程的周六/周日两列
 *   午休/晚休分隔带 → 按节次时间的实际间隔插通栏标签
 *   块内显示      → 课名之外的 @地点 / 教师 / 学分 各自开关
 *   字体大小      → 今日课程列表与周课表同步放大/缩小
 *
 * 为什么入口放在课表页的视图切换行而不是"设置"页：
 * 这些项都会**当场改变眼前这张表的样子**，用户调完要立刻看到结果。
 * 放进设置页意味着"进去 → 改 → 返回课表 → 再看"，改错了还得再来一遍。
 * 放在课表页就地弹层，改一下看一眼，是这类"所见即所得"开关该有的距离。
 */
import type { ScheduleDisplayPrefs, ScheduleFontScale } from '../lib/scheduleDisplay'
import {
  DEFAULT_DISPLAY_PREFS,
  FONT_SCALE_LABEL,
  ROW_HEIGHT_MAX,
  ROW_HEIGHT_MIN
} from '../lib/scheduleDisplay'
import Modal from './Modal'
import Switch from './Switch'
import { IconCheck } from '../icons'

interface ScheduleDisplaySheetProps {
  open: boolean
  prefs: ScheduleDisplayPrefs
  onChange: (patch: Partial<ScheduleDisplayPrefs>) => void
  onReset: () => void
  onClose: () => void
}

const FONT_SCALES: ScheduleFontScale[] = ['sm', 'md', 'lg']

/** 「块内显示」三个多选项：键 → 文案 */
const BLOCK_FIELDS: { key: 'showLocation' | 'showTeacher' | 'showCredit'; label: string }[] = [
  { key: 'showLocation', label: '地点' },
  { key: 'showTeacher', label: '教师' },
  { key: 'showCredit', label: '学分' }
]

/** 当前设置是否已经是默认值 —— 用来决定"一键恢复"要不要置灰（没有可恢复的就别给假按钮） */
function isDefault(p: ScheduleDisplayPrefs): boolean {
  return (Object.keys(DEFAULT_DISPLAY_PREFS) as (keyof ScheduleDisplayPrefs)[]).every(
    (k) => p[k] === DEFAULT_DISPLAY_PREFS[k]
  )
}

export default function ScheduleDisplaySheet({ open, prefs, onChange, onReset, onClose }: ScheduleDisplaySheetProps) {
  const unchanged = isDefault(prefs)
  const manual = prefs.rowHeight != null

  return (
    <Modal open={open} title="课表显示" onClose={onClose}>
      <div className="set-list">
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">紧凑视图</div>
            <div className="set-row-sub">缩小行高，周一~周日一屏看全（不用左右滑动）</div>
          </div>
          <Switch
            checked={prefs.compact}
            onChange={(v) => onChange({ compact: v })}
            label="紧凑视图"
          />
        </div>

        {/* 卡片行高：自动 / 手动 二选一，手动时才展开滑杆 */}
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">卡片行高</div>
            <div className="set-row-sub">
              {manual ? `当前 ${prefs.rowHeight}px` : '自动：按节数与紧凑档推导'}
            </div>
          </div>
          <div className="set-seg" role="radiogroup" aria-label="卡片行高模式">
            <button
              type="button"
              role="radio"
              aria-checked={!manual}
              className={`set-seg-btn${!manual ? ' active' : ''}`}
              onClick={() => onChange({ rowHeight: null })}
            >
              自动
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={manual}
              className={`set-seg-btn${manual ? ' active' : ''}`}
              onClick={() => onChange({ rowHeight: prefs.rowHeight ?? 64 })}
            >
              手动
            </button>
          </div>
        </div>

        {manual && (
          <div className="set-range-row">
            <input
              className="st-range"
              type="range"
              min={ROW_HEIGHT_MIN}
              max={ROW_HEIGHT_MAX}
              step={1}
              value={prefs.rowHeight ?? 64}
              onChange={(e) => onChange({ rowHeight: Number(e.target.value) })}
              aria-label="卡片行高"
            />
            <div className="set-range-scale">
              <span>紧凑 {ROW_HEIGHT_MIN}</span>
              <span>宽松 {ROW_HEIGHT_MAX}</span>
            </div>
          </div>
        )}

        {/* 块内显示：三个多选项并排，比三行开关省一半高度 */}
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">块内显示</div>
            <div className="set-row-sub">课程块里除课名外还显示什么</div>
          </div>
          <div className="set-seg">
            {BLOCK_FIELDS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={prefs[f.key]}
                className={`set-seg-btn${prefs[f.key] ? ' active' : ''}`}
                onClick={() => onChange({ [f.key]: !prefs[f.key] } as Partial<ScheduleDisplayPrefs>)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">午休 / 晚休分隔带</div>
            <div className="set-row-sub">按节次时间的实际间隔自动插入</div>
          </div>
          <Switch
            checked={prefs.showBreaks}
            onChange={(v) => onChange({ showBreaks: v })}
            label="午休晚休分隔带"
          />
        </div>

        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">显示非本周课程</div>
            <div className="set-row-sub">以灰色标记本周不上课的课程</div>
          </div>
          <Switch
            checked={prefs.showInactive}
            onChange={(v) => onChange({ showInactive: v })}
            label="显示非本周课程"
          />
        </div>

        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">按需显示周末</div>
            <div className="set-row-sub">分别隐藏当前周没有可见课程的周六、周日</div>
          </div>
          <Switch
            checked={prefs.autoWeekend}
            onChange={(v) => onChange({ autoWeekend: v })}
            label="按需显示周末"
          />
        </div>

        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-title">字体大小</div>
            <div className="set-row-sub">今日课程和周课表同步调整</div>
          </div>
          <div className="set-seg" role="radiogroup" aria-label="课表字体大小">
            {FONT_SCALES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={prefs.fontScale === s}
                className={`set-seg-btn${prefs.fontScale === s ? ' active' : ''}`}
                onClick={() => onChange({ fontScale: s })}
              >
                {FONT_SCALE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 「一键恢复显示设置」：把全部项一次拉回默认。置灰而不是隐藏 ——
          用户需要知道"这个功能在哪"，只是此刻无可恢复。 */}
      <button
        type="button"
        className="btn btn-soft btn-block"
        style={{ marginTop: 14 }}
        disabled={unchanged}
        onClick={onReset}
      >
        <IconCheck size={16} />
        {unchanged ? '当前已是默认设置' : '一键恢复显示设置'}
      </button>
    </Modal>
  )
}
