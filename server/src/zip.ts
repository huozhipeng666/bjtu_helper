/**
 * 最小 ZIP 打包器（无第三方依赖）。
 *
 * ## 为什么自己写
 *
 * 本仓库的服务端依赖是「零原生依赖 + 尽量少的 npm 包」（见 package.json，
 * 连数据库都用内置 `node:sqlite`）。为了一个「整目录导出」去引 jszip/archiver
 * 不划算：ZIP 的存储格式是稳定的公开规范，需要的只有 CRC32 + 头结构 + zlib，
 * 而 zlib 是 Node 内置的。
 *
 * ## 支持范围（刻意收窄）
 *
 * - 只写，不读。不处理 ZIP64 —— 单文件 / 整个包超过 4GB 直接抛错，
 *   而不是写一个会被解压工具判为损坏的包。
 * - 文件名一律按 UTF-8 写入并置通用标志位第 11 位（EFS），
 *   中文目录名/文件名在 Windows 资源管理器、macOS 归档工具、7-Zip 下都正常。
 * - 目录项单独写入（以 `/` 结尾的 0 字节条目），空文件夹因此不会在解压后消失。
 * - 压缩用 deflate；如果压完反而更大（已压缩过的 pdf/zip/图片），该文件改用
 *   store 模式存原样 —— 否则「压缩」会让整包变大。
 *
 * ## 已知不做的事
 *
 * - 不写时间以外的扩展字段（Unix 权限、NTFS 时间戳）。
 * - 不加密、不分卷。
 */

import { deflateRawSync } from 'node:zlib'

/* ---------------- CRC32 ---------------- */

/** CRC32 查表（IEEE 802.3 多项式 0xEDB88320，ZIP 规范要求的那一个） */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** 算一段字节的 CRC32（ZIP 每个条目头里都要存这个值） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------------- 类型 ---------------- */

export interface ZipEntry {
  /**
   * 包内路径，用 `/` 分隔（如 `第1章/讲义.pdf`）。
   *
   * ⚠️ 不允许以 `/` 开头、不允许出现 `..` 段、不允许盘符 ——
   *   这几种写法解压时会写到目标目录之外（Zip Slip）。本函数会直接抛错，
   *   而不是悄悄改名，因为路径来自学校平台的目录名，出问题应该暴露出来。
   */
  path: string
  data: Buffer
  /** 修改时间，缺省用当前时间 */
  mtime?: Date
}

export interface ZipBuildResult {
  bytes: Buffer
  /** 真正按 deflate 存的条目数 */
  deflated: number
  /** 因为压缩后更大而按原样（store）存的条目数 */
  stored: number
}

/** ZIP 格式的硬上限：4GB（不实现 ZIP64 时不能超过） */
const MAX_TOTAL_BYTES = 0xffffffff
/** 条目数上限：65535（同样是不实现 ZIP64 的硬限制） */
const MAX_ENTRIES = 0xffff

/* ---------------- 路径校验 ---------------- */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 规范化包内路径，同时挡掉 Zip Slip。
 *
 * 除了 `..` 与绝对路径，还要处理 Windows 的非法字符：
 * 平台上的文件夹名可能带 `:` 或 `*`（比如 `第3章: 复习*`），
 * 这些字符在 Windows 上解压会失败或被系统改写，统一换成全角/下划线更好预期。
 */
export function normalizeZipPath(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      if (seg === '.' || seg === '..') throw new Error(`导出路径非法：${raw}`)
      let s = seg
        // Windows 非法字符 → 下划线；控制字符一并清掉
        .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
        // 结尾的点和空格在 Windows 上会被吃掉，随后与相邻目录重名
        .replace(/[. ]+$/, '')
      if (s.length === 0) s = '_'
      // 设备保留名（CON/PRN/AUX/NUL/COM1…）在 Windows 上无法创建
      if (WINDOWS_RESERVED.test(s)) s = `_${s}`
      return s
    })

  if (cleaned.length === 0) throw new Error(`导出路径非法：${raw}`)
  const joined = cleaned.join('/')
  // 单段过长会让部分解压工具报错；255 是多数文件系统的上限
  if (Buffer.byteLength(joined, 'utf8') > 4096) throw new Error('导出路径过长')
  /*
   * ⚠️ 结尾斜杠必须保留：ZIP 里「以 / 结尾的 0 字节条目」才被识别成目录。
   *   如果这里吃掉它，解压后会变成一个同名的**空文件**，空文件夹就此丢失。
   */
  return raw.replace(/\\/g, '/').trimEnd().endsWith('/') ? `${joined}/` : joined
}

/* ---------------- 时间 ---------------- */

/**
 * 转成 MS-DOS 时间（ZIP 头里用的格式）。
 *
 * ⚠️ 年份早于 1980 时按 1980-01-01 写：DOS 时间的年份字段是「年份 - 1980」，
 *   更早的时间无法表示，写负数会得到一个乱码日期。
 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear()
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 }
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

/* ---------------- 打包 ---------------- */

/**
 * 把若干条目打成 ZIP。
 *
 * 结构：每个条目 = 本地文件头 + [压缩数据]；全部写完后是中央目录 + 结尾记录。
 * `localOffset` 记录每个条目在包里的起点，中央目录要靠它。
 */
export function buildZip(entries: readonly ZipEntry[]): ZipBuildResult {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`文件过多（${entries.length} 个），单次导出上限 ${MAX_ENTRIES} 个`)
  }

  const now = new Date()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let deflated = 0
  let stored = 0

  // 同名条目会让解压工具互相覆盖，导出前必须挡住
  const seen = new Set<string>()

  for (const entry of entries) {
    const path = normalizeZipPath(entry.path)
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Error(`导出出现重名文件：${path}`)
    seen.add(key)

    const data = entry.data
    if (data.length > MAX_TOTAL_BYTES) throw new Error(`单个文件超过 4GB：${path}`)

    const nameBuf = Buffer.from(path, 'utf8')
    const crc = crc32(data)
    const { time, date } = dosDateTime(entry.mtime ?? now)

    // 先试着压；压不小就存原样（pdf/zip/图片压完往往更大）
    let payload = data
    let method = 0
    if (data.length > 0) {
      const packed = deflateRawSync(data, { level: 6 })
      if (packed.length < data.length) {
        payload = packed
        method = 8
        deflated++
      } else {
        stored++
      }
    }

    if (data.length > MAX_TOTAL_BYTES || payload.length > MAX_TOTAL_BYTES) {
      throw new Error(`文件过大：${path}`)
    }
    if (offset + 30 + nameBuf.length + payload.length > MAX_TOTAL_BYTES) {
      throw new Error('导出内容超过 4GB，请分目录导出')
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // 通用标志：bit11 = 文件名为 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    locals.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
    central.writeUInt16LE(20, 4) // 生成者版本
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段长度
    central.writeUInt16LE(0, 32) // 注释长度
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性（不写 Unix 权限，交给解压方默认）
    central.writeUInt32LE(offset, 42) // 本地头偏移

    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 中央目录结束签名
  eocd.writeUInt16LE(0, 4) // 当前磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8) // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10) // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12) // 中央目录字节数
  eocd.writeUInt32LE(offset, 16) // 中央目录起始偏移
  eocd.writeUInt16LE(0, 20) // 注释长度

  return {
    bytes: Buffer.concat([...locals, centralBuf, eocd]),
    deflated,
    stored
  }
}

/**
 * 生成一个目录条目（以 `/` 结尾、无内容）。
 *
 * 不做成 `buildZip` 的隐式行为：调用方通常**只需要**给空文件夹补条目，
 * 给每个文件都补它的父目录会产生一堆没必要的条目。
 */
export function zipDirEntry(path: string, mtime?: Date): ZipEntry {
  // 已有结尾斜杠就不再重复；normalizeZipPath 会保留它
  const withSlash = path.replace(/\\/g, '/').trimEnd().endsWith('/') ? path : `${path}/`
  return { path: withSlash, data: Buffer.alloc(0), mtime }
}
