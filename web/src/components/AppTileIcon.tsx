/**
 * 「应用」模块的分类图标。
 *
 * 为什么单独一个文件、不用 icons.tsx 里的图标：
 *  icons.tsx 的图标是**导航语义**（首页 / 列表 / 课表 / 用户），线条细、
 *  尺寸固定 22~24。应用磁贴需要更饱满的图形（有填充块、有内部结构），
 *  直接复用会让网格看起来"全是线条"。这里统一 24×24 viewBox，
 *  由调用方通过 CSS `color` 注入分类强调色（全部用 currentColor）。
 *
 * ⚠️ 一律不引第三方图标库：CSP 是 `script-src 'self'`，且项目坚持零依赖。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(size = 24, props: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props
  }
}

/** 作业：一叠带勾选线的纸 */
export const IconAppHomework = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 3.5h9.5L19 7v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M15 3.5V7h4" />
    <path d="m8.5 12.5 1.6 1.6 3.4-3.4" />
    <path d="M8.5 17.5h7" />
  </svg>
)

/** 成绩：柱状图 + 上升箭头 */
export const IconAppGrades = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 20h16" />
    <rect x="5.5" y="12" width="3" height="5.5" rx="1" />
    <rect x="10.5" y="8.5" width="3" height="9" rx="1" />
    <rect x="15.5" y="5" width="3" height="12.5" rx="1" />
  </svg>
)

/** 课件：文件夹中露出一角文档 */
export const IconAppCourseware = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.6l1.7 2h8.2A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z" />
    <path d="M9 12h6M9 15h4" />
  </svg>
)

/** 校历：日历 + 顶栏点 */
export const IconAppCalendar = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3.5v3M16 3.5v3" />
    <path d="M7.5 13h2M11 13h2M14.5 13h2M7.5 16.5h2M11 16.5h2" />
  </svg>
)

/** 教室：带门窗的屋子 */
export const IconAppClassroom = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 20V6.2a1.2 1.2 0 0 1 .8-1.13l7-2.5a1.2 1.2 0 0 1 1.6 1.13V20" />
    <path d="M13.4 9.5H19a1 1 0 0 1 1 1V20" />
    <path d="M2.8 20h18.4" />
    <path d="M7 8.5h3M7 12h3M16 13v3" />
  </svg>
)

/** 校园卡：圆角卡片 + 磁条 */
export const IconAppCampusCard = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4" />
    <path d="M2.8 9.6h18.4" />
    <path d="M6.2 14.2h4.2" />
  </svg>
)

/** 校园网：信号弧线 */
export const IconAppCampusNet = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4.2 10.2a11 11 0 0 1 15.6 0" />
    <path d="M7.2 13.4a6.8 6.8 0 0 1 9.6 0" />
    <path d="M10.1 16.6a2.7 2.7 0 0 1 3.8 0" />
    <circle cx="12" cy="19.2" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

/** 邮箱：信封 */
export const IconAppMailbox = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="2.8" y="5.5" width="18.4" height="13" rx="2.2" />
    <path d="m3.6 7.4 7.3 5.2a2 2 0 0 0 2.2 0l7.3-5.2" />
  </svg>
)

/** 成绩单：带印章的文档 */
export const IconAppReportCard = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 3.5h12A1.5 1.5 0 0 1 19.5 5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z" />
    <path d="M8 8h8M8 11.5h8M8 15h4.5" />
    <circle cx="15.6" cy="16.2" r="2.3" />
  </svg>
)

/** 同步：双向循环箭头 */
export const IconAppSync = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4.5 11.5a7.5 7.5 0 0 1 12.9-5.2L20 9" />
    <path d="M20 4.6V9h-4.4" />
    <path d="M19.5 12.5a7.5 7.5 0 0 1-12.9 5.2L4 15" />
    <path d="M4 19.4V15h4.4" />
  </svg>
)

/** 二维码：角标 + 点阵 */
export const IconAppQr = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.3" />
    <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.3" />
    <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.3" />
    <path d="M14 14h2.6v2.6H14zM17.9 20.5h2.6v-2.6" />
  </svg>
)

/** 考试安排：一张写了日期的试卷（不是日历 —— 日历已被「校历」占用） */
export const IconAppExams = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M5.5 3.5h9.5l4 4v13a1 1 0 0 1-1 1h-12.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M15 3.5v4h4" />
    <path d="M8 12.5h7M8 16h4.5" />
  </svg>
)

/** 教室占用：7×7 格子（与教室人数「带门窗的屋子」区分开） */
export const IconAppOccupancy = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2" />
    <path d="M8.2 3.2v17.6M14.8 3.2v17.6M3.2 8.2h17.6M3.2 14.8h17.6" />
    <rect x="8.2" y="8.2" width="6.6" height="6.6" fill="currentColor" stroke="none" opacity="0.55" />
  </svg>
)

/** CITEL：显示器 + 代码角标（独立 Moodle 教学平台） */
export const IconAppCitel = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="2.8" y="4.2" width="18.4" height="12.4" rx="2" />
    <path d="M8.5 20h7M12 16.6V20" />
    <path d="m9.6 8.2-1.8 2.2 1.8 2.2" />
    <path d="m14.4 8.2 1.8 2.2-1.8 2.2" />
    <path d="M13.2 7.8l-2.4 4.8" />
  </svg>
)

/** 物理在线：锥形瓶（Moodle 物理实验平台） */
export const IconAppPhyVlab = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M9.5 3.5h5M10.5 3.5v5.2L5.6 17a2.6 2.6 0 0 0 2.3 3.9h8.2A2.6 2.6 0 0 0 18.4 17l-4.9-8.3V3.5" />
    <path d="M7.8 14.2h8.4" />
    <circle cx="10.4" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="13.9" cy="17.8" r="0.7" fill="currentColor" stroke="none" />
  </svg>
)

/** 物理实验：原子轨道（教务处实验选课系统） */
export const IconAppPhysicsLab = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
    <ellipse cx="12" cy="12" rx="9.2" ry="3.8" />
    <ellipse cx="12" cy="12" rx="9.2" ry="3.8" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9.2" ry="3.8" transform="rotate(120 12 12)" />
  </svg>
)

/** 演示实验：预约日历 + 对勾（演示实验室预约） */
export const IconAppPhyDemo = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3.5v3M16 3.5v3" />
    <path d="m8.6 14.6 2.2 2.2 4.4-4.4" />
  </svg>
)

const APP_ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  homework: IconAppHomework,
  grades: IconAppGrades,
  courseware: IconAppCourseware,
  calendar: IconAppCalendar,
  classroom: IconAppClassroom,
  occupancy: IconAppOccupancy,
  exams: IconAppExams,
  campuscard: IconAppCampusCard,
  campusnet: IconAppCampusNet,
  mailbox: IconAppMailbox,
  reportcard: IconAppReportCard,
  sync: IconAppSync,
  qr: IconAppQr,
  citel: IconAppCitel,
  phyvlab: IconAppPhyVlab,
  physicslab: IconAppPhysicsLab,
  phydemo: IconAppPhyDemo
}

/** 按注册表的 `icon` 键取图标；未知键回退到二维码图标（不会渲染成空白） */
export function AppTileIcon({ name, size = 24, ...rest }: IconProps & { name: string }) {
  const Comp = APP_ICONS[name] ?? IconAppQr
  return <Comp size={size} {...rest} />
}
