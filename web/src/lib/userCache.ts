/**
 * 本地用户快照：让"已经登录过的人"打开 App 时不必等 `me()` 回来才看到界面。
 *
 * 背景（实测数据，4G 限速 + 4x CPU 冷启动）：
 *   骨架壳 393ms 就能画出来，但真实界面（顶栏头像/昵称、底栏）要等到 856ms —
 *   中间那 460ms 里，大头是 `GET /api/auth/me` 这一跳（启动流程必须等它才知道
 *   用户是谁）。可这份数据**上一次打开时就已经在手机上了**，没有任何理由再等一次网络。
 *
 * 做法：把上一次 `me()` 返回的用户行存进 localStorage，下次启动直接用。
 * 随后 `me()` 照常在后台跑一遍校验 —— 拿到结果就覆盖，token 失效（401）就照常
 * 清 token 落回登录/游客态。也就是说：**快照只用于"先画出来"，不用来判断登录是否有效**。
 *
 * ⚠️ 必须按 token 摘要分桶：
 *   同一台手机上换账号（登出→登录别人）后，如果直接读同一份快照，会在顶栏
 *   短暂显示上一个账号的昵称与头像 —— 那是明确的隐私问题，不是"小瑕疵"。
 *   分桶后旧 token 的快照读不到，自然回落到骨架壳。
 *
 * ⚠️ 存的内容只限"顶栏要用的展示字段"。用户行里还有 role（管理员判定）等，
 *   把它们一起缓存会让"本地数据"参与权限判断 —— 权限必须每次由服务端说了算。
 */
import type { User } from '../types'

const KEY_PREFIX = 'bjtu-user-snapshot:'

/** 只保留渲染顶栏所需的字段；其余一概不落盘（见文件头第 2 条 ⚠️） */
type Snapshot = Pick<User, 'id' | 'username' | 'nickname' | 'avatar' | 'isGuest' | 'theme' | 'accent'> & {
  /** 存快照时的 token 摘要，用于校验"这份快照还属于当前 token 吗" */
  scope: string
}

/** token 摘要：不需要密码学强度，只要"不同 token 得到不同短串"。与 sw.js 的 djb2 一致 */
function digest(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function keyFor(token: string): string {
  return KEY_PREFIX + digest(token)
}

/**
 * 读快照。任何异常（隐私模式禁 localStorage、旧版本残留的坏 JSON）都返回 null ——
 * 这条路径失败只等于"没有加速"，绝不能让 App 打不开。
 */
export function readUserSnapshot(token: string): User | null {
  if (!token) return null
  try {
    const raw = localStorage.getItem(keyFor(token))
    if (!raw) return null
    const s = JSON.parse(raw) as Snapshot
    /* 形状校验：字段缺失或类型不对就整份丢弃。宁可退回骨架壳，也不要把
       半份数据渲染出去（例如 nickname 是 undefined 会在顶栏显示 "undefined"）。 */
    if (s.scope !== digest(token) || typeof s.id !== 'number' || typeof s.nickname !== 'string') return null
    return {
      id: s.id,
      username: s.username,
      nickname: s.nickname,
      avatar: s.avatar ?? null,
      isGuest: s.isGuest,
      theme: s.theme,
      accent: s.accent ?? null
    } as User
  } catch {
    return null
  }
}

export function writeUserSnapshot(token: string, u: User): void {
  if (!token) return
  try {
    const s: Snapshot = {
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      avatar: u.avatar ?? null,
      isGuest: u.isGuest ?? false,
      theme: u.theme,
      accent: u.accent ?? null,
      scope: digest(token)
    }
    localStorage.setItem(keyFor(token), JSON.stringify(s))
  } catch {
    /* 配额满 / 隐私模式：不影响功能 */
  }
}

/** 登出或 token 失效时清掉**当前 token** 的快照（不清别的账号的，避免误伤） */
export function clearUserSnapshot(token: string): void {
  if (!token) return
  try {
    localStorage.removeItem(keyFor(token))
  } catch {
    /* 忽略 */
  }
}

/* 存快照会留下历史残留（每次重新签发游客 token 都是一个新桶）。
   启动时顺手清理：只保留当前 token 那一份，其余全删。
   为什么值得做：游客 token 有效期 14 天，一个活跃访客一年能攒下二十几个桶，
   每个几百字节，虽不致命但属于纯垃圾 —— 而清理成本是一次 localStorage 遍历。 */
export function pruneUserSnapshots(keepToken: string): void {
  try {
    const keep = keepToken ? keyFor(keepToken) : ''
    const dead: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY_PREFIX) && k !== keep) dead.push(k)
    }
    for (const k of dead) localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
}
