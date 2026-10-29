/**
 * 成绩单下载（「应用」→ 工具）。
 *
 * 数据来源：本科教务的**成绩单打印页**，服务端把 PDF 字节流转回来（`/api/report-card`）。
 *
 * ⚠️ 为什么服务端要转字节流而不是给个链接让前端直跳：
 *   教务系统要求**带 cookie 的登录态**才能访问该页，浏览器直接打开 / 新窗口跳转
 *   都会因为没有 MIS 会话而看到登录页。所以我们让服务端带着登录会话（会话池）
 *   取回 PDF 二进制，再原样吐给前端 —— 前端拿到的是「已登录后才看得到的东西」。
 *
 * ⚠️ 2026-10-14 修复：此前页面**从不传 sid**（也没有登录入口），服务端
 *   requireSession 必然失败 —— 功能从未可用过。现改为自带轻量登录
 *   （验证码 + misLogin）。
 *   会话策略（会话池）：打开时先探测 —— 任一教务应用登录过的会话直接复用
 *   （"打开应用自动登录"）；离开页面**不销毁**（其他应用还要用），
 *   「退出」按钮才销毁共享会话。
 *
 * ⚠️ 中文成绩单常见坑：部分打印机/教务模板的 PDF 内嵌字体不含中文，
 *   或干脆是**扫描图**。因此这里不做「解析 PDF 内容再展示」，
 *   只提供下载 + 内嵌预览 —— 用户要的是那张盖章的纸，不是重新排版的数据
 *   （要看数据请用「成绩查询」，那边是结构化的）。
 */
import { useEffect, useRef, useState } from 'react'
import {
  destroyMisSession, downloadReportCard, misLogin,
  type ReportCardLanguage
} from '../../api'
import { probeSessionSid } from '../../lib/misSession'
import { saveBlob, hasNativeDownloadBridge } from '../../lib/saveFile'
import { IconDownload } from '../../icons'
import AppShell from './AppShell'
import AppState from './AppState'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import type { AppEntryHostProps } from './types'

const LANG_OPTIONS: ReadonlyArray<{ id: ReportCardLanguage; label: string; hint: string }> = [
  { id: 'zh', label: '中文成绩单', hint: '中文 / 培养方案课程名' },
  { id: 'en', label: 'English', hint: '英文 / 用于留学申请' }
]

export default function ReportCardApp({ onBack, onToast }: AppEntryHostProps) {
  const [phase, setPhase] = useState<'login' | 'ready'>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /* 会话失效回到登录态时 +1，让 MisLoginForm 换一张验证码
     （避免用户拿着已被服务端消费的旧验证码反复失败；已填的学号密码保留） */
  const [loginKey, setLoginKey] = useState(0)

  const [lang, setLang] = useState<ReportCardLanguage>('zh')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  /* 原始 Blob 必须留着：预览用 objectURL，但「下载」要走 saveBlob
     （Android WebView 里 <a download> 点了没反应，详见 lib/saveFile.ts）。 */
  const blobRef = useRef<Blob | null>(null)

  /** 打开页面时的会话池探测中（命中则跳过登录表单直接进入） */
  const [probing, setProbing] = useState(true)

  const sidRef = useRef('')

  /*
   * ⚠️ 卸载时不再销毁会话（2026-10-14 会话池）：课件 / 邮箱 / 数据同步
   * 还要复用同一份登录；不活跃 2 小时由服务端 TTL 兜底清理。
   */

  /* 打开页面：先探测会话池 —— 有可复用登录直接进「待下载」态（自动登录），没有才显示登录表单。
     验证码的获取交给 MisLoginForm 自己处理（它会去重，不会重复消耗学校侧配额）。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) {
        sidRef.current = found.sid
        setPhase('ready')
      }
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleLogin(cred: MisLoginCredential) {
    setError('')
    setBusy(true)
    try {
      await misLogin(cred)
      sidRef.current = cred.sid
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      /* 验证码是一次性的：失败后必须换一张，否则用户重试必然再失败 */
      setLoginKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  /** 取回 PDF 并生成 objectURL；同一个 objectURL 既用于预览也用于下载 */
  async function fetchPdf(): Promise<{ url: string; name: string; blob: Blob } | null> {
    if (!sidRef.current) {
      setError('会话已过期，请重新登录')
      setPhase('login')
      setLoginKey((k) => k + 1)
      return null
    }
    setBusy(true)
    try {
      const blob = await downloadReportCard(sidRef.current, lang)
      // 旧预览要先释放，否则每点一次就泄漏一份 blob
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      const url = URL.createObjectURL(blob)
      blobRef.current = blob
      const name = `${lang === 'en' ? 'Transcript' : '成绩单'}-${stamp()}.pdf`
      setPreviewUrl(url)
      setFileName(name)
      setError('')
      return { url, name, blob }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '获取成绩单失败'
      /* 除了 toast，也在页面里留一条 —— toast 几秒就消失，
         用户回头看页面时只剩「预览」按钮，不知道刚才失败过。 */
      setError(msg)
      onToast(msg)
      /* 会话失效（单发授权被回收 / 过期）→ 回登录页 */
      if (/会话/.test(msg)) {
        sidRef.current = ''
        setPhase('login')
        setLoginKey((k) => k + 1)
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  async function onPreview() {
    const r = await fetchPdf()
    if (r) onToast('已生成预览，可长按 / 右键保存')
  }

  async function onDownload() {
    // 已经取过就直接下载，避免重复登录教务
    const r = previewUrl && blobRef.current
      ? { url: previewUrl, name: fileName, blob: blobRef.current }
      : await fetchPdf()
    if (!r) return
    /* ⚠️ 走 saveBlob：Android WebView 里 <a download> 点了没反应，
       这是「App 端成绩单下载失败」的直接原因。 */
    const saved = await saveBlob(r.blob, r.name)
    onToast(saved.message)
  }

  function exitSession() {
    if (sidRef.current) destroyMisSession(sidRef.current).catch(() => undefined)
    sidRef.current = ''
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setError('')
    setPhase('login')
    setLoginKey((k) => k + 1)
  }

  /* ---------------- 会话池探测中（打开页面的第一瞬间） ---------------- */
  if (probing) {
    return (
      <AppShell title="成绩单下载" onBack={onBack}>
        <AppState kind="loading" title="正在检查登录状态…" hint="如果之前登录过教务，会直接复用，不必再输验证码。" />
      </AppShell>
    )
  }

  /* ---------------- 登录阶段 ---------------- */
  if (phase === 'login') {
    return (
      <AppShell
        title="成绩单"
        onBack={onBack}
        lead="从本科教务系统导出带公章的成绩单 PDF。首次使用需登录一次教务（验证码），留学的同学请选英文版。"
      >
        <MisLoginForm
          busy={busy}
          error={error}
          refreshToken={loginKey}
          onLogin={handleLogin}
        />
      </AppShell>
    )
  }

  /* ---------------- 下载阶段 ---------------- */
  return (
    <AppShell
      title="成绩单"
      onBack={onBack}
      action={
        <button type="button" className="btn-ghost" onClick={exitSession}>
          退出
        </button>
      }
      lead="已登录教务（会话仅本次停留有效）。成绩单由教务按需生成，首次获取可能需要几秒。"
    >
      <section className="apps-group">
        <div className="profile-section-title">选择版本</div>
        <div className="seg-list">          {LANG_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`seg-item${lang === o.id ? ' is-active' : ''}`}
              onClick={() => {
                setLang(o.id)
                // 切换语言后旧预览作废
                if (previewUrl) {
                  URL.revokeObjectURL(previewUrl)
                  setPreviewUrl(null)
                }
              }}
            >
              <span className="seg-label">{o.label}</span>
              <span className="seg-hint">{o.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {error && (
        <AppState
          kind="error"
          title={error}
          hint="教务生成成绩单偶尔会超时，重试一次通常就好；连续失败可换个时间再来。"
          onRetry={() => void onPreview()}
          retryLabel="重新获取"
        />
      )}

      <div className="app-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void onPreview()}>
          {busy ? '获取中…' : previewUrl ? '刷新预览' : '预览'}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onDownload()}>
          <IconDownload size={17} />
          {busy ? '处理中…' : '下载 PDF'}
        </button>
      </div>

      {previewUrl && (
        <section className="apps-group">
          <div className="profile-section-title">预览</div>
          {/* 用 iframe 而非 <embed>：Safari / 微信内置浏览器对 <embed> 的 PDF 支持不一致 */}
          <iframe className="pdf-frame" src={previewUrl} title="成绩单预览" />
          <div className="app-note">
            手机上若无法内嵌预览，请直接点「下载 PDF」。
            {hasNativeDownloadBridge()
              ? '文件会保存到「下载 / bjtu-helper」目录。'
              : '浏览器会存到默认下载目录；用 App 打开本站可直接存进系统下载目录。'}
          </div>
        </section>
      )}
    </AppShell>
  )
}

/** 文件名用的时间戳：20261015-1630 */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
