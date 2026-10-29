/**
 * 多学期（Term）纯函数工具。
 *
 * ⚠️ **本文件刻意不 import './db.js'**：
 *   迁移脚本（scripts/migrate-terms.mts）与回归测试都要直接 import 它，
 *   而 db.js 在模块加载时就会打开数据库文件并建表 —— 直接 import 会导致
 *   「只想算个 id，却顺带打开了一个库」。保持纯函数是本模块的硬约束。
 *
 * 设计要点（为什么要保留 settings.semester 这个"镜像"）：
 *   改造前全项目读学期都走 `settings.semester`（周/月视图、设置页表单、课表文案）。
 *   如果直接把它换成 `terms` 数组，所有读取点都要改，回归面极大。
 *   因此 `terms` 是**唯一事实来源**，而 `semester` 被维护为「当前学期」的镜像 ——
 *   读取方零改动，写入方统一走本模块的函数来保证两者一致。
 */
import type { Period, SemesterSettings, SemesterWeek, Settings, Term } from './types.js'

/** 学期 id 的最大长度防御（避免异常输入把 id 撑爆） */
const MAX_TERM_ID_LEN = 40

/**
 * 由开学日生成稳定、可读的学期 id：`2026-fall` / `2027-spring`。
 *
 * 学年口径（与下方代码逐字一致）：7-12 月 → 当年秋季；1 月 → 上一年的秋季；
 * 2 月 → 上一年的春季（学年跨自然年：2026-01/02 都属于 2025 学年）；
 * 3-6 月 → 当年春季。
 * 冲突时追加 `-2`、`-3`…（同一学年补建第二个学期时用得到）。
 * 生成后**不再随开学日变动**（id 一旦写入就固定），否则改开学日会让课程归属丢失。
 */
export function makeTermId(startDate: string, taken: ReadonlySet<string> = new Set()): string {
  const m = /^(\d{4})-(\d{2})/.exec(startDate)
  const year = m ? Number(m[1]) : new Date().getFullYear()
  const month = m ? Number(m[2]) : 9
  const season = month >= 7 || month <= 1 ? 'fall' : 'spring'
  const baseYear = month <= 2 ? year - 1 : year
  const base = `${baseYear}-${season}`.slice(0, MAX_TERM_ID_LEN)
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/** 由学期设置派生一个 Term（用于把存量单学期数据升格成 terms 列表） */
export function termFromSemester(semester: SemesterSettings, taken: ReadonlySet<string> = new Set()): Term {
  return {
    id: makeTermId(semester.startDate, taken),
    name: semester.name,
    startDate: semester.startDate,
    totalWeeks: semester.totalWeeks,
    weeks: semester.weeks ?? null,
    officialCredits: null
  }
}

/** 取当前学期（Terms 缺失时合成一个，保证调用方永远拿得到） */
export function currentTerm(settings: Settings): Term {
  const normalized = normalizeSettings(settings)
  const id = normalized.currentTermId as string
  return normalized.terms!.find((t) => t.id === id) as Term
}

/**
 * 归一化设置：
 *  1. 缺 terms → 由 semester 合成（存量数据零迁移即可读）；
 *  2. currentTermId 缺失或指向不存在的学期 → 回退到列表第一项；
 *  3. 把 `semester` 与 `officialCredits` 同步成「当前学期」的镜像。
 * 幂等，可反复调用；不改动传入对象（返回新对象）。
 */
export function normalizeSettings(settings: Settings): Settings {
  const terms: Term[] = Array.isArray(settings.terms) && settings.terms.length > 0 ? [...settings.terms.map((t) => ({ ...t }))] : []
  /* 只有在「刚从旧数据合成出学期列表」时，顶层 officialCredits 才代表当前学期的权威值。 */
  const synthesized = terms.length === 0

  if (synthesized) {
    const t = termFromSemester(settings.semester)
    /* 存量数据的 officialCredits 在顶层，此刻升格到学期上，避免升级后丢失；
       注意**只在合成这一次**做这件事（详见下方注释）。 */
    t.officialCredits = settings.officialCredits ?? null
    terms.push(t)
  }

  let currentTermId = settings.currentTermId ?? ''
  if (!terms.some((t) => t.id === currentTermId)) currentTermId = terms[0].id

  const cur = terms.find((t) => t.id === currentTermId) as Term

  /*
   * ⚠️ 这里**不要**再写「顶层有值就回填到当前学期」。
   *
   * 曾这么写过，后果是：用户在 A 学期有官方总学分 88（顶层镜像=88），切到还没导入过教务的
   * B 学期时，B.officialCredits 为 null → 回填逻辑把 88 拷到 B 上 → 顶层镜像仍是 88。
   * 于是「切了学期但学分没变」，B 学期凭空多出一份不属于它的官方学分（回归测试抓到的真实 bug）。
   *
   * 正确的不变量：**terms 是唯一事实来源，顶层 officialCredits 只是当前学期的镜像**，
   * 单向（term → 顶层）。旧数据的顶层值在「合成学期」那一步已经搬进学期里了，无需二次搬运。
   */

  return {
    ...settings,
    terms,
    currentTermId,
    semester: {
      name: cur.name,
      startDate: cur.startDate,
      totalWeeks: cur.totalWeeks,
      /* 周次表随学期一起镜像给读取方（周/月视图要按它解析「第 N 周 ↔ 日期」）。
         缺失时给 null 而不是 undefined，让「没有周次表」这件事在 JSON 里显式可见。 */
      weeks: cur.weeks ?? null
    },
    officialCredits: cur.officialCredits ?? null
  }
}

/**
 * 新增一个学期；**默认同时切换过去**（`makeCurrent !== false`）。
 *
 * 为什么默认是「切过去」而不是「留在原学期」：
 *   建一个新学期的实际动机几乎总是「接下来要开始用它」（下学期开学前建好、导入新课表）。
 *   若默认不切，用户建完会发现课表还是旧学期，得再点一次「切换」—— 多一步且容易困惑。
 *   路由 `POST /api/terms` 也基于同一判断（`setCurrent !== false`），此处保持一致，
 *   避免「库函数默认」与「接口默认」相反这种只有踩过才发现的坑。
 */
export function addTerm(
  settings: Settings,
  input: { name: string; startDate: string; totalWeeks: number; makeCurrent?: boolean; weeks?: SemesterWeek[] | null },
  periods?: Period[]
): { settings: Settings; term: Term } {
  const base = normalizeSettings(settings)
  const taken = new Set(base.terms!.map((t) => t.id))
  const term: Term = {
    id: makeTermId(input.startDate, taken),
    name: input.name,
    startDate: input.startDate,
    totalWeeks: input.totalWeeks,
    weeks: input.weeks ?? null,
    officialCredits: null
  }
  const makeCurrent = input.makeCurrent !== false
  const next = normalizeSettings({
    ...base,
    ...(periods ? { periods } : {}),
    terms: [...base.terms!, term],
    currentTermId: makeCurrent ? term.id : base.currentTermId
  })
  return { settings: next, term }
}

/**
 * 修改某个学期。注意：**id 不随开学日变化**（否则课程归属会断）。
 * 若改的是当前学期，镜像字段会一并同步。
 */
export function updateTerm(settings: Settings, termId: string, patch: Partial<Omit<Term, 'id'>>): Settings {
  const base = normalizeSettings(settings)
  const terms = base.terms!.map((t) => (t.id === termId ? { ...t, ...patch, id: t.id } : t))
  return normalizeSettings({ ...base, terms })
}

/** 切换当前学期 */
export function switchTerm(settings: Settings, termId: string): Settings {
  const base = normalizeSettings(settings)
  if (!base.terms!.some((t) => t.id === termId)) throw new Error(`学期不存在：${termId}`)
  return normalizeSettings({ ...base, currentTermId: termId })
}

/** 把顶层 officialCredits 写入当前学期（MIS 导入时用） */
export function setCurrentOfficialCredits(settings: Settings, credits: number | null): Settings {
  const base = normalizeSettings(settings)
  const terms = base.terms!.map((t) => (t.id === base.currentTermId ? { ...t, officialCredits: credits } : t))
  return normalizeSettings({ ...base, terms, officialCredits: credits })
}
