/**
 * 教务会话池 —— 前端探测助手（2026-10-14）。
 *
 * 背景：以前每个教务类应用（课件 / 邮箱 / 成绩单 / 数据同步）打开时都要
 * 单独输一遍学号 + 密码。现在服务端把已登录会话留在池里
 * （不活跃滑动 TTL 2 小时），各应用打开时先探测：
 *   - 探测到会话 → 跳过登录表单，直接用（= "打开应用自动登录"）；
 *   - 没有 → 正常显示登录表单；登录一次后其他应用就都能复用了。
 *
 * 探测失败（网络抖动等）按"没有会话"处理：用户手动登录一次即可，
 * 不能因为探测接口挂了把整个应用卡死在加载态。
 */
import { probeMisSession } from '../api'

/** 探测可复用的会话（sid + 登录人姓名）；无会话或探测失败 → null */
export async function probeSessionSid(): Promise<{ sid: string; name: string } | null> {
  try {
    const r = await probeMisSession()
    if (r.ok && r.has && r.sid) return { sid: r.sid, name: r.name ?? '' }
    return null
  } catch {
    return null
  }
}
