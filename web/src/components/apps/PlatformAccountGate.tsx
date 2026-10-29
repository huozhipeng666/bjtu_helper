/**
 * 独立平台账号门（CITEL / 物理在线 / 物理实验 / 演示实验 四个应用共用）。
 *
 * ## 为什么抽出来
 *
 * 这四个平台（见 server/src/independentAccounts.ts）各自要「账号 + 密码」，
 * 且都是**布局近似**的同一套交互：没绑 → 表单；绑了 → 内容；想换 → 解绑重绑。
 * 四个页面各写一遍 ≈ 160 行逐字重复，而「密码保存前先探活验证」「解绑要二次确认」
 * 这类细节一旦只在三处实现，第四处必然漏。
 *
 * ## 边界
 *
 * - 本组件**只碰账号**，不发起任何平台数据请求。数据在各应用页面里拉。
 * - 密码经 lib/credEnvelope.ts 的 RSA 信封发出（saveAccount 内部处理），
 *   密码框提交后立即清空、不落 localStorage。
 * - 服务端保存前默认先探活（打一次上游登录）。verified=false 表示站点暂时
 *   连不上但凭据已存下，此时给一句提示即可，不算错误。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import AppState from './AppState'
import {
  ACCOUNT_PLATFORM_LABEL, deleteAccount, listAccounts, saveAccount,
  type AccountPlatform, type IndependentAccount
} from '../../api'
import { startDeviceRelay } from '../../lib/deviceRelay'

export interface PlatformAccountGateProps {
  platform: AccountPlatform
  /** 未绑定时表单上方的说明（各平台的账号是什么、去哪注册） */
  lead?: ReactNode
  children: ReactNode
}

type Phase = 'loading' | 'bind' | 'ready'

export default function PlatformAccountGate({ platform, lead, children }: PlatformAccountGateProps) {
  const label = ACCOUNT_PLATFORM_LABEL[platform]
  const [phase, setPhase] = useState<Phase>('loading')
  const [account, setAccount] = useState<IndependentAccount | null>(null)
  const [loadError, setLoadError] = useState('')

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 解绑二次确认：点第一下进入待确认态，第二下才真删 */
  const [confirmUnbind, setConfirmUnbind] = useState(false)

  /**
   * 三个物理平台只对校园网开放（服务器在公网机房，直连被学校防火墙丢包）。
   * App 里有原生 HTTP 桥时，由本机在校园网 WiFi 下替服务端访问学校站点 ——
   * 见 lib/deviceRelay.ts。CITEL 是公网站点，不需要这条出口。
   */
  useEffect(() => {
    if (platform === 'citel') return
    return startDeviceRelay()
  }, [platform])

  const refresh = useCallback(async () => {
    setLoadError('')
    try {
      const r = await listAccounts()
      const hit = r.accounts.find((a) => a.platform === platform) ?? null
      setAccount(hit)
      setPhase(hit ? 'ready' : 'bind')
      if (hit) setUsername(hit.username)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '账号信息加载失败')
    }
  }, [platform])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function submit() {
    const u = username.trim()
    if (!u || !password || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await saveAccount(platform, u, password)
      setAccount(r.account)
      setPhase('ready')
      setPassword('')
      setConfirmUnbind(false)
      if (!r.verified) setNotice(`${label}站点暂时连不上，账号已保存，稍后可在页面内重试。`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    setBusy(true)
    setError('')
    try {
      await deleteAccount(platform)
      setAccount(null)
      setPhase('bind')
      setPassword('')
      setConfirmUnbind(false)
      setNotice('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解绑失败')
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'loading') {
    return <AppState kind="loading" title={loadError ? loadError : '正在检查账号绑定状态…'} onRetry={loadError ? () => void refresh() : undefined} />
  }

  if (phase === 'bind') {
    return (
      <div className="card profile-card">
        {lead && <div className="field-hint is-lead">{lead}</div>}

        <div className="field-label">{label}账号</div>
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="平台登录账号"
          autoComplete="username"
          aria-label={`${label}账号`}
        />

        <div className="field-label is-spaced">密码</div>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="平台登录密码"
          autoComplete="current-password"
          aria-label="密码"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void submit()
          }}
        />

        {error && <div className="form-error">{error}</div>}

        <div className="app-actions">
          <button type="button" className="btn-primary" disabled={busy || !username.trim() || !password} onClick={() => void submit()}>
            {busy ? '正在验证并保存…' : '保存并验证'}
          </button>
        </div>

        <div className="field-hint">
          保存前会先到{label}试登录一次，密码不正确会当场提示。密码仅用于本助手向对应平台取数，
          服务端不会回传给任何页面。忘记密码请直接联系该平台管理员。
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="plat-account-bar">
        <span className="plat-account-user">
          {label}账号：<strong>{account?.username ?? ''}</strong>
        </span>
        {notice && <span className="plat-account-notice">{notice}</span>}
        {confirmUnbind ? (
          <span className="plat-account-confirm">
            <button type="button" className="btn-ghost is-danger" disabled={busy} onClick={() => void unbind()}>确认解绑</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirmUnbind(false)}>取消</button>
          </span>
        ) : (
          <button type="button" className="btn-ghost" onClick={() => setConfirmUnbind(true)}>更换 / 解绑</button>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {children}
    </>
  )
}
