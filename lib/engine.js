/**
 * mira_active / engine.js —— 定时器 + 触发逻辑 + 状态
 *
 * 一块表，按 nextAt 升序处理（功能点8）：到点的条目依次投递；投递只走 steer（功能点9）。
 *
 * 跳过与失败的四种结果，刻意分开计（否则 status 里分不清「用户设了静默」和「会话没了」）：
 *   quiet      命中静默       → 本次不响、不补、missedCount+1（功能点3）
 *   maxPerDay  撞每日上限     → 不响，也不记 miss（这是用户自己设的闸）
 *   minGap     距上次太近     → 顺延到 lastFiredAt+gap
 *   work       不在开工时段   → 预约到下一个窗口开始（扩展字段，窗口外不算错过）
 *   fail       投递失败       → failCount+1、按 failBackoffMinutes 退避；连续到顶自动停用（功能点10）
 *   missed     停机期间错过   → 加载时只记数，不补发（功能点11）
 */

import { makeCounters, nowIso, toError, MiraError } from './kit.mjs'
import { normalizeConfig } from './config.js'
import { AlarmStore, makeAlarm } from './alarms.js'
import {
  buildShiftHeader, computeNext, currentWorkRange, dayKey, inQuiet, inWork, nextWorkStart, rangeOccurrenceKey, renderPrompt, sortByNextAt,
} from './schedule.js'

const TIMER = { minDelayMs: 1000, maxDelayMs: 60_000 }
const MINUTE_MS = 60_000

export class ActiveEngine {
  /**
   * @param {object} options
   * @param {string} options.baseDir     $DSH_HOME/mira_config/mira_active
   * @param {object} [options.config]    { defaultSchedule, timer? }
   * @param {object} [options.logger]
   * @param {import('./deliver.js').Deliverer} options.deliverer
   * @param {()=>number} [options.now]   注入时钟（自检用；生产就是 Date.now）
   */
  constructor({ baseDir, config = {}, logger = null, deliverer, now = () => Date.now() }) {
    this.baseDir = baseDir
    // 配置归一：旧版键映射成「新建闹钟的默认值」，并把用到的旧键记下来（见 config.js 顶部）
    const normalized = normalizeConfig(config)
    this.config = normalized.config
    this.legacyKeys = normalized.legacyKeys
    this.configWarnings = normalized.warnings
    this.logger = logger
    this.deliverer = deliverer
    this.now = now
    this.store = new AlarmStore(baseDir)
    this.counters = makeCounters()
    this.counters.pluginName = 'mira_active'
    this.lastError = null
    this.timer = null
    this.running = false
    this.ticking = false
    this.lastTickAt = 0
    this.timerDelayMs = null
  }

  get defaultSchedule() {
    const configured = this.config.defaultSchedule
    if (configured && typeof configured === 'object' && configured.type) return configured
    // 默认：每天期望 6 次随机激活（约每 4 小时一次，±40% 抖动）
    return { type: 'random', perDay: 6 }
  }

  get defaultPrompt() { return this.config.defaultPrompt ?? undefined }
  get defaultQuiet() { return this.config.defaultQuiet ?? undefined }
  get defaultLimits() { return this.config.defaultLimits ?? undefined }
  get defaultWorkRanges() { return this.config.defaultWorkRanges ?? undefined }
  get defaultMaxPerRange() { return this.config.defaultMaxPerRange ?? undefined }

  load() {
    this.store.load(this.logger, this.now())
    if (this.store.fatalError) this.noteError(this.store.fatalError)
    return this
  }

  /* ── 定时器 ───────────────────────────────────────────── */

  start() {
    this.running = true
    this.scheduleNextTick('start')
    return this
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.timerDelayMs = null
  }

  scheduleNextTick(reason = 'timer') {
    if (!this.running) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = this.now()
    let delay = TIMER.maxDelayMs
    if (!this.store.hasFatal()) {
      const earliest = this.store.earliest()
      if (earliest !== null) delay = Math.max(TIMER.minDelayMs, Math.min(TIMER.maxDelayMs, earliest - now))
    }
    this.timerDelayMs = delay
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick(reason).catch((error) => {
        this.noteError(error)
        this.logger?.warn?.('[mira_active] tick 异常：' + (error && error.message ? error.message : String(error)))
        this.scheduleNextTick('after-error')
      })
    }, delay)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 处理所有到期条目；返回本次处理摘要（自检直接断言这个）。 */
  async tick(reason = 'timer') {
    if (this.ticking) return { skipped: 'busy' }
    if (!this.running) return { skipped: 'stopped' }
    if (this.store.hasFatal()) {
      // 文件坏了：不猜、不重写、不空转 —— 只是等人工修好
      return { skipped: 'fatal', error: toError(this.store.fatalError).error }
    }
    this.ticking = true
    const summary = { reason, fired: [], missed: [], skipped: [], failed: [] }
    try {
      const now = this.now()
      this.lastTickAt = now
      const due = sortByNextAt([...this.store.alarms.values()].filter((alarm) => alarm.enabled
        && alarm.nextAt !== null
        && alarm.nextAt <= now
        && (!alarm.backoffUntil || alarm.backoffUntil <= now)))
      for (const alarm of due) {
        const outcome = await this.handleDue(alarm, now)
        if (outcome.fired) summary.fired.push({ alarmId: alarm.id, sessionId: alarm.sessionId })
        else if (outcome.reason === 'quiet') summary.missed.push({ alarmId: alarm.id, reason: 'quiet' })
        else if (outcome.reason === 'failed') summary.failed.push({ alarmId: alarm.id, error: outcome.error })
        else summary.skipped.push({ alarmId: alarm.id, reason: outcome.reason })
      }
      if (due.length > 0) this.store.save(this.logger)
    } finally {
      this.ticking = false
      this.scheduleNextTick('tick')
    }
    return summary
  }

  /** 一条到期条目的处理（拆出来便于自检直接调用单条）。 */
  async handleDue(alarm, now = this.now()) {
    const stats = this.store.rollDay(alarm, now)

    // 1. 静默：本次不响、不补，只记数（功能点3）
    if (inQuiet(alarm, now)) {
      stats.missedCount += 1
      this.counters.bump('fire.missed.quiet')
      if (alarm.schedule.type === 'once') {
        // 一次性闹钟错过了就是错过了：不推迟到静默结束后补响
        alarm.enabled = false
        alarm.nextAt = null
      } else {
        alarm.nextAt = this.#advance(alarm, now)
      }
      this.logger?.info?.('[mira_active] ' + alarm.id + ' 命中静默时段，本次不触发（累计错过 ' + stats.missedCount + ' 次）')
      return { fired: false, reason: 'quiet', missedCount: stats.missedCount }
    }

    // 2. 扩展：不在开工时段 → 预约到下一个窗口开始，不算错过
    const range = currentWorkRange(alarm, now)
    if (!inWork(alarm, now)) {
      alarm.nextAt = nextWorkStart(alarm, now)
      this.counters.bump('fire.skipped.work')
      return { fired: false, reason: 'work' }
    }

    // 2.5 扩展：单个开工时段的上限（到顶就等下一个班次）
    const rangeCap = Number(alarm.maxPerRange) || 0
    if (rangeCap > 0 && range) {
      const key = rangeOccurrenceKey(range, now)
      if (stats.rangeKey === key && stats.rangeFired >= rangeCap) {
        alarm.nextAt = nextWorkStart(alarm, now)
        this.counters.bump('fire.skipped.maxPerRange')
        return { fired: false, reason: 'maxPerRange' }
      }
    }

    // 3. 每日上限
    if (alarm.limits.maxPerDay > 0 && stats.dayFired >= alarm.limits.maxPerDay) {
      alarm.nextAt = this.#advance(alarm, now)
      this.counters.bump('fire.skipped.maxPerDay')
      return { fired: false, reason: 'maxPerDay' }
    }

    // 4. 最小间隔
    const minGapMs = Math.max(0, Number(alarm.limits.minGapMinutes) || 0) * MINUTE_MS
    const lastFiredMs = alarm.stats.lastFiredAt ? Date.parse(alarm.stats.lastFiredAt) : 0
    if (minGapMs > 0 && lastFiredMs && now - lastFiredMs < minGapMs) {
      alarm.nextAt = lastFiredMs + minGapMs
      this.counters.bump('fire.skipped.minGap')
      return { fired: false, reason: 'minGap' }
    }

    return this.fire(alarm, { now, manual: false })
  }

  /** 真正投递。manual=true 只跳过时间判断（静默仍然生效，见 fireNow）。 */
  async fire(alarm, { now = this.now(), manual = false } = {}) {
    const stats = this.store.rollDay(alarm, now)
    const count = stats.fireCount + 1
    const range = currentWorkRange(alarm, now)
    if (range) {
      // 班次身份带日期：跨午夜的 22:00→01:30 算同一个班次，过了 00:00 不清零
      const key = rangeOccurrenceKey(range, now)
      if (stats.rangeKey !== key) {
        stats.rangeKey = key
        stats.rangeFired = 0
      }
    }
    const header = buildShiftHeader(alarm, { now, rangeFireCount: stats.rangeFired })
    const body = renderPrompt(alarm, { now, count })
    const text = header ? header + '\n' + body : body

    try {
      await this.deliverer.steer(alarm.sessionId, text, { alarmId: alarm.id })
    } catch (error) {
      const normalized = toError(error, 'delivery/failed', '会话可能已被删除；检查 mira_active_list 里的 sessionId')
      stats.failCount += 1
      stats.consecutiveFailures += 1
      const backoffMs = Math.max(1, Number(alarm.limits.failBackoffMinutes) || 10) * MINUTE_MS
      alarm.backoffUntil = now + backoffMs
      alarm.nextAt = alarm.backoffUntil
      this.counters.bump('fire.fail')
      this.noteError(normalized.error)
      if (stats.consecutiveFailures >= alarm.limits.maxFailures) {
        alarm.enabled = false
        alarm.nextAt = null
        this.logger?.warn?.('[mira_active] ' + alarm.id + ' 连续失败 ' + stats.consecutiveFailures
          + ' 次（上限 ' + alarm.limits.maxFailures + '），已自动停用。最后一次错误：'
          + normalized.error.code + ' ' + normalized.error.message)
      } else {
        this.logger?.warn?.('[mira_active] ' + alarm.id + ' 投递失败（第 ' + stats.consecutiveFailures + ' 次），'
          + '退避 ' + alarm.limits.failBackoffMinutes + ' 分钟：' + normalized.error.code + ' ' + normalized.error.message)
      }
      return { fired: false, reason: 'failed', error: normalized.error }
    }

    // 成功
    stats.fireCount = count
    stats.lastFiredAt = nowIso(now)
    stats.dayFired += 1
    if (range) stats.rangeFired += 1
    stats.consecutiveFailures = 0
    alarm.backoffUntil = 0
    if (alarm.schedule.type === 'once') {
      alarm.enabled = false
      alarm.nextAt = null
    } else {
      alarm.nextAt = this.#advance(alarm, now)
    }
    this.counters.bump('fire.ok')
    this.logger?.info?.('[mira_active] 已插话投递 ' + alarm.id + ' → ' + alarm.sessionId
      + '（第 ' + count + ' 次，下次 ' + (alarm.nextAt ? new Date(alarm.nextAt).toISOString() : '不再') + '）')
    return { fired: true, text, fireCount: count }
  }

  /** 立刻触发一次（不改 schedule，不重排下一次）。静默仍然生效（PLAN B8）。 */
  async fireNow(alarmId) {
    const alarm = this.store.get(alarmId)
    const now = this.now()
    if (inQuiet(alarm, now)) {
      alarm.stats.missedCount += 1
      this.counters.bump('fire.missed.quiet')
      this.store.save(this.logger)
      this.scheduleNextTick('fire-now-quiet')
      return { ok: true, fired: false, reason: 'quiet', alarmId: alarm.id, missedCount: alarm.stats.missedCount }
    }
    const outcome = await this.fire(alarm, { now, manual: true })
    this.store.save(this.logger)
    this.scheduleNextTick('fire-now')
    if (!outcome.fired) return { ok: false, error: outcome.error, alarmId: alarm.id }
    return { ok: true, fired: true, alarmId: alarm.id, fireCount: outcome.fireCount, text: outcome.text }
  }

  /** 下一次触发的计算；once 已过时给一个兜底延迟，避免「过去时刻」把定时器打空转。 */
  #advance(alarm, now) {
    const next = computeNext(alarm, now)
    if (next === null) return null
    return next > now ? next : now + MINUTE_MS
  }

  /* ── 管理（工具层直接调用） ───────────────────────────── */

  /**
   * 启用：给了 alarmId 就精确启用；否则「按当前会话」——
   * 复用该会话已有的 default 条目，没有就建一条（PLAN §3.1 的口径）。
   *
   * 带 alarmId 时若**显式**传入不同的 sessionId，则把该条闹钟改绑到新会话：
   * 只换归属，stats（累计次数/失败/错过）与 nextAt 原样保留 —— 会话重启/换绑后
   * 闹钟可以跟着迁移，不用删旧建新（旧行为是静默忽略 sessionId）。
   */
  enable({ sessionId, alarmId, note, schedule, prompt, quiet, limits, workRanges, maxPerRange, create = false } = {}) {
    const now = this.now()
    if (alarmId) {
      const existing = this.store.get(alarmId)
      const wanted = String(sessionId ?? '').trim()
      const reboundFrom = wanted && wanted !== existing.sessionId ? existing.sessionId : null
      const alarm = this.store.update(alarmId, {
        // 改绑：显式给了不同的 sessionId 才动；只换归属，不碰 stats / nextAt
        ...(reboundFrom ? { sessionId: wanted } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(quiet !== undefined ? { quiet } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...(workRanges !== undefined ? { workRanges } : {}),
        ...(maxPerRange !== undefined ? { maxPerRange } : {}),
        enabled: true,
      }, now)
      this.store.save(this.logger)
      this.scheduleNextTick('enable')
      if (reboundFrom) {
        this.logger?.info?.('[mira_active] 闹钟 ' + alarm.id + ' 已改绑会话：' + reboundFrom + ' → ' + wanted
          + '（保留统计与下次触发时刻）')
      }
      this.logger?.info?.('[mira_active] 闹钟已启用：' + alarm.id)
      return { action: 'enabled', alarm, ...(reboundFrom ? { rebound: { from: reboundFrom, to: wanted } } : {}) }
    }

    const sid = String(sessionId ?? '').trim()
    if (!sid) {
      throw new MiraError('config/missing', 'sessionId 必填',
        '在会话里调用工具会自动用当前会话；不在会话里调用就必须显式给 sessionId（不猜）')
    }
    const mine = [...this.store.alarms.values()].filter((a) => a.sessionId === sid)
    // create:true 表示「我就要再来一条」，跳过复用（同会话可以有多条闹钟）
    const reusable = create ? null : (mine.find((a) => a.note === 'default') ?? (mine.length === 1 ? mine[0] : null))
    if (reusable) {
      this.store.update(reusable.id, {
        ...(note !== undefined ? { note } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(quiet !== undefined ? { quiet } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...(workRanges !== undefined ? { workRanges } : {}),
        ...(maxPerRange !== undefined ? { maxPerRange } : {}),
        enabled: true,
      }, now)
      this.store.save(this.logger)
      this.scheduleNextTick('enable-reuse')
      return { action: 'reuse', alarm: reusable }
    }

    const alarm = makeAlarm({
      sessionId: sid,
      note: note ?? 'default',
      schedule: schedule ?? this.defaultSchedule,
      prompt: prompt ?? this.defaultPrompt,
      quiet: quiet ?? this.defaultQuiet,
      limits: limits ?? this.defaultLimits,
      workRanges: workRanges ?? this.defaultWorkRanges,
      maxPerRange: maxPerRange ?? this.defaultMaxPerRange,
    }, now)
    this.store.add(alarm)
    this.store.save(this.logger)
    this.scheduleNextTick('enable-create')
    this.logger?.info?.('[mira_active] 已为会话 ' + sid + ' 新建闹钟 ' + alarm.id)
    return { action: 'created', alarm }
  }

  /** 停用：给了 alarmId 只关它；否则关掉该会话**全部**闹钟并列出关掉了哪些（PLAN §3.1）。 */
  disable({ sessionId, alarmId } = {}) {
    const now = this.now()
    if (alarmId) {
      const alarm = this.store.setEnabled(alarmId, false, now)
      this.store.save(this.logger)
      this.scheduleNextTick('disable')
      this.logger?.info?.('[mira_active] 闹钟已停用：' + alarm.id)
      return { action: 'disabled', disabled: [alarm.id] }
    }
    const sid = String(sessionId ?? '').trim()
    if (!sid) {
      throw new MiraError('config/missing', 'sessionId 必填',
        '在会话里调用工具会自动用当前会话；不在会话里调用就必须显式给 sessionId（不猜）')
    }
    const mine = [...this.store.alarms.values()].filter((a) => a.sessionId === sid)
    const disabled = []
    for (const alarm of mine) {
      if (!alarm.enabled) continue
      this.store.setEnabled(alarm.id, false, now)
      disabled.push(alarm.id)
    }
    if (disabled.length > 0) this.store.save(this.logger)
    this.scheduleNextTick('disable-session')
    if (disabled.length > 0) this.logger?.info?.('[mira_active] 会话 ' + sid + ' 的 ' + disabled.length + ' 条闹钟已停用')
    return { action: 'disabled', disabled, total: mine.length }
  }

  pause(alarmId, paused) {
    const alarm = this.store.setEnabled(alarmId, !paused, this.now())
    this.store.save(this.logger)
    this.scheduleNextTick('pause')
    return { alarm, paused: !!paused }
  }

  remove(alarmId) {
    const alarm = this.store.remove(alarmId)
    this.store.save(this.logger)
    this.scheduleNextTick('remove')
    return alarm
  }

  /* ── 观测 ─────────────────────────────────────────────── */

  noteError(error) {
    const normalized = toError(error, 'unknown/error')
    this.lastError = {
      code: normalized.error.code,
      message: String(normalized.error.message ?? '').slice(0, 300),
      at: nowIso(this.now()),
    }
    this.counters.bump('error.' + this.lastError.code)
    return this.lastError
  }

  view(alarm, now = this.now()) {
    const schedule = alarm.schedule
    return {
      id: alarm.id,
      sessionId: alarm.sessionId,
      enabled: alarm.enabled,
      note: alarm.note || undefined,
      schedule,
      prompt: alarm.prompt.mode === 'list'
        ? { mode: 'list', count: alarm.prompt.texts.length, order: alarm.prompt.order }
        : { mode: 'single', text: alarm.prompt.text },
      quiet: alarm.quiet,
      workRanges: alarm.workRanges,
      maxPerRange: alarm.maxPerRange,
      delivery: 'steer',
      limits: alarm.limits,
      nextAt: alarm.nextAt ? new Date(alarm.nextAt).toISOString() : null,
      nextInMinutes: alarm.nextAt ? Math.max(0, Math.round((alarm.nextAt - now) / MINUTE_MS)) : null,
      backoffUntil: alarm.backoffUntil ? new Date(alarm.backoffUntil).toISOString() : null,
      stats: alarm.stats,
    }
  }

  list(sessionId) {
    const sid = String(sessionId ?? '').trim()
    const rows = this.store.list().filter((a) => !sid || a.sessionId === sid)
    const now = this.now()
    return sortByNextAt(rows).map((alarm) => this.view(alarm, now))
  }

  status() {
    const fatal = this.store.fatalError
    const alarms = fatal ? [] : [...this.store.alarms.values()]
    const now = this.now()
    const enabled = alarms.filter((a) => a.enabled)
    const earliest = fatal ? null : this.store.earliest()
    return {
      ok: true,
      schemaVersion: 2,
      baseDir: this.baseDir,
      file: this.store.file,
      count: alarms.length,
      enabledCount: enabled.length,
      sessionCount: new Set(alarms.map((a) => a.sessionId)).size,
      nextAt: earliest ? new Date(earliest).toISOString() : null,
      nextInSeconds: earliest ? Math.max(0, Math.round((earliest - now) / 1000)) : null,
      timerRunning: this.running,
      timerDelayMs: this.timerDelayMs,
      ticking: this.ticking,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      lastError: this.lastError,
      counters: this.counters.snapshot(),
      warnings: [...this.configWarnings, ...this.store.warnings],
      legacyConfigKeys: this.legacyKeys,
      fatalError: fatal ? toError(fatal).error : null,
      alarms: alarms.map((alarm) => this.view(alarm, now)),
    }
  }

  dispose() {
    this.stop()
    if (!this.store.hasFatal()) {
      try { this.store.save(this.logger) } catch { /* 退场不抛 */ }
    }
  }
}

export { dayKey }
