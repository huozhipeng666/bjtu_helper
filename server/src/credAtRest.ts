/**
 * 凭据静态加密（评审 B1，2026-10-23）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────
 * 独立平台账号（CITEL / 物理在线 / 物理实验 / 演示实验）的密码此前**明文**进 SQLite：
 * `backup.sh` 每天把整库落到 /backup，备份外流 = 四平台密码外流。
 * 传输层已有 RSA 信封（credCrypto.ts），这里补齐存储层：AES-256-GCM 应用层加密。
 *
 * ── 密钥来源 ────────────────────────────────────────────────────
 *  - 设有 `CRED_PRIVATE_KEY_PEM`（线上标准配置）：从同一把 RSA 私钥**派生**
 *    AES 密钥（SHA-256 分域），不引入第二份要管理的机密 —— 这就是评审说的
 *    「同源密钥」。派生时加盐固定串，与 RSA 的用途隔离。
 *  - 未设（本地/开发，RSA 密钥随进程轮换）：派生密钥会跟着变、重启后解不开，
 *    因此退化为「数据目录下随机密钥文件」（cred-at-rest.key，0600 权限），
 *    保证重启后存量密文仍可解。
 *
 * ── 存储格式 ────────────────────────────────────────────────────
 * `enc:v1:<iv b64>:<tag b64>:<ct b64>`。带版本前缀：老明文行（无前缀）按明文读出、
 * 顺手惰性迁移回写为密文；将来换格式时升 v2 即可。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDirPath } from './db.js'

const PREFIX = 'enc:v1:'
let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey
  const pem = (process.env.CRED_PRIVATE_KEY_PEM ?? '').trim()
  if (pem) {
    cachedKey = createHash('sha256')
      .update('bjtu-helper:cred-at-rest:v1')
      .update(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem)
      .digest()
    return cachedKey
  }
  /* 开发环境兜底：数据目录下 32 字节随机密钥。文件丢了/换机 = 存量密文不可解，
     这是如实语义 —— 密钥本来就不该跟着备份走，否则加密形同虚设。 */
  const keyPath = join(dataDirPath, 'cred-at-rest.key')
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath)
    if (raw.length === 32) {
      cachedKey = raw
      return cachedKey
    }
  }
  const key = randomBytes(32)
  writeFileSync(keyPath, key, { mode: 0o600 })
  cachedKey = key
  return cachedKey
}

/** 加密；空串原样返回（调用方用空串表达「沿用原密码/无密码」）。 */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/**
 * 解密。老明文（无前缀）原样返回 —— 上层可据此做惰性迁移。
 * 解不开（密钥变更/密文损坏）时抛错而不是回空串：回空串会让平台拿空密码去撞登录，
 * 还会把这个失败伪装成「密码错误」。
 */
export function decryptSecret(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('凭据密文格式非法')
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('凭据静态密钥不可用（CRED_PRIVATE_KEY_PEM 已变更或密钥文件丢失），请重新保存该平台账号')
  }
}

/** 是否还是未迁移的明文（供惰性迁移判断） */
export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX)
}
