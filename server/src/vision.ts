/**
 * 拍照识别课表：把课程表图片发给「视觉大模型」，直接拿回结构化课程 JSON。
 *
 * 选型原理（为什么是视觉大模型而不是传统 OCR）：
 *  - 传统 OCR（tesseract 等）只输出"文字+坐标"，课表的合并单元格、色块、
 *    "课名/教师/地点/周次堆在一格"的语义需要自己重建，准确率很难上 90%；
 *  - 视觉大模型把"识字 + 表格结构理解 + 语义抽取"一步完成，
 *    教务系统截图场景下字段级准确率可达 95% 以上；
 *  - 服务端只做一次 HTTPS 转发（几百 KB 图片），2 核 2G 的小机器毫无压力，
 *    不需要在本机跑 OCR 引擎。
 *
 * 当前模型：智谱 GLM-4.6V（glm-4.6v，128K 上下文、最大输出 32K tokens），
 * 接口走 OpenAI 兼容协议（chat/completions + image_url）。换供应商只需改环境变量：
 *  - VISION_API_KEY    必填，未配置时识别接口返回 503
 *  - VISION_BASE_URL   默认 https://open.bigmodel.cn/api/paas/v4
 *  - VISION_MODEL      默认 glm-4.6v；免费档可填 glm-4.6v-flash
 *  - VISION_MAX_TOKENS 默认 8192（GLM-4.6V 上限 32768；开启思考时会消耗一部分）
 *  - VISION_THINKING   '1' 开启深度思考（默认开，课表这种密集表格抽取更准），'0' 关闭以提速
 *  - VISION_RECHECK    '1' 开启第二轮查漏扫描（默认开），'0' 关闭以提速
 *  - VISION_TIMEOUT_MS 单次调用超时毫秒，默认 120000（开启思考时首 token 更慢）
 *  - VISION_SCAN_RETRIES 首轮/查漏遇"瞬时失败"（超时/429/网络）自动重试次数，默认 1，
 *                      仅重试瞬时失败，密钥错误/结果为空等立即上抛
 *  - NO_CLASS_PERIODS  不排课的节次号，逗号分隔，默认 "3"（仅在提示词与告警中使用，
 *                      不会丢弃识别结果——万一学期调整，图片上真有课仍会如实录入）
 *
 * 准确率的三道防线：
 *  1) Prompt 侧：明确识别目标（5 个字段）+ 字段定义 + 严格结构化输出 + 忽略无关信息；
 *     上课时间只让模型报「时间列里的起止时刻」(timeRange)，不让它输出节次号（跨节次
 *     最容易错，且 GLM-4.6V 有固定课程 JSON 模板会丢弃非标准字段、endPeriod 永远=startPeriod）；
 *  2) 服务端：timeRange 按「学期节次时间表」确定性映射成节次号（读时刻是 VLM 最不易错的
 *     OCR 任务，时刻读对节次就不可能错），并校验节次范围、清洗字段、无法确认即留空；
 *  3) 用户侧：结果先进预览页勾选确认，确认后的数据才入库。
 */
import type { Period, WeekType } from './types.js'

/** 识别出的一门课（与前端 CourseInput / 建课接口字段一致，无 id/color） */
export interface RecognizedCourse {
  name: string
  teacher: string
  location: string
  dayOfWeek: number
  weekStart: number
  weekEnd: number
  weekType: WeekType
  startPeriod: number
  endPeriod: number
  /** 非阻塞提醒（如落在"通常不排课"的节次），前端预览时提示用户核对 */
  warn?: string
}

export interface RowError {
  /** 在模型原始输出数组中的下标，方便定位 */
  index: number
  reason: string
}

export interface RecognizeResult {
  courses: RecognizedCourse[]
  errors: RowError[]
  model: string
}

const API_KEY = process.env.VISION_API_KEY ?? ''
const BASE_URL = (process.env.VISION_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
const MODEL = process.env.VISION_MODEL ?? 'glm-4.6v'

/** 识别图片上限：base64 字符数 ≈ 3.4MB 二进制（前端已压到长边 1600，通常 <1MB） */
export const IMAGE_MAX_CHARS = 4_500_000

/** 调用超时（毫秒）：开启深度思考时首 token 更慢，默认 120 秒。
 *  并发尖峰/思考抖动时可能超时，可用环境变量 VISION_TIMEOUT_MS 调大（如 180000），
 *  或交给下面的瞬时失败自动重试兜底，无需改代码。 */
const REQUEST_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS ?? 120_000)

/** 首轮全表扫描遇到"瞬时失败"（超时 / 429 限流 / 网络抖动）时自动重试的次数上限。
 *  这类失败重试一次命中率很高；第二轮查漏本来就静默降级，不参与重试，避免无谓等待。 */
const SCAN_RETRIES = Math.max(0, Number(process.env.VISION_SCAN_RETRIES ?? 1))

/** 输出上限：GLM-4.6V 支持 32K，取 8192 足够塞下整学期课表 + 思考过程 */
const MAX_TOKENS = Number(process.env.VISION_MAX_TOKENS ?? 8192)

/** 是否开启深度思考（智谱 GLM-4.6V 专有参数，其它供应商自动跳过） */
const THINKING = (process.env.VISION_THINKING ?? '1') !== '0'
const IS_ZHIPU = /bigmodel\.cn|z\.ai|zai/i.test(BASE_URL)

/** 是否做第二轮"查漏"扫描 */
const RECHECK = (process.env.VISION_RECHECK ?? '1') !== '0'

/** 不排课的节次（仅用于提示与告警，不用于过滤） */
const NO_CLASS_PERIODS: number[] = (process.env.NO_CLASS_PERIODS ?? '3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

export function isVisionConfigured(): boolean {
  return API_KEY.trim().length > 0
}

export function visionModelName(): string {
  return MODEL
}

/* ---------------- 节次时间表（识别结果的时间映射基准） ---------------- */

/** HH:mm → 当日分钟数；非法返回 null */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 从各种写法里抠出 HH:mm（"8:00"、"08：00"、"上午8:00"、"8:00-9:50" 都能处理） */
function parseHHMM(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/** 从 "08:00-12:00" / "8:00~12:00" / "08:00至12:00" 里抠出起止两个时刻；非法返回 null */
function parseTimeRange(v: unknown): { start: string; end: string } | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[-~–—〜～－])\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s)
  if (!m) return null
  const h1 = Number(m[1])
  const mi1 = Number(m[2])
  const h2 = Number(m[3])
  const mi2 = Number(m[4])
  if (h1 > 23 || h2 > 23 || mi1 > 59 || mi2 > 59) return null
  return {
    start: `${String(h1).padStart(2, '0')}:${String(mi1).padStart(2, '0')}`,
    end: `${String(h2).padStart(2, '0')}:${String(mi2).padStart(2, '0')}`
  }
}

/**
 * 把上课时间映射到节次号。
 * 优先匹配"落在该节次时间区间内"，匹配不到时取开始时间最接近的节次。
 * 这是"课表只写时间不写节次号"场景的兜底通道，保证入库的节次一定来自学期节次时间表。
 */
export function mapTimeToPeriod(periods: Period[], hhmm: string): number | null {
  const t = toMinutes(hhmm)
  if (t === null || periods.length === 0) return null
  for (const p of periods) {
    const s = toMinutes(p.start)
    const e = toMinutes(p.end)
    if (s !== null && e !== null && t >= s && t <= e) return p.index
  }
  let best: Period | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const p of periods) {
    const s = toMinutes(p.start)
    if (s === null) continue
    const diff = Math.abs(s - t)
    if (diff < bestDiff) {
      bestDiff = diff
      best = p
    }
  }
  return best?.index ?? null
}

/** 渲染给模型看的节次时间表，顺带标注哪些节次通常不排课 */
function renderPeriodTable(periods: Period[], noClass: number[]): string {
  if (periods.length === 0) return '（未配置，请按图片上的节次编号填写）'
  return periods
    .map((p) => {
      const base = `第${p.index}节 ${p.start}-${p.end}`
      return noClass.includes(p.index) ? `${base}（本校该时段通常不排课）` : base
    })
    .join('；')
}

/* ---------------- 节次判定：三条证据交叉校验 ---------------- */

/**
 * 解析行号区间写法："1-2" / "3" / "1~2" / "1、2" / "1,2" / 数字 3 都接受。
 * 起止写反时自动交换，非法返回 null。
 */
export function parseRowRange(v: unknown): { start: number; end: number } | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const nums = s.match(/\d{1,2}/g)
  if (!nums || nums.length === 0) return null
  const a = Number(nums[0])
  const b = nums.length > 1 ? Number(nums[nums.length - 1]) : a
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null
  if (a < 1 || b < 1 || a > 99 || b > 99) return null
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** 行号 → 节次号：按 index 升序排列后，正文第 N 行对应第 N 项 */
function rowToPeriod(periods: Period[], row: number): number | null {
  if (row < 1) return null
  const sorted = [...periods].sort((a, b) => a.index - b.index)
  const p = sorted[row - 1]
  return p ? p.index : null
}

export interface ResolvedPeriods {
  startPeriod: number
  endPeriod: number
  /** 命中的证据通道，多于一个说明各通道结论不一致、已按规则合并 */
  sources: string[]
}

/**
 * 用「时间列实际时刻」作为最可靠证据确定节次，换算全部在服务端按学期节次时间表完成。
 *
 * 为什么让模型只报 timeRange 而不是节次号：
 *  节次号（尤其 endPeriod）需要模型「数合并单元格跨了几行再减一」，实测在跨节次课程上
 *  会稳定少算（跨 2 行输出 1 节）；而且 GLM-4.6V 有固定的课程 JSON 输出模板，
 *  会直接丢弃 rows / startTime / endTime 这类非标准字段、且永远让 endPeriod = startPeriod。
 *  而「读取时间列里的起止时刻」是 VLM 最擅长、最不易错的 OCR 类任务——
 *  时刻读对了，节次按时间表映射就绝不会错，跨节次也自然被时刻差覆盖。
 *
 * 优先级：timeRange（或 startTime+endTime）> 模型直给的节次号（兜底）> 行号区间。
 */
export function resolvePeriods(r: Record<string, unknown>, periods: Period[]): ResolvedPeriods | null {
  const cands: { start: number; end: number; source: string }[] = []

  // 1) timeRange "HH:mm-HH:mm"（最可靠：直接读时间列，跨节次靠时刻差自然体现）
  const tr = parseTimeRange(r.timeRange)
  if (tr) {
    const s = mapTimeToPeriod(periods, tr.start)
    const e = mapTimeToPeriod(periods, tr.end)
    if (s !== null && e !== null) cands.push({ start: s, end: Math.max(s, e), source: 'timeRange' })
  }

  // 2) 起止时间分开（兼容老字段）
  const st = parseHHMM(r.startTime)
  const et = parseHHMM(r.endTime)
  if (st && et) {
    const s = mapTimeToPeriod(periods, st)
    const e = mapTimeToPeriod(periods, et)
    if (s !== null && e !== null) cands.push({ start: s, end: Math.max(s, e), source: 'time' })
  }

  // 3) 模型直给的节次号（前两条都拿不到时的兜底）
  const sp = toInt(r.startPeriod)
  const ep = toInt(r.endPeriod)
  if (sp !== null && sp >= 1) {
    cands.push({ start: sp, end: ep !== null && ep >= sp ? ep : sp, source: 'period' })
  }

  // 4) 行号区间（最低优先级，仅在模型确实给出了行号时使用）
  const rows = parseRowRange(r.rows)
  if (rows) {
    const s = rowToPeriod(periods, rows.start)
    const e = rowToPeriod(periods, rows.end)
    if (s !== null && e !== null) cands.push({ start: s, end: e, source: 'rows' })
  }

  if (cands.length === 0) return null

  let start = cands[0].start
  let end = cands[0].end
  const sources = [cands[0].source]
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]
    if (c.start === start && c.end > end) {
      end = c.end
      sources.push(c.source)
    }
  }
  return { startPeriod: start, endPeriod: end, sources }
}

/* ---------------- Prompt ---------------- */

/**
 * 第一轮：全表扫描。
 *
 * 设计要点：
 *  - 先给"任务定义 + 只抽 5 个字段"，再给"必须忽略什么"，把模型的注意力锁在课程格上；
 *  - 字段逐个给定义与取值域，减少自由发挥（尤其是单双周、节次号这两处最容易错）；
 *  - 明确"无法确认就留空、禁止编造"——宁可字段为空让用户补，也不要错误数据入库；
 *  - 节次映射基准（学期节次时间表）放在最后，要求模型严格照此换算。
 */
function buildPrompt(periods: Period[], totalWeeks: number): string {
  const periodTable = renderPeriodTable(periods, NO_CLASS_PERIODS)
  return `你是一个课程表信息抽取工具。请从图片中抽取课程安排，除此之外不要输出任何信息。

【识别目标——只需要这 5 个字段】
1. 课程名称
2. 上课时间（星期几 + 第几节到第几节）
3. 上课地点
4. 是否单双周（若图片还标了起止周，一并记录）
5. 授课教师

【必须忽略的信息】
学校名称、标题、学期/学年说明、专业班级、图例、水印、页码、表头（如"节次""时间""星期一"）、空单元格，以及任何与课程无关的文字。这些都不能当成课程输出。

【输出格式】
只输出一个 JSON 数组，不要 markdown 代码块，不要任何解释性文字；压缩成单行、不要换行和缩进。每个元素代表"一门课占用的【一个节次】"：
{"name":"课程名","teacher":"教师","location":"教室","dayOfWeek":1,"startPeriod":1,"weekStart":1,"weekEnd":${totalWeeks},"weekType":"all"}

【一门课占多个节次怎么输出——最重要】
如果一门课连续占用多个节次（在表格里表现为跨多行的合并大格），请为它占用的【每一个节次】各输出一个元素；这些元素除 startPeriod 外必须完全相同。
- 例：某课连续占第 1、2 两节 → 输出两个元素，startPeriod 分别是 1 和 2，name/teacher/location 一字不差。
- 例：某课占第 6、7 两节 → 输出两个元素，startPeriod 分别是 6 和 7。
- 只占 1 节（只占 1 个格）的课 → 只输出 1 个元素。
- 不要输出 endPeriod 字段（节次范围由服务端根据你给出的多个 startPeriod 自动合并，你只需保证占几节就输出几个 startPeriod 递增的元素）。

【字段定义与规则】
- name：只写课程名称本身，不要把教师、地点、周次、节次拼进去。
- teacher / location：图片上没有就填空字符串 ""。
- dayOfWeek：整数，1=周一，2=周二，…，7=周日。
- startPeriod：该元素对应节次的节次号（对照文末节次时间表；表格正文第 1 行=第 1 节，第 2 行=第 2 节，依此类推）。
- weekType：每周上="all"，单周="odd"，双周="even"；图片没标注单双周时填 "all"。
- weekStart / weekEnd：整数周次；图片没标注起止周时分别填 1 和 ${totalWeeks}。
- 分单双周上同一门课（例如单周在这、双周在另一时间）→ 各自按占用的节次输出元素。
- **任何字段看不清或无法确认，就留空（name 除外，课程名无法确认则整条不输出）；绝对不要推测、补全或编造内容。**

【扫描要求——最重要】
- 按"从上到下每一行、从左到右每一列"的顺序逐格扫描整张表格，每一个非空课程单元格都要输出，一个都不许漏。
- 跨多行合并的大格：必须按它实际跨的【行数】输出对应个数的元素（跨 2 行就输出 2 个、跨 3 行就输出 3 个 startPeriod 递增的元素），绝不可只输出 1 个。
- 容易漏的：同一行有多门课（别只输出第一门）、浅色字或靠边角的课程、跨行合并的大格。
- **输出前逐条复盘**：每门课的 startPeriod 元素个数 = 它实际跨的行数；跨 N 行的课一定有 N 个 startPeriod 分别为 k, k+1, …, k+N-1 的元素。
- 数一遍表格里非空课程单元格的总数 N，确认 JSON 数组元素个数 ≥ N 后再输出。

【本学期节次时间表——节次号严格按此表映射】
${periodTable}
注：表格正文第 N 行对应上表第 N 项（第 1 行=第 1 节，第 2 行=第 2 节…）。

如果图片不是课程表，或完全无法辨认，输出空数组 []。`
}

/** 第二轮"查漏"提示词：带已找到清单，让模型专找遗漏的非空课程格 */
function buildRecheckPrompt(found: RecognizedCourse[], periods: Period[], totalWeeks: number): string {
  const periodTable = renderPeriodTable(periods, NO_CLASS_PERIODS)
  const foundLines =
    found
      .map((c) => `周${'一二三四五六日'[c.dayOfWeek - 1] ?? c.dayOfWeek} 第${c.startPeriod}${c.endPeriod > c.startPeriod ? `-${c.endPeriod}` : ''}节 ${c.name}`)
      .join('；') || '（无）'
  return `这是一张课程表图片。此前的抽取已经找到以下上课时间段：
${foundLines}

请重新逐行逐列检查整张表格，只输出**不在上面清单里**的遗漏课程时间段；已列出的不要重复输出。若确实没有遗漏，输出空数组 []。

【输出格式】只输出一个 JSON 数组，不要 markdown 代码块，不要任何解释性文字。每个元素代表"一门课占用的一个节次"：
{"name":"课程名","teacher":"教师","location":"教室","dayOfWeek":1,"startPeriod":1,"weekStart":1,"weekEnd":${totalWeeks},"weekType":"all"}

【字段规则】
- name 只写课程名称本身；teacher / location 没有就填 ""。
- dayOfWeek：1=周一 … 7=周日。
- startPeriod：该元素对应节次的节次号（表格正文第 1 行=第 1 节，第 2 行=第 2 节…）。
- **一门课连续占多个节次时，为它占用的每一个节次各输出一个元素**（startPeriod 递增、其余字段相同），不要只输出 1 个。
- weekType：每周="all"，单周="odd"，双周="even"；weekStart / weekEnd 未标注时填 1 和 ${totalWeeks}。
- 忽略校名、标题、表头等非课程信息；无法确认的字段留空，不要编造。

【本学期节次时间表——节次号严格按此表映射】
${periodTable}`
}

/* ---------------- 模型返回解析（纯函数，便于离线测试） ---------------- */

/**
 * 从模型输出文本中稳健地提取 JSON 数组。
 * 容忍 ```json 代码块、前后解释文字、对象包装、尾随逗号、被 max_tokens 截断等常见情况。
 */
export function extractJsonArray(text: string): unknown[] {
  let t = text.trim()
  // 去掉 markdown 代码块围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  // 情况 1：模型把数组包在对象里，如 {"courses": [...]} —— 先尝试抽对象里的数组
  const objMatch = t.match(/"(?:courses|data|result|list)"\s*:\s*(\[[\s\S]*)/i)
  if (objMatch) {
    try {
      return parseArrayLiteral(objMatch[1])
    } catch {
      /* 继续走下面的通用路径 */
    }
  }

  // 情况 2：常规 —— 截取第一个 [ 到最后一个 ]
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1) throw new Error('模型返回中没有 JSON 数组')
  if (end > start) {
    try {
      return parseArrayLiteral(t.slice(start, end + 1))
    } catch {
      /* 可能是半截数组，走截断修复 */
    }
  }

  // 情况 3：输出被 max_tokens 截断 —— 退到最后一个完整的 "}"，补齐 ] 再解析。
  // 课程多、JSON 长时一旦截断就会丢末尾的 "]"；宁可少最后一门课，也比整个识别失败强。
  const lastBrace = t.lastIndexOf('}')
  if (lastBrace > start) {
    const repaired = t.slice(start, lastBrace + 1).replace(/,\s*$/, '') + ']'
    return parseArrayLiteral(repaired)
  }
  throw new Error('模型返回中没有可解析的 JSON 数组')
}

/** 解析一个以 [ 开头的数组字面量，容忍尾随逗号 */
function parseArrayLiteral(s: string): unknown[] {
  const cleaned = s.replace(/,\s*([\]}])/g, '$1') // 去掉尾随逗号（[1,2,] → [1,2]）
  const parsed: unknown = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) throw new Error('模型返回不是数组')
  return parsed
}

const WEEKDAY_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7
}

/** 星期字段容错：接受 1-7 的数字，或"周一/星期一/礼拜三/wed"等写法 */
function parseDayOfWeek(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 7) return v
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return null
  const n = Number(s)
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n
  for (const [k, d] of Object.entries(WEEKDAY_MAP)) {
    if (s.includes(k)) return d
  }
  return null
}

const WEEK_TYPE_MAP: Record<string, WeekType> = {
  all: 'all', 每周: 'all', 全部: 'all', '': 'all',
  odd: 'odd', 单周: 'odd', 单: 'odd',
  even: 'even', 双周: 'even', 双: 'even'
}

function toInt(v: unknown): number | null {
  const s = String(v ?? '').trim()
  if (!s) return null // 注意：Number('') === 0，空串必须先拦掉，否则缺省字段会被误判成 0
  const n = Number(s)
  return Number.isInteger(n) ? n : null
}

export interface NormalizeOptions {
  totalWeeks: number
  /** 学期节次时间表：识别出的节次号必须落在这个范围内，缺节次号时用它把时间换算成节次 */
  periods: Period[]
  /** 通常不排课的节次（仅生成提醒，不做过滤） */
  noClassPeriods?: number[]
}

/**
 * 把模型输出的原始数组清洗成合法课程列表。
 * 每一行要么变成 RecognizedCourse，要么记入 errors —— 绝不静默丢弃、也绝不带病入库。
 */
export function normalizeCourses(
  raw: unknown[],
  opts: NormalizeOptions
): { courses: RecognizedCourse[]; errors: RowError[] } {
  const { totalWeeks, periods } = opts
  const noClass = opts.noClassPeriods ?? NO_CLASS_PERIODS
  const courses: RecognizedCourse[] = []
  const errors: RowError[] = []
  const maxPeriod = periods.length > 0 ? Math.max(...periods.map((p) => p.index)) : 12

  raw.forEach((item, index) => {
    const fail = (reason: string) => errors.push({ index, reason })
    if (typeof item !== 'object' || item === null) {
      fail('该条不是对象')
      return
    }
    const r = item as Record<string, unknown>

    const name = String(r.name ?? '').trim().slice(0, 40)
    if (!name) {
      fail('缺少课程名称')
      return
    }

    const dayOfWeek = parseDayOfWeek(r.dayOfWeek)
    if (dayOfWeek === null) {
      fail(`星期无法识别（${String(r.dayOfWeek ?? '空')}）`)
      return
    }

    /* 节次：三条证据交叉确定（行号区间 / 时间列起止时间 / 模型直给节次号），服务端完成换算 */
    const resolved = resolvePeriods(r, periods)
    if (!resolved) {
      fail(
        `上课时间无法确认（timeRange=${String(r.timeRange ?? '空')}，startPeriod=${String(r.startPeriod ?? '空')}）`
      )
      return
    }
    const startPeriod = resolved.startPeriod
    // 模型直给的 endPeriod 不可靠（GLM-4.6V 固定让 endPeriod = startPeriod，跨节次识别不出跨度），
    // 这里先置为 startPeriod，真正的节次跨度由 mergeConsecutiveSections 按"多个 startPeriod 元素"合并得出。
    const endPeriod = startPeriod
    // 多条证据结论不一致时记一条日志，便于事后判断是哪条通道在误判
    if (resolved.sources.length > 1) {
      console.log(
        `[vision] 节次证据不一致，已合并：${name} → 第${startPeriod}-${endPeriod}节（来源 ${resolved.sources.join('+')}）`
      )
    }
    // 严格校验：节次必须存在于学期节次时间表中，否则课程没有对应上课时间，宁可报错让用户补
    if (startPeriod > maxPeriod || endPeriod > maxPeriod) {
      fail(`第 ${startPeriod}-${endPeriod} 节超出学期节次时间表（共 ${maxPeriod} 节）`)
      return
    }

    let weekStart = toInt(r.weekStart) ?? 1
    let weekEnd = toInt(r.weekEnd) ?? totalWeeks
    if (weekStart < 1) weekStart = 1
    if (weekEnd < weekStart) weekEnd = weekStart
    if (weekEnd > totalWeeks) weekEnd = totalWeeks // 超出本学期周数时收敛，不视为错误
    if (weekStart > totalWeeks) {
      fail(`起始周 ${weekStart} 超出本学期总周数 ${totalWeeks}`)
      return
    }

    const wtRaw = String(r.weekType ?? '').trim().toLowerCase()
    const weekType = WEEK_TYPE_MAP[wtRaw]
    if (weekType === undefined) {
      fail(`周次类型无法识别（${String(r.weekType)}）`)
      return
    }

    // 落在"通常不排课"的节次：不丢弃（图片说了算），但提示用户在预览页核对
    const hit = noClass.filter((p) => p >= startPeriod! && p <= endPeriod!)
    const warn = hit.length > 0 ? `第${hit.join('、')}节为不排课时段，请核对` : undefined

    courses.push({
      name,
      teacher: String(r.teacher ?? '').trim().slice(0, 30),
      location: String(r.location ?? '').trim().slice(0, 40),
      dayOfWeek,
      weekStart,
      weekEnd,
      weekType,
      startPeriod,
      endPeriod,
      ...(warn ? { warn } : {})
    })
  })

  return { courses, errors }
}

/* ---------------- 调用视觉大模型 ---------------- */

/** 视觉服务错误（带 HTTP 语义，路由层转成友好提示） */
export class VisionError extends Error {
  /** 是否为"瞬时失败"（超时/429 限流/网络抖动）：瞬时失败才值得自动重试一次 */
  retryable: boolean
  constructor(message: string, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

/** 单次调用视觉模型，返回文本内容（内部函数，供多轮扫描复用） */
async function callVision(promptText: string, imageDataUrl: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0.1, // 低温度，减少自由发挥
    // GLM-4.6V 输出上限 32K；换供应商时可用 VISION_MAX_TOKENS 调小（如免费档 4V-Flash 只到 1024）
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  }
  // 深度思考是智谱专有参数，只在智谱域名下发送，避免其它供应商报"未知参数"
  if (THINKING && IS_ZHIPU) body.thinking = { type: 'enabled' }

  let res: Response
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    // 超时 / 网络层错误 = 瞬时失败，可自动重试；连接失败大多也是瞬时（DNS/建连抖动）
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    const msg = isTimeout ? '识别服务响应超时，请稍后重试' : '无法连接识别服务，请稍后重试'
    throw new VisionError(msg, true)
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { error?: { message?: string } }
      if (data?.error?.message) detail = data.error.message
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    if (res.status === 401) throw new VisionError('识别服务密钥无效（VISION_API_KEY），请联系管理员检查配置')
    // 429 限流通常是瞬时峰值，自动重试一次往往能过
    if (res.status === 429) throw new VisionError('识别服务当前繁忙，请稍后再试', true)
    throw new VisionError(`识别服务返回错误：${detail}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[]
  }
  const message = data?.choices?.[0]?.message
  const content = message?.content
  // OpenAI 兼容协议 content 可能是 string，也可能是分段数组
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c === 'object' && c !== null ? String((c as { text?: unknown }).text ?? '') : '')).join('')
        : ''
  if (!text.trim()) {
    // 开启深度思考时偶尔只回 reasoning_content，把思考尾巴也打到日志里便于排查
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
    console.error('[vision] 模型返回空内容，thinking 片段（前 300 字符）:', reasoning.slice(0, 300))
    throw new VisionError('识别服务返回为空，请换一张更清晰的图片重试')
  }
  return text
}

/**
 * 对"瞬时失败"做有界重试：只重试 VisionError.retryable 的（超时/429/网络抖动），
 * 其它失败（密钥无效、结果为空、HTTP 5xx 等）立即上抛，不做无谓等待。
 * @param retries 额外重试次数上限（0 = 不重试）
 */
async function withTransientRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  onRetry?: (retryIndex: number) => void
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryable = err instanceof VisionError && err.retryable
      if (!retryable || attempt >= retries) throw err
      console.warn(`[vision] 瞬时失败（第 ${attempt + 1} 次：${(err as Error).message}），1s 后重试`)
      onRetry?.(attempt)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/** 从模型文本中解析并清洗课程列表（格式异常时抛 VisionError） */
function parseCourses(text: string, opts: NormalizeOptions): { courses: RecognizedCourse[]; errors: RowError[] } {
  let raw: unknown[]
  try {
    raw = extractJsonArray(text)
  } catch {
    // 解析失败时把模型原始输出打进日志（journalctl -u bjtu-helper 可见），
    // 便于管理员事后诊断是模型拒答、截断还是返回了别的格式
    console.error('[vision] 无法解析的模型输出（前 600 字符）:', text.slice(0, 600))
    throw new VisionError('识别结果格式异常，请重试；若多次出现请把照片发给管理员排查')
  }
  return normalizeCourses(raw, opts)
}

/**
 * 把"一门课占多个节次 → 多个 startPeriod 元素"的模型输出合并成带跨度的单条课程。
 *
 * 背景：GLM-4.6V 有固定的课程 JSON 模板，endPeriod 永远等于 startPeriod、且会丢弃任何
 * 非标准字段（rows / timeRange / startTime），跨节次课程只能靠"每节次一个元素"绕开。
 * 合并规则：按 (name, dayOfWeek, weekType) 分组、按 startPeriod 升序，把连续或重叠的
 * startPeriod 段合并成一条，endPeriod 取段的最大节次；非连续段（同一门课在不同节次块）
 * 保持为多条。同组内的重复 startPeriod（模型偶发重复）自动去重。
 */
export function mergeConsecutiveSections(courses: RecognizedCourse[]): RecognizedCourse[] {
  const groups = new Map<string, RecognizedCourse[]>()
  for (const c of courses) {
    const key = `${c.name}|${c.dayOfWeek}|${c.weekType}`
    const arr = groups.get(key)
    if (arr) arr.push(c)
    else groups.set(key, [c])
  }
  const out: RecognizedCourse[] = []
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.startPeriod - b.startPeriod || a.endPeriod - b.endPeriod)
    let cur: RecognizedCourse | null = null
    for (const c of arr) {
      if (!cur) {
        cur = { ...c }
        continue
      }
      if (c.startPeriod <= cur.endPeriod + 1) {
        // 连续（sp 正好是上一段末节次+1）或重叠/重复 → 延长结束节次、合并提醒，不新增条目
        if (c.endPeriod > cur.endPeriod) cur.endPeriod = c.endPeriod
        if (c.warn && !cur.warn) cur.warn = c.warn
      } else {
        out.push(cur)
        cur = { ...c }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

export async function recognizeSchedule(
  imageDataUrl: string,
  opts: { periods: Period[]; totalWeeks: number },
  onPhase?: (phase: string) => void
): Promise<RecognizeResult> {
  if (!isVisionConfigured()) {
    throw new VisionError('服务器未配置 VISION_API_KEY')
  }

  const normalizeOpts: NormalizeOptions = {
    totalWeeks: opts.totalWeeks,
    periods: opts.periods,
    noClassPeriods: NO_CLASS_PERIODS
  }

  // 第一轮：全表扫描。遇"瞬时失败"（超时/429/网络抖动）最多重试 SCAN_RETRIES 次，
  // 每次留 1s 退避，避免跟模型/网关在同一秒内对撞；重试多次仍失败才上抛给用户。
  onPhase?.('正在调用识别大模型识别课表（第 1 轮扫描）…')
  const text1 = await withTransientRetry(
    () => callVision(buildPrompt(opts.periods, opts.totalWeeks), imageDataUrl),
    SCAN_RETRIES,
    (retry) => onPhase?.(retry ? `调用超时/繁忙，正在第 ${retry + 1} 次重试调用识别大模型…` : '正在调用识别大模型…')
  )
  const first = parseCourses(text1, normalizeOpts)

  // 第二轮：查漏（密集课表容易漏格；带着"已找到清单"让模型专找遗漏，两轮取并集提升召回）。
  // 第一轮为空时说明图片可能不是课表，不再查漏。
  if (!RECHECK || first.courses.length === 0) {
    onPhase?.('识别完成，正在整理结果…')
    return { courses: first.courses, errors: first.errors, model: MODEL }
  }

  let second: { courses: RecognizedCourse[]; errors: RowError[] } = { courses: [], errors: [] }
  try {
    onPhase?.('第 1 轮识别完成，正在调用大模型查漏补全（第 2 轮）…')
    // 查漏同样对瞬时失败做 1 次重试；仍失败则不影响第一轮结果，静默降级为单轮
    const text2 = await withTransientRetry(
      () => callVision(buildRecheckPrompt(first.courses, opts.periods, opts.totalWeeks), imageDataUrl),
      Math.min(1, SCAN_RETRIES),
      (retry) => onPhase?.(retry ? `第 2 轮调用超时/繁忙，正在重试调用识别大模型…` : '第 2 轮正在调用识别大模型…')
    )
    second = parseCourses(text2, normalizeOpts)
  } catch {
    // 查漏失败（超时/格式异常等）不影响第一轮结果，静默降级为单轮
  }
  onPhase?.('识别完成，正在合并去重…')

  // 合并去重：同一课程名 + 同一天 + 同起始节次视为同一条；保留带 warn 的版本（信息更全）
  const merged: RecognizedCourse[] = [...first.courses]
  const keyOf = (c: RecognizedCourse) => `${c.name}|${c.dayOfWeek}|${c.startPeriod}`
  const index = new Map(merged.map((c, i) => [keyOf(c), i]))
  for (const c of second.courses) {
    const key = keyOf(c)
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, merged.length)
      merged.push(c)
    } else if (!merged[at].warn && c.warn) {
      merged[at] = { ...merged[at], warn: c.warn }
    }
  }

  // 把"一门课占多个节次 → 多个 startPeriod 元素"合并成带跨度的单条课程（解决 GLM-4.6V 跨节次判窄）
  const courses = mergeConsecutiveSections(merged)
  return { courses, errors: [...first.errors, ...second.errors], model: MODEL }
}
