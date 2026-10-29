/**
 * 安全响应头 / 健康检查载荷 / 监听地址 —— 抽成纯函数，便于回归。
 *
 * 为什么从 index.ts 里抽出来：
 *   这三样东西的共同点是「配错了不会报错，只会安静地少一层防护」：
 *   - 安全头只在浏览器里生效，服务端日志和 curl 200 都看不出它没发；
 *   - 健康检查多吐几个字段，等于给扫描器免费提供版本号与负载量级；
 *   - 监听地址默认值一改，3001 就从「只对本机 nginx 开门」变成「对整个内网开门」。
 *   放在纯函数里，`scripts/test-security-headers.mts` 才能逐条钉住这些性质。
 */
import { timingSafeEqual } from 'node:crypto'

/**
 * CSP 的固定部分。
 *
 * - `script-src` 是唯一"动态"的一项：/theme-init.js 会被内联进 /app 的 HTML，
 *   内联脚本必须靠 sha256 放行（由 buildSecurityHeaders 拼进来）。
 * - `style-src 'unsafe-inline'`：前端有大量 `style={{}}` 内联样式（进度条、主题色），
 *   必须放开否则样式全丢。内联样式的注入危害远小于脚本，可接受。
 * - `img-src 'self' data: blob:`：头像存 data URL、论坛图片走本域 /uploads/、预览用 blob。
 * - `connect-src 'self'`：API 全部同源；开发环境页面由 Vite 托管，不受本头约束。
 * - `worker-src` / `manifest-src`：PWA 用。找不到专属指令时会回落到 default-src，
 *   显式写出来是为了让"允许 SW"在配置里一眼可见。
 * - 无第三方域（已核实无 @import / CDN / 外部字体），所以 default-src 可直接锁 'self'。
 * - HSTS **不在这里下发**：由 nginx 的 443 server 块负责（deploy/nginx-server.conf）。
 *   放在应用层的话 HTTP 响应也会带上，而浏览器忽略非 HTTPS 响应里的 HSTS ——
 *   白发一趟，还容易让人误判"已经生效了"。
 */
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
]

/**
 * 权限策略：把所有本应用用不到的强能力显式关掉。
 *
 * 为什么值得单独发一个头：`Permissions-Policy` 是**浏览器侧的兜底**。
 * CSP 管的是"能加载什么脚本"，管不了"页面里某个第三方脚本/扩展/未来某个新组件
 * 突然要求摄像头"。把不用的能力写成 `=()` 之后，即使真有代码去要，浏览器也直接拒，
 * 而且这个拒绝发生在用户看到权限弹窗之前。
 *
 * 逐项依据（都已核对源码，不是拍脑袋关的）：
 * - `camera=(self)`：唯一相关用法是 `web/src/components/CoursePhotoImport.tsx` 的
 *   `<input capture="environment">`，它**不受 Permissions-Policy 约束**（走的是文件选择器）。
 *   这里仍给 `(self)` 而不是 `()`，是为了将来真要改用 getUserMedia 拍课表时不用再改响应头。
 * - `microphone=()`：全项目零 `getUserMedia`，语音输入走的是系统输入法，与页面无关。
 * - `geolocation=()`：课表/教室都不需要定位。
 * - `payment=()` / `usb=()` / `serial=()` / `midi=()` / `hid=()`：零使用。
 * - `accelerometer/gyroscope/magnetometer=()`：**刻意关掉**。这三项若开着，
 *   页面就能读到设备姿态，配合时间可做指纹；本项目所有动效都基于鼠标/滚动位置，
 *   不依赖传感器（已 grep 确认无 `deviceorientation`/`devicemotion`）。
 * - `interest-cohort=()` 与 `browsing-topics=()`：前者是旧版 FLoC，后者是 Topics API，
 *   都属于"把本站访客归入广告兴趣分组"，校园工具没有理由参与。
 * - `display-capture=()` / `encrypted-media=()` / `idle-detection=()`：
 *   录屏、DRM、空闲检测，均无使用。
 * - `fullscreen=(self)`：移动端课表全屏查看是合理需求，保留同源。
 */
const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'midi=()',
  'accelerometer=()',
  'gyroscope=()',
  'magnetometer=()',
  'display-capture=()',
  'encrypted-media=()',
  'idle-detection=()',
  'interest-cohort=()',
  'browsing-topics=()',
  'fullscreen=(self)'
].join(', ')

/**
 * 组装全套安全头。`themeInitHash` 为 null 时（文件不存在/读不到）只给 `'self'`，
 * 与 index.ts 里"要不要内联 theme-init"由同一个判据驱动，不会出现"内联了但没放行"。
 */
export function buildSecurityHeaders(themeInitHash: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': CSP.concat([
      `script-src 'self'${themeInitHash ? ` '${themeInitHash}'` : ''}`
    ]).join('; '),
    /* 阻止浏览器把 JSON/图片嗅探成可执行脚本 */
    'X-Content-Type-Options': 'nosniff',
    /* 跨站跳转不泄露完整 URL，只给来源域 */
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    /* 防点击劫持（与 CSP frame-ancestors 互为冗余，照顾老浏览器） */
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': PERMISSIONS_POLICY,
    /* COOP：把本站的 window 引用彻底隔离。没有它，跨站页面拿到本站 window 后
       仍可能通过 window.opener 做导航劫持；本站不用弹窗登录，隔离零成本。 */
    'Cross-Origin-Opener-Policy': 'same-origin',
    /* CORP：本站资源（尤其是 /uploads 里的用户图片）不允许被别的站点当子资源加载，
       挡住"第三方页面用 <img>/<script src=本站> 做旁路探测与热链"。 */
    'Cross-Origin-Resource-Policy': 'same-origin'
  }
  return headers
}

/** 健康检查里的完整载荷（内部/运维视角） */
export interface HealthPayload {
  ok: boolean
  reason?: string
  version?: string
  uptimeSec?: number
  db?: string
  sessions?: number
  rssMb?: number
  mail?: { configured: boolean }
}

/**
 * 按调用者身份裁剪健康检查载荷。
 *
 * 匿名访客只该知道「服务活着没 + 库通不通 + 邮件配了没」—— 这三项是**探活与部署脚本
 * 真正依赖的**（`deploy/publish.ps1` grep `"ok":true`、`scripts/smoke.mjs` 断言 `ok`）。
 *
 * 被裁掉的四项及其泄露价值：
 * - `version`：直接对上「这一版有没有已知漏洞」，省掉扫描器的猜测；
 * - `uptimeSec`：能推断"是不是刚重启过 / 什么时候打补丁"，也能配合会话数算上线节奏；
 * - `sessions`：等于告诉对方"现在有多少活跃用户"，是选时机的依据；
 * - `rssMb`：内存占用，配合反复触发大请求可用来估"打多大能把进程打挂"。
 * 这四项对匿名者毫无用处，对运维排障却有用 —— 所以不是删掉，而是**要求带运维令牌**。
 */
export function publicHealthPayload(full: HealthPayload, detailed: boolean): HealthPayload {
  const base: HealthPayload = {
    ok: full.ok,
    /* reason 只在降级时存在；用展开而不是赋值，避免未降级时多出一个 `"reason":undefined`
       的键（JSON.stringify 会把它整个丢掉，但对象的形状会不同，测试也不好写） */
    ...(full.reason ? { reason: full.reason } : {}),
    ...(full.db ? { db: full.db } : {}),
    ...(full.mail ? { mail: full.mail } : {})
  }
  if (!detailed) return base
  return {
    ...base,
    version: full.version,
    uptimeSec: full.uptimeSec,
    sessions: full.sessions,
    rssMb: full.rssMb
  }
}

/**
 * 健康检查详情是否可见 —— 判定逻辑抽成纯函数，方便逐条回归。
 *
 * 两档，按是否配置了 `HEALTH_DETAIL_TOKEN` 分：
 *
 *  ① **配了令牌**：只认令牌，连本机也不例外。令牌比较走定长比较（长度先比，
 *     因为 timingSafeEqual 长度不等会抛；长度本身不算秘密）。
 *     空令牌永远不放行 —— "未设置就默认空串相等"是令牌校验里最常见的后门。
 *
 *  ② **没配令牌**：只放行「本机直连且不带任何转发头」的调试请求。
 *     为什么必须同时要求"无转发头"：nginx 在 `deploy/nginx-server.conf` 里会用
 *     `proxy_set_header X-Forwarded-For $remote_addr` **覆盖**而不是追加，所以正常
 *     反代流量一定带 XFF。于是"带 XFF"本身就是"这个请求是从反代进来的"的铁证 ——
 *     哪怕哪天有人把覆盖改回追加、或者干脆漏配了 proxy_set_header，
 *     这条判据也不会被伪造的 `X-Forwarded-For: 127.0.0.1` 骗过去。
 *     只看 `req.ip` 是不够的：`trust proxy` 一旦被设成数字，`req.ip` 就由请求头决定。
 */
export function healthDetailAllowed(input: {
  /** 环境变量 HEALTH_DETAIL_TOKEN 的当前值（可能为空） */
  token: string
  /** 请求头 x-health-token 的值 */
  provided: string
  /** 是否是 `?detail=1` 之类显式请求 */
  wantDetail: boolean
  /** TCP 层的对端地址（req.socket.remoteAddress），不受 trust proxy 影响 */
  peer: string
  /** 请求是否带有任何转发头（XFF / X-Real-IP / Forwarded） */
  hasForwardedHeader: boolean
}): boolean {
  const token = input.token ?? ''
  if (token) {
    const provided = input.provided ?? ''
    if (!provided) return false
    const a = Buffer.from(token)
    const b = Buffer.from(provided)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  if (!input.wantDetail) return false
  if (input.hasForwardedHeader) return false
  const peer = input.peer ?? ''
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
}

/**
 * 监听地址：**默认只开环回**。
 *
 * 之前是 `app.listen(PORT)`，Node 会绑到 `::`/`0.0.0.0`，也就是整个内网可达。
 * 线上之所以没出事，是因为阿里云安全组恰好没放行 3001 —— 边界只剩**一层云配置**，
 * 而安全组是那种"配一次就再没人看过"的东西。真正的边界应当由进程自己守住：
 * 对外统一走 nginx（80/443），node 只跟本机 nginx 说话。
 *
 * 需要把 node 直接暴露出去的场景（Docker 里另有反代、单机不带 nginx 调试）
 * 显式设 `HOST=0.0.0.0` 即可。
 *
 * 为什么会拒绝无法识别的值：写错成 `HOST=localhost`/`HOST=example.com` 时，
 * 与其让 Node 在 bind 阶段抛错（生产上表现为服务起不来），不如**回落到环回**并打日志 ——
 * 后者最坏是"外部访问不通"，前者最坏是"整个站点挂掉"，两害相权取其轻。
 */
export function resolveListenHost(raw: string | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return '127.0.0.1'
  /* 只接受 IPv4 字面量、IPv6 字面量与 0.0.0.0/:: 这类通配地址。
     用"是否像 IP 字面量"而不是"是否合法 host"来判，避免把域名交给 bind。 */
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(v)
  const isIPv6 = /^[0-9a-fA-F:]+$/.test(v) && v.includes(':')
  if (isIPv4 || isIPv6) return v
  return '127.0.0.1'
}
