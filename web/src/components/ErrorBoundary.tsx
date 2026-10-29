import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportClientError } from '../api'

interface Props {
  children: ReactNode
  /**
   * 出错时展示的标题。整页边界用默认值；按 tab 的边界传"这一页出了点问题"，
   * 让用户知道**只有这一块**坏了、底栏还能用。
   */
  title?: string
}

interface State {
  error: Error | null
}

/**
 * 渲染错误的兜底层。
 *
 * 为什么必须有：React 18 里任何未捕获的渲染异常都会**卸载整棵树**，
 * 用户看到的是一块纯色背景（深色主题下就是黑屏），刷新也不一定恢复（若是脏数据导致，会稳定复现）。
 * 这类故障此前完全不可恢复 —— 用户既不知道发生了什么，也没有任何自救手段。
 *
 * 兜住之后至少有四件事：① 其它区域还能用（按 tab 包一层时）；
 * ② 把 message 显示出来，用户能截图反馈；③ 自动上报到 /api/client-errors；
 * ④ 给一个"清缓存重载"按钮 —— Service Worker 缓存了旧 chunk 时，普通刷新是没用的。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 这里也是全站唯一能拿到 componentStack 的地方，一并上报
    reportClientError(error.message, `${error.stack ?? ''}\n--- componentStack ---\n${info.componentStack ?? ''}`)
    // 保留 console 输出：本地开发时直接能看到完整堆栈
    console.error('[ui] 渲染崩溃', error, info.componentStack)
  }

  /** 只重试渲染（不清缓存）：适合"某次数据异常"这类偶发问题 */
  private retry = (): void => {
    this.setState({ error: null })
  }

  /** 连 Service Worker 缓存一起清掉再重载：适合"发版后加载到旧 chunk"这类问题 */
  private hardReload = (): void => {
    void (async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(keys.map((k) => caches.delete(k)))
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations()
          await Promise.all(regs.map((r) => r.unregister()))
        }
      } catch {
        /* 清缓存失败也照样重载 */
      }
      location.reload()
    })()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash-page" role="alert">
        <h2>{this.props.title ?? '页面出了点问题'}</h2>
        <p>已经记录下来了。你可以先重试；如果反复出现，请把下面的信息反馈给我们。</p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button type="button" className="btn btn-primary" onClick={this.retry}>
            重试
          </button>
          <button type="button" className="btn" onClick={this.hardReload}>
            清缓存并重新加载
          </button>
        </div>
      </div>
    )
  }
}
