/**
 * 前端侧的登录/建号约束常量。
 *
 * ⚠️ 这里的值必须与后端 `server/src/passwordPolicy.ts` 的 `PASSWORD_MIN` 保持一致。
 * 前端校验只是"提前给提示、少一次往返"，**真正的门禁在后端**：
 * 即使这里被改错，服务端仍会用同一套策略拒绝弱口令。
 * 改后端策略时记得同步这里（否则会出现"前端放行、后端报错"的割裂体验）。
 */
export const PASSWORD_MIN = 8

/** 与后端 PASSWORD_MAX 对应，避免超长输入白跑一次请求 */
export const PASSWORD_MAX = 128

/** 昵称长度上限（后端 `PUT /api/auth/profile` 同口径） */
export const NICKNAME_MAX = 16
