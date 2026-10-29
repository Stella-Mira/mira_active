/**
 * mira_active / deliver.js —— 投递：把一条用户消息**插话（steer）**进会话
 *
 * 为什么是 steer 而不是 followup（任务书功能点9【定】）：
 *   followup 是排队：会话在跑的时候，这条消息要等这一整轮结束才轮到它，等于「迟到的闹钟」。
 *   steer 是插话：空闲会话立刻开一轮，正在跑的会话把消息插到最近一步。
 *   闹钟语义要求「现在就叫」，所以只走 steer。
 *
 * 会话找不到 / steer 抛错 → 抛出去，由 engine 记 failCount 并退避（功能点10）。
 */

import { randomUUID } from 'node:crypto'
import { MiraError } from './kit.mjs'

/**
 * 造一条用户消息。必须带 source：宿主 RuntimeContextProjection 会读 source.kind，
 * 缺了会直接崩（qqbot / bilibili 的历史教训）。kind 用生产者自己的名字，
 * MessageSource 是「各生产者声明自己的 kind、未知 kind 直接穿透」的设计。
 */
export function makeUserMessage(text, { sessionId = '', alarmId = '' } = {}) {
  return {
    id: 'mira-active-' + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'mira_active' },
    meta: { sessionId, alarmId },
  }
}

export class Deliverer {
  /**
   * @param {object} options
   * @param {(sessionId:string)=>Promise<object>} options.resolveAgent  sessionController.resolveAgent 的薄包装
   * @param {{flush?:Function}} [options.sessions]                     宿主 sessions 服务（投递后跟一次 flush）
   * @param {object} [options.logger]
   */
  constructor({ resolveAgent, sessions = null, logger = null }) {
    this.resolveAgent = resolveAgent
    this.sessions = sessions
    this.logger = logger
  }

  async steer(sessionId, text, meta = {}) {
    const target = String(sessionId ?? '').trim()
    if (!target) throw new MiraError('config/missing', 'sessionId 为空，无法投递', '闹钟条目必须带 sessionId')
    const agent = await this.resolveAgent(target)
    if (!agent) throw new MiraError('delivery/failed', '会话不存在或拿不到 live agent：' + target, '会话可能已被删除；检查 mira_active_list 里的 sessionId')
    if (typeof agent.steer !== 'function') {
      throw new MiraError('delivery/failed', 'agent.steer 不可用（会话 ' + target + '）', '宿主版本不支持插话投递')
    }
    agent.steer(makeUserMessage(text, { sessionId: target, alarmId: meta.alarmId }))
    try {
      if (this.sessions && typeof this.sessions.flush === 'function' && agent.session) await this.sessions.flush(agent.session)
    } catch { /* flush 失败不影响「已投递」，日志宿主自己出 */ }
    return agent
  }
}
