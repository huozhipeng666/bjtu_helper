/**
 * 极简 SMTP 客户端（零依赖）。
 *
 * 为什么不用 nodemailer：
 *   本项目用 esbuild 把服务端打成**自包含单文件**（server/dist/index.cjs），
 *   服务器上只有 node 可执行文件 + dist，没有 node_modules。
 *   引 nodemailer 意味着部署链路要额外装依赖、打包要标 external，
 *   为了"发一封纯文本通知"付出这个代价不划算。
 *   与内置 node:sqlite 取代 better-sqlite3 是同一个取舍。
 *
 * 覆盖范围（刻意收窄）：
 *   - 465 implicit TLS，或 587/25 STARTTLS 升级
 *   - AUTH LOGIN / AUTH PLAIN 两种认证（覆盖 QQ/163/阿里云/Gmail/企业邮 等主流）
 *   - multipart/alternative 的纯文本 + HTML 正文，全程 base64（天然规避 dot-stuffing 与 UTF-8 编码问题）
 * 不支持：附件、DKIM 签名、OAuth2 认证（XOAUTH2）、SMTP 代理。
 *   这些都不是"反馈通知"这个场景需要的能力，真需要时应换用成熟的邮件服务 SDK。
 *
 * 配置缺失时的行为：**静默跳过、绝不抛错**。
 *   发信是反馈流程的**附加**动作，不是主流程。邮件发不出去不该让用户提交反馈失败 ——
 *   工单已经落库、管理员在后台看得到，邮件只是"提醒他快点看"。因此所有发信失败都只记日志。
 *
 * 配置（全部走环境变量，凭据不入库、不进 git、不写进代码）：
 *   SMTP_HOST            必填。smtp.qq.com / smtp.163.com / smtp.exmail.qq.com ...
 *   SMTP_PORT            选填，默认 465（SMTP_SECURE=0 时默认 587）
 *   SMTP_SECURE          选填，'1'/'true' = 465 直连 TLS；否则走 STARTTLS
 *   SMTP_USER            选填。留空则跳过 AUTH（仅适用于内网中继）
 *   SMTP_PASS            选填。QQ/163 等需要的是**授权码**，不是登录密码
 *   SMTP_FROM            选填。默认取 SMTP_USER；部分服务商要求发件人 = 认证账号，不要乱改
 *   ADMIN_NOTIFY_EMAIL   必填（否则视为未配置）。管理员收件箱，多个用逗号分隔
 */

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { hostname } from 'node:os'

export interface SmtpConfig {
  host: string
  port: number
  /** true = 465 隐式 TLS（连上即加密）；false = 明文连接后用 STARTTLS 升级 */
  secure: boolean
  user: string
  pass: string
  from: string
  /** 管理员收件人（已拆分、去空、去重） */
  admins: string[]
}

export interface SendResult {
  sent: boolean
  /** 未发送的原因（未配置 / 出错），仅用于日志与调试，不暴露给终端用户 */
  reason?: string
}

/** 整体超时：SMTP 交互是一串往返，任何一步卡住都不该拖住请求线程 */
const TIMEOUT_MS = 12_000
/** 单封邮件大小上限：反馈正文有 5000 字限制，加 HTML 包装远不到这个量级，纯属防御 */
const MAX_BODY_BYTES = 512 * 1024

let cachedConfig: SmtpConfig | null | undefined

/**
 * 读取并校验配置。结果缓存（进程内不变），避免每次发信都重新解析。
 * 返回 null = 未配置完整，调用方应跳过发信。
 */
export function readSmtpConfig(): SmtpConfig | null {
  if (cachedConfig !== undefined) return cachedConfig

  const host = (process.env.SMTP_HOST ?? '').trim()
  const adminsRaw = (process.env.ADMIN_NOTIFY_EMAIL ?? '').trim()
  if (!host || !adminsRaw) {
    cachedConfig = null
    return null
  }

  const secure = /^(1|true|yes)$/i.test((process.env.SMTP_SECURE ?? '').trim())
  const portRaw = Number.parseInt((process.env.SMTP_PORT ?? '').trim(), 10)
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : secure ? 465 : 587

  const user = (process.env.SMTP_USER ?? '').trim()
  const pass = process.env.SMTP_PASS ?? ''
  const from = (process.env.SMTP_FROM ?? '').trim() || user
  if (!from) {
    // 有 host 和收件人但没有发件人：无法构造 MAIL FROM，按未配置处理
    cachedConfig = null
    return null
  }

  const admins = Array.from(
    new Set(
      adminsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  )
  if (admins.length === 0) {
    cachedConfig = null
    return null
  }

  cachedConfig = { host, port, secure, user, pass, from, admins }
  return cachedConfig
}

export function isMailConfigured(): boolean {
  return readSmtpConfig() !== null
}

/** 配置摘要，用于 /api/health 暴露"邮件通道是否就绪"（不含任何凭据） */
export function mailStatus(): { configured: boolean; host: string | null; port: number | null; recipients: number } {
  const c = readSmtpConfig()
  if (!c) return { configured: false, host: null, port: null, recipients: 0 }
  return { configured: true, host: c.host, port: c.port, recipients: c.admins.length }
}

/* ---------------- 编码工具 ---------------- */

/** 非 ASCII 的 header 值必须用 RFC 2047 编码字，否则中文主题会变乱码 */
function encodeHeaderValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

/** base64 正文按 76 字符折行（RFC 2045 要求，部分服务商不折行会拒收） */
function base64Body(s: string): string {
  const b64 = Buffer.from(s, 'utf8').toString('base64')
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ---------------- SMTP 会话 ---------------- */

interface SmtpReply {
  code: number
  /** 全部响应行（含续行），便于把服务端报错原样带进日志 */
  lines: string[]
}

/**
 * 一行式 SMTP 应答读取器。
 * 多行应答形如 `250-XXX` 续行 + `250 YYY` 结束行 —— 只有 **空格分隔** 的那行代表结束。
 * 用 `-` 判断结束是常见错误：EHLO 的多行能力列表最后一行也是空格分隔，
 * 但中间行用 `-`，两者混淆会把中间行当成完整应答，导致后续命令错位。
 */
class SmtpSession {
  private sock: Socket | TLSSocket
  private buf = ''
  private closed = false
  private err: Error | null = null
  private onReply: ((r: SmtpReply) => void) | null = null
  private onError: ((e: Error) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** STARTTLS 升级时用作 SNI / 证书校验的主机名 */
  private readonly sni: string

  constructor(sock: Socket | TLSSocket, sni: string) {
    this.sock = sock
    this.sni = sni
    this.attach(sock)
  }

  private attach(sock: Socket | TLSSocket) {
    // 连接阶段挂的兜底 error 监听已完成使命，先摘掉，避免同一次错误被两处处理
    sock.removeAllListeners('error')
    sock.removeAllListeners('close')
    sock.removeAllListeners('data')
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      this.buf += chunk
      this.tryResolve()
    })
    sock.on('error', (e: Error) => this.fail(e))
    sock.on('close', () => {
      this.closed = true
      this.fail(new Error('SMTP 连接被对端关闭'))
    })
  }

  private tryResolve() {
    if (!this.onReply) return
    // 找到第一条「空格分隔」的结束行；其前的所有行都属于同一条应答
    const lines = this.buf.split('\r\n')
    // 最后一段可能是半行（还没收到 \r\n），先留在缓冲里
    const tail = lines.pop() ?? ''
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\d{3})([ -])(.*)$/.exec(lines[i])
      if (!m) continue
      if (m[2] !== ' ') continue
      const replyLines = lines.slice(0, i + 1)
      const rest = lines.slice(i + 1)
      this.buf = rest.length > 0 ? rest.join('\r\n') + '\r\n' + tail : tail
      const cb = this.onReply
      this.onReply = null
      this.onError = null
      this.clearTimer()
      cb({ code: Number(m[1]), lines: replyLines })
      return
    }
    // 未收全：还原缓冲（把 tail 拼回去）
    this.buf = lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '') + tail
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private fail(e: Error) {
    const cb = this.onError
    this.onReply = null
    this.onError = null
    this.clearTimer()
    // 只记住第一个错误：'close' 事件总会在 'error' 之后补一个"连接被关闭"，
    // 覆盖掉它会把真正的原因（认证失败 / 证书错误）冲掉。
    if (!this.err) this.err = e
    cb?.(this.err)
  }

  /** 等待下一条应答（整体超时兜底） */
  read(): Promise<SmtpReply> {
    if (this.err) return Promise.reject(this.err)
    return new Promise<SmtpReply>((resolve, reject) => {
      this.onReply = resolve
      this.onError = reject
      this.timer = setTimeout(() => {
        this.fail(new Error('SMTP 应答超时'))
        this.sock.destroy()
      }, TIMEOUT_MS)
      // 数据可能已经先到（在 attach 后、read 前），补一次解析
      this.tryResolve()
    })
  }

  /** 发一条命令，自动补 CRLF */
  write(line: string): void {
    this.sock.write(line + '\r\n')
  }

  /** 升级为 TLS（STARTTLS）并替换底层 socket */
  async upgrade(): Promise<void> {
    const plain = this.sock
    plain.removeAllListeners('data')
    plain.removeAllListeners('error')
    plain.removeAllListeners('close')
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const t = tlsConnect({ socket: plain, servername: this.sni }, () => resolve(t))
      t.once('error', reject)
    })
    this.sock = secure
    this.buf = ''
    this.closed = false
    this.err = null
    this.attach(secure)
  }
  destroy() {
    this.sock.destroy()
  }
}

/** 建立连接（465 直连 TLS / 其它走明文 + STARTTLS） */
function openSocket(cfg: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(new Error(`连接 SMTP 服务器失败：${e.message}`))
    const guard = (s: Socket | TLSSocket) => {
      // 连接阶段的兜底超时；连上后立刻撤掉，避免与 SmtpSession 的应答超时重复计时
      s.setTimeout(TIMEOUT_MS, () => {
        s.destroy()
        reject(new Error('连接 SMTP 服务器超时'))
      })
      s.once('error', onErr)
      return s
    }
    if (cfg.secure) {
      const s = guard(tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => {
        s.setTimeout(0)
        resolve(s)
      }))
    } else {
      const s = guard(netConnect({ host: cfg.host, port: cfg.port }, () => {
        s.setTimeout(0)
        resolve(s)
      }))
    }
  })
}

/** 断言应答码；失败时把服务端原文带出来，便于排查认证/权限问题 */
function expect(r: SmtpReply, codes: number[], stage: string) {
  if (!codes.includes(r.code)) {
    const detail = r.lines.join(' | ').slice(0, 300)
    throw new Error(`${stage} 失败（${r.code}）：${detail}`)
  }
}

/** 构造 MIME 报文（headers + body），返回可整段 DATA 发送的字符串 */
function buildMessage(opts: {
  from: string
  to: string[]
  subject: string
  text: string
  html?: string
}): string {
  const boundary = `----bjtu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const headers: string[] = []
  headers.push(`From: ${encodeHeaderValue('北交大助手')} <${opts.from}>`)
  headers.push(`To: ${opts.to.join(', ')}`)
  headers.push(`Subject: ${encodeHeaderValue(opts.subject)}`)
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push(`Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@bjtu-helper>`)
  headers.push('MIME-Version: 1.0')

  let body: string
  if (opts.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(opts.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(opts.html),
      `--${boundary}--`,
      ''
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8')
    headers.push('Content-Transfer-Encoding: base64')
    body = base64Body(opts.text) + '\r\n'
  }
  return headers.join('\r\n') + '\r\n\r\n' + body
}

/**
 * 发送一封邮件。**任何失败都只返回 {sent:false}，不抛异常**（见文件头说明）。
 */
export async function sendMail(opts: {
  to: string[]
  subject: string
  text: string
  html?: string
}): Promise<SendResult> {
  const cfg = readSmtpConfig()
  if (!cfg) return { sent: false, reason: 'SMTP 未配置' }

  const recipients = opts.to.filter((t) => t.trim().length > 0)
  if (recipients.length === 0) return { sent: false, reason: '没有收件人' }

  let session: SmtpSession | null = null
  try {
    const message = buildMessage({
      from: cfg.from,
      to: recipients,
      subject: opts.subject,
      text: opts.text,
      html: opts.html
    })
    if (Buffer.byteLength(message, 'utf8') > MAX_BODY_BYTES) {
      return { sent: false, reason: '邮件内容过大' }
    }

    const sock = await openSocket(cfg)
    session = new SmtpSession(sock, cfg.host)

    expect(await session.read(), [220], '服务端握手')

    // EHLO 必须带一个合法域名（用本机 hostname），部分服务商不接受空参数
    let ehloHost = 'bjtu-helper'
    try {
      ehloHost = hostname() || ehloHost
    } catch {
      /* 取不到 hostname 就用默认值 */
    }
    session.write(`EHLO ${ehloHost}`)
    let ehlo = await session.read()
    expect(ehlo, [250], 'EHLO')

    if (!cfg.secure) {
      const caps = ehlo.lines.join('\n').toUpperCase()
      if (!caps.includes('STARTTLS')) {
        throw new Error('服务端未提供 STARTTLS，且未启用 SMTP_SECURE 直连 TLS')
      }
      session.write('STARTTLS')
      expect(await session.read(), [220], 'STARTTLS')
      await session.upgrade()
      session.write(`EHLO ${ehloHost}`)
      ehlo = await session.read()
      expect(ehlo, [250], 'EHLO(TLS)')
    }

    if (cfg.user) {
      // 优先 AUTH PLAIN（一次往返），服务端不支持时退回 AUTH LOGIN（两次往返）
      const caps = ehlo.lines.join('\n').toUpperCase()
      if (caps.includes('AUTH') && /PLAIN/.test(caps)) {
        const token = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, 'utf8').toString('base64')
        session.write(`AUTH PLAIN ${token}`)
        expect(await session.read(), [235], '认证')
      } else {
        session.write('AUTH LOGIN')
        expect(await session.read(), [334], '认证(LOGIN)')
        session.write(Buffer.from(cfg.user, 'utf8').toString('base64'))
        expect(await session.read(), [334], '认证(用户名)')
        session.write(Buffer.from(cfg.pass, 'utf8').toString('base64'))
        expect(await session.read(), [235], '认证(密码)')
      }
    }

    session.write(`MAIL FROM:<${cfg.from}>`)
    expect(await session.read(), [250], 'MAIL FROM')

    for (const rcpt of recipients) {
      session.write(`RCPT TO:<${rcpt}>`)
      const r = await session.read()
      // 单个收件人被拒（如地址不存在）不应中断整封：记录后继续
      if (r.code !== 250 && r.code !== 251) {
        console.warn(`[smtp] RCPT TO ${rcpt} 被拒（${r.code}）：${r.lines.join(' | ')}`)
      }
    }

    session.write('DATA')
    expect(await session.read(), [354], 'DATA')

    // 正文全程 base64，不会出现以 "." 开头的行，无需 dot-stuffing；
    // 结束标记必须是 CRLF.CRLF，紧跟在正文最后一行的 CRLF 之后。
    const payload = message.endsWith('\r\n') ? message : message + '\r\n'
    session.write(payload + '.')
    expect(await session.read(), [250], '邮件投递')

    session.write('QUIT')
    // QUIT 的 221 应答不强制等待：部分服务端直接断连，等它会白等到超时
    session.destroy()
    return { sent: true }
  } catch (e) {
    session?.destroy()
    const reason = e instanceof Error ? e.message : String(e)
    console.warn(`[smtp] 发送失败：${reason}`)
    return { sent: false, reason }
  }
}
