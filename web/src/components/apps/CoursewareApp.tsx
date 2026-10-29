/**
 * 课件下载（「应用」→ 学习）。
 *
 * 数据来源：智慧课程平台 `/ve/back/coursePlatform/courseResource.shtml?method=stuQueryUploadResourceForCourseList`。
 *
 * ⚠️ **不落库**：文件名/大小/下载状态可能随时变（老师可上可删），缓存会误导用户。
 *   MIS 会话进入**会话池**（任一教务应用登录一次即全应用复用，不活跃 2 小时过期），
 *   本页打开时自动探测复用、无会话才显示登录表单（自带轻量登录，
 *   与「成绩单」「邮箱」等单域应用同一策略）。
 *
 * ⚠️ 「展开文件夹」是按需请求，不一次性递归 —— 一门课可能有几十层目录、几百文件，
 *   一次性全拉既慢又容易超时。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  destroyMisSession, listCourseware, downloadCourseware, misLogin,
  listCoursewareCourses, exportCoursewareDirectory, createCoursewareDownloadTicket,
  createCoursewareExportTicket, type CoursewareCourseSummary
} from '../../api'
import { probeSessionSid } from '../../lib/misSession'
import { saveBlob } from '../../lib/saveFile'
import { absoluteUrl, canOpenSystemBrowser, isInAppShell, openInSystemBrowser } from '../../lib/systemBrowser'
import type { CoursewareList, CoursewareNode } from '../../types'
import {
  IconChevronRight, IconDownload, IconFolder
} from '../../icons'
import AppShell from './AppShell'
import AppState from './AppState'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import type { AppEntryHostProps } from './types'

type Phase = 'login' | 'pickCourse' | 'browsing'

/** 文件后缀 → emoji 图标（无第三方库） */
function fileEmoji(ext: string): string {
  const e = ext.toLowerCase()
  if (/^(pdf|doc|docx|ppt|pptx|xls|xlsx)$/.test(e)) return '📄'
  if (/^(zip|rar|7z|tar|gz)$/.test(e)) return '🗜️'
  if (/^(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(e)) return '🖼️'
  if (/^(mp4|mov|avi|mkv|webm)$/.test(e)) return '🎬'
  if (/^(mp3|wav|flac|m4a|ogg)$/.test(e)) return '🎵'
  if (/^(txt|md|json|xml|csv|log)$/.test(e)) return '📝'
  if (/^url$/.test(e)) return '🔗'
  return '📎'
}

export default function CoursewareApp({ onBack, onToast }: AppEntryHostProps) {
  const [phase, setPhase] = useState<Phase>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /* 回到登录态时 +1，让 MisLoginForm 换一张验证码（保留已填的学号密码） */
  const [loginKey, setLoginKey] = useState(0)

  /** 课件课程列表（轻量版，不走 sync） */
  const [courses, setCourses] = useState<CoursewareCourseSummary[]>([])
  /** 当前选中的课程下标（在 pickCourse 阶段选） */
  const [courseIdx, setCourseIdx] = useState<number | null>(null)
  /** 当前文件夹的栈：每一项是 `{ courseIdx, parentId, title }` */
  const [stack, setStack] = useState<Array<{ courseIdx: number; parentId: string; title: string }>>([])
  const [list, setList] = useState<CoursewareList | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  /** 正在下载的那一项的 id（只让那一行显示「下载中」，不整页替换） */
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  /** 整目录导出中（导出期间锁住所有下载按钮，避免并发把服务端压垮） */
  const [exporting, setExporting] = useState(false)
  /** 打开页面时的会话池探测中（命中则跳过登录表单直接进入） */
  const [probing, setProbing] = useState(true)

  const sidRef = useRef('')

  /*
   * ⚠️ 卸载时**不再销毁会话**（2026-10-14 会话池）：用户离开课件页后，
   * 邮箱 / 成绩单 / 数据同步等应用还要复用同一份登录；不活跃 2 小时由服务端
   * TTL 兜底清理。用户想主动退出 → 用页面右上角的「退出」按钮（销毁共享会话）。
   */

  /** 拿到可用 sid（登录成功或复用会话池）后：拉课程列表并进入选课阶段 */
  const enterWithSid = useCallback(async (useSid: string) => {
    const r = await listCoursewareCourses(useSid)
    sidRef.current = useSid
    setCourses(r.courses)
    /* 重试成功必须清掉上一次的错误，否则错误卡片会一直挂在那儿 */
    setError('')
    setPhase('pickCourse')
  }, [])

  /* 打开页面：先探测会话池 —— 已有可复用的教务登录就直接进入（"打开应用自动登录"）；
     没有才走「验证码 + 学号密码」表单（验证码由 MisLoginForm 自己拉）。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) {
        try {
          await enterWithSid(found.sid)
          if (!cancelled) setProbing(false)
          return
        } catch {
          /* 学校侧会话可能已先失效：静默回退到登录表单，让用户重新登录一次 */
        }
      }
      if (cancelled) return
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [enterWithSid])

  /** 第一步：登录 + 轻量取本学期课程列表（不走 sync） */
  async function handleLogin(cred: MisLoginCredential) {
    setError('')
    setBusy(true)
    try {
      await misLogin(cred)
      // 登录成功后会话留在会话池里（其他教务应用直接复用），这里立刻用它拉课程列表
      await enterWithSid(cred.sid)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      /* 验证码一次性：失败必须换一张，否则重试必然再失败 */
      setLoginKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  async function openCourse(idx: number) {
    const c = courses[idx]
    if (!c) return
    setCourseIdx(idx)
    setStack([{ courseIdx: idx, parentId: '0', title: c.name }])
    await loadList(idx, '0')
  }

  async function loadList(idx: number, parentId: string) {
    const c = courses[idx]
    if (!c) return
    setLoadingList(true)
    setError('')
    try {
      const r = await listCourseware(sidRef.current, c, parentId)
      setList(r)
      setPhase('browsing')
    } catch (e) {
      setError(e instanceof Error ? e.message : '课件列表获取失败')
      setList(null)
    } finally {
      setLoadingList(false)
    }
  }

  async function onDownload(node: CoursewareNode) {
    if (!node.canDownload) {
      onToast('该文件未开放下载')
      return
    }
    if (!sidRef.current) {
      onToast('会话已失效，请重新登录')
      return
    }
    /* ⚠️ 只标出"正在下这一个"，不再把整个列表换成「正在下载…」：
       课件常有几 MB，下载期间列表整页消失会让人以为回到了上一级，
       而且看不出到底是哪个文件在下。 */
    setDownloadingId(node.id)
    const fileName = node.name || `课件-${node.id}.${node.ext || 'bin'}`
    try {
      /*
       * App 壳里：换一张短命票据，把下载**交给系统浏览器**。
       *
       * 为什么不在壳里直接下：WebView 没有下载管理器，只能把文件读成 base64
       * 过原生桥，几十 MB 会卡住 JS 线程，而且全程没有任何进度 ——
       * 用户看到的就是「点了下载，然后什么都没有」。
       * 交给浏览器后由它显示进度条、通知栏提醒、下完可直接打开。
       */
      if (isInAppShell() && canOpenSystemBrowser()) {
        try {
          const t = await createCoursewareDownloadTicket(sidRef.current, node.rpId, fileName)
          if (openInSystemBrowser(absoluteUrl(t.path))) {
            onToast('已交给浏览器下载，进度看通知栏')
            return
          }
        } catch {
          /* 换票据失败（会话过期等）→ 落到下面的 Blob 方案，别让用户点了没反应 */
        }
      }

      const blob = await downloadCourseware(sidRef.current, node.rpId, fileName)
      /* ⚠️ 必须走 saveBlob 而不是 <a download>：Android WebView 里后者点了没反应。
         详见 lib/saveFile.ts 顶部注释。 */
      const r = await saveBlob(blob, fileName)
      onToast(r.message)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '下载失败')
    } finally {
      setDownloadingId(null)
    }
  }

  const currentStackItem = stack[stack.length - 1]

  /**
   * 整目录导出。
   *
   * `parentId` = 当前所在目录（栈顶），`title` = 该目录名，用来给 zip 命名。
   * 导完必须把「跳过了几个」「是否被截断」如实说出来 —— 用户拿到一个缺文件的包
   * 却以为完整，比导出失败更糟。
   */
  async function onExportDirectory() {
    if (!sidRef.current) {
      onToast('会话已失效，请重新登录')
      return
    }
    const idx = stack[0]?.courseIdx
    const c = idx === undefined ? undefined : courses[idx]
    const parentId = currentStackItem?.parentId ?? '0'
    if (!c) {
      onToast('课程信息丢失，请重新进入')
      return
    }
    setExporting(true)
    const blobName = `${(currentStackItem?.title || c.name).replace(/[/\\:*?"<>|]/g, '_')}.zip`
    try {
      /* App 壳里同单文件：整目录 zip 往往几十 MB，交给浏览器下载（进度 + 通知栏） */
      if (isInAppShell() && canOpenSystemBrowser()) {
        try {
          const t = await createCoursewareExportTicket(
            sidRef.current, c, parentId, currentStackItem?.title || c.name
          )
          if (openInSystemBrowser(absoluteUrl(t.path))) {
            onToast('已交给浏览器打包下载，文件大时请稍候')
            return
          }
        } catch {
          /* 换票据失败 → 走原来的 Blob 方案 */
        }
      }

      const r = await exportCoursewareDirectory(
        sidRef.current, c, parentId, currentStackItem?.title || c.name
      )
      const saved = await saveBlob(r.blob, blobName)
      /* 一次性把结果说全：成功了几张、跳过了几个、失败几个、是否被截断 */
      const parts = [`已导出 ${r.files} 个文件`]
      if (r.skipped > 0) parts.push(`跳过 ${r.skipped} 个未开放下载`)
      if (r.failed > 0) parts.push(`${r.failed} 个下载失败`)
      if (r.truncated) parts.push('已达单次导出上限，如需完整内容请进入子目录分批导出')
      onToast(`${saved.message}；${parts.join('，')}`)
    } catch (e) {
      onToast(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  /* ---------------- 会话池探测中（打开页面的第一瞬间） ---------------- */
  if (probing) {
    return (
      <AppShell title="课件下载" onBack={onBack}>
        <AppState kind="loading" title="正在检查登录状态…" hint="如果之前登录过教务，会直接复用，不必再输验证码。" />
      </AppShell>
    )
  }

  /* ---------------- 登录阶段 ---------------- */
  if (phase === 'login') {
    return (
      <AppShell
        title="课件下载"
        onBack={onBack}
        lead="登录后看到本学期智慧课程平台的课程列表，点击进入看每门课下的资料。"
      >
        <MisLoginForm
          busy={busy}
          error={error}
          refreshToken={loginKey}
          submitLabel="登录并加载课程"
          onLogin={handleLogin}
        />
        <div className="app-note is-tight">
          登录一次即可 —— 课件 / 校园邮箱 / 成绩单等应用都会复用这次登录状态，不用重复输入。
        </div>
      </AppShell>
    )
  }

  /* ---------------- 选课程 ---------------- */
  if (phase === 'pickCourse' || courses.length > 0 && courseIdx === null) {
    return (
      <AppShell
        title="课件下载"
        onBack={onBack}
        action={
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              if (sidRef.current) destroyMisSession(sidRef.current).catch(() => undefined)
              sidRef.current = ''
              setCourses([])
              setPhase('login')
              setLoginKey((k) => k + 1)
            }}
          >
            退出
          </button>
        }
        lead={`当前学期共 ${courses.length} 门课，点击进入查看课件。`}
      >
        {error && (
          <AppState
            kind="error"
            title={error}
            hint="学校侧的会话有时会提前失效，重新登录一次通常就能恢复。"
            onRetry={() => {
              /* sid 还在就原地重拉；sid 已经没了（登录失败 / 已退出）就回登录表单 */
              if (sidRef.current) void enterWithSid(sidRef.current)
              else {
                setPhase('login')
                setLoginKey((k) => k + 1)
              }
            }}
            retryLabel="重试"
          />
        )}
        {courses.length === 0 && !error && (
          <AppState
            kind="empty"
            title="当前学期没有找到课程"
            hint="请确认智慧课程平台能正常登录；如果平台上有课但这里为空，可能是学校侧改版了。"
          />
        )}
        {courses.length > 0 && (
          <div className="course-list">
            {courses.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className="course-row cw-course"
                onClick={() => void openCourse(i)}
                disabled={loadingList}
              >
                <span className="course-row-main">
                  <span className="course-row-title">{c.name}</span>
                  <span className="course-row-meta">{c.teacher}</span>
                </span>
                <IconChevronRight size={18} />
              </button>
            ))}
          </div>
        )}
      </AppShell>
    )
  }

  /* ---------------- 浏览文件 ---------------- */
  return (
    <AppShell
      title={currentStackItem?.title ?? '课件'}
      onBack={onBack}
      action={
        <span className="cw-toolbar">
          {/* 整目录导出：递归展开当前目录（或整门课）打成 zip。
              文件多时会跑很久，所以导出期间禁用，并把按钮文案改成进度提示。 */}
          <button
            type="button"
            className="btn-ghost"
            disabled={exporting || loadingList || !list || list.nodes.length === 0}
            onClick={() => void onExportDirectory()}
            title="把当前目录（含所有子目录）打包成 zip 下载"
          >
            {exporting ? (
              <>
                <span className="app-spinner" aria-hidden="true" />
                导出中
              </>
            ) : (
              <>
                <IconFolder size={16} />
                导出本目录
              </>
            )}
          </button>
          {stack.length > 1 ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={exporting}
              onClick={() => {
                const next = stack.slice(0, -1)
                setStack(next)
                const top = next[next.length - 1]
                if (top) void loadList(top.courseIdx, top.parentId)
              }}
            >
              返回上级
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              disabled={exporting}
              onClick={() => {
                setCourseIdx(null)
                setStack([])
                setList(null)
              }}
            >
              切换课程
            </button>
          )}
        </span>
      }
      lead={list ? `${list.nodes.length} 项` : ''}
    >
      {error && (
        <AppState
          kind="error"
          title={error}
          onRetry={() => void loadList(stack[0]?.courseIdx ?? 0, currentStackItem?.parentId ?? '0')}
          retryLabel="重新加载"
        />
      )}
      {loadingList && <AppState kind="loading" title="正在加载资料列表…" />}
      {!loadingList && list && list.nodes.length === 0 && (
        <AppState
          kind="empty"
          title={list.empty ? '这门课没有上传任何资料' : '这个目录是空的'}
          hint={list.empty ? '老师上传资料后会出现在这里。' : '换一个文件夹看看，或点右上角「切换课程」。'}
        />
      )}
      {!loadingList && list && list.nodes.length > 0 && (
        <div className="cw-list">
          {list.nodes.map((n) => {
            const dl = downloadingId === n.id
            return (
              <div key={`${n.kind}-${n.id}`} className={`cw-row${n.kind === 'folder' ? ' is-folder' : ' is-file'}`}>
                <span className="cw-ico">{n.kind === 'folder' ? <IconFolder size={20} /> : fileEmoji(n.ext)}</span>
                <span className="cw-main">
                  <span className="cw-name">{n.name}</span>
                  <span className="cw-meta">
                    {n.kind === 'file' ? (
                      <>
                        {n.ext && <span className="cw-tag">{n.ext.toUpperCase()}</span>}
                        {n.size && <span className="cw-tag">{n.size}</span>}
                        {n.teacherName && <span className="cw-tag">{n.teacherName}</span>}
                        {n.downloadCount > 0 && <span className="cw-tag">{n.downloadCount} 次下载</span>}
                        {!n.canDownload && <span className="cw-tag is-bad">未开放</span>}
                      </>
                    ) : (
                      <span className="cw-tag">文件夹</span>
                    )}
                  </span>
                </span>
                {n.kind === 'folder' ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={exporting}
                    onClick={async () => {
                      const next = [...stack, { courseIdx: stack[0].courseIdx, parentId: n.id, title: n.name }]
                      setStack(next)
                      await loadList(stack[0].courseIdx, n.id)
                    }}
                  >
                    展开
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost cw-dl"
                    /* 只禁用「正在下的这一个」和不可下载的；其他文件仍可点，
                       避免一个 20MB 的附件把整个列表锁死。
                       但整目录导出期间全部锁住 —— 并发几十个请求会把资源服务打挂。 */
                    disabled={!n.canDownload || dl || exporting}
                    onClick={() => void onDownload(n)}
                    title={n.canDownload ? '下载' : '该文件未开放下载'}
                  >
                    {dl ? <span className="app-spinner" aria-hidden="true" /> : <IconDownload size={16} />}
                    {dl ? '下载中' : '下载'}
                  </button>                )}
              </div>
            )
          })}
        </div>
      )}
    </AppShell>
  )
}
