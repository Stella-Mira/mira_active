/**
 * mira_active — 让会话拥有「自我激活」的能力（本质是闹钟）
 *
 * 数据模型（任务书 v2【定】）：
 *   **一条配置 = 一个闹钟**（alarmId 为键），条目里带 sessionId；同一会话可以有多条。
 *   落盘 `$DSH_HOME/mira_config/mira_active/alarms.json`（schemaVersion 2）。
 *
 * 投递（功能点9【定】）：**steer（插话）**。会话空闲 → 立刻开一轮；会话在跑 → 插到最近一步。
 * 绝不排队等下一轮 —— 排队会把「到点叫醒」变成「这一轮结束后才叫」。
 *
 * 与旧版 0.2.0 的差别：旧版是「每会话一条配置 + 全局随机间隔」，新版是「每闹钟一条」，
 * 支持单次 / 每日 / 间隔 / 随机、条目级静默、失败退避、按 alarmId 精确操作。
 * 旧状态文件 `~/.dsh/mira_active.json` 用 `重构插件/migrate/active.mjs` 转换（见 README「迁移」）。
 *
 * 只依赖 Node 内置能力。
 */

import { ensureDir, claimInstance, fail, miraConfigDir } from './kit.mjs'
import { DEFAULTS, normalizeConfig } from './config.js'
import { ActiveEngine } from './engine.js'
import { Deliverer } from './deliver.js'
import { registerTools } from './tools.js'

export const name = 'mira_active'

/** 投递要能拿到会话，这三个是硬依赖（缺了插件不加载，比起来一半好排查）。 */
export const inject = ['tools', 'sessionController', 'sessions']

const INSTANCE_ID = 'mira_active'

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const { config: cfg } = normalizeConfig(config)

  if (cfg.enabled === false) {
    logger?.info?.('[mira_active] 已禁用（config.enabled = false），不注册工具、不起定时器')
    return fail('plugin/disabled', 'mira_active 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6 单实例：两个实例 = 两套定时器 = 同一条闹钟被投递两次
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_active] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会各起一套定时器，同一条闹钟会被投递两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_active 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_active 挂了两遍；一个进程只允许一个实例')
  }

  let sessionsSvc = null
  let sessionControllerSvc = null
  try { sessionsSvc = ctx.sessions || null } catch { sessionsSvc = null }
  try { sessionControllerSvc = ctx.sessionController || null } catch { sessionControllerSvc = null }

  async function resolveAgent(sessionId) {
    if (!sessionControllerSvc || typeof sessionControllerSvc.resolveAgent !== 'function') {
      throw new Error('sessionController.resolveAgent 不可用')
    }
    const result = await sessionControllerSvc.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    const err = result && result.error
    throw new Error('resolveAgent 失败：' + (err && (err.message || err.code) ? (err.message || err.code) : String(err)))
  }

  const baseDir = miraConfigDir('mira_active')
  let engine = null
  let disposeTools = null
  try {
    ensureDir(baseDir)

    const deliverer = new Deliverer({ resolveAgent, sessions: sessionsSvc, logger })
    engine = new ActiveEngine({ baseDir, config: cfg, logger, deliverer })
    engine.load()

    disposeTools = registerTools(ctx, engine)
    engine.start()

    const status = engine.status()
    for (const warning of status.warnings.filter((w) => String(w).includes('旧版'))) {
      logger?.warn?.('[mira_active] ' + warning)
    }
    if (status.fatalError) {
      logger?.warn?.('[mira_active] alarms.json 处于致命错误状态（' + status.fatalError.code + '），'
        + '定时器不会触发任何条目。修好文件后重载插件。文件：' + status.file)
    } else {
      logger?.info?.('[mira_active] 已加载：' + status.count + ' 条闹钟（启用 ' + status.enabledCount + '），涉及 '
        + status.sessionCount + ' 个会话，最近一次触发在 ' + (status.nextAt ?? '（无）') + '，文件 ' + status.file)
    }

    ctx.effect(() => () => {
      // 顺序：先摘工具 → 停定时器并落盘 → 放认领。新实例 load 到的永远是最新文件（约定9 的踩坑点）
      try { disposeTools?.() } catch { /* noop */ }
      try { engine.dispose() } catch { /* 退场不抛 */ }
      try { claim.release() } catch { /* noop */ }
    })

    return { ok: true, file: status.file, alarms: status.count }
  } catch (error) {
    // apply 中途抛错（工具注册失败 / 宿主 effect 不收 / 目录不可写）时必须回滚干净：
    // 残留的定时器会让同一条闹钟被投递两次，没释放的单实例认领会把之后每一次重载都拒掉（只能重启进程）。
    try { disposeTools?.() } catch { /* noop */ }
    try { engine?.dispose() } catch { /* 退场不抛 */ }
    try { claim.release() } catch { /* noop */ }
    logger?.warn?.('[mira_active] 加载失败，已回滚工具/定时器/单实例认领：'
      + (error && error.message ? error.message : String(error)))
    throw error
  }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  DEFAULTS,
  ActiveEngine,
  Deliverer,
  defaults: () => structuredClone(DEFAULTS),
  configDir: () => miraConfigDir('mira_active'),
}
