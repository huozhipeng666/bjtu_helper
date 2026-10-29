/**
 * 校园卡（「应用」→ 校园服务）。
 *
 * 页面**只展示二维码**（2026-10-14 按用户要求精简：去掉复制链接、保存按钮、
 * 跳转入口与说明段落等一切附带内容 —— 这个页面只需要"扫一扫"一个用途）。
 *
 * ⚠️ **绝不能做成「点击直接跳转 wxaurl.cn」** —— 这是本页最重要的设计约束：
 *   微信小程序链接（wxaurl.cn）从**微信外部**打开时，会把小程序绑定到
 *   「首个打开者」账号上。用户在浏览器里点一下就绑定错了。
 *   所以即使将来再加交互，这个约束也不能动。
 */
import QrCanvas from '../QrCanvas'
import AppShell from './AppShell'
import type { AppEntryHostProps } from './types'

/** 完美校园小程序链接（参考仓库同源） */
const CAMPUS_CARD_URL = 'https://wxaurl.cn/RLEw5IMZRKl'

export default function CampusCardApp({ onBack, onToast }: AppEntryHostProps) {
  return (
    <AppShell
      title="校园卡"
      onBack={onBack}
      lead="校园卡充值、余额与消费记录都在「完美校园」小程序里，用微信扫码打开。"
    >
      <div className="qr-center">
        <div className="qr-box">
          <QrCanvas value={CAMPUS_CARD_URL} size={220} onError={(m) => onToast(m)} />
        </div>
        <div className="qr-hint">用微信「扫一扫」识别二维码</div>
      </div>
    </AppShell>
  )
}
