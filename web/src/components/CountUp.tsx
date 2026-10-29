import { useCountUp } from '../lib/useCountUp'

/**
 * 数字滚动显示（把 useCountUp 收进一个叶子组件）。
 *
 * 为什么必须单独抽成组件，而不是在页面顶层直接调 useCountUp：
 * useCountUp 内部靠 rAF 每帧 setState 来推进数字，550ms 大约 33 次。
 * 如果这个 hook 写在 HomeView 顶层，这 33 次 setState 会把**整个首页**重渲染 33 次
 * （问候语、统计卡、进度条、DDL 横幅、今日课程、下一节课、本周时间线全部重算）。
 * 而数字变化的时机恰好是「完成一条任务 / 新建任务」之后 —— 此时列表的划掉与收起
 * 动画正在播，主线程再叠 33 次整页重渲染，低端机上就会掉帧。
 *
 * 收进叶子组件后，每帧只重渲染这一个文本节点，页面其余部分完全不动。
 * 对外表现（数字同样的时长、同样的缓动）与改动前完全一致。
 */
export default function CountUp({ value }: { value: number }) {
  const display = useCountUp(value)
  return <>{display}</>
}
