/**
 * 考务：一键添加考试信息 —— 复用 MIS 统一认证登录教务系统，
 * 自动抓取本学期考试安排，确认后整表覆盖导入并「自动生成 DDL」。
 *
 * 流程与课表导入完全一致：开 SSO 会话 → 填学号/密码 → 登录 →
 * 拉取考试 → 预览 → 覆盖导入（createDdl=true 时为每场考试建一条高优先级考试任务）。
 * 学号与密码只在本弹窗内存中存在，提交后服务端瞬时使用、不落库。
 *
 * 2026-10 学校换用 sso.bjtu.edu.cn 后**没有验证码**了；未激活的账号会被直接拒绝，
 * 服务端错误文案里会提示"可能未激活"。
 */
import { useEffect, useRef, useState } from 'react'
import {
  importExams, misExams, misLogin, startMisSession,
  type ImportExamsResult, type MisExam
} from '../api'
import Modal from './Modal'

interface ExamMisImportProps {
  onClose: () => void
  /** 导入成功后回调（刷新课表 / DDL 数据），携带结果便于提示 */
  onImported: (result: ImportExamsResult) => void
}

type Phase = 'form' | 'loggingIn' | 'fetching' | 'preview' | 'importing' | 'done'

export default function ExamMisImport({ onClose, onImported }: ExamMisImportProps) {
  const [phase, setPhase] = useState<Phase>('form')
  const [sid, setSid] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [profile, setProfile] = useState<{ name: string } | null>(null)
  const [exams, setExams] = useState<MisExam[]>([])
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportExamsResult | null>(null)
  const sidRef = useRef('')

  /*
   * ⚠️ 卸载时不再销毁会话（2026-10-14 会话池）：导入流程登录成功的会话会留在
   * 池里供课件 / 邮箱 / 成绩单等应用复用；不活跃 2 小时由服务端 TTL 统一清理。
   */

  async function refreshSession() {
    setError('')
    setPhase('form')
    try {
      const r = await startMisSession()
      sidRef.current = r.sid
      setSid(r.sid)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录会话建立失败，请重试')
    }
  }

  useEffect(() => {
    refreshSession()
     
  }, [])

  async function handleLogin() {
    if (!username.trim() || !password) {
      setError('请填写学号和密码')
      return
    }
    setError('')
    setPhase('loggingIn')
    try {
      const p = await misLogin({ sid, username: username.trim(), password })
      setProfile({ name: p.name })
      setPhase('fetching')
      const r = await misExams(sid)
      sidRef.current = '' // 会话保留在池中（其他教务应用可复用），这里无需再跟踪
      if (r.exams.length === 0) {
        setError('登录成功，但教务系统暂未公布本学期考试安排（或考试页结构已变化）。可稍后关注教务通知，或用「添加」手动登记考试。')
        setPhase('form')
        return
      }
      setExams(r.exams)
      setPhase('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      await refreshSession()
    }
  }

  async function handleImport() {
    setPhase('importing')
    setError('')
    try {
      const r = await importExams(exams, true)
      setResult(r)
      setPhase('done')
      onImported(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败，请重试')
      setPhase('preview')
    }
  }

  const busy = phase === 'loggingIn' || phase === 'fetching' || phase === 'importing'

  return (
    <Modal
      open
      title="一键添加考试信息"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy && phase !== 'importing'}>
          {phase === 'done' ? '关闭' : '取消'}
        </button>
      }
    >
      {error && (
        <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>
      )}

      {(phase === 'form' || phase === 'loggingIn') && (
        <div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 12px', lineHeight: 1.7 }}>
            使用学校 MIS 统一身份认证登录（与交大钥匙相同的学号密码），自动抓取本学期考试安排，
            并一键为每场考试生成 DDL 提醒。密码仅用于本次登录，不会被保存。
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              学号
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="学号" autoComplete="off" disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="统一身份认证密码" autoComplete="new-password" disabled={busy} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) handleLogin() }} />
            </label>
            <button type="button" className="btn btn-primary" onClick={handleLogin} disabled={busy}>
              {phase === 'loggingIn' ? '正在登录…' : '登录并抓取考试'}
            </button>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-3)' }}>
              学校已改用统一身份认证（sso.bjtu.edu.cn），登录不再需要验证码。
              若确认密码无误仍提示错误，可能是账号<strong>还没有激活</strong>，请先到{' '}
              <a href="https://sso.bjtu.edu.cn" target="_blank" rel="noreferrer">sso.bjtu.edu.cn</a>{' '}
              完成激活后再试。
            </div>
          </div>
          <ul style={{ color: 'var(--text-2)', fontSize: 12, margin: '14px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
            <li>导入会覆盖当前已有的考试安排（原有考试记录将被清除），导入前可在下方预览核对</li>
            <li>抓取的每场考试都会自动生成一条高优先级 DDL（在「DDL」页可见），无需手动添加</li>
            <li>每分钟最多发起 15 次 MIS 登录</li>
          </ul>
        </div>
      )}

      {phase === 'fetching' && (
        <div style={{ textAlign: 'center', padding: '18px 0 10px' }}>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            {profile?.name ? `已登录（${profile.name}），` : '已登录，'}正在从教务系统抓取考试安排…
          </p>
        </div>
      )}

      {(phase === 'preview' || phase === 'importing' || phase === 'done') && exams.length > 0 && (
        <div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 10px' }}>
            共识别 {exams.length} 场考试
            {result && (
              <span style={{ color: 'var(--ok)' }}>
                {' '}· 已导入 {result.imported} 场，自动生成 DDL {result.taskCreated} 条（复用 {result.taskReused} 条）
              </span>
            )}
          </p>
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table className="period-table">
              <thead>
                <tr>
                  <th>科目</th>
                  <th>日期</th>
                  <th>时间</th>
                  <th>考场</th>
                  <th>座位</th>
                </tr>
              </thead>
              <tbody>
                {exams.map((e, i) => (
                  <tr key={i}>
                    <td>{e.courseName}</td>
                    <td>{e.examDate}</td>
                    <td>{e.startTime || '待定'}{e.endTime ? ` - ${e.endTime}` : ''}</td>
                    <td>{e.location || '—'}</td>
                    <td>{e.seat || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleImport}
              disabled={phase === 'importing' || phase === 'done'}
            >
              {phase === 'importing' ? '导入中…' : phase === 'done' ? '已完成' : `确认导入并为每场生成 DDL（${exams.length} 场）`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
