/**
 * 全局「发现新版本」提示门（挂在 main.tsx，壳内外都渲染，但只在 App 壳里生效）。
 *
 * 为什么放在全局而不是某个页面里：1.7 之前的壳没有任何更新通道，用户可能
 * 停在登录页就再也不往下走 —— 提示必须与当前页面无关，一进 App 就能看到。
 * 详见 lib/appUpdate.ts 顶部对「老版本为什么收不到推送」的说明。
 *
 * 交互刻意做得"轻"：
 *   - 启动时静默检查（6 小时最多一次，与壳里的原生检查同节流），有新版才浮出一条卡片；
 *   - 点卡片打开弹窗看更新内容，再决定「立即更新」还是「稍后」；
 *   - 「稍后」按版本号记住，同一个版本不再打扰（下一个版本仍会提示）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import {
  CHECK_UPDATE_EVENT,
  deliverApk,
  fetchApkManifest,
  isNewerThanShell,
  markChecked,
  readSkippedVersion,
  shouldAutoCheck,
  shellVersion,
  writeSkippedVersion,
  type ApkDownloadResult,
  type ApkManifest,
  type ShellVersion
} from '../lib/appUpdate'

export default function AppUpdateGate() {
  /* 壳版本在组件生命周期内不会变，取一次即可 */
  const [shell] = useState<ShellVersion>(() => shellVersion())
  const [manifest, setManifest] = useState<ApkManifest | null>(null)
  const [visible, setVisible] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApkDownloadResult | null>(null)
  /** 手动检查的即时反馈（已是最新 / 检查失败），4 秒后自动消失 */
  const [hint, setHint] = useState('')
  const hintTimer = useRef<number | null>(null)

  const flashHint = useCallback((text: string) => {
    setHint(text)
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHint(''), 4000)
  }, [])

  /**
   * @param manual true = 用户在「关于」里主动点的检查（绕过节流；已最新/失败都要给反馈）
   */
  const check = useCallback(
    async (manual: boolean) => {
      if (!shell.inShell) return
      if (!manual && !shouldAutoCheck()) return
      const m = await fetchApkManifest()
      if (!m) {
        /* ⚠️ 失败**不能**打节流时间戳：启动瞬间 WebView 常常还没连上网，
           一次抖动就会白丢接下来 6 小时的自动检查窗口。
           只有真正拿到清单（不论新旧）才算"检查过"。 */
        if (manual) flashHint('检查更新失败，请检查网络后重试')
        return
      }
      markChecked()
      if (!isNewerThanShell(m, shell)) {
        if (manual) flashHint(`已是最新版本 v${shell.versionName || m.versionName}`)
        return
      }
      /* 用户对**这个版本**点过「稍后」→ 自动检查时不再打扰；主动检查则照常提示 */
      if (!manual && readSkippedVersion() === m.versionName) return
      setManifest(m)
      setResult(null)
      setVisible(true)
      if (manual) setModalOpen(true)
    },
    [flashHint, shell]
  )

  useEffect(() => {
    void check(false)
    return () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current)
    }
  }, [check])

  /* 「我的 → 关于 → 检查更新」派发的事件（老壳没有 checkUpdate 桥，只能走这条） */
  useEffect(() => {
    if (!shell.inShell) return
    const onManual = () => void check(true)
    window.addEventListener(CHECK_UPDATE_EVENT, onManual)
    return () => window.removeEventListener(CHECK_UPDATE_EVENT, onManual)
  }, [check, shell.inShell])

  if (!shell.inShell) return null

  const dismiss = () => {
    setVisible(false)
    if (manifest) writeSkippedVersion(manifest.versionName)
  }

  const doUpdate = async () => {
    if (!manifest || busy) return
    setBusy(true)
    try {
      setResult(await deliverApk(manifest))
    } finally {
      setBusy(false)
    }
  }

  /* APK 只有几十 KB，直接 toFixed(1) 会显示成 "0.0MB"；小于 1MB 时改用 KB */
  const sizeText = (() => {
    const bytes = manifest?.sizeBytes ?? 0
    if (bytes <= 0) return ''
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
  })()

  return (
    <>
      {visible && manifest && !modalOpen && (
        <div className="app-update-card" role="status">
          <div className="app-update-main">
            <span className="app-update-title">发现新版本 v{manifest.versionName}</span>
            <span className="app-update-sub">
              当前 v{shell.versionName || '未知'}
              {manifest.releasedAt ? ` · ${manifest.releasedAt} 发布` : ''}
            </span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setModalOpen(true)}>
            查看
          </button>
          <button type="button" className="app-update-close" aria-label="关闭更新提示" onClick={dismiss}>
            ×
          </button>
        </div>
      )}

      {hint && (
        <div className="app-update-card is-hint" role="status">
          <div className="app-update-main">
            <span className="app-update-sub">{hint}</span>
          </div>
        </div>
      )}

      {manifest && (
        <Modal
          open={modalOpen}
          title={`发现新版本 v${manifest.versionName}`}
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  writeSkippedVersion(manifest.versionName)
                  setVisible(false)
                  setModalOpen(false)
                }}
              >
                稍后
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void doUpdate()} disabled={busy}>
                {busy ? '准备中…' : '立即更新'}
              </button>
            </>
          }
        >
          <div className="app-update-dialog">
            <p className="app-update-meta">
              当前版本 v{shell.versionName || '未知'} → 最新 v{manifest.versionName}
              {sizeText ? ` · 安装包 ${sizeText}` : ''}
            </p>
            {manifest.changelog && manifest.changelog.length > 0 && (
              <ul className="app-update-log">
                {manifest.changelog.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            <p className="app-update-note">
              覆盖安装不会清除数据：登录状态、课表、DDL 与本地设置都会保留。
              {manifest.osRequirement ? `（${manifest.osRequirement}）` : ''}
            </p>
            {result && (
              <p className={`app-update-result is-${result.delivery}`}>
                {result.message}
                {result.delivery === 'manual' && (
                  <a href={result.fallbackUrl} target="_blank" rel="noreferrer">
                    {result.fallbackUrl}
                  </a>
                )}
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
