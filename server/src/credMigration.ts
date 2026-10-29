/**
 * 存量凭据迁移（启动时清扫明文密码）。
 *
 * ## 为什么要在启动时扫一遍
 *
 * `credAtRest.ts` 落地后，`independentAccounts.readAccount()` 会在**读到**某条明文
 * 记录时把它加密回写 —— 这是「惰性迁移」。上线后线上库实测：10 条独立平台凭据里
 * 还有 4 条是明文，因为它们的主人自从加密上线后就没再点过那个平台。惰性迁移的
 * 前提是「会被读到」，而总有一部分记录永远等不到那次读取。
 *
 * 后果是确凿的：`scripts/backup-cron.sh` 每天把整库带走，那 4 个平台密码就在备份里
 * 躺着。所以不能只靠惰性迁移 —— 进程启动时主动扫全表，一轮之后库里不该再有明文。
 *
 * ## 三条必须守住的性质
 *
 * 1. **只动明文行**。已加密的行一个字节都不碰：每次启动重写全表不仅白费磁盘与 WAL，
 *    还会因为每次 iv 不同而把所有密文翻新一遍（毫无收益的写放大）。
 * 2. **空串原样保留**。`upsertAccount` 用空串表达「只换用户名、沿用原密码」，
 *    SQL 侧靠 `CASE WHEN excluded.password = ''` 判断。把空串加密成密文会让这个
 *    判断失效，用户下次换用户名时旧密码被抹掉 —— 静默的数据损失。
 * 3. **单行失败不许拖垮启动**。密钥不可用、密文格式异常都只记 failed 计数并打日志，
 *    让进程照常起来；失败的行保持明文（宁可留着能被发现，也不要静默丢密码）。
 *
 * ## 为什么依赖注入
 *
 * 直接 import `db` / `encryptSecret` 就没法在回归里造「表不存在」「密钥抛错」
 * 这类分支，而这几种分支恰恰是最容易写错、也最该被钉住的地方。所以两个依赖都从
 * 参数进来，生产侧在 `index.ts` 启动处传真货。
 */
import { encryptSecret } from './credAtRest.js'
import { db } from './db.js'

const ENC_PREFIX = 'enc:v1:'

/** 一次清扫的结果（供日志与回归断言） */
export interface SweepResult {
  /** 全表行数（含空串与已加密行） */
  scanned: number
  /** 本次真正加密回写的行数 */
  migrated: number
  /** 加密失败、保持原样的行数 */
  failed: number
}

interface SweepRow {
  id: number
  user_id: number
  platform: string
  password: string
}

/** `db.prepare` 的最小形状 —— 只声明本文件用到的部分，方便回归里造假对象 */
interface MinimalDb {
  prepare(sql: string): {
    all(): unknown[]
    run(...params: unknown[]): unknown
  }
}

const EMPTY: SweepResult = { scanned: 0, migrated: 0, failed: 0 }

/**
 * 扫描 `independent_accounts`，把仍然明文的密码加密回写。
 *
 * @param database 数据库句柄（生产传 db，回归传假对象）
 * @param encrypt  加密函数（生产传 encryptSecret，回归传可抛错的桩）
 * @param onError  单行失败时的回调，默认不做事（生产侧传日志函数）
 */
export function sweepPlaintextCredentials(
  database: MinimalDb = db as unknown as MinimalDb,
  encrypt: (plain: string) => string = encryptSecret,
  onError?: (row: SweepRow, err: unknown) => void
): SweepResult {
  let rows: SweepRow[]
  try {
    rows = database
      .prepare(`SELECT id, user_id, platform, password FROM independent_accounts`)
      .all() as SweepRow[]
  } catch {
    /* 表还没建（首次启动）或 schema 变更中：不是错误，没东西可迁移 */
    return { ...EMPTY }
  }
  if (!Array.isArray(rows)) return { ...EMPTY }

  const result: SweepResult = { scanned: rows.length, migrated: 0, failed: 0 }

  for (const row of rows) {
    const stored = typeof row.password === 'string' ? row.password : ''
    /* 空串是「沿用原密码」的哨兵，必须原样留着（性质 2） */
    if (!stored) continue
    /* 已经是密文（性质 1） */
    if (stored.startsWith(ENC_PREFIX)) continue

    let next = ''
    try {
      next = encrypt(stored)
    } catch (err) {
      result.failed++
      onError?.(row, err)
      continue
    }
    /* 加密函数回空串时绝不能拿去覆盖原密码（性质 3 的变体：静默丢密码） */
    if (!next) {
      result.failed++
      onError?.(row, new Error('加密结果为空'))
      continue
    }

    try {
      database
        .prepare(`UPDATE independent_accounts SET password = ? WHERE id = ?`)
        .run(next, row.id)
      row.password = next
      result.migrated++
    } catch (err) {
      result.failed++
      onError?.(row, err)
    }
  }

  return result
}
