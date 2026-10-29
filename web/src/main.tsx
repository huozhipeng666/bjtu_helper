import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { registerServiceWorker } from './lib/pwa'
import ErrorBoundary from './components/ErrorBoundary'
import AppUpdateGate from './components/AppUpdateGate'
import { reportClientError } from './api'

/* 启动耗时打点（Performance Timeline）。
 *
 * 为什么需要：用户说"打开要 1 秒"，但"打开"具体指哪一刻并没有共识 ——
 * 是 HTML 到了、首帧画出来了、还是数据填满了？这三个时间点在优化中会指向
 * 完全不同的方向（前者看网络与体积，后者看接口与渲染）。没有打点就只能靠猜，
 * 改完也无法证明有效。
 * 打点本身近乎零成本（performance.mark 只在内存时间线里写一条），线上同样可用：
 *   performance.getEntriesByType('mark').map(m => [m.name, Math.round(m.startTime)])
 * scripts/measure-boot.mjs 读的就是这些标记。 */
function mark(name: string) {
  try {
    performance.mark(name)
  } catch {
    /* 老浏览器没有 User Timing API：忽略，不影响任何功能 */
  }
}
mark('js-eval')

registerServiceWorker()

/* 全局兜底：ErrorBoundary 只能接住**渲染期**的异常，接不住事件回调、定时器、
   未 await 的 Promise 里的错误。这些错误以前只出现在用户自己的控制台里，
   我们这边完全看不到（"用户说白屏/点不动，但复现不出来"这类工单的根源）。
   这里只上报、不改变原有行为：浏览器默认仍会把错误打到控制台。 */
window.addEventListener('error', (e) => {
  /* 资源加载失败（img/script）也会触发 error 事件，但 e.error 为空 —— 不上报，
     否则一个 404 的图片就能刷满错误表。 */
  if (e.error) reportClientError(e.error.message, e.error.stack)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  const message = r instanceof Error ? r.message : String(r)
  reportClientError(message, r instanceof Error ? r.stack : '')
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 整页兜底：任何逃出来的渲染异常都不会再变成"黑屏且无法自救" */}
    <ErrorBoundary>
      <App />
      {/* 老版本 App 的更新通道（只在壳里生效，浏览器里直接渲染 null）。
          挂在 App 之外：用户可能停在登录页，提示不能依赖登录后的页面。 */}
      <AppUpdateGate />
    </ErrorBoundary>
  </React.StrictMode>
)

/* React 18 的 createRoot().render() 是异步的（走调度器，不保证同步提交），
   所以不能在这一行之后直接打点。用 requestAnimationFrame 等一帧：
   下一帧之前 React 已完成首次提交与样式计算，这一帧开始时用户才真正"看到东西"。 */
requestAnimationFrame(() => mark('first-paint'))
