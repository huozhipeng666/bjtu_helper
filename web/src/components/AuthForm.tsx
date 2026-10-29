/**
 * 登录 / 注册表单（**纯表单**，不含页面壳）。
 *
 * 为什么要从 AuthView 里抽出来：登录不再只是"进入应用的门"（未登录也能以游客身份用），
 * 它变成了两个高成本动作（教务导入、拍照导入）的解锁入口，需要在**弹层**里也能出现。
 * 页面壳（AuthView，整页）与弹层壳（LoginSheet）共用这一份表单，
 * 校验规则、交互、错误文案才不会两边漂移。
 *
 * ## 2026-10 学校换登录入口后的主次调整
 *
 * 学校把 MIS 的登录从 `cas.bjtu.edu.cn`（学号 + 密码 + 图形算术验证码）
 * 换成了 `sso.bjtu.edu.cn` 的统一身份认证：**没有验证码了**，但**未激活的账号会被拒绝**。
 *
 * 于是本站的默认入口也跟着反过来：
 *   - **主路径 = 学号 + 统一身份认证密码**（本校学生，占绝大多数用户）；
 *   - 非本校用户 / 用邮箱注册过的账号，再走下面的"邮箱账号登录 / 注册"。
 * 以前默认是"邮箱 + 站点密码"、把学号登录塞成一个小按钮 —— 那会让绝大多数新生
 * 卡在"我没有站点密码"上，而现在他们连验证码都不用填，一步就能进来。
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import type { User } from '../types'
import { anonMisLogin, getCaptcha, login, register, startAnonMisSession } from '../api'
import { NICKNAME_MAX, PASSWORD_MIN } from '../lib/authConstraints'

interface AuthFormProps {
  onAuthed: (token: string, user: User) => void
  /**
   * 外观变体：
   *  - `page`  整页（自带 .card 卡片样式与阴影）
   *  - `sheet` 弹层内（弹层已经提供了卡片表面，这里只输出表单本体）
   */
  variant?: 'page' | 'sheet'
}

interface CaptchaState {
  id: string
  svg: string
}

/**
 * 三种视图：
 *  - `mis`      **学号 + 统一身份认证密码**（本校学生，默认视图）
 *  - `login`    邮箱/学号 + 本站密码（用邮箱注册过的账号走这条）
 *  - `register` 注册新账号（非本校用户）
 */
type Mode = 'login' | 'register' | 'mis'

export default function AuthForm({ onAuthed, variant = 'page' }: AuthFormProps) {
  /**
   * label 与输入框的关联 id 前缀。
   * 本组件同时被整页壳（AuthView）和弹层壳（LoginSheet）复用，极端情况下可能两份同时挂载，
   * 固定 id 会撞车 → 用 useId 生成实例内唯一的前缀（React 18）。
   */
  const uid = useId()
  const [mode, setMode] = useState<Mode>('mis')
  const [nickname, setNickname] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')
  const [captcha, setCaptcha] = useState<CaptchaState | null>(null)
  const [captchaErr, setCaptchaErr] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /* 学号登录（MIS 匿名通道）的独立状态 */
  const [misSid, setMisSid] = useState('')
  const [misStuNo, setMisStuNo] = useState('')
  const [misPassword, setMisPassword] = useState('')
  const [misLoading, setMisLoading] = useState(false)

  /** 拉一张新的验证码；注册模式下才需要 */
  const reloadCaptcha = useCallback(async () => {
    setCaptchaErr('')
    try {
      const c = await getCaptcha()
      setCaptcha({ id: c.id, svg: c.svg })
    } catch (e) {
      setCaptcha(null)
      setCaptchaErr(e instanceof Error ? e.message : '验证码加载失败')
    }
  }, [])

  useEffect(() => {
    if (mode === 'register') void reloadCaptcha()
  }, [mode, reloadCaptcha])

  /**
   * 开一个 SSO 会话（学号登录用）。
   *
   * 新流程没有验证码，所以这里"拿"的不是图而是一个 sid —— 它绑定了服务端
   * 从 sso.bjtu.edu.cn 抓到的那张登录页（流水号 + SM2 公钥）。
   * 失败一次（密码错）这个 sid 就作废了，必须重开，故登录失败后要再调一次。
   */
  const loadMisSession = useCallback(async (opts?: { keepError?: boolean }) => {
    try {
      const r = await startAnonMisSession()
      setMisSid(r.sid)
      /* ⚠️ 这里的 setError('') 只适用于「用户主动进入登录页」的常规路径。
         登录失败后的重开必须带 keepError：否则时序是
         setError('学号或密码不正确…') → 会话重开成功 → setError('')
         —— 失败原因只闪几百毫秒就没了，用户看到的正是「密码被清空、什么都没提示」。
         这个坑在 2026-10-22 线上表现为「账号突然登不进去且无任何报错」，查了很久。 */
      if (!opts?.keepError) setError('')
    } catch (e) {
      setMisSid('')
      setError(e instanceof Error ? e.message : '登录会话建立失败，请稍后重试')
    }
  }, [])

  /* 进入学号登录视图时自动开一个会话 */
  useEffect(() => {
    if (mode === 'mis' && !misSid) void loadMisSession()
  }, [mode, misSid, loadMisSession])

  /** 三种视图之间切换时清掉上一屏的错误 */
  function go(next: Mode) {
    setMode(next)
    setError('')
    setCaptchaCode('')
  }

  /** 学号 + 统一身份认证密码登录：SSO 通过即证明是本人，服务端直接取回账号并签发会话 */
  async function handleMisLogin(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!misStuNo.trim()) return setError('请填写学号')
    if (!misPassword) return setError('请填写统一身份认证密码')
    if (!misSid) return setError('登录会话已失效，正在重新建立，请稍候再试')

    setMisLoading(true)
    try {
      const r = await anonMisLogin({
        sid: misSid,
        username: misStuNo.trim(),
        password: misPassword
      })
      /* 登录成功：交给上层走统一的「登录 + 游客数据迁移」流程 */
      onAuthed(r.token, r.user)
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : '登录失败，请重试'
      setError(msg)
      /* 服务端失败时会销毁会话（SSO 的流水号也是一次性的），必须重开一个。
         keepError 不能省：重开成功会清空错误态，见 loadMisSession 的注释。 */
      setMisPassword('')
      void loadMisSession({ keepError: true })
    } finally {
      setMisLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (mode === 'register') {
      const nick = nickname.trim()
      if (!nick) return setError('请填写昵称')
      if (nick.length > NICKNAME_MAX) return setError(`昵称最多 ${NICKNAME_MAX} 个字符`)
      if (username.trim().length < 3) return setError('账号至少 3 个字符（邮箱或学号）')
      if (password.length < PASSWORD_MIN) return setError(`密码至少 ${PASSWORD_MIN} 位`)
      if (confirmPassword !== password) return setError('两次输入的密码不一致')
      if (!captcha) return setError('验证码未加载，请点击验证码图片刷新')
      if (captchaCode.trim().length === 0) return setError('请填写验证码')
    } else {
      if (!username.trim()) return setError('请输入邮箱或学号')
      if (!password) return setError('请输入密码')
    }

    setLoading(true)
    try {
      if (mode === 'login') {
        const res = await login(username.trim(), password)
        onAuthed(res.token, res.user)
        return
      }
      const res = await register({
        nickname: nickname.trim(),
        username: username.trim(),
        password,
        confirmPassword,
        captchaId: captcha!.id,
        captchaCode: captchaCode.trim()
      })
      onAuthed(res.token, res.user)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '操作失败'
      setError(msg)
      // 验证码是一次性的：只要服务端说验证码有问题，就立刻换一张，避免用户卡住
      if (mode === 'register' && msg.includes('验证码')) {
        setCaptchaCode('')
        void reloadCaptcha()
      }
    } finally {
      setLoading(false)
    }
  }

  /* ---------------- 学号登录视图（本校学生的主路径，也是默认视图） ---------------- */
  if (mode === 'mis') {
    return (
      <form className={variant === 'page' ? 'card auth-card' : 'auth-form-inline'} onSubmit={handleMisLogin}>
        {variant === 'page' && <h2>本校学生登录</h2>}
        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="forgot-intro">
          <p>
            用<b>学号 + 学校统一身份认证密码</b>登录（就是登录 <b>sso.bjtu.edu.cn</b> 的那个密码）。
          </p>
          <p>
            学校 2026 年换了统一身份认证，<b>登录时不再需要验证码</b>。
            第一次登录会自动为你建好账号，<b>课表、DDL、考试都会跟着这个账号走</b>。
          </p>
          <p className="forgot-tip">密码只用于向学校验证身份，不会保存在本站。</p>
        </div>

        <div className="field">
          <label htmlFor={`${uid}-mis-stu-no`}>
            学号<span className="required">*</span>
          </label>
          <input
            id={`${uid}-mis-stu-no`}
            className="input"
            value={misStuNo}
            onChange={(e) => setMisStuNo(e.target.value)}
            placeholder="输入你的学号"
            autoComplete="username"
            inputMode="numeric"
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor={`${uid}-mis-password`}>
            统一身份认证密码<span className="required">*</span>
          </label>
          <input
            id={`${uid}-mis-password`}
            className="input"
            type="password"
            value={misPassword}
            onChange={(e) => setMisPassword(e.target.value)}
            placeholder="与登录 sso.bjtu.edu.cn 相同"
            autoComplete="current-password"
          />
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={misLoading}>
          {misLoading ? '正在验证…' : '登录'}
        </button>

        {/* 未激活是这次换系统最常见的失败原因，且学校返回的报错和"密码错误"长得一样，
            所以必须常驻提示，不能让用户反复试密码把自己试到锁定 */}
        <div className="auth-note">
          提示：确认密码无误仍提示错误，通常是因为你的统一身份认证<b>还没有激活</b>。
          请先打开{' '}
          <a href="https://sso.bjtu.edu.cn" target="_blank" rel="noreferrer">
            sso.bjtu.edu.cn
          </a>{' '}
          完成激活（首次激活需要填报手机号/邮箱并设置密码），再回来登录。
        </div>

        <p className="auth-switch">
          不是本校学生？
          <button type="button" onClick={() => go('register')}>
            用邮箱注册
          </button>
        </p>
        <p className="auth-switch auth-switch-tight">
          已经用邮箱注册过？
          <button type="button" onClick={() => go('login')}>
            邮箱账号登录
          </button>
        </p>
      </form>
    )
  }

  return (
    <form className={variant === 'page' ? 'card auth-card' : 'auth-form-inline'} onSubmit={handleSubmit}>
      {/* 弹层里标题由 Modal 提供（"登录后即可使用"），表单内不再重复一遍 */}
      {variant === 'page' && (
        <h2>{mode === 'login' ? '邮箱账号登录' : '注册新账号'}</h2>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}

      {mode === 'register' && (
        <div className="field">
          <label htmlFor={`${uid}-nickname`}>
            昵称<span className="required">*</span>
          </label>
          <input
            id={`${uid}-nickname`}
            className="input"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="同学之间怎么称呼你"
            maxLength={NICKNAME_MAX}
            autoFocus
          />
        </div>
      )}

      <div className="field">
        <label htmlFor={`${uid}-username`}>
          邮箱 / 学号{mode === 'register' && <span className="required">*</span>}
        </label>
        <input
          id={`${uid}-username`}
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="输入邮箱或学号"
          autoComplete="username"
          autoFocus={mode === 'login'}
        />
      </div>

      <div className={mode === 'register' ? 'form-row' : 'field'}>
        <div className="field">
          <label htmlFor={`${uid}-password`}>密码</label>
          <input
            id={`${uid}-password`}
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? `至少 ${PASSWORD_MIN} 位` : '输入密码'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </div>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor={`${uid}-confirm-password`}>确认密码</label>
            <input
              id={`${uid}-confirm-password`}
              className="input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </div>
        )}
      </div>

      {mode === 'register' && (
        <div className="field">
          <label htmlFor={`${uid}-captcha`}>
            验证码<span className="required">*</span>
          </label>
          <div className="captcha-row">
            <input
              id={`${uid}-captcha`}
              className="input"
              value={captchaCode}
              onChange={(e) => setCaptchaCode(e.target.value)}
              placeholder="请输入右侧字符"
              maxLength={6}
              autoComplete="off"
            />
            <button
              type="button"
              className="captcha-box"
              onClick={() => void reloadCaptcha()}
              title="点击换一张"
              aria-label="点击刷新验证码"
            >
              {captcha ? (
                <span
                  className="captcha-svg"
                  // SVG 由服务端生成，字符集固定，不存在注入风险
                  dangerouslySetInnerHTML={{ __html: captcha.svg }}
                />
              ) : (
                <span className="captcha-placeholder">{captchaErr ? '加载失败' : '加载中…'}</span>
              )}
            </button>
          </div>
          <div className="captcha-hint">
            看不清？点图片换一张（不区分大小写）
            {captchaErr && <span className="captcha-err" role="alert"> · {captchaErr}</span>}
          </div>
        </div>
      )}

      <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
        {loading ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
      </button>

      {/* 本校学生随时能切回主路径：走错入口的人不该只能靠"返回"按钮找路 */}
      <button type="button" className="btn btn-soft btn-block auth-mis-btn" onClick={() => go('mis')}>
        本校学生 · 用学号 + 统一身份认证密码登录
      </button>

      <p className="auth-switch">
        {mode === 'login' ? '还没有账号？' : '已有账号？'}
        <button type="button" onClick={() => go(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '去注册' : '去登录'}
        </button>
      </p>
    </form>
  )
}
