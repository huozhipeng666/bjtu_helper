/**
 * 作业提交面板（「课程平台作业」→ 展开某条作业 → 提交）。
 *
 * ## 这是全站唯一不可撤回的写操作
 *
 * 平台的提交是**覆盖式**的：删掉旧记录再写新记录，没有撤回接口。
 * 所以这个组件的设计目标不是"顺手"，而是**让人慢下来**：
 *   ① 必须先勾选「我确认这是最终版本」才能点提交（不是弹窗，是常驻勾选框）；
 *   ② 文件名和大小在提交前一直可见，改完再看一眼；
 *   ③ 提交中禁止关闭面板（关掉会让人以为取消了，实际请求还在飞）；
 *   ④ 提交成功后不自动收起，而是把服务端的回读结论原样贴出来 ——
 *      包括"未能确认"这种不好看但必须说的情况。
 *
 * ## 为什么文件读成 base64
 *
 * 服务端只有 `express.json`（不引 multipart 解析器），所以走 JSON。
 * 上限 6 MB 是服务端 `MAX_TOTAL_UPLOAD_BYTES`；这里提前挡一次是为了
 * 给用户一句人话，而不是让他等上传完再收到 413。
 */
import { useCallback, useRef, useState } from 'react'
import type { Homework } from '../../types'
import { submitHomework, type SubmitHomeworkFile } from '../../api'
import { IconClose, IconPlus, IconSend } from '../../icons'

/** 与服务端 homeworkSubmit.ts 的 MAX_TOTAL_UPLOAD_BYTES 保持一致（6 MB） */
const MAX_TOTAL_BYTES = 6 * 1024 * 1024
/** 与服务端 MAX_UPLOAD_FILES 保持一致 */
const MAX_FILES = 8
/** 与服务端 MAX_SUBMIT_NOTE_LENGTH 保持一致 */
const MAX_NOTE = 5000

interface Props {
  sid: string
  homework: Homework
  onToast: (msg: string) => void
  /** 提交成功后回调，让列表重新拉一次（拿平台最新的 subStatus / submitCount） */
  onSubmitted: () => void
}

interface Picked {
  name: string
  size: number
  type: string
  data: string
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * 读文件成 base64 data URL。
 *
 * 用 FileReader 而不是 `file.text()`：后者只能读文本，而作业可能是 zip/pdf/pptx。
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`))
    reader.readAsDataURL(file)
  })
}

export default function HomeworkSubmitPanel({ sid, homework, onToast, onSubmitted }: Props) {
  const [files, setFiles] = useState<Picked[]>([])
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ hint: string; verified: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const totalBytes = files.reduce((s, f) => s + f.size, 0)

  const pick = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return
      setError('')
      const next: Picked[] = []
      let total = totalBytes
      for (const file of Array.from(list)) {
        if (files.length + next.length >= MAX_FILES) {
          setError(`一次最多提交 ${MAX_FILES} 个文件`)
          break
        }
        if (files.some((f) => f.name === file.name) || next.some((f) => f.name === file.name)) {
          setError(`「${file.name}」已经在列表里了`)
          continue
        }
        total += file.size
        if (total > MAX_TOTAL_BYTES) {
          setError(`文件总大小超过 ${fmtSize(MAX_TOTAL_BYTES)}，请先删掉几个再去网页端传大文件`)
          break
        }
        try {
          next.push({
            name: file.name,
            size: file.size,
            type: file.type,
            data: await readAsDataUrl(file)
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : '读取文件失败')
        }
      }
      if (next.length > 0) setFiles((prev) => [...prev, ...next])
      /* 清空原生 input：否则同一个文件第二次选择不会触发 change，
         用户会以为"点了没反应" */
      if (inputRef.current) inputRef.current.value = ''
    },
    [files, totalBytes]
  )

  function removeAt(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setError('')
  }

  async function doSubmit() {
    if (files.length === 0) {
      setError('请至少选择一个要提交的文件')
      return
    }
    if (!confirmed) {
      setError('请先勾选下方的确认项')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const payload: SubmitHomeworkFile[] = files.map((f) => ({
        name: f.name,
        type: f.type,
        data: f.data
      }))
      const r = await submitHomework({ sid, upId: homework.upId, note, files: payload })
      setResult({ hint: r.hint, verified: r.verified !== null })
      onToast(r.verified ? '作业已提交' : '作业已提交，请到平台核对')
      /* 清掉已上传的文件与勾选：避免用户以为"再点一次"是追加提交，
         实际是又覆盖了一遍。说明保留（可能想改几个字再提交）。 */
      setFiles([])
      setConfirmed(false)
      onSubmitted()
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hw-submit">
      <div className="hw-submit-head">
        <span className="hw-submit-title">提交作业</span>
        <span className="hw-submit-hint">
          {homework.submitted
            ? '平台显示已提交过，再次提交会覆盖上一次的记录'
            : '提交后不可撤回，请确认文件无误'}
        </span>
      </div>

      {/* ---------------- 已选文件 ---------------- */}
      {files.length > 0 && (
        <div className="hw-submit-files">
          {files.map((f, i) => (
            <div key={f.name} className="hw-submit-file">
              <span className="hw-submit-file-name">{f.name}</span>
              <span className="hw-submit-file-size">{fmtSize(f.size)}</span>
              <button
                type="button"
                className="icon-btn hw-submit-file-del"
                disabled={busy}
                onClick={() => removeAt(i)}
                aria-label={`移除 ${f.name}`}
              >
                <IconClose size={15} />
              </button>
            </div>
          ))}
          <div className="hw-submit-total">
            共 {files.length} 个文件，{fmtSize(totalBytes)}
          </div>
        </div>
      )}

      {/* ---------------- 选文件 ---------------- */}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => void pick(e.target.files)}
      />
      <button
        type="button"
        className="btn-ghost hw-submit-add"
        disabled={busy || files.length >= MAX_FILES}
        onClick={() => inputRef.current?.click()}
      >
        <IconPlus size={15} /> 选择文件（单个 ≤ {fmtSize(MAX_TOTAL_BYTES)}）
      </button>

      {/* ---------------- 提交说明 ---------------- */}
      <label className="hw-submit-note-label">
        提交说明（可选）
        <textarea
          className="hw-submit-note"
          value={note}
          rows={3}
          maxLength={MAX_NOTE}
          disabled={busy}
          placeholder="给老师留几句话，比如实现思路、遇到的问题"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      {/* ---------------- 确认与提交 ---------------- */}
      <label className="hw-submit-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>我确认这是最终版本，且知道提交会覆盖上一次的记录</span>
      </label>

      {error && <div className="hw-submit-error">{error}</div>}
      {result && (
        <div className={`hw-submit-result${result.verified ? '' : ' is-warn'}`}>
          {result.hint}
        </div>
      )}

      <button
        type="button"
        className="btn-ghost hw-submit-go"
        disabled={busy || files.length === 0 || !confirmed}
        onClick={() => void doSubmit()}
      >
        <IconSend size={15} /> {busy ? '正在提交…' : '提交作业'}
      </button>
    </div>
  )
}
