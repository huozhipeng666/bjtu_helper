/**
 * fetch 封装：自动 JSON 序列化/解析，非 2xx 抛错（优先读取后端 error 字段）
 * 一律使用相对路径 /api/...，由 Vite 代理转发到 http://localhost:3001
 */
import type {
  ActivityLevel, AuthResponse, Course, CouplePlan, Feedback, FeedbackReply, FeedbackStats, FeedbackStatus, FeedbackType,
  MonthData, MyFeedbackStats, Overview, Period, PlanInput, Settings, ShareDetail, ShareGroupSummary,
  StationMessage, Task, Term, ThemeMode, User, UserRole, WeekData, Exam, SemesterWeek, WeekOption,
  HomeworkList, DataChange, GradeList, GradeStats, Grade, GradeCourseType,
  CoursewareList, MailDetail, MailListResult
} from './types';

/* 成绩相关类型在本模块里被下游（apps/GradesApp.tsx）从这个入口 import，
   所以显式转出去 —— 否则下游得改路径直接引 './types'，两处来源容易漂移。 */
export type { GradeList, GradeStats, Grade, GradeCourseType };

const TOKEN_KEY = 'bjtu-token';

/* 凭据信封加密：登录 / 注册 / 教务登录的账号密码在发出前用服务端 RSA 公钥加密，
   浏览器不支持或公钥取不到时静默退回明文（详见 lib/credEnvelope.ts 的失败策略说明）。 */
import { encryptCred, resetCredKeyCache } from './lib/credEnvelope';

/**
 * 带凭据信封的请求，服务端换钥后自动重试一次。
 *
 * 背景：服务端默认每次启动**重新生成**一对临时 RSA 密钥（见 server/src/credCrypto.ts
 * 的「密钥生命周期」）。kid 是公钥指纹，客户端把公钥缓存在内存里、整个页面生命周期只取一次。
 * 于是服务重启后，**已经打开着的页面**手里的还是旧公钥：密文发过去解不开，
 * 服务端抛 CRED_KEY_STALE（fail() 映射成 400 + 该文案）。
 *
 * 为什么必须在这里兜住：`resetCredKeyCache()` 早就导出好了，但全仓库没有任何地方调用它 ——
 * 这个分支此前是**死代码**。在只走 HTTP 的年代它碰不到（http 下没有 crypto.subtle，
 * 前端一律走明文，根本不会产生 kid）；上了 HTTPS 并开了 CRED_REQUIRE_ENCRYPTED 之后，
 * 每次发版重启都会让所有已打开的页面在**手动刷新前**持续登录失败。
 *
 * ⚠️ 重试必须**重新加密**，所以加密动作放在 send 回调外面、由本函数持有 fields：
 *   若先把 payload 构造好再重试，发出去的还是那份用旧公钥加密的密文，等于没重试。
 *
 * 只重试一次：第二次仍是 stale 说明不是"换钥"（比如服务端真在反复重启），
 * 再重试只会变成死循环，直接把原始错误抛给调用方。
 */
async function sendWithCredRetry<T>(
  fields: Record<string, string>,
  send: (credEnc: { kid: string; ct: string } | undefined) => Promise<T>
): Promise<T> {
  const attempt = async (): Promise<T> => {
    /* encryptCred 失败时返回 {}（非安全上下文 / 公钥端点挂了）→ 退回明文，
       此时 credEnc 为 undefined，服务端在 CRED_REQUIRE_ENCRYPTED=1 下会明确报 400。 */
    const { credEnc } = await encryptCred(fields);
    return send(credEnc);
  };
  try {
    return await attempt();
  } catch (err) {
    /* 必须严格比对文案：400 还可能是"密码错误""验证码过期"，那些重试毫无意义，
       而且会把一次登录尝试变成两次（验证码被白白消耗掉）。 */
    if (!(err instanceof ApiError) || err.status !== 400) throw err;
    if (!err.message.includes('CRED_KEY_STALE')) throw err;
    resetCredKeyCache();
    return await attempt();
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

const DEFAULT_TIMEOUT_MS = 25_000;
/** 下载类接口的超时：PDF / 课件 / 附件可能有几十 MB，用 25s 会误杀 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * 带 HTTP 状态码的接口错误。
 *
 * ⚠️ 为什么必须把状态码带出来：调用方需要区分「这个 token 真的失效了」和
 *   「服务器暂时不可用」。此前 request() 只抛 `new Error(文案)`，状态码在抛出时丢失，
 *   于是 App 启动逻辑只能 `catch {}` 一把抓 —— 把 429（限流）、5xx、断网、超时
 *   全都当成"登录失效"处理，直接清掉本地 token。结果是**一次瞬时网络抖动就把用户永久登出**，
 *   而且他自己无法恢复（重新打开也还是登录页）。详见 web/src/lib/authRecovery.ts。
 *
 * status = 0 表示请求根本没拿到响应（断网 / DNS / 超时 / 被取消）。
 */
export class ApiError extends Error {
  readonly status: number;

  /**
   * 请求是否被**调用方主动取消**（不是失败）。
   *
   * ⚠️ 为什么必须在 ApiError 上单独记：rawFetch 会把任何 fetch 异常都包装成
   *   `ApiError(name='ApiError')`（为了统一成"网络失败"），于是 `err.name === 'AbortError'`
   *   **再也判不出来**了 —— lib/useAbortController.ts 的 isAbortError() 因此永远返回 false。
   *   后果是每个用了 begin() 的页面在快速切换时都会走 catch 的 else 分支，
   *   把"这次请求本来就是自己取消的"渲染成「加载失败」红字。
   *   这里保留一个显式标记，isAbortError() 会先看它。
   */
  readonly canceled: boolean;

  constructor(message: string, status: number, canceled = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.canceled = canceled;
  }

  /** 请求是否压根没到服务器（断网、超时、被取消） */
  get isNetworkFailure(): boolean {
    return this.status === 0;
  }

  /** 只有它才意味着"凭据无效、必须重新登录" */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * 带超时 + 可外部取消的 fetch。
 *
 * 抽出来是因为「下载接口」和「JSON 接口」都需要同一套 AbortController 逻辑。
 * 此前三个下载函数各自手写 fetch，都没有超时也没有取消 —— 弱网下会**永久挂起**，
 * UI 上的 busy 状态永远不解除，用户只能强杀页面。
 */
async function rawFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      onExternalAbort = () => {
        clearTimeout(timer);
        controller.abort();
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    if (timedOut) {
      // status=0：没拿到任何响应，属于"暂时性失败"，**不等于**登录失效
      throw new ApiError('网络请求超时，请检查网络连接后重试', 0);
    }
    /* 调用方主动 abort（组件卸载、快速切换 tab/群组）不是失败：
       打上 canceled 标记，让 isAbortError() 能认出来，调用方据此跳过报错。
       文案仍按"网络请求失败"给，但正常路径不会显示它。 */
    if (externalSignal?.aborted) {
      throw new ApiError('请求已取消', 0, true);
    }
    throw new ApiError(err instanceof Error ? err.message : '网络请求失败', 0);
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * 同一 URL 的在途请求合并。
 *
 * 为什么需要：几个组件会各自拉同一份数据（例如 CreditSummaryCard 与 ScheduleView 都要课程表），
 * 同时挂载时就是两次一模一样的 GET。这里把并发的相同请求合成一次 —— 只合并**在途**请求，
 * 请求一结束就从表里删掉，所以**不存在缓存过期问题**（下一次调用照常回源）。
 * 带 signal 的请求不合并：取消语义会互相干扰。
 */
const inflightGets = new Map<string, Promise<unknown>>();

export async function request<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method === 'GET' && !options.signal) {
    const hit = inflightGets.get(path);
    if (hit) return hit as Promise<T>;
    const p = requestOnce<T>(path, options).finally(() => inflightGets.delete(path));
    inflightGets.set(path, p);
    return p;
  }
  return requestOnce<T>(path, options);
}

async function requestOnce<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...init } = options;
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  /* RequestInit.signal 的类型是 `AbortSignal | null`，而 rawFetch 的形参只接受
     `AbortSignal | undefined` —— 用 `?? undefined` 把 null 归一，避免多一种空值形态。 */
  const res = await rawFetch(path, { ...init, headers }, timeoutMs, externalSignal ?? undefined);

  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (data && typeof data.error === 'string' && data.error) {
        message = data.error;
      }
    } catch {
      /* 响应体不是 JSON，保留默认错误信息 */
    }
    /* 评审 C3（2026-10-23）：会话中途 401 的统一出口。token 被吊销（管理员重置密码 /
       学号接管）后，此前各页面只显示各自的「加载失败」，用户不知道要重新登录。
       这里识别 401 派发全局事件，App 监听后弹登录引导 —— 一处处理，全站生效。
       排除 /api/auth/*（登录/游客通道自身的 401 是正常业务流，不该连环弹窗）
       与 /api/client-errors（匿名错误上报，无会话概念）。 */
    if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/client-errors')) {
      window.dispatchEvent(new CustomEvent('bjtu:session-expired'));
    }
    throw new ApiError(message, res.status);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('响应格式错误', res.status);
  }
}

/**
 * 下载二进制（PDF / 课件 / 附件），返回 Blob。
 *
 * ⚠️ 不能复用 request()：它会 JSON.parse，二进制会被损坏。
 * 但超时、取消、错误文案映射应当与 request() 完全一致 —— 所以走同一个 rawFetch。
 */
export async function requestBlob(
  path: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Blob> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await rawFetch(path, { headers }, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, options.signal);
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* 非 JSON 就沿用默认文案 */
    }
    /* 与 requestOnce 同款（评审 C3）：下载链路的 401 也要触发统一重登引导 */
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('bjtu:session-expired'));
    }
    throw new ApiError(msg, res.status);
  }
  return res.blob();
}

/**
 * 上报前端运行时错误（白屏、未捕获异常）。
 *
 * 三个刻意的设计：
 * 1. **绝不抛错**：这是诊断通道，不是业务通道。上报失败不能让用户看到第二个错误。
 * 2. **不 await**：调用方通常是崩溃现场，不能因为上报而阻塞渲染。
 * 3. 同一消息只报一次（按 message 去重），避免"崩溃循环"把后端刷满。
 */
const reportedErrors = new Set<string>();
export function reportClientError(message: string, stack?: string): void {
  try {
    const key = String(message).slice(0, 200);
    if (!key || reportedErrors.has(key) || reportedErrors.size > 20) return;
    reportedErrors.add(key);
    const token = getToken();
    // 没有 token 时也照报（登录页崩溃同样需要知道），但不能带 Authorization
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        message: key,
        stack: String(stack ?? '').slice(0, 2000),
        url: location.pathname + location.search,
        ua: navigator.userAgent
      }),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    /* 忽略 */
  }
}


/** 创建/更新任务时可提交的字段（id 与只读 join/服务端字段除外，status 可省，默认 pending） */
export type TaskInput = Omit<Task, 'id' | 'courseName' | 'color' | 'sortOrder' | 'status'> & { status?: Task['status'] };
/** 创建/更新课程时可提交的字段 */
export type CourseInput = Omit<Course, 'id'>;

/* ---------------- 设置 ---------------- */

export function getSettings(signal?: AbortSignal): Promise<Settings> {
  return request<Settings>('/api/settings', signal ? { signal } : {});
}

/* ---------------- 学期（多学期支持） ---------------- */

/** GET /api/terms 的返回：学期列表（含各学期课程数）+ 当前学期 id */
export interface TermListResult {
  terms: Term[];
  currentTermId: string;
}

export function listTerms(signal?: AbortSignal): Promise<TermListResult> {
  return request<TermListResult>('/api/terms', signal ? { signal } : {});
}

/** 新建学期。默认同时切换过去（setCurrent 默认 true） */
export function createTerm(body: {
  name: string;
  startDate: string;
  totalWeeks: number;
  setCurrent?: boolean;
}): Promise<TermListResult & { term: Term }> {
  return request<TermListResult & { term: Term }>('/api/terms', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/** 修改某个学期（id 不变，课程归属不受影响） */
export function updateTerm(
  id: string,
  body: { name?: string; startDate?: string; totalWeeks?: number }
): Promise<TermListResult> {
  return request<TermListResult>(`/api/terms/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

/** 切换当前学期（只改「看哪个学期」，不动数据） */
export function setCurrentTerm(id: string): Promise<TermListResult> {
  return request<TermListResult>(`/api/terms/${encodeURIComponent(id)}/current`, { method: 'PUT' });
}


export function updateSettings(body: {
  /**
   * 当前学期的字段。`weeks` 显式传 `null` 表示「清空周次表，按线性口径解释周次」——
   * 教务（AA）导入给不出周次表，必须显式清掉上一次智慧平台留下的表，
   * 否则换学期后可能拿旧表解释新课表。字段缺席 = 不动它。
   */
  semester?: { name?: string; startDate?: string; totalWeeks?: number; weeks?: SemesterWeek[] | null };
  periods?: Period[];
}): Promise<Settings> {
  return request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
}

/* ---------------- 课程 ---------------- */

export function getCourses(signal?: AbortSignal): Promise<Course[]> {
  return request<Course[]>('/api/courses', signal ? { signal } : {});
}

export function createCourse(body: CourseInput): Promise<Course> {
  return request<Course>('/api/courses', { method: 'POST', body: JSON.stringify(body) });
}

export function updateCourse(id: number, body: Partial<CourseInput>): Promise<Course> {
  return request<Course>(`/api/courses/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function deleteCourse(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/courses/${id}`, { method: 'DELETE' });
}

/**
 * 拍照导入专用：整表替换。
 * 服务端在一个事务里「先删光该用户全部课程，再写入这批课程」，
 * 失败整体回滚，不会出现删了旧的没写进新的。
 */
export interface ReplaceCoursesResult {
  ok: boolean;
  deleted: number;
  imported: number;
  courses: Course[];
}

export function replaceCourses(courses: CourseInput[], officialCredits?: number | null): Promise<ReplaceCoursesResult> {
  return request<ReplaceCoursesResult>('/api/courses/import-replace', {
    method: 'POST',
    body: JSON.stringify({ courses, ...(officialCredits !== undefined ? { officialCredits } : {}) })
  });
}

/* ---------------- 拍照识别课表 ---------------- */

/** 识别结果中的一行错误（对应模型输出的第 index 条） */
export interface RecognizeRowError {
  index: number;
  reason: string;
}

/** 识别出的课程（字段同 CourseInput，warn 为服务端给的非阻塞提醒） */
export interface RecognizedCourse extends CourseInput {
  warn?: string;
}

export interface RecognizePhotoResult {
  /** 清洗校验通过、可直接建课的课程（字段同 CourseInput） */
  courses: RecognizedCourse[];
  errors: RecognizeRowError[];
  /** 实际使用的模型名，便于排查 */
  model: string;
}

export function getRecognizePhotoStatus(): Promise<{ configured: boolean; model: string }> {
  return request<{ configured: boolean; model: string }>('/api/courses/recognize-photo/status');
}

/**
 * 提交识别任务（异步）。HTTP 层立刻返回 jobId（识别在服务端后台跑，绕开代理超时）。
 * 返回的 jobId 用于轮询 getRecognizeJobStatus。
 */
export function submitRecognizePhoto(image: string): Promise<{ jobId: string }> {
  return request<{ jobId: string }>('/api/courses/recognize-photo', {
    method: 'POST',
    body: JSON.stringify({ image })
  });
}

export type RecognizeJobStatus =
  | 'pending' | 'running'            // 还在识别，看 phase
  | 'done'                            // 完成，取 result
  | 'failed';                         // 失败，看 error

export interface RecognizeJobState {
  ok: boolean;
  jobId: string;
  status: RecognizeJobStatus;
  /** 面向用户的进度文案，如"正在识别第 1/2 轮…" */
  phase?: string;
  result?: RecognizePhotoResult;
  error?: string;
}

/** 轮询一次识别任务状态。 */
export function getRecognizeJobStatus(jobId: string): Promise<RecognizeJobState> {
  return request<RecognizeJobState>(`/api/courses/recognize-photo/${encodeURIComponent(jobId)}`);
}

/* ---------------- MIS 一键导入课表 ---------------- */

/**
 * 开启 MIS 登录会话：sid 是后续两步的会话凭证。
 *
 * 2026-10 学校把 MIS 登录换成了 `sso.bjtu.edu.cn` 的统一身份认证（SSO），
 * **没有了图形验证码**，所以这里不再返回验证码图片，只有 sid。
 */
export interface MisSessionStart {
  ok: boolean;
  sid: string;
}

export function startMisSession(): Promise<MisSessionStart> {
  /* 2026-10-23 改 POST：GET /api/mis/session 已让位给会话池探测（probeMisSession），
     开会话带副作用（真实请求学校 SSO），与服务端路由动词对齐。 */
  return request<MisSessionStart>('/api/mis/session', { method: 'POST' });
}

/* ---------------- 学号登录（匿名教务通道） ----------------
 *
 * 与上面 /api/mis/* 的区别：那条要求**已登录**（是"导入课表"用的）；
 * 这条 /api/auth/mis/* 是**登录通道本身** —— 用户此刻还没有账号，正是来登录的。
 *
 * 它也是学号账号唯一的登录方式：这类账号是第一次走教务登录时自动创建的，
 * 本地密码是一串没人知道的随机数（服务端 provisionStudentAccount 每次都会重新轮换），
 * 所以「忘记密码」对他们不成立 —— 用学号 + 教务密码通过学校统一身份认证验证身份，
 * 通过即证明是本人，服务端直接取回（或创建）账号并签发会话。
 *
 * ⚠️ 2026-10 起学校换用 sso.bjtu.edu.cn：没有验证码了，但**首次使用前需要先激活**，
 * 未激活的账号会被 SSO 直接拒绝，服务端会把这种情况翻译成"可能未激活"的提示。
 */

export interface AnonMisSession {
  ok: boolean;
  sid: string;
}

export function startAnonMisSession(): Promise<AnonMisSession> {
  return request<AnonMisSession>('/api/auth/mis/session');
}

export interface AnonMisLoginResult {
  ok: boolean;
  token: string;
  user: User;
  sid: string;
  profile: { name: string; identity: string; department: string };
  /** 本次是否新建了账号（false = 老账号被取回） */
  created: boolean;
}

/**
 * 匿名教务登录（游客 / 首次绑定）。
 *
 * 这里的密码是**学生的统一身份认证密码**（能登进本人的教务账号），是全站最敏感的一类凭据。
 * 走与 login 相同的可选信封（lib/credEnvelope.ts）；服务端 /api/auth/mis/login 已在用
 * readCredField，天然支持。
 */
export async function anonMisLogin(body: {
  sid: string;
  username: string;
  password: string;
}): Promise<AnonMisLoginResult> {
  return sendWithCredRetry({ username: body.username, password: body.password }, (credEnc) => {
    const payload = credEnc ? { sid: body.sid, credEnc } : body;
    return request<AnonMisLoginResult>('/api/auth/mis/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  });
}

/** MIS 登录成功返回的身份信息（来自 mis/home 页面） */
export interface MisProfile {
  ok: boolean;
  name: string;
  identity: string;
  department: string;
}

/** 登录教务系统并建立会话（凭据走可选信封，见 lib/credEnvelope.ts）。 */
export async function misLogin(body: {
  sid: string;
  username: string;
  password: string;
}): Promise<MisProfile> {
  return sendWithCredRetry({ username: body.username, password: body.password }, (credEnc) => {
    const payload = credEnc ? { sid: body.sid, credEnc } : body;
    return request<MisProfile>('/api/mis/login', { method: 'POST', body: JSON.stringify(payload) });
  });
}

/* ---------------- 学号登录（匿名教务通道） ----------------
 *
 * 与上面 /api/mis/* 的区别：那条要求**已登录**（是"导入课表"用的）；
 * 这条 /api/auth/mis/* 是**登录通道本身** —— 用户此刻还没有账号，正是来登录的。
 *
 * 它也是学号账号唯一的登录方式：这类账号是第一次走教务登录时自动创建的，
 * 本地密码是一串没人知道的随机数（服务端 provisionStudentAccount 每次都会重新轮换），
 * 所以「忘记密码」对他们不成立 —— 用学号 + 教务密码通过学校 CAS 验证身份，
 * 通过即证明是本人，服务端直接取回（或创建）账号并签发会话。
 */

/** MIS 解析出的课程（字段同 CourseInput，可直接交给 replaceCourses 整表覆盖） */
export type MisCourse = CourseInput

/** 教务页面识别出的学期信息；两项都可能为 null（页面没给就识别不到） */
export interface MisSemesterInfo {
  /** 学期第一周的周一 YYYY-MM-DD */
  startDate: string | null;
  totalWeeks: number | null;
  /** 命中来源说明，例如「开学日来自页面"开学日期"；周数来自页面"共 X 周"」 */
  source: string | null;
}

/** MIS 拉课表结果：courses 为逐节课程；totalCredits 为 AA 页面上方官方"总学分"（可能抓不到=null） */
export interface MisCoursesResult {
  ok: boolean;
  courses: MisCourse[];
  totalCredits: number | null;
  semester: MisSemesterInfo | null;
}

export function misCourses(sid: string): Promise<MisCoursesResult> {
  return request<MisCoursesResult>('/api/mis/courses', {
    method: 'POST',
    body: JSON.stringify({ sid })
  });
}

/**
 * 智慧课程平台「课表」导入结果。
 *
 * 与 `MisCoursesResult` 的关键差别是多了 `weeks` —— 平台的**权威周次表**
 * （每周的起止日期 + 是否有课）。导入时要把它一并写进学期设置，周/月视图
 * 才能把日期正确换算成教学周（学校放假的周会整周跳过，不再整体错位）。
 */
export interface MisTimetableResult {
  ok: boolean;
  courses: MisCourse[];
  /** 权威周次表，写入 Settings.semester.weeks */
  weeks: SemesterWeek[];
  /** 周次下拉可选项（教学周 + 放假周）；`week === null` 的即放假周 */
  weekOptions: WeekOption[];
  /** 学期第一周的周一 */
  startDate: string;
  /** 教学周总数 */
  totalWeeks: number;
  /** 抓取失败的周号（网络抖动）；非空时数据可能不全 */
  failedWeeks: number[];
  /** 从教务课程列表匹配到学分的课程数 */
  creditHits: number;
  /** 教务侧失败原因（只影响学分，不影响课表）；成功为 null */
  aaError: string | null;
}

export function misTimetable(sid: string): Promise<MisTimetableResult> {
  return request<MisTimetableResult>('/api/mis/timetable', {
    method: 'POST',
    body: JSON.stringify({ sid })
  });
}

export function destroyMisSession(sid: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/mis/session', {
    method: 'DELETE',
    body: JSON.stringify({ sid })
  });
}

/**
 * 会话池探测（2026-10-14）：当前用户是否已有可复用的教务登录。
 *
 * 教务类应用（课件 / 邮箱 / 成绩单 / 数据同步）打开时先调它：
 *   - `has: true` → 直接拿 `sid` 使用（= "打开应用自动登录"，不用再输学号 / 密码 / 验证码）；
 *   - `has: false` → 显示登录表单；登录一次后全部教务应用共享该会话（不活跃 2 小时过期）。
 */
export interface MisSessionProbe {
  ok: boolean;
  has: boolean;
  /** 可复用的 MIS 会话句柄（has=true 时存在） */
  sid?: string;
  /** 登录人姓名（供 UI 显示"已登录"状态） */
  name?: string;
}

export function probeMisSession(): Promise<MisSessionProbe> {
  return request<MisSessionProbe>('/api/mis/session');
}


/* ---------------- 考务（考试安排） ---------------- */

/** MIS 解析出的考试（字段与后端 ExamInput 对齐） */
export interface MisExam {
  courseName: string
  examDate: string
  startTime: string
  endTime: string
  location: string
  seat: string
  note: string
}

/** MIS 拉考试结果：exams 为解析出的考试安排；path 为命中的 AA 页面路径（未命中为 null） */
export interface MisExamsResult {
  ok: boolean
  exams: MisExam[]
  path: string | null
  tried: string[]
}

export function misExams(sid: string): Promise<MisExamsResult> {
  return request<MisExamsResult>('/api/mis/exams', {
    method: 'POST',
    body: JSON.stringify({ sid })
  })
}

/** 列出考试（按日期升序） */
export function getExams(signal?: AbortSignal): Promise<Exam[]> {
  return request<Exam[]>('/api/exams', signal ? { signal } : {})
}

/** 手动添加一条考试 */
export interface ExamInput {
  courseName: string
  examDate: string
  startTime?: string
  endTime?: string
  location?: string
  seat?: string
  note?: string
}

export function createExam(body: ExamInput): Promise<Exam> {
  return request<Exam>('/api/exams', { method: 'POST', body: JSON.stringify(body) })
}

export function deleteExam(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/exams/${id}`, { method: 'DELETE' })
}

/** 单条考试转 DDL：已转过则复用原任务 */
export interface ExamToTaskResult {
  ok: boolean
  taskId: number
  created: boolean
  task: Task
}

export function examToTask(id: number): Promise<ExamToTaskResult> {
  return request<ExamToTaskResult>(`/api/exams/${id}/to-task`, { method: 'POST' })
}

/** 整表覆盖导入 + 可选一键生成 DDL（createDdl=true 时为每场考试自动建一条考试任务） */
export interface ImportExamsResult {
  ok: boolean
  deleted: number
  imported: number
  taskCreated: number
  taskReused: number
  exams: Exam[]
}

export function importExams(exams: ExamInput[], createDdl?: boolean): Promise<ImportExamsResult> {
  return request<ImportExamsResult>('/api/exams/import', {
    method: 'POST',
    body: JSON.stringify({ exams, createDdl: createDdl === true })
  })
}

/* ---------------- 任务 ---------------- */

export interface TaskQuery {
  status?: string;
  type?: string;
  from?: string;
  to?: string;
}

export function getTasks(query: TaskQuery = {}, signal?: AbortSignal): Promise<Task[]> {
  const qs = new URLSearchParams();
  if (query.status) qs.set('status', query.status);
  if (query.type) qs.set('type', query.type);
  if (query.from) qs.set('from', query.from);
  if (query.to) qs.set('to', query.to);
  const s = qs.toString();
  return request<Task[]>(`/api/tasks${s ? `?${s}` : ''}`, signal ? { signal } : {});
}

export function createTask(body: TaskInput): Promise<Task> {
  return request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
}

export function updateTask(id: number, body: Partial<TaskInput>): Promise<Task> {
  return request<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function deleteTask(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' });
}

export function toggleTask(id: number): Promise<Task> {
  return request<Task>(`/api/tasks/${id}/toggle`, { method: 'POST' });
}

/** 手动排序：ids 顺序即目标顺序 */
export function reorderTasks(ids: number[]): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/tasks/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
}

/** 一键清空已完成任务，返回删除条数 */
export function clearDoneTasks(): Promise<{ ok: boolean; deleted: number }> {
  return request<{ ok: boolean; deleted: number }>('/api/tasks/clear-done', { method: 'POST' });
}

/* ---------------- 周视图 & 月视图 & 概览 ---------------- */

export function getWeek(
  date?: string,
  signal?: AbortSignal,
  opts: { inactive?: boolean } = {}
): Promise<WeekData> {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  /* inactive=1：额外带回「本学期有课但本周不上」的课程（课表页「显示非本周课程」开关）。
     显式开关而不是默认返回：这份数据通常是本周课程的一两倍，多数用户并不需要。 */
  if (opts.inactive) qs.set('inactive', '1');
  const s = qs.toString();
  return request<WeekData>(`/api/week${s ? `?${s}` : ''}`, signal ? { signal } : {});
}

export function getMonth(date?: string, signal?: AbortSignal): Promise<MonthData> {
  return request<MonthData>(`/api/month${date ? `?date=${date}` : ''}`, signal ? { signal } : {});
}

export function getOverview(signal?: AbortSignal): Promise<Overview> {
  return request<Overview>('/api/overview', signal ? { signal } : {});
}

/**
 * 首页聚合：一次拿到「本周 + 概览 + 考试」。
 *
 * 为什么合并：首页此前打 3 个接口，每个都要过一次鉴权、各自带一份任务数据；
 * 合并后是 1 个往返（4G 下省 2 个 RTT ≈ 100~200ms），服务端也少一次 listTasks。
 * 保留 getWeek / getOverview / getExams 不动：课表页、DDL 页、考试卡片仍各自需要其中一部分。
 */
export interface HomePayload {
  week: WeekData;
  overview: Overview;
  exams: Exam[];
}

export function getHome(date?: string, signal?: AbortSignal): Promise<HomePayload> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<HomePayload>(`/api/home${qs}`, signal ? { signal } : {});
}

/* ---------------- 首页账户状态（新邮件 / 校园卡 / 校园网） ---------------- */

/** 三个字段都是学校平台的**原始文本**，不做格式化 */
export interface HomeStatus {
  newMailCount: string
  campusCardBalance: string
  networkBalance: string
}

export interface HomeStatusFlags {
  hasNewMail: boolean
  /** 余额 < 20 元 */
  campusCardLow: boolean
  /** 余额恰好为 0 */
  networkEmpty: boolean
}

/**
 * 拉首页账户状态。
 *
 * ⚠️ 失败是常态（学校接口偶发抽风、会话过期），调用方**不能**让它拖垮首页：
 * 状态卡单独显示错误，其它区块照常。
 */
export function getHomeStatus(
  sid: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: HomeStatus; flags: HomeStatusFlags }> {
  return request<{ ok: boolean; status: HomeStatus; flags: HomeStatusFlags }>(
    `/api/home/status?sid=${encodeURIComponent(sid)}`,
    signal ? { signal } : {}
  )
}

/* ---------------- 学业日历（权威教学周） ---------------- */

/** 一周的学业日历状态 */
export interface AcademicWeek {
  /** 教学周号；非教学周为 null（不是 0 —— 0 在别处代表"开学前"） */
  teachingWeek: number | null
  kind: 'teaching' | 'holiday' | 'gap'
  monday: string
  sunday: string
  /** 平台原始标签（`第3教学周` / `休` / 空串），排错用 */
  raw: string
}

export interface AcademicSemesterSummary {
  id: number
  title: string
  academicYear: string
  term: number
  /** 该学期一共有几周数据（不是教学周数） */
  weeks: number
}

export interface AcademicCalendarPayload {
  ok: boolean
  /** 服务器当天日期 YYYY-MM-DD（判断基于它，不是浏览器本地时间） */
  today: string
  current: {
    id: number
    title: string
    academicYear: string
    term: number
    /** 第一个教学周的周一 —— 可直接填进「学期设置 → 开学日」 */
    firstMonday: string | null
    totalWeeks: number
  } | null
  week: AcademicWeek | null
  semesters: AcademicSemesterSummary[]
}

/**
 * 拉学校权威学业日历。
 *
 * **免登录**：学校这个页面是公开的，游客也能看「今天是第几教学周」。
 * 失败（校外网络屏蔽、学校改版）时抛错，调用方应当静默降级到本地推算，
 * 不要因为校历拿不到就在首页显示错误 —— 本地的周次表仍然可用。
 */
export function getAcademicCalendar(signal?: AbortSignal): Promise<AcademicCalendarPayload> {
  return request<AcademicCalendarPayload>('/api/calendar/academic', signal ? { signal } : {})
}

/* ---------------- 认证 ---------------- */

/** 注册字段：昵称 + 账号（邮箱或学号）+ 密码两遍 + 图形验证码 */
export interface RegisterInput {
  nickname: string;
  username: string;
  password: string;
  confirmPassword: string;
  captchaId: string;
  captchaCode: string;
}

/**
 * 注册。
 *
 * 与 login 同口径加密：账号 + 两遍密码都进信封。**必须同时加密 confirmPassword** ——
 * 只加密 password 的话，明文里就还留着一个"两遍密码之一"，加密的意义就没了
 * （服务端 readCredField 对每个字段都先看信封、再回退明文，两者可以独立命中）。
 * 验证码 id/code 不敏感，留在明文体里。
 *
 * ⚠️ 与小程序的差异：小程序自己的 secureCred.js 也会加密注册的两个密码字段，
 *    这里保持字段名一致（username / password / confirmPassword），服务端无需分支。
 */
export async function register(input: RegisterInput): Promise<AuthResponse> {
  return sendWithCredRetry(
    { username: input.username, password: input.password, confirmPassword: input.confirmPassword },
    (credEnc) => {
      const body = credEnc
        ? { ...input, username: undefined, password: undefined, confirmPassword: undefined, credEnc }
        : input;
      return request<AuthResponse>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }
  );
}

/**
 * 登录。
 *
 * 用户名/密码走**可选的**信封加密（见 lib/credEnvelope.ts）：能加密就只发密文，
 * 加密不可用（非安全上下文 / 公钥端点失败）时退回明文，行为与以前完全一致。
 * 其余字段（captchaId）本来就是公开的，不加密，也不进明文体 ——
 * 加密后 body 里**不应再出现** password 字段，否则这层就白做了。
 */
export async function login(username: string, password: string): Promise<AuthResponse> {
  return sendWithCredRetry({ username, password }, (credEnc) => {
    const body = credEnc
      ? JSON.stringify({ credEnc })
      : JSON.stringify({ username, password });
    return request<AuthResponse>('/api/auth/login', { method: 'POST', body });
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function me(): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/me');
}

/* ---------------- 忘记密码 ---------------- */

/* ---------------- 忘记密码（当前未在界面上暴露） ----------------
 *
 * ⚠️ 这四个函数对应的服务端接口**存在且可用，但界面上暂时没有入口**。
 *   原因：学号账号（占全部账号的 94%）本来就没有站点密码，他们的"找回账号"
 *   是走教务验证（见下面的 anonMisLogin），而不是重置密码。
 *   因此原先那套「留联系方式 → 管理员人工核实 → 批准」的申请流程被撤下了界面：
 *   站主明确表示逐个加 QQ/微信 核实不现实。
 *
 *   保留它们是为了以后有需要时能一行代码重新启用（例如开通 HTTPS 后改为邮件自助重置，
 *   或给邮箱注册的账号留一条人工兜底）。邮箱账号忘记密码目前可由管理员在
 *   用户管理里直接重置（POST /api/admin/users/:id/reset-password）。
 */

export interface PasswordResetInput {
  username: string;
  newPassword: string;
  /** QQ / 微信 / 手机号，管理员核实身份用 */
  contact: string;
  note?: string;
}

export function requestPasswordReset(input: PasswordResetInput): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('/api/auth/password-reset', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export interface PasswordResetRequest {
  id: number;
  userId: number;
  username: string;
  nickname: string;
  contact: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  handledAt: string | null;
}

export function getPasswordResets(signal?: AbortSignal): Promise<{ requests: PasswordResetRequest[]; pending: number }> {
  return request<{ requests: PasswordResetRequest[]; pending: number }>('/api/admin/password-resets', signal ? { signal } : {});
}

export function approvePasswordReset(id: number): Promise<{ ok: boolean; username: string }> {
  return request<{ ok: boolean; username: string }>(`/api/admin/password-resets/${id}/approve`, { method: 'POST' });
}

export function rejectPasswordReset(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/admin/password-resets/${id}/reject`, { method: 'POST' });
}

/* ---------------- 未登录游客（一次性账号） ----------------
 *
 * 未登录用户拿到的也是一个**真实 token**（服务端签发的游客会话），所以上面所有业务
 * 接口对游客天然可用，这里只需要三个与「游客身份本身」相关的接口。
 *
 * 关键约定：游客 token 就存在 TOKEN_KEY 里，与登录后的 token 是同一个位置。
 * 因此登录时要先把旧 token（= 游客 token）**读出来留在内存里**，再 setToken(新 token)，
 * 最后用内存里那个游客 token 调 claimGuest —— 顺序反了就拿不到游客身份了。
 */

/** 签发（或复用）一个游客账号。服务端幂等：已持有效游客 token 时原样返回。 */
export function guestLogin(): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/guest', { method: 'POST' });
}

/**
 * 并发去重的游客建号 —— 页面启动与登出都走它。
 *
 * 为什么需要：React 18 的 StrictMode 在开发环境会把 mount effect 跑两遍，
 * 两次都会看到"没有 token"→ 各发一次 `POST /api/auth/guest`，多出来的那个游客账号
 * 没人使用，只能等 14 天 TTL 才被回收。生产构建不受 StrictMode 影响，
 * 但"effect 重复执行"还可能来自父级 key 变化等别的原因，这里统一兜住。
 *
 * 注意：请求结束后就释放（不缓存结果）—— 下一次调用应该是真的想重新建号
 * （例如登出后），缓存住会让登出拿不到新游客身份。
 */
let guestSessionPromise: Promise<AuthResponse> | null = null
export function ensureGuestSession(): Promise<AuthResponse> {
  if (!guestSessionPromise) {
    guestSessionPromise = guestLogin().finally(() => {
      guestSessionPromise = null
    });
  }
  return guestSessionPromise;
}

/** 游客名下的数据量（登录后询问「合并 / 覆盖 / 不用了」时给用户看） */
export interface GuestDataCounts {
  courses: number;
  tasks: number;
  exams: number;
  feedbacks: number;
  messages: number;
  hasSettings: boolean;
}

export interface GuestPendingResult {
  ok: boolean;
  /** 游客侧是否有值得迁移的数据（课程 / DDL / 考试 / 反馈） */
  hasGuest: boolean;
  guest?: GuestDataCounts;
  target?: GuestDataCounts;
}

/** 登录后探测游客侧与当前账号各有多少数据（需要**真实账号** token + 游客 token 头） */
export function getGuestPending(guestToken: string): Promise<GuestPendingResult> {
  return request<GuestPendingResult>('/api/auth/guest/pending', {
    headers: { 'X-Guest-Token': guestToken }
  });
}

export type GuestClaimMode = 'merge' | 'replace' | 'discard';

export interface GuestClaimResult {
  ok: boolean;
  mode: GuestClaimMode;
  courses: number;
  tasks: number;
  exams: number;
  feedbacks: number;
  messages: number;
}

/**
 * 把未登录期间产生的数据迁移到当前登录账号。
 * `merge`=合并去重（默认）/ `replace`=覆盖 / `discard`=丢弃。
 * 成功后游客账号即被删除，重复调用返回 409（可安全忽略）。
 */
export function claimGuest(guestToken: string, mode: GuestClaimMode): Promise<GuestClaimResult> {
  return request<GuestClaimResult>('/api/auth/guest/claim', {
    method: 'POST',
    body: JSON.stringify({ guestToken, mode })
  });
}

/** 标记新用户引导已看过（幂等，重复调用无副作用） */
export function markOnboarded(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/auth/onboarded', { method: 'POST' });
}

/** 获取图形验证码（SVG 字符串直接用 innerHTML 渲染，内容由服务端固定字符集生成） */
export function getCaptcha(): Promise<{ id: string; svg: string; expiresAt: string }> {
  return request<{ id: string; svg: string; expiresAt: string }>('/api/auth/captcha');
}

export interface ProfilePatch {
  nickname?: string;
  /** data URL；传空字符串表示删除头像 */
  avatar?: string | null;
  theme?: ThemeMode;
  /** 自选主题色：色相数值字符串（0-359）；null = 恢复默认青绿 */
  accent?: string | null;
}

/** 更新昵称 / 头像 / 主题，返回最新的用户信息 */
export function updateProfile(patch: ProfilePatch): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(patch)
  });
}

/* ---------------- 管理员（用户管理） ---------------- */

export interface AdminUser {
  id: number;
  username: string;
  nickname: string;
  role: UserRole;
  createdAt: string;
  courseCount: number;
  taskCount: number;
  /** 最后访问时间（服务端节流记录，UTC 'YYYY-MM-DD HH:mm:ss'；null = 从未记录） */
  lastSeenAt: string | null;
  /** 提交过的反馈工单数 / 其中待处理数（论坛下架后取代原 postCount/commentCount 口径） */
  feedbackCount: number;
  feedbackPending: number;
  /** 最后一次提交反馈的时间（null = 从未） */
  lastFeedbackAt: string | null;
  /** 最后活跃 = max(最后访问, 最后提交反馈)；null = 无任何活跃痕迹 */
  lastActivityAt: string | null;
  /** 活跃度分级，由服务端判定 */
  level: ActivityLevel;
}

/** 全站概览统计（管理员看板顶部） */
export interface AdminStats {
  /** 真实用户数（**不含游客**，与用户列表口径一致） */
  totalUsers: number;
  adminCount: number;
  active7d: number;
  active30d: number;
  neverActive: number;
  newToday: number;
  new7d: number;
  /** 当前存在的一次性游客账号数（待 TTL 回收；不计入 totalUsers） */
  guestCount: number;
  /** 真实用户的课程 / DDL 总数（不含游客数据） */
  courseCount: number;
  taskCount: number;
  /** 反馈工单总数 / 其中待处理数（**包含游客提交的**，那也要处理） */
  feedbackCount: number;
  feedbackPending: number;
  /** 待处理的密码重置申请数（走不通登录的用户全靠这条通道，积压要及时清） */
  resetPending: number;
}

/** 单个用户的活跃度明细 */
export interface AdminUserActivity {
  user: {
    id: number;
    username: string;
    nickname: string;
    role: UserRole;
    createdAt: string;
    lastSeenAt: string | null;
  };
  counts: { courses: number; tasks: number; feedbacks: number; feedbackPending: number };
  lastActivityAt: string | null;
  level: ActivityLevel;
  recent: Array<{
    kind: 'feedback';
    id: number;
    text: string;
    feedbackType: FeedbackType;
    status: FeedbackStatus;
    createdAt: string;
  }>;
}

/** 用户管理列表（评审 A6，2026-10-23 起分页）：随注册数增长，一次只拉一页。 */
export interface AdminUserPage {
  items: AdminUser[];
  total: number;
}

export function getAdminUsers(opts: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<AdminUserPage> {
  const p = new URLSearchParams();
  if (opts.offset !== undefined) p.set('offset', String(opts.offset));
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  const qs = p.toString();
  return request<AdminUserPage>(`/api/admin/users${qs ? `?${qs}` : ''}`, opts.signal ? { signal: opts.signal } : {});
}

export function getAdminStats(signal?: AbortSignal): Promise<AdminStats> {
  return request<AdminStats>('/api/admin/stats', signal ? { signal } : {});
}

export function getAdminUserActivity(id: number, signal?: AbortSignal): Promise<AdminUserActivity> {
  return request<AdminUserActivity>(`/api/admin/users/${id}/activity`, signal ? { signal } : {});
}

/**
 * 后台建号。
 *
 * 账号与密码走与登录相同的信封（见 lib/credEnvelope.ts）：`CRED_REQUIRE_ENCRYPTED=1`
 * 打开后服务端不再接受明文密码，这条链路也不例外 —— 它是全站**唯一**能写入
 * "别人的密码"的入口，让它收明文等于给强制加密开一个最难被注意到的后门。
 *
 * 注意 body 里刻意不再带 username/password 明文（与 web/src/api.ts 的 login 一致）：
 * 加密之后还留着明文字段，这层就白做了。
 */
export async function createAdminUser(body: { username: string; password: string; nickname?: string; role: UserRole }): Promise<User> {
  return sendWithCredRetry(
    { username: body.username, password: body.password },
    (credEnc) =>
      request<User>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ nickname: body.nickname, role: body.role, credEnc })
      })
  );
}

export function updateAdminUser(id: number, body: { username?: string; role?: UserRole }): Promise<User> {
  return request<User>(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

/** 后台重置密码。理由同 createAdminUser：新密码只以密文出站。 */
export async function resetAdminUserPassword(id: number, password: string): Promise<{ ok: boolean }> {
  return sendWithCredRetry(
    { password },
    (credEnc) =>
      request<{ ok: boolean }>(`/api/admin/users/${id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ credEnc })
      })
  );
}

export function deleteAdminUser(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

/** 管理员查看某个用户的课表：返回目标用户摘要 + 其全部课程（按周一次序） */
export interface AdminUserCourses {
  user: { id: number; username: string; nickname: string; role: UserRole };
  courses: Course[];
}

export function getAdminUserCourses(id: number): Promise<AdminUserCourses> {
  return request<AdminUserCourses>(`/api/admin/users/${id}/courses`);
}

/* 补种示例数据接口（POST /api/admin/seed-demo）已移除：
   新用户注册不再写入示例课程/DDL，管理员后台也不需要补种入口。 */

/* ---------------- 个人中心：反馈工单 ---------------- */

export function createFeedback(body: {
  type: FeedbackType;
  title: string;
  content: string;
  contact?: string;
  images?: string[];
}): Promise<{ id: number }> {
  return request('/api/feedback', { method: 'POST', body: JSON.stringify(body) });
}

/** 反馈图片上传：dataURL → 服务端落盘，返回 /uploads/ 相对路径（与旧论坛上传同一套机制） */
export function uploadFeedbackImage(dataUrl: string): Promise<{ url: string }> {
  return request<{ url: string }>('/api/feedback/upload', { method: 'POST', body: JSON.stringify({ data: dataUrl }) });
}

export function listMyFeedbacks(signal?: AbortSignal): Promise<Feedback[]> {
  return request<Feedback[]>('/api/feedback/mine', signal ? { signal } : {});
}

export function getMyFeedbackStats(signal?: AbortSignal): Promise<MyFeedbackStats> {
  return request<MyFeedbackStats>('/api/feedback/mine/stats', signal ? { signal } : {});
}

export function getFeedbackDetail(id: number, signal?: AbortSignal): Promise<{ feedback: Feedback; replies: FeedbackReply[] }> {
  return request(`/api/feedback/${id}`, signal ? { signal } : {});
}

/* ---------------- 反馈工单（管理员） ---------------- */

export function listAllFeedbacks(
  opts: { type?: FeedbackType; status?: FeedbackStatus; q?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<{ items: Feedback[]; total: number }> {
  const qs = new URLSearchParams();
  if (opts.type) qs.set('type', opts.type);
  if (opts.status) qs.set('status', opts.status);
  if (opts.q && opts.q.trim()) qs.set('q', opts.q.trim());
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.offset) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? '?' + qs.toString() : '';
  return request(`/api/feedback/admin${suffix}`, signal ? { signal } : {});
}

export function getFeedbackStats(signal?: AbortSignal): Promise<FeedbackStats> {
  return request<FeedbackStats>('/api/feedback/admin/stats', signal ? { signal } : {});
}

/** 管理员回复工单：服务端会同时写入站内信并置状态为 replied */
export function replyFeedback(id: number, content: string): Promise<FeedbackReply> {
  return request(`/api/feedback/${id}/reply`, { method: 'POST', body: JSON.stringify({ content }) });
}

export function setFeedbackStatus(id: number, status: FeedbackStatus): Promise<{ ok: boolean; status: FeedbackStatus }> {
  return request(`/api/feedback/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

/* ---------------- 个人中心：站内信 ---------------- */

export function listMessages(unreadOnly = false, signal?: AbortSignal): Promise<StationMessage[]> {
  return request<StationMessage[]>(`/api/messages${unreadOnly ? '?unread=1' : ''}`, signal ? { signal } : {});
}

export function getUnreadMessageCount(signal?: AbortSignal): Promise<{ count: number }> {
  return request<{ count: number }>('/api/messages/unread-count', signal ? { signal } : {});
}

export function readMessage(id: number): Promise<{ ok: boolean }> {
  return request(`/api/messages/${id}/read`, { method: 'POST' });
}

export function readAllMessages(): Promise<{ ok: boolean; changed: number }> {
  return request('/api/messages/read-all', { method: 'POST' });
}

/* ---------------- 日历订阅 ---------------- */

export function getCalendarToken(): Promise<{ feedToken: string }> {
  return request('/api/calendar/token');
}

export function regenerateCalendarToken(): Promise<{ feedToken: string }> {
  return request('/api/calendar/token', { method: 'POST' });
}

/* ---------------- 共享课表（空闲课表 / 情侣课表） ----------------

   两套形态共用这一组接口，靠 group.kind 区分（见 server/src/share.ts 文件头）。
   全部要求**真实账号**：游客 token 调这些接口会被服务端 403 拦下（requireRealUser），
   前端在 App 层先做登录引导，避免用户填完密钥才被拒。 */

export function listShareGroups(signal?: AbortSignal): Promise<{ groups: ShareGroupSummary[] }> {
  return request<{ groups: ShareGroupSummary[] }>('/api/share/groups', signal ? { signal } : {});
}

export function createShareGroup(body: { name: string; threshold?: number }): Promise<{ group: ShareGroupSummary }> {
  return request<{ group: ShareGroupSummary }>('/api/share/groups', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function joinShareGroup(secret: string): Promise<{ ok: boolean; id: number }> {
  return request<{ ok: boolean; id: number }>('/api/share/groups/join', {
    method: 'POST',
    body: JSON.stringify({ secret })
  });
}

export function getShareDetail(id: number, signal?: AbortSignal): Promise<ShareDetail> {
  return request<ShareDetail>(`/api/share/groups/${id}`, signal ? { signal } : {});
}

export function updateShareGroup(
  id: number,
  patch: {
    name?: string;
    threshold?: number;
    /** 三个纪念日：传 null 表示清空，传 undefined（不传）表示不动它 */
    anniversary?: string | null;
    birthday?: string | null;
    nextMeet?: string | null;
  }
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/share/groups/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
}

/** 解散群组（群主）。成员退出请用 leaveShareGroup，两者后果不同，不要混用 */
export function disbandShareGroup(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/share/groups/${id}`, { method: 'DELETE' });
}

/** 把我的课表同步进群组（服务端生成忙闲快照，周次口径只在服务端实现一份） */
export function syncShareGroup(id: number): Promise<{ ok: boolean; syncedAt: string | null }> {
  return request<{ ok: boolean; syncedAt: string | null }>(`/api/share/groups/${id}/sync`, { method: 'POST' });
}

export function rotateShareSecret(id: number): Promise<{ ok: boolean; secret: string }> {
  return request<{ ok: boolean; secret: string }>(`/api/share/groups/${id}/rotate-secret`, { method: 'POST' });
}

/** 我自己的隐私开关：是否把课程明细共享给同群成员（仅情侣形态生效） */
export function setSharePrivacy(id: number, showDetail: boolean): Promise<{ ok: boolean; showDetail: boolean }> {
  return request<{ ok: boolean; showDetail: boolean }>(`/api/share/groups/${id}/privacy`, {
    method: 'PUT',
    body: JSON.stringify({ showDetail })
  });
}

export function removeShareMember(groupId: number, memberId: number): Promise<{ ok: boolean; disbanded: boolean }> {
  return request<{ ok: boolean; disbanded: boolean }>(`/api/share/groups/${groupId}/members/${memberId}`, {
    method: 'DELETE'
  });
}

export function leaveShareGroup(id: number): Promise<{ ok: boolean; disbanded: boolean }> {
  return request<{ ok: boolean; disbanded: boolean }>(`/api/share/groups/${id}/leave`, { method: 'POST' });
}

/* ---- 情侣课表（同一套群组模型，kind='couple'） ---- */

export interface CoupleResult {
  couple: ShareGroupSummary | null;
  detail?: ShareDetail;
}

export function getCouple(signal?: AbortSignal): Promise<CoupleResult> {
  return request<CoupleResult>('/api/share/couple', signal ? { signal } : {});
}

export function createCouple(name?: string): Promise<{ group: ShareGroupSummary }> {
  return request<{ group: ShareGroupSummary }>('/api/share/couple', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
}

export function joinCouple(secret: string): Promise<{ ok: boolean; id: number }> {
  return request<{ ok: boolean; id: number }>('/api/share/couple/join', {
    method: 'POST',
    body: JSON.stringify({ secret })
  });
}

export function unbindCouple(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/share/couple', { method: 'DELETE' });
}

/* ---- 共同计划 ----

   服务端权威：这些写接口都返回**更新后的整条 plan**，调用方必须用它覆盖本地状态，
   而不是自己推算一个 status。理由见 types.ts 的 CouplePlan 注释。 */

export function listCouplePlans(signal?: AbortSignal): Promise<{ plans: CouplePlan[] }> {
  return request<{ plans: CouplePlan[] }>('/api/share/couple/plans', signal ? { signal } : {});
}

export function createCouplePlan(body: PlanInput): Promise<{ plan: CouplePlan }> {
  return request<{ plan: CouplePlan }>('/api/share/couple/plans', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/** 对方回应：accept 接受 / decline 婉拒（只有非发起人能调，服务端会 403 拦自问自答） */
export function respondCouplePlan(id: number, action: 'accept' | 'decline'): Promise<{ plan: CouplePlan }> {
  return request<{ plan: CouplePlan }>(`/api/share/couple/plans/${id}/respond`, {
    method: 'POST',
    body: JSON.stringify({ action })
  });
}

/** 修改计划（只有发起人）。改时间/标题/地点会让计划退回 pending 并通知对方重新确认 */
export function updateCouplePlan(id: number, body: Partial<PlanInput>): Promise<{ plan: CouplePlan }> {
  return request<{ plan: CouplePlan }>(`/api/share/couple/plans/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

export function cancelCouplePlan(id: number): Promise<{ plan: CouplePlan }> {
  return request<{ plan: CouplePlan }>(`/api/share/couple/plans/${id}`, { method: 'DELETE' });
}

/* ==================== 「应用」模块 ==================== */

/** 课程平台作业列表（只读；数据由 syncMis 落库） */
export function listHomework(signal?: AbortSignal): Promise<HomeworkList> {
  return request<HomeworkList>('/api/homework', { signal });
}

/** 成绩列表 + 统计（只读；数据由 syncMis 落库） */
export function listGrades(signal?: AbortSignal): Promise<GradeList> {
  return request<GradeList>('/api/grades', { signal });
}

/* ---------------- 作业详情与附件（需 MIS 会话） ---------------- */

/** 老师上传的附件（`sourcePath` 已在服务端剥离，前端拿不到也不需要） */
export interface HomeworkAttachment {
  id: number
  fileName: string
  /** 0 = 平台没给大小（不是空文件） */
  sizeBytes: number
}

export interface HomeworkDetail {
  upId: number
  /** 详情正文（可能比列表里的 content 更完整） */
  content: string
  attachments: HomeworkAttachment[]
  /** 缓存时间（本地墙上时间字符串） */
  fetchedAt: string
}

/**
 * 拉取作业详情（正文 + 老师附件）。
 *
 * `refresh=true` 绕过缓存强制重拉 —— 用户明确点「刷新附件」时才传，
 * 默认走缓存（附件列表不会天天变，而每次重拉要几秒）。
 */
export function getHomeworkDetail(
  sid: string,
  upId: number,
  refresh = false
): Promise<{ ok: boolean; cached: boolean; detail: HomeworkDetail }> {
  const q = new URLSearchParams({ sid, upId: String(upId) });
  if (refresh) q.set('refresh', '1');
  return request<{ ok: boolean; cached: boolean; detail: HomeworkDetail }>(`/api/homework/detail?${q.toString()}`);
}

/**
 * 下载老师附件，返回 Blob 由前端触发保存。
 * ⚠️ 不能复用 request()：二进制流会被 JSON.parse 损坏。
 */
export async function downloadHomeworkAttachment(
  sid: string,
  upId: number,
  attachmentId: number
): Promise<Blob> {
  return requestBlob(
    `/api/homework/attachment?sid=${encodeURIComponent(sid)}&upId=${upId}&id=${attachmentId}`
  );
}

/* ---------------- 提交作业（写操作，需 MIS 会话 + 二次确认） ---------------- */

/** 前端读好的待提交文件（base64 由 FileReader 产出，服务端剥前缀） */
export interface SubmitHomeworkFile {
  name: string
  /** MIME；空串由服务端补 application/octet-stream */
  type: string
  /** data URL 或纯 base64 都接受 */
  data: string
}

export interface SubmitHomeworkResult {
  ok: boolean
  submittedFiles: number
  /**
   * 回读确认结果。`null` = 提交请求成功但没能回读平台列表确认，
   * 用户必须自己去平台核对 —— 前端要把 `hint` 显示出来。
   */
  verified: { submitCount: number; subStatus: string } | null
  hint: string
}

/**
 * 提交作业。
 *
 * ⚠️ 覆盖式、不可撤回：平台会删掉旧记录再写新记录，失败时旧记录也可能已丢。
 * 因此 `confirm` 必须显式为 true —— 调用点在用户点确认后才传。
 *
 * ⚠️ 文件以 base64 走 JSON（服务端不引 multipart 解析器）。
 * 单个 ≤ 6 MB、合计 ≤ 6 MB（base64 后 8 MB，落在 nginx 的 10m 以内）。
 */
export function submitHomework(input: {
  sid: string
  upId: number
  note: string
  files: SubmitHomeworkFile[]
}): Promise<SubmitHomeworkResult> {
  return request<SubmitHomeworkResult>('/api/homework/submit', {
    method: 'POST',
    body: JSON.stringify({
      sid: input.sid,
      upId: input.upId,
      note: input.note,
      files: input.files,
      confirm: true
    })
  });
}

/* ---------------- 教室占用（教务 room_view 占用矩阵） ----------------
 *
 * 与下面「教室人数」是两个功能，别混：
 *   教室占用 = 这一周这间教室被排课/考试/实验占掉了哪些节次（要教务会话）；
 *   教室人数 = 此刻这间教室有多少人（第三方公开接口，免登录）。
 *
 * 旧的「空闲教室」（2026-10-14 下线）就是教室占用的错误实现：
 * 路径缺 /timeholdresult/ 段、把 49 格矩阵当成「楼/教室/座位」三列解析。
 */

export type OccupancyKind =
  | 'free'
  | 'scheduled'
  | 'rescheduled'
  | 'exam'
  | 'experiment'
  | 'other'
  | 'unknown'

export interface OccupancyRoom {
  room: string
  capacity: number
  /** 键为 `"<星期1-7>-<节次1-7>"`；缺的格子按空闲处理 */
  cells: Record<string, OccupancyKind>
}

export interface OccupancyBuilding {
  /** 教务 jxlh 数字 ID —— 请求必须传 ID，传中文楼名查不到教室 */
  id: string
  name: string
}

export interface OccupancySemesterOption {
  id: string
  label: string
}

export interface OccupancySemesterOptions {
  selected: OccupancySemesterOption | null
  all: OccupancySemesterOption[]
}

export interface OccupancyResult {
  ok: boolean
  week: number
  buildingId: string
  buildingName: string
  rooms: OccupancyRoom[]
  /** 同一次响应里顺带解析的学期下拉；解析失败为 null（不影响占用数据本身） */
  semesters: OccupancySemesterOptions | null
  /** 7 个大节的起止时间，index 0 = 第 1 节 */
  slotTimes: string[]
  kindLabels: Record<OccupancyKind, string>
}

/** 教室占用支持的教学楼清单 + 节次时间（静态数据，无需登录即可取） */
export function listOccupancyBuildings(
  signal?: AbortSignal
): Promise<{ ok: boolean; buildings: OccupancyBuilding[]; slotTimes: string[] }> {
  return request<{ ok: boolean; buildings: OccupancyBuilding[]; slotTimes: string[] }>(
    '/api/classroom/occupancy/buildings',
    { signal }
  )
}

/**
 * 某栋教学楼某一教学周的教室占用矩阵。
 * ⚠️ 需要教务会话；**服务端不缓存**。
 */
export function getClassroomOccupancy(
  sid: string,
  week: number,
  buildingId: string,
  term?: string,
  signal?: AbortSignal
): Promise<OccupancyResult> {
  let url = `/api/classroom/occupancy?sid=${encodeURIComponent(sid)}&week=${week}&building=${encodeURIComponent(buildingId)}`
  if (term) url += `&term=${encodeURIComponent(term)}`
  return request<OccupancyResult>(url, { signal })
}

/** 教室占用页的学期下拉 */
export function getOccupancySemesters(
  sid: string,
  signal?: AbortSignal
): Promise<{ ok: boolean } & OccupancySemesterOptions> {
  return request<{ ok: boolean } & OccupancySemesterOptions>(
    `/api/classroom/occupancy/semesters?sid=${encodeURIComponent(sid)}`,
    { signal }
  )
}

/* ---------------- 独立平台账号与数据（CITEL / 物理在线 / 物理实验 / 演示实验） ----------------
 *
 * 这四个平台各有独立账号密码（与统一身份认证无关，见服务端
 * server/src/independentAccounts.ts 的协议表）。密码只在本模块进信封，
 * 服务端存库、永不回传（GET 只给 hasPassword）。
 *
 * 数据接口的形状刻意统一成 PlatformSnapshotResult<T>：
 *   data 才是各平台的结构化数据；cached=true 表示命中服务端 5 分钟 TTL 缓存
 *   （前端据此把「刷新」按钮做成 force 拉取，避免用户连点把学校服务器打挂）。
 */

export type AccountPlatform = 'citel' | 'phyvlab' | 'physicslab' | 'phydemo'

/** 平台中文名（与服务端 ACCOUNT_PLATFORM_LABEL 一致；列表接口也会回传一份，这里用于本地即时渲染） */
export const ACCOUNT_PLATFORM_LABEL: Record<AccountPlatform, string> = {
  citel: 'CITEL',
  phyvlab: '物理在线',
  physicslab: '物理实验',
  phydemo: '演示实验'
}

export interface IndependentAccount {
  platform: AccountPlatform
  username: string
  hasPassword: boolean
  createdAt: string
  updatedAt: string
}

export interface PlatformSnapshotResult<T> {
  ok: boolean
  platform: AccountPlatform
  label: string
  data: T
  cached: boolean
}

/* ---------------- 账号 CRUD ---------------- */

export async function listAccounts(
  signal?: AbortSignal
): Promise<{ ok: boolean; platforms: AccountPlatform[]; labels: Record<AccountPlatform, string>; accounts: IndependentAccount[] }> {
  return request<{ ok: boolean; platforms: AccountPlatform[]; labels: Record<AccountPlatform, string>; accounts: IndependentAccount[] }>(
    '/api/accounts',
    { signal }
  )
}

/**
 * 保存/更新平台账号（凭据走 RSA 信封，同登录）。
 * 服务端默认先探活验证再落库；verified=false 表示站点暂时连不上、凭据原样存下了。
 */
export async function saveAccount(
  platform: AccountPlatform,
  username: string,
  password: string
): Promise<{ ok: boolean; account: IndependentAccount; verified: boolean }> {
  return sendWithCredRetry({ username, password }, (credEnc) => {
    const payload = credEnc ? { credEnc } : { username, password }
    return request<{ ok: boolean; account: IndependentAccount; verified: boolean }>(
      `/api/accounts/${platform}`,
      { method: 'PUT', body: JSON.stringify(payload) }
    )
  })
}

export function deleteAccount(platform: AccountPlatform): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/accounts/${platform}`, { method: 'DELETE' })
}

/** 重新验证已保存的账号（「检测账号」按钮用） */
export function verifyAccount(platform: AccountPlatform): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/accounts/${platform}/verify`, { method: 'POST' })
}

/* ---------------- CITEL（ citel.bjtu.edu.cn/mlsv3，Moodle） ---------------- */

export interface CitelCourse {
  id: number
  name: string
}

export interface CitelTask {
  id: number
  courseId: number
  courseName: string
  title: string
  url: string
  /** 编程练习与书面作业的详情结构不同 */
  programming: boolean
  /** epoch 秒；null = 上游页面没写这个时间 */
  openTime: number | null
  dueTime: number | null
  discountTime: number | null
  discount: number | null
  allowLate: boolean | null
  status: string | null
  submitted: boolean
  grade: string | null
}

export interface CitelSnapshot {
  courses: CitelCourse[]
  tasks: CitelTask[]
}

/* ---------------- 物理在线（phyvlab.bjtu.edu.cn，Moodle） ---------------- */

export interface PhyVlabCourse {
  id: number
  name: string
  category: string
  courseUrl: string
}

export interface PhyVlabActivity {
  id: number
  courseId: number
  courseName: string
  title: string
  url: string
  /** 页面原文（解析失败也有个东西显示） */
  openText: string | null
  dueText: string | null
  dueTimestamp: number | null
  completed: boolean
}

export interface PhyVlabAssignmentDetail {
  activityId: number
  submissionStatus: string | null
  gradeText: string | null
  canEdit: boolean
  canSubmit: boolean
  files: string[]
}

export interface PhyVlabSnapshot {
  courses: PhyVlabCourse[]
  activities: PhyVlabActivity[]
}

/* ---------------- 物理实验（wlsy.bjtu.edu.cn，ASP.NET WebForms，GBK） ---------------- */

export interface PhysicsLab {
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  /** 1-6 */
  period: number
  name: string
  location: string
  teacher: string
}

/** 与 server/src/platformPhysicslab.ts 的 PHYSICS_LAB_TIME_RANGES 对齐 */
export const PHYSICS_LAB_TIME_RANGES = [
  '13:20-15:50',
  '16:20-18:50',
  '19:10-21:40',
  '13:00-16:20',
  '17:40-21:00',
  '10:10-12:40'
] as const

/* ---------------- 演示实验（physpace.bjtu.edu.cn:8089/phydemo） ---------------- */

export interface PhysicsDemoBooking {
  name: string
  /** epoch 秒（UTC+8 当天零点） */
  date: number
  /** 1-6，对应 PHYSICS_DEMO_TIMES 的序号 */
  period: number
  teacher: string
}

/** 与 server/src/platformPhydemo.ts 的常量对齐 */
export const PHYSICS_DEMO_TIMES = [
  '08:10-09:50',
  '10:10-11:50',
  '14:10-15:50',
  '16:10-17:50',
  '18:30-20:10',
  '20:30-22:10'
] as const

export const PHYSICS_DEMO_NAMES = ['光学', '近代与综合'] as const

/* ---------------- 快照拉取（统一入口） ---------------- */

/**
 * 快照请求的专用超时。
 *
 * 为什么不能用默认的 25s：这三个物理平台的站点只对校园网开放，请求要经过
 * 「中继机器」或「手机原生桥」绕一圈，而一次快照 = 登录页 + 登录 POST + 结果页
 * 好几跳。wlsy 的首个 TCP 连接实测就要 10~17s（校园防火墙对首个 SYN 静默丢弃，
 * 靠重传才连上），三跳加起来很容易超过 25s。
 *
 * 用默认超时的后果是：**服务端其实还在正常工作，前端先放弃了** ——
 * nginx 里表现为 499，用户看到「网络请求超时，请检查网络连接后重试」，
 * 但真实原因跟"用户的网络"毫无关系。所以这里给足余量，
 * 真正的快速失败交给服务端（见 campusRelay 的出口熔断）。
 */
const SNAPSHOT_TIMEOUT_MS = 120_000

/** force=true 绕过服务端 5 分钟缓存（「刷新」按钮专用） */
export function getPlatformSnapshot<T>(
  platform: AccountPlatform,
  force = false,
  signal?: AbortSignal
): Promise<PlatformSnapshotResult<T>> {
  const q = force ? '?force=1' : ''
  return request<PlatformSnapshotResult<T>>(`/api/platforms/${platform}/snapshot${q}`, {
    signal,
    timeoutMs: SNAPSHOT_TIMEOUT_MS
  })
}

export function getCitelSnapshot(force = false, signal?: AbortSignal): Promise<PlatformSnapshotResult<CitelSnapshot>> {
  return getPlatformSnapshot<CitelSnapshot>('citel', force, signal)
}

export function getPhyVlabSnapshot(force = false, signal?: AbortSignal): Promise<PlatformSnapshotResult<PhyVlabSnapshot>> {
  return getPlatformSnapshot<PhyVlabSnapshot>('phyvlab', force, signal)
}

export function getPhysicsLabs(force = false, signal?: AbortSignal): Promise<PlatformSnapshotResult<PhysicsLab[]>> {
  return getPlatformSnapshot<PhysicsLab[]>('physicslab', force, signal)
}

export function getPhyDemoBookings(force = false, signal?: AbortSignal): Promise<PlatformSnapshotResult<PhysicsDemoBooking[]>> {
  return getPlatformSnapshot<PhysicsDemoBooking[]>('phydemo', force, signal)
}

/* ---------------- 物理实验 / 演示实验 → 课表 / DDL ---------------- */

/** 实验转课表/DDL 的目标：课表、DDL、或两者一起 */
export type LabAddTarget = 'course' | 'task' | 'both'

/** 请求体里可以只挑几条（逐条按钮用）；不传 items = 处理快照里全部实验 */
export interface LabAddInput {
  target: LabAddTarget
  /** 只处理这些实验（键 = 日期|节次|名称，由服务端按同一口径匹配） */
  items?: { name: string; date: number; period: number }[]
  /** 默认只加今天及以后的实验；true 表示连过去的也加 */
  includePast?: boolean
}

export interface LabAddResult {
  ok: boolean
  platform: AccountPlatform
  label: string
  /** 快照里的实验总数 */
  scanned: number
  /** 本次实际处理（命中 items 且在时间范围内）的条数 */
  handled: number
  added: { courses: number; tasks: number }
  /** 已存在而跳过的条数（重复点按钮不会产生重复条目） */
  skipped: { courses: number; tasks: number }
  /** 落不了周的实验（放假周 / 学期外 / 节次表外），附原因 */
  unresolved: { name: string; date: string; reason: string }[]
  /**
   * 本次扫到并处理过的实验键（日期|节次|名称）。
   * ⚠️ 包含 `unresolved` 里那些**没能加进课表**的条目，只能用于统计/日志，
   *    不要拿它把按钮改成「已加入」—— 那会得到一个 disabled 且加不进去的假状态。
   */
  keys: string[]
  /** 真正落到课表的实验键（已存在而跳过也算）—— 按钮「✓ 已在课表」只看这个 */
  courseKeys: string[]
  /** 真正生成了 DDL 的实验键（已存在而跳过也算）—— 按钮「✓ 已有 DDL」只看这个 */
  taskKeys: string[]
}

export function addLabsToSchedule(
  platform: 'physicslab' | 'phydemo',
  body: LabAddInput
): Promise<LabAddResult> {
  /* 同样要给足超时：这个接口内部会复用快照（必要时现拉一次），
     同样要经过校园网出口绕一圈 */
  return request<LabAddResult>(`/api/platforms/${platform}/add-to-schedule`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: SNAPSHOT_TIMEOUT_MS
  })
}

/** 取消导入的目标，与 LabAddTarget 同口径 */
export type LabRemoveTarget = 'course' | 'task' | 'both'

export interface LabRemoveResult {
  ok: boolean
  platform: AccountPlatform
  /** 实际删除的行数 */
  removed: { courses: number; tasks: number }
}

/**
 * 取消导入：把该平台导入的课程 / DDL 删掉。
 *
 * 只动本站数据库、不打学校站点，所以校园网出口离线时也能用 ——
 * 这也是它不用 SNAPSHOT_TIMEOUT_MS 的原因（几毫秒就返回）。
 */
export function removeLabsFromSchedule(
  platform: 'physicslab' | 'phydemo',
  target: LabRemoveTarget
): Promise<LabRemoveResult> {
  return request<LabRemoveResult>(`/api/platforms/${platform}/remove-from-schedule`, {
    method: 'POST',
    body: JSON.stringify({ target })
  })
}

/** 物理在线：单个作业的提交状态/成绩详情（不在快照里，点开作业行时才拉） */
export function getPhyVlabAssignmentDetail(activityId: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: PhyVlabAssignmentDetail }> {
  return request<{ ok: boolean; detail: PhyVlabAssignmentDetail }>(`/api/phyvlab/assignment/${activityId}`, { signal })
}

/** 教室人数里的一间教室 */
export interface ClassroomRoom {
  name: string
  used: number
  capacity: number
  usagePercent: number
}

/** 一栋教学楼的教室人数快照 */
export interface ClassroomBuildingInfo {
  building: string
  /** 第三方数据轮询窗口（原样字符串，不解析时区） */
  effectiveStart: string
  effectiveEnd: string
  rooms: ClassroomRoom[]
}

/** 教室人数支持的教学楼清单（服务端为准，前端拿来做下拉） */
export function listClassroomBuildings(
  signal?: AbortSignal
): Promise<{ ok: boolean; buildings: string[] }> {
  return request<{ ok: boolean; buildings: string[] }>('/api/classroom/buildings', { signal })
}

/** 某栋楼各教室当前人数。**服务端不缓存**，每次都是实时打第三方。 */
export function getClassroomCapacity(
  building: string,
  signal?: AbortSignal
): Promise<{ ok: boolean } & ClassroomBuildingInfo> {
  return request<{ ok: boolean } & ClassroomBuildingInfo>(
    `/api/classroom/capacity?building=${encodeURIComponent(building)}`,
    { signal }
  )
}

/**
 * 下载成绩单 PDF。
 *
 * ⚠️ 必须带 sid：教务取 PDF 要 AA 登录态。调用方先确保有可用会话 ——
 *   优先探测会话池（probeMisSession），没有才走「验证码 + misLogin」。
 */export async function downloadReportCard(sid: string, lang: ReportCardLanguage = 'zh'): Promise<Blob> {
  return requestBlob(`/api/report-card?lang=${lang}&sid=${encodeURIComponent(sid)}`);
}

export type ReportCardLanguage = 'zh' | 'en';

/* ---------------- 统一同步（/api/mis/sync） ---------------- */

/** 智慧课程平台同步结果（课表导入用不到全部字段，但同步页要用） */
export interface MisSyncBksyResult {
  ok: boolean;
  error?: string;
  semester: { xqCode: string; name: string; beginDate: string; endDate: string } | null;
  courses: MisCourse[];
  /** 作业/课程设计/实验报告；已由服务端落库，这里只用于展示条数 */
  homeworks: unknown[];
  /** 拉取失败的「课程 × 类型」清单（评审 B7）：部分失败不影响 ok，但必须让用户看见 */
  failedCourses?: string[];
}

export interface MisSyncResult {
  ok: boolean;
  courses: MisCourse[];
  totalCredits: number | null;
  semester: { startDate: string | null; totalWeeks: number | null; source: string | null };
  aaError: string | null;
  bksy: MisSyncBksyResult;
  /** 本次同步相对上次的变动（服务端算好，首同步为空数组） */
  dataChanges: DataChange[];
}

/**
 * 一次会话同步「本科教务 + 智慧课程平台」（含作业落库）。
 *
 * ⚠️ 为什么所有域走这一个接口：各子系统共用同一套 CAS 登录态，
 * 合并调用只需消耗一次学校侧登录额度（2026-10-14 会话池改造后登录态
 * 会留在池里供其他应用复用，但合并仍然是**最省额度**的路径）。
 */
export function misSync(sid: string): Promise<MisSyncResult> {
  return request<MisSyncResult>('/api/mis/sync', {
    method: 'POST',
    body: JSON.stringify({ sid })
  });
}

/* ---------------- 课件（智慧课程平台） ---------------- */

export type { CoursewareList };

/**
 * 列某门课下某层节点。
 *
 * - `parentId` 默认 `'0'`（根目录）；点文件夹展开就是再调一次、把 parentId 换成它的 id。
 * - `course` 来自 sync 返回的 `bksy.courses[i]` 整条对象（id/name/courseNumber/groupId/semesterCode）。
 */
export function listCourseware(
  sid: string,
  course: { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string },
  parentId = '0'
): Promise<CoursewareList> {
  return request<CoursewareList>('/api/courseware/list', {
    method: 'POST',
    body: JSON.stringify({ sid, course, parentId })
  });
}

/** 课件可浏览课程列表（轻量版，不走 sync） */
export interface CoursewareCourseSummary {
  id: number;
  name: string;
  teacher: string;
  courseNumber: string;
  groupId: string;
  semesterCode: string;
}
export function listCoursewareCourses(sid: string): Promise<{ courses: CoursewareCourseSummary[] }> {
  return request<{ courses: CoursewareCourseSummary[] }>(`/api/courseware/courses?sid=${encodeURIComponent(sid)}`);
}

/**
 * 下载一个课件文件，返回 Blob 由前端触发保存。
 *
 * ⚠️ 不能复用 request()：它会 JSON.parse 二进制损坏。
 */
export async function downloadCourseware(
  sid: string,
  rpId: string,
  fileName: string
): Promise<Blob> {
  return requestBlob(
    `/api/courseware/download?sid=${encodeURIComponent(sid)}&rpId=${encodeURIComponent(rpId)}&name=${encodeURIComponent(fileName)}`
  );
}

/** 浏览器直下票据的返回值：`path` 是相对地址，用 `new URL(path, location.origin)` 拼成绝对地址 */
export interface DownloadTicket {
  path: string;
  /** 有效期（秒）—— 目前是 600，仅用于提示文案，前端不需要自己计时 */
  expiresIn: number;
}

/**
 * 换一张「单文件下载」票据（App 壳里跳浏览器下载用）。
 *
 * 为什么要绕这一圈：浏览器地址栏的请求带不了 Authorization 头，而
 * `/api/courseware/download` 需要登录态。票据把「哪个用户、哪个文件」编码进一个
 * 10 分钟有效的随机串里，浏览器拿着它就能直接下 —— 详见服务端的票据注释。
 */
export function createCoursewareDownloadTicket(
  sid: string,
  rpId: string,
  name: string
): Promise<DownloadTicket> {
  return request<DownloadTicket>('/api/courseware/download-ticket', {
    method: 'POST',
    body: JSON.stringify({ sid, rpId, name })
  });
}

/** 换一张「整目录导出」票据（同上，只是载荷多一个课程与目录） */
export function createCoursewareExportTicket(
  sid: string,
  course: { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string },
  parentId: string,
  zipName: string
): Promise<DownloadTicket> {
  return request<DownloadTicket>('/api/courseware/export-ticket', {
    method: 'POST',
    body: JSON.stringify({ sid, course, parentId, name: zipName })
  });
}

/** 整目录导出的结果说明（zip 本体是 Blob） */
export interface CoursewareExportSummary {
  blob: Blob;
  /** 实际打进包里的文件数 */
  files: number;
  /** 老师未开放下载而跳过的文件数 */
  skipped: number;
  /** 下载失败的文件数 */
  failed: number;
  /** 触到服务端上限被截断 —— 必须提示用户「不是完整导出」 */
  truncated: boolean;
}

/**
 * 整目录导出：服务端递归展开 + 打包 zip。
 *
 * ⚠️ 单独走 fetch 而不是 requestBlob：需要读 `X-Export-*` 响应头，
 *   而 requestBlob 只返回 Blob 本体，把「跳过了几个」「是否被截断」全丢了 ——
 *   静默截断比直接报错更伤人。
 *
 * ⚠️ 超时给 10 分钟：几十个文件每个都要先取票据再下载，串行跑确实可能很久。
 *   服务端另有 200 文件 / 500MB 的硬上限兜底。
 */
export async function exportCoursewareDirectory(
  sid: string,
  course: { id: number; name: string; courseNumber: string; groupId: string; semesterCode: string },
  parentId: string,
  zipName: string,
  signal?: AbortSignal
): Promise<CoursewareExportSummary> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const q = new URLSearchParams({
    sid, parentId, name: zipName, course: JSON.stringify(course)
  });
  const res = await rawFetch(`/api/courseware/export?${q.toString()}`, { headers }, 600_000, signal);
  if (!res.ok) {
    let msg = `导出失败（HTTP ${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* 非 JSON 就沿用默认文案 */
    }
    throw new ApiError(msg, res.status);
  }
  const n = (name: string): number => {
    const v = Number(res.headers.get(name));
    return Number.isFinite(v) ? v : 0;
  };
  return {
    blob: await res.blob(),
    files: n('X-Export-Files'),
    skipped: n('X-Export-Skipped'),
    failed: n('X-Export-Failed'),
    truncated: res.headers.get('X-Export-Truncated') === '1'
  };
}

/* ---------------- 校园邮箱（只读中转，Coremail） ---------------- */

/** 收件箱列表（只读；会话在页面停留期间复用，离开时用 destroyMisSession 销毁） */
export function listMails(sid: string, start = 0, limit = 30): Promise<MailListResult> {
  return request<MailListResult>('/api/mailbox/list', {
    method: 'POST',
    body: JSON.stringify({ sid, start, limit })
  });
}

/** 邮件详情（正文为服务端转好的纯文本） */
export function readMail(sid: string, id: string): Promise<MailDetail> {
  return request<MailDetail>('/api/mailbox/message', {
    method: 'POST',
    body: JSON.stringify({ sid, id })
  });
}

/**
 * 下载邮件附件，返回 Blob 由前端触发保存。
 * ⚠️ 不能复用 request()：二进制流会被 JSON.parse 损坏。
 */
export async function downloadMailAttachment(
  sid: string,
  mid: string,
  part: string,
  name: string
): Promise<Blob> {
  return requestBlob(
    `/api/mailbox/attachment?sid=${encodeURIComponent(sid)}&mid=${encodeURIComponent(mid)}&part=${encodeURIComponent(part)}&name=${encodeURIComponent(name)}`
  );
}

/* ---------------- 校园邮箱：写信 / 回复 / 发送（2026-10-20 新增） ---------------- */

/** 服务端建好的写信草稿（id 是投递凭据） */
export interface MailComposeDraft {
  id: string;
  /** 回复时平台会预填收件人 */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** 已转纯文本的引用正文（回复时非空，用户可自行删改） */
  bodyText: string;
  replyToMessageId: string | null;
}

/**
 * 建草稿。`replyTo` 传被回复邮件的 id 即为「回复」，不传就是「新邮件」。
 *
 * 为什么先建草稿再发送：投递失败时草稿还在，用户可以改一改重发；
 * 直接一步发送失败就什么都没了。
 */
export function beginCompose(
  sid: string,
  replyTo: string | null = null
): Promise<{ ok: boolean; draft: MailComposeDraft }> {
  return request<{ ok: boolean; draft: MailComposeDraft }>('/api/mailbox/compose', {
    method: 'POST',
    body: JSON.stringify({ sid, replyTo })
  });
}

/** 发送。地址格式与长度由服务端再校验一遍（投递不可撤销） */
export function sendMail(input: {
  sid: string;
  draftId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  replyTo?: string | null;
}): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/mailbox/send', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

/** 放弃草稿（取消写信、或发送失败后清理） */
export function discardCompose(sid: string, draftId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/mailbox/discard', {
    method: 'POST',
    body: JSON.stringify({ sid, draftId })
  });
}
