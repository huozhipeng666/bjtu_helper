/**
 * 凭据信封加密（应用层）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 站点 2026-10-20 起已备案并签发证书，HTTPS 就绪后传输层不再是明文。
 * 但小程序要走的是学号 + **教务系统密码** —— 这组凭据能登进学生本人的教务账号，
 * 风险等级远高于普通站点密码。传输层之外再叠一层应用层加密的收益是：
 * TLS 终止点（nginx）之后到 Node 之间的那一段、以及任何未来的明文回退路径，
 * 拿到的都只是密文；代理日志、错误上报里的 request 快照同样看不到明文。
 *
 * 所以在传输层之外再叠一层应用层加密：**只加密凭据本身**，其余字段照常传。
 *
 * ── 为什么是 RSA-OAEP + SHA-256，而不是自造的方案 ────────────────
 * 客户端是小程序，**没有任何内置密码学原语**（没有 WebCrypto，没有 crypto.subtle），
 * 所以 RSA 只能在 JS 里实现。既然必须自己写模幂与填充，就必须挑一个
 * 「实现短、可被标准实现逐字节验证」的方案：
 *   - OAEP 是当前推荐的 RSA 填充（PKCS#1 v1.5 有 Bleichenbacher 类历史问题）；
 *   - 公钥以 **JWK 的 n/e** 暴露，客户端只需 base64url → BigInt，**省掉整个 SPKI DER
 *     解析器**（那是最容易写错、又最难发现的一部分）；
 *   - 正确性由 `scripts/test-cred-crypto.mjs` 与 Node 原生 crypto 对拍保证：
 *     同一份小程序 JS 加密 → Node `privateDecrypt` 解密 → 明文必须逐字节一致。
 *
 * ⚠️ 千万不要"优化"掉这个对拍：填充写错的表现是"偶尔登录失败"或"某些密码失败"，
 *    靠人工点页面几乎不可能定位。
 *
 * ── 密钥生命周期 ────────────────────────────────────────────────
 * 默认进程启动时生成一对临时密钥（够用：密钥随进程重启轮换，客户端靠 kid 感知）。
 * 多实例部署 / 希望重启后不失效时，用 CRED_PRIVATE_KEY_PEM 注入固定私钥
 * （PKCS#8 PEM，单行换行用 \n 转义）。**所有实例必须用同一把私钥**，
 * 否则负载均衡到另一台就会解密失败。
 */
import {
  constants, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, privateDecrypt, type KeyObject
} from 'node:crypto'

/** 对外宣告的算法标识。客户端据此选择实现，不允许协商降级 */
export const CRED_ALG = 'RSA-OAEP-256'

/** RSA-2048 + OAEP-SHA256 的明文上限：256 - 2*32 - 2 = 190 字节。密码远小于它 */
const MAX_PLAINTEXT_BYTES = 190
/** 密文固定 256 字节 → base64 344 字符。给点余量，同时挡住超大 body */
export const MAX_CRED_CT_CHARS = 512

/** 凭据类错误一律映射成 400（是客户端请求的问题，不是服务端故障） */
export class CredError extends Error {}

interface CredKey {
  /** 密钥指纹，客户端用它判断是否需要重新取公钥（服务重启换钥后必须重取） */
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
  /** JWK 形式的分量，base64url 无填充 */
  n: string
  e: string
}

let cached: CredKey | null = null

function fingerprint(pub: KeyObject): string {
  const der = pub.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** 惰性初始化：第一次用到时才生成，避免拖慢启动（生成 2048 位密钥约几十毫秒） */
function key(): CredKey {
  if (cached) return cached

  const pem = (process.env.CRED_PRIVATE_KEY_PEM ?? '').trim()
  let privateKey: KeyObject
  if (pem) {
    try {
      // 环境变量里换行常被写成字面量 \n，这里还原，免得运维必须写多行 env
      privateKey = createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem)
    } catch {
      throw new CredError('CRED_PRIVATE_KEY_PEM 不是合法的 PKCS#8 私钥')
    }
  } else {
    /* 生成一对临时密钥。刻意先生成 PEM 再 createPrivateKey 转成 KeyObject：
       generateKeyPairSync 的返回类型**随 encoding 参数变化**（PEM 时是 string，
       DER 时是 Buffer），直接取 .privateKey 拿到的是 string，赋给 KeyObject 编译不过。
       统一走 createPrivateKey 才能与上面"环境变量注入"那条分支得到同一种类型。 */
    privateKey = createPrivateKey(
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      }).privateKey
    )
  }

  const publicKey = createPublicKey(privateKey)
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string }
  if (!jwk.n || !jwk.e) throw new CredError('无法从私钥导出公钥分量')

  cached = { kid: fingerprint(publicKey), privateKey, publicKey, n: jwk.n, e: jwk.e }
  return cached
}

/** 暴露给客户端的公钥信息（**只含公开分量**，私钥永不出进程） */
export function publicKeyInfo(): { kid: string; alg: string; n: string; e: string } {
  const k = key()
  return { kid: k.kid, alg: CRED_ALG, n: k.n, e: k.e }
}

/**
 * 解开客户端信封。
 *
 * 信封形态（小程序 utils/secureCred.js 产出，字段名固定）：
 *   `{ credEnc: { kid: '16位hex', ct: 'base64(RSA-OAEP-SHA256(JSON))' } }`
 * 明文是被加密的 JSON 对象，通常含 username / password / confirmPassword。
 *
 * 返回 null 表示请求里**没有**信封（网页端走明文，向后兼容）；解不开则抛 CredError。
 */
export function openCredEnvelope(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') throw new CredError('凭据信封格式错误')

  const env = raw as Record<string, unknown>
  const ct = typeof env.ct === 'string' ? env.ct : ''
  if (!ct) throw new CredError('凭据信封缺少密文')
  if (ct.length > MAX_CRED_CT_CHARS) throw new CredError('凭据信封过大')
  /* 只做长度/token 校验，不做严格 base64 解码校验 —— 解码失败会在下面统一报"解密失败"，
     多一层校验反而容易把合法变体（带换行、无填充）误杀。 */
  if (!/^[A-Za-z0-9+/=\s]+$/.test(ct)) throw new CredError('凭据密文编码非法')

  const k = key()
  const kid = typeof env.kid === 'string' ? env.kid : ''
  /* kid 不匹配：服务端已轮换密钥，客户端还拿着旧的公钥。
     明确报错（而不是静默失败）—— 客户端侧会据此重新取公钥并重试一次。 */
  if (kid && kid !== k.kid) throw new CredError('CRED_KEY_STALE')

  let plain: Buffer
  try {
    plain = privateDecrypt(
      { key: k.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(ct.replace(/\s+/g, ''), 'base64')
    )
  } catch {
    // 不把底层错误透出去（可能含密钥长度等细节），统一文案
    throw new CredError('凭据解密失败，请重试')
  }
  if (plain.length > MAX_PLAINTEXT_BYTES) throw new CredError('凭据内容过长')

  try {
    const obj = JSON.parse(plain.toString('utf8')) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not object')
    const out: Record<string, string> = {}
    for (const [kk, vv] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof vv === 'string') out[kk] = vv
    }
    return out
  } catch {
    throw new CredError('凭据内容解析失败')
  }
}

/**
 * 取一个凭据字段：**信封优先，其次明文**。
 *
 * 为什么保留明文回退：**滚动升级**期间，用户浏览器里可能还缓存着旧版 web 包的 JS，
 * 它只会发明文；服务端先放开，页面刷新后自然切到密文。另外非安全上下文
 * （http:// 且非 localhost）下浏览器不给 `crypto.subtle`，网页端也只能降级为明文。
 *
 * ⚠️ 2026-10-20 现状：https 已全站可用（443 放行 + 严格态 + HSTS），
 *    线上已设 CRED_REQUIRE_ENCRYPTED=1，明文提交一律 400。
 *    将来若因故障退回 http（`bash deploy/switch-https.sh --transition`），
 *    **必须同时把这个开关关掉**：http 下浏览器不给 crypto.subtle → 前端退回明文 → 全被拒。
 *    正确顺序是「先退 nginx，再关开关，最后重启」，否则中间会有一段登录全 400 的窗口。
 */
export function readCredField(
  body: Record<string, unknown>,
  secret: Record<string, string> | null,
  field: string
): string {
  if (secret && typeof secret[field] === 'string') return secret[field]
  if (process.env.CRED_REQUIRE_ENCRYPTED === '1') {
    /* 这句文案必须能指导用户下一步。线上 2026-10-22 出现过「登录点了没反应」：
       客户端拿不到 crypto.subtle（非 https / 旧缓存页面）→ 静默降级成明文 →
       这里回 400，而前端当时又把错误文案吞掉了。现在把「怎么修」写进提示里。 */
    throw new CredError('当前请求没有携带加密凭据：请用 https:// 打开应用（浏览器在非安全上下文下不提供加密能力），刷新页面后重试')
  }
  const raw = body[field]
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * 启动时打印一次凭据传输策略。**只读环境变量，不碰任何请求**。
 *
 * 为什么需要：`CRED_REQUIRE_ENCRYPTED` 没开时，`readCredField` 会**静默**接受明文，
 * 而日志里对此毫无痕迹 —— 管理员看到"登录一切正常"，完全无法判断此刻学号+教务密码
 * 是不是正以明文经过公网。这是本项目风险最高的一条链路（教务密码可拿去登学校门户），
 * 不能靠"记得看文档"来发现配置漏了。
 *
 * 两档：
 *   - 未开：输出一条 WARN，把当前监听地址带出来，方便判断是否已在 HTTPS 后面；
 *   - 已开：输出一条 INFO 确认强制生效（否则切了 HTTPS 却忘了开，等于白切）。
 */
export function logCredTransportPolicy(listenHint: string): void {
  if (process.env.CRED_REQUIRE_ENCRYPTED === '1') {
    console.log('[cred] 已强制凭据信封：明文提交的教务凭据将被拒绝（400）')
    return
  }
  console.warn(
    '[cred] ⚠️ 允许明文提交教务凭据（CRED_REQUIRE_ENCRYPTED 未开）。' +
      `当前入口：${listenHint}。若它不是 https://，学号与教务密码将以明文经过公网 —— ` +
      '请尽快上 HTTPS，之后再设 CRED_REQUIRE_ENCRYPTED=1 彻底关闭明文回退。'
  )
}
