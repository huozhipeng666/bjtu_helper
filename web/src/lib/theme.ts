/**
 * 主题：浅色 / 深色 / 跟随系统
 *
 * 两套机制配合：
 *  1. localStorage —— 首屏即可生效（index.html 内联脚本会先读它），不依赖网络；
 *  2. 服务端 users.theme —— 换设备/清缓存后仍保留偏好，登录后由 App 拉取并回写本地。
 *
 * 「跟随系统」不是静态值：系统会随时切换，所以要监听 prefers-color-scheme 变化并重新落地。
 */
import type { ResolvedTheme, ThemeMode } from '../types'

export const THEME_KEY = 'bjtu-theme'

const THEME_META: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#0e1013'
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

export function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isThemeMode(v) ? v : 'dark'
  } catch {
    return 'dark'
  }
}

export function storeTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return mode === 'light' ? 'light' : 'dark'
}

/** 把模式落到 <html data-theme>，并同步地址栏颜色 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_META[resolved])
  return resolved
}

/** 监听系统深浅色变化；mode 为 system 时才会真正回调 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const handler = () => onChange()
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }
  // Safari 14 以下只有已废弃的 addListener
  mq.addListener(handler)
  return () => mq.removeListener(handler)
}

/* ---------------- 自选主题色（强调色色相，深浅主题通用） ---------------- */

export const ACCENT_KEY = 'bjtu-accent'

/** 可选主题色预设（色相 0-359）；默认青绿 166 与原配色完全一致 */
export const ACCENT_PRESETS: { h: number; label: string }[] = [
  { h: 166, label: '青绿' },
  { h: 205, label: '海蓝' },
  { h: 262, label: '紫罗兰' },
  { h: 328, label: '玫红' },
  { h: 24, label: '橙柚' },
  { h: 88, label: '青柠' }
]

export const DEFAULT_ACCENT = '166'

export function isAccentHue(v: unknown): v is string {
  return typeof v === 'string' && /^(?:[0-9]|[1-9][0-9]|[12]\d{2}|3[0-5]\d)$/.test(v) && Number(v) <= 359
}

export function readStoredAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY)
    return isAccentHue(v) ? v : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

export function storeAccent(h: string): void {
  try {
    localStorage.setItem(ACCENT_KEY, h)
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

/** 把色相落到 <html> 的 --accent-h，全部强调色由 CSS 从它派生（深浅主题各自调明度） */
export function applyAccent(h: string): void {
  if (!isAccentHue(h)) return
  document.documentElement.style.setProperty('--accent-h', h)
}
