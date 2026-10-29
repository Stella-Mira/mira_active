/**
 * mira_active 自检：node test/smoke.mjs
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项断言）====`；失败逐行 `[FAIL] 编号 说明`，退出码 1。
 *
 * 覆盖 重构插件/PLAN.md §1.2 的 B2–B17：
 *   B2  空目录 → list 是 [] 而不是错误
 *   B3  enable 用当前会话建条目
 *   B4  既没当前会话也没参数 → config/missing（不猜）
 *   B5  同会话再 enable → 复用同一条，条数不变
 *   B6  list 字段齐全（含 nextAt ISO 与 stats）
 *   B7  fire_now → steer 1 次、fireCount+1、schedule 与 nextAt 不变
 *   B8  静默命中 fire_now → fired:false / missedCount+1 / 不 steer
 *   B9  静默**不推迟**：直接跳到下一个正常时刻（不等于窗口结束）
 *   B10 once 触发后 enabled=false 且条目仍在
 *   B11 daily 多时刻 → 取最近；跨天重算
 *   B12 会话忙也 steer（插话），从不走 followup
 *   B13 steer 连抛 → failCount 递增 + 退避；到 maxFailures 自动停用 + warn
 *   B14 重启不补触发，只记 missedCount，nextAt 重算到未来
 *   B15 变量渲染（五个内置变量替换，未知原样保留）
 *   B16 单实例：第二次 apply 被拒且不注册工具
 *   B17 schemaVersion≠2 → 拒绝该文件，且拒绝写盘（保住原文件）
 * 另加：跨午夜时段、maxPerDay、workRanges、pause/resume、disable 全关并列出、
 *       带 alarmId 改绑 sessionId（B27）、当前会话优先 agent.session.id（B28）。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) { passed++; return true }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  return check(JSON.stringify(actual) === JSON.stringify(expected),
    message + '（期望 ' + JSON.stringify(expected) + '，实得 ' + JSON.stringify(actual) + '）')
}

async function test(id, name, fn) {
  current = id + ' ' + name
  try { await fn() } catch (error) {
    failures.push('[' + current + '] 抛异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error)))
  }
}

/* ── 隔离环境 ───────────────────────────────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'mira-active-smoke-'))
process.env.DSH_HOME = TMP
let caseSeq = 0
/** 每个用例一个独立目录，避免用例之间互相看到对方的闹钟。 */
function freshDir() {
  caseSeq += 1
  const dir = join(TMP, 'case-' + caseSeq, 'mira_config', 'mira_active')
  mkdirSync(dir, { recursive: true })
  return dir
}
const logLines = []
const logger = {
  info: (m) => logLines.push('I ' + m),
  warn: (m) => logLines.push('W ' + m),
  error: (m) => logLines.push('E ' + m),
  debug: () => {},
}

const { ActiveEngine } = await import('../lib/engine.js')
const { makeUserMessage } = await import('../lib/deliver.js')
const { computeNext, inRanges, renderPrompt } = await import('../lib/schedule.js')
const { registerTools } = await import('../lib/tools.js')
const { apply } = await import('../lib/index.js')

/** 假投递器：记录每次 steer，可按脚本抛错。 */
function makeDeliverer() {
  const record = { steers: [], failNext: 0, error: null, followups: 0 }
  return {
    record,
    async steer(sessionId, text) {
      if (record.failNext > 0) {
        record.failNext -= 1
        throw Object.assign(new Error(record.error ?? '会话不存在'), { code: 'delivery/failed' })
      }
      record.steers.push({ sessionId, text })
      return { id: sessionId }
    },
  }
}

const clock = { now: new Date(2026, 9, 27, 8, 0, 0).getTime() }

function makeEngine(config = {}, deliverer = makeDeliverer(), baseDir = null) {
  const engine = new ActiveEngine({ baseDir: baseDir ?? freshDir(), config, logger, deliverer, now: () => clock.now })
  engine.load()
  engine.running = true // 不开真定时器；测试里手动 tick，时间由 clock 控制
  return { engine, deliverer }
}

/** 假 ctx（B16 用真正的 apply）。 */
function makeCtx() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger,
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    effect(fn) { const d = fn(); disposers.push(d); return () => {} },
    sessionController: {
      async resolveAgent(sessionId) {
        return {
          agent: {
            id: sessionId,
            session: { id: sessionId },
            status: 'running',
            steers: [],
            steer(message) { this.steers.push(message) },
            followup() { throw new Error('不允许走 followup') },
          },
        }
      },
    },
    sessions: { async flush() {} },
    dispose() { for (const d of disposers.reverse()) { try { if (typeof d === 'function') d() } catch { /* noop */ } } },
    toolsMap: tools,
  }
  return ctx
}

/* ── B2 空目录 ──────────────────────────────────────────── */

await test('B2', '空目录：list 是空数组，不是错误', async () => {
  const { engine } = makeEngine()
  eq(engine.list().length, 0, 'list 应为空')
  const status = engine.status()
  eq(status.count, 0, 'status.count 应为 0')
  eq(status.fatalError, null, '不应有致命错误')
  eq(status.schemaVersion, 2, 'schemaVersion 应为 2')
  engine.dispose()
})

/* ── B3 / B4 / B5 enable 语义 ───────────────────────────── */

await test('B3', 'enable 用传入的当前会话建条目', async () => {
  const { engine } = makeEngine()
  const result = engine.enable({ sessionId: 'S1', note: 'default' })
  eq(result.action, 'created', '第一次应创建')
  eq(result.alarm.sessionId, 'S1', 'sessionId 应是当前会话')
  eq(result.alarm.schedule.type, 'random', '默认定时方式应是 random')
  eq(result.alarm.delivery, 'steer', '投递方式必须是 steer')
  check(engine.store.alarms.size === 1, '应有一条')
  engine.dispose()
})

await test('B4', '既没当前会话也没参数 → config/missing（不猜）', async () => {
  const { engine } = makeEngine()
  let err = null
  try { engine.enable({}) } catch (e) { err = e }
  eq(err && err.code, 'config/missing', '应报 config/missing')
  check(String(err.hint).includes('sessionId'), 'hint 要指出缺 sessionId：' + err.hint)
  engine.dispose()
})

await test('B5', '同会话再 enable → 复用同一条，条数不变', async () => {
  const { engine } = makeEngine()
  eq(engine.enable({ sessionId: 'S2' }).action, 'created', '第一次创建')
  const before = engine.store.alarms.size
  const again = engine.enable({ sessionId: 'S2' })
  eq(again.action, 'reuse', '第二次应复用')
  eq(engine.store.alarms.size, before, '条数不应增加')
  engine.dispose()
})

/* ── B6 list 字段 ───────────────────────────────────────── */

await test('B6', 'list 含 id/sessionId/enabled/schedule/nextAt(ISO)/stats', async () => {
  const { engine } = makeEngine()
  engine.enable({ sessionId: 'S6', schedule: { type: 'daily', times: ['09:00'] } })
  const view = engine.list()[0]
  for (const key of ['id', 'sessionId', 'enabled', 'schedule', 'nextAt', 'stats']) {
    check(view[key] !== undefined, 'list 条目缺少 ' + key)
  }
  check(typeof view.nextAt === 'string' && view.nextAt.includes('T'), 'nextAt 应是 ISO 字符串：' + view.nextAt)
  eq(view.stats.fireCount, 0, 'fireCount 应从 0 开始')
  check(['fireCount', 'failCount', 'missedCount', 'createdAt'].every((k) => view.stats[k] !== undefined), 'stats 字段要齐')
  engine.dispose()
})

/* ── B7 fire_now ────────────────────────────────────────── */

await test('B7', 'fire_now：steer 1 条、fireCount+1、schedule 与 nextAt 不变', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({ sessionId: 'S7', schedule: { type: 'interval', intervalMinutes: 60 } })
  const id = created.alarm.id
  const scheduleBefore = JSON.stringify(engine.store.get(id).schedule)
  const nextBefore = engine.store.get(id).nextAt
  const result = await engine.fireNow(id)
  eq(result.ok, true, 'fire_now 应成功')
  eq(result.fired, true, '应真的触发')
  eq(deliverer.record.steers.length, 1, '应 steer 1 次')
  eq(engine.store.get(id).stats.fireCount, 1, 'fireCount 应 +1')
  eq(JSON.stringify(engine.store.get(id).schedule), scheduleBefore, 'schedule 不应被改')
  eq(engine.store.get(id).nextAt, nextBefore, 'fire_now 不应改下次触发时刻')
  check(engine.store.get(id).stats.lastFiredAt !== null, 'lastFiredAt 应更新')
  engine.dispose()
})

await test('B12', '会话忙也 steer（插话），从不走 followup', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({ sessionId: 'S-busy', schedule: { type: 'interval', intervalMinutes: 60 } })
  await engine.fireNow(created.alarm.id)
  eq(deliverer.record.steers.length, 1, '忙会话也应收到 steer')
  eq(deliverer.record.steers[0].sessionId, 'S-busy', '投给正确的会话')
  check(deliverer.record.steers[0].text.length > 0, '投递内容不应为空')
  eq(deliverer.record.followups, 0, '绝不允许 followup（那是排队）')
  const message = makeUserMessage('x', { sessionId: 's', alarmId: 'a' })
  eq(message.role, 'user', '必须是用户消息')
  eq(message.source.kind, 'mira_active', '必须带 source.kind（否则宿主投影会崩）')
  engine.dispose()
})

/* ── B8 / B9 静默 ───────────────────────────────────────── */

await test('B8', '静默命中：fire_now → fired:false / missedCount+1 / 不 steer', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({
    sessionId: 'S8',
    schedule: { type: 'interval', intervalMinutes: 60 },
    quiet: { ranges: [{ from: '07:00', to: '09:00' }] }, // 现在是 08:00
  })
  const result = await engine.fireNow(created.alarm.id)
  eq(result.ok, true, '调用本身应成功')
  eq(result.fired, false, '静默时不应触发')
  eq(result.reason, 'quiet', '原因应是 quiet')
  eq(engine.store.get(created.alarm.id).stats.missedCount, 1, 'missedCount 应 +1')
  eq(deliverer.record.steers.length, 0, '不应 steer')
  engine.dispose()
})

await test('B9', '静默不推迟：跳到下一个正常时刻（不是窗口结束）', async () => {
  const { engine } = makeEngine()
  const created = engine.enable({
    sessionId: 'S9',
    schedule: { type: 'daily', times: ['08:30'] },
    quiet: { ranges: [{ from: '08:00', to: '09:00' }] },
  })
  const alarm = engine.store.get(created.alarm.id)
  alarm.nextAt = clock.now
  const summary = await engine.tick('test')
  eq(summary.missed.length, 1, '应记一次错过')
  const after = engine.store.get(alarm.id)
  eq(after.stats.missedCount, 1, 'missedCount 应为 1')
  const nextDate = new Date(after.nextAt)
  eq([nextDate.getDate(), nextDate.getHours(), nextDate.getMinutes()], [27, 8, 30], '应落到下一个排定时刻 08:30')
  check(!(nextDate.getHours() === 9 && nextDate.getMinutes() === 0), '绝不允许「推迟到静默窗口结束立刻响」（09:00）')
  engine.dispose()
})

/* ── B10 once ───────────────────────────────────────────── */

await test('B10', 'once 触发后 enabled=false，条目仍在，fireCount=1', async () => {
  const { engine, deliverer } = makeEngine()
  const at = new Date(clock.now + 30 * 60_000).toISOString()
  const created = engine.enable({ sessionId: 'S10', schedule: { type: 'once', at } })
  const id = created.alarm.id
  engine.store.get(id).nextAt = clock.now
  await engine.tick('test')
  const after = engine.store.get(id)
  eq(after.enabled, false, '应自动停用')
  eq(after.stats.fireCount, 1, 'fireCount 应为 1')
  eq(after.nextAt, null, '不应再有下次')
  eq(deliverer.record.steers.length, 1, '应真的投递了')
  check(engine.list().some((a) => a.id === id), '条目应保留（便于复查）')
  engine.dispose()
})

await test('B10b', 'once 拒绝过去时刻（不猜着立刻触发）', async () => {
  const { engine } = makeEngine()
  let err = null
  try {
    engine.enable({ sessionId: 'S10b', schedule: { type: 'once', at: new Date(clock.now - 3600_000).toISOString() } })
  } catch (e) { err = e }
  eq(err && err.code, 'config/invalid', '应报 config/invalid')
  check(String(err.message).includes('过去'), 'message 要说清楚是过去时刻：' + err.message)
  engine.dispose()
})

/* ── B11 daily ──────────────────────────────────────────── */

await test('B11', 'daily 多时刻取最近，跨天重算', async () => {
  const probe = (hour, minute) => {
    const at = new Date(2026, 9, 27, hour, minute, 0).getTime()
    const next = computeNext({ schedule: { type: 'daily', times: ['09:00', '21:00'] }, stats: { lastFiredAt: null } }, at)
    return new Date(next)
  }
  let next = probe(8, 0)
  eq([next.getDate(), next.getHours(), next.getMinutes()], [27, 9, 0], '08:00 时下一次是今天 09:00')
  next = probe(10, 0)
  eq([next.getDate(), next.getHours(), next.getMinutes()], [27, 21, 0], '10:00 时下一次是今天 21:00')
  next = probe(22, 0)
  eq([next.getDate(), next.getHours(), next.getMinutes()], [28, 9, 0], '22:00 时下一次是明天 09:00')
})

/* ── B13 失败退避 ───────────────────────────────────────── */

await test('B13', 'steer 连抛：failCount 递增 + 退避；到 maxFailures 自动停用并 warn', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({
    sessionId: 'S13',
    schedule: { type: 'interval', intervalMinutes: 60 },
    limits: { failBackoffMinutes: 5, maxFailures: 2 },
  })
  const id = created.alarm.id
  deliverer.record.failNext = 5
  deliverer.record.error = '会话不存在'

  const first = await engine.fireNow(id)
  eq(first.ok, false, '投递失败应返回 ok:false')
  eq(engine.store.get(id).stats.failCount, 1, 'failCount 应为 1')
  eq(engine.store.get(id).enabled, true, '还没到上限，仍启用')
  check(engine.store.get(id).backoffUntil > clock.now, '应设置退避时刻')
  eq(engine.store.get(id).nextAt, engine.store.get(id).backoffUntil, '下次触发应推到退避之后')

  const second = await engine.fireNow(id)
  eq(second.ok, false, '第二次也应失败')
  eq(engine.store.get(id).stats.failCount, 2, 'failCount 应为 2')
  eq(engine.store.get(id).enabled, false, '连续失败到 maxFailures 应自动停用')
  check(logLines.some((l) => l.includes('已自动停用')), '应写一条 warn')
  engine.dispose()
})

/* ── B14 重启与错过 ─────────────────────────────────────── */

await test('B14', '重启不补触发：只记 missedCount，nextAt 重算到未来', async () => {
  const dir = freshDir()
  {
    const { engine } = makeEngine({}, makeDeliverer(), dir)
    engine.enable({ sessionId: 'S14', schedule: { type: 'interval', intervalMinutes: 60 } })
    engine.dispose()
  }
  const file = join(dir, 'alarms.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const id = Object.keys(raw.alarms).find((key) => raw.alarms[key].sessionId === 'S14')
  raw.alarms[id].nextAt = clock.now - 3600_000 // 停在过去（模拟停机）
  writeFileSync(file, JSON.stringify(raw, null, 2))

  const { engine } = makeEngine({}, makeDeliverer(), dir)
  const alarm = engine.store.get(id)
  eq(alarm.stats.missedCount, 1, '停机期间错过应记 1 次')
  check(alarm.nextAt > clock.now, 'nextAt 应重算到未来')
  eq(alarm.stats.fireCount, 0, '不补触发：fireCount 仍为 0')
  engine.dispose()
})

/* ── B15 变量渲染 ───────────────────────────────────────── */

await test('B15', '变量渲染：五个内置变量全替换，未知原样保留', async () => {
  const alarm = {
    id: 'a-test', sessionId: 'S15',
    prompt: { mode: 'single', text: '{{date}} {{time}} {{sessionId}} {{alarmId}} {{count}} {{unknown}}' },
    stats: { fireCount: 2 },
  }
  const text = renderPrompt(alarm, { now: new Date(2026, 9, 27, 8, 5, 0).getTime(), count: 3 })
  eq(text, '2026-10-27 08:05 S15 a-test 3 {{unknown}}', '渲染结果不对：' + text)
  const listAlarm = {
    id: 'a2', sessionId: 'S', prompt: { mode: 'list', texts: ['A{{count}}', 'B{{count}}'], order: 'seq' },
    stats: { fireCount: 1 },
  }
  eq(renderPrompt(listAlarm, { count: 2 }), 'B2', 'seq 顺序应按 count 取模')
})

/* ── 跨午夜 / maxPerDay / workRanges ───────────────────── */

await test('B18', '跨午夜区间：含 days 时按「窗口开始那天」判定', async () => {
  const range = [{ from: '22:00', to: '02:00' }]
  check(inRanges(range, new Date(2026, 9, 27, 23, 0).getTime()), '23:00 在 22:00–02:00 内')
  check(inRanges(range, new Date(2026, 9, 28, 1, 0).getTime()), '01:00 也在（属于前一天开的窗口）')
  check(!inRanges(range, new Date(2026, 9, 28, 3, 0).getTime()), '03:00 不在')
  // 2026-10-26 是周一
  const mondayOnly = [{ from: '22:00', to: '02:00', days: [1] }]
  check(inRanges(mondayOnly, new Date(2026, 9, 26, 23, 0).getTime()), '周一 23:00 应命中')
  check(inRanges(mondayOnly, new Date(2026, 9, 27, 1, 0).getTime()), '周二 01:00 仍算周一那段')
  check(!inRanges(mondayOnly, new Date(2026, 9, 27, 23, 0).getTime()), '周二 23:00 不应命中')
})

await test('B19', 'maxPerDay 到顶：不触发、不记错过、顺延', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({
    sessionId: 'S19',
    schedule: { type: 'interval', intervalMinutes: 10 },
    limits: { maxPerDay: 1 },
  })
  const id = created.alarm.id
  engine.store.get(id).nextAt = clock.now
  await engine.tick('test')
  eq(engine.store.get(id).stats.fireCount, 1, '第一次应触发')
  engine.store.get(id).nextAt = clock.now
  const before = deliverer.record.steers.length
  await engine.tick('test')
  eq(deliverer.record.steers.length, before, '到上限后不应再触发')
  eq(engine.store.get(id).stats.fireCount, 1, 'fireCount 不应变')
  eq(engine.store.get(id).stats.missedCount, 0, '上限跳过不算错过')
  engine.dispose()
})

await test('B20', 'workRanges：窗口外不触发也不记错过，窗口内照常', async () => {
  const { engine, deliverer } = makeEngine()
  const created = engine.enable({
    sessionId: 'S20',
    schedule: { type: 'interval', intervalMinutes: 10 },
    workRanges: [{ from: '09:00', to: '12:00' }],
  })
  const id = created.alarm.id
  const before = deliverer.record.steers.length
  engine.store.get(id).nextAt = clock.now // 08:00，窗口外
  await engine.tick('test')
  eq(deliverer.record.steers.length, before, '窗口外不应触发')
  eq(engine.store.get(id).stats.missedCount, 0, '窗口外不算错过')
  eq(new Date(engine.store.get(id).nextAt).getHours(), 9, '应预约到 09:00')
  clock.now = new Date(2026, 9, 27, 9, 30, 0).getTime()
  engine.store.get(id).nextAt = clock.now
  await engine.tick('test')
  eq(deliverer.record.steers.length, before + 1, '窗口内应触发')
  clock.now = new Date(2026, 9, 27, 8, 0, 0).getTime()
  engine.dispose()
})

/* ── pause / disable 语义 ──────────────────────────────── */

await test('B21', 'pause / resume；disable 无 alarmId 关掉会话全部并列出 id', async () => {
  const { engine } = makeEngine()
  const sid = 'S21'
  const first = engine.enable({ sessionId: sid, note: 'one', schedule: { type: 'daily', times: ['10:00'] } })
  const second = engine.enable({ sessionId: sid, note: 'two', create: true, schedule: { type: 'daily', times: ['11:00'] } })

  engine.pause(first.alarm.id, true)
  eq(engine.store.get(first.alarm.id).enabled, false, 'pause 应停用')
  eq(engine.store.get(first.alarm.id).nextAt, null, '停用后不应有下次')
  engine.pause(first.alarm.id, false)
  eq(engine.store.get(first.alarm.id).enabled, true, 'resume 应恢复')
  check(engine.store.get(first.alarm.id).nextAt !== null, 'resume 应重算下次')

  const disabled = engine.disable({ sessionId: sid })
  eq(disabled.action, 'disabled', 'action 应是 disabled')
  eq(disabled.disabled.sort(), [first.alarm.id, second.alarm.id].sort(), '应列出被关掉的全部 id')
  eq(engine.store.get(second.alarm.id).enabled, false, '第二条也应停用')
  engine.dispose()
})

/* ── 旧版 profile 配置键不能静默失效 ───────────────────── */

await test('B22', '旧版配置键（intervalMin/Max、quietRanges、prompts、maxPerDay）映射成新默认值并点名', async () => {
  const { engine } = makeEngine({
    intervalMinMinutes: 30,
    intervalMaxMinutes: 90,
    quietRanges: [{ from: '02:00', to: '08:00' }],
    prompts: ['甲', '乙'],
    maxPerDay: 8,
    sameSessionGapMinutes: 20,
  })
  const created = engine.enable({ sessionId: 'S22' })
  const alarm = created.alarm
  eq(alarm.schedule.type, 'random', '应映射成 random')
  eq(alarm.schedule.range, [16, 48], '30–90 分钟应换算成每天 16–48 次')
  eq(alarm.quiet.ranges, [{ from: '02:00', to: '08:00' }], '静默时段必须带过来（否则凌晨会照响）')
  eq(alarm.prompt.mode, 'list', '多条 prompts 应映射成 list 模式')
  eq(alarm.prompt.texts, ['甲', '乙'], 'prompts 内容应保留')
  eq(alarm.limits.maxPerDay, 8, 'maxPerDay 应映射到 limits')
  eq(alarm.limits.minGapMinutes, 20, 'sameSessionGapMinutes 应映射到 minGapMinutes')
  const status = engine.status()
  check(status.legacyConfigKeys.length >= 4, '应报出用了哪些旧键：' + JSON.stringify(status.legacyConfigKeys))
  check(status.warnings.some((w) => String(w).includes('旧版')), 'warnings 里应有一条旧版配置提示')
  engine.dispose()
})

/* ── B17 schemaVersion ─────────────────────────────────── */

await test('B17', 'schemaVersion≠2 → 拒绝该文件，status 报 config/schema，且拒绝写盘', async () => {
  const dir = freshDir()
  const file = join(dir, 'alarms.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, alarms: { x: {} } }, null, 2))
  try {
    const { engine } = makeEngine({}, makeDeliverer(), dir)
    const status = engine.status()
    eq(status.fatalError && status.fatalError.code, 'config/schema', 'status 应报 config/schema')
    let err = null
    try { engine.list() } catch (e) { err = e }
    eq(err && err.code, 'config/schema', 'list 应拒绝')
    eq(engine.store.save(logger), false, '致命错误时不允许写盘（不能毁掉用户文件）')
    eq(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 99, '原文件必须原样保留')
    engine.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── B16 单实例（走真正的 apply） ──────────────────────── */

await test('B16', '单实例：第二次 apply 被拒，且不注册工具', async () => {
  const ctx1 = makeCtx()
  const first = apply(ctx1, {})
  eq(first && first.ok, true, '第一次 apply 应成功：' + JSON.stringify(first))
  check(ctx1.toolsMap.has('mira_active_enable'), '应注册 mira_active_enable')
  eq(ctx1.toolsMap.size, 7, '应注册 7 个工具（实得 ' + [...ctx1.toolsMap.keys()].join(',') + '）')

  const ctx2 = makeCtx()
  const second = apply(ctx2, {})
  eq(second && second.ok, false, '第二次应失败')
  eq(second.error && second.error.code, 'plugin/instance', '错误码应是 plugin/instance')
  eq(ctx2.toolsMap.size, 0, '被拒的实例不应注册工具')
  check(logLines.some((l) => l.includes('已经有一个实例在跑')), '应写 warn 日志')
  ctx1.dispose()
  ctx2.dispose()
})

/* ── 回归：时间计算 / 计数器 / 加载 / 失败回滚 ─────────── */

await test('B23', 'once 在停机期间过点：条目保留、记 1 次错过、停用且不补发', async () => {
  const dir = freshDir()
  writeFileSync(join(dir, 'alarms.json'), JSON.stringify({
    schemaVersion: 2,
    alarms: {
      'a-once-past': {
        id: 'a-once-past', sessionId: 'S23', enabled: true, note: '',
        schedule: { type: 'once', at: new Date(clock.now - 3600_000).toISOString() },
        prompt: { mode: 'single', text: 't', order: 'random' },
        quiet: { enabled: true, ranges: [] },
        delivery: 'steer', limits: {},
        stats: {
          createdAt: new Date(clock.now - 7200_000).toISOString(), lastFiredAt: null,
          fireCount: 0, failCount: 0, missedCount: 0, consecutiveFailures: 0,
          dayKey: '2026-10-27', dayFired: 0, rangeKey: '', rangeFired: 0,
        },
        nextAt: clock.now - 1800_000, backoffUntil: 0,
      },
    },
  }, null, 2))

  const { engine, deliverer } = makeEngine({}, makeDeliverer(), dir)
  const alarm = engine.store.alarms.get('a-once-past')
  check(alarm !== undefined, '条目不能被当成坏条目丢掉（否则下次 save 就从文件里永久消失）')
  eq(alarm && alarm.enabled, false, '错过的一次性闹钟应停用')
  eq(alarm && alarm.nextAt, null, '不应再有下次触发')
  eq(alarm && alarm.stats.missedCount, 1, '应记 1 次错过')
  await engine.tick('test')
  eq(deliverer.record.steers.length, 0, '停机期间错过的一次性闹钟不允许补发')
  engine.dispose()
  const saved = JSON.parse(readFileSync(join(dir, 'alarms.json'), 'utf8'))
  check(saved.alarms['a-once-past'] !== undefined, '落盘后条目仍在（便于复查）')
})

await test('B24', 'maxPerRange 跨午夜不清零：22–01:30 班次到顶后 00:30 不再触发', async () => {
  const { engine, deliverer } = makeEngine()
  try {
    const created = engine.enable({
      sessionId: 'S24',
      schedule: { type: 'interval', intervalMinutes: 30 },
      workRanges: [{ from: '22:00', to: '01:30' }],
      maxPerRange: 1,
    })
    const id = created.alarm.id
    clock.now = new Date(2026, 9, 27, 23, 0, 0).getTime()
    engine.store.get(id).nextAt = clock.now
    await engine.tick('test')
    eq(deliverer.record.steers.length, 1, '班次内第一次应触发')
    clock.now = new Date(2026, 9, 28, 0, 30, 0).getTime()
    engine.store.get(id).nextAt = clock.now
    const summary = await engine.tick('test')
    eq(deliverer.record.steers.length, 1, '过了 00:00 仍算同一班次，到顶不应再触发')
    eq(summary.skipped.map((s) => s.reason), ['maxPerRange'], '应报 maxPerRange 跳过')
    const nextDate = new Date(engine.store.get(id).nextAt)
    eq([nextDate.getDate(), nextDate.getHours()], [28, 22], '应预约到下一个班次 22:00')
  } finally {
    clock.now = new Date(2026, 9, 27, 8, 0, 0).getTime()
    engine.dispose()
  }
})

await test('B25', 'daily / workRanges 在夏令时切换日仍是本地 09:00（不能偏成 10:00 / 08:00）', async () => {
  const scheduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'schedule.js')).href
  const script = [
    'import { computeNext, nextWorkStart } from ' + JSON.stringify(scheduleUrl),
    'const fmt = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0") }',
    'const spring = new Date(2026, 2, 8, 0, 30, 0).getTime()',   // 美国春令时：23 小时的一天
    'const fall = new Date(2026, 10, 1, 0, 30, 0).getTime()',     // 美国冬令时：25 小时的一天
    'const daily = computeNext({ schedule: { type: "daily", times: ["09:00"] }, stats: { lastFiredAt: null } }, spring)',
    'const work = nextWorkStart({ workRanges: [{ from: "09:00", to: "12:00" }] }, spring)',
    'const dailyFall = computeNext({ schedule: { type: "daily", times: ["09:00"] }, stats: { lastFiredAt: null } }, fall)',
    'console.log(JSON.stringify([fmt(daily), fmt(work), fmt(dailyFall)]))',
  ].join('\n')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
  })
  eq(JSON.parse(out), ['3/8 9:00', '3/8 9:00', '11/1 9:00'], '夏令时切换日的时刻必须仍是本地 09:00')
})

await test('B26', 'apply 中途抛错：工具/定时器/单实例认领全部回滚，重载不被永久拒绝', async () => {
  const ctxBad = makeCtx()
  ctxBad.effect = () => { throw new Error('宿主 effect 注册失败') }
  let threw = null
  try { apply(ctxBad, {}) } catch (error) { threw = error }
  check(threw !== null, 'apply 应把错误抛出去（不能静默吞掉）')
  eq(ctxBad.toolsMap.size, 0, '失败时已注册的 7 个工具必须摘掉')
  const ctxGood = makeCtx()
  const ret = apply(ctxGood, {})
  eq(ret && ret.ok, true, '回滚后重新 apply 应成功（单实例认领没泄漏）：' + JSON.stringify(ret))
  eq(ctxGood.toolsMap.size, 7, '重载应重新注册 7 个工具')
  ctxGood.dispose()
})

/* ── 回归：告警改绑 / 活会话 id ────────────────────────── */

await test('B27', '带 alarmId + 不同 sessionId → 真改绑：落盘/list/status 可见，nextAt 不重置', async () => {
  const { engine } = makeEngine()
  const created = engine.enable({ sessionId: 'old-sid', schedule: { type: 'daily', times: ['09:00'] } })
  const id = created.alarm.id
  const before = engine.store.get(id).nextAt
  engine.store.get(id).stats.fireCount = 3
  const ctx = makeCtx()
  const disposeTools = registerTools(ctx, engine)
  try {
    const tool = ctx.toolsMap.get('mira_active_enable')
    const out = JSON.parse(await tool.execute({ alarmId: id, sessionId: 'new-sid' }, {}))
    eq(out.ok, true, '调用应成功')
    eq(out.action, 'enabled', 'action 仍是 enabled')
    eq(out.sessionId, 'new-sid', '返回的 sessionId 应是改绑后的值（旧行为返回旧值）')
    eq(out.alarm.sessionId, 'new-sid', 'alarm.sessionId 应是改绑后的值')
    eq(out.rebound, { from: 'old-sid', to: 'new-sid' }, '应回报改绑前后')
    eq(engine.store.get(id).sessionId, 'new-sid', '内存条目应已改绑')
    eq(engine.store.get(id).nextAt, before, '改绑不允许重置 nextAt')
    eq(engine.store.get(id).stats.fireCount, 3, '改绑应保留统计')
    eq(engine.list('old-sid').length, 0, '旧会话不应再看到它')
    eq(engine.list('new-sid').map((a) => a.id), [id], '新会话应能看到它')
    eq(engine.status().alarms.find((a) => a.id === id).sessionId, 'new-sid', 'status 里应是新会话')
    eq(JSON.parse(readFileSync(engine.store.file, 'utf8')).alarms[id].sessionId, 'new-sid', '改绑必须落盘')

    // 带 alarmId 但不显式给 sessionId：绝不能用「当前会话」悄悄改绑
    const out2 = JSON.parse(await tool.execute({ alarmId: id }, {
      agent: { id: 'stale-id', session: { id: 'live-id' } },
    }))
    eq(out2.sessionId, 'new-sid', '不显式给 sessionId 时不应改绑')
    check(out2.rebound === undefined, '不显式给 sessionId 时不应回报 rebound')

    // 空 sessionId 直接走 store 更新时必须报错，不能落成「孤儿闹钟」
    let err = null
    try { engine.store.update(id, { sessionId: '   ' }) } catch (e) { err = e }
    eq(err && err.code, 'config/missing', '空 sessionId 改绑应报 config/missing')
    eq(engine.store.get(id).sessionId, 'new-sid', '报错时归属不应被改动')
  } finally {
    disposeTools()
    engine.dispose()
  }
})

await test('B28', '当前会话优先 agent.session.id（resume 后的活 id），回退 agent.id', async () => {
  const { engine } = makeEngine()
  const ctx = makeCtx()
  const disposeTools = registerTools(ctx, engine)
  try {
    const tool = ctx.toolsMap.get('mira_active_enable')
    const out = JSON.parse(await tool.execute({}, { agent: { id: 'stale-id', session: { id: 'live-id' } } }))
    eq(out.ok, true, '调用应成功')
    eq(out.sessionId, 'live-id', '应绑定 agent.session.id')
    eq(out.alarm.sessionId, 'live-id', '闹钟的 sessionId 必须是 live-id（不能是 stale-id）')
    eq(engine.list('live-id').length, 1, 'list 里应挂在 live-id 下')
    eq(engine.list('stale-id').length, 0, '绝不能挂在 stale 的 agent.id 下')
    eq(JSON.parse(readFileSync(engine.store.file, 'utf8')).alarms[out.alarm.id].sessionId, 'live-id', '必须落盘')

    const fallback = JSON.parse(await tool.execute({}, { agent: { id: 'only-id' } }))
    eq(fallback.sessionId, 'only-id', '没有 agent.session.id 时应回退到 agent.id')
  } finally {
    disposeTools()
    engine.dispose()
  }
})

/* ── 收尾 ───────────────────────────────────────────────── */

rmSync(TMP, { recursive: true, force: true })
console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const f of failures) console.log('[FAIL] ' + f)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)
