/**
 * 课程平台作业（「应用」→ 学习）。
 *
 * 数据来自服务端 /api/homework（由 /api/mis/sync 落库）。
 * 列表本身**只读**：作业的提交要在学校平台完成，这里做不到也不该假装做得到。
 * 所以每条给「去平台提交」的入口，而不是一个点了会失败的提交按钮。
 *
 * ## 2026-10-20：新增「作业详情 + 老师附件」
 *
 * 列表接口（`queryStudentCourseNoteList`）只给标题和正文，**附件在另一个接口**
 * （`queryStudentCourseNote`，要 upId + courseId + teacherId 三元组）。
 * 所以这里是「按需实时拉取」：点开某条作业才请求详情，失败只影响这一条。
 *
 * 需要 MIS 会话（sid），所以本页现在会先用会话池探测自动登录，
 * 没有会话才显示登录表单 —— 和课件/邮箱两个应用一致。
 * **没登录也照样能看列表**（列表有本地库），只是看不到附件。
 *
 * 分组方式：**按课程**分组（2026-10-14 按用户反馈改版）。
 *  - 课程组顺序：有待完成的课靠前（按待完成数降序），其余按课程名；
 *  - 组内顺序：未交的在前（按截止时间升序），已交的在后；
 *  - 顶部一行总览（几门课 / 共几条 / 待完成几条），第一眼回答"我还有没有没交的"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Homework } from '../../types'
import {
  listHomework,
  getHomeworkDetail,
  downloadHomeworkAttachment,
  misLogin,
  destroyMisSession,
  type HomeworkDetail
} from '../../api'
import { probeSessionSid } from '../../lib/misSession'
import { saveBlob } from '../../lib/saveFile'
import { useAbortController, isAbortError } from '../../lib/useAbortController'
import { IconRefresh, IconArrowRight, IconDownload } from '../../icons'
import {
  copyText,
  saveText,
  homeworkToMarkdown,
  homeworkListToMarkdown,
  homeworkFilename
} from '../../lib/markdownExport'
import AppShell from './AppShell'
import AppState from './AppState'
import HomeworkSubmitPanel from './HomeworkSubmitPanel'
import MisLoginForm, { type MisLoginCredential } from './MisLoginForm'
import type { AppEntryHostProps } from './types'

const BKSY_HOME = 'https://bksy.bjtu.edu.cn'

/** 截止状态的展示配置（颜色 + 文案）。'unknown' 走中性灰，不猜。 */
const STATE_META: Record<Homework['deadlineState'], { label: string; cls: string }> = {
  overdue: { label: '已逾期', cls: 'is-overdue' },
  dueSoon: { label: '即将截止', cls: 'is-soon' },
  open: { label: '进行中', cls: '' },
  submitted: { label: '已提交', cls: 'is-done' },
  unknown: { label: '无截止时间', cls: 'is-unknown' }
}

/** 截止时间展示：把 "2026-10-20 23:00:00" 压成 "10/20 23:00" */
function fmtEnd(end: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2}:\d{2})?/.exec(end.trim())
  if (!m) return end
  return `${Number(m[2])}/${Number(m[3])}${m[4] ? ` ${m[4]}` : ''}`
}

function typeLabel(t: number): string {
  return t === 0 ? '作业' : t === 1 ? '课程设计' : '实验报告'
}

/** 文件大小：附件接口可能给 0（平台没记录），要区分「0」和「未知」 */
function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

interface CourseGroup {
  course: string
  items: Homework[]
  pending: number
}

export default function HomeworkApp({ onBack, onToast, refreshKey }: AppEntryHostProps) {
  const [items, setItems] = useState<Homework[]>([])
  const [lastSyncedCount, setLastSyncedCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  /** 展开的作业 id（详情内嵌在列表里，而不是跳新页 —— 作业内容通常很短） */
  const [openId, setOpenId] = useState<number | null>(null)
  /* 三个筛选开关。默认全开（= 不筛），因为最常见的诉求是"我还有没有没交的"，
     一进来就把东西藏起来会让人以为数据没同步到。 */
  const [hideSubmitted, setHideSubmitted] = useState(false)
  const [hideOverdue, setHideOverdue] = useState(false)
  /** 课程筛选：'' = 全部 */
  const [courseFilter, setCourseFilter] = useState('')
  const begin = useAbortController()

  /* ---------------- MIS 会话（只为拉详情与附件） ---------------- */
  /**
   * 当前可用的教务 sid。
   * 空串 = 还没登录 —— 不影响列表展示，只是详情里没有附件区。
   * 用 ref 而不是 state：详情请求是事件驱动的，不需要为 sid 变化重渲染。
   */
  const sidRef = useRef('')
  const [sid, setSid] = useState('')
  const [showLogin, setShowLogin] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [loginKey, setLoginKey] = useState(0)
  const [probing, setProbing] = useState(true)

  /* ---------------- 详情缓存与请求守卫 ---------------- */
  const [details, setDetails] = useState<Record<number, HomeworkDetail>>({})
  /** 正在拉详情的作业 id（null = 没有进行中的请求） */
  const [detailBusy, setDetailBusy] = useState<number | null>(null)
  const [detailError, setDetailError] = useState<{ upId: number; msg: string } | null>(null)
  /** 正在下载的附件 id（`${upId}-${attId}`） */
  const [attBusy, setAttBusy] = useState<string | null>(null)
  /** 已展开过的 upId：避免重复请求同一个详情（缓存命中也会走一次接口，但很快） */
  const seenRef = useRef(new Set<number>())

  /** 设置 sid 的两处入口统一走这里，避免 ref 与 state 不同步 */
  const setSession = useCallback((next: string) => {
    sidRef.current = next
    setSid(next)
  }, [])

  /* 打开页面先探测会话池：之前登录过教务就直接复用（详情不必再登一次） */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await probeSessionSid()
      if (cancelled) return
      if (found) setSession(found.sid)
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [setSession])

  /** 会话类错误（服务端文案里带「会话」）→ 清掉 sid 并引导重新登录 */
  const dropSessionIfExpired = useCallback(
    (msg: string) => {
      if (/会话/.test(msg)) {
        setSession('')
        setShowLogin(true)
        setLoginKey((k) => k + 1)
      }
    },
    [setSession]
  )

  /** 拉某条作业的详情。`refresh` 只在用户点「刷新」时为 true（绕过服务端缓存） */
  const loadDetail = useCallback(
    async (upId: number, refresh = false) => {
      const useSid = sidRef.current
      if (!useSid) {
        setShowLogin(true)
        return
      }
      setDetailBusy(upId)
      setDetailError(null)
      try {
        const r = await getHomeworkDetail(useSid, upId, refresh)
        setDetails((prev) => ({ ...prev, [upId]: r.detail }))
        seenRef.current.add(upId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : '附件加载失败'
        setDetailError({ upId, msg })
        dropSessionIfExpired(msg)
      } finally {
        setDetailBusy(null)
      }
    },
    [dropSessionIfExpired]
  )

  async function handleLogin(cred: MisLoginCredential) {
    setLoginError('')
    setLoginBusy(true)
    try {
      await misLogin(cred)
      setSession(cred.sid)
      setShowLogin(false)
      /* 登录成功后把当前展开的那条详情补上，省得用户再点一次 */
      if (openId !== null) {
        const h = items.find((x) => x.id === openId)
        if (h) await loadDetail(h.upId, true)
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : '登录失败，请重试')
      setLoginKey((k) => k + 1)
    } finally {
      setLoginBusy(false)
    }
  }

  function exitSession() {
    if (sidRef.current) destroyMisSession(sidRef.current).catch(() => undefined)
    setSession('')
    /* 详情里的附件是权限相关的：换个账号后旧数据不该留着 */
    setDetails({})
    seenRef.current.clear()
    setShowLogin(false)
    setLoginError('')
  }

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      const ac = begin()
      try {
        const r = await listHomework(ac.signal)
        if (ac.signal.aborted) return
        setItems(r.items)
        setLastSyncedCount(r.lastSyncedCount)
      } catch (e) {
        /* 取消不是失败：用户翻页/切页导致的 abort 不该弹「加载失败」 */
        if (ac.signal.aborted || isAbortError(e)) return
        if (!silent) onToast(e instanceof Error ? e.message : '加载作业失败')
      } finally {
        if (!ac.signal.aborted && !silent) setLoading(false)
      }
    },
    [begin, onToast]
  )

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  /** 先应用筛选，再分组 —— 分组逻辑不需要知道筛选的存在 */
  const visible = useMemo(() => {
    /* 课程下拉的选项要来自**未筛选**的全集，否则选完一门课后
       其它课就从下拉里消失了，用户没法再切回去 */
    return items.filter((h) => {
      if (hideSubmitted && h.submitted) return false
      if (hideOverdue && h.deadlineState === 'overdue') return false
      if (courseFilter && h.courseName.trim() !== courseFilter) return false
      return true
    })
  }, [items, hideSubmitted, hideOverdue, courseFilter])

  /** 按课程分组（见文件头排序规则） */
  const groups = useMemo<CourseGroup[]>(() => {
    const map = new Map<string, Homework[]>()
    for (const h of visible) {
      const key = h.courseName.trim() || '未知课程'
      const list = map.get(key)
      if (list) list.push(h)
      else map.set(key, [h])
    }
    const out: CourseGroup[] = []
    for (const [course, list] of map) {
      const sorted = [...list].sort((a, b) => {
        if (a.submitted !== b.submitted) return a.submitted ? 1 : -1
        return (a.endTime || '9999-12-31').localeCompare(b.endTime || '9999-12-31')
      })
      out.push({ course, items: sorted, pending: list.filter((h) => !h.submitted).length })
    }
    out.sort((a, b) => {
      if ((a.pending > 0) !== (b.pending > 0)) return a.pending > 0 ? -1 : 1
      if (a.pending !== b.pending) return b.pending - a.pending
      return a.course.localeCompare(b.course, 'zh')
    })
    return out
  }, [visible])

  /** 未筛选的全集课程名（下拉选项来源） */
  const allCourses = useMemo(() => {
    const s = new Set<string>()
    for (const h of items) s.add(h.courseName.trim() || '未知课程')
    return [...s].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [items])

  const pendingTotal = useMemo(() => items.filter((h) => !h.submitted).length, [items])

  /**
   * 48 小时内截止且未提交的条数。
   *
   * 为什么是"48 小时"：这是上游（KMP 版）首页摘要卡的口径，也是学生
   * 能实际做出反应的窗口 —— 24 小时太紧，一周太松（等于没提醒）。
   * 用服务端给的 endTime 而不是 deadlineState：后者只分 overdue/dueSoon，
   * dueSoon 的阈值不一定是 48h，这里要精确口径。
   */
  const due48 = useMemo(() => {
    const now = Date.now()
    const limit = now + 48 * 3600 * 1000
    return items.filter((h) => {
      if (h.submitted || !h.endTime) return false
      /* "2026-10-25 23:00:00" 在部分浏览器（Safari）里 new Date 会 NaN，
         必须把空格换成 T。这是踩过的坑，别改回去。 */
      const t = new Date(h.endTime.replace(' ', 'T')).getTime()
      return Number.isFinite(t) && t >= now && t <= limit
    }).length
  }, [items])

  /** 把 Homework 转成 Markdown 构造器的入参（类型收窄集中在一处，避免每处重复） */
  const mdInput = (h: Homework) => ({
    courseName: h.courseName,
    title: h.title,
    homeworkType: h.homeworkType,
    endTime: h.endTime,
    score: h.score,
    submitted: h.submitted,
    subStatus: h.subStatus,
    content: h.content
  })

  const [busy, setBusy] = useState<string | null>(null)

  /** 导出范围的名字：筛了课程就用课程名，否则"本学期" */
  const exportScope = courseFilter || '本学期'

  const doCopyOne = async (h: Homework) => {
    const ok = await copyText(homeworkToMarkdown(mdInput(h)))
    onToast(ok ? '已复制为 Markdown' : '复制失败，请长按手动选中')
  }

  const doSaveOne = async (h: Homework) => {
    setBusy(`save-${h.id}`)
    try {
      const r = await saveText(homeworkFilename(h.courseName, h.title), homeworkToMarkdown(mdInput(h)))
      /* saveBlob 返回结构化结果：ok=false 时必须说失败，吞掉会让用户以为存下来了 */
      onToast(r.ok ? r.message : '保存失败')
    } catch (e) {
      onToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  const doCopyAll = async () => {
    const ok = await copyText(homeworkListToMarkdown(visible.map(mdInput), exportScope))
    onToast(ok ? `已复制 ${visible.length} 条作业为 Markdown` : '复制失败，请长按手动选中')
  }

  const doSaveAll = async () => {
    setBusy('save-all')
    try {
      const r = await saveText(`${exportScope}作业清单.md`, homeworkListToMarkdown(visible.map(mdInput), exportScope))
      onToast(r.ok ? r.message : '保存失败')
    } catch (e) {
      onToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  /** 点开/收起某条作业；点开且还没拉过详情、又有会话时自动拉一次 */
  function toggleOpen(h: Homework) {
    const next = openId === h.id ? null : h.id
    setOpenId(next)
    if (next !== null && sidRef.current && !seenRef.current.has(h.upId) && !details[h.upId]) {
      void loadDetail(h.upId)
    }
  }

  async function downloadAttachment(upId: number, attId: number, fileName: string) {
    const useSid = sidRef.current
    if (!useSid) {
      setShowLogin(true)
      return
    }
    setAttBusy(`${upId}-${attId}`)
    try {
      const blob = await downloadHomeworkAttachment(useSid, upId, attId)
      /* ⚠️ 走 saveBlob：Android WebView 里 <a download> 点了没反应 */
      const r = await saveBlob(blob, fileName)
      onToast(r.message)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '附件下载失败'
      onToast(msg)
      dropSessionIfExpired(msg)
    } finally {
      setAttBusy(null)
    }
  }

  const renderCard = (h: Homework) => {
    const meta = STATE_META[h.deadlineState]
    const open = openId === h.id
    const detail = details[h.upId]
    const err = detailError && detailError.upId === h.upId ? detailError.msg : ''
    const busyHere = detailBusy === h.upId
    return (
      <div key={h.id} className={`hw-card${open ? ' is-open' : ''}`}>
        <button type="button" className="hw-main" onClick={() => toggleOpen(h)}>
          <div className="hw-top">
            <span className="hw-type">{typeLabel(h.homeworkType)}</span>
            <span className={`hw-state ${meta.cls}`}>{meta.label}</span>
          </div>
          <div className="hw-title">{h.title}</div>
          <div className="hw-meta">
            {h.endTime && <span>截止 {fmtEnd(h.endTime)}</span>}
            {h.score && <span className="hw-score">{h.score} 分</span>}
            {h.submitted && h.subStatus && <span>{h.subStatus}</span>}
          </div>
        </button>
        {open && (
          <div className="hw-detail">
            {/* 详情正文优先用详情接口的（比列表更完整），没拉到就退回列表里的 */}
            {(detail?.content || h.content) ? (
              /* 作业说明是平台侧纯文本，用 pre-wrap 保留换行；不做 HTML 渲染（避免注入） */
              <div className="hw-content">{detail?.content || h.content}</div>
            ) : (
              <div className="hw-content hw-content-empty">平台未提供作业说明</div>
            )}

            {/* ---------------- 老师附件 ---------------- */}
            {!sid || showLogin ? (
              <div className="hw-att-login">
                <span>登录教务后可查看老师上传的附件</span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => (showLogin ? setShowLogin(true) : void loadDetail(h.upId))}
                  disabled={probing}
                >
                  登录查看附件
                </button>
              </div>
            ) : busyHere ? (
              <div className="hw-att-note">正在加载附件…</div>
            ) : err ? (
              <div className="hw-att-note is-error">
                {err}
                <button type="button" className="btn-ghost" onClick={() => void loadDetail(h.upId, true)}>
                  重试
                </button>
              </div>
            ) : detail && detail.attachments.length > 0 ? (
              <div className="hw-att">
                <div className="hw-att-head">
                  老师附件 {detail.attachments.length} 个
                </div>
                {detail.attachments.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="hw-att-row"
                    disabled={attBusy === `${h.upId}-${a.id}`}
                    onClick={() => void downloadAttachment(h.upId, a.id, a.fileName)}
                  >
                    <IconDownload size={15} />
                    <span className="hw-att-name">{a.fileName}</span>
                    {a.sizeBytes > 0 && <span className="hw-att-size">{fmtSize(a.sizeBytes)}</span>}
                    <span className="hw-att-act">
                      {attBusy === `${h.upId}-${a.id}` ? '下载中…' : ''}
                    </span>
                  </button>
                ))}
              </div>
            ) : detail ? (
              <div className="hw-att-note">老师未上传附件</div>
            ) : null}

            {/* ---------------- 提交作业 ---------------- */}
            {/* 只在有会话时给入口：没有会话连附件都看不到，更不该给提交按钮。
                提交面板自己处理确认与错误，这里只负责按需渲染。 */}
            {sid && !showLogin && (
              <HomeworkSubmitPanel
                key={`submit-${h.upId}`}
                sid={sid}
                homework={h}
                onToast={onToast}
                onSubmitted={() => void load()}
              />
            )}

            <div className="hw-detail-foot">
              <span className="hw-detail-note">
                {h.submitted ? '已在平台提交' : '尚未提交'}
              </span>
              {/* 复制/保存 Markdown：把作业要求贴进笔记或丢给 AI 问思路时用 */}
              <div className="hw-detail-acts">
                <button type="button" className="btn-ghost" onClick={() => void doCopyOne(h)}>
                  复制 Markdown
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy === `save-${h.id}`}
                  onClick={() => void doSaveOne(h)}
                >
                  {busy === `save-${h.id}` ? '保存中…' : '保存 .md'}
                </button>
              </div>
              <a className="btn-ghost hw-go" href={BKSY_HOME} target="_blank" rel="noopener noreferrer">
                去平台查看 <IconArrowRight size={14} />
              </a>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <AppShell
      title="课程平台作业"
      onBack={onBack}
      action={
        <div className="app-head-actions">
          <button type="button" className="icon-btn" onClick={() => void load()} aria-label="刷新">
            <IconRefresh size={19} />
          </button>
          {sid && (
            <button type="button" className="btn-ghost" onClick={exitSession}>
              退出登录
            </button>
          )}
        </div>
      }
      lead={
        <>
          作业数据在「设置 → 数据同步」或首页导入课表时一并拉取。
          {lastSyncedCount === null && ' 还没有同步过。'}
        </>
      }
    >
      {/* 登录表单：只有需要看附件时才出现（列表本身不需要会话） */}
      {showLogin && !sid && (
        <section className="hw-login">
          <div className="hw-login-title">登录教务后查看老师附件</div>
          <MisLoginForm
            busy={loginBusy}
            error={loginError}
            refreshToken={loginKey}
            submitLabel="登录教务"
            onLogin={handleLogin}
          />
          <button type="button" className="btn-ghost hw-login-cancel" onClick={() => setShowLogin(false)}>
            先不看附件
          </button>
        </section>
      )}
      {loading ? (
        <AppState kind="loading" title="正在加载作业…" />
      ) : items.length === 0 ? (
        <AppState
          kind="empty"
          title={lastSyncedCount === null ? '还没有同步过作业' : '本学期暂无作业'}
          hint={
            lastSyncedCount === null
              ? '到「应用 → 数据同步」用学号登录一次即可拉取本学期作业。'
              : '平台可能在教师布置后才有数据，可稍后下拉刷新。'
          }
        />
      ) : (
        <>
          <div className="hw-summary">
            共 {groups.length} 门课程 · {items.length} 条作业
            {pendingTotal > 0 ? ` · 待完成 ${pendingTotal} 条` : ' · 已全部提交'}
            {due48 > 0 && <span className="hw-due48"> · 48 小时内截止 {due48} 条</span>}
          </div>

          {/* 筛选行：课程 + 两个隐藏开关。放在汇总下面，因为汇总要反映"全量" */}
          <div className="hw-filters">
            <select
              className="hw-select"
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value)}
              aria-label="按课程筛选"
            >
              <option value="">全部课程</option>
              {allCourses.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="hw-check">
              <input
                type="checkbox"
                checked={hideSubmitted}
                onChange={(e) => setHideSubmitted(e.target.checked)}
              />
              隐藏已提交
            </label>
            <label className="hw-check">
              <input
                type="checkbox"
                checked={hideOverdue}
                onChange={(e) => setHideOverdue(e.target.checked)}
              />
              隐藏已逾期
            </label>
          </div>

          {/* 整份清单导出：一次把当前可见的作业按课程分节写成 Markdown */}
          <div className="hw-bulk">
            <button type="button" className="btn-ghost" onClick={() => void doCopyAll()}>
              复制为 Markdown
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy === 'save-all'}
              onClick={() => void doSaveAll()}
            >
              {busy === 'save-all' ? '保存中…' : '保存 .md'}
            </button>
          </div>

          {visible.length === 0 && (
            <AppState
              kind="empty"
              title="没有符合筛选条件的作业"
              hint="试试取消上面的勾选，或把课程切回「全部课程」。"
            />
          )}

          {groups.map((g) => (
            <section className="apps-group" key={g.course}>
              <div className="profile-section-title">
                {g.course}
                <span className="hw-count">
                  {g.pending > 0 ? `${g.pending} 待完成` : '已完成'}
                </span>
              </div>
              {g.items.map(renderCard)}
            </section>
          ))}
        </>
      )}
    </AppShell>
  )
}
