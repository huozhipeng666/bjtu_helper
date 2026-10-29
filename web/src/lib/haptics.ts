/**
 * 触觉反馈：完成任务等关键操作时短震动一下（Android 浏览器支持）。
 * iOS Safari / 桌面端不支持时静默跳过，无副作用。
 */
export function buzz(pattern: number | number[] = 10): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern)
    }
  } catch {
    /* 忽略：震动只是增强手感，失败不该影响主流程 */
  }
}
