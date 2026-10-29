/* ============================================================
   教务登录表单（共享组件）
   ============================================================

   ## 为什么抽出来

   「课件下载」「成绩单」「校园邮箱」「数据同步」四个应用各自手写了一遍
   学号 / 密码表单 —— 逐字重复约 60 行 × 4。这带来两个真实问题：

   1. **改一处漏三处**。比如输入框的 `inputMode="numeric"`、
      Enter 提交、`autoComplete` 属性，任何一次调整都要记得同步 4 个文件。
      实际上已经出现过：CoursewareApp 的按钮文案是「登录并加载课程」，
      另外两个是「登录教务」，用户在不同应用里看到不一致的按钮。
   2. **会话是消耗品**。每个应用自己 `useEffect` 里调 `startMisSession()`，
      用户在 A 应用登录成功后切到 B 应用，B 又去学校拉一次登录页 ——
      无谓地消耗学校侧配额（拿多了会被风控），也让「打开就自动登录」
      的会话池机制看起来像失效了（其实只是慢了一下）。

   ## 2026-10 学校换登录方式后的变化

   MIS 的登录从 `cas.bjtu.edu.cn`（学号 + 密码 + 图形算术验证码）换成了
   `sso.bjtu.edu.cn` 的统一身份认证（**没有验证码**，密码在服务端用 SM2 加密后提交）。
   所以本组件不再有验证码输入框与验证码图片，只保留学号 / 密码两项。

   代价是：**没激活过统一身份认证的账号会被直接拒绝**，而 SSO 的报错文案
   （"用户名或密码错误"之类）跟真输错密码一模一样，用户很难自行判断。
   服务端（mis.ts 的 describeSsoError）已经在错误文案里点了"可能未激活"，
   这里再补一条常驻提示，省得用户反复试密码。

   ## 设计取舍

   - **受控组件**：所有状态由调用方持有。因为各应用在登录成功后的后续动作
     完全不同（拉课程列表 / 拉邮件 / 下载 PDF / 触发全量同步），
     把状态藏进组件里反而要加一堆回调。
   - **不自己发请求**：`onLogin` 由调用方提供。这样每个应用能保留自己的
     错误处理与 phase 流转。
   - **会话刷新走 `refreshToken` 而不是重挂载**。登录失败后必须重新开一个
     SSO 会话（旧的在服务端已销毁），但用户不该因此重输学号密码。
     所以调用方只需把 `refreshToken` 加一，本组件重新拿 sid、保留已填内容。
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react'
import { startMisSession } from '../../api'

export interface MisLoginCredential {
  /** 当前 SSO 会话的 sid，由本组件在开会话时记录，避免父组件的 state 落后一帧 */
  sid: string
  username: string
  password: string
}

export interface MisLoginFormProps {
  /** 登录成功后的动作由调用方在 onLogin 里做 */
  onLogin: (cred: MisLoginCredential) => Promise<void>
  /** 登录按钮文案，默认「登录教务」 */
  submitLabel?: string
  /** 提交中按钮文案，默认「正在登录…」 */
  busyLabel?: string
  /** 是否禁用提交（调用方的 busy 状态） */
  busy?: boolean
  /** 外部错误信息（调用方的 error state） */
  error?: string
  /** 每 +1 就重开一个 SSO 会话（登录失败 / 会话失效时由调用方触发） */
  refreshToken?: number
}

/**
 * 教务登录表单。
 *
 * 内部维护 username / password 两个输入值，以及 SSO 会话 sid。
 * 调用方只需要提供 `onLogin`，并在成功后自己切 phase。
 */
export default function MisLoginForm({
  onLogin,
  submitLabel = '登录教务',
  busyLabel = '正在登录…',
  busy = false,
  error,
  refreshToken = 0
}: MisLoginFormProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  /** 防 StrictMode 双跑：重复开 SSO 会话会白烧学校侧配额 */
  const requestedRef = useRef(false)
  /** 已处理过的 refreshToken，避免父组件无关重渲染导致重复开会话 */
  const seenTokenRef = useRef(refreshToken)
  /** 当前 SSO 会话的 sid。用 ref 而非 state：提交瞬间就要拿到最新值，
      state 可能落后一帧（刚开完会话就点登录 → 提交的是上一个 sid） */
  const sidRef = useRef('')

  const refreshSession = useCallback(async () => {
    setLocalError('')
    sidRef.current = ''
    setRefreshing(true)
    try {
      const r = await startMisSession()
      sidRef.current = r.sid
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '登录会话建立失败，请重试')
    } finally {
      setRefreshing(false)
    }
  }, [])

  /* 首次挂载开一个会话 */
  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    void refreshSession()
  }, [refreshSession])

  /* refreshToken 变化 → 重开一个会话（保留学号密码） */
  useEffect(() => {
    if (refreshToken === seenTokenRef.current) return
    seenTokenRef.current = refreshToken
    void refreshSession()
  }, [refreshToken, refreshSession])

  const canSubmit = username.trim().length > 0 && password.length > 0 && !refreshing

  async function submit() {
    if (!canSubmit || busy) return
    if (!sidRef.current) {
      /* 会话还没建好就被点了提交：等它一下，别把空 sid 发出去 */
      setLocalError('登录会话还在建立中，请稍候再试')
      return
    }
    setLocalError('')
    await onLogin({ sid: sidRef.current, username: username.trim(), password })
    /* 密码不留在内存里：失败时用户只需重输密码（会话由父组件触发重开） */
    setPassword('')
  }

  const shown = error || localError

  return (
    <div className="card profile-card">
      <div className="field-label">学号</div>
      <input
        className="input"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="例如 20231xxxxx"
        autoComplete="username"
        inputMode="numeric"
        aria-label="学号"
      />

      <div className="field-label is-spaced">密码</div>
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="学校统一身份认证密码"
        autoComplete="current-password"
        aria-label="密码"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) void submit()
        }}
      />

      {shown && <div className="form-error">{shown}</div>}

      <div className="app-actions">
        <button type="button" className="btn-primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>

      <div className="field-hint">
        学校已改用统一身份认证（sso.bjtu.edu.cn），登录时不再需要验证码。
        如果确认密码无误仍提示错误，可能是你的账号<strong>还没有激活</strong>，
        请先到 <a href="https://sso.bjtu.edu.cn" target="_blank" rel="noreferrer">sso.bjtu.edu.cn</a> 完成激活后再回来登录。
      </div>
    </div>
  )
}
