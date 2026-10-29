/**
 * 课件（课程资料）—— 智慧课程平台的「课程资源」。
 *
 * ## 接口（照搬 KMP 参考仓库实测）
 *
 * | 用途 | 请求 |
 * | --- | --- |
 * | 列课程下的节点 | `GET /ve/back/coursePlatform/courseResource.shtml?method=stuQueryUploadResourceForCourseList&courseId=<课程号>&cId=<课程号>&xkhId=<groupId>&xqCode=<学期>&docType=1&up_id=<父目录，根为 0>&searchName=` |
 * | 取下载票据 | `POST /ve/back/resourceSpace.shtml?method=rpinfoDownloadUrl&rpId=<rpId>` |
 * | 下载文件 | `GET <票据返回的 rpUrl>`（**不带 sessionid 头**） |
 *
 * ## 关键约定
 *
 * - **两级结构**：根调用 `up_id=0` 返回 `bagList`（文件夹）+ `resList`（文件）。
 *   文件夹要再调一次、把 `up_id` 换成该文件夹的 `bag_id`，才能拿到里面的东西。
 *   所以「展开文件夹」是一次按需请求，不是一次性递归 —— 一个课程可能有几十层。
 * - `STATUS === '2'` 表示**该课程没有资源**，是合法空结果，不算错误。
 * - `stu_download` 字段：只有明确等于 `'2'` 才表示"不允许下载"，缺失时按允许（沿用参考仓库行为）。
 * - 下载票据里的 URL **不能带 sessionid 头** —— 令牌已嵌在 URL 里，
 *   再带会话头反而会被资源服务拒绝。
 */

import { CookieJar, jarFetch, MisError } from './mis.js'
import { bksyFetchSemesters, bksyFetchCourses } from './bksy.js'
import {
  EXPORT_MAX_BYTES, EXPORT_MAX_DEPTH, EXPORT_MAX_FILES,
  collectEmptyDirs, flattenExportTree as flattenTree, joinExportPath
} from './coursewareTree.js'

export const BKSY_ORIGIN = process.env.BKSY_ORIGIN ?? 'http://123.121.147.7:88'
const BKSY_HOST = new URL(BKSY_ORIGIN).host
const API = `${BKSY_ORIGIN}/ve/back`

/** 接口调用必须带的请求头（缺 Referer / X-Requested-With 会被判为非页面上下文） */
function apiHeaders(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Referer: BKSY_ORIGIN,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01'
  }
  if (sessionId) h.sessionid = sessionId
  return h
}

/* ---------------- 类型 ---------------- */

export type CoursewareKind = 'folder' | 'file'

export interface CoursewareNode {
  /** 文件夹用 bag_id，文件用 resId */
  id: string
  name: string
  kind: CoursewareKind
  /** 文件才有：下载用的资源 id */
  rpId: string
  /** 文件后缀（不带点） */
  ext: string
  /** 原始大小文案（平台给的就是 "1.2MB" 这种字符串，不转数字免得失真） */
  size: string
  teacherName: string
  /** 上传时间 */
  inputTime: string
  downloadCount: number
  /** 平台是否允许下载 */
  canDownload: boolean
}

export interface CoursewareList {
  /** 命中的课程名（回显用） */
  courseName: string
  nodes: CoursewareNode[]
  /** 该课程平台侧整体没有资源 */
  empty: boolean
}

/* ---------------- 解析 ---------------- */

/** 取对象里可能为字符串的字段 */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim()
}
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析一次 courseResource 响应。
 *
 * ⚠️ `bagList` / `resList` 在无数据时是**空串**而不是 `[]`（平台的老毛病），
 *   所以不能写 `?? []` 就完事 —— 得判断是不是数组。
 */
export function parseCoursewareNodes(json: unknown, courseName: string): CoursewareList {
  const root = (json ?? {}) as Record<string, unknown>
  // STATUS="2"：该课程确实没有资源（合法空），与"解析失败"必须区分开
  if (str(root.STATUS) === '2') return { courseName, nodes: [], empty: true }
  if (str(root.STATUS) !== '1' && str(root.flag) !== 'true' && root.flag !== true) {
    // 有些版本用 flag，有些用 STATUS；两个都不认就当作失败由调用方兜底
  }

  const nodes: CoursewareNode[] = []

  const bags = Array.isArray(root.bagList) ? root.bagList : []
  for (const b of bags) {
    const it = (b ?? {}) as Record<string, unknown>
    const id = str(it.id ?? it.bag_id)
    const name = str(it.bag_name ?? it.name)
    if (!id || !name) continue
    nodes.push({
      id,
      name,
      kind: 'folder',
      rpId: '',
      ext: '',
      size: '',
      teacherName: str(it.teacherName),
      inputTime: str(it.inputTime),
      downloadCount: 0,
      canDownload: true
    })
  }

  const res = Array.isArray(root.resList) ? root.resList : []
  for (const r of res) {
    const it = (r ?? {}) as Record<string, unknown>
    const id = str(it.resId ?? it.id)
    const name = str(it.rpName ?? it.name)
    const rpId = str(it.rpId)
    if (!name || !rpId) continue
    nodes.push({
      id: id || rpId,
      name,
      kind: 'file',
      rpId,
      ext: str(it.extName).replace(/^\./, ''),
      size: str(it.rpSize),
      teacherName: str(it.teacherName),
      inputTime: str(it.inputTime),
      downloadCount: num(it.downloadNum),
      // 缺失时按允许（沿用参考仓库）；只有明确 '2' 才判不允许
      canDownload: it.stu_download === undefined || it.stu_download === null ? true : str(it.stu_download) === '2'
    })
  }

  return { courseName, nodes, empty: nodes.length === 0 }
}

/* ---------------- 抓取 ---------------- */

/**
 * 列出某课程「某父目录下」的节点。
 *
 * `parentId` 为 `'0'` 表示根目录。展开一个文件夹就是再调一次、把 parentId 换成它的 id。
 *
 * ⚠️ 为什么不做递归一次性拉全：一门课可能有几十层目录、几百个文件，
 *   一次性递归会让一次同步变得又慢又容易超时；用户真正想看的是某一层的文件。
 */
export async function bksyFetchCourseware(
  jar: CookieJar,
  sessionId: string,
  course: { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string },
  parentId = '0'
): Promise<CoursewareList> {
  const q = new URLSearchParams({
    method: 'stuQueryUploadResourceForCourseList',
    courseId: course.courseNumber,
    cId: course.courseNumber,
    xkhId: course.groupId,
    xqCode: course.semesterCode,
    docType: '1',
    up_id: parentId,
    searchName: ''
  })
  const res = await jarFetch(jar, `${API}/coursePlatform/courseResource.shtml?${q.toString()}`, {
    headers: apiHeaders(sessionId)
  })
  if (!res.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')

  // 会话过期时平台有时仍回 200，但正文是登录页 —— 只当 JSON 解析失败会误报成"文件信息无效"
  const bodyText = res.body.trim()
  if (bodyText.startsWith('<')) {
    throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  }

  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    throw new MisError('课件列表解析失败，平台可能已改版')
  }
  return parseCoursewareNodes(json, course.name)
}

export interface CoursewareDownload {
  bytes: Buffer
  contentType: string
  fileName: string
}

/** 校验下载票据响应 */
export function parseDownloadTicket(json: unknown): string {
  const root = (json ?? {}) as Record<string, unknown>
  const accepted = root.flag === true || str(root.flag) === 'true'
  const url = str(root.rpUrl)
  if (!accepted || !url) throw new MisError('平台未返回有效的下载地址（该文件可能未开放下载）')
  return url
}

/**
 * 下载一个课件文件。
 *
 * ⚠️ 票据 URL 请求**不带 sessionid 头**：令牌已嵌在 URL 里，
 *   再带会话头反而会被资源服务当作非法请求拒掉。
 */
export async function bksyDownloadCourseware(
  jar: CookieJar,
  sessionId: string,
  rpId: string,
  fileName: string
): Promise<CoursewareDownload> {
  const q = new URLSearchParams({ method: 'rpinfoDownloadUrl', rpId })
  const ticketRes = await jarFetch(jar, `${API}/resourceSpace.shtml?${q.toString()}`, {
    method: 'POST',
    headers: apiHeaders(sessionId)
  })
  if (!ticketRes.url.includes(BKSY_HOST)) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')
  if (ticketRes.body.trim().startsWith('<')) throw new MisError('智慧教学平台会话已失效，请重新登录 MIS')

  let url: string
  try {
    url = parseDownloadTicket(JSON.parse(ticketRes.body))
  } catch (e) {
    if (e instanceof MisError) throw e
    throw new MisError('下载票据解析失败，平台可能已改版')
  }

  const fileRes = await jarFetch(jar, url, { headers: { Referer: BKSY_ORIGIN } })
  if (!fileRes.response.ok) throw new MisError(`文件下载失败（HTTP ${fileRes.response.status}）`)
  if (fileRes.raw.length === 0) throw new MisError('文件内容为空')

  const ct = (fileRes.response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]
  return { bytes: fileRes.raw, contentType: ct, fileName }
}

/* ---------------- 课程列表（轻量版，不走 sync） ---------------- */

/**
 * 列出「本学期」智慧课程平台上的课程。
 *
 * ⚠️ 为什么单独出一个接口：sync 是重操作（拉课表/作业/成绩十几秒），
 *   课件用户进应用就是想看文件列表，**不应该**为这件事等十几秒。
 *   课件直接做一次轻量登录 → bksy SSO → 课程列表，全程用同一会话。
 */
export interface CoursewareCourseSummary {
  id: number
  name: string
  teacher: string
  courseNumber: string
  groupId: string
  semesterCode: string
}

export async function bksyListCoursesForCourseware(
  jar: CookieJar,
  sessionId: string
): Promise<CoursewareCourseSummary[]> {
  // 学期：取当前学期（与 sync 的取法一致）
  const sems = await bksyFetchSemesters(jar, sessionId)
  const current = sems.find((s) => s.current) ?? sems[0]
  if (!current) return []

  const courses = await bksyFetchCourses(jar, sessionId, current.xqCode)
  return courses.map((c) => ({
    id: c.id,
    name: c.name,
    teacher: c.teacherName,
    // ⚠️ 字段映射：bksy 实际返回的字段是 courseNum / fzId，
    //   课件接口要的字段名是 courseNumber / groupId（沿用 KMP 实际抓包）。
    //   两者只是 key 不同、值是同一组数据。
    courseNumber: c.courseNum,
    groupId: c.fzId,
    semesterCode: current.xqCode
  }))
}

/* ---------------- 整目录导出 ---------------- */

export interface CoursewareExportFile {
  /** 包内路径（已含目录层级，如 `第1章/讲义.pdf`） */
  path: string
  rpId: string
  /** 平台文件名，用于失败时回显 */
  name: string
}

export interface CoursewareExportTree {
  files: CoursewareExportFile[]
  /** 老师未开放下载的文件名（跳过，但在结果里说明） */
  skipped: string[]
  /** 空文件夹路径（解压后要保留层次，单独写目录条目） */
  emptyDirs: string[]
}

/** 这些常量定义在 coursewareTree 里（纯逻辑，可单测） */
export const COURSEWARE_EXPORT_MAX_FILES = EXPORT_MAX_FILES
export const COURSEWARE_EXPORT_MAX_BYTES = EXPORT_MAX_BYTES
export const COURSEWARE_EXPORT_MAX_DEPTH = EXPORT_MAX_DEPTH

/**
 * 把一层目录展开成「待下载文件 + 跳过的文件 + 子目录」，再补上空的子目录判定。
 *
 * 纯函数，脱离网络单独可测。实现见 `coursewareTree.ts`（那里不碰任何 IO）。
 */
export function flattenExportTree(
  nodes: readonly CoursewareNode[],
  parentPath = ''
): CoursewareExportTree {
  const t = flattenTree(nodes, parentPath)
  return { files: t.files, skipped: t.skipped, emptyDirs: t.dirs }
}

/**
 * 递归展开一棵目录树（服务端抓取）。
 *
 * ⚠️ 为什么要服务端递归而不是前端一层层点：Web 版没有「选择本地目录」的能力
 *   （File System Access API 只在 Chromium 且需要用户手势选目录），
 *   只能由服务端一次性打包成 zip 让浏览器下载。
 *
 * 限制（都是硬上限，超了就抛 MisError 让用户分目录导）：
 * - 文件数 `COURSEWARE_EXPORT_MAX_FILES`
 * - 总字节 `COURSEWARE_EXPORT_MAX_BYTES`（边抓边累加，超了立即停）
 * - 递归深度 `COURSEWARE_EXPORT_MAX_DEPTH`
 *
 * 单个文件下载失败**不中断整次导出**，记进 failed 列表由调用方回显 ——
 * 上游同样是「一个文件不能拖垮整次导出」的口径。
 */
export interface CoursewareExportResult {
  files: Array<{ path: string; bytes: Buffer }>
  /** 下载失败的文件名（含原因） */
  failed: Array<{ name: string; reason: string }>
  skipped: string[]
  emptyDirs: string[]
  /** 被上限截断时为 true —— 前端必须提示「这不是完整导出」 */
  truncated: boolean
}

export async function bksyExportCoursewareDirectory(
  jar: CookieJar,
  sessionId: string,
  course: { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string },
  rootId = '0',
  onProgress?: (done: number, total: number) => void
): Promise<CoursewareExportResult> {
  const out: CoursewareExportResult = {
    files: [],
    failed: [],
    skipped: [],
    emptyDirs: [],
    truncated: false
  }
  let totalBytes = 0
  /*
   * 所有被访问到的目录路径。
   * 递归展开完再用 collectEmptyDirs 回填 —— 一个目录在扫到它的时候还不知道
   * 里面有没有东西，只有整棵子树走完才能确定它是不是空的。
   */
  const visitedDirs: string[] = []

  /** 递归展开；返回 false 表示触到上限，需要停止 */
  async function walk(parentId: string, parentPath: string, depth: number): Promise<boolean> {
    if (depth > COURSEWARE_EXPORT_MAX_DEPTH) {
      throw new MisError(`目录层级超过 ${COURSEWARE_EXPORT_MAX_DEPTH} 层，请进入子目录后再导出`)
    }
    const level = await bksyFetchCourseware(jar, sessionId, course, parentId)
    const tree = flattenExportTree(level.nodes, parentPath)
    out.skipped.push(...tree.skipped)
    if (parentPath) visitedDirs.push(parentPath)

    for (const f of tree.files) {
      if (out.files.length + out.failed.length >= COURSEWARE_EXPORT_MAX_FILES) {
        out.truncated = true
        return false
      }
      try {
        const r = await bksyDownloadCourseware(jar, sessionId, f.rpId, f.name)
        totalBytes += r.bytes.length
        if (totalBytes > COURSEWARE_EXPORT_MAX_BYTES) {
          out.truncated = true
          return false
        }
        out.files.push({ path: f.path, bytes: r.bytes })
      } catch (e) {
        // 单个文件失败不中断整次导出
        out.failed.push({ name: f.name, reason: e instanceof Error ? e.message : '下载失败' })
      }
      onProgress?.(out.files.length + out.failed.length, COURSEWARE_EXPORT_MAX_FILES)
    }

    // 逐个子目录递归（顺序执行，避免把老师的资源服务打挂）
    for (const n of level.nodes) {
      if (n.kind !== 'folder') continue
      const ok = await walk(n.id, joinExportPath(parentPath, n.name, n.id), depth + 1)
      if (!ok) return false
    }
    return true
  }

  await walk(rootId, '', 1)
  // 空目录才需要单独写目录条目；有文件的目录由文件路径隐式创建
  out.emptyDirs = collectEmptyDirs(out.files, visitedDirs)
  return out
}
