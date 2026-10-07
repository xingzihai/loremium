# Loremium 模块接口契约

供并行开发使用。所有实现必须遵守本契约;行为细节见 `DESIGN.md`、`API.md`、`BLOCKS.md`。

## 0. 通用约定

- 全部 ESM JavaScript,无 TypeScript,无构建步骤,除 Web 标准 API 外不引入运行时依赖
- 变量/函数 camelCase;D1 列名 snake_case;数据库行在模块边界转换为 camelCase
- 不写注释(除非确有必要);不提交 secrets;不改动不属于自己职责的文件
- 单元测试放 `test/*.test.js`,使用 `node:test` + `node:assert/strict`,运行 `npm test`
- 纯逻辑必须抽到可脱离 Worker 运行的文件中(`limiter-core.js`、`interpreter.js`),便于单测

## 1. 共享形状

```js
// getConfig() 返回的规范对象(字符串值已转换)
Config = {
  firstDelayMs: number,        // 0–60000
  charsPerSecond: number,      // 0.5–1000
  chunkSize: number,           // 1–256
  maxDurationMs: number,       // max_duration_s * 1000
  maxOutputChars: number,
  concurrencyLimit: number,
  overLimitBehavior: 'truncate' | 'reject',
  defaultModel: string,
  strictModel: boolean,
  corsOrigin: string,
  authMode: 'off' | 'optional' | 'required'
}

// 限流规则(内部一律 camelCase;D1 rules 表为 snake_case)
Rule = { windowSeconds: number, limitChars: number }

// Profile
Profile = {
  id: string, name: string, modelId: string, program: object,
  isDefault: boolean, enabled: boolean,
  firstDelayMs: number | null,     // null = 继承全局 config.firstDelayMs
  charsPerSecond: number | null,   // null = 继承全局 config.charsPerSecond
  updatedAt: number
}

// sanitized Key(不含哈希)
ApiKey = {
  id: string, name: string, keyPrefix: string,
  quotaMode: 'unlimited' | 'per_ip' | 'total',
  quotaRules: Rule[] | null, enabled: boolean,
  expiresAt: number | null, note: string | null,
  createdAt: number, updatedAt: number
}

// scope 字符串
//   ip:<ip>
//   key:<keyId>            (quota_mode=total)
//   key:<keyId>:<ip>       (quota_mode=per_ip)
// 轮换存储键:r:<key>(global) / r:<key>:ip:<ip>(ip)

// acquire 入参
AcquireParams = {
  ip: string,
  concurrencyLimit: number,
  reserveCap: number,
  maxDurationMs: number,       // 用于租约兜底:lease = now + maxDurationMs + 30000
  scopes: [{ scope: string, rules: Rule[] }],
  rotateKeys?: [{ key: string, mode: 'cycle'|'random', scope: 'ip'|'global', count: number, options: string[] }]
}
// 返回
AcquireOk  = { ok: true, reserved: number, rotations?: { [key: string]: string } }
AcquireErr = { ok: false, reason: 'concurrency' | 'quota', retryAfterMs: number, scope?: string }

SettleParams = { ip: string, scopes: string[], used: number }
StatusParams = { scopes?: string[], scopePrefix?: string, ip?: string }
ResetParams  = { scopes?: string[], scopePrefix?: string, ip?: string, rotations?: string[] }
```

## 2. src/util.js

```js
export function json(data, init)                                  // Response, JSON.stringify
export function openaiError(status, message, type = 'invalid_request_error', code = null)
export function randomId(prefix, len = 24)                        // base62 随机
export function sleep(ms)                                         // Promise
export function nowSec()                                          // Math.floor(Date.now()/1000)
export function parseIntOr(v, def)
export function corsHeaders(origin)                               // { 'Access-Control-Allow-Origin': ... }
```

## 3. src/config.js

```js
export const CONFIG_DEFAULTS  // { [key]: string }
export async function getConfig(env)                 // -> Config,每次请求直接读 D1(无跨请求缓存)
export function invalidateConfigCache()
export async function listProfiles(env)              // -> Profile[](enabled 与 disabled 都返回,调用方按需过滤)
export async function getProfileByModel(env, model)  // 精确匹配或 null
export async function getProfileById(env, id)
export async function createProfile(env, input)      // input 可含 firstDelayMs/charsPerSecond(或 snake_case),缺省/null/'' 存 NULL=继承全局
export async function updateProfile(env, id, patch)  // 同上;传 null 或 '' 清除覆盖
export async function deleteProfile(env, id)         // is_default 方案禁止删除
export async function listRules(env)                 // -> [{id, windowSeconds, limitChars, enabled, note}]
export async function getEnabledRules(env)           // -> Rule[]
export async function createRule(env, input)
export async function updateRule(env, id, patch)
export async function deleteRule(env, id)
export async function getIpOverride(env, ip)         // -> {ip, concurrency, rules, expiresAt, note}|null(过期视为 null)
export async function listIpOverrides(env)
export async function upsertIpOverride(env, ip, input)
export async function deleteIpOverride(env, ip)
```

## 4. src/keys.js

```js
export const KEY_PREFIX = 'sk-lorem-'
export async function hashKey(plaintext)             // SHA-256 hex
export function generateKeyMaterial()                // -> { plaintext, hash, prefix }(plaintext = KEY_PREFIX + 48 base62)
export function parseBearer(request)                 // -> string | null
export async function authenticate(env, request, authMode)
  // -> { status: 'none' } | { status: 'invalid' } | { status: 'valid', key: ApiKey }
export async function listKeys(env)                  // -> ApiKey[]
export async function getKeyById(env, id)            // -> ApiKey | null
export async function createKey(env, input)          // input: {name, quotaMode, quotaRules?, expiresAt?, note?} -> {key: ApiKey, plaintext}
export async function updateKey(env, id, patch)
export async function deleteKey(env, id)
export function keyScopes(key, ip)
  // quotaMode='unlimited' -> [];'total' -> [{scope:`key:${key.id}`, rules}];'per_ip' -> [{scope:`key:${key.id}:${ip}`, rules}]
export function invalidateKeyCache()
```

Key 查询不设跨请求缓存(直接读 D1,管理端变更即时生效),任何写操作仍调用 `invalidateKeyCache()`。

## 5. src/stats.js(D1 `request_logs` 聚合)

```js
export async function overview(env, hours = 24)
  // -> {requests, chars, errors, activeIps, series:[{t, requests, chars}]}
  // 按小时分桶聚合 request_logs;series 补齐空桶;hours 钳制到 1..(24*31)
export async function overviewToday(env, tzOffsetMinutes = 480)
  // -> 同上;从本地自然日 0 点(按 tzOffsetMinutes)起算,series 截至当前
export async function queryStats(env, filters)
  // filters {from,to,ip,model,status,keyId|key_id,limit};参数化 SQL 查明细
  // -> [{timestamp, ip, model, status, profile, finishReason, keyId,
  //      chars, inputTokens, outputTokens, durationMs, ttftMs, isStream}]
  // limit 钳制到 1..1000(默认 100)
export async function keyUsage(env, keyId, days = 7)
  // -> {requests, chars, series:[{t, requests, chars}]};days 钳制到 1..31
export async function cleanup(env)
  // Cron:删除已过期 ip_overrides -> {deleted}
```

- 全部使用参数化 SQL 聚合 D1 `request_logs`(按小时分桶、`SUM(output_tokens)` 求和、`status>=400` 计错误、`COUNT(DISTINCT ip)` 活跃 IP)
- 数据仅覆盖 `request_logs` 保留期(`request_log_retention_days`,默认 7 天);`request_log_enabled=false` 时 `/overview` 与 Key 用量由上层返回 `unavailable:true` + 中文 note
- 已移除早期 `writeEvent`、`queryAE`、`syncKeyIps`、`listKeyIps` 及 AE 查询令牌相关接口

## 6. src/limiter-core.js(纯函数)

```js
export function sumWindow(entries, now, windowMs)          // entries [{ts,chars}] -> number
export function remainingForRules(windows, rules, now)
  // windows: { [windowSeconds: string]: [{ts,chars}] };rules: Rule[];无规则返回 Infinity
export function retryAfterForRules(windows, rules, now)    // -> ms(累计到额度回落所需时间;多规则取最大)
export function truncateUtf16(text, maxChars)              // 不切断代理对
export function pickRotation(mode, count, options, counter) // counter 从 0 起;cycle: options[counter % len];random: 随机
```

## 7. src/limiter.js(Worker 侧客户端)

```js
export async function acquire(env, params)   // -> AcquireOk | AcquireErr
export async function settle(env, params)    // -> {ok:true}
export async function status(env, params)
  // -> { scopes:[{scope, windows:[{windowSeconds, used}]}], inflight:{[ip]:number}, rotations:{[key]:number} }
export async function reset(env, params)     // -> {ok:true}
```

实现:stub = `env.LIMITER.get(env.LIMITER.idFromName('global'))`,POST `/rpc`,body `{method, params}`;非 2xx 抛错。

## 8. src/limiter-do.js

```js
export class Limiter {
  constructor(ctx, env)     // ctx.storage.sql;首次 blockConcurrencyWhile 建表 + alarm 兜底
  async fetch(request)      // POST /rpc {method, params} 分发到 acquire/settle/status/reset
  async alarm()             // 回收超时租约 + purge 过期桶 + 持久化
}
```

SQLite 表(DO 内部):

```sql
CREATE TABLE IF NOT EXISTS buckets (
  scope TEXT NOT NULL, window_seconds INTEGER NOT NULL,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, window_seconds)
);
CREATE TABLE IF NOT EXISTS inflight (
  ip TEXT PRIMARY KEY, leases TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rotations (
  rkey TEXT PRIMARY KEY, counter INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

- acquire:purge → 并发检查(leases 数组长度 ≥ concurrencyLimit 即拒绝)→ `remainingForRules` 跨所有 scope 取最小 → 预留 → leases.push(now+maxDurationMs+30000) → 解析 rotateKeys(counter 持久化递增)
- settle:按 reservationId 把 pending 条目改写为 used;若 reservationId 对应预留已因实例驱逐丢失(内存无记录),则扫描所有 scope 的 pending 条目恢复结算 → 始终移除该 ip 最早的 lease → 持久化
- leases 为 JSON 数组,inflight 数 = leases.length;alarm 剔除已过期 lease
- 租约兜底需要知道 maxDurationMs:`acquire` 入参带 `maxDurationMs`(由调用方从 config 传入)
- 持久化策略:settle 必写;acquire 的 inflight 变化节流(≥1s)写;内存缓存,驱逐后从 SQLite 恢复
- `status` 返回各 scope 各窗口 used、inflight、rotations

## 9. public/js/interpreter.js(浏览器/Worker 共享)

```js
export const PRESETS   // { 'unicode-garbage': string, 'zero-width': string, 'private-use': {range:['U+E000','U+F8FF']}, 'combining':..., 'ascii-noise':... }
export function validateProgram(program)       // -> {ok, errors: string[]}(深度≤16、节点≤10000、repeat≤1000000、选项 1–1024、pool 1–16384)
export function collectRotateKeys(program)     // -> [{key, mode, scope, count, options}]
export function interpret(program, opts)       // opts {budget=Infinity, rotations={}, rng}
  // -> {text, truncated};rotate 块取 rotations[key],缺失时取 options[0]
export function truncateUtf16(text, maxChars)
```

块类型与字段严格按 `docs/BLOCKS.md`。随机源默认 `globalThis.crypto`。达到 budget 即停止并 `truncated=true`。

## 10. src/generator.js

```js
export function estimatePromptTokens(messages)  // ceil(JSON.stringify(messages).length / 4)
export function generateContent(program, { budget, rotations })  // -> {text, truncated}
export function resolvePacing(config, profile = null)
  // -> { firstDelayMs, charsPerSecond, chunkSize, maxDurationMs }
  // 方案覆盖优先:profile.firstDelayMs / profile.charsPerSecond 非 null 且合法(延迟 >= 0、速度 > 0 的有限数)时使用;
  // 未设置或非法则回退 config.firstDelayMs / config.charsPerSecond;chunkSize / maxDurationMs 恒取全局
```

## 11. src/openai.js

```js
export async function readJson(request)        // -> {ok:true, body} | {ok:false, response}
export function chatCompletionBody({id, model, created, text, usage, finishReason})
export function completionBody({id, model, created, text, usage, finishReason})
export function sseStream({kind, id, model, created, text, usage, pacing, includeUsage, truncated, signal})
  // kind: 'chat' | 'text'
  // pacing: { firstDelayMs, charsPerSecond, chunkSize, maxDurationMs }
  // -> { response, done: Promise<{ emitted, finishReason }> }
```

- chat:role 块 → 内容块(chunkSize 分组)→ includeUsage 块(可选)→ finish 块 → `data: [DONE]`
- text:每个 chunk `object:'text_completion'`,`choices[0].text`
- 速度:`chunkSize / charsPerSecond * 1000` ms/块;首字延迟在首个内容块前
- `maxDurationMs` 或 abort 时停止;`done.finishReason = truncated || aborted || timeout ? 'length' : 'stop'`
- `done.emitted` 为实际写出字符数(供 settle)

## 12. src/admin-api.js

```js
export async function handleAdminApi(request, env, ctx)  // -> Response;无匹配返回 404
```

路由与响应格式按 `docs/API.md` §6。Access 校验由 `index.js` 在进入前完成。

## 13. src/index.js

```js
export { Limiter } from './limiter-do.js'
export default {
  async fetch(request, env, ctx),
  async scheduled(event, env, ctx)   // cron: "0 4 * * *" -> stats.cleanup(过期 ip_overrides) + cleanupRequestLogs(过期请求日志)
}
```

请求管线(chat/completions 共用):

1. `readJson` → 400
2. `getConfig`;OPTIONS 直接 204 + CORS
3. `authenticate`;invalid → 401;required 且 none → 401
4. profile:`getProfileByModel` → 命中;否则 strict 404;否则 `getProfileByModel(defaultModel)`;再无则内置兜底程序
5. scopes:`ip:<ip>`(override.rules ?? getEnabledRules());有效 Key 且 `authMode !== 'off'` 且非 unlimited → `keyScopes(key, ip)`
6. rotateKeys = `collectRotateKeys(profile.program)`
7. `acquire`;失败时:reason='concurrency' 一律 429 + `Retry-After`(ceil(retryAfterMs/1000));reason='quota' 时,`overLimitBehavior='reject'` → 429,`'truncate'` → 返回空补全(200,finish_reason='length')
8. budget = min(reserved, maxOutputChars, maxTokens??Infinity)
9. `generateContent` → 文本与 truncated
10. `resolvePacing(config, profile)` 解析本次首字延迟与速度(方案覆盖 → 全局回退);流式 → `sseStream`;非流式 → sleep(`pacing.firstDelayMs`) 后返回 JSON body
11. finally:`settle({ip, scopes, used: emitted})`
12. `writeRequestLog(env, ctx, ...)`(仅 `config.requestLogEnabled` 时写入 D1 `request_logs`)

admin 域判定:`url.hostname` 属于 `env.ADMIN_HOST`(逗号分隔允许列表,默认 `admin.ai.example.com`);带 `Origin` 时其 hostname 也必须在允许列表;`POST/PUT/PATCH` 要求 `Content-Type` 以 `application/json` 开头;若设置了 `env.ACCESS_AUD`,要求 `Cf-Access-Jwt-Assertion` 通过 RS256 验签(aud/iss/exp,team domain 取 `env.ACCESS_TEAM_DOMAIN`,未知 kid 时限频刷新 JWKS 且 fetch 5s 超时),未配置 `ACCESS_AUD` 或验签失败一律 403;`env.DEV_BYPASS_ADMIN === 'true'` 且(**未配置** `env.ACCESS_AUD` 或请求 host 为 localhost/127.0.0.1/::1)时才全部跳过(仅本地开发)。客户端 IP 只取 `CF-Connecting-IP`,不信任 `X-Forwarded-For`。

## 14. public/(管理面板)

- `public/index.html`:Alpine.js + Pico.css(CDN 可接受),标签页:仪表盘 / 限流 / API Keys / 内容 / 行为 / IP 查询
- `public/js/boot.js`:Alpine 初始化引导脚本(替代内联脚本以适配 CSP;`script-src` 仍需保留 `'unsafe-eval'` 供 Alpine 3 求值表达式)
- `public/js/app.js`:所有管理 API 调用与页面状态;创建 Key 后弹一次性明文提示
- `public/js/blocks.js`:Blockly 接入(M5,可先留最小骨架:加载 `vendor/blockly`、由 `BLOCKS.md` 定义积木,不阻塞本阶段)
- `public/style.css`
