/**
 * mira_active / tools.js —— 对 agent 暴露的工具（任务书功能点12 的四个 + list/status + remove）
 *
 * 语义要点（PLAN §3.1，任务书没写死，这是明确取舍）：
 *   enable  不带 alarmId = 「按当前会话」：复用该会话的 default 条目，没有就建一条
 *   disable 不带 alarmId = 关掉该会话**全部**闹钟，并把关掉的 alarmId 列出来（避免"关了一条以为全关了"）
 *   fire_now 只跳过时间判断，**静默仍然生效**（PLAN B8）
 */

import { MiraError, textTool } from './kit.mjs'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const num = (description) => ({ type: 'number', description })

const rangeSchema = {
  type: 'object',
  properties: {
    from: str('开始 HH:MM（24 小时制，必须补零）'),
    to: str('结束 HH:MM'),
    days: { type: 'array', items: { type: 'integer' }, description: '可选，0=周日…6=周六；省略=每天。跨午夜时指窗口开始那天' },
  },
  required: ['from', 'to'],
}

const scheduleSchema = {
  type: 'object',
  description: '定时方式。once=一次性 / daily=每天固定时刻 / interval=每 N 分钟 / random=按天期望次数',
  properties: {
    type: { type: 'string', enum: ['once', 'daily', 'interval', 'random'] },
    at: str('once 用：绝对时刻 ISO8601（不接受过去时刻）'),
    afterMinutes: num('once 用：从现在起多少分钟（保存时折算成绝对时刻）'),
    times: { type: 'array', items: { type: 'string' }, description: 'daily 用：["09:00","21:00"]' },
    intervalMinutes: num('interval 用：间隔分钟数（≥1）'),
    perDay: num('random 用：每天期望次数'),
    range: { type: 'array', items: { type: 'integer' }, description: 'random 用：[min,max] 每天期望次数的区间' },
  },
  required: ['type'],
}

const promptSchema = {
  type: 'object',
  description: '提示词。mode=single 用 text；mode=list 用 texts + order。支持 {{time}} {{date}} {{sessionId}} {{alarmId}} {{count}}',
  properties: {
    mode: { type: 'string', enum: ['single', 'list'] },
    text: str('single：被叫醒时说的那句话'),
    texts: { type: 'array', items: { type: 'string' }, description: 'list：候选提示词' },
    order: { type: 'string', enum: ['random', 'seq'], description: 'list 时怎么挑：随机 / 顺序循环' },
  },
}

const quietSchema = {
  type: 'object',
  description: '静默时段（命中则本次不触发、不补，只记 missedCount）',
  properties: {
    enabled: bool('默认 true；false = 不启用静默'),
    ranges: { type: 'array', items: rangeSchema, description: '静默区间，可多段、可跨午夜、可按星期' },
  },
}

const limitsSchema = {
  type: 'object',
  properties: {
    maxPerDay: num('每天最多触发几次（0=不限）'),
    minGapMinutes: num('两次触发之间至少隔多少分钟（0=不限）'),
    failBackoffMinutes: num('投递失败后等多少分钟再试（默认 10）'),
    maxFailures: num('连续失败多少次后自动停用（默认 5）'),
  },
}

function currentSessionId(exec) {
  const agent = exec && exec.agent
  if (!agent) return ''
  // **优先用活会话的 id**：resume / 克隆 / rekey 之后 `agent.id` 可能还是旧 id（实测：
  // 会话目录是 qq-mvpvzf70-01703d，而 exec.agent.id 报 qq-mvp8dqhy-smrami），拿它去绑定会让
  // taker 指向不存在的会话、每次发送都要 force、回信路由错位。`agent.session.id` 是会话日志的权威 id。
  const live = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  if (live) return live
  return typeof agent.id === 'string' ? agent.id : ''
}

export function registerTools(ctx, engine) {
  const defs = []

  defs.push(textTool(
    'mira_active_enable',
    '给会话装一个「闹钟」：到点会自动往这个会话里**插话**注入一条消息，让 agent 自己跑一轮（会话忙也会插到最近一步，不排队）。'
    + '不传 alarmId 时按当前会话处理：该会话已有 default 闹钟就复用，没有就新建一条（默认每天随机 6 次）。'
    + '同一会话可以有多条闹钟，用 alarmId 精确操作；要改配置就带 alarmId 再调一次。'
    + '带 alarmId 且显式给了**不同**的 sessionId 时会把这条闹钟改绑到新会话（保留统计与下次触发时刻，不重置计时）。',
    obj({
      sessionId: str('要装闹钟的会话 id；不带 alarmId 时不给则用当前会话；带 alarmId 时显式给不同 id 才会改绑（不给=不改绑）'),
      alarmId: str('精确操作已有闹钟（见 mira_active_list）'),
      note: str('备注（只用于状态显示）'),
      schedule: scheduleSchema,
      prompt: promptSchema,
      quiet: quietSchema,
      limits: limitsSchema,
      workRanges: { type: 'array', items: rangeSchema, description: '扩展：只在正向开工时段内触发（窗口外不记错过）' },
      maxPerRange: num('扩展：单个开工时段内最多触发几次（0=不限）'),
      create: bool('true=强制新建一条（同一会话要装多条闹钟时用）；默认会复用该会话已有的 default 条目'),
    }),
    async (args, exec) => {
      const explicitSessionId = String(args.sessionId || '').trim()
      // 带 alarmId 时只有**显式**给的 sessionId 才算改绑：不传时不能拿「当前会话」当目标，
      // 否则在别的会话里改一条闹钟的配置会把它悄悄搬走（旧行为是静默忽略，也不能矫枉过正）。
      const sessionId = args.alarmId ? explicitSessionId : (explicitSessionId || currentSessionId(exec))
      const result = engine.enable({
        sessionId,
        alarmId: args.alarmId,
        note: args.note,
        schedule: args.schedule,
        prompt: args.prompt,
        quiet: args.quiet,
        limits: args.limits,
        workRanges: args.workRanges,
        maxPerRange: args.maxPerRange,
        create: args.create === true,
      })
      return {
        ok: true,
        action: result.action,
        sessionId: result.alarm.sessionId,
        ...(result.rebound ? { rebound: result.rebound } : {}),
        alarm: engine.view(result.alarm),
      }
    },
  ))

  defs.push(textTool(
    'mira_active_disable',
    '停用闹钟。给 alarmId 只停那一条；不给则停掉**当前会话的全部**闹钟，并在返回里列出关掉了哪些。'
    + '条目不会删除（记录留着便于复查），要删用 mira_active_remove。幂等。',
    obj({
      alarmId: str('精确停用某条闹钟'),
      sessionId: str('停用该会话全部闹钟；不给则用当前会话'),
    }),
    async (args, exec) => {
      const result = engine.disable({
        alarmId: args.alarmId,
        sessionId: String(args.sessionId || '').trim() || currentSessionId(exec),
      })
      return { ok: true, ...result }
    },
  ))

  defs.push(textTool(
    'mira_active_list',
    '列出闹钟条目：id / sessionId / 是否启用 / 定时方式 / 下次触发时刻（ISO 与还有多少分钟）/ 统计'
    + '（累计触发 fireCount、失败 failCount、错过 missedCount）/ 静默时段 / 限额。可按会话过滤。',
    obj({ sessionId: str('只看某个会话的闹钟') }),
    async (args) => {
      const alarms = engine.list(args.sessionId)
      return { ok: true, count: alarms.length, file: engine.store.file, alarms }
    },
  ))

  defs.push(textTool(
    'mira_active_fire_now',
    '立刻触发一次指定闹钟（不改变它的 schedule 与下次触发时刻）。只跳过时间判断：'
    + '**命中静默时段仍然不触发**，而是记 missedCount 并返回 fired:false。',
    obj({ alarmId: str('要立刻触发的闹钟 id（必填）') }, ['alarmId']),
    async (args) => {
      if (!args.alarmId) throw new MiraError('config/missing', 'alarmId 必填', '先 mira_active_list 拿 alarmId')
      return engine.fireNow(args.alarmId)
    },
  ))

  defs.push(textTool(
    'mira_active_pause',
    '临时停用/恢复一条闹钟（不动它的其他配置）。恢复时如果原来没有下次触发时刻，会重新算一个。',
    obj({ alarmId: str('闹钟 id'), paused: bool('true=暂停，false=恢复') }, ['alarmId', 'paused']),
    async (args) => {
      const result = engine.pause(args.alarmId, args.paused !== false)
      return { ok: true, paused: result.paused, alarm: engine.view(result.alarm) }
    },
  ))

  defs.push(textTool(
    'mira_active_remove',
    '删除一条闹钟（连统计一起删）。只是想暂时别响请用 mira_active_pause / mira_active_disable。',
    obj({ alarmId: str('闹钟 id') }, ['alarmId']),
    async (args) => {
      const alarm = engine.remove(args.alarmId)
      return { ok: true, removed: alarm.id, sessionId: alarm.sessionId }
    },
  ))

  defs.push(textTool(
    'mira_active_status',
    '只读状态：条目数与启用数、涉及几个会话、最近触发、失败与错过计数、本进程定时器是否在跑（timerRunning / 下次多久后检查）、上次错误、加载告警、'
    + '以及 alarms.json 处于致命错误时的详情（config/schema / config/corrupt）。',
    obj({}),
    async () => engine.status(),
  ))

  // 注册中途失败要把已经注册的工具摘掉：否则 apply 抛错后宿主里残留一半工具，
  // 而 registerTools 没返回、调用方拿不到 disposer，永远收不回来。
  const disposers = []
  try {
    for (const def of defs) disposers.push(ctx.tools.register(def))
  } catch (error) {
    for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
    throw error
  }
  return () => disposers.forEach((d) => { try { d() } catch { /* noop */ } })
}
