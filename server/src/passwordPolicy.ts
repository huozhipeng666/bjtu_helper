/**
 * 密码策略（注册 / 管理员建号 / 管理员重置共用）。
 *
 * ── 为什么抽成独立模块 ────────────────────────────────────────────
 * 原先三处各写一遍 `password.length < 6`。这种"复制粘贴的校验"必然漂移：
 * 改了一处忘了另两处，于是"注册要求 8 位、后台建号仍能设 6 位"这种后门就出现了。
 * 抽成唯一出口，并且**必须能被单测覆盖**。
 *
 * ── 设计原则：长度 + 黑名单 > 复杂度规则 ──────────────────────────
 * 不强制"必须含大小写+数字+符号"。那是过时的建议（NIST SP 800-63B 已明确不推荐）：
 * 它把人逼成 `Password1!` 这类**可预测**的形态，反而降低实际强度。
 * 真正有效的是：
 *   ① 足够的最小长度；② 挡住已知弱口令与"和账号相关"的密码；③ 不限制最大长度。
 *
 * ── 最大长度为什么要限制 ─────────────────────────────────────────
 * 不是为了"安全"，而是为了**可用性**：每个密码都要跑一次 scrypt，
 * 超长输入会白白消耗 CPU。128 位对任何人类口令都绰绰有余，
 * 同时让攻击者无法用超长字符串来放大 scrypt 开销。
 */

/** 最小长度。从 6 提到 8：6 位纯数字的搜索空间只有 100 万，离线爆破是秒级。 */
export const PASSWORD_MIN = 8
/** 最大长度：防超长输入放大 scrypt 开销，对真人口令无实际限制 */
export const PASSWORD_MAX = 128

/**
 * 常见弱口令黑名单（小写比对）。
 *
 * 为什么不接 HIBP 之类的在线库：本项目的注册量级不需要，且引入外部依赖
 * 意味着注册流程受第三方可用性影响。这里收录的是"学生群体 + 通用榜单"里
 * 最高频的那些 —— 挡住前几百个就把绝大多数"随手一敲"挡掉了。
 *
 * 注意：包含**校园场景特有**的几类（学号常见格式、学校缩写），
 * 因为本项目用户是学生，这类口令实际出现频率远高于通用榜单排名。
 */
const WEAK_PASSWORDS = new Set([
  /* 纯数字序列 / 重复 */
  '12345678', '123456789', '1234567890', '87654321', '11223344', '12341234',
  '11111111', '00000000', '88888888', '66666666', '123123123', '520520520',
  '147258369', '159357852',
  /* 通用弱口令 */
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'admin123',
  'administrator', 'root1234', 'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk',
  'zxcvbnm1', '1qaz2wsx', '1q2w3e4r', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'letmein1', 'welcome1', 'monkey123',
  'dragon123', 'master123', 'abc12345', 'abcd1234', 'a1234567', 'aa123456',
  'a1b2c3d4', 'changeme', 'secret123', 'test1234', 'admin888', 'nopassword',
  /* 校园场景高频（学号/学校缩写 + 常见尾缀） */
  'bjtu1234', 'bjtu2024', 'bjtu2025', 'bjtu2026', 'student1', 'stu12345',
  'bjtuedu1', 'jiaotong', 'jiaoda123'
])

/** 是否全部为同一个字符（如 aaaaaaaa、11111111） */
function isAllSameChar(pw: string): boolean {
  return pw.length > 0 && pw.split('').every((c) => c === pw[0])
}

/** 是否纯数字 */
function isAllDigits(pw: string): boolean {
  return /^\d+$/.test(pw)
}

/**
 * 是否连续递增/递减序列（如 12345678、abcdefgh、87654321）。
 * 只做"整串连续"判定，不做"包含连续片段"——后者误伤太大（`Pass123456` 很常见且不算太弱）。
 */
function isSequential(pw: string): boolean {
  const lower = pw.toLowerCase()
  if (lower.length < 4) return false
  let ascending = true
  let descending = true
  for (let i = 1; i < lower.length; i++) {
    const diff = lower.charCodeAt(i) - lower.charCodeAt(i - 1)
    if (diff !== 1) ascending = false
    if (diff !== -1) descending = false
  }
  return ascending || descending
}

/**
 * 校验密码强度。
 *
 * @param password 明文密码
 * @param opts.username 传入时额外校验"密码不得与账号相同或包含账号"
 * @returns null = 通过；否则返回**可直接展示给用户**的错误文案
 */
export function checkPasswordStrength(password: string, opts: { username?: string } = {}): string | null {
  if (typeof password !== 'string') return '密码格式不正确'
  if (password.length < PASSWORD_MIN) return `密码需至少 ${PASSWORD_MIN} 位`
  if (password.length > PASSWORD_MAX) return `密码不能超过 ${PASSWORD_MAX} 位`

  /* 控制字符会让密码在输入法/终端里表现得诡异，且几乎必然是异常输入 */
  if (/[\p{C}]/u.test(password)) return '密码不能包含控制字符'

  const lower = password.toLowerCase()

  if (WEAK_PASSWORDS.has(lower)) return '该密码过于常见，容易被猜到，请换一个'
  if (isAllSameChar(password)) return '密码不能是重复的同一个字符'

  /* 纯数字：6~8 位纯数字的实际强度极低，且校园场景常用生日/学号，
     这类口令是撞库字典的优先项。要求混入非数字字符。 */
  if (isAllDigits(password)) return '密码不能是纯数字，请混入字母或符号'

  if (isSequential(password)) return '密码不能是连续递增或递减的序列（如 12345678）'

  /* 与账号相关：撞库字典的第一条就是"用账号本身当密码" */
  const name = (opts.username ?? '').trim().toLowerCase()
  if (name && (lower === name || lower.includes(name))) {
    return '密码不能与账号相同或包含账号'
  }

  return null
}