/**
 * 写信/回复的**纯逻辑**：收件人解析、地址校验、纯文本 → HTML。
 *
 * ## 为什么从 mailbox.ts 里抽出来
 *
 * mailbox.ts 一 import 就会拖进 `mis.ts` 的整个会话体系（cookie jar、
 * ssoLogin、fetch 包装）。这几个函数是纯字符串处理，抽出来之后
 * `scripts/test-units.mts` 可以直接 import 做单测，不用起服务、不用网络。
 *
 * ## 校验为什么必须做（而且必须在服务端做）
 *
 * 投递不可撤销。收件人写错一个字符，邮件就已经发出去了，只能再发封道歉信。
 * 前端校验只是体验优化 —— 客户端可以被改写、也可能是缓存的旧版本，
 * 因此真正的边界在这里。
 */

/** 单个收件人地址的长度上限（RFC 5321 的 254 是总长上限，这里按单址收紧） */
const MAX_ADDRESS_LENGTH = 254
/** 一次最多发给多少人（含 cc/bcc）——防止误贴整份通讯录 */
const MAX_RECIPIENTS = 50
/** 主题长度上限（Coremail 界面本身也在这个量级截断） */
const MAX_SUBJECT_LENGTH = 255
/** 正文长度上限：1 MB 纯文本，超过几乎一定是误贴了文件 */
const MAX_BODY_LENGTH = 1024 * 1024

/**
 * 宽松但足够拦住手误的地址校验：必须有 @，域名要有点，不能有空白。
 *
 * 刻意不做完整 RFC 5322 校验 —— 那个正则几乎没人能维护，而且会把
 * 合法但罕见的地址（`a+b@x.y` 之外的加号/等号形式）误判成非法。
 * 真正的验证是 SMTP 服务器发出去的退信，前端/服务端只能挡明显笔误。
 */
const ADDRESS_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[^\s@,;<>()[\]\\]+$/

/** 输入不合法的统一错误类型（mailbox.ts 会把它转成对用户可见的 MisError） */
export class ComposeInputError extends Error {}

/**
 * 把用户输入的一串地址切成数组。
 *
 * 支持 `,` `;` 中文逗号中文分号与换行 —— Coremail 自己全认，
 * 但用户从通讯录/Excel 里粘出来时这四种分隔符都会出现。
 * 同时去重（不区分大小写）：同一地址写两遍会让对方收到两封。
 */
export function parseRecipients(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[,;，；\n]/)) {
    const addr = part.trim()
    if (!addr) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out
}

/** 校验地址列表；返回第一个不合法的地址（null = 全部合法） */
function findBadAddress(list: string[]): string | null {
  for (const a of list) {
    if (a.length > MAX_ADDRESS_LENGTH || !ADDRESS_RE.test(a)) return a
  }
  return null
}

/**
 * 纯文本 → Coremail 接受的 HTML。
 *
 * 转义顺序与 `htmlToText` 严格相反（**先转义再插 `<br>`**）：反过来的话
 * 正文里的 `<script>` 会被当成标签发出去，收件人看到的是一封被剥掉内容的信。
 */
export function composeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '<br>')
}

export interface ComposeInput {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}

export interface NormalizedCompose {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

/**
 * 校验并归一化一封待发邮件。抛出的错误文案直接给用户看。
 *
 * 主题允许为空（网易/QQ 也允许，只弹一句提示），但**收件人不能为空** ——
 * 没有收件人的邮件是无意义的，拦在这里比让平台报一个晦涩的错误码好。
 */
export function normalizeComposeInput(input: ComposeInput): NormalizedCompose {
  const to = parseRecipients(input.to)
  const cc = parseRecipients(input.cc ?? '')
  const bcc = parseRecipients(input.bcc ?? '')
  if (to.length === 0) throw new ComposeInputError('请填写收件人')
  const total = to.length + cc.length + bcc.length
  if (total > MAX_RECIPIENTS) {
    throw new ComposeInputError(`收件人过多（共 ${total} 个，最多 ${MAX_RECIPIENTS} 个）`)
  }
  const bad = findBadAddress(to) ?? findBadAddress(cc) ?? findBadAddress(bcc)
  if (bad) throw new ComposeInputError(`地址格式不对：${bad}`)
  const subject = input.subject.trim()
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new ComposeInputError(`主题过长（最多 ${MAX_SUBJECT_LENGTH} 字）`)
  }
  const body = input.body.replace(/\r\n/g, '\n')
  if (body.length > MAX_BODY_LENGTH) throw new ComposeInputError('正文过长（最多 1 MB）')
  return { to, cc, bcc, subject, body }
}
