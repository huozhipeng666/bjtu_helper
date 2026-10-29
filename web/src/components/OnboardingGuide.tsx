/**
 * 新用户引导：首次注册登录（user.onboarded=0）后弹出一次，
 * 之后不再出现（点「开始使用」或「一键导入课表」都会 POST /api/auth/onboarded）。
 *
 * ## 为什么是两步
 *
 * 第二步「一键导入课表」才是这个引导真正要做的事：新账号的课表和 DDL 都是空的，
 * 只看一段功能介绍就「开始使用」，用户进去只会看到一屏 0，还得自己找导入入口。
 * 所以第一步讲清楚这里有什么，第二步直接把最关键的动作用一个按钮递到手上
 * （默认来源是智慧课程平台，见 CourseMisImport 的 SOURCE_ORDER）。
 *
 * 跳过永远是显式的、一键可达的：不诱导、不强制，符合最小打扰原则。
 */
import { useState } from 'react'
import { IconUser, IconList, IconSchedule, IconHome, IconCheck, IconDownload, IconChevronLeft } from '../icons'

interface OnboardingGuideProps {
  nickname: string
  /** 结束引导（跳过 / 已完成导入后返回） */
  onDone: () => void
  /** 第二步点「一键导入课表」：由 App 关闭引导并打开课表导入弹窗 */
  onImportCourses: () => void
}

const FEATURES = [
  {
    icon: <IconHome size={26} />,
    title: '本周 / 今日概览',
    desc: '一打开就看到今天有几节课、本周有哪些 DDL，课和时间线在同一个页面里。'
  },
  {
    icon: <IconSchedule size={26} />,
    title: '课表',
    desc: '支持「课表导入」（默认智慧课程平台，也可切本科教务，自动读课名/时间/教室/学分），也能拍照识别或手动添加。'
  },
  {
    icon: <IconList size={26} />,
    title: 'DDL',
    desc: '所有作业、考试、待办统一倒计时。点「一键添加考试信息」即可从教务直接抓考试并自动生成考试提醒。'
  },
  {
    icon: <IconUser size={26} />,
    title: '我的（个人中心）',
    desc: '换头像昵称、调深浅色、订阅日历提醒；消息通知里能看管理员回复和校园邮箱。'
  }
]

export default function OnboardingGuide({ nickname, onDone, onImportCourses }: OnboardingGuideProps) {
  /** 1 = 功能介绍，2 = 导入课表 */
  const [step, setStep] = useState<1 | 2>(1)

  return (
    <div className="onb-overlay">
      <div className="onb-card">
        <div className="onb-badge">
          <span className="onb-badge-dot" />
          新手指引 · {step}/2
        </div>

        {step === 1 ? (
          <>
            <h2 className="onb-title">{nickname ? `${nickname}，你好` : '你好'}</h2>
            <p className="onb-sub">交大小助手帮你管好课表、DDL 和考试。先认识一下这几个板块：</p>

            <div className="onb-list">
              {FEATURES.map((f) => (
                <div className="onb-item" key={f.title}>
                  <span className="onb-ico">{f.icon}</span>
                  <div className="onb-text">
                    <div className="onb-name">{f.title}</div>
                    <div className="onb-desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <button className="btn btn-primary btn-block onb-cta" onClick={() => setStep(2)}>
              <IconDownload size={18} />
              下一步：导入课表
            </button>
            <button className="btn btn-ghost btn-block onb-skip" onClick={onDone}>
              跳过，直接开始使用
            </button>
          </>
        ) : (
          <>
            <h2 className="onb-title">一键导入课表</h2>
            <p className="onb-sub">
              用学号和统一身份认证密码从<b>智慧课程平台</b>读取本学期课表，课名、时间、教室、学分自动填好，
              顺带把学期周次也对齐 —— 之后的「本周」页立刻就是你自己的课和 DDL。
            </p>

            <div className="onb-import-note">
              <span className="onb-import-dot" />
              默认来源：智慧课程平台（可切换本科教务）
            </div>

            <button className="btn btn-primary btn-block onb-cta" onClick={onImportCourses}>
              <IconDownload size={18} />
              一键导入课表
            </button>
            <button className="btn btn-ghost btn-block onb-skip" onClick={onDone}>
              <IconCheck size={17} />
              先不导入，手动添加
            </button>
            <button className="onb-back-link" onClick={() => setStep(1)}>
              <IconChevronLeft size={15} />
              返回
            </button>
          </>
        )}

        <p className="onb-tip">导入、周次对齐、考试提醒的说明，随时可在「个人中心 → 帮助」里查看</p>
      </div>
    </div>
  )
}
