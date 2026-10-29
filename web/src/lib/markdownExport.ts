/**
 * 「复制为 Markdown / 保存为 Markdown」。
 *
 * 参考仓库（BJTUselfService-KMP-Refreshed）在作业详情、CITEL 题面、作业聚合
 * 三处都提供了这两个动作。真实用途很具体：把这些内容贴进 Obsidian / Notion，
 * 或者丢给 AI 助手问"这道题怎么做"。所以格式要让**人和机器都好读**：
 *
 *  - 用 `##` 分节而不是表格 —— 表格在窄屏聊天窗口里会错行；
 *  - 元信息（截止/分数/提交状态）放在一个引用块里，粘出去像"卡片头"；
 *  - 正文原样保留（平台给的是纯文本，不要自作聪明做 HTML→MD 转换，
 *    那会把代码里的 `<` 吃掉）。
 *
 * 两个动作的区别（**不是同一个东西**）：
 *  - 复制：走 `navigator.clipboard.writeText`。HTTP 环境下不可用，
 *    所以有 textarea + execCommand 的回退 —— 内网部署很常见，不能只支持 https。
 *  - 保存：走 `saveBlob`（已有的下载通道），保证 Android WebView 里也能存下来。
 *    直接 `<a download>` 在 WebView 里点了没反应，这是 saveFile.ts 里记录过的坑。
 */
import { saveBlob, sanitizeFileName, type SaveResult } from './saveFile'

/**
 * 复制文本到剪贴板。
 *
 * 三级回退，按可靠性从高到低：
 *  1. `navigator.clipboard.writeText` —— 只在安全上下文（https / localhost）可用；
 *  2. 选中 + `document.execCommand('copy')` —— 已废弃但兼容性最好；
 *  3. 都失败则抛错，让调用方提示用户「手动长按选中复制」。
 *
 * 为什么值得写三级：本项目常被部署在校园内网的 http:// 地址上，
 * 那里第 1 条必然不可用 —— 只写第 1 条等于在主要使用场景里功能直接失效。
 */
export async function copyText(text: string): Promise<boolean> {
  /* 第 1 级：现代剪贴板 API */
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 用户拒绝授权或浏览器策略拦截，继续往下试 */
    }
  }
  /* 第 2 级：隐藏 textarea + execCommand */
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    /* 不能 display:none —— 那样选不中，复制会得到空串。
       用 fixed + 透明 + 零尺寸把它藏到视野外。 */
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 保存文本为文件（Markdown 走这里） */
export async function saveText(
  filename: string,
  text: string,
  mime = 'text/markdown;charset=utf-8'
): Promise<SaveResult> {
  const blob = new Blob([text], { type: mime })
  return saveBlob(blob, sanitizeFileName(filename))
}

/* ============================================================
   Markdown 构造
   ============================================================ */

/** 转义会破坏 Markdown 结构的字符（只处理行首的，正文里的不动） */
function safeHeading(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim()
}

export interface HomeworkMdInput {
  courseName: string
  title: string
  homeworkType: number
  endTime: string
  score: string
  submitted: boolean
  subStatus: string
  content: string
}

/**
 * 单条作业 → Markdown。
 *
 * 空字段**整行省略**而不是写「无」：一篇到处是「无」的文档没法读。
 * 但「未提交」要显式写出来 —— 那是这份文档最重要的信息，不能因为它是
 * 布尔假值就被省略掉。
 */
export function homeworkToMarkdown(h: HomeworkMdInput): string {
  const typeName = h.homeworkType === 0 ? '作业' : h.homeworkType === 1 ? '课程设计' : '实验报告'
  const lines: string[] = [`# ${safeHeading(h.title || '未命名作业')}`, '']
  lines.push(`> 课程：${safeHeading(h.courseName || '未知课程')}`)
  lines.push(`> 类型：${typeName}`)
  if (h.endTime) lines.push(`> 截止：${h.endTime}`)
  if (h.score) lines.push(`> 成绩：${h.score}`)
  lines.push(`> 状态：${h.submitted ? `已提交${h.subStatus ? `（${h.subStatus}）` : ''}` : '未提交'}`)
  lines.push('')
  lines.push('## 作业要求')
  lines.push('')
  lines.push(h.content?.trim() ? h.content.trim() : '_平台未提供作业说明_')
  return lines.join('\n')
}

/**
 * 整门课（或全部）作业 → 一份 Markdown。
 *
 * 排序口径与列表页一致：未交的在前、按截止时间升序 ——
 * 导出的文档和屏幕上看到的顺序必须一样，否则用户会以为导出漏了东西。
 */
export function homeworkListToMarkdown(
  items: HomeworkMdInput[],
  scopeName: string
): string {
  const sorted = [...items].sort((a, b) => {
    if (a.submitted !== b.submitted) return a.submitted ? 1 : -1
    return (a.endTime || '9999-12-31').localeCompare(b.endTime || '9999-12-31')
  })
  const pending = sorted.filter((h) => !h.submitted).length
  const lines: string[] = [
    `# ${safeHeading(scopeName)} 作业清单`,
    '',
    `> 共 ${sorted.length} 条，其中 ${pending} 条未提交`,
    `> 导出于 ${new Date().toLocaleString('zh-CN')}`,
    ''
  ]
  /* 按课程分节：同一门课的作业放一起，比按时间混排更好找 */
  const byCourse = new Map<string, HomeworkMdInput[]>()
  for (const h of sorted) {
    const k = h.courseName.trim() || '未知课程'
    const arr = byCourse.get(k)
    if (arr) arr.push(h)
    else byCourse.set(k, [h])
  }
  for (const [course, list] of byCourse) {
    lines.push(`## ${safeHeading(course)}`, '')
    for (const h of list) {
      const flag = h.submitted ? 'x' : ' '
      const due = h.endTime ? ` （截止 ${h.endTime}）` : ''
      lines.push(`- [${flag}] ${safeHeading(h.title || '未命名作业')}${due}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** 文件名：课程名 + 作业标题，去掉非法字符并限长（过长的文件名在 Windows 上会失败） */
export function homeworkFilename(courseName: string, title: string): string {
  const base = `${courseName || '作业'}-${title || '详情'}`.trim()
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ')
  return (cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned) + '.md'
}
