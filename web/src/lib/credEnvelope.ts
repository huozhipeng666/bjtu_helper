/**
 * 凭据信封加密（网页端）。
 *
 * ── 为什么网页端也需要它 ──────────────────────────────────────────
 * 服务端早就实现了 RSA-OAEP-256 信封（server/src/credCrypto.ts），但一直只有小程序在用；
 * 网页端提交的是**明文**学号 + 教务密码。而这组凭据能直接登进学生本人的教务账号，
 * 泄露的后果是成绩单、课表、培养方案全部被看，甚至被拿来冒名办事。
 *
 * 为什么不能指望 HTTPS 就够了：
 *   · TLS 只保护"浏览器到 nginx"这一段，nginx 之后到 Node 是明文；
 *   · 即便切了 HTTPS，密文也不会出现在浏览器 DevTools 的 Network 面板、代理日志、
 *     或前端错误上报的 request 快照里。
 * 多这一层几乎没有成本（浏览器原生 WebCrypto，2048 位 OAEP 一次约 1ms）。
 *
 * ── 与小程序实现的关系 ────────────────────────────────────────────
 * 协议完全相同：`{ credEnc: { kid, ct } }`，ct = base64(RSA-OAEP-SHA256(JSON 明文))。
 * 区别只在实现手段：小程序没有 WebCrypto，只能自己写 JS 模幂；网页端直接用标准 API。
 * 因此同一份服务端解密逻辑可以服务两端，`scripts/test-cred-crypto.mjs` 的对拍仍然成立。
 *
 * ── 失败策略：降级，而不是阻断 ────────────────────────────────────
 * 只要取公钥或加密失败（老浏览器没有 crypto.subtle、公钥端点 5xx、HTTP 环境被判定为非安全上下文
 * 因而 crypto.subtle 为 undefined），就**退回明文提交** —— 与此前行为完全一致。
 * 理由：这一层是"锦上添花"，绝不能因为它在某些浏览器上不可用就让用户登不进教务。
 * 若运维要求强制加密，服务端设 CRED_REQUIRE_ENCRYPTED=1 后明文通道会被拒绝，
 * 那种情况下失败会变成一次明确的报错，而不是静默降级。
 * ⚠️ 注意：`crypto.subtle` 只在**安全上下文**（HTTPS 或 localhost）可用。
 *    2026-10-20 起站点已全站 HTTPS（严格态 + HSTS）并设了 CRED_REQUIRE_ENCRYPTED=1，
 *    所以正常路径上这条明文降级**已经走不到了** —— 一旦触发，服务端会明确回 400。
 *    唯一还会走到它的场景是"站点临时退回 http 救急"（switch-https.sh --transition），
 *    那时必须同时关掉服务端的开关，否则网页端登录会整体失败。
 *
 * ── 服务端换钥时的自动重试 ────────────────────────────────────────
 * 服务端默认每次重启**重新生成**密钥，`kid` 会变。本模块把公钥缓存在内存里
 * （`cachedKey` / `cachedKid`），所以服务重启后已打开的页面拿的还是旧公钥。
 * 服务端比对 kid 后抛 `CRED_KEY_STALE`，由 `web/src/api.ts` 的 `sendWithCredRetry`
 * 调 `resetCredKeyCache()` 并**重新加密**重试一次。本文件只负责提供那个重置钩子。
 */

/** 服务端 /api/crypto/key 的响应形状（与 credCrypto.ts 的 publicKeyInfo 对应） */
interface CredKeyInfo {
  kid: string;
  alg: string;
  n: string; // base64url，无填充
  e: string; // base64url，无填充
}

/** 对外协议标识，必须与服务端 CRED_ALG 一致；不一致就不加密（宁可降级也不发错格式） */
const CRED_ALG = 'RSA-OAEP-256';

/** 公钥缓存：带 kid 失效判断，服务重启换钥后自动重取 */
let cachedKey: Promise<CryptoKey> | null = null;
let cachedKid = '';

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  /* 分块避免 apply 参数过多（大数组会栈溢出；密文只有 256 字节，这里只是稳妥写法） */
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 取公钥并导入成 CryptoKey。整个进程内只请求一次（除非 kid 变化）。 */
function loadKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  cachedKey = (async () => {
    /* 直接用 fetch 而不是 api.ts 的 request()：request() 会附加 Authorization 头，
       而公钥端点是匿名的，且它自己依赖 api.ts —— 这里保持零依赖，避免循环引用。 */
    const res = await fetch('/api/crypto/key', { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`取加密公钥失败（HTTP ${res.status}）`);
    const info = (await res.json()) as CredKeyInfo;
    if (info.alg !== CRED_ALG) throw new Error(`不支持的加密算法：${info.alg}`);
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: info.n, e: info.e, alg: 'RSA-OAEP-256', ext: true },
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
    cachedKid = info.kid;
    return key;
  })();
  /* 失败不缓存：下次调用重试，避免一次网络抖动就让本页面永久降级成明文 */
  cachedKey.catch(() => {
    cachedKey = null;
  });
  return cachedKey;
}

/**
 * 把凭据字段加密成信封；成功返回 `{ credEnc }`，任何失败都返回 `{}`（调用方照常发明文）。
 *
 * @param fields 需要加密的字段，通常 `{ username, password }` 或再加 `confirmPassword`
 */
export async function encryptCred(
  fields: Record<string, string>
): Promise<{ credEnc?: { kid: string; ct: string } }> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return {};
    const key = await loadKey();
    const plain = new TextEncoder().encode(JSON.stringify(fields));
    /* RSA-2048 + OAEP-SHA256 的明文上限是 190 字节；学号+密码远小于它，
       但仍显式判一下，免得将来加了长字段后在运行时抛一个难懂的 DOMException。 */
    if (plain.length > 190) return {};
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, plain);
    return { credEnc: { kid: cachedKid, ct: bytesToB64(new Uint8Array(ct)) } };
  } catch {
    return {};
  }
}

/** 供 api.ts 的换钥重试使用（服务端抛 CRED_KEY_STALE 时清缓存并重新加密） */
export function resetCredKeyCache(): void {
  cachedKey = null;
  cachedKid = '';
}
