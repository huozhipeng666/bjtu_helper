/**
 * 「应用」模块的目录注册表。
 *
 * 为什么要有这张表而不是在各处硬写：
 *  1. 「应用」页网格、搜索、以及后续的变动提醒跳转都要用到同一份元数据
 *     （标题、副标题、分类、图标、强调色、真实可用性），分散定义必然漂移。
 *  2. 分级（见下）是**给人看的诚实标注** —— 它同时驱动 UI 上的「即将上线」角标，
 *     而不是偷偷放一个点了没反应的按钮。
 *
 * 分级来源：`docs/2026-10-15-参照KMP增设应用模块_方案设计.md`
 *  - ready    已可用（复用已有抓取器或纯本地）
 *  - beta     已实现但依赖学校系统解析，可能出现「学校改版」错误
 *  - soon     规划中，暂不开放
 */

/** 应用分类 —— 决定网格分组标题与强调色 */
export type AppCategory = 'study' | 'campus' | 'tool'

interface CategoryMeta {
  key: AppCategory
  title: string
  /** CSS 变量名后缀，见 styles.css 的 --app-c-* */
  accentVar: string
}

export const APP_CATEGORIES: CategoryMeta[] = [
  { key: 'study', title: '学习', accentVar: '--app-c-study' },
  { key: 'campus', title: '校园服务', accentVar: '--app-c-campus' },
  { key: 'tool', title: '工具', accentVar: '--app-c-tool' }
]

/**
 * 应用条目。
 *
 * `id` 同时是前端路由键与后端数据域的键，**不要随手改**：
 * 变动提醒的 `domain` 会存进数据库，改名会让历史快照对不上。
 */
export interface AppEntry {
  id: string
  title: string
  subtitle: string
  category: AppCategory
  /** 图标键，见 components/AppTileIcon.tsx */
  icon: string
  status: 'ready' | 'beta' | 'soon'
  /** 是否需要登录（游客点按会被引导登录） */
  needLogin?: boolean
  /** 是否为外链入口（点击后由 App 处理跳转，不走内部子页） */
  external?: boolean
}

export const APP_ENTRIES: AppEntry[] = [
  /* ---------------- 学习 ---------------- */
  {
    id: 'homework',
    title: '课程平台作业',
    subtitle: '智慧课程平台的作业与实验报告',
    category: 'study',
    icon: 'homework',
    status: 'ready',
    needLogin: true
  },
  {
    id: 'grades',
    title: '成绩查询',
    subtitle: '各学期成绩、学分与绩点统计',
    category: 'study',
    icon: 'grades',
    status: 'beta',
    needLogin: true
  },
  {
    id: 'exams',
    title: '考试安排',
    subtitle: '考试时间、地点与座位号',
    category: 'study',
    icon: 'exams',
    status: 'ready',
    needLogin: true
  },
  {
    id: 'courseware',
    title: '课件下载',
    subtitle: '智慧课程平台的资料与附件',
    category: 'study',
    icon: 'courseware',
    status: 'ready',
    needLogin: true
  },
  {
    id: 'calendar',
    title: '校历',
    subtitle: '本学期周次表与放假安排',
    category: 'study',
    icon: 'calendar',
    status: 'ready'
  },
  {
    id: 'citel',
    title: 'CITEL',
    subtitle: 'CITEL 教学平台的作业与编程练习（独立账号）',
    category: 'study',
    icon: 'citel',
    status: 'beta',
    needLogin: true
  },
  {
    id: 'phyvlab',
    title: '物理在线',
    subtitle: '物理在线平台的课程作业（独立账号）',
    category: 'study',
    icon: 'phyvlab',
    status: 'beta',
    needLogin: true
  },

  /* ---------------- 校园服务 ---------------- */
  {
    id: 'campuscard',
    title: '校园卡',
    subtitle: '充值、余额与消费记录',
    category: 'campus',
    icon: 'campuscard',
    status: 'ready'
  },
  {
    id: 'campusnet',
    title: '校园网',
    subtitle: '网络自服务与常见问题',
    category: 'campus',
    icon: 'campusnet',
    status: 'ready'
  },
  {
    id: 'mailbox',
    title: '校园邮箱',
    subtitle: '收发校内邮件，支持附件下载',
    category: 'campus',
    icon: 'mailbox',
    status: 'ready',
    needLogin: true
  },
  {
    id: 'classroom',
    title: '教室人数',
    subtitle: '各教学楼实时人数估计（第三方公开数据）',
    category: 'campus',
    icon: 'classroom',
    status: 'beta'
  },
  {
    id: 'occupancy',
    title: '教室占用',
    subtitle: '本周各教室的排课、考试与实验占用',
    category: 'campus',
    icon: 'occupancy',
    status: 'beta',
    needLogin: true
  },
  {
    id: 'physicslab',
    title: '物理实验',
    subtitle: '实验选课系统的实验安排（独立账号）',
    category: 'campus',
    icon: 'physicslab',
    status: 'beta',
    needLogin: true
  },
  {
    id: 'phydemo',
    title: '演示实验',
    subtitle: '演示实验室的预约记录（独立账号）',
    category: 'campus',
    icon: 'phydemo',
    status: 'beta',
    needLogin: true
  },

  /* ---------------- 工具 ---------------- */
  {
    id: 'reportcard',
    title: '成绩单下载',
    subtitle: '中英文成绩单 PDF（用于申请材料）',
    category: 'tool',
    icon: 'reportcard',
    status: 'beta',
    needLogin: true
  },
  {
    id: 'sync',
    title: '数据同步',
    subtitle: '一次登录，同步课表 / 成绩 / 作业 / 考试',
    category: 'tool',
    icon: 'sync',
    status: 'ready',
    needLogin: true
  }
]

/** 按分类分组（保持 APP_CATEGORIES 的顺序，空分类不出现） */
export function groupedEntries(entries: AppEntry[] = APP_ENTRIES): { meta: CategoryMeta; items: AppEntry[] }[] {
  return APP_CATEGORIES.map((meta) => ({
    meta,
    items: entries.filter((e) => e.category === meta.key)
  })).filter((g) => g.items.length > 0)
}

export function findEntry(id: string): AppEntry | undefined {
  return APP_ENTRIES.find((e) => e.id === id)
}

/** 校园邮箱地址（学校统一门户） */
export const MAILBOX_URL = 'https://mail.bjtu.edu.cn'
