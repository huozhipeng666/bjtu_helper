/**
 * 校园网（「应用」→ 校园服务）。
 *
 * 页面**只展示缴费二维码**（2026-10-14 按用户要求精简：去掉复制链接、
 * 保存按钮、自助服务入口与常见问题等一切附带内容）。
 *
 * 说明：浏览器无法管理 Wi-Fi 连接（没有那个 API），所以这个页面唯一的
 * 用途就是扫码缴费 —— 其它内容（报修、FAQ）不在本页承载。
 */
import QrCanvas from '../QrCanvas'
import AppShell from './AppShell'
import type { AppEntryHostProps } from './types'

/** 校园网缴费同走完美校园小程序 */
const PAY_URL = 'https://wxaurl.cn/RLEw5IMZRKl'

export default function CampusNetApp({ onBack, onToast }: AppEntryHostProps) {
  return (
    <AppShell title="校园网" onBack={onBack} lead="网费缴纳请用微信扫码进入「完美校园」小程序。">
      <div className="qr-center">
        <div className="qr-box">
          <QrCanvas value={PAY_URL} size={220} onError={(m) => onToast(m)} />
        </div>
        <div className="qr-hint">用微信「扫一扫」进入缴费页面</div>
      </div>
    </AppShell>
  )
}
