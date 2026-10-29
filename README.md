# mira_active

让会话拥有**自我激活**的能力 —— 本质是闹钟：到点往某个会话里**插话**注入一条用户消息，
让它自己跑一轮。

> 0.3.0 起数据模型改成「**一条配置 = 一个闹钟**」（`alarmId` 为键，条目里带 `sessionId`），
> 投递方式从 `followup`（排队）改成 **`steer`（插话）**。旧版的单文件状态用
> `重构插件/migrate/active.mjs` 转换，见「迁移」。
>
> 纯 Node 内置能力（`fs` / `path` / `crypto`），`link:` 装入 profile 即可用，无第三方依赖。

```
落盘：$DSH_HOME/mira_config/mira_active/alarms.json   （schemaVersion 2）
      $DSH_HOME 缺省 ~/.dsh → 例如 `~/.dsh/mira_config/mira_active/`
```

> **状态文件是内存镜像，不是开关。** 插件运行时以内存为准，`alarms.json` 只是它写出去的副本；
> 运行时删除或手改该文件，会在下一次落盘时被**写回或覆盖**（工具调用、卸载、定时器处理到点条目
> 都会触发落盘）。**删掉状态文件来清空激活列表，仅在插件未运行时有效。** 运行中要清空请用
> `mira_active_remove` / `mira_active_disable`；只想看状态用 `mira_active_status`（只读，返回文件
> 路径、条目数、启用数，不改任何东西）。插件也不会自动重读外部改动：手改文件后要重载插件才生效。

## 投递语义（任务书【定】）

| 会话状态 | 行为 |
|---|---|
| 空闲 | 立刻开始一轮 |
| 正在跑 | 把消息**插到最近一步**（steer） |

**绝不排队等下一轮**：`followup` 要等这一整轮结束才轮到，会把「到点叫醒」变成「这一轮结束后才叫」。
所以本插件只调 `agent.steer()`，代码里没有 followup 路径。

## 数据模型

```json
{
  "schemaVersion": 2,
  "alarms": {
    "a-1f2e3d4c5b": {
      "id": "a-1f2e3d4c5b",
      "sessionId": "会话 id（必填，空 → 拒绝保存并报 config/missing，不猜）",
      "enabled": true,
      "note": "备注，只用于状态显示",
      "schedule": { "type": "daily", "times": ["09:00", "21:00"] },
      "prompt": { "mode": "single", "text": "该起来了", "order": "random" },
      "quiet": { "enabled": true, "ranges": [{ "from": "01:00", "to": "07:00" }] },
      "delivery": "steer",
      "limits": { "maxPerDay": 0, "minGapMinutes": 0, "failBackoffMinutes": 10, "maxFailures": 5 },
      "stats": { "createdAt": "…", "lastFiredAt": null, "fireCount": 0, "failCount": 0, "missedCount": 0,
                 "consecutiveFailures": 0, "dayKey": "2026-10-27", "dayFired": 0, "rangeKey": "", "rangeFired": 0 },
      "nextAt": null,
      "backoffUntil": 0
    }
  }
}
```

同一会话可以有**多条**闹钟；多条同时到期时按 `nextAt` 升序依次投递。

### `schedule`（定时方式）

| type | 字段 | 说明 |
|---|---|---|
| `once` | `at`（ISO8601）或 `afterMinutes` | 一次性。`afterMinutes` 在**保存时**折算成绝对时刻；拒绝过去时刻（要立刻响用 `mira_active_fire_now`）。触发后 `enabled` 自动置 `false`，条目保留便于复查 |
| `daily` | `times: ["09:00","21:00"]` | 每天固定时刻，可多个；取最近的将来时刻 |
| `interval` | `intervalMinutes` | 每 N 分钟；基准是上次触发时刻 |
| `random` | `perDay` 或 `range: [min,max]` | 按天给**期望次数**。按平均间隔采样（±40% 抖动），不是「固定 k 次均匀铺开」 —— 均匀铺开会把随机变成机械 |

### `prompt`（提示词）

- `mode:"single"` + `text`，或 `mode:"list"` + `texts[]` + `order:"random"|"seq"`（顺序循环）
- 变量：`{{time}}` `{{date}}` `{{sessionId}}` `{{alarmId}}` `{{count}}`（该条目累计触发次数，1 起）
- 未知的 `{{xxx}}` **原样保留**，不会被静默吞掉

### `quiet`（静默时段）

- 条目级、可多段、可跨午夜（`22:00 → 02:00`）、可按星期（`days:[0..6]`，0=周日；省略=每天）
- 跨午夜时 `days` 指**窗口开始那天**：周一 22:00 开的窗口，周二 01:00 仍算周一那段
- 命中 → 本次不触发、**不补**、`missedCount+1` 并打一行 info
- **不推迟到窗口结束后立刻响** —— 那会让人一觉醒来被一串闹钟炸掉（任务书点名的坑）

### `limits`

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxPerDay` | `0` | 每天最多触发几次（0=不限），按本地日期跨天重置 |
| `minGapMinutes` | `0` | 两次触发之间至少隔多少分钟 |
| `failBackoffMinutes` | `10` | 投递失败后等多久再试 |
| `maxFailures` | `5` | 连续失败多少次后自动 `enabled=false` 并打 warn（不无限重试烧 token） |

### 扩展字段（任务书 v2 数据模型里没有，r70 已上线，PLAN §3.2 定为条目级可选）

| 字段 | 说明 |
|---|---|
| `workRanges` | 正向开工时段：只在窗口内触发；窗口外**不记错过**，直接预约到下一个窗口开始 |
| `maxPerRange` | 单个开工时段内的触发上限；到顶等下一个班次（跨午夜的窗口过了 00:00 也不清零） |

不写这两个字段 = 不启用，行为与任务书模型完全一致。配了 `workRanges` 时注入的消息会带一行
`[班次 22:00-01:30，本班次第 2/3 次]` 作为上下文。

## 工具

| 工具 | 行为 |
|---|---|
| `mira_active_enable` | 装闹钟。不给 `alarmId` 时按当前会话：复用该会话的 `default` 条目，没有就新建（默认 `random perDay=6`，可用 `config.defaultSchedule` 改）。`create:true` 强制新建一条（同会话要多条时用）。带 `alarmId` 且**显式**给不同的 `sessionId` = 改绑到新会话（`stats` 与 `nextAt` 原样保留，返回 `rebound:{from,to}`；不显式给 `sessionId` 则不会改绑） |
| `mira_active_disable` | 给 `alarmId` 只停那一条；不给则停掉**当前会话全部**闹钟并在返回里列出关掉的 id。条目保留不删 |
| `mira_active_list` | 条目清单：`id/sessionId/enabled/schedule/nextAt(ISO + 还有多少分钟)/stats/quiet/limits`，可按会话过滤 |
| `mira_active_fire_now` | 立刻触发一次，**不改** `schedule`（例外：`once` 触发后自动停用，投递失败按 `failBackoffMinutes` 改 `nextAt`）。只跳过时间判断：**静默仍然生效**（返回 `fired:false, reason:"quiet"`，`missedCount+1`） |
| `mira_active_pause` | 临时停/恢复一条，不动其他配置 |
| `mira_active_remove` | 删除一条（连统计）。只是想别响请用 pause/disable |
| `mira_active_status` | 只读：条目数/启用数/涉及几个会话/最近触发/失败与错过/定时器在跑吗/上次错误/加载告警/致命错误详情 |

「当前会话」优先取工具上下文的 `exec.agent.session.id`（会话日志的权威 id；resume / 克隆 / rekey 后
`exec.agent.id` 可能还是旧 id），没有再回退 `exec.agent.id`。所以**必须在会话里调用**；两者都拿不到
又没给 `sessionId` 时返回 `config/missing`，不会猜。

## 配置（profile 的 cordis patch）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具、不起定时器 |
| `defaultSchedule` | `{ "type": "random", "perDay": 6 }` | `mira_active_enable` 不带 `schedule` 时用它 |
| `defaultPrompt` | 内置一句话 | `enable` 不带 `prompt` 时用它（`{mode:"single"|"list", …}`） |
| `defaultQuiet` | 不静默 | `enable` 不带 `quiet` 时用它（`{enabled, ranges}`） |
| `defaultLimits` | 见上表 | `enable` 不带 `limits` 时用它 |
| `defaultWorkRanges` | 不设限 | 扩展字段的条目级默认值 |
| `defaultMaxPerRange` | `0` | 扩展字段的条目级默认值 |

### 旧版配置键（0.2.0）怎么映射

0.2.0 的配置是「每会话一条 + 全局节奏」，这些键在 0.3.0 里**没有同名对应物**。
为了不让升级变成「静默行为变化」（最糟的一种：静默时段消失、凌晨照响），插件会把它们
映射成**新建闹钟的默认值**，并在日志和 `mira_active_status.warnings / legacyConfigKeys` 里点名：

| 旧键 | 映射到 | 换算 |
|---|---|---|
| `intervalMinMinutes` / `intervalMaxMinutes` | `defaultSchedule: {type:"random", range:[…]}` | `range[0]=ceil(1440/max)`、`range[1]=floor(1440/min)`；30–90 分钟 → `[16, 48]` |
| `quietRanges` | `defaultQuiet.ranges` | 原样 |
| `prompts` | `defaultPrompt` | 1 条 → `single`，多条 → `list` |
| `maxPerDay` | `defaultLimits.maxPerDay` | 原样 |
| `sameSessionGapMinutes` | `defaultLimits.minGapMinutes` | 原样 |
| `workRanges` / `maxPerRange` | `defaultWorkRanges` / `defaultMaxPerRange` | 原样 |
| `tickMs` / `statePath` | —（忽略，会点名） | 定时器改成睡到最近 `nextAt`；状态文件路径由目录约定取代 |

**这不是静默兼容**：旧键只做兜底默认值，且一定会被 warn 点名。请把 profile 里的这些键删掉、
改成上面的新结构（`defaultQuiet` 等）。映射只影响**新建**的闹钟；已存在的条目保持自己的配置。

## 定时器怎么跑

不是固定节拍轮询，而是**睡到最近一条 `nextAt`**（下限 1 秒、上限 60 秒，避免睡死或空转）。
醒来后把到点的条目按 `nextAt` 升序逐条处理，本次到点的条目处理完后回写一次文件。
**不会重读状态文件或配置**：外部改动要重载插件才生效（见上面「状态文件是内存镜像」）。

五种结果分开计数（`mira_active_status.counters` 里能区分，否则分不清「用户设了静默」和「会话没了」）：

| 结果 | 计数键 | 是否记 missed |
|---|---|---|
| 静默命中 | `fire.missed.quiet` | 是（`missedCount+1`） |
| 不在开工时段 | `fire.skipped.work` | 否（预约到窗口开始） |
| 撞 `maxPerDay` | `fire.skipped.maxPerDay` | 否 |
| 撞 `maxPerRange` | `fire.skipped.maxPerRange` | 否（等下一个班次） |
| 距上次太近 | `fire.skipped.minGap` | 否 |
| 投递失败 | `fire.fail` | 否（走退避） |
| 停机期间错过 | — | 是（加载时每条只记 1 次，不补发） |

## 已知取舍

1. **随机是「期望次数」不是「固定次数」**：`perDay:6` 按下平均 4 小时的间隔采样，实际落在
   2.4–5.6 小时。真正「每天恰好 6 次均匀分布」需要预生成当天时刻表，那是另一种产品口径；
   任务书写的是「期望次数或区间」，这里按期望实现。单日硬上限仍由 `limits.maxPerDay` 兜。
2. **静默命中后落到「下一个排定时刻」，不是「下一个不被静默的时刻」**。`daily 08:30` 配静默
   `08:00–09:00`：08:30 那次被记为错过，下一次是**明天** 08:30；今天 09:00 不会补响。
   若排定时刻本身就在静默里（如每天 02:00 配静默 01:00–07:00），它会每天记一次 misses ——
   这是「不推迟」的必然代价，配置时请让两者错开。
3. **`disable` 不带 `alarmId` = 关掉该会话全部闹钟**，并把 id 列出来。任务书只说「按当前会话」，
   一闹钟一条之后「关哪条」必须定口径：全关 + 明确回报比「关最近一条」可预测。
4. **`enable` 不带 `alarmId` 默认复用**，要新增第二条必须显式 `create:true`。否则重复调用会
   不断堆条目，而这正是旧版「幂等 enable」的语义。
5. **`once` 拒绝过去时刻**。过去时刻如果被接受，重启后会立刻触发一堆历史闹钟（功能点11 要
   避免的正是这个）。要手动补一次用 `mira_active_fire_now`。
6. **`fire_now` 仍然受静默约束**（PLAN B8）。手动触发是「不等时间」，不是「忽略用户的静默设置」。
7. **热重载不丢状态**：卸载时先摘工具 → 停定时器并落盘 → 释放单实例认领，新实例随后 load
   拿到的是最新文件。旧实例不会用旧内存覆盖新落盘（约定9 的踩坑点）。
8. **`alarms.json` 坏了/版本不符 → 拒绝使用且拒绝写盘**。宁可插件报错，也不拿空表覆盖用户的
   闹钟。`mira_active_status.fatalError` 里有 `code/message/hint`。手改文件里个别条目坏掉
   （比如 schedule 非法）只跳过那一条并 warn，不影响其他条目。

## 迁移（0.2.0 → 0.3.0）

旧版把状态写在 `<DSH_HOME>/mira_active.json`（每会话一条 + 全局 `intervalMin/MaxMinutes`）。
新版是一闹钟一条。转换脚本：

```bash
# 1. 先看计划（默认 dry-run）
node 重构插件/migrate/active.mjs --interval-min 30 --interval-max 90 \
  --quiet 01:00-07:00 --prompt "该起来了" --max-per-day 8

# 2. 确认后写入（写前备份旧文件，写完把旧文件改名成 .bak.<时间戳>）
node 重构插件/migrate/active.mjs … --write
```

换算口径（脚本会把算式打出来，自己核对）：

```
旧：两次激活相隔 [intervalMin, intervalMax] 分钟
新：perDay 是每天期望次数，平均间隔 = 1440/perDay
    range[0] = ceil(1440 / intervalMax)    ← 最长间隔对应最少次数
    range[1] = floor(1440 / intervalMin)   ← 最短间隔对应最多次数
例：30–90 分钟  →  每天 16–48 次
```

`intervalMin/MaxMinutes`、`quietRanges`、`prompts`、`maxPerDay` 原本在 profile 的 cordis patch 里，
脚本用命令行参数接（它读不到你的 profile）；profile 里这几项在新版**不再生效**，
请在迁移后从 patch 里删掉，避免误以为还在用。

**语义差异要自己确认**：`sameSessionGapMinutes` 会映射成**条目级** `limits.minGapMinutes` ——
多条闹钟挂同一会话时，间隔不再跨条目生效；`tickMs` 没有对应物（定时器改成睡到最近 `nextAt`）。
旧版「带 `workRanges` 时写的 `day/dayCount/rangeDay/rangeCount`」只影响统计，迁移脚本按
`count` 换算 `fireCount`，其余归零。

## 自检

```bash
cd mira_active && node test/smoke.mjs       # 期望末行：==== ALL PASS（148 项断言）====，退出码 0
node ../重构插件/tools/check-zero-dep.mjs   # 只许 node: 与相对 import
node ../重构插件/tools/check-kit.mjs        # lib/kit.mjs 与规范源逐字节一致
```

smoke 用**注入时钟**（`new ActiveEngine({ now })`）与假投递器，在临时 `DSH_HOME` 里跑，
不依赖 DSH 运行时、不碰真实配置，也不等待真实时间。覆盖 PLAN §1.2 的 B2–B17。
