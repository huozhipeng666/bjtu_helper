/**
 * 校园邮箱（Coremail 通道：读 + 写信/回复/发送）。
 *
 * 移植自参考仓库 `BJTUselfService-KMP-Refreshed` 的
 * `MailboxRemoteDataSource` / `MailboxJsonParser`（Kotlin Multiplatform）——
 * 接口路径与字段均由该仓库以浏览器 DevTools 取证过。
 *
 * 链路（全部在 MIS 会话的 cookie jar 内完成）：
 *   ① GET  https://mis.bjtu.edu.cn/module/module/26/
 *         → 302 落到 mail.bjtu.edu.cn/…?sid=<会话 id>，捕获该 sid
 *   ② POST https://mail.bjtu.edu.cn/coremail/s/json?sid=&func=mbox:listMessages
 *         （text/x-json，body 为 JSON；收件箱 fid=1）
 *   ③ POST https://mail.bjtu.edu.cn/coremail/XT/jsp/readMessage.jsp（form，mid=…）
 *   ④ GET  https://mail.bjtu.edu.cn/coremail/mbox-data?…（附件，302 后为文件本体）
 *   ⑤ POST .../coremail/XT/jsp/compose.jsp?sid=（建草稿，normal / reply）
 *   ⑥ POST .../coremail/s/json?func=mbox:compose（action=deliver 真正投递）
 *
 * ⚠️ 会话在「邮箱」页停留期间**复用**（列表 → 详情 → 附件靠同一个 sid）：
 *   每次操作都重登一次在体验上不可接受；销毁由前端离开页面时触发
 *   （DELETE /api/mis/session），服务端 TTL 兜底。
 *
 * ⚠️ 写操作（写信/发送）2026-10-20 才加：投递不可撤销，服务端会再校验一遍
 *   地址与长度（见 normalizeComposeInput），不把前端校验当安全边界。
 */
import { getMisSession, jarFetch, MisError, onMisSessionDestroyed, type CookieJar } from './mis.js'
import { ComposeInputError, composeHtml, normalizeComposeInput as normalizeRaw } from './mailCompose.js'

export { composeHtml, parseRecipients } from './mailCompose.js'

const MIS_MAILBOX_ENTRY_URL = 'https://mis.bjtu.edu.cn/module/module/26/'
const COREMAIL_ORIGIN = 'https://mail.bjtu.edu.cn'
const COREMAIL_HOST = 'mail.bjtu.edu.cn'
const COREMAIL_JSON_PATH = '/coremail/s/json'
const COREMAIL_READ_MESSAGE_URL = `${COREMAIL_ORIGIN}/coremail/XT/jsp/readMessage.jsp`
const COREMAIL_COMPOSE_URL = `${COREMAIL_ORIGIN}/coremail/XT/jsp/compose.jsp`
const COREMAIL_INDEX_URL = `${COREMAIL_ORIGIN}/coremail/XT/index.jsp`
const COREMAIL_ATTACHMENT_PATH = '/coremail/mbox-data'

/** 收件箱（Coremail 标准文件夹 id） */
const INBOX_FID = 1
const MAX_LIMIT = 50

/** MIS sid → Coremail sid 的缓存（同一次「邮箱」页访问内复用） */
const coremailSids = new Map<string, string>()

/* 评审 B5（2026-10-23）：MIS 会话被 TTL/LRU 清理或显式销毁时，这里缓存的
   Coremail sid 已经没有宿主会话，永久残留是内存泄漏。注册 mis.ts 的销毁钩子联动清理
   （钩子机制就是为了避免 mis → mailbox 的循环依赖）。 */
onMisSessionDestroyed((sid) => coremailSids.delete(sid))

export interface MailSummary {
  id: string
  sender: string
  subject: string
  preview: string
  sentAt: string
  sizeBytes: number
  isRead: boolean
  hasAttachments: boolean
}

export interface MailAttachmentMeta {
  id: string
  name: string
  sizeBytes: number | null
  contentType: string | null
}

export interface MailDetail {
  id: string
  from: string[]
  to: string[]
  cc: string[]
  subject: string
  sentAt: string
  /** 正文已转为纯文本（不把平台侧 HTML 直接交给前端，彻底避开注入面） */
  bodyText: string
  attachments: MailAttachmentMeta[]
}

export interface MailListResult {
  ok: true
  total: number
  messages: MailSummary[]
}

export interface MailAttachmentContent {
  fileName: string
  contentType: string
  bytes: Buffer
}

/**
 * 写信草稿：Coremail 的发送是**两步** ——
 *   ① compose.jsp 建一份草稿，拿到草稿 id（这一步决定是「新邮件」还是「回复」）；
 *   ② mbox:compose + action=deliver 用该 id 真正投递。
 *
 * 为什么不让客户端自己拼第 ② 步：投递是不可撤销的写操作，收件人地址与正文
 * 必须在服务端再校验一遍（客户端可以被改写、也可能是旧版本）。
 */
export interface MailComposeDraft {
  id: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** 用户在文本框里输入的纯文本（服务端负责转义成 HTML 再提交） */
  bodyText: string
  /** 回复时带上被回复的邮件 id，Coremail 会自行补引用头 */
  replyToMessageId: string | null
}

function requireSession(sid: string, userId: number) {
  const s = getMisSession(sid)
  if (!s || s.userId !== userId) throw new MisError('MIS 会话不存在或已过期，请重新登录')
  if (!s.misLoggedIn) throw new MisError('尚未完成 MIS 登录')
  return s
}

/** ① 建立 Coremail 会话：从 MIS 邮箱入口跟随跳转、捕获 URL 里的 sid。 */
async function ensureCoremailSid(sid: string, jar: CookieJar): Promise<string> {
  const cached = coremailSids.get(sid)
  if (cached) return cached
  const page = await jarFetch(jar, MIS_MAILBOX_ENTRY_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
  })
  if (!page.response.ok) throw new MisError('邮箱入口打开失败，请稍后重试')
  let host = ''
  let mailSid = ''
  try {
    const u = new URL(page.url)
    host = u.hostname.toLowerCase()
    mailSid = u.searchParams.get('sid') ?? ''
  } catch {
    /* 交给下面的统一报错 */
  }
  if (host !== COREMAIL_HOST || !mailSid) {
    throw new MisError('邮箱会话建立失败：未能从学校门户进入邮箱（可能未开通邮箱或门户已改版）')
  }
  coremailSids.set(sid, mailSid)
  return mailSid
}

function coremailJsonHeaders(): Record<string, string> {
  return {
    Accept: 'text/x-json',
    'Content-Type': 'text/x-json; tz="Asia/Shanghai"',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: COREMAIL_INDEX_URL
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

const asNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}

function asStrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asStr).filter(Boolean)
  const s = asStr(v)
  return s ? [s] : []
}

/** Coremail 会话失效的统一处理：清缓存 + 抛可读错误。 */
function sessionExpired(sid: string): never {
  coremailSids.delete(sid)
  throw new MisError('邮箱会话已失效，请退出后重新登录')
}

/** ② 收件箱列表。 */
export async function misMailboxList(
  sid: string,
  userId: number,
  start: number,
  limit: number
): Promise<MailListResult> {
  const s = requireSession(sid, userId)
  const mailSid = await ensureCoremailSid(sid, s.jar)
  const safeLimit = Math.min(Math.max(1, limit), MAX_LIMIT)
  const body = JSON.stringify({
    start: Math.max(0, start),
    limit: safeLimit,
    mode: 'count',
    order: 'date',
    desc: true,
    returnTotal: true,
    returnTag: false,
    summaryWindowSize: safeLimit,
    fid: INBOX_FID,
    mboxa: '',
    topFirst: true
  })
  const page = await jarFetch(
    s.jar,
    `${COREMAIL_ORIGIN}${COREMAIL_JSON_PATH}?sid=${encodeURIComponent(mailSid)}&func=mbox%3AlistMessages`,
    { method: 'POST', headers: coremailJsonHeaders(), body }
  )
  const json = parseJson(page.body)
  if (!json || json.code !== 'S_OK') sessionExpired(sid)
  const items = Array.isArray(json.var) ? json.var : []
  const messages = items.map(parseSummary).filter((m): m is MailSummary => m !== null)
  const total = asNum(json.total) ?? asNum(json.count) ?? messages.length
  return { ok: true, total, messages }
}

function parseSummary(raw: unknown): MailSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const it = raw as Record<string, unknown>
  const id = asStr(it.id)
  if (!id) return null
  const flags = (it.flags ?? {}) as Record<string, unknown>
  const from = asStrList(it.from)
  const to = asStrList(it.to)
  /* 发件箱列表有些版本只返回 to；往来对象取 from，缺则用 to */
  const party = from.length > 0 ? from : to
  return {
    id,
    sender: party.join(', '),
    subject: asStr(it.subject),
    preview: asStr(it.summary),
    sentAt: asStr(it.sentDate) || asStr(it.receivedDate),
    sizeBytes: asNum(it.size) ?? 0,
    /* ⚠️ Coremail 只对「已读」返回 read=true；未读时整个键缺失。
       必须显式 === true 才算已读，否则未读会被误判。 */
    isRead: flags.read === true,
    hasAttachments: flags.attached === true || flags.inlineAttached === true
  }
}

/** ③ 邮件详情（正文转纯文本）。 */
export async function misMailboxRead(sid: string, userId: number, id: string): Promise<MailDetail> {
  const s = requireSession(sid, userId)
  await ensureCoremailSid(sid, s.jar)
  const form = new URLSearchParams({ mid: id, mboxa: '', part: '', mailCipherPassword: '' })
  const page = await jarFetch(s.jar, COREMAIL_READ_MESSAGE_URL, {
    method: 'POST',
    headers: {
      Accept: 'text/x-json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: COREMAIL_INDEX_URL
    },
    body: form.toString()
  })
  const json = parseJson(page.body)
  if (!json || json.code !== 'S_OK') sessionExpired(sid)
  const payload = (json.var ?? {}) as Record<string, unknown>
  const mail = (payload.mail ?? {}) as Record<string, unknown>
  const info = (payload.mailInfo ?? {}) as Record<string, unknown>
  const mainPart = (mail.mainPartData ?? {}) as Record<string, unknown>
  return {
    id: asStr(info.id) || id,
    from: asStrList(mail.from),
    to: asStrList(mail.to),
    cc: asStrList(mail.cc),
    subject: asStr(mail.subject),
    sentAt: asStr(info.sentDate),
    bodyText: htmlToText(asStr(mainPart.content)),
    attachments: parseAttachments(mail.attachments)
  }
}

function parseAttachments(v: unknown): MailAttachmentMeta[] {
  if (!Array.isArray(v)) return []
  return v
    .map((raw): MailAttachmentMeta | null => {
      if (!raw || typeof raw !== 'object') return null
      const it = raw as Record<string, unknown>
      const name = asStr(it.filename) || asStr(it.name) || asStr(it.fileName)
      if (!name) return null
      /* Coremail XT5 实际字段：id / filename / contentType / contentLength（base64 长度）/ estimateSize（解码后大小） */
      const contentLength = asNum(it.contentLength)
      return {
        id: asStr(it.id) || asStr(it.attachmentId),
        name,
        sizeBytes:
          asNum(it.estimateSize) ??
          asNum(it.size) ??
          (contentLength !== null ? Math.floor((contentLength / 4) * 3) : null),
        contentType: (asStr(it.contentType) || asStr(it.type)).split(';')[0].trim() || null
      }
    })
    .filter((x): x is MailAttachmentMeta => x !== null)
}

/** ④ 附件下载（302 后是文件本体；落回登录页 = 会话失效）。 */
export async function misMailboxAttachment(
  sid: string,
  userId: number,
  messageId: string,
  part: string,
  fallbackName: string
): Promise<MailAttachmentContent> {
  const s = requireSession(sid, userId)
  const mailSid = await ensureCoremailSid(sid, s.jar)
  const q = new URLSearchParams({ mode: 'download', sid: mailSid, mid: messageId, part })
  const res = await jarFetch(s.jar, `${COREMAIL_ORIGIN}${COREMAIL_ATTACHMENT_PATH}?${q.toString()}`, {
    headers: { Referer: COREMAIL_INDEX_URL }
  })
  let path = ''
  try {
    path = new URL(res.url).pathname
  } catch {
    /* 交给下面的统一报错 */
  }
  if (!path.startsWith(COREMAIL_ATTACHMENT_PATH)) sessionExpired(sid)
  if (res.raw.length === 0) throw new MisError('附件内容为空')
  const contentType = (res.response.headers.get('content-type') ?? 'application/octet-stream')
    .split(';')[0]
    .trim()
  const disposition = res.response.headers.get('content-disposition') ?? ''
  return {
    fileName: decodeDispositionName(disposition) ?? (fallbackName || 'attachment.bin'),
    contentType,
    bytes: res.raw
  }
}

function decodeDispositionName(disposition: string): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      /* 继续试普通形式 */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition)
  return plain ? plain[1] : null
}

/**
 * 邮件 HTML → 纯文本。
 * 顺序有讲究：先剥标签、后解实体 —— 反过来的话 `&lt;script&gt;`
 * 会在剥标签阶段被解成真标签，等于自己给自己造注入面。
 * `&amp;` 放在最后解，避免二次解码。
 */
function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ============================================================
   写信 / 回复 / 发送（2026-10-20 新增）
   ============================================================

   ## 为什么要做这一步

   在此之前本模块只有读（列表 / 详情 / 附件），用户想回一封邮件必须
   跳到网页版重新登录一次。上游 KMP 版有完整的写信/回复，属于「上游更好
   就采纳」的一类。

   ## 校验放在服务端的理由

   投递不可撤销。收件人写错一个字符，邮件就已经发出去了，只能再发一封
   道歉信。所以地址格式、必填项、长度上限全部在服务端再查一遍 ——
   前端校验只是体验优化，不能当安全边界。

   ## 收件人分隔符

   Coremail 自己接受 `,` `;` 和中文逗号分号。这里统一按这四种切分，
   然后逐个 trim + 去重（同一地址写两遍会让对方收到两封）。
   ============================================================ */

/* 校验与纯文本→HTML 的实现搬到了 mailCompose.ts（纯函数，可被单测直接 import）。
   这里保留一个薄封装，把 ComposeInputError 转成本仓库统一的 MisError，
   这样路由层的 misFail 不用认识第二种错误类型。 */
export function normalizeComposeInput(input: {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  try {
    return normalizeRaw(input)
  } catch (err) {
    if (err instanceof ComposeInputError) throw new MisError(err.message)
    throw err
  }
}

/**
 * ① 建草稿。replyTo 非空时是「回复」，Coremail 会自己补 In-Reply-To 与引用正文。
 *
 * 返回的 id 是后面投递的凭据；**草稿留在服务端**，即使投递失败也不会
 * 在用户的草稿箱里堆一堆半成品（失败路径会尝试 cancelCompose）。
 */
export async function misMailboxBeginCompose(
  sid: string,
  userId: number,
  replyTo: string | null
): Promise<MailComposeDraft> {
  const s = requireSession(sid, userId)
  const mailSid = await ensureCoremailSid(sid, s.jar)
  const fields = new URLSearchParams({ ctype: replyTo ? 'reply' : 'normal', mboxa: '' })
  if (replyTo) fields.set('mid', replyTo)
  const page = await jarFetch(s.jar, `${COREMAIL_COMPOSE_URL}?sid=${encodeURIComponent(mailSid)}`, {
    method: 'POST',
    headers: {
      Accept: 'text/x-json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: COREMAIL_INDEX_URL
    },
    body: fields.toString()
  })
  const json = parseJson(page.body)
  if (!json || json.code !== 'S_OK') sessionExpired(sid)
  const payload = (json.var ?? {}) as Record<string, unknown>
  const id = asStr(payload.id)
  if (!id) throw new MisError('写信失败：平台没有返回草稿编号（邮箱可能未开通写信权限）')
  return {
    id,
    to: asStrList(payload.to),
    cc: asStrList(payload.cc),
    bcc: asStrList(payload.bcc),
    subject: asStr(payload.subject),
    /* 回复时平台会预填引用正文；转纯文本交给前端显示，用户可自行删改 */
    bodyText: htmlToText(asStr(payload.content)).trim(),
    replyToMessageId: replyTo
  }
}

/** ② 投递。只认 `code === "S_OK"`，其它一律当失败 —— 静默当成功会让用户以为发出去了 */
export async function misMailboxSend(
  sid: string,
  userId: number,
  draftId: string,
  input: { to: string; cc?: string; bcc?: string; subject: string; body: string },
  replyTo: string | null
): Promise<{ ok: true }> {
  const s = requireSession(sid, userId)
  const mailSid = await ensureCoremailSid(sid, s.jar)
  if (!draftId) throw new MisError('缺少草稿编号，请重新写信')
  const v = normalizeComposeInput(input)
  const attrs = {
    to: v.to,
    cc: v.cc,
    bcc: v.bcc,
    subject: v.subject,
    isHtml: true,
    content: composeHtml(v.body),
    /* 附件暂不支持：上传要另走一遍 multipart + 落盘，且 Coremail 对
       附件有 50 MB 上限。误以为「点了发送就带上了附件」比不支持更糟，
       所以这里永远传空数组，前端也不放附件入口。 */
    attachments: [],
    priority: 1,
    requestReadReceipt: false,
    saveSentCopy: true
  }
  const body: Record<string, unknown> = {
    id: draftId,
    attrs,
    returnInfo: true,
    action: 'deliver'
  }
  if (replyTo) {
    body.ctype = 'reply'
    body.mid = replyTo
    body.mboxa = ''
  }
  const page = await jarFetch(s.jar, `${COREMAIL_ORIGIN}${COREMAIL_JSON_PATH}?sid=${encodeURIComponent(mailSid)}&func=mbox%3Acompose`, {
    method: 'POST',
    headers: coremailJsonHeaders(),
    body: JSON.stringify(body)
  })
  const json = parseJson(page.body)
  if (!json || json.code !== 'S_OK') {
    if (json && json.code !== 'S_OK') {
      /* 平台给了明确的业务错误码：把 code 带出来，比一句「发送失败」有用 */
      throw new MisError(`发送失败：${asStr(json.code) || '平台拒绝'}${asStr(json.message) ? `（${asStr(json.message)}）` : ''}`)
    }
    sessionExpired(sid)
  }
  return { ok: true }
}

/** ③ 放弃草稿（投递失败时尽力清理；失败本身不再抛，否则会盖住真错误） */
export async function misMailboxCancelCompose(sid: string, userId: number, draftId: string): Promise<void> {
  if (!draftId) return
  try {
    const s = requireSession(sid, userId)
    const mailSid = await ensureCoremailSid(sid, s.jar)
    await jarFetch(s.jar, `${COREMAIL_ORIGIN}${COREMAIL_JSON_PATH}?sid=${encodeURIComponent(mailSid)}&func=mbox%3AcancelComposes`, {
      method: 'POST',
      headers: coremailJsonHeaders(),
      body: JSON.stringify({ ids: draftId })
    })
  } catch {
    /* 清理是 best-effort：残留在草稿箱里用户也能自己删 */
  }
}
