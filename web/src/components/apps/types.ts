/** 「应用」子页的公共契约。所有 apps/*.tsx 都接收同一组 props。 */

export interface AppEntryHostProps {
  /** 应用 id，对应 lib/appRegistry.ts 的 AppEntry.id */
  entryId: string
  /** 返回目录页 */
  onBack: () => void
  onToast: (msg: string) => void
  /** 全局刷新计数：数据变更后 bump，子页据此重新取数 */
  refreshKey: number
  /** 本地数据发生变更（新建/删除课程等）时调用 */
  onMutated: () => void
}
