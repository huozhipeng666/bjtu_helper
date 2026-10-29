import { useMemo, useState } from 'react'
import type { Exam } from '../types'
import { weekdayCN } from '../lib/date'
import { buildExamTimeline, countdownOf } from '../lib/examWindow'
import { IconClock, IconMapPin, IconGraduation } from '../icons'

interface ExamSprintCardProps {
  exams: Exam[]
  now: Date
  /** 前往考务管理入口（DDL 页的「一键添加考试信息」）；不传则不显示该按钮 */
  onManageExams?: () => void
}

/** 倒计时档位 → 颜色。'soon'(<1h) 与 'ongoing' 都用告警色，让临场感更强 */
const COUNTDOWN_COLOR: Record<ReturnType<typeof countdownOf>['level'], string> = {
  ongoing: 'var(--danger)',
  soon: 'var(--danger)',
  today: 'var(--warn)',
  later: 'var(--accent)'
}

export default function ExamSprintCard({ exams, now, onManageExams }: ExamSprintCardProps) {
  /* 主界面上默认折叠：只留一行标题 + 剩余门数，详情让用户主动展开看，不挤占首页 */
  const [collapsed, setCollapsed] = useState(true)
  const [activeIdx, setActiveIdx] = useState(0)

  // 时间窗口、排序、过期过滤全部收敛在纯函数里（见 lib/examWindow.ts），这里只负责渲染
  const upcomingExams = useMemo(() => buildExamTimeline(exams, now), [exams, now])

  if (upcomingExams.length === 0) return null

  const currentItem = upcomingExams[Math.min(activeIdx, upcomingExams.length - 1)]
  const { exam, startDt, isToday, endEstimated } = currentItem

  const { label: countdownLabel, level: countdownLevel } = countdownOf(currentItem, now)
  const countdownColor = COUNTDOWN_COLOR[countdownLevel]

  const dateLabel = `${exam.examDate} (${weekdayCN(startDt.getDay() === 0 ? 7 : startDt.getDay())})`
  const timeLabel = exam.startTime?.includes(':')
    ? endEstimated
      ? `${exam.startTime} 开考 · 时长待定`
      : `${exam.startTime} - ${exam.endTime}`
    : '时间待定'

  return (
    <div
      className="card exam-sprint-card"
      style={{
        border: '1.5px solid var(--accent)',
        background: 'linear-gradient(145deg, var(--card), var(--bg-2))',
        position: 'relative',
        overflow: 'hidden',
        marginBottom: 16
      }}
    >
      {/* 顶部标题栏与模式切换 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16 }}>🔥</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>考试冲刺模式</span>
          {isToday && (
            <span
              className="chip active"
              style={{ fontSize: 11, padding: '2px 8px', background: 'var(--danger)', color: '#fff', fontWeight: 700 }}
            >
              今天
            </span>
          )}
          <span
            className="chip active"
            style={{ fontSize: 11, padding: '2px 8px', background: 'var(--accent-weak)', color: 'var(--accent-2)' }}
          >
            剩余 {upcomingExams.length} 门考试
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onManageExams && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 12, padding: '2px 6px' }}
              onClick={onManageExams}
              title="前往 DDL 页管理考务（导入考试 / 一键转 DDL）"
            >
              考务管理 ›
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12, padding: '2px 6px' }}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? '展开 ▼' : '收起 ▲'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* 冲刺主信息卡 */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--bg-3)',
              marginBottom: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
                {exam.courseName}
              </div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  color: countdownColor,
                  background: 'var(--card)',
                  padding: '4px 10px',
                  borderRadius: 20,
                  whiteSpace: 'nowrap'
                }}
              >
                {countdownLabel}
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, fontSize: 13, color: 'var(--text-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconClock size={15} />
                <span>{dateLabel} {timeLabel}</span>
              </div>
              {exam.location && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text)' }}>
                  <IconMapPin size={15} />
                  <strong>{exam.location}</strong>
                </div>
              )}
            </div>

            {/* 座位号大字置顶 */}
            <div
              style={{
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: 8,
                background: 'var(--card)',
                border: '1px dashed var(--border)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconGraduation size={16} />
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>考场座位号：</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--accent-2)' }}>
                  {exam.seat ? `${exam.seat} 号` : '教务未公布'}
                </span>
              </div>
              {exam.note && (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {exam.note}
                </span>
              )}
            </div>
          </div>

          {/* 考前必带 Checklist 提示 */}
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-2)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              padding: '6px 4px',
              borderTop: '1px solid var(--border-soft)'
            }}
          >
            <span>📝 考前准备：</span>
            <span>☑ 学生证/校园卡</span>
            <span>☑ 身份证</span>
            <span>☑ 2B铅笔与黑色签字笔</span>
            {exam.note?.includes('计算器') && <span>☑ 科学计算器</span>}
          </div>

          {/* 多门考试切换导航 */}
          {upcomingExams.length > 1 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto', paddingBottom: 2 }}>
              {upcomingExams.map((item, idx) => (
                <button
                  key={item.exam.id}
                  className={`chip${idx === activeIdx ? ' active' : ''}`}
                  style={{
                    fontSize: 12,
                    padding: '3px 10px',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer'
                  }}
                  onClick={() => setActiveIdx(idx)}
                >
                  {item.exam.courseName}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
