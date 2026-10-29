import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(size = 24, props: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props
  }
}

export const IconHome = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
)

export const IconSchedule = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
    <path d="M3 9.5h18" />
    <path d="M8 2.5v4M16 2.5v4" />
  </svg>
)

export const IconList = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 6.5h16M4 12h16M4 17.5h10" />
  </svg>
)

export const IconBook = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22.5z" />
    <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
    <path d="M8.5 7h6" />
  </svg>
)

export const IconGear = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h0a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
)

export const IconPlus = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconBell = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M18 8.5a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </svg>
)

export const IconChevronLeft = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
)

export const IconChevronRight = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)

export const IconClock = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const IconMapPin = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M20 10.5c0 6-8 10.5-8 10.5s-8-4.5-8-10.5a8 8 0 0 1 16 0z" />
    <circle cx="12" cy="10.5" r="2.5" />
  </svg>
)

export const IconPin = ({ size = 24, filled = false, ...p }: IconProps & { filled?: boolean }) => (
  <svg {...base(size, p)} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    <path d="M12 15v5" />
  </svg>
)

export const IconArrowRight = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 12h16m-6-6 6 6-6 6" />
  </svg>
)

export const IconRefresh = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 4v5h-5" />
  </svg>
)

export const IconUser = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </svg>
)

export const IconSun = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9 6.7 6.7M17.3 17.3 19.1 19.1M19.1 4.9 17.3 6.7M6.7 17.3 4.9 19.1" />
  </svg>
)

export const IconCalendar = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
    <path d="M3 9.5h18" />
    <path d="M8 2.5v4M16 2.5v4" />
    <path d="M8.5 14h3M8.5 17h6" />
  </svg>
)

export const IconDownload = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M4.5 20h15" />
  </svg>
)

/** 文件夹：课件列表里的"展开"按钮 */
export const IconFolder = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L12 7.5h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)

export const IconCheck = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
)

export const IconClose = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IconEdit = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
)

export const IconTrash = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2M19 6l-1 15H6L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

export const IconMoon = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

export const IconSearch = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)

/** 站内信 / 消息通知（信封） */
export const IconMail = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m3.5 7.5 7.3 5.2a2 2 0 0 0 2.4 0l7.3-5.2" />
  </svg>
)

/** 联系管理员 / 提交反馈（纸飞机） */
export const IconSend = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M21.5 3.5 2.8 10.4a.6.6 0 0 0 .05 1.13l7.1 2.4 2.4 7.1a.6.6 0 0 0 1.13.05z" />
    <path d="M21.5 3.5 9.95 13.93" />
  </svg>
)

/** 反馈工单 / 待办列表（带勾的清单） */
export const IconTicket = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 6.5h16v4a1.5 1.5 0 0 0 0 3v4H4v-4a1.5 1.5 0 0 0 0-3z" />
    <path d="M9.5 6.5v11" />
  </svg>
)

export const IconHeart = ({ size = 24, filled = false, ...p }: IconProps & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
)

export const IconCamera = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2.1A1.5 1.5 0 0 1 10.8 3h2.4a1.5 1.5 0 0 1 1.3.9L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.2" />
  </svg>
)

export const IconFire = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3c1 3 3 4.5 3 7a3 3 0 0 1-6 0c0-1 .3-1.9.7-2.7C7.3 8.6 6 11 6 13.5a6 6 0 0 0 12 0C18 8 14 6 12 3z" />
    <path d="M9.5 18a2.6 2.6 0 0 0 5 .5" />
  </svg>
)

/** 评论数：对话气泡 */
export const IconComment = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M20 11.2a7.3 7.3 0 0 1-7.5 7.1c-1.1 0-2.2-.2-3.2-.7L5 18.8l1.2-3.4a6.9 6.9 0 0 1-1.7-4.2A7.3 7.3 0 0 1 12 4.1a7.3 7.3 0 0 1 8 7.1z" />
  </svg>
)

/** 回到顶部：向上箭头 + 顶部横线 */
export const IconArrowUp = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <line x1="12" y1="20" x2="12" y2="5" />
    <polyline points="5.5 11.5 12 5 18.5 11.5" />
  </svg>
)

/** 向下箭头（用于任务排序等） */
export const IconArrowDown = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <line x1="12" y1="4" x2="12" y2="19" />
    <polyline points="18.5 12.5 12 19 5.5 12.5" />
  </svg>
)

/** 考务：学位帽，用于课表页「考务」入口与考试条目 */
export const IconGraduation = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M2.5 8.5 12 4.4l9.5 4.1L12 12.6 2.5 8.5Z" />
    <path d="M6.2 10.6V16c0 1.7 2.6 3 5.8 3s5.8-1.3 5.8-3v-5.4" />
    <line x1="21.5" y1="9" x2="21.5" y2="15" />
  </svg>
)

/**
 * 考核与成绩占比：三根高低不同的柱子（统计图）。
 *
 * 为什么是柱状图而不是饼图，也不是 emoji：
 *  ① emoji（📊）由系统字体渲染，各平台的字形/基线/配色都不受控，混在一排线性图标里
 *     会明显"贴纸感"；而且它无法继承 currentColor，深浅主题下都只能将就。
 *  ② 饼图在这个位置**会和时间图标撞脸** —— 课程卡片的正文行依次是「时钟 · 地点 · 占比」，
 *     都是"圆里带线"，三个圆形叠成一列反而更难扫读。
 *     柱状图的竖向剪影与它们截然不同，一眼就能区分。
 *  ③ 13px 下三段竖线比圆弧更抗糊：即使只有 1px 描边也能看出是"高低不同的几份"。
 *
 * 几何上刻意让最高的一根从 y=4 到 y=19（其余图标大致占满 3~21），
 * 否则柱子只占中间一小段，摆在时钟/定位图标旁边会显得明显偏小、发虚。
 */
export const IconChart = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <line x1="4.5" y1="19" x2="4.5" y2="11" />
    <line x1="12" y1="19" x2="12" y2="4.5" />
    <line x1="19.5" y1="19" x2="19.5" y2="15" />
  </svg>
)

/** 帮助：圆圈问号，用于个人中心「帮助」板块 */
export const IconHelp = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="9.3" />
    <path d="M9.4 9.6a2.7 2.7 0 1 1 3.5 2.6c-.7.28-1 .88-1 1.6v.3" />
    <line x1="12" y1="17.2" x2="12" y2="17.2" />
  </svg>
)

/** 显示设置：三根带滑块的横线，用于课表页「课表显示」弹层入口（设计稿图2） */
export const IconSliders = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="9" cy="7" r="2.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="17" r="2.2" fill="currentColor" stroke="none" />
  </svg>
)

/** 分享：向上箭头 + 托盘，用于「分享课表」入口（设计稿图3） */
export const IconShare = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 3.5v11" />
    <path d="M8 7.5 12 3.5l4 4" />
    <path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
)

/** 多人：空闲课表（群组）入口用 */
export const IconUsers = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 6" />
    <path d="M17.2 14.8c2.2.5 3.8 2.2 3.8 4.7" />
  </svg>
)

/** 网格：空闲课表 Hero 用的 6 宫格图标 */
export const IconGrid = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3.5" y="4" width="5.5" height="7" rx="1.6" />
    <rect x="15" y="4" width="5.5" height="7" rx="1.6" />
    <rect x="3.5" y="13" width="5.5" height="7" rx="1.6" />
    <rect x="15" y="13" width="5.5" height="7" rx="1.6" />
    <rect x="9.25" y="8.5" width="5.5" height="7" rx="1.6" />
  </svg>
)

/** 闪电：加入群组入口（设计稿图5 用闪电表示"输入密钥加入"） */
export const IconBolt = ({ size = 24, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M13.6 2.5 5.2 13.2h5.6l-1.4 8.3L18.8 10.8h-5.6z" />
  </svg>
)
