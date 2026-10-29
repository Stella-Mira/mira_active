/**
 * mira_active / schedule.js —— 时间计算：下次触发、静默判定、提示词渲染
 *
 * 四种 schedule.type（任务书功能点4/5/6）：
 *   once      绝对时刻 at（ISO8601）或 afterMinutes（保存时折算成 at）；触发一次后 enabled=false
 *   daily     每天固定时刻 times:["09:00","21:00"]
 *   interval  每 N 分钟 intervalMinutes
 *   random    按天给期望次数 perDay（或区间 range:[min,max]）
 *
 * 静默（功能点3）：命中 → 本次不触发、**不推迟到窗口结束后立刻响**、记 missedCount。
 *   推迟会让人一觉醒来被一串闹钟炸掉，这正是任务书点名的坑。
 *   所以这里只做「这一格该不该响」的判定，不负责「找下一个能响的时刻」。
 *
 * 扩展（任务书 v2 数据模型里没有，r70 已上线，PLAN §3.2 定为条目级可选字段）：
 *   workRanges  正向开工时段：只在窗口内触发；窗口外**不记 missed**，直接预约到下一个窗口开始。
 *   maxPerRange 单个开工时段内的触发上限。
 */

import { randomInt } from 'node:crypto'

export const SCHEDULE_TYPES = ['once', 'daily', 'interval', 'random']
export const PROMPT_MODES = ['single', 'list']
export const PROMPT_ORDERS = ['random', 'seq']

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** "HH:MM" → 当日分钟数；非法返回 -1。 */
export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return -1
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return -1
  return hour * 60 + minute
}

export function fmtMinutes(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m < 0) return ''
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0')
}

/** 本地日期键 YYYY-MM-DD（跨天重置计数用；必须用本地时区，不能用 UTC）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/**
 * ts 是否落在任一区间内。支持跨午夜；days（0=周日…6=周六）省略=每天。
 * 跨午夜时 days 指「窗口开始那天」：凌晨 01:00 属于前一天 22:00 开的窗口。
 */
export function inRanges(ranges, ts = Date.now()) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false
  const d = new Date(ts)
  const day = d.getDay()
  const minutes = d.getHours() * 60 + d.getMinutes()
  for (const range of ranges) {
    if (!range) continue
    const from = parseHHMM(range.from)
    const to = parseHHMM(range.to)
    if (from < 0 || to < 0 || from === to) continue // 非法或零长：忽略（校验时已报过）
    const days = Array.isArray(range.days) && range.days.length ? range.days.map(Number) : null
    if (from < to) {
      if (minutes >= from && minutes < to && (!days || days.includes(day))) return true
    } else {
      // 跨午夜：晚间部分算今天，凌晨部分算昨天开的窗口
      if (minutes >= from && (!days || days.includes(day))) return true
      if (minutes < to && (!days || days.includes((day + 6) % 7))) return true
    }
  }
  return false
}

/** 是否命中静默（功能点3）。quiet 未启用/无区间 = 不静默。 */
export function inQuiet(alarm, ts = Date.now()) {
  const quiet = alarm && alarm.quiet
  if (!quiet || quiet.enabled === false) return false
  return inRanges(quiet.ranges, ts)
}

/** 扩展：workRanges 是否允许此刻触发（未配置 = 不限）。 */
export function inWork(alarm, ts = Date.now()) {
  const ranges = alarm && alarm.workRanges
  if (!Array.isArray(ranges) || ranges.length === 0) return true
  return inRanges(ranges, ts)
}

/** 当前所在开工时段（用于班次上下文与每班次上限），没有就 null。 */
export function currentWorkRange(alarm, ts = Date.now()) {
  const ranges = alarm && alarm.workRanges
  if (!Array.isArray(ranges) || ranges.length === 0) return null
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    if (!inRanges([range], ts)) continue
    const fromMin = parseHHMM(range.from)
    const toMin = parseHHMM(range.to)
    return { ...range, index, fromMin, toMin, crosses: fromMin > toMin }
  }
  return null
}

/**
 * 一次开工时段的身份：`日期#序号#起-止`。
 * 跨午夜的那一段在凌晨那半截里锚回**前一天**的日期 —— 这样 22:00→01:30 整段算同一个班次，
 * 不会因为过了 00:00 就把「本班次已触发几次」清零（r70 的老坑）。
 */
export function rangeOccurrenceKey(range, ts = Date.now()) {
  if (!range) return ''
  const d = new Date(ts)
  if (range.crosses && d.getHours() * 60 + d.getMinutes() < range.toMin) d.setDate(d.getDate() - 1)
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  return key + '#' + range.index + '#' + range.from + '-' + range.to
}

/** 下一个开工时段的开始时刻（窗口外预约用）。 */
export function nextWorkStart(alarm, from = Date.now()) {
  const ranges = alarm && alarm.workRanges
  if (!Array.isArray(ranges) || ranges.length === 0) return from
  const probe = new Date(from)
  for (let i = 0; i < 8; i++) { // 最多探 8 天，区间都非法时不死循环
    const base = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + i, 0, 0, 0, 0)
    for (const range of ranges) {
      const start = parseHHMM(range.from)
      if (start < 0) continue
      const days = Array.isArray(range.days) && range.days.length ? range.days.map(Number) : null
      if (days && !days.includes(base.getDay())) continue
      const at = atToday(base, start)
      if (at > from) return at
    }
  }
  return from
}

/**
 * 本地「ts 所在那天的 HH:MM」→ 毫秒。
 * 必须交给 Date 构造器按本地时区搭：`午夜 + 分钟数*60000` 在夏令时切换日会整体偏 1 小时
 * （例如纽约 2026-03-08 只有 23 小时，09:00 会算成 10:00），这类偏差一天只出现一次，最难发现。
 */
function atToday(ts, minutesOfDay) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(),
    Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0).getTime()
}

/** 本地「ts 的第二天 00:00」→ 毫秒。跨天不能用 +24h：夏令时那天只有 23 或 25 小时。 */
function nextDayStart(ts) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

/**
 * 算下一次触发时刻（毫秒）。返回 null 表示这个条目没有下一次（once 已触发）。
 *
 * @param {object} alarm
 * @param {number} from  从这个时刻之后算（通常是 now 或上次触发时刻）
 * @returns {number|null}
 */
export function computeNext(alarm, from = Date.now()) {
  const schedule = alarm && alarm.schedule
  if (!schedule || !SCHEDULE_TYPES.includes(schedule.type)) return null

  if (schedule.type === 'once') {
    if (alarm.stats && alarm.stats.lastFiredAt) return null
    const at = Date.parse(schedule.at ?? '')
    return Number.isFinite(at) ? at : null
  }

  if (schedule.type === 'daily') {
    const times = (schedule.times ?? []).map(parseHHMM).filter((m) => m >= 0).sort((a, b) => a - b)
    if (times.length === 0) return null
    for (const minutes of times) {
      const candidate = atToday(from, minutes)
      if (candidate > from) return candidate
    }
    // 今天的都过了 → 明天的第一条（按日历翻页，不按 +24h）
    return atToday(nextDayStart(from), times[0])
  }

  if (schedule.type === 'interval') {
    const minutes = Math.max(1, Math.floor(Number(schedule.intervalMinutes) || 0))
    const base = (alarm.stats && alarm.stats.lastFiredAt) || from
    const candidate = base + minutes * MINUTE_MS
    return candidate > from ? candidate : from + minutes * MINUTE_MS
  }

  if (schedule.type === 'random') {
    return from + sampleGapMs(schedule)
  }

  return null
}

/**
 * 随机间隔采样。
 *
 * 口径：perDay（或 range:[min,max]）是**期望次数**，按平均间隔采样，不是「固定 k 次均匀铺开」。
 *   perDay=6 → 平均间隔 4 小时，实际落在 [2.4h, 5.6h]（±40% 抖动）。
 *   单日上限仍由 limits.maxPerDay 兜底（功能点6 原文）。
 * 这样做的理由：均匀铺开会让「每天 6 次」变成机械的每 4 小时一次，失去「随机」的意义。
 */
export function sampleGapMs(schedule, options = {}) {
  const jitter = options.jitter ?? 0.4
  let perDay = Number(schedule.perDay) || 0
  if (Array.isArray(schedule.range) && schedule.range.length === 2) {
    const lo = Math.max(1, Math.min(Number(schedule.range[0]) || 1, Number(schedule.range[1]) || 1))
    const hi = Math.max(lo, Number(schedule.range[1]) || lo)
    perDay = randomInt(lo, hi + 1)
  }
  if (!(perDay > 0)) perDay = 6
  const mean = DAY_MS / perDay
  const lo = Math.max(MINUTE_MS, Math.round(mean * (1 - jitter)))
  const hi = Math.max(lo + MINUTE_MS, Math.round(mean * (1 + jitter)))
  return randomInt(lo, hi + 1)
}

/** 多条同时到期 → 按 nextAt 升序依次投递（功能点8）。 */
export function sortByNextAt(alarms) {
  return alarms.slice().sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
}

/**
 * 渲染提示词（功能点7）。支持 {{time}} {{date}} {{sessionId}} {{alarmId}} {{count}}。
 * 未知的 {{xxx}} 原样保留（不静默吞掉 —— 看到就知道自己写错了）。
 */
export function renderPrompt(alarm, { now = Date.now(), count = null } = {}) {
  const prompt = alarm.prompt ?? { mode: 'single', text: '' }
  let text = ''
  if (prompt.mode === 'list') {
    const texts = (prompt.texts ?? []).filter((t) => typeof t === 'string' && t.trim() !== '')
    if (texts.length === 0) return ''
    if (prompt.order === 'seq') {
      // count 是「第几次触发」（1 起）：第 1 次用 texts[0]，第 2 次用 texts[1] ……
      const ordinal = Math.max(1, Number(count ?? (Number(alarm.stats?.fireCount ?? 0) + 1)))
      text = texts[(ordinal - 1) % texts.length]
    } else {
      text = texts[randomInt(0, texts.length)]
    }
  } else {
    text = String(prompt.text ?? '')
  }
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const fireCount = count === null || count === undefined ? Number(alarm.stats?.fireCount ?? 0) + 1 : count
  const vars = {
    time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    sessionId: String(alarm.sessionId ?? ''),
    alarmId: String(alarm.id ?? ''),
    count: String(fireCount),
  }
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole))
}

/**
 * 扩展：班次上下文头行。只在配了 workRanges 时加，且不超过一行 ——
 * 目的是让模型知道「现在是第几个班次、这个班次第几次被叫」，不是写日记。
 */
export function buildShiftHeader(alarm, { now = Date.now(), rangeFireCount = 0 } = {}) {
  const range = currentWorkRange(alarm, now)
  if (!range) return ''
  const cap = Number(alarm.maxPerRange) || 0
  return '[班次 ' + String(range.from) + '-' + String(range.to)
    + (cap > 0 ? '，本班次第 ' + (rangeFireCount + 1) + '/' + cap + ' 次' : '')
    + ']'
}
