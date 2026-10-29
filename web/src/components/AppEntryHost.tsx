/**
 * 「应用」子页分发器。
 *
 * 为什么单独抽一个文件，而不是在 App.tsx 里写一大串三元表达式：
 *   应用数量只会增加（每接一个校园子系统 +1）。App.tsx 已经 800+ 行，
 *   再塞十几个 `appPage === 'xxx' ? <XxxView/> : ...` 会彻底失控。
 *   这里把"应用 id → 组件"的映射收在一处，App.tsx 只保留一行调用。
 *
 * 未实现的应用（status='soon'）在目录页已不可点，走不到这里；
 * 但仍保留兜底分支，避免将来误加了可点却无组件的条目时白屏。
 */
import type { AppEntryHostProps } from './apps/types'
import SyncApp from './apps/SyncApp'
import HomeworkApp from './apps/HomeworkApp'
import GradesApp from './apps/GradesApp'
import CoursewareApp from './apps/CoursewareApp'
import CalendarApp from './apps/CalendarApp'
import ReportCardApp from './apps/ReportCardApp'
import CampusCardApp from './apps/CampusCardApp'
import CampusNetApp from './apps/CampusNetApp'
import MailboxApp from './apps/MailboxApp'
import ClassroomApp from './apps/ClassroomApp'
import OccupancyApp from './apps/OccupancyApp'
import ExamsApp from './apps/ExamsApp'
import CitelApp from './apps/CitelApp'
import PhyVlabApp from './apps/PhyVlabApp'
import PhysicsLabApp from './apps/PhysicsLabApp'
import PhyDemoApp from './apps/PhyDemoApp'

export default function AppEntryHost(props: AppEntryHostProps) {
  switch (props.entryId) {
    case 'homework':
      return <HomeworkApp {...props} />
    case 'grades':
      return <GradesApp {...props} />
    case 'exams':
      return <ExamsApp {...props} />
    case 'courseware':
      return <CoursewareApp {...props} />
    case 'calendar':
      return <CalendarApp {...props} />
    case 'reportcard':
      return <ReportCardApp {...props} />
    case 'campuscard':
      return <CampusCardApp {...props} />
    case 'campusnet':
      return <CampusNetApp {...props} />
    case 'mailbox':
      return <MailboxApp {...props} />
    case 'sync':
      return <SyncApp {...props} />
    case 'classroom':
      return <ClassroomApp {...props} />
    case 'occupancy':
      return <OccupancyApp {...props} />
    case 'citel':
      return <CitelApp {...props} />
    case 'phyvlab':
      return <PhyVlabApp {...props} />
    case 'physicslab':
      return <PhysicsLabApp {...props} />
    case 'phydemo':
      return <PhyDemoApp {...props} />
    default:
      return <HomeworkApp {...props} />
  }
}
