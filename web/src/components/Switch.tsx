/**
 * iOS 风格开关（设计稿图2 / 图3 的右侧开关）。
 *
 * 为什么不用原生 `<input type="checkbox">`：原生控件的尺寸与配色在各浏览器差异很大，
 * 而且这个开关要跟主题色联动（开启态用 --accent）。用一个 button + CSS 画出来，
 * 只有一份实现、两套主题下表现完全一致，也天然满足键盘可聚焦（button 语义）。
 *
 * role="switch" + aria-checked 是必须的：读屏用户看不到"滑到了哪边"，
 * 只有把这个状态暴露给无障碍树，开关才是可用的。
 */
interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** 无障碍名称。开关自身没有文字，缺了它读屏只会念"开关" */
  label: string
  disabled?: boolean
}

export default function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`sw${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="sw-knob" />
    </button>
  )
}
