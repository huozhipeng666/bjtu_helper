import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './db.js'

/**
 * 清理「孤儿图片」——存在于 uploads 目录、但没有任何帖子/反馈工单引用、且已存在足够久的文件。
 *
 * 为什么会产生孤儿：
 *   前端是「选图即上传」（选完立刻拿到 /uploads/xxx.png，再把 url 放进表单）。
 *   用户取消提交、或提交校验失败时，已经落盘的文件就再也没有引用者了。
 *   这类文件不会自己消失，长期运行会持续占磁盘。改成「提交时才上传」是更彻底的方案，
 *   但那要动前端上传流程与失败重试语义，风险更大；服务端兜底清理更稳。
 *
 * 为什么要有时间闸门：
 *   不能删「刚上传、但还没提交」的文件——那正是用户正在编辑的内容。
 *   只有超过 MIN_AGE_MS 仍无人引用的，才能确定是废弃产物。
 *
 * 闸门为什么是 2 小时而不是 24 小时：
 *   真实的"选图即上传、取消即废弃"窗口只有几分钟；24 小时意味着**任何**上传洪泛
 *   都能把磁盘占满一整天（此前上传接口还没有限流，见 index.ts 的 uploadLimit）。
 *   2 小时既不会误删正在填的表单，又让最坏情况的占用时间缩小 12 倍。
 *
 * ⚠️ 引用来源必须同时覆盖 posts 与 feedbacks 两张表（论坛下架后帖子图片由 feedbacks 承接），
 *    详见下方 collectReferences 处的说明。
 *
 * 安全性：只处理 uploads 目录下的**普通文件**，不递归、不跟随目录，文件名与引用名精确比对。
 */
const MIN_AGE_MS = 2 * 3600 * 1000

export function sweepOrphanUploads(uploadsDir: string): { scanned: number; removed: number; freedBytes: number } {
  let names: string[]
  try {
    names = readdirSync(uploadsDir)
  } catch {
    return { scanned: 0, removed: 0, freedBytes: 0 }
  }

  /* 收集全部被引用的文件名。
     引用来源**必须同时包含 posts.images 与 feedbacks.images**：
       - posts 是论坛时代的帖子（表仍保留，见 db.ts 的下架说明）；
       - feedbacks 是迁移后的反馈工单（论坛帖子迁过来时图片引用一并带过来）。
     ⚠️ 只查其中一张表，另一张表里仍在使用的图片会在 24 小时后被当成孤儿删掉 ——
        迁移完成后旧帖图片就只剩 feedbacks 一个引用来源了，漏掉它等于批量删用户的历史截图。
     两张表任一不存在（全新部署 / 未来清理）都不算错，跳过即可。 */
  const referenced = new Set<string>()
  const sources: { table: string }[] = [{ table: 'posts' }, { table: 'feedbacks' }]
  for (const src of sources) {
    let rows: { images: string | null }[] = []
    try {
      rows = db.prepare(`SELECT images FROM ${src.table}`).all() as { images: string | null }[]
    } catch {
      /* 表不存在等异常：跳过该来源，不影响其它来源 */
      continue
    }
    for (const r of rows) {
      if (!r.images) continue
      try {
        const arr = JSON.parse(r.images)
        if (!Array.isArray(arr)) continue
        for (const u of arr) {
          if (typeof u !== 'string') continue
          const base = u.split('/').pop()
          if (base) referenced.add(base)
        }
      } catch {
        /* 脏数据（非 JSON）忽略，不影响其它记录的引用收集 */
      }
    }
  }

  const now = Date.now()
  let removed = 0
  let freedBytes = 0
  for (const name of names) {
    if (referenced.has(name)) continue
    const full = join(uploadsDir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (now - st.mtimeMs < MIN_AGE_MS) continue
    try {
      unlinkSync(full)
      removed++
      freedBytes += st.size
    } catch {
      /* 单个文件删不掉不影响其它文件 */
    }
  }

  return { scanned: names.length, removed, freedBytes }
}
