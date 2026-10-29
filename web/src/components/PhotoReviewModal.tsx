/**
 * 课表拍照识别 —— 结果预览 + 覆盖导入确认。
 * 由课表页后台识别悬浮球点开后触发（识别提交即转后台，不再有弹窗内
 * 阻塞预览）；展示识别出的课程，用户勾选后「整表替换」入库，覆盖前二次确认。
 */
import { useEffect, useState } from 'react'
import { getCourses, replaceCourses, type CourseInput, type RecognizePhotoResult } from '../api'
import { COURSE_COLORS } from '../constants'
import { weekdayCN } from '../lib/date'
import Modal from './Modal'

interface PhotoReviewModalProps {
  result: RecognizePhotoResult
  onImported: () => void
  onClose: () => void
}

interface PreviewRow {
  key: number
  course?: CourseInput & { warn?: string }
  error?: string
  checked: boolean
}

/** 同名课程给同一颜色：按课程名哈希取色 */
function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return COURSE_COLORS[h % COURSE_COLORS.length]
}

export default function PhotoReviewModal({ result, onImported, onClose }: PhotoReviewModalProps) {
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [existingCount, setExistingCount] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [resultMsg, setResultMsg] = useState('')
  const [message, setMessage] = useState('')
  const keySeq = useKeySeq()

  // 由识别结果初始化预览（默认全勾选）
  useEffect(() => {
    const next: PreviewRow[] = [
      ...(result.courses ?? []).map((c) => ({
        key: keySeq.current++,
        course: { ...c, color: colorFor(c.name) },
        checked: true
      })),
      ...(result.errors ?? []).map((e) => ({
        key: keySeq.current++,
        error: `第 ${e.index + 1} 条：${e.reason}`,
        checked: false
      }))
    ]
    setRows(next)
    getCourses()
      .then((list) => setExistingCount(list.length))
      .catch(() => setExistingCount(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  const validChecked = rows.filter((r) => r.course && r.checked)

  async function doImport() {
    setConfirming(false)
    if (validChecked.length === 0) return
    setImporting(true)
    setMessage('')
    try {
      const r = await replaceCourses(validChecked.map((row) => row.course!))
      setResultMsg(
        `导入完成：本次录入 ${r.imported} 门，清除原有课程 ${r.deleted} 门。若发现漏课，可重新拍一张补导入或手动添加。`
      )
      onImported()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '导入失败，请重试')
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <Modal
        open
        title="识别结果 · 确认导入"
        onClose={() => {
          if (importing) return
          onClose()
        }}
        footer={
          <>
            {resultMsg ? (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                完成
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" onClick={onClose} disabled={importing}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setConfirming(true)}
                  disabled={importing || validChecked.length === 0}
                >
                  {importing ? '导入中…' : `导入 ${validChecked.length} 门课程`}
                </button>
              </>
            )}
          </>
        }
      >
        {message && <div className="form-error" style={{ marginBottom: 10 }}>{message}</div>}

        {!resultMsg ? (
          <>
            <div
              style={{
                background: 'var(--warn-soft)',
                color: 'var(--warn)',
                fontSize: 12.5,
                lineHeight: 1.7,
                padding: '9px 12px',
                borderRadius: 10,
                marginBottom: 10
              }}
            >
              导入会清除当前课表的全部课程
              {existingCount !== null ? `（现有 ${existingCount} 门）` : ''}
              ，只保留下面勾选的识别结果。请确认已勾选完整，漏掉的课需要重新导入或手动补。
            </div>
            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table className="period-table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}></th>
                    <th>课程</th>
                    <th>时间</th>
                    <th>周次</th>
                    <th>地点</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ color: 'var(--text-2)', textAlign: 'center', padding: '14px 0' }}>
                        没有识别到课程
                      </td>
                    </tr>
                  )}
                  {rows.map((r) =>
                    r.course ? (
                      <tr key={r.key}>
                        <td>
                          <input
                            type="checkbox"
                            checked={r.checked}
                            disabled={importing}
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) => (x.key === r.key ? { ...x, checked: e.target.checked } : x))
                              )
                            }
                          />
                        </td>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 8,
                              height: 8,
                              borderRadius: 4,
                              background: r.course.color,
                              marginRight: 6
                            }}
                          />
                          {r.course.name}
                          {r.course.teacher ? (
                            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>（{r.course.teacher}）</span>
                          ) : null}
                          {r.course.warn ? (
                            <div style={{ color: 'var(--warn)', fontSize: 11.5, marginTop: 2 }}>⚠ {r.course.warn}</div>
                          ) : null}
                        </td>
                        <td>
                          {weekdayCN(r.course.dayOfWeek)} 第{r.course.startPeriod}
                          {r.course.endPeriod > r.course.startPeriod ? `-${r.course.endPeriod}` : ''}节
                        </td>
                        <td>
                          {r.course.weekStart}-{r.course.weekEnd}周
                          {r.course.weekType !== 'all' ? `（${r.course.weekType === 'odd' ? '单' : '双'}）` : ''}
                        </td>
                        <td>{r.course.location || '—'}</td>
                      </tr>
                    ) : (
                      <tr key={r.key}>
                        <td style={{ color: 'var(--danger)' }}>✗</td>
                        <td colSpan={4} style={{ color: 'var(--danger)', fontSize: 12 }}>
                          {r.error}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
            <p style={{ color: 'var(--text-2)', fontSize: 12, margin: '10px 2px 0', lineHeight: 1.6 }}>
              请核对识别结果，勾选要导入的课程；个别字段不对没关系，导入后在课表里点课程即可修改。
            </p>
          </>
        ) : (
          <p style={{ color: 'var(--ok)', fontSize: 13, margin: '4px 2px' }}>{resultMsg}</p>
        )}
      </Modal>

      {/* 覆盖前二次确认 */}
      {confirming && (
        <Modal
          open
          title="确认覆盖课表"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button type="button" className="btn btn-danger" onClick={doImport}>
                确认覆盖并导入
              </button>
            </>
          }
        >
          <p style={{ margin: '0 0 8px' }}>
            将导入 <b>{validChecked.length}</b> 门课程，并清除课表中现有的
            <b>{existingCount ?? 0}</b> 门课程。
          </p>
          <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
            覆盖后课表只保留本次勾选的识别结果，原有课程无法恢复。挂在旧课程下的任务会保留，但变为「无课程」。
          </p>
        </Modal>
      )}
    </>
  )
}

/** 局部递增 key 生成器（无需跨渲染持久 ref） */
function useKeySeq() {
  const [seq] = useState(() => ({ current: 0 }))
  return seq
}
