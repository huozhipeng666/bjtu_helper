/**
 * 「需要登录」引导弹层。
 *
 * 未登录用户可以正常用课表 / DDL / 学期设置，只有两个动作（教务导入、拍照导入）需要登录。
 * 点那两个入口时不跳走、不切页，就地弹出这个弹层 —— 用户填完登录，**原来那个动作会自动继续**。
 *
 * 为什么用弹层而不是整页 AuthView：用户此刻的上下文是"我要导入课表"，
 * 把他扔到一个全屏登录页会丢失上下文（登回来还要自己再找一次入口）。
 */
import type { User } from '../types'
import Modal from './Modal'
import AuthForm from './AuthForm'

interface LoginSheetProps {
  /** 为什么需要登录，例如「登录后即可用学号一键导入本学期课表」 */
  reason: string
  onAuthed: (token: string, user: User) => void
  onClose: () => void
}

export default function LoginSheet({ reason, onAuthed, onClose }: LoginSheetProps) {
  return (
    <Modal open title="登录后即可使用" onClose={onClose}>
      <p className="auth-reason">{reason}</p>
      <AuthForm onAuthed={onAuthed} variant="sheet" />
    </Modal>
  )
}
