/**
 * 课件整目录导出的**纯逻辑**（无网络、无数据库、无会话）。
 *
 * ## 为什么单独一个文件
 *
 * `courseware.ts` 一被 import 就会顺着 `mis.js` 拖进整个会话体系（cookie jar、
 * SSO、fetch 包装），最底下还会打开 SQLite。那样这几个纯函数就没法在单测里
 * 单独跑了 —— 而「哪个文件该进包、哪个该跳过、路径怎么拼」恰恰是最容易写错、
 * 也最该被单测锁住的部分。这里只放数据形状 + 摊平算法。
 */

/** 导出时用到的节点形状（与 `courseware.ts` 的 CoursewareNode 结构兼容） */
export interface ExportableNode {
  id: string
  name: string
  kind: 'folder' | 'file'
  rpId: string
  canDownload: boolean
}

export interface ExportFile {
  /** 包内路径（含祖先目录，如 `第1章/讲义.pdf`） */
  path: string
  rpId: string
  /** 平台文件名，用于失败时回显 */
  name: string
}

export interface ExportTree {
  files: ExportFile[]
  /** 老师未开放下载的文件名（跳过，但在结果里说明） */
  skipped: string[]
  /** 子目录路径（是否为空要等整棵子树扫完才知道） */
  dirs: string[]
}

/** 单次导出的文件数上限 —— 一次下载几百个文件既慢又会打爆内存 */
export const EXPORT_MAX_FILES = 200
/** 单次导出的总字节上限（500MB），超过就提示「分目录导出」 */
export const EXPORT_MAX_BYTES = 500 * 1024 * 1024
/** 递归层数上限，防御平台侧出现环状 bag_id 引用 */
export const EXPORT_MAX_DEPTH = 12

/**
 * 把路径里的分隔符与 Windows 非法字符替换掉。
 *
 * 只做「不破坏目录结构」这一件事：名字里带 `/` 会让文件跑到别的目录下，
 * 带 `\` 在 Windows 上同理。其余字符（如 `:`）交给 zip 层统一处理。
 */
export function safeSegment(name: string, fallback: string): string {
  return name.replace(/[/\\]/g, '_').trim() || fallback
}

/** 拼包内路径，根目录时不留前导斜杠 */
export function joinExportPath(parent: string, name: string, fallback: string): string {
  const seg = safeSegment(name, fallback)
  return parent ? `${parent}/${seg}` : seg
}

/**
 * 摊平一层节点：分出「待下载 / 跳过 / 子目录」。
 *
 * 上游在 `exportDirectory` 里做的是同一件事
 * （`resourcesWithFolders(stableKey).partition { it.node.downloadAllowed }`），
 * 未开放下载的文件收集成 skipped，**不能因为一个文件不可下载就整单失败**。
 */
export function flattenExportTree(nodes: readonly ExportableNode[], parentPath = ''): ExportTree {
  const files: ExportFile[] = []
  const skipped: string[] = []
  const dirs: string[] = []

  for (const n of nodes) {
    const path = joinExportPath(parentPath, n.name, n.id)
    if (n.kind === 'folder') {
      dirs.push(path)
      continue
    }
    // 没有 rpId 就拿不到下载票据，硬塞进去只会在下载阶段失败
    if (!n.rpId) continue
    if (!n.canDownload) {
      skipped.push(n.name)
      continue
    }
    files.push({ path, rpId: n.rpId, name: n.name })
  }

  return { files, skipped, dirs }
}

/**
 * 一棵已经递归采集完的目录树 → 待打包条目。
 *
 * `files` 里每个文件的**祖先目录**都算非空；只有从没被任何文件用到的目录
 * 才需要单独写一个目录条目（否则解压后空文件夹会消失）。
 */
export function collectEmptyDirs(
  files: readonly { path: string }[],
  dirs: readonly string[]
): string[] {
  const nonEmpty = new Set<string>()
  for (const f of files) {
    let p = f.path
    for (;;) {
      const cut = p.lastIndexOf('/')
      if (cut < 0) break
      p = p.slice(0, cut)
      nonEmpty.add(p)
    }
  }
  return dirs.filter((d) => !nonEmpty.has(d)).sort()
}
