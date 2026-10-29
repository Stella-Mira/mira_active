/**
 * mira_active / alarms.js —— 闹钟条目的落盘、校验、CRUD
 *
 * 数据模型（任务书【定】）：
 *   一条配置 = 一个闹钟条目，alarmId 为键，条目里带 sessionId。
 *   同一会话可以有多条闹钟；不再是「每会话一条配置」。
 *
 * 落盘：$DSH_HOME/mira_config/mira_active/alarms.json
 *   { "schemaVersion": 2, "alarms": { "<alarmId>": { ...alarm } } }
 *
 * 容错口径（刻意和 mira_account 一致）：
 *   文件坏 / 版本不符 → **拒绝使用并保留原文件**（绝不静默清空，否则用户的闹钟全没了），
 *   错误进 status，工具报 config/schema 或 config/corrupt。
 *   手改文件里个别字段不合法 → 该字段回落默认值并 warn（不让一条坏条目毁掉整个文件）。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  MiraError, checkSchema, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'
import {
  SCHEDULE_TYPES, computeNext, dayKey, parseHHMM,
} from './schedule.js'

export const ALARMS_SCHEMA = 2

/** 内置默认提示词：不配置 prompt 时用它（任务书没规定默认文案，这里给一个中性的）。 */
export const DEFAULT_PROMPT = '（自我激活）现在是你的自由时间。可以做点自己想做的事，也可以只是整理一下想法；没事就简短说一句，不必硬找活干。'

export const LIMIT_DEFAULTS = {
  maxPerDay: 0,          // 0 = 不限
  minGapMinutes: 0,      // 0 = 不限
  failBackoffMinutes: 10,
  maxFailures: 5,
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function newId() {
  return 'a-' + randomUUID().replace(/-/g, '').slice(0, 10)
}

function asInt(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function invalid(message, hint) {
  return new MiraError('config/invalid', message, hint)
}

/** 校验一组时段（quiet / workRanges）：非法就抛，不猜、不静默丢。 */
function validateRanges(ranges, label) {
  if (ranges === undefined || ranges === null) return []
  if (!Array.isArray(ranges)) throw invalid(label + ' 必须是数组', '形如 [{ "from": "01:00", "to": "07:00" }]，可选 days:[0..6]')
  return ranges.map((range, index) => {
    if (!range || typeof range !== 'object') throw invalid(label + '[' + index + '] 不是对象', '形如 { "from": "01:00", "to": "07:00" }')
    const from = parseHHMM(range.from)
    const to = parseHHMM(range.to)
    if (from < 0) throw invalid(label + '[' + index + '].from 不是 HH:MM：' + JSON.stringify(range.from), '例如 "01:00"（24 小时制，必须补零）')
    if (to < 0) throw invalid(label + '[' + index + '].to 不是 HH:MM：' + JSON.stringify(range.to), '例如 "07:00"')
    if (from === to) throw invalid(label + '[' + index + '] 的 from 和 to 相同（零长区间）', '跨午夜请写成 from "22:00" to "01:00"')
    const out = { from: String(range.from).trim(), to: String(range.to).trim() }
    if (Array.isArray(range.days) && range.days.length) {
      const days = range.days.map((d) => asInt(d, -1))
      if (days.some((d) => d < 0 || d > 6)) throw invalid(label + '[' + index + '].days 必须是 0–6', '0=周日 … 6=周六；省略=每天')
      out.days = [...new Set(days)].sort()
    }
    return out
  })
}

/** 校验 schedule（功能点4/5/6）。once 的 relative 在保存时折算成绝对时刻。 */
export function validateSchedule(schedule, now = Date.now()) {
  if (!schedule || typeof schedule !== 'object') throw invalid('schedule 必填', '例如 { "type": "daily", "times": ["09:00"] }')
  const type = String(schedule.type ?? '').trim()
  if (!SCHEDULE_TYPES.includes(type)) {
    throw invalid('schedule.type 非法：' + JSON.stringify(schedule.type), '可选 ' + SCHEDULE_TYPES.join(' / '))
  }
  if (type === 'once') {
    const afterMinutes = Number(schedule.afterMinutes)
    if (Number.isFinite(afterMinutes) && afterMinutes > 0) {
      return { type, at: new Date(now + Math.round(afterMinutes * 60_000)).toISOString() }
    }
    const at = Date.parse(String(schedule.at ?? ''))
    if (!Number.isFinite(at)) throw invalid('schedule.type=once 需要 at（ISO8601）或 afterMinutes（正整数）', '例如 { "type":"once", "afterMinutes": 30 }')
    if (at < now - 60_000) throw invalid('schedule.at 是过去时刻：' + new Date(at).toISOString(), '一次性闹钟不接受过去时刻；要立刻触发一次用 mira_active_fire_now')
    return { type, at: new Date(at).toISOString() }
  }
  if (type === 'daily') {
    const times = Array.isArray(schedule.times) ? schedule.times : []
    if (times.length === 0) throw invalid('schedule.type=daily 需要 times（至少一个 HH:MM）', '例如 { "type":"daily", "times": ["09:00","21:00"] }')
    for (const time of times) {
      if (parseHHMM(time) < 0) throw invalid('times 里有非法时刻：' + JSON.stringify(time), '24 小时制 "HH:MM"，必须补零')
    }
    return { type, times: [...new Set(times.map((t) => String(t).trim()))].sort() }
  }
  if (type === 'interval') {
    const minutes = asInt(schedule.intervalMinutes, 0)
    if (minutes < 1) throw invalid('schedule.type=interval 需要 intervalMinutes ≥ 1', '例如 { "type":"interval", "intervalMinutes": 45 }')
    return { type, intervalMinutes: minutes }
  }
  // random
  const out = { type: 'random' }
  if (Array.isArray(schedule.range) && schedule.range.length === 2) {
    const min = asInt(schedule.range[0], 0)
    const max = asInt(schedule.range[1], 0)
    if (min < 1 || max < min) throw invalid('schedule.range 需要 [min,max] 且 1 ≤ min ≤ max', '例如 { "type":"random", "range": [3, 6] }')
    out.range = [min, max]
  }
  const perDay = asInt(schedule.perDay, 0)
  if (!out.range && perDay < 1) throw invalid('schedule.type=random 需要 perDay ≥ 1 或 range [min,max]', '例如 { "type":"random", "perDay": 6 }')
  if (out.range && perDay > 0) out.perDay = perDay
  if (perDay > 0) out.perDay = perDay
  return out
}

export function validatePrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') {
    return { mode: 'single', text: DEFAULT_PROMPT, order: 'random' }
  }
  const mode = String(prompt.mode ?? 'single')
  if (!['single', 'list'].includes(mode)) throw invalid('prompt.mode 非法：' + JSON.stringify(prompt.mode), '可选 single / list')
  const order = String(prompt.order ?? 'random')
  if (!['random', 'seq'].includes(order)) throw invalid('prompt.order 非法：' + JSON.stringify(prompt.order), '可选 random / seq')
  if (mode === 'list') {
    const texts = (Array.isArray(prompt.texts) ? prompt.texts : [])
      .map((t) => String(t ?? '')).filter((t) => t.trim() !== '')
    if (texts.length === 0) throw invalid('prompt.mode=list 需要非空 texts[]', '给至少一条候选提示词')
    return { mode, texts, order }
  }
  const text = String(prompt.text ?? '').trim()
  if (!text) throw invalid('prompt.mode=single 需要非空 text', '也就是「被叫醒时听到的那句话」')
  return { mode: 'single', text, order }
}

export function validateLimits(limits) {
  const out = { ...LIMIT_DEFAULTS }
  if (!limits || typeof limits !== 'object') return out
  for (const key of Object.keys(LIMIT_DEFAULTS)) {
    if (limits[key] === undefined) continue
    const value = asInt(limits[key], -1)
    if (value < 0) throw invalid('limits.' + key + ' 必须是非负整数', '0 表示不限')
    out[key] = value
  }
  if (out.maxFailures === 0) out.maxFailures = LIMIT_DEFAULTS.maxFailures
  return out
}

/** 组装一个新条目（创建路径，严格校验）。 */
export function makeAlarm(input, now = Date.now()) {
  const sessionId = String(input?.sessionId ?? '').trim()
  if (!sessionId) {
    throw new MiraError('config/missing', 'alarm.sessionId 必填', '一条闹钟挂在哪个会话上不能猜：调用时带 sessionId，或在会话里调用工具让它自动用当前会话')
  }
  const schedule = validateSchedule(input?.schedule, now)
  const prompt = validatePrompt(input?.prompt)
  const quietInput = input?.quiet
  const quiet = {
    enabled: quietInput?.enabled !== false,
    ranges: validateRanges(quietInput?.ranges ?? (Array.isArray(quietInput) ? quietInput : []), 'quiet.ranges'),
  }
  const limits = validateLimits(input?.limits)
  const workRanges = validateRanges(input?.workRanges, 'workRanges')
  const alarm = {
    id: String(input?.id ?? '').trim() || newId(),
    sessionId,
    enabled: input?.enabled !== false,
    note: String(input?.note ?? ''),
    schedule,
    prompt,
    quiet,
    delivery: 'steer',
    limits,
    stats: {
      createdAt: nowIso(now),
      lastFiredAt: null,
      fireCount: 0,
      failCount: 0,
      missedCount: 0,
      consecutiveFailures: 0,
      dayKey: dayKey(now),
      dayFired: 0,
      rangeKey: '',
      rangeFired: 0,
    },
    nextAt: null,
    backoffUntil: 0,
  }
  if (workRanges.length) alarm.workRanges = workRanges
  if (asInt(input?.maxPerRange, 0) > 0) alarm.maxPerRange = asInt(input.maxPerRange, 0)
  alarm.nextAt = alarm.enabled ? computeNext(alarm, now) : null
  return alarm
}

/** 手改文件的宽松归一：坏字段回落默认 + 收进 problems，不让一条坏条目毁掉整个文件。 */
function normalizeStored(raw, problems, now) {
  const id = String(raw?.id ?? '').trim()
  if (!ID_RE.test(id)) { problems.push('条目 id 非法，已跳过：' + JSON.stringify(raw?.id)); return null }
  const sessionId = String(raw?.sessionId ?? '').trim()
  if (!sessionId) { problems.push(id + '：sessionId 为空，已跳过（不猜它属于哪个会话）'); return null }
  let schedule
  try {
    schedule = validateSchedule(raw?.schedule, now)
  } catch (error) {
    // 停机期间「过点」的一次性闹钟不是坏条目：validateSchedule 拒收过去时刻，
    // 但加载时把它整条丢掉 = 条目从内存消失、下次 save 时从文件里永久消失（用户会以为闹钟没设过）。
    // 这里保留它，由 load() 记一次错过并停用（不补发）。
    const stored = raw?.schedule
    const at = stored && String(stored.type) === 'once' ? Date.parse(String(stored.at ?? '')) : NaN
    if (!Number.isFinite(at)) {
      problems.push(id + '：schedule 非法（' + error.message + '），已跳过')
      return null
    }
    schedule = { type: 'once', at: new Date(at).toISOString() }
    problems.push(id + '：一次性闹钟的时刻已过（停机期间错过），保留条目、记一次错过并停用，不补发')
  }
  let prompt = { mode: 'single', text: DEFAULT_PROMPT, order: 'random' }
  try { prompt = validatePrompt(raw?.prompt) } catch (error) { problems.push(id + '：prompt 非法，已回落默认文案（' + error.message + '）') }
  let limits = { ...LIMIT_DEFAULTS }
  try { limits = validateLimits(raw?.limits) } catch (error) { problems.push(id + '：limits 非法，已回落默认（' + error.message + '）') }
  let quietRanges = []
  try { quietRanges = validateRanges(raw?.quiet?.ranges ?? [], 'quiet.ranges') } catch (error) { problems.push(id + '：quiet.ranges 非法，已清空（' + error.message + '）') }
  let workRanges = []
  try { workRanges = validateRanges(raw?.workRanges ?? [], 'workRanges') } catch (error) { problems.push(id + '：workRanges 非法，已清空（' + error.message + '）') }

  const statsIn = raw?.stats ?? {}
  const alarm = {
    id,
    sessionId,
    enabled: raw?.enabled !== false,
    note: String(raw?.note ?? ''),
    schedule,
    prompt,
    quiet: { enabled: raw?.quiet?.enabled !== false, ranges: quietRanges },
    delivery: 'steer',
    limits,
    stats: {
      createdAt: typeof statsIn.createdAt === 'string' ? statsIn.createdAt : nowIso(now),
      lastFiredAt: typeof statsIn.lastFiredAt === 'string' ? statsIn.lastFiredAt : null,
      fireCount: Math.max(0, asInt(statsIn.fireCount, 0)),
      failCount: Math.max(0, asInt(statsIn.failCount, 0)),
      missedCount: Math.max(0, asInt(statsIn.missedCount, 0)),
      consecutiveFailures: Math.max(0, asInt(statsIn.consecutiveFailures, 0)),
      dayKey: typeof statsIn.dayKey === 'string' ? statsIn.dayKey : dayKey(now),
      dayFired: Math.max(0, asInt(statsIn.dayFired, 0)),
      rangeKey: typeof statsIn.rangeKey === 'string' ? statsIn.rangeKey : '',
      rangeFired: Math.max(0, asInt(statsIn.rangeFired, 0)),
    },
    nextAt: Number.isFinite(raw?.nextAt) ? raw.nextAt : null,
    backoffUntil: Number.isFinite(raw?.backoffUntil) ? raw.backoffUntil : 0,
  }
  if (workRanges.length) alarm.workRanges = workRanges
  if (asInt(raw?.maxPerRange, 0) > 0) alarm.maxPerRange = asInt(raw.maxPerRange, 0)
  if (alarm.enabled && alarm.nextAt === null) alarm.nextAt = computeNext(alarm, now)
  return alarm
}

export class AlarmStore {
  constructor(baseDir) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'alarms.json')
    /** id -> alarm */
    this.alarms = new Map()
    /** 加载期问题（非致命）：坏条目、被清空的区间等 */
    this.warnings = []
    /** 致命错误：文件坏 / 版本不符。此时 list() 报错、save() 拒绝写（不能毁掉用户文件） */
    this.fatalError = null
  }

  load(logger, now = Date.now()) {
    this.alarms = new Map()
    this.warnings = []
    this.fatalError = null

    const read = readJsonStrict(this.file)
    if (!read.ok) {
      if (read.reason === 'missing') return this // 首次启动：空，不是错误
      this.fatalError = new MiraError('config/corrupt',
        'alarms.json 无法解析（' + read.reason + '）：' + this.file,
        '先备份该文件，修好 JSON 或删掉重建；本插件不会用空表覆盖它（那会把你的闹钟全丢了）')
      logger?.warn?.('[mira_active] ' + this.fatalError.message)
      return this
    }
    const check = checkSchema(read.value, ALARMS_SCHEMA, this.file)
    if (!check.ok) {
      this.fatalError = new MiraError('config/schema',
        'alarms.json 的 schemaVersion 是 ' + JSON.stringify(read.value.schemaVersion) + '，本代码要求 ' + ALARMS_SCHEMA + '：' + this.file,
        '按 README「迁移」一节转换（旧版是每会话一条的 mira_active.json，用 重构插件/migrate/active.mjs）；不会静默兼容')
      logger?.warn?.('[mira_active] ' + this.fatalError.message)
      return this
    }

    const raw = read.value.alarms
    const entries = Array.isArray(raw) ? raw.map((a) => [a?.id, a]) : Object.entries(raw ?? {})
    for (const [key, value] of entries) {
      const alarm = normalizeStored(value ?? { id: key }, this.warnings, now)
      if (alarm) this.alarms.set(alarm.id, alarm)
    }
    for (const warning of this.warnings) logger?.warn?.('[mira_active] ' + warning)

    // 重启与错过（功能点11）：不补触发，只记 missedCount，nextAt 重算到未来
    for (const alarm of this.alarms.values()) {
      if (!alarm.enabled) continue
      // 一次性闹钟在停机期间过点：错过了就是错过了（不补发、也不立刻补响），
      // 记一次错过并停用；条目留着便于复查（这是「保留」而不是「跳过」的那一半）。
      if (alarm.schedule.type === 'once' && !alarm.stats.lastFiredAt
        && alarm.nextAt !== null && alarm.nextAt < now) {
        alarm.stats.missedCount += 1
        alarm.enabled = false
        alarm.nextAt = null
        logger?.info?.('[mira_active] ' + alarm.id + ' 的一次性时刻在停机期间已过，不补发（missedCount='
          + alarm.stats.missedCount + '），条目保留并停用')
        continue
      }
      if (alarm.nextAt !== null && alarm.nextAt < now) {
        alarm.stats.missedCount += 1
        alarm.nextAt = computeNext(alarm, now)
        logger?.info?.('[mira_active] ' + alarm.id + ' 在停机期间错过了 1 次触发，不补发（missedCount=' + alarm.stats.missedCount + '）')
      }
    }
    return this
  }

  hasFatal() {
    return this.fatalError !== null
  }

  /** 落盘。致命错误时不写（保住用户原文件）。 */
  save(logger) {
    if (this.fatalError) {
      logger?.warn?.('[mira_active] 拒绝写盘：alarms.json 处于致命错误状态（' + this.fatalError.code + '），先修好它')
      return false
    }
    const payload = {
      schemaVersion: ALARMS_SCHEMA,
      alarms: Object.fromEntries([...this.alarms.entries()]),
    }
    const ok = writeJsonAtomic(this.file, payload)
    if (!ok) logger?.warn?.('[mira_active] 写盘失败：' + this.file)
    return ok
  }

  list() {
    if (this.fatalError) throw this.fatalError
    return [...this.alarms.values()]
  }

  get(id) {
    const alarm = this.alarms.get(String(id ?? '').trim())
    if (!alarm) {
      throw new MiraError('alarm/not-found', '没有这个闹钟：' + JSON.stringify(id),
        '先 mira_active_list 看有哪些 alarmId')
    }
    return alarm
  }

  has(id) {
    return this.alarms.has(String(id ?? '').trim())
  }

  add(alarm) {
    if (this.alarms.has(alarm.id)) {
      throw new MiraError('alarm/exists', '闹钟 id 已存在：' + alarm.id, '换一个 id')
    }
    this.alarms.set(alarm.id, alarm)
    return alarm
  }

  remove(id) {
    const alarm = this.get(id)
    this.alarms.delete(alarm.id)
    return alarm
  }

  /** 改条目：只允许改配置字段，stats 由运行时维护。 */
  update(id, patch, now = Date.now()) {
    const alarm = this.get(id)
    if (patch.note !== undefined) alarm.note = String(patch.note)
    if (patch.schedule !== undefined) {
      alarm.schedule = validateSchedule(patch.schedule, now)
      alarm.nextAt = alarm.enabled ? computeNext(alarm, now) : null
    }
    if (patch.prompt !== undefined) alarm.prompt = validatePrompt(patch.prompt)
    if (patch.quiet !== undefined) {
      const quietInput = patch.quiet
      alarm.quiet = {
        enabled: quietInput?.enabled !== false,
        ranges: validateRanges(quietInput?.ranges ?? [], 'quiet.ranges'),
      }
    }
    if (patch.limits !== undefined) alarm.limits = validateLimits(patch.limits)
    if (patch.workRanges !== undefined) {
      const ranges = validateRanges(patch.workRanges, 'workRanges')
      if (ranges.length) alarm.workRanges = ranges
      else delete alarm.workRanges
    }
    if (patch.maxPerRange !== undefined) {
      const value = asInt(patch.maxPerRange, 0)
      if (value > 0) alarm.maxPerRange = value
      else delete alarm.maxPerRange
    }
    if (patch.enabled !== undefined) this.setEnabled(alarm.id, patch.enabled, now)
    if (patch.sessionId !== undefined) {
      // 改绑：sessionId 是归属，不是可选装饰 —— 空值必须报错，不能落成「孤儿闹钟」。
      // 放在所有校验之后才落，避免 schedule 非法时留下「内存里已改绑、磁盘上没改」的半截状态。
      const sid = String(patch.sessionId ?? '').trim()
      if (!sid) {
        throw new MiraError('config/missing', 'alarm.sessionId 不能为空',
          '改绑时给新会话的 id；要清空归属请用 mira_active_remove 删掉这条')
      }
      alarm.sessionId = sid
    }
    return alarm
  }

  setEnabled(id, enabled, now = Date.now()) {
    const alarm = this.get(id)
    alarm.enabled = !!enabled
    if (alarm.enabled) {
      if (alarm.nextAt === null || alarm.nextAt < now) alarm.nextAt = computeNext(alarm, now)
      alarm.stats.consecutiveFailures = 0
      alarm.backoffUntil = 0
    } else {
      alarm.nextAt = null
    }
    return alarm
  }

  /** 最早的下一次触发（定时器只盯这一个）。 */
  earliest() {
    let best = null
    for (const alarm of this.alarms.values()) {
      if (!alarm.enabled || alarm.nextAt === null) continue
      if (best === null || alarm.nextAt < best) best = alarm.nextAt
    }
    return best
  }

  /**
   * 跨天重置**每日**计数（maxPerDay 用）。
   * 刻意不在这里清 rangeKey/rangeFired：跨午夜的班次（22:00→01:30）过了 00:00 仍是同一班次，
   * 在这里清零会让 maxPerRange 在午夜失效（README「跨午夜的窗口过了 00:00 也不清零」）。
   * 班次计数由 fire() 按 rangeOccurrenceKey 换班时归零。
   */
  rollDay(alarm, now = Date.now()) {
    const key = dayKey(now)
    if (alarm.stats.dayKey !== key) {
      alarm.stats.dayKey = key
      alarm.stats.dayFired = 0
    }
    return alarm.stats
  }
}

export { newId, ID_RE }
