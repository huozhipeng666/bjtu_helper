/**
 * 登录 / 注册**整页**壳。
 *
 * 它不再是"进入应用的唯一入口"（未登录也能以游客身份使用），而是两个场景的兜底：
 *  1. 游客账号签发失败（断网 / 被限流 / 隐私模式禁用 localStorage）时，整页只渲染它；
 *  2. 用户主动想登录自己的老账号时（游客态顶栏也有入口，这里是最"正式"的那一个）。
 *
 * 表单本体在 components/AuthForm.tsx，与弹层壳 LoginSheet 共用同一份校验与交互。
 */
import type { User } from '../types'
import AuthForm from '../components/AuthForm'

interface AuthViewProps {
  onAuthed: (token: string, user: User) => void
}

export default function AuthView({ onAuthed }: AuthViewProps) {
  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="logo">交</span>
        <div>
          <h1>交大小助手</h1>
          <p>课表、作业、考试，截止时间都在这</p>
        </div>
      </div>
      <AuthForm onAuthed={onAuthed} variant="page" />
    </div>
  )
}
