/**
 * 数据同步（「应用」→ 工具）。
 *
 * 一次 CAS 登录（或复用会话池里已有的登录）→ 同时拉「本科教务课表 + 智慧课程平台」
 * → 作业落库 → 产出变动摘要。
 *
 * 为什么必须是**一个**页面而不是一堆独立按钮：
 *   各子系统共用同一套 CAS 登录态。「同步课表」「同步作业」「同步成绩」各来一次，
 *   用户要点三次验证码、烧三次学校侧登录额度；合并后一次登录全部拉回。
 *
 * ⚠️ 验证码是学校侧反爬的最后一道闸。这个页面的目的是**减少重复登录**，
 *   而不是绕过它 —— 所以一次会话内把该拿的都拿到，之后长期用本地缓存。
 *
 * 2026-10-14 会话池：打开页面时先探测 —— 任一教务应用（课件 / 邮箱 / 成绩单）
 * 登录过的会话直接复用，显示「一键同步」（不再要密码）；没有才显示登录表单。
 */
import { useEffect, useRef, useState } from 'react'
import type { DataChange } from '../../types'
import {
  misLogin, misSync,
  type MisSyncResult
} from '../../api'
import { probeSessionSid } from '../../lib/misSession'
import ChangeDigestCard from '../ChangeDigestCard'
import AppShell from './AppShell'
import AppState from './AppState'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import type { AppEntryHostProps } from './types'

type Phase = 'form' | 'loggingIn' | 'fetching' | 'result'

export default function SyncApp({ onBack, onToast, onMutated }: AppEntryHostProps) {
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState('')
  /* 回到登录态时 +1，让 MisLoginForm 换一张验证码（保留已填的学号密码） */
  const [loginKey, setLoginKey] = useState(0)
  const [result, setResult] = useState<MisSyncResult | null>(null)
  const [changes, setChanges] = useState<DataChange[]>([])
  /** 打开页面时的会话池探测中 */
  const [probing, setProbing] = useState(true)
  /** 是否复用会话池里已有的登录（true = 显示「一键同步」，不再要学号/密码） */
  const [reused, setReused] = useState(false)
  /** 共享会话句柄（会话池：登录后留在服务端供其他应用复用，卸载不销毁、TTL 兜底） */
  const sidRef = useRef('')

  /* 打开页面：先探测会话池 —— 有可复用登录直接进入「一键同步」视图 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) {
        sidRef.current = found.sid
        setReused(true)
      }
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 用已就绪的 sid 跑同步（登录成功 / 复用会话池共用同一条路径） */
  async function runSync(useSid: string) {
    setPhase('fetching')
    const r = await misSync(useSid)
    setResult(r)
    setChanges(r.dataChanges ?? [])
    /* 会话已留在池里：之后「再同步一次」直接复用，其他教务应用也能用 */
    setReused(true)
    setPhase('result')
    /* 课表/学分可能被更新 → 通知 App 重新取数（周视图、课表页会跟着刷新） */
    onMutated()
    onToast(r.dataChanges?.length ? `同步完成，有 ${r.dataChanges.length} 项变动` : '同步完成')
  }

  async function handleSync() {
    setError('')
    /* 复用会话池：跳过登录表单直接同步 */
    if (reused && sidRef.current) {
      try {
        await runSync(sidRef.current)
      } catch (err) {
        const msg = err instanceof Error ? err.message : '同步失败，请重试'
        setError(msg)
        setPhase('form')
        if (/会话/.test(msg)) {
          /* 共享会话已失效（学校侧先过期）→ 退回登录表单 */
          setReused(false)
          sidRef.current = ''
          setLoginKey((k) => k + 1)
        }
      }
    }
  }

  /** 登录表单提交（MisLoginForm 已保证三字段非空） */
  async function handleLogin(cred: MisLoginCredential) {
    setError('')
    setPhase('loggingIn')
    try {
      await misLogin(cred)
      sidRef.current = cred.sid
      await runSync(cred.sid)
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败，请重试')
      setPhase('form')
      /* 验证码一次性：失败必须换一张 */
      setLoginKey((k) => k + 1)
    }
  }

  const busy = phase === 'loggingIn' || phase === 'fetching'

  /* ---------------- 会话池探测中（打开页面的第一瞬间） ---------------- */
  if (probing) {
    return (
      <AppShell title="数据同步" onBack={onBack}>
        <AppState kind="loading" title="正在检查登录状态…" hint="如果之前登录过教务，会直接复用，不必再输验证码。" />
      </AppShell>
    )
  }

  if (phase === 'result' && result) {
    const semester = result.bksy.semester
    return (
      <AppShell
        title="数据同步"
        onBack={onBack}
        action={
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setPhase('form')
              setResult(null)
              setChanges([])
            }}
          >
            再同步一次
          </button>
        }
      >
        <section className="apps-group">
          <div className="profile-section-title">本次结果</div>
          <div className="card profile-card sync-summary">
            <div className="sync-row">
              <span>课程表</span>
              <span className={result.courses.length > 0 ? 'sync-ok' : 'sync-miss'}>
                {result.courses.length > 0 ? `${result.courses.length} 门` : '未取到'}
              </span>
            </div>
            <div className="sync-row">
              <span>智慧课程平台</span>
              <span className={result.bksy.ok ? 'sync-ok' : 'sync-miss'}>
                {result.bksy.ok
                  ? `${result.bksy.courses.length} 门课 · ${result.bksy.homeworks.length} 条作业`
                  : result.bksy.error || '失败'}
              </span>
            </div>
            {result.totalCredits !== null && (
              <div className="sync-row">
                <span>教务总学分</span>
                <span className="sync-ok">{result.totalCredits}</span>
              </div>
            )}
            {semester && (
              <div className="sync-row">
                <span>当前学期</span>
                <span className="sync-ok">{semester.name || semester.xqCode}</span>
              </div>
            )}
          </div>
        </section>

        {changes.length > 0 ? (
          <ChangeDigestCard title={`相比上次，有 ${changes.length} 项变动`} changes={changes} />
        ) : (
          <div className="app-note">
            相比上次没有变化。变动会在每次同步后自动记录，并在「消息通知」里提醒你。
          </div>
        )}

        {result.aaError && (
          <div className="app-note sync-warn">
            教务侧部分失败（只影响学分）：{result.aaError}
          </div>
        )}

        {/* 评审 B7：部分课程/类型拉取失败必须显式告知，不能让作业"无声缺席" */}
        {result.bksy.failedCourses && result.bksy.failedCourses.length > 0 && (
          <div className="app-note sync-warn">
            以下课程条目本次未能拉取（其余数据已正常导入，可稍后重试同步）：
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {result.bksy.failedCourses.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </AppShell>
    )
  }

  /* ---------------- 复用会话池：一键同步（不再要学号/密码/验证码） ---------------- */
  if (reused) {
    return (
      <AppShell
        title="数据同步"
        onBack={onBack}
        lead="已复用教务登录状态，直接同步即可 —— 课表、作业、学分一次拉回。"
      >
        <div className="card profile-card">
          <div className="app-note">
            检测到已登录的教务会话（来自课件 / 邮箱 / 成绩单等应用的登录），无需再次输入学号密码。
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="app-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void handleSync()}>
              {phase === 'fetching' ? '正在同步…' : '开始同步'}
            </button>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell
      title="数据同步"
      onBack={onBack}
      lead="用学号登录一次，同时同步课程表、作业与学分。登录后其他教务应用可直接复用，密码不会被保存。"
    >
      <MisLoginForm
        busy={busy}
        error={error}
        refreshToken={loginKey}
        submitLabel="开始同步"
        busyLabel={phase === 'fetching' ? '正在同步…' : '正在登录…'}
        onLogin={handleLogin}
      />
    </AppShell>
  )
}
