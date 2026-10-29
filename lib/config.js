/**
 * mira_active / config.js —— 插件配置归一（新结构 + 旧版键映射）
 *
 * 为什么要有这一层：
 *   0.3.0 把「每会话一条 + 全局随机间隔」换成了「一闹钟一条」。**插件配置**（profile 的
 *   cordis patch）里原来那些键（intervalMinMinutes / quietRanges / prompts / maxPerDay /
 *   sameSessionGapMinutes / workRanges / maxPerRange）如果被直接忽略，后果不是报错，而是
 *   **静默行为变化**：静默时段消失、凌晨照响。那比启动失败更糟。
 *
 *   所以这里把它们映射成「新建闹钟时的默认值」，并**把用到的旧键报出来**（warn 一次，
 *   同时在 mira_active_status.warnings 里可见），让人知道该去 profile 里改。
 *   这不是静默兼容：旧键不会伪装成新键继续工作，它就是兜底默认值，且一定会被点名。
 *
 * 新结构（推荐写法）：
 *   config:
 *     enabled: true
 *     defaultSchedule: { type: random, perDay: 6 }   # enable 不带 schedule 时用
 *     defaultPrompt:   { mode: single, text: "…" }
 *     defaultQuiet:    { enabled: true, ranges: [{ from: "02:00", to: "08:00" }] }
 *     defaultLimits:   { maxPerDay: 0, minGapMinutes: 0, failBackoffMinutes: 10, maxFailures: 5 }
 *     defaultWorkRanges: [{ from: "09:00", to: "12:00" }]
 *     defaultMaxPerRange: 0
 */

const MINUTES_PER_DAY = 1440

export const CONFIG_SCHEMA = 2

export const DEFAULTS = {
  enabled: true,
  defaultSchedule: { type: 'random', perDay: 6 },
  defaultPrompt: null,
  defaultQuiet: null,
  defaultLimits: {},
  defaultWorkRanges: null,
  defaultMaxPerRange: 0,
}

/** 旧版键 → 新默认值。返回 null 表示这个键没出现。 */
function legacyDefaults(raw) {
  const used = []
  const out = {}
  const has = (key) => raw[key] !== undefined && raw[key] !== null

  if (has('intervalMinMinutes') || has('intervalMaxMinutes')) {
    const min = Math.max(1, Math.floor(Number(raw.intervalMinMinutes) || 30))
    const max = Math.max(min, Math.floor(Number(raw.intervalMaxMinutes) || 90))
    // 旧：两次激活相隔 [min,max] 分钟 → 新：每天期望次数区间
    const perDayMax = Math.max(1, Math.floor(MINUTES_PER_DAY / min))
    const perDayMin = Math.max(1, Math.min(perDayMax, Math.ceil(MINUTES_PER_DAY / max)))
    out.defaultSchedule = { type: 'random', range: [perDayMin, perDayMax] }
    used.push('intervalMinMinutes/intervalMaxMinutes → defaultSchedule.range [' + perDayMin + ',' + perDayMax + ']')
  }
  if (Array.isArray(raw.quietRanges) && raw.quietRanges.length > 0) {
    out.defaultQuiet = { enabled: true, ranges: raw.quietRanges }
    used.push('quietRanges → defaultQuiet.ranges')
  }
  if (Array.isArray(raw.prompts) && raw.prompts.length > 0) {
    out.defaultPrompt = raw.prompts.length === 1
      ? { mode: 'single', text: String(raw.prompts[0]), order: 'random' }
      : { mode: 'list', texts: raw.prompts.map((t) => String(t)), order: 'random' }
    used.push('prompts → defaultPrompt' + (raw.prompts.length > 1 ? '（list）' : '（single）'))
  }
  const limits = {}
  if (has('maxPerDay')) {
    limits.maxPerDay = Math.max(0, Math.floor(Number(raw.maxPerDay) || 0))
    used.push('maxPerDay → defaultLimits.maxPerDay')
  }
  if (has('sameSessionGapMinutes')) {
    limits.minGapMinutes = Math.max(0, Math.floor(Number(raw.sameSessionGapMinutes) || 0))
    used.push('sameSessionGapMinutes → defaultLimits.minGapMinutes')
  }
  if (Object.keys(limits).length > 0) out.defaultLimits = limits
  if (Array.isArray(raw.workRanges) && raw.workRanges.length > 0) {
    out.defaultWorkRanges = raw.workRanges
    used.push('workRanges → defaultWorkRanges')
  }
  if (has('maxPerRange')) {
    out.defaultMaxPerRange = Math.max(0, Math.floor(Number(raw.maxPerRange) || 0))
    used.push('maxPerRange → defaultMaxPerRange')
  }
  if (has('tickMs')) used.push('tickMs（已无对应物：定时器改成睡到最近 nextAt，该项被忽略）')
  if (has('statePath')) used.push('statePath（旧状态文件路径，已由新目录约定取代，该项被忽略）')
  return { defaults: out, used }
}

/**
 * @returns {{config: object, legacyKeys: string[], warnings: string[]}}
 */
export function normalizeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const config = structuredClone(DEFAULTS)
  const warnings = []

  // 新键优先；旧键只填空缺
  if (raw.enabled !== undefined) config.enabled = raw.enabled !== false
  for (const key of ['defaultSchedule', 'defaultPrompt', 'defaultQuiet', 'defaultLimits', 'defaultWorkRanges']) {
    if (raw[key] !== undefined && raw[key] !== null) config[key] = raw[key]
  }
  if (raw.defaultMaxPerRange !== undefined) config.defaultMaxPerRange = Number(raw.defaultMaxPerRange) || 0

  const legacy = legacyDefaults(raw)
  const legacyKeys = [...legacy.used]
  for (const [key, value] of Object.entries(legacy.defaults)) {
    const alreadySet = raw[key] !== undefined && raw[key] !== null
    if (alreadySet) continue
    config[key] = value
  }

  if (legacyKeys.length > 0) {
    warnings.push('检测到旧版 mira_active 配置键，已按 README「迁移」的换算映射成新默认值；'
      + '请把这些键从 profile 的 cordis patch 里删掉并改用新结构：' + legacyKeys.join('；'))
  }
  if (config.defaultSchedule && config.defaultSchedule.type === undefined) {
    warnings.push('defaultSchedule.type 缺失，已回落到 { type: "random", perDay: 6 }')
    config.defaultSchedule = { type: 'random', perDay: 6 }
  }
  return { config, legacyKeys, warnings }
}

export { legacyDefaults }
