/**
 * 横向手势的三个纯函数：方向锁 / 位移夹紧 / 松手吸附。
 *
 * 为什么把它们从组件里抽出来（2026-10-27）：
 *   SwipeRow 此前在 `touchmove` 里直接 `setOffset(next)` —— 手指每移动一帧就
 *   触发一次 React 重渲染（父级的课程卡整棵子树跟着 reconciliation）。真机上
 *   这就是「滑得动但跟手发涩」的来源：JS 帧与渲染帧互相等待。
 *   改造后的手势期只写 ref + 直接改 `style.transform`（不经过 React），
 *   但这些判定仍然必须**与改造前逐字一致**，否则手感会悄悄变味。
 *   把判定做成纯函数是唯一能在零依赖单测里锁住它们的方式。
 *
 * 三条既有语义（别"顺手改对"）：
 *  1. 方向锁一旦判定，本次手势内不再改变 —— 否则滑动途中会被判成滚动。
 *  2. 位移只允许指向 -actionWidth..0，向右不越 0（不露出左侧空白）。
 *  3. 「滑过一半即展开」用的是 `<=`，恰好一半也算展开。
 */

/** 方向锁判定阈值（px）：小于它既不算滑动也不算滚动 */
export const SWIPE_LOCK_THRESHOLD = 8

export type SwipeAxis = 'x' | 'y' | null

/**
 * 方向锁：首次超过阈值时用位移绝对值较大的轴定方向，未超过返回 null（继续观察）。
 * 绝对值相同（正好 45°）时判为横向 —— 与旧实现的 `Math.abs(dx) > Math.abs(dy)` 一致。
 */
export function swipeAxis(dx: number, dy: number, threshold: number = SWIPE_LOCK_THRESHOLD): SwipeAxis {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
}

/**
 * 位移夹紧：在「手势开始时的基准位移 base」上叠加本次 dx，结果夹在 [-actionWidth, 0]。
 * base 是手势开始时卡片已展开的位移（展开态为 -actionWidth，否则 0）。
 */
export function clampSwipeOffset(base: number, dx: number, actionWidth: number): number {
  return Math.max(-actionWidth, Math.min(0, base + dx))
}

/**
 * 松手吸附：滑过一半展开到满宽，否则回弹归零。
 * actionWidth 为 0 时永不展开（没有按钮可露出来）。
 */
export function settleSwipe(offset: number, actionWidth: number): { open: boolean; offset: number } {
  if (actionWidth > 0 && offset <= -actionWidth / 2) return { open: true, offset: -actionWidth }
  return { open: false, offset: 0 }
}
