/**
 * 数据目录权限收口 —— 抽成纯逻辑 + 可注入依赖，好在回归里钉住。
 *
 * ── 为什么这件事值得单独一个模块 ──────────────────────────────────
 * 线上实测（2026-10-27）：`server/data/bjtu-helper.db` 是 **644**，
 * 同目录里还躺着 7 个历史快照（`bjtu-helper.pre-terms-*.db`、
 * `bjtu-helper-backup-before-forum-migration-*.db` …）以及 `-wal`/`-shm`，
 * 全部 644，目录 755。也就是说**同机任何用户都能把整个库拷走** ——
 * 里面是真实学生的学号、课表、加密后的平台密码密文与会话。
 *
 * 收口靠三层，互不依赖（任一层漏了另外两层仍有效）：
 *  ① 本模块：启动时扫一遍 dataDir，把历史遗留的宽松权限改掉（补历史文件的洞）；
 *  ② systemd `UMask=0077`：保证**今后**新写的文件天然 0600（含 -wal、上传图、备份）；
 *  ③ 部署脚本 chmod 兜底。
 *
 * 为什么"扫描"不能省、只靠 UMask：UMask 只影响本进程**之后**创建的文件，
 * 对已经存在的 644 历史快照完全无效。而恰恰是这些快照最容易被忘掉。
 *
 * ── 为什么不递归 ────────────────────────────────────────────────
 * `uploads/` 子目录里是图片，由 express.static 直接对外提供，权限语义与库文件不同
 * （启动时统一改可能破坏 CDN/反代下的读取）。这里只处理**目录内第一层**的库文件。
 */
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 库文件与目录的目标权限：只有属主可读写/进入 */
export const DATA_DIR_MODE = 0o700
export const DATA_FILE_MODE = 0o600

/**
 * 判断某个文件名是否属于"装着用户数据、必须收紧权限"的那一类。
 *
 * 刻意写得很窄 —— 宁可漏掉某个奇怪后缀，也不要误伤运维自己放进来的东西
 * （readme、导出脚本、临时 SQL）。真正需要收紧的是：
 *   `bjtu-helper.db`、`bjtu-helper.db-wal`、`bjtu-helper.db-shm`、
 *   以及任意 `bjtu-helper*.db` / `.db.gz` / `.db.gzip` 形式的快照。
 *
 * ⚠️ `scripts/backup-db.mjs --gzip` 的产物名形如
 * `bjtu-helper-20261027-030000.db.gz`，压缩后**依然是完整用户数据**，
 * 一样要收 —— 备份文件常常被当成"压缩过了就没事"，其实只是省了空间。
 */
export function isSensitiveDataFile(name: string): boolean {
  if (!name.startsWith('bjtu-helper')) return false
  /* SQLite 的伴生文件命名是 <db>-wal / <db>-shm（连字符，不是 .db-wal）。
     两种写法都认，免得因为一个连字符让 -wal 留在 644。 */
  if (/-wal$|-shm$/.test(name)) return true
  if (/\.db$/.test(name)) return true
  if (/\.db\.gz$/.test(name) || /\.db\.gzip$/.test(name)) return true
  return false
}

export interface HardenResult {
  /** 扫描到的常规文件总数（不只是被改的那些） */
  scanned: number
  /** 真正改了权限的文件名 */
  changed: string[]
}

/**
 * 把 `dir` 目录本身与目录内所有"装着用户数据"的常规文件收敛到 0700 / 0600。
 *
 * 依赖全部可注入（`list`/`chmod`），这样回归可以在没有真实文件系统的前提下
 * 断言"哪些文件名被处理、哪些被跳过"—— 这正是最容易写错的地方
 * （正则写松了会误伤，写紧了会漏掉 -wal）。
 *
 * 任何单点失败都吞掉：权限收紧是**加固**，不是启动前提。
 * 让服务因为"某台机器上 chmod 不支持"而起不来，是把加固变成了新的可用性风险。
 */
export function hardenDataDir(
  dir: string,
  io: {
    list: (dir: string) => { name: string; isFile: () => boolean }[]
    chmod: (path: string, mode: number) => void
  } = {
    list: (d) => readdirSync(d, { withFileTypes: true }),
    chmod: (p, m) => chmodSync(p, m)
  }
): HardenResult {
  const result: HardenResult = { scanned: 0, changed: [] }
  try {
    io.chmod(dir, DATA_DIR_MODE)
  } catch {
    /* 目录本身改不动也继续：能改文件也是好的 */
  }
  let entries: { name: string; isFile: () => boolean }[]
  try {
    entries = io.list(dir)
  } catch {
    /* 目录不可读（权限/跨平台）→ 什么都不做 */
    return result
  }
  for (const entry of entries) {
    /* 只认常规文件：符号链接不跟随（改动它会把权限设在链接目标上，
       那是别人路径下的文件，可能根本不属于本服务）。 */
    if (!entry.isFile()) continue
    result.scanned++
    if (!isSensitiveDataFile(entry.name)) continue
    try {
      io.chmod(join(dir, entry.name), DATA_FILE_MODE)
      result.changed.push(entry.name)
    } catch {
      /* 单个失败不影响其它文件 */
    }
  }
  return result
}
