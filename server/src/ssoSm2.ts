/**
 * 学校统一身份认证（sso.bjtu.edu.cn）的 SM2 密码加密。
 *
 * 为什么需要它：2026-10 学校把统一身份认证换成新版（`/o/authorize/` + `/sso/login`），
 * 登录表单里的 `password` **必须**是 SM2 加密后的密文（页面 `doLogin()` 里
 * `params.password = sm2.encrypt(params.password, config.sm2.publicKey)`）。明文提交会被
 * 服务端当作"账号或密码错误"直接打回，根本走不到验证密码那一步。
 *
 * 为什么直接内嵌学校官方的 `sm2.min.js` 而不是引第三方库：
 *  - 加密结果（C1C3C2 / base64 / 无 `04` 前缀）必须与服务端解密的实现严格一致，
 *    任何一个字节的差异都会让登录永远失败；用学校自己下发的那份脚本，兼容性最好；
 *  - `server/package.json` 不想为了一个函数新增依赖（sm-crypto 之类），也避免
 *    供应链与版本漂移问题。
 *
 * `sm2.min.js` 是 UMD 包，浏览器里挂在 `window.sm2`。这里用 `node:vm` 造一个
 * 最小的类浏览器上下文把它跑起来，取出 `sm2.encrypt` 缓存复用。
 * ⚠️ 它需要 `Buffer` 与 WebCrypto 的 `crypto`，所以要显式注入。
 *
 * 脚本内容是**内联常量**（`./ssoSm2.source.ts`，由 `scripts/gen-sm2-source.mjs` 生成），
 * 不从磁盘读 `.min.js`：服务端发布产物是 esbuild 打的 CJS 单文件，里面没有
 * `import.meta.url`，而开发模式的 tsx 走 ESM 又没有 `__dirname` —— 用内联常量一次
 * 绕开两条路径分支，`dist/index.cjs` 也不再依赖旁边的资源文件。
 */
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { SSO_SM2_SOURCE } from './ssoSm2.source.js'

interface Sm2Like {
  encrypt(plain: string, publicKey: string): string
}

let cached: Sm2Like | null = null

function loadSm2(): Sm2Like {
  if (cached) return cached
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    Buffer,
    crypto: webcrypto,
    module: { exports: {} as unknown },
    exports: {} as unknown,
    define: undefined
  }
  // UMD 会在几处探测这些全局名，缺一个就在初始化阶段抛错
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(SSO_SM2_SOURCE, context, { filename: 'sm2.min.js' })
  const sm2 = (sandbox.sm2 ?? (sandbox.module as { exports?: Sm2Like })?.exports) as Sm2Like | undefined
  if (!sm2 || typeof sm2.encrypt !== 'function') {
    throw new Error('SM2 加密脚本加载失败（sm2.min.js 来源文件结构异常）')
  }
  cached = sm2
  return sm2
}

/**
 * 把明文密码加密成学校 SSO 要求的密文。
 *
 * @param plain 明文密码
 * @param publicKeyBase64 登录页 `ssoConfig.sm2.publicKey` 的原值（Base64，128 字节的裸公钥）
 * @returns Base64 编码的 C1C3C2 密文（无 `04` 前缀）
 */
export function sm2Encrypt(plain: string, publicKeyBase64: string): string {
  if (!plain) throw new Error('SM2 加密：密码为空')
  if (!/^[A-Za-z0-9+/=]{80,200}$/.test(publicKeyBase64)) {
    throw new Error('SM2 加密：公钥格式不正确')
  }
  return loadSm2().encrypt(plain, publicKeyBase64)
}
