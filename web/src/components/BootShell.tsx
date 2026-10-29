/**
 * 启动外壳（Boot Shell）：JS 还没跑完、数据还没回来时，屏幕上的"应用的样子"。
 *
 * 为什么需要它：改造前 `!booted` 分支渲染的是一行「加载中…」—— 用户看到的是
 * 一个纯色页面加四个字，体感就是"卡住了"。而实测冷启动在 4G + 4x CPU 下，
 * FCP 要 750ms 左右，这段空窗里如果只有文字，那 750ms 就是纯粹的等待。
 * 换上与真实界面同构的骨架壳之后，同样的 750ms 变成"界面正在长出来"。
 *
 * ⚠️ 这个组件必须与 web/index.html 里 `#root` 内的静态外壳**逐字同构**：
 * 静态那份是 HTML 自带的，在本文件对应的 JS 下载并求值之前就已经画在屏幕上了。
 * 两边结构一旦不一致，会出现"骨架闪一下再变成另一套骨架"的跳动。
 * 改这里就要同步改 index.html（反之亦然），两处都有这条注释互相指路。
 *
 * 样式全部走 `boot-` 前缀，定义在 index.html 的内联 <style> 里 —— 刻意不依赖
 * styles.css：那份 CSS 是 render-blocking 的，等它到达等于白等。外壳自带样式
 * 才能做到"HTML 一到就有画面"。真正的应用界面一渲染，这层壳就被 React 整体替换。
 */
export default function BootShell() {
  return (
    <div className="boot-app" aria-busy="true" aria-label="正在加载">
      <div className="boot-top">
        <span className="boot-avatar" />
        <span className="boot-text">
          <span className="boot-line" style={{ width: 76, height: 13 }} />
          <span className="boot-line" style={{ width: 52, height: 10 }} />
        </span>
      </div>
      <div className="boot-content">
        <span className="boot-line" style={{ width: 96, height: 15, margin: '14px 2px 12px' }} />
        <span className="boot-line" style={{ width: '68%', height: 32, margin: '0 2px 12px' }} />
        <span className="boot-line" style={{ width: 210, height: 13, margin: '0 2px 20px' }} />
        <div className="boot-stats">
          <span className="boot-stat" />
          <span className="boot-stat" />
          <span className="boot-stat" />
        </div>
        <div className="boot-card">
          <span className="boot-line" style={{ width: '40%', height: 12, marginBottom: 12 }} />
          <span className="boot-line" style={{ width: '55%', height: 19, marginBottom: 14 }} />
          <span className="boot-line" style={{ width: '82%', height: 13, marginBottom: 9 }} />
          <span className="boot-line" style={{ width: '62%', height: 13 }} />
        </div>
      </div>
      <div className="boot-nav">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}
