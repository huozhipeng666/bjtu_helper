import { useEffect, useId, useState, type FormEvent } from 'react'
import type { Period, Settings, Term } from '../types'
import { createTerm, getSettings, listTerms, setCurrentTerm, updateSettings, updateTerm } from '../api'
import { IconChevronLeft } from '../icons'

interface SettingsViewProps {
  settings: Settings | null
  onBack: () => void
  onSaved: (s: Settings) => void
  /** 学期发生增改/切换后通知上层：需要刷新课表、本周等所有页面数据 */
  onTermChanged: () => void
  onLogout: () => void
}

export default function SettingsView({
  settings, onBack, onSaved, onTermChanged
}: SettingsViewProps) {
  /**
   * label 与输入框的关联 id 前缀。
   * 本页同时存在两份结构相同的表单（上方「学期设置」与下方「学期管理」的新建/编辑表单），
   * 两者可能同时可见，固定 id 会重复 → useId 生成实例内唯一前缀，再各自加后缀区分。
   */
  const uid = useId()
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [totalWeeks, setTotalWeeks] = useState(16)
  const [periods, setPeriods] = useState<Period[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  /* ---------------- 学期管理（多学期） ---------------- */
  const [terms, setTerms] = useState<Term[]>([])
  const [currentTermId, setCurrentTermId] = useState('')
  const [termsLoading, setTermsLoading] = useState(true)
  const [termBusy, setTermBusy] = useState(false)
  const [termMsg, setTermMsg] = useState('')
  const [termError, setTermError] = useState('')
  /** null = 表单收起；'' = 新建；其它 = 正在编辑的学期 id */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tName, setTName] = useState('')
  const [tStart, setTStart] = useState('')
  const [tWeeks, setTWeeks] = useState(16)

  useEffect(() => {
    let cancelled = false
    setTermsLoading(true)
    listTerms()
      .then((r) => {
        if (cancelled) return
        setTerms(r.terms)
        setCurrentTermId(r.currentTermId)
      })
      .catch((e) => {
        if (!cancelled) setTermError(e instanceof Error ? e.message : '学期列表加载失败')
      })
      .finally(() => {
        if (!cancelled) setTermsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function openCreateForm() {
    const d = new Date()
    /* 默认给一个「下一年 2 月最后一周的周一」之类很难猜，直接给今天所在周的周一，用户自己改 */
    const monday = new Date(d)
    const day = (monday.getDay() + 6) % 7
    monday.setDate(monday.getDate() - day)
    const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
    setEditingId('')
    setTName('')
    setTStart(iso)
    setTWeeks(16)
    setTermError('')
    setTermMsg('')
  }

  function openEditForm(t: Term) {
    setEditingId(t.id)
    setTName(t.name)
    setTStart(t.startDate)
    setTWeeks(t.totalWeeks)
    setTermError('')
    setTermMsg('')
  }

  /**
   * 学期表单提交。
   * 注意：本组件最外层已经是 <form>（保存节次设置），HTML 不允许 form 嵌套，
   * 所以学期的「表单」只能写成 div + 按钮 onClick，否则内层 submit 会被浏览器丢弃、
   * 点「保存」反而触发了外层保存。这里入参做成可选，就是为了同时兼容 onsubmit/onclick。
   */
  async function handleTermSubmit(ev?: { preventDefault: () => void }) {
    ev?.preventDefault()
    setTermError('')
    setTermMsg('')
    if (!tName.trim()) return setTermError('学期名称不能为空')
    if (!tStart) return setTermError('请选择开学日期')
    if (!Number.isInteger(tWeeks) || tWeeks < 1 || tWeeks > 60) return setTermError('总周数需为 1-60 的整数')
    setTermBusy(true)
    try {
      const body = { name: tName.trim(), startDate: tStart, totalWeeks: tWeeks }
      if (editingId) {
        const r = await updateTerm(editingId, body)
        setTerms(r.terms)
        setCurrentTermId(r.currentTermId)
        setTermMsg('学期已更新 ✓')
        /* 编辑学期不改变「当前是哪个学期」，只是数据变了 → 走 onSaved（轻量刷新） */
        onSaved(await getSettings())
      } else {
        const r = await createTerm(body)
        setTerms(r.terms)
        setCurrentTermId(r.currentTermId)
        setTermMsg(`已新建并切换到「${body.name}」，接下来导入的课表会归到该学期 ✓`)
        /* 新建学期会一并切换当前学期 → 等同于「切换」，必须让所有页面按新学期重新取数 */
        onTermChanged()
      }
      setEditingId(null)
    } catch (err) {
      setTermError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setTermBusy(false)
    }
  }

  async function handleSwitch(id: string) {
    setTermError('')
    setTermMsg('')
    setTermBusy(true)
    try {
      const r = await setCurrentTerm(id)
      setTerms(r.terms)
      setCurrentTermId(r.currentTermId)
      const t = r.terms.find((x) => x.id === id)
      setTermMsg(`已切换到「${t?.name ?? id}」✓`)
      /* 学期变了，课表/本周/月视图都要重新取数 */
      onTermChanged()
    } catch (err) {
      setTermError(err instanceof Error ? err.message : '切换失败')
    } finally {
      setTermBusy(false)
    }
  }

  useEffect(() => {
    if (settings) {
      setName(settings.semester.name)
      setStartDate(settings.semester.startDate)
      setTotalWeeks(settings.semester.totalWeeks)
      setPeriods(settings.periods)
    }
  }, [settings])

  function updatePeriod(index: number, field: 'start' | 'end', value: string) {
    setPeriods((prev) => prev.map((p) => (p.index === index ? { ...p, [field]: value } : p)))
  }

  function addPeriod() {
    const next = periods.length ? Math.max(...periods.map((p) => p.index)) + 1 : 1
    setPeriods((prev) => [...prev, { index: next, start: '08:00', end: '08:45' }])
  }

  function removePeriod(index: number) {
    if (periods.length <= 1) return
    setPeriods((prev) => prev.filter((p) => p.index !== index))
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMsg('')
    if (!startDate) {
      setError('请选择开学日期')
      return
    }
    if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 60) {
      setError('总周数需为 1-60 的整数')
      return
    }
    if (periods.length === 0) {
      setError('至少保留一个节次')
      return
    }
    setSaving(true)
    try {
      const updated = await updateSettings({
        semester: { name, startDate, totalWeeks },
        periods
      })
      onSaved(updated)
      setMsg('已保存 ✓')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /**
   * 清除校历周次表，改回「开学日 + 7 天」的线性推算。
   *
   * 为什么需要这个出口：周次表一旦写入就以它为准，手动改开学日不会再改变周次映射
   * （这正是我们要的 —— 表是权威的）。但如果用户填错了学期、或想手工排一套周次，
   * 没有出口就会卡死。清除是显式动作，且必须二次确认。
   */
  async function clearWeeks() {
    if (!window.confirm('清除后将改回「按开学日线性推算」周次。若本学期有放假周，日期与周数会重新错位。确定清除吗？')) {
      return
    }
    setError('')
    setMsg('')
    setSaving(true)
    try {
      const updated = await updateSettings({ semester: { weeks: null } })
      onSaved(updated)
      setMsg('已清除校历周次表，改回按开学日推算 ✓')
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <div className="empty-hint">加载设置中…</div>

  return (
    <form onSubmit={handleSave}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 2px 16px' }}>
        <button className="topbar-btn" onClick={onBack} aria-label="返回">
          <IconChevronLeft size={22} />
        </button>
        <div className="page-title" style={{ margin: 0 }}>学期设置</div>
      </div>
      <div className="card">
        <h2>学期设置</h2>
        <p className="page-hint">
          这里改的是<strong>当前学期</strong>的开学日与周数，与下方「学期管理」里选中的那一项是同一份数据
          （改完会同步过去）。要新增或切换到别的学期，用下方的「学期管理」。
        </p>
        <div className="form-row">
          <div className="field">
            <label htmlFor={`${uid}-semester-name`}>学期名称</label>
            <input id={`${uid}-semester-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-semester-start`}>开学日期（第一周的周一）</label>
            <input id={`${uid}-semester-start`} className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor={`${uid}-semester-weeks`}>学期总周数</label>
          <input id={`${uid}-semester-weeks`} className="input" type="number" min={1} max={60} value={totalWeeks} onChange={(e) => setTotalWeeks(Number(e.target.value))} />
        </div>
        {/* 校历周次表：导入智慧课程平台课表时写入。它一旦存在就**以它为准**，
            所以这里必须告诉用户「改开学日不会改变周次映射」，并给一个显式清除的出口。 */}
        {settings.semester.weeks && settings.semester.weeks.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              <span style={{ fontWeight: 600 }}>已导入校历周次表</span>
              <span style={{ color: 'var(--text-2)' }}>
                （
                {
                  settings.semester.weeks.filter(
                    (w) => w.week >= 1 && w.week <= totalWeeks && w.hasClass
                  ).length
                }{' '}
                个教学周）—— 周次与日期的对应以它为准，学校放假的周会整周跳过。因此上面的开学日只作展示，
                改它不会改变周次映射。
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
              onClick={clearWeeks}
              disabled={saving}
            >
              清除校历周次表（改回按开学日推算）
            </button>
          </div>
        )}
      </div>

      {termsLoading && <div className="page-hint">学期列表加载中…</div>}
      {!termsLoading && (
        <div className="card">
          <h2>学期管理</h2>
          <p className="page-hint">
            课程归属于具体学期。切换学期只改变「当前在看哪个学期」，<strong>不会重新解释其它学期的课表</strong>
            ——所以下学期开始前先「新建学期」再导入新学期的课表，历史课表会原样保留。
          </p>
          <ul className="term-list">
            {terms.map((t) => (
              <li key={t.id} className={t.id === currentTermId ? 'term-item is-current' : 'term-item'}>
                <div className="term-main">
                  <div className="term-name">
                    {t.name}
                    {t.id === currentTermId && <span className="term-badge">当前</span>}
                  </div>
                  <div className="term-sub">
                    开学日 {t.startDate} · 共 {t.totalWeeks} 周 · {t.courseCount ?? 0} 门课
                  </div>
                </div>
                <div className="term-actions">
                  {t.id !== currentTermId && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={termBusy} onClick={() => handleSwitch(t.id)}>
                      切换
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={termBusy} onClick={() => openEditForm(t)}>
                    编辑
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {editingId === null ? (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={openCreateForm}>
                ＋ 新建学期
              </button>
            </div>
          ) : (
            /* 外层整页已经是 <form>，HTML 不允许 form 嵌套 —— 这里只能是 div。
               代价是输入框里按 Enter 会提交**外层**表单（保存节次设置），
               所以显式把 Enter 接管成「保存这个学期表单」，符合用户预期。 */
            <div
              style={{ marginTop: 12 }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const t = e.target as HTMLElement
                if (t.tagName !== 'INPUT') return
                e.preventDefault()
                handleTermSubmit()
              }}
            >
              <div className="term-form-title">{editingId ? '编辑学期' : '新建学期（保存后自动切换过去）'}</div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor={`${uid}-term-name`}>学期名称</label>
                  <input id={`${uid}-term-name`} className="input" value={tName} onChange={(e) => setTName(e.target.value)} placeholder="如 2026-2027 学年 春季学期" />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-term-start`}>开学日期（第一周的周一）</label>
                  <input id={`${uid}-term-start`} className="input" type="date" value={tStart} onChange={(e) => setTStart(e.target.value)} />
                </div>
              </div>
              <div className="field" style={{ maxWidth: 200 }}>
                <label htmlFor={`${uid}-term-weeks`}>学期总周数</label>
                <input id={`${uid}-term-weeks`} className="input" type="number" min={1} max={60} value={tWeeks} onChange={(e) => setTWeeks(Number(e.target.value))} />
              </div>
              <div className="term-form-actions">
                <button type="button" className="btn btn-sm" disabled={termBusy} onClick={handleTermSubmit}>
                  {termBusy ? '保存中…' : '保存'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={termBusy} onClick={() => setEditingId(null)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {termError && <div className="form-error" style={{ marginTop: 10 }} role="alert">{termError}</div>}
          {termMsg && <div className="term-msg">{termMsg}</div>}
        </div>
      )}

      <div className="card">
        <h2>节次时间表</h2>
        <p style={{ color: 'var(--text-2)', fontSize: 12, margin: '0 0 12px' }}>
          修改节次时间会影响课程块在周视图中的显示时间。
        </p>
        <table className="period-table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>节次</th>
              <th>开始时间</th>
              <th>结束时间</th>
              <th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {[...periods]
              .sort((a, b) => a.index - b.index)
              .map((p) => (
                <tr key={p.index}>
                  <td>第 {p.index} 节</td>
                  <td>
                    <input className="input" type="time" value={p.start} onChange={(e) => updatePeriod(p.index, 'start', e.target.value)} />
                  </td>
                  <td>
                    <input className="input" type="time" value={p.end} onChange={(e) => updatePeriod(p.index, 'end', e.target.value)} />
                  </td>
                  <td>
                    <button type="button" className="icon-btn danger" onClick={() => removePeriod(p.index)} title="删除该节次">
                      🗑️
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={addPeriod}>
            ＋ 添加一节
          </button>
        </div>
      </div>

      {error && <div className="form-error" style={{ marginTop: 10 }} role="alert">{error}</div>}
      {msg && <div style={{ color: 'var(--ok)', fontSize: 13, marginTop: 10 }}>{msg}</div>}

      <div style={{ marginTop: 16 }}>
        <button type="submit" className="btn btn-primary btn-save-lg" disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </form>
  )
}
