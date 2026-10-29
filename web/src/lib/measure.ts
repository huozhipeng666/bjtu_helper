/**
 * 布局测量结果的比较工具。
 *
 * 为什么需要它（2026-10-27）：
 *   NavBar 用 ResizeObserver 盯住底栏与每个 tab，回调里调 measure() 把
 *   `getBoundingClientRect()` 的中心点写进 state。`getBoundingClientRect()`
 *   返回的是**亚像素浮点**，而移动端地址栏收缩、字体回流、滚动条显隐都会让它
 *   抖动零点几个像素 —— 于是每次抖动都 setState、都重渲染整条底栏（4 个 tab
 *   ＋ 涟漪层 ＋ 液态水珠的 className 回写）。
 *   这层抖动对人眼完全不可见，却让底栏在「手指拖拽 + 页面滚动」同时发生时
 *   抢走渲染帧。用半像素容差把这些无效更新挡掉。
 *
 * 为什么是 0.5px：图标的磁吸位移由 centers 换算，0.5px 的中心点误差换到
 * `--push` 上不足 0.01px，肉眼不可能分辨；而真正需要重排的场景（旋转屏、
 * 字体缩放、栏宽变化）位移都远大于半像素，不会被误判成"没变"。
 */
export const CENTERS_EPSILON = 0.5

/**
 * 两组中心点是否在容差内等价。
 * 长度不同一律视为不等（tab 数量变了必须重算）。
 */
export function centersEqual(a: readonly number[], b: readonly number[], epsilon: number = CENTERS_EPSILON): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > epsilon) return false
  }
  return true
}
