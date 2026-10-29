/**
 * 独立账号凭据库（CITEL / 物理在线 / 物理实验 / 演示实验）。
 *
 * ## 为什么要有这一层
 *
 * 这四个平台各自有**独立的账号密码**，与统一身份认证无关（上游 v1.8.5 发布说明
 * 明确：物理在线的 OAuth 按钮仍指向已下线的 CAS，物理实验/演示实验从来就是独立
 * 账号）。凭据不能进普通业务表 —— 需要单独一张表、单独的读写入口，将来想加
 * 「凭据加密落盘」时只改这一个文件。
 *
 * ## 存储加密（评审 B1，2026-10-23 起启用）
 *
 * 此前的取舍是「存储明文、传输走 RSA 信封」，理由是"服务端被攻陷时密钥同机"。
 * 但 `backup.sh` 每天把整库落到 /backup：**备份外流 = 四平台密码外流**，威胁模型
 * 不止"攻陷服务进程"。现在密码列改为 AES-256-GCM 应用层加密（credAtRest.ts），
 * 密钥与 `CRED_PRIVATE_KEY_PEM` 同源派生；接口不变 —— password 永不回传前端
 * （只回 `hasPassword`），日志里也不打印。存量明文行在读取时惰性迁移为密文。
 *
 * ## 与 `user_settings` 的关系
 *
 * 账号是「凭据」不是「偏好」，不能塞进 `Settings` JSON 列：那个列被几乎所有接口
 * 读，格式变更会波及全部页面。这里单表存放，删除级联到用户。
 *
 * ## 平台清单
 *
 * | platform | 站点 | 协议 |
 * |---|---|---|
 * | `citel` | citel.bjtu.edu.cn/mlsv3 | Moodle |
 * | `phyvlab` | phyvlab.bjtu.edu.cn | Moodle |
 * | `physicslab` | wlsy.bjtu.edu.cn | ASP.NET WebForms |
 * | `phydemo` | physpace.bjtu.edu.cn:8089/phydemo | 自建 |
 */
import { db, tx } from './db.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from './credAtRest.js'

/** 受支持的独立账号平台 */
export type AccountPlatform = 'citel' | 'phyvlab' | 'physicslab' | 'phydemo'

export const ACCOUNT_PLATFORMS: readonly AccountPlatform[] = ['citel', 'phyvlab', 'physicslab', 'phydemo']

/** 各平台的中文名（错误提示与前端文案共用） */
export const ACCOUNT_PLATFORM_LABEL: Record<AccountPlatform, string> = {
  citel: 'CITEL',
  phyvlab: '物理在线',
  physicslab: '物理实验',
  phydemo: '演示实验'
}

export function isAccountPlatform(v: unknown): v is AccountPlatform {
  return typeof v === 'string' && (ACCOUNT_PLATFORMS as readonly string[]).includes(v)
}

/** 平台名展示用（未知值不抛错，回显原样，避免错误提示吞掉用户输入） */
export function accountPlatformLabel(p: string): string {
  return (ACCOUNT_PLATFORM_LABEL as Record<string, string>)[p] ?? p
}

/**
 * 一条独立账号记录。
 *
 * `hasPassword` 是**唯一**对外可见的密码信息：真正的 `password` 永不出 `db.ts`
 * 与本文件之外（见 `toPublic`）。
 */
export interface IndependentAccount {
  platform: AccountPlatform
  username: string
  hasPassword: boolean
  /** 首次保存时间（本地墙上时间） */
  createdAt: string
  /** 最近一次更新（换账号 / 换密码） */
  updatedAt: string
}

interface AccountRow {
  platform: string
  username: string
  password: string
  created_at: string
  updated_at: string
}

function toPublic(row: AccountRow): IndependentAccount {
  return {
    platform: row.platform as AccountPlatform,
    username: row.username,
    hasPassword: row.password.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 保存（或更新）一个平台的账号。
 *
 * `password` 传空串表示**只换用户名、沿用原密码** —— 这是刻意的：前端换账号时
 * 用户常常只改用户名（同一个人换了学号写法），强制重填密码毫无必要。
 */
export function upsertAccount(
  userId: number,
  platform: AccountPlatform,
  username: string,
  password: string
): IndependentAccount {
  const u = username.trim()
  if (!u) throw new Error('账号不能为空')
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  /* 评审 B1：密码 AES-256-GCM 加密后再落库；空串原样存（SQL 的 CASE 依赖它表达"沿用原密码"） */
  const storedPassword = encryptSecret(password)
  return tx(() => {
    /* 密码传空串时保留旧密码：UPDATE 里用 COALESCE(NULLIF(?, ''), password) */
    db.prepare(
      `INSERT INTO independent_accounts (user_id, platform, username, password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         username = excluded.username,
         password = CASE WHEN excluded.password = '' THEN independent_accounts.password ELSE excluded.password END,
         updated_at = excluded.updated_at`
    ).run(userId, platform, u, storedPassword, stamp, stamp)
    const row = db
      .prepare(`SELECT platform, username, password, created_at, updated_at FROM independent_accounts WHERE user_id = ? AND platform = ?`)
      .get(userId, platform) as unknown as AccountRow
    return toPublic(row)
  })
}

/** 读一条账号（含明文密码，仅供服务端联网调用；不要回传前端） */
export function readAccount(
  userId: number,
  platform: AccountPlatform
): { username: string; password: string } | null {
  const row = db
    .prepare(`SELECT platform, username, password, created_at, updated_at FROM independent_accounts WHERE user_id = ? AND platform = ?`)
    .get(userId, platform) as unknown as AccountRow | undefined
  if (!row) return null
  /* 惰性迁移（评审 B1）：存量明文行读出后顺手加密回写，一轮使用后全库收敛为密文。
     迁移失败（密钥不可用）不影响读出 —— 让登录先走通。 */
  if (row.password && !isEncryptedSecret(row.password)) {
    try {
      const enc = encryptSecret(row.password)
      if (enc) {
        db.prepare(`UPDATE independent_accounts SET password = ? WHERE user_id = ? AND platform = ?`).run(enc, userId, platform)
        row.password = enc
      }
    } catch {
      /* 迁移失败：按明文继续 */
    }
  }
  return { username: row.username, password: decryptSecret(row.password) }
}

/** 列出该用户全部账号（不含密码） */
export function listAccounts(userId: number): IndependentAccount[] {
  const rows = db
    .prepare(`SELECT platform, username, password, created_at, updated_at FROM independent_accounts WHERE user_id = ? ORDER BY platform`)
    .all(userId) as unknown as AccountRow[]
  return rows.map(toPublic)
}

/**
 * 删除一个平台的账号。
 *
 * 刻意**保留**该平台的历史业务数据（如已抓到的实验预约）：用户可能只是想换号，
 * 不想把之前同步到的记录一并清掉。真要清数据走各自的「清除缓存」。
 */
export function deleteAccount(userId: number, platform: AccountPlatform): boolean {
  const r = db.prepare(`DELETE FROM independent_accounts WHERE user_id = ? AND platform = ?`).run(userId, platform)
  return r.changes > 0
}
