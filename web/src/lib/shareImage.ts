/**
 * 分享课表图片（设计稿图3）—— 零依赖 Canvas 绘制。
 *
 * 为什么手写 Canvas 而不引库（html2canvas 等）：
 *   ① 本项目的 CSP 是 `script-src 'self'`，不能引 CDN；把 html2canvas 打进 bundle
 *      又是 40KB+ 的体积，只为一个低频功能，不划算。
 *   ② html2canvas 是"把 DOM 截图"，结果会带上当前主题、当前滚动位置、当前字号 ——
 *      用户想分享的是**一张干净的课表**，不是自己屏幕的翻拍。
 *   ③ 手写之后，图的配色/边距/换行完全可控，深浅主题下分享出去的都是同一张白底图。
 *
 * ⚠️ 为什么分享图**固定用浅色底**（不跟随深色主题）：
 *   这张图会被贴进微信/QQ 聊天里，深色底在浅色聊天界面上像一块补丁，
 *   而且同一份课表在两种主题下分享出去长得不一样，会让接收方以为是两张不同的表。
 *   分享图是"对外产物"，不是"我的界面"，因此固定配色是刻意的。
 */
import type { Period, WeekCourse, WeekData } from '../types'
import { hexToRgba } from '../constants'
import { weekdayCN } from './date'
import { saveBlob } from './saveFile'

export interface ShareImageOptions {
  /** 显示上课地点（关闭后隐藏教室信息） */
  showLocation: boolean
  /** 显示任课教师（关闭后隐藏教师信息） */
  showTeacher: boolean
  /** 显示非本周课程（开启后以灰色显示本周不上课的课程） */
  showInactive: boolean
  /** 显示开始结束周（显示课程起止周次，保留单双周与离散周说明） */
  showWeeks: boolean
}

const W = 1080
const PAD = 40
const AXIS_W = 96
const ROW_H = 124
const HEAD_H = 92
const TITLE_H = 132
const FOOT_H = 64
const MIN_ROWS = 7

const INK = '#17202b'
const INK_2 = '#5c6875'
const INK_3 = '#8b96a5'
const LINE = '#e6eaf1'
const HEAD_BG = '#f4f6f9'
const PAGE_BG = '#ffffff'
const MUTED_BG = '#f1f3f7'
const MUTED_INK = '#8b96a5'

const FONT = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif'

/** 圆角矩形（roundRect 在旧 WebView 上不一定有，自己画一份保证兼容） */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/** 按宽度折行，超出 maxLines 时最后一行加省略号 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const chars = [...text]
  const lines: string[] = []
  let cur = ''
  for (const ch of chars) {
    const next = cur + ch
    if (ctx.measureText(next).width > maxWidth && cur !== '') {
      lines.push(cur)
      cur = ch
      if (lines.length === maxLines) break
    } else {
      cur = next
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines) {
    // 还有没放下的内容：把最后一行压成省略号
    const consumed = lines.join('').length
    if (consumed < chars.length) {
      let last = lines[maxLines - 1]
      while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
      lines[maxLines - 1] = last + '…'
    }
  }
  return lines
}

/** 把课程的周次说清（含单双周/离散周说明）——「显示开始结束周」用 */
function weeksLabel(c: WeekCourse, totalWeeks: number): string {
  const weeks = c.weeks && c.weeks.length > 0 ? c.weeks : null
  if (!weeks) {
    const base = `${c.weekStart}-${c.weekEnd}周`
    if (c.weekType === 'odd') return `${base} 单周`
    if (c.weekType === 'even') return `${base} 双周`
    return base
  }
  if (weeks.length >= totalWeeks) return `1-${totalWeeks}周`
  const isOdd = weeks.every((w) => w % 2 === 1)
  const isEven = weeks.every((w) => w % 2 === 0)
  if (isOdd && weeks.length === Math.ceil(totalWeeks / 2)) return `1-${totalWeeks}周 单周`
  if (isEven && weeks.length === Math.floor(totalWeeks / 2)) return `1-${totalWeeks}周 双周`
  if (weeks.length === 1) return `第 ${weeks[0]} 周`
  const contiguous = weeks.every((w, i) => i === 0 || w === weeks[i - 1] + 1)
  if (contiguous) return `${weeks[0]}-${weeks[weeks.length - 1]}周`
  // 离散周：给前几个 + 省略号，够用户判断即可
  const head = weeks.slice(0, 6).join('/')
  return `${head}${weeks.length > 6 ? '/…' : ''} 周`
}

function weekTitle(week: WeekData): { title: string; sub: string } {
  const md = (iso: string) => `${Number(iso.slice(5, 7))}.${Number(iso.slice(8, 10))}`
  const range = `${md(week.weekStart)} — ${md(week.weekEnd)}`
  if (week.weekState === 'holiday') return { title: '放假周', sub: `${week.semester.name} · ${range} · 无课程` }
  if (week.weekState === 'before') return { title: '开学前预览', sub: `${week.semester.name} · 第 1 周 · ${range}` }
  if (week.weekState === 'after') return { title: '本学期已结课', sub: `${week.semester.name} · ${range}` }
  return { title: `第 ${week.weekNumber} 周`, sub: `${week.semester.name} · ${range}` }
}

/**
 * 画一张周课表分享图。
 * @param accentHue 用户主题色色相（0-359），只用于标题下的装饰条
 */
export function drawScheduleImage(
  week: WeekData,
  periods: Period[],
  opts: ShareImageOptions,
  accentHue = 166
): HTMLCanvasElement {
  let maxEnd = 0
  for (const d of week.days) {
    for (const c of d.courses) if (c.endPeriod > maxEnd) maxEnd = c.endPeriod
    for (const c of d.inactiveCourses ?? []) if (c.endPeriod > maxEnd) maxEnd = c.endPeriod
  }
  const rows = Math.max(MIN_ROWS, periods.length, maxEnd, 1)
  const gridH = rows * ROW_H
  const H = TITLE_H + HEAD_H + gridH + FOOT_H
  const colW = (W - PAD * 2 - AXIS_W) / 7

  const canvas = document.createElement('canvas')
  const scale = 2
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.scale(scale, scale)

  // 背景
  ctx.fillStyle = PAGE_BG
  ctx.fillRect(0, 0, W, H)

  const { title, sub } = weekTitle(week)
  ctx.textBaseline = 'alphabetic'

  // 标题
  ctx.fillStyle = INK
  ctx.font = `700 46px ${FONT}`
  ctx.fillText(title, PAD, 62)
  ctx.fillStyle = INK_2
  ctx.font = `400 24px ${FONT}`
  ctx.fillText(sub, PAD, 100)

  // 主题色装饰条（标题右侧）
  const barW = 56
  ctx.fillStyle = `hsl(${accentHue} 55% 45%)`
  roundRect(ctx, W - PAD - barW, 40, barW, 8, 4)
  ctx.fill()

  // 表头
  const headY = TITLE_H
  ctx.fillStyle = HEAD_BG
  roundRect(ctx, PAD, headY, W - PAD * 2, HEAD_H, 16)
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.fillStyle = INK_3
  ctx.font = `500 22px ${FONT}`
  ctx.fillText('时段', PAD + AXIS_W / 2, headY + 56)

  week.days.forEach((d, i) => {
    const cx = PAD + AXIS_W + colW * i + colW / 2
    ctx.fillStyle = d.isToday ? `hsl(${accentHue} 55% 40%)` : INK
    ctx.font = `600 24px ${FONT}`
    ctx.fillText(weekdayCN(d.weekday), cx, headY + 40)
    ctx.fillStyle = d.isToday ? `hsl(${accentHue} 55% 40%)` : INK_3
    ctx.font = `400 20px ${FONT}`
    ctx.fillText(String(Number(d.date.slice(8, 10))), cx, headY + 70)
  })
  ctx.textAlign = 'left'

  const gridY = headY + HEAD_H

  // 网格线 + 时段轴
  for (let r = 0; r < rows; r++) {
    const y = gridY + r * ROW_H
    ctx.fillStyle = r % 2 === 1 ? 'rgba(0,0,0,0.012)' : 'transparent'
    if (r % 2 === 1) ctx.fillRect(PAD, y, W - PAD * 2, ROW_H)
    ctx.strokeStyle = LINE
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD, y)
    ctx.lineTo(W - PAD, y)
    ctx.stroke()

    const p = periods.find((x) => x.index === r + 1)
    ctx.fillStyle = INK
    ctx.font = `600 24px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText(String(r + 1), PAD + AXIS_W / 2, y + 40)
    if (p) {
      ctx.fillStyle = INK_3
      ctx.font = `400 17px ${FONT}`
      ctx.fillText(p.start, PAD + AXIS_W / 2, y + 64)
    }
    ctx.textAlign = 'left'
  }
  // 纵向列分隔线
  for (let i = 0; i <= 7; i++) {
    const x = PAD + AXIS_W + colW * i
    ctx.strokeStyle = LINE
    ctx.beginPath()
    ctx.moveTo(x, gridY)
    ctx.lineTo(x, gridY + gridH)
    ctx.stroke()
  }
  ctx.strokeStyle = LINE
  ctx.beginPath()
  ctx.moveTo(PAD, gridY + gridH)
  ctx.lineTo(W - PAD, gridY + gridH)
  ctx.stroke()

  // 课程块
  week.days.forEach((d, i) => {
    const x0 = PAD + AXIS_W + colW * i

    const drawBlock = (c: WeekCourse, muted: boolean) => {
      const top = gridY + (c.startPeriod - 1) * ROW_H + 4
      const h = (c.endPeriod - c.startPeriod + 1) * ROW_H - 10
      const x = x0 + 4
      const w = colW - 8

      ctx.fillStyle = muted ? MUTED_BG : hexToRgba(c.color, 0.16)
      roundRect(ctx, x, top, w, h, 12)
      ctx.fill()

      // 左侧色条
      ctx.fillStyle = muted ? '#c3cad4' : c.color
      roundRect(ctx, x, top, 7, h, 3.5)
      ctx.fill()

      const textX = x + 14
      const textW = w - 24
      let ty = top + 30

      /* 字号按块高自适应：矮块（单节）用 20px 保证一行塞得下更多字，
         高块（跨多节）用 22px 让课名更醒目。7 列网格里每列只有约 130px 宽，
         字号再大就会把"大数据技术原理"折成三行，反而不好读。 */
      ctx.fillStyle = muted ? MUTED_INK : INK
      ctx.font = `600 ${h > 110 ? 22 : 20}px ${FONT}`
      const nameLines = wrapText(ctx, c.name, textW, h > 150 ? 3 : 2)
      for (const line of nameLines) {
        ctx.fillText(line, textX, ty)
        ty += 26
      }

      ctx.font = `400 19px ${FONT}`
      if (opts.showWeeks && ty < top + h - 8) {
        ctx.fillStyle = muted ? MUTED_INK : INK_2
        ctx.fillText(weeksLabel(c, week.semester.totalWeeks), textX, ty)
        ty += 24
      }
      if (opts.showLocation && c.location && ty < top + h - 6) {
        ctx.fillStyle = muted ? MUTED_INK : INK_2
        ctx.fillText(c.location, textX, ty)
        ty += 24
      }
      if (opts.showTeacher && c.teacher && ty < top + h - 6) {
        ctx.fillStyle = muted ? MUTED_INK : INK_3
        ctx.fillText(c.teacher, textX, ty)
      }
    }

    // 先画灰色（非本周），再画本周，保证本周的课永远盖在上面
    if (opts.showInactive) for (const c of d.inactiveCourses ?? []) drawBlock(c, true)
    for (const c of d.courses) drawBlock(c, false)
  })

  // 页脚：说明 + 来源
  const footY = gridY + gridH + 40
  ctx.fillStyle = INK_3
  ctx.font = `400 19px ${FONT}`
  const notes: string[] = []
  if (opts.showInactive) notes.push('灰色为本学期有课、本周不上')
  if (opts.showWeeks) notes.push('已标注起止周次')
  ctx.fillText(notes.join(' · '), PAD, footY)
  ctx.textAlign = 'right'
  ctx.fillText('bjtu-helper', W - PAD, footY)
  ctx.textAlign = 'left'

  return canvas
}

/**
 * canvas → dataURL（**预览**专用）。
 *
 * 为什么预览不用 blob: URL：手机上的"保存到相册"就是**长按图片**唤出系统菜单。
 * blob: URL 在微信 / QQ / 安卓 WebView 里长按常常不给"保存图片"这一项，
 * data: URL 则各端都认。代价是字符串比 blob 大约 1/3，
 * 但预览图是低频、单张、关闭即弃，这点内存换"长按一定存得下来"是划算的。
 *
 * 注意：真正走"保存"按钮时仍然用 Blob（见 canvasToBlob）——
 * 下载与 navigator.share 都需要 Blob，dataURL 反而要再解一次。
 */
export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

/** canvas → Blob（优先 png；个别旧内核不给 toBlob 时回退 dataURL 转换） */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => {
        if (b) resolve(b)
        else reject(new Error('图片生成失败'))
      }, 'image/png')
      return
    }
    try {
      const url = canvas.toDataURL('image/png')
      const bin = atob(url.split(',')[1])
      const buf = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
      resolve(new Blob([buf], { type: 'image/png' }))
    } catch (e) {
      reject(e instanceof Error ? e : new Error('图片生成失败'))
    }
  })
}

export type SaveImageResult = 'shared' | 'downloaded' | 'cancelled' | 'failed'

/**
 * 保存/分享图片。
 *
 * 优先走系统分享（`navigator.share` + files）：在手机浏览器与原生壳里它会唤起
 * "发送给微信好友 / 存到相册"，这正是用户拿到课表图后想做的事。
 * 不支持时才退化成下载 —— 桌面浏览器与部分旧内核走这条。
 * 用户主动取消分享不算失败（返回 'cancelled'），否则每次点"取消"都弹一个红色报错。
 */
export async function saveOrShareImage(blob: Blob, filename: string): Promise<SaveImageResult> {
  const file = new File([blob], filename, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  if (typeof navigator.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '我的课表' })
      return 'shared'
    } catch (err) {
      // AbortError = 用户点了取消，不是错误
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // 其它失败（权限、文件类型不支持）→ 落到下载兜底，而不是直接失败
    }
  }
  /* ⚠️ 必须走 saveBlob 而不是 <a download>：Android WebView 里后者点了没反应，
     而「长按保存」在 WebView 里也常常被壳吞掉 —— 不修的话 App 用户拿不到课表图。
     详见 lib/saveFile.ts 顶部注释。 */
  const r = await saveBlob(blob, filename)
  return r.ok ? 'downloaded' : 'failed'
}
