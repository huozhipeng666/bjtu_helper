/**
 * 骨架屏：加载时用形状相近的灰色占位替代「加载中…」文字。
 * 数据到达后内容直接顶替，布局不跳，感知等待更短。
 * 全部为纯展示元素；样式见 styles.css 的 .skel 系列。
 */

interface SkelProps {
  w?: number | string
  h?: number | string
  r?: number | string
  style?: React.CSSProperties
}

export function Skel({ w, h, r, style }: SkelProps) {
  return (
    <span className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />
  )
}

/** 首页：问候 + 大数字 + 统计三格 + 下一节课卡 */
export function HomeSkeleton() {
  return (
    <div>
      <Skel w={96} h={15} r={7} style={{ margin: '14px 2px 12px' }} />
      <Skel w={'68%'} h={32} r={10} style={{ margin: '0 2px 12px' }} />
      <Skel w={210} h={13} r={7} style={{ margin: '0 2px 20px' }} />
      <div className="stats-row">
        {[0, 1, 2].map((i) => (
          <div key={i} className="stat-card">
            <Skel w={44} h={11} r={6} style={{ marginBottom: 10 }} />
            <Skel w={28} h={22} r={6} />
          </div>
        ))}
      </div>
      <div className="card">
        <Skel w={'40%'} h={12} r={6} style={{ marginBottom: 12 }} />
        <Skel w={'55%'} h={19} r={8} style={{ marginBottom: 14 }} />
        <Skel w={'82%'} h={13} r={7} style={{ marginBottom: 9 }} />
        <Skel w={'62%'} h={13} r={7} />
      </div>
    </div>
  )
}

/** 任务列表：N 条与 .task-item 同构的行 */
export function TaskListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="task-item">
          <Skel w={22} h={22} r="50%" />
          <div className="task-main">
            <Skel w={`${72 - (i % 3) * 14}%`} h={14} r={7} style={{ marginBottom: 9 }} />
            <Skel w={`${46 - (i % 2) * 10}%`} h={11} r={6} />
          </div>
          <Skel w={44} h={12} r={6} />
        </div>
      ))}
    </div>
  )
}

/** 论坛帖子卡骨架（PostCardSkeleton）已随论坛下架一并移除：
    个人中心用的是普通列表，首屏没有需要骨架屏撑场的大块内容。 */

/** 课表日视图：7 枚日期胶囊 + 课程卡 */
export function ScheduleSkeleton() {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skel key={i} w={56} h={62} r={16} />
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="course-card">
          <Skel w={4} h={'100%'} r={4} />
          <div className="cc-main">
            <Skel w={`${58 - i * 12}%`} h={17} r={8} style={{ marginBottom: 12 }} />
            <Skel w={`${42 - i * 8}%`} h={12} r={6} style={{ marginBottom: 8 }} />
            <Skel w={`${34 - i * 6}%`} h={12} r={6} />
          </div>
        </div>
      ))}
    </div>
  )
}
