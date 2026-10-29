/**
 * 课表一键导入 —— 登录学校 MIS 系统（CAS 统一认证），服务端代拉课表并解析，
 * 用户预览确认后整表覆盖导入。
 *
 * ## 两个来源，默认走智慧课程平台（BKSY）
 *
 * | 来源 | 接口 | 周次口径 |
 * | --- | --- | --- |
 * | 智慧课程平台（默认/推荐） | `POST /api/mis/timetable` | 平台给出**权威周次表**，周次与日期天然一致 |
 * | 本科教务 AA（备选） | `POST /api/mis/courses` | 只给「第 N 周」，靠开学日线性推算 |
 *
 * 2026-10-07 ~ 10-14 期间曾因学校侧「智慧课程平台」故障（校方问题，非本站）临时把默认
 * 来源改为「本科教务」；**2026-10-14 学校侧平台已恢复正常**，故恢复「智慧课程平台」为默认/推荐。
 *
 * 教务口径的代价：教务的「第 N 周」要换算成日期就得假设「每个自然周都是教学周」，
 * 而学校放假那一周不排课、也不算教学周 —— 于是放假之后所有周次整体错位一周。
 * 智慧课程平台的课表页直接给每周的起止日期，没有这个假设（平台可用时仍是更准的来源）。
 *
 * 导入智慧平台时会**顺带写入周次表**（`Settings.semester.weeks`），周/月视图据此
 * 把日期换算成教学周；落在周次表空档里的日期就是放假周，页面显示「放假无课程」。
 * 导入教务（AA）时相反：必须显式传 `weeks: null` 清掉上一次智慧平台留下的周次表。
 *
 * 流程：获取验证码 → 填学号/密码/算术验证码 → 登录 → 拉取课表 → 预览 → 覆盖导入。
 * 学号与密码只在本弹窗内存中存在，提交后服务端瞬时使用、不落库；
 * 验证码为 CAS 算术题图片（如 3+4=?），人工计算输入，无需额外服务。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  misCourses,
  misLogin,
  misTimetable,
  replaceCourses,
  startMisSession,
  updateSettings,
  type MisCourse,
  type MisSemesterInfo,
  type MisTimetableResult
} from '../api'
import Modal from './Modal'
import ConflictBanner from './ConflictBanner'
import { describePair, findConflicts } from '../lib/conflicts'
import { weekSummary } from '../lib/weeks'

interface CourseMisImportProps {
  onClose: () => void
  /** 导入成功后回调（刷新课表数据）。
      本组件导入后可能改写学期设置（官方学分/开学日/周次表），所以带 settings 标记，
      让 App 层按需重取 settings，而不是每次数据变更都打一跳（评审 C6）。 */
  onImported: (opts?: { settings?: boolean }) => void
}
type Phase = 'form' | 'loggingIn' | 'fetching' | 'preview' | 'importing' | 'done'
/** 课表来源：aa=本科教务 / bksy=智慧课程平台 */
type Source = 'bksy' | 'aa'

const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

/**
 * ★★★ 唯一开关：课表来源的展示顺序，**数组第一项即默认来源**（也是「推荐」角标的位置）。
 *
 * 2026-10-07 ~ 10-14 期间学校侧「智慧课程平台」故障，曾临时把默认来源改为 aa（本科教务）。
 * **2026-10-14 平台恢复可用，已改回 `['bksy', 'aa']`**。
 *
 * 若日后平台再次不可用，只需把 'aa' 挪到数组第一位（即 `['aa', 'bksy']`）即可，
 * 默认选中、「推荐」角标、`activeSource` 兜底全部跟随本数组，其余代码无需改动。
 */
const SOURCE_ORDER: Source[] = ['bksy', 'aa']
/** 默认来源 = 展示顺序的第一项，勿单独硬编码 */
const DEFAULT_SOURCE: Source = SOURCE_ORDER[0]

const SOURCE_META: Record<Source, { label: string; hint: string }> = {
  aa: {
    label: '本科教务',
    hint: '教务系统的「我的课表」（信息查询 → 我的课表）。登录后自动读取课名、时间、教室与学分。只给「第 N 周」，日期按开学日推算，放假周之后的周次可能整体偏一周。'
  },
  bksy: {
    label: '智慧课程平台',
    hint: '本科生院教学服务平台 → 智慧课程平台 → 课表。平台直接给出每周的起止日期，放假周会整周跳过，周次与日期不会错位。'
  }
}

const SOURCES: { key: Source; label: string; hint: string }[] = SOURCE_ORDER.map((key) => ({
  key,
  ...SOURCE_META[key]
}))

export default function CourseMisImport({ onClose, onImported }: CourseMisImportProps) {
  const [phase, setPhase] = useState<Phase>('form')
  const [source, setSource] = useState<Source>(DEFAULT_SOURCE)
  const [sid, setSid] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [profile, setProfile] = useState<{ name: string; identity: string; department: string } | null>(null)
  const [courses, setCourses] = useState<MisCourse[]>([])
  /** 教务官方总学分（仅 AA 来源能拿到） */
  const [totalCredits, setTotalCredits] = useState<number | null>(null)
  /** 教务页面识别到的开学日 / 总周数（仅 AA 来源） */
  const [semesterInfo, setSemesterInfo] = useState<MisSemesterInfo | null>(null)
  /** 智慧课程平台课表结果（含权威周次表） */
  const [timetable, setTimetable] = useState<MisTimetableResult | null>(null)
  /** 是否把学期信息（开学日/总周数/周次表）一并写入用户学期设置 */
  const [syncSemester, setSyncSemester] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  /** 会话凭证 ref（会话池共享：登录成功的会话留给全部教务应用复用，卸载不销毁） */
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

  // 打开弹窗即开一个 SSO 会话（新流程没有验证码）
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
      setProfile(p)
      setPhase('fetching')

      if (source === 'bksy') {
        const r = await misTimetable(sid)
        sidRef.current = '' // 会话保留在池中（其他教务应用可复用），这里无需再跟踪
        if (r.courses.length === 0) {
          setError(
            '登录成功，但智慧课程平台的课表为空（可能当前学期没有排课）。可切换到「本科教务」重试，' +
              '也可用拍照导入或手动添加课程'
          )
          setPhase('form')
          return
        }
        setCourses(r.courses)
        setTimetable(r)
        setTotalCredits(null)
        setSemesterInfo(null)
        setSyncSemester(true)
        setPhase('preview')
        return
      }

      const r = await misCourses(sid)
      sidRef.current = '' // 会话保留在池中（其他教务应用可复用），这里无需再跟踪
      if (r.courses.length === 0) {
        setError('登录成功，但教务系统课表为空（可能当前学期没有排课），请尝试拍照导入或手动添加课程')
        setPhase('form')
        return
      }
      setCourses(r.courses)
      setTotalCredits(r.totalCredits ?? null)
      setTimetable(null)
      const sem = r.semester ?? null
      setSemesterInfo(sem)
      // 只在真的识别到值时默认勾选，避免给一个空勾选框让用户困惑
      setSyncSemester(!!(sem && (sem.startDate || sem.totalWeeks)))
      setPhase('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      // 登录失败后服务端已销毁该 SSO 会话，重新开一个
      await refreshSession()
    }
  }

  async function handleImport() {
    setPhase('importing')
    setError('')
    try {
      /* AA 来源能拿到「官方总学分」；智慧平台来源没有这个汇总，传 null = 不动该字段
         （学分已按课程号逐门从教务课程列表对齐，见 misFetchBksyTimetable） */
      const r = await replaceCourses(courses, source === 'aa' ? totalCredits : null)
      const creditNote =
        source === 'bksy'
          ? timetable && timetable.creditHits > 0
            ? ` · 已按课程号从教务对齐 ${timetable.creditHits} 门课的学分`
            : ' · 未从教务匹配到学分（可在课程里逐门补填）'
          : totalCredits != null
            ? ` · 官方总学分 ${totalCredits}`
            : courses.some((c) => c.credits != null)
              ? ' · 教务课表页无总学分汇总，已按课程列表逐门填入学分'
              : ' · 未从教务抓到学分（可在课程里逐门补填）'

      // 课表写成功后，再同步学期设置（失败不影响课表，只提示手动改）
      let semesterNote = ''
      if (syncSemester) {
        try {
          if (source === 'bksy' && timetable) {
            await updateSettings({
              semester: {
                startDate: timetable.startDate,
                totalWeeks: timetable.totalWeeks,
                /* 关键：把权威周次表一起写进去，周/月视图才不会再线性推算 */
                weeks: timetable.weeks
              }
            })
            const holidays = timetable.weekOptions.filter((o) => o.week === null).length
            semesterNote =
              ` · 学期已同步为 开学日 ${timetable.startDate} · 共 ${timetable.totalWeeks} 个教学周` +
              (holidays > 0 ? `（含 ${holidays} 个放假周，不排课）` : '')
          } else if (semesterInfo && (semesterInfo.startDate || semesterInfo.totalWeeks)) {
            const patch: { startDate?: string; totalWeeks?: number; weeks: null } = { weeks: null }
            if (semesterInfo.startDate) patch.startDate = semesterInfo.startDate
            if (semesterInfo.totalWeeks) patch.totalWeeks = semesterInfo.totalWeeks
            await updateSettings({ semester: patch })
            semesterNote = ` · 学期设置已同步为${patch.startDate ? ` 开学日 ${patch.startDate}` : ''}${
              patch.totalWeeks ? ` 共 ${patch.totalWeeks} 周` : ''
            }`
          }
        } catch {
          semesterNote = ' · 学期设置同步失败，可在「设置 → 学期设置」手动调整'
        }
      }
      setResult(`导入完成：清除原课表 ${r.deleted} 条，写入 ${r.imported} 条${creditNote}${semesterNote}`)
      setPhase('done')
      /* 本组件可能写入了学期设置（syncSemester 时），让 App 顺手重取 settings（评审 C6） */
      onImported({ settings: syncSemester })
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败，请重试')
      setPhase('preview')
    }
  }

  const busy = phase === 'loggingIn' || phase === 'fetching' || phase === 'importing'
  const activeSource = SOURCES.find((s) => s.key === source) ?? SOURCES[0]
  /** 校历里被整周跳过的放假周（智慧平台来源才有） */
  const holidayWeeks = useMemo(
    () => (timetable ? timetable.weekOptions.filter((o) => o.week === null) : []),
    [timetable]
  )

  /**
   * 待导入课表自身的时间冲突自查：覆盖导入会先清空原课表，
   * 所以这里只需在「即将写入的这份数据」内部两两比对。
   * 教务偶尔会在同一时段排出两门课（或页面上一格重复渲染成两行），导入前提示比导入后发现好。
   */
  const importConflicts = useMemo(
    () =>
      findConflicts(courses).sort(
        (x, y) => x.a.dayOfWeek - y.a.dayOfWeek || x.a.startPeriod - y.a.startPeriod
      ),
    [courses]
  )

  return (
    <Modal
      open
      title="课表导入"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy && phase !== 'importing'}>
          {phase === 'done' ? '关闭' : '取消'}
        </button>
      }
    >
      {error && (
        <div className="form-error" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {(phase === 'form' || phase === 'loggingIn') && (
        <div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.7 }}>
            使用学校 MIS 统一认证登录（与交大钥匙相同的学号密码），自动拉取本学期课表。
            密码仅用于本次登录，不会被保存。
          </p>

          {/* 来源切换：顺序与默认值都取自 SOURCE_ORDER —— 改回智慧平台只需动那个数组 */}
          <div className="filter-tabs" style={{ marginBottom: 8 }}>
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`filter-tab${source === s.key ? ' active' : ''}`}
                onClick={() => setSource(s.key)}
                disabled={busy}
              >
                {s.label}
                {s.key === DEFAULT_SOURCE && <span className="rec-badge">推荐</span>}
              </button>
            ))}
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 12, margin: '0 0 12px', lineHeight: 1.6 }}>
            {activeSource.hint}
          </p>

          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              学号
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="学号"
                autoComplete="off"
                disabled={busy}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="统一身份认证密码"
                autoComplete="new-password"
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) handleLogin()
                }}
              />
            </label>
            <button type="button" className="btn btn-primary" onClick={handleLogin} disabled={busy}>
              {phase === 'loggingIn' ? '正在登录…' : '登录并获取课表'}
            </button>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-3)' }}>
              学校已改用统一身份认证（sso.bjtu.edu.cn），登录不再需要验证码。
              若确认密码无误仍提示错误，可能是账号<strong>还没有激活</strong>，请先到{' '}
              <a href="https://sso.bjtu.edu.cn" target="_blank" rel="noreferrer">
                sso.bjtu.edu.cn
              </a>{' '}
              完成激活后再试。
            </div>
          </div>
          <ul style={{ color: 'var(--text-2)', fontSize: 12, margin: '14px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
            <li>导入会覆盖当前学期课表（原有课程将被清除），导入前可先在下方预览核对</li>
            <li>研究生请使用拍照导入或手动添加课程，本功能解析的是本科课表</li>
            <li>每分钟最多发起 15 次 MIS 登录</li>
          </ul>
        </div>
      )}

      {phase === 'fetching' && (
        <div style={{ textAlign: 'center', padding: '18px 0 10px' }}>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            登录成功（{profile?.name}），正在从{activeSource.label}拉取课表…
          </p>
          {source === 'bksy' && (
            <p style={{ color: 'var(--text-3)', fontSize: 12, margin: '6px 0 0' }}>
              需要逐周读取整学期课表，约需数秒
            </p>
          )}
        </div>
      )}

      {(phase === 'preview' || phase === 'importing' || phase === 'done') && courses.length > 0 && (
        <div>
          {profile && (
            <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 10px' }}>
              {profile.name} · {profile.identity} · {profile.department} · 来源{activeSource.label} · 共识别{' '}
              {courses.length} 门课
              {totalCredits != null && (
                <span style={{ color: 'var(--accent-2)', fontWeight: 600 }}> · 教务官方总学分 {totalCredits}</span>
              )}
            </p>
          )}

          {/* 智慧课程平台：展示权威周次表（含放假周） */}
          {source === 'bksy' && timetable && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 10,
                fontSize: 13,
                lineHeight: 1.7
              }}
            >
              <div>
                <span style={{ fontWeight: 600 }}>学期周次：</span>
                开学日 {timetable.startDate} · 共 {timetable.totalWeeks} 个教学周
              </div>
              {holidayWeeks.length > 0 && (
                <div style={{ color: 'var(--warn)', marginTop: 2 }}>
                  校历有 {holidayWeeks.length} 个放假周（学校不排课，教学周次会跳过）：
                  {holidayWeeks.map((o) => ` ${o.beginDate} ~ ${o.endDate}`).join('；')}
                </div>
              )}
              {timetable.failedWeeks.length > 0 && (
                <div style={{ color: 'var(--danger)', marginTop: 2 }}>
                  第 {timetable.failedWeeks.join('、')} 周读取失败，这些周的课可能缺失，建议稍后重试
                </div>
              )}
              {timetable.aaError && (
                <div style={{ color: 'var(--text-3)', marginTop: 2 }}>学分未取到（{timetable.aaError}），可导入后补填</div>
              )}
              {phase === 'preview' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={syncSemester}
                    onChange={(e) => setSyncSemester(e.target.checked)}
                  />
                  导入时把开学日 / 总周数 / 周次表同步到我的学期设置（推荐，否则放假周仍会错位）
                </label>
              )}
            </div>
          )}

          {/* 本科教务：展示识别到的开学日 / 总周数 */}
          {source === 'aa' && semesterInfo && (semesterInfo.startDate || semesterInfo.totalWeeks) && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 10,
                fontSize: 13,
                lineHeight: 1.7
              }}
            >
              <div>
                <span style={{ fontWeight: 600 }}>教务学期：</span>
                {semesterInfo.startDate ? `开学日 ${semesterInfo.startDate}` : '开学日未在教务页面识别到'}
                {semesterInfo.totalWeeks ? ` · 共 ${semesterInfo.totalWeeks} 周` : ' · 周数未识别'}
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 2 }}>
                教务只给「第 N 周」，日期靠开学日推算：若本学期有放假周，放假之后的周次可能整体偏一周，
                可在「设置 → 学期设置」核对开学日
              </div>
              {phase === 'preview' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={syncSemester}
                    onChange={(e) => setSyncSemester(e.target.checked)}
                  />
                  导入时把这些值同步到我的学期设置（覆盖当前开学日/周数）
                </label>
              )}
              {semesterInfo.source && (
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 2 }}>{semesterInfo.source}</div>
              )}
            </div>
          )}

          <ConflictBanner
            conflicts={importConflicts}
            title={`这份课表里有 ${importConflicts.length} 处时间冲突`}
            format={describePair}
            note="冲突不影响导入（会照原样写入），但建议先核对教务页面是否真有重叠排课。"
          />
          {result && (
            <div style={{ color: 'var(--ok)', fontSize: 13, marginBottom: 8 }}>{result}</div>
          )}
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table className="period-table">
              <thead>
                <tr>
                  <th>课程名称</th>
                  <th>时间</th>
                  <th>周次</th>
                  <th>学分</th>
                  <th>教师</th>
                  <th>地点</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((c, i) => (
                  <tr key={i}>
                    <td>{c.name}</td>
                    <td>
                      {DAY_NAMES[c.dayOfWeek]} 第{c.startPeriod}大节
                    </td>
                    <td>{weekSummary(c)}</td>
                    <td>{c.credits != null ? c.credits : '—'}</td>
                    <td>{c.teacher}</td>
                    <td>{c.location}</td>
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
              {phase === 'importing' ? '导入中…' : phase === 'done' ? '已完成' : `确认整表覆盖导入 ${courses.length} 门课程`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
