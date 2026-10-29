/**
 * 变动摘要卡：一次同步后「变了什么」。
 *
 * 用在两处：数据同步页（本次结果）与消息中心（历史变动的通知详情）。
 * 未读通知点进来时展示的是同一份结构，所以抽成组件而不是各写一遍。
 */
import type { DataChange } from '../types'
import { domainLabelOf } from '../lib/changeDigest'

const KIND_LABEL: Record<DataChange['kind'], string> = {
  added: '新增',
  modified: '变更',
  deleted: '移除'
}

interface ChangeDigestCardProps {
  title?: string
  changes: DataChange[]
  /** 每域最多列几条（超出折叠成「另有 N 项」） */
  maxPerDomain?: number
}

export default function ChangeDigestCard({ title, changes, maxPerDomain = 5 }: ChangeDigestCardProps) {
  if (changes.length === 0) return null

  // 按域分组：一次同步可能同时改了作业与考试，混在一起看不出层次
  const byDomain = new Map<string, DataChange[]>()
  for (const c of changes) {
    const arr = byDomain.get(c.domain)
    if (arr) arr.push(c)
    else byDomain.set(c.domain, [c])
  }

  return (
    <div className="change-digest">
      <div className="change-digest-title">{title ?? `本次同步有 ${changes.length} 项变动`}</div>
      {[...byDomain.entries()].map(([domain, list]) => {
        const shown = list.slice(0, maxPerDomain)
        const rest = list.length - shown.length
        return (
          <div key={domain} className="change-digest-domain">
            <div className="change-digest-domain-name">
              {domainLabelOf(domain)}
              <span className="change-digest-domain-count">{list.length}</span>
            </div>
            <ul className="change-digest-list">
              {shown.map((c, i) => (
                <li key={`${c.kind}-${c.label}-${i}`} className="change-digest-item">
                  <span className="change-digest-kind" data-kind={c.kind}>
                    {KIND_LABEL[c.kind]}
                  </span>
                  <span className="change-digest-label">{c.label}</span>
                </li>
              ))}
            </ul>
            {rest > 0 && <div className="change-digest-more">另有 {rest} 项</div>}
          </div>
        )
      })}
    </div>
  )
}
