/**
 * 课程平台作业提交（上传文件 → 投递）。
 *
 * ## 为什么要单独一个文件
 *
 * `bksy.ts` 只做**读**（列表 / 详情 / 下载）。上传是写操作，风险等级完全不同：
 * 提交会**覆盖式替换**上一次的提交记录（服务端删旧记录再写新记录），
 * 且没有撤回接口。把它和读接口混在一起，将来想"只读模式"就得逐行判断。
 *
 * ## 两步协议（上游 `HomeworkRemoteDataSource.submitHomework` 取证）
 *
 * ```
 * ① POST http://123.121.147.7:88/ve/back/rp/common/homeworkUpload.shtml?noteId=<upId>
 *        multipart/form-data，单个字段名 file
 *      → {"STATUS":"0","fileNameNoExt":"…","fileExtName":"…","fileSize":"…","visitName":"…"}
 * ② POST http://123.121.147.7:88/ve/back/course/courseWorkInfo.shtml?method=sendStuHomeWorks
 *        application/x-www-form-urlencoded
 *      → {"flag":"success"}
 * ```
 *
 * ## 判成功的唯一依据
 *
 * 只看 HTTP 2xx 会把失败当成功（上游有这段历史缺陷）。必须解析回执：
 * 上传要 `STATUS == "0"` 且四个回执字段齐全，投递要 `flag == "success"`。
 * 投递失败（`{"flag":"bad"}`）还会**连带清掉上一次的提交记录** ——
 * 所以失败必须如实告诉用户"可能已经丢了上次提交"，不能吞掉。
 *
 * ## 上传端点的坑
 *
 * - 学生走 `homeworkUpload.shtml?noteId=`，作业 ID 在 **query** 里，不在 body。
 * - `rpUpload.shtml` 是**老师**分支，学生调它会回 `{"STATUS":"2","MSG":"学生角色无权限上传"}`。
 *   上游此前的移植版一直失败就是因为调错了这个端点。
 * - 上传**不带** `X-Requested-With`/`Accept` 这些 AJAX 头（网页端 layui/uploadify 也不带），
 *   但**必须带** `sessionid` —— 它是这个平台区别于 JSESSIONID 的接口会话标识。
 */
import { CookieJar, jarFetch, MisError } from './mis.js'
import { BKSY_ORIGIN } from './bksy.js'

const BKSY_HOST = new URL(BKSY_ORIGIN).host
const API = `${BKSY_ORIGIN}/ve/back`

/** 学生上传端点（注意 noteId 在 query） */
const UPLOAD_PATH = `${API}/rp/common/homeworkUpload.shtml`
/** 投递端点 */
const SUBMIT_PATH = `${API}/course/courseWorkInfo.shtml`

/**
 * 单个文件大小上限。
 *
 * 上游网页端 uploadify 的限制在 50 MB 量级，但本项目的上传是
 * **base64 塞进 JSON** 走的（与图片上传同一套路，见 index.ts 的
 * LARGE_BODY_PATHS 说明），base64 膨胀 4/3。
 *
 * 6 MB 的取舍：学生真实提交物是代码包 / 实验报告 / 小 PPT，绝大多数不到 2 MB；
 * 再往上放大只会让单请求内存占用成倍上涨，而收益很小。
 * 超过这个值的文件让用户去网页端提交（页面会明确告诉他这一点）。
 */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024
/** 一次提交的文件总大小上限（多个小文件加起来同样要卡） */
export const MAX_TOTAL_UPLOAD_BYTES = 6 * 1024 * 1024
/** 一次最多提交几个文件（上游网页端 uploadify 允许 5 个左右，这里稍宽） */
export const MAX_UPLOAD_FILES = 8
/** 提交说明长度上限 */
export const MAX_SUBMIT_NOTE_LENGTH = 5000

/**
 * 只带 `sessionid`，不带 AJAX 头。
 *
 * 与 `apiHeaders()` 的区别是刻意的：写请求走的是网页表单路径，
 * 加了 `X-Requested-With` 反而可能被平台当成 AJAX 请求走另一条分支。
 */
function writeHeaders(sessionId: string): Record<string, string> {
  return { sessionid: sessionId, Referer: `${BKSY_ORIGIN}/ve/back/core/main/index.shtml` }
}

/** 上传回执（平台返回的四个字段，投递时要原样回传） */
export interface BksyUploadReceipt {
  fileNameNoExt: string
  fileExtName: string
  fileSize: string
  visitName: string
}

/**
 * 解析上传回执。任何字段缺失都算失败 —— 半份回执拼出来的 `fileList`
 * 会让服务端在投递阶段把它当成非法文件。
 *
 * 失败时抛 MisError，文案优先用服务端的 `MSG`（那是真正的原因，
 * 比如"上传文件类型不支持"），没有才用通用文案。
 */
export function parseUploadReceipt(body: string): BksyUploadReceipt {
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('not object')
    json = parsed as Record<string, unknown>
  } catch {
    throw new MisError('上传回执解析失败，学校系统可能已改版')
  }
  const status = json.STATUS == null ? '' : String(json.STATUS)
  const msg = typeof json.MSG === 'string' ? json.MSG.trim() : ''
  const name = typeof json.fileNameNoExt === 'string' ? json.fileNameNoExt : ''
  const ext = typeof json.fileExtName === 'string' ? json.fileExtName : ''
  const size = typeof json.fileSize === 'string' ? json.fileSize : ''
  const visit = typeof json.visitName === 'string' ? json.visitName : ''
  if (status !== '0' || !name || !size || !visit) {
    /* 服务端明确回绝（缺 noteId / 类型不支持 / 无权限）时把原文带给用户 */
    if (msg) throw new MisError(`上传失败：${msg}`)
    throw new MisError('上传失败：平台未返回有效的文件回执')
  }
  return { fileNameNoExt: name, fileExtName: ext, fileSize: size, visitName: visit }
}

/**
 * 解析投递回执。只有 `flag=success` 算成功。
 *
 * `flag=bad` 的后果比"这次没提交上"更严重：服务端会顺带清掉上一次的提交记录。
 * 所以错误文案必须说明这一点，否则用户会以为旧提交还在。
 */
export function parseSubmitReceipt(body: string): void {
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('not object')
    json = parsed as Record<string, unknown>
  } catch {
    throw new MisError('提交回执解析失败，学校系统可能已改版，请到网页端确认是否提交成功')
  }
  const flag = typeof json.flag === 'string' ? json.flag.toLowerCase() : ''
  if (flag === 'success') return
  const msg = typeof json.msg === 'string' ? json.msg.trim() : ''
  if (msg) throw new MisError(`提交失败：${msg}`)
  throw new MisError('提交失败：平台未确认收到（可能已清空上一次的提交记录，请到网页端确认）')
}

/** 把上传回执拼成平台 `fileList` 字段要的 JSON 数组字符串 */
export function buildFileListJson(receipts: BksyUploadReceipt[]): string {
  return `[${receipts
    .map((r) => {
      const esc = (s: string) => JSON.stringify(s).slice(1, -1)
      return (
        `{"fileNameNoExt":"${esc(r.fileNameNoExt)}","fileExtName":"${esc(r.fileExtName)}",` +
        `"fileSize":"${esc(r.fileSize)}","visitName":"${esc(r.visitName)}",` +
        `"pid":"","ftype":"insert"}`
      )
    })
    .join(',')}]`
}

/**
 * 表单值预编码 —— 与网页端 `sendHomeWorks()` 的双层编码对齐。
 *
 * 网页端先 `encodeURIComponent(content)`，再交给 jQuery 编码一次；
 * 服务端按两层解码取原文。**少这一层**（或换成标准 urlencoded）的结果是
 * 正文里的中文/换行在提交后变成 `%E4%BD%A0` 这样的字面量。
 *
 * 与 `encodeURIComponent` 的差别：空格编成 `+`（表单编码惯例），
 * 保留 `-_.*` 不转义。
 */
export function formValuePreEncode(text: string): string {
  const HEX = '0123456789ABCDEF'
  let out = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    const safe =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x2a // - _ . *
    if (safe) out += String.fromCharCode(byte)
    else if (byte === 0x20) out += '+'
    else out += `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`
  }
  return out
}

/** 一个待上传的文件 */
export interface UploadFile {
  fileName: string
  contentType: string
  bytes: Buffer
}

/**
 * 上传单个文件，返回回执。
 *
 * 手写 multipart 而不是用 `FormData`：本项目服务端零原生依赖，
 * 也不引 `form-data` 包；而 `fetch` 的 `FormData` 在 Node 里会给文件
 * 自动加 `filename="blob"`，平台按文件名判扩展名，那样会全部失败。
 */
export async function bksyUploadHomeworkFile(
  jar: CookieJar,
  sessionId: string,
  upId: number,
  file: UploadFile
): Promise<BksyUploadReceipt> {
  if (file.bytes.length === 0) throw new MisError(`文件「${file.fileName}」是空的`)
  if (file.bytes.length > MAX_UPLOAD_BYTES) {
    throw new MisError(`文件「${file.fileName}」超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
  }
  /* 文件名里的引号/换行必须去掉：它们会截断 multipart 头，让整个请求体错位。
     这不是洁癖 —— 浏览器上传时也会做同样的剔除。
     2026-10-23 修（评审 B3）：contentType 也来自外部（浏览器/客户端），同样能带 CRLF
     注入 multipart 头，做同款清洗；空值回退 application/octet-stream。 */
  const safeName = file.fileName.replace(/["\r\n\\]/g, '_')
  const safeType = (file.contentType || 'application/octet-stream').replace(/[\r\n]/g, '')
  const boundary = `----bjtuHelper${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${safeType}\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, file.bytes, tail])

  const res = await jarFetch(jar, `${UPLOAD_PATH}?noteId=${upId}`, {
    method: 'POST',
    headers: {
      ...writeHeaders(sessionId),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  return parseUploadReceipt(res.body)
}

/** 提交参数 */
export interface SubmitHomeworkInput {
  upId: number
  courseId: number
  homeworkType: number
  /** 提交说明（纯文本）；平台要求先预编码 */
  note: string
  receipts: BksyUploadReceipt[]
}

/**
 * 投递作业。
 *
 * `return_num` 必须传 `"0"`：网页表单未初始化时会提交 `{}`，
 * 服务端把它当整数解析失败 → 回 `{"flag":"bad"}` 并**清掉上一次提交**。
 * 列表页自己的 `jiaozuoye(...)` 传的是 `'0'`，这里保持一致。
 */
export async function bksySubmitHomework(
  jar: CookieJar,
  sessionId: string,
  input: SubmitHomeworkInput
): Promise<void> {
  if (input.receipts.length === 0) throw new MisError('请先上传至少一个文件')
  if (input.note.length > MAX_SUBMIT_NOTE_LENGTH) {
    throw new MisError(`提交说明过长（最多 ${MAX_SUBMIT_NOTE_LENGTH} 字）`)
  }
  const form = new URLSearchParams({
    content: formValuePreEncode(input.note),
    groupName: '',
    groupId: '',
    courseId: String(input.courseId),
    contentType: String(input.homeworkType),
    fz: '0',
    jxrl_id: '',
    fileList: buildFileListJson(input.receipts),
    upId: String(input.upId),
    /* 服务端按整数解析；网页表单未初始化时提交的 `{}` 会得到 flag=bad */
    return_num: '0',
    isTeacher: '0'
  })
  const res = await jarFetch(jar, `${SUBMIT_PATH}?method=sendStuHomeWorks`, {
    method: 'POST',
    headers: {
      ...writeHeaders(sessionId),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: form.toString()
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  parseSubmitReceipt(res.body)
}
