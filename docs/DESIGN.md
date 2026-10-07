# Loremium 设计文档

版本: v1.1(API Key 机制) · 2026-10-04

## 1. 目标与非目标

### 目标

1. **OpenAI 兼容中转站**:实现 `/v1/models`、`/v1/chat/completions`、`/v1/completions`,流式(SSE)与非流式均可,兼容 Cherry Studio / NextChat / Open WebUI 等常见客户端。
2. **可配置的"垃圾输出"**:文本、随机、加权随机、字符池、Lorem、重复循环、跨请求轮换,由 Blockly 图形化积木编排。
3. **行为模拟**:首字延迟、输出速度(字符/秒)、分块大小、响应时长上限;首字延迟与输出速度支持按内容方案覆盖。
4. **API Key 机制**:多把 Key、独立配额(无限 / 按 IP 配额 / 单 Key 总额度)、记录调用 IP;鉴权模式可配置(off / optional / required)。
5. **精细化限流**:按 IP 的并发数 + 多条滑动窗口字数规则 + Key 配额,所有生效额度取最小值,触顶截断;支持按 IP 覆盖。
6. **管理面板**:今日调用量、请求统计、限流规则、内容方案、API Key 管理、积木编辑器、单 IP 实时状态。
7. **零成本**:全部运行在 Cloudflare 免费计划额度内。

### 非目标

- 不做真实 AI 推理,不接入任何模型
- 不做多用户账号体系与计费(面板仅管理员使用)
- 不追求 100% OpenAI 语义兼容(`usage` 为模拟值,`temperature` 等参数忽略)
- v1 不做 Key 级并发限制(仅字符额度),列入 backlog

## 2. 架构总览

```
                    ┌────────────────────────── Cloudflare ─────────────────────────┐
 客户端              │                                                               │
   │  ai.example.com │   ┌──────────── Worker: loremium ────────────┐                │
   ├─────────────────┼──>│ /v1/*            OpenAI 兼容 API          │                │
   │                 │   │ /admin/api/*     管理 API                 │                │
   │  admin.          │   │ 静态资源         管理面板(Static Assets) │                │
   │  ai.example.com ┼──>│ Cloudflare Access 保护 admin 域          │                │
   └─────────────────┼──>└──────┬──────────────┬───────────┬───────┘                │
                     │          │              │           │                        │
                      │      ┌───▼───┐    ┌─────▼─────┐                            │
                      │      │  D1   │    │ Limiter DO│                            │
                      │      │配置/方案│   │全局单实例:  │                            │
                      │      │规则/Key │   │IP/Key 窗口 │                            │
                      │      │日志/统计│   │并发/轮换    │                            │
                      │      └───────┘    └───────────┘                            │
                      │      Cron:每日清理过期 IP 覆盖与过期请求日志                     │
                     └───────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 | 免费额度 |
|---|---|---|
| Worker | 路由、OpenAI 协议、Key 鉴权、生成与节流、管理 API | 10 万请求/天,10ms CPU/请求 |
| D1 | 配置、内容方案、限流规则、IP 覆盖、API Key、逐请求日志与统计聚合 | 500 万行读/天,10 万行写/天,5GB |
| Durable Object `Limiter`(全局单实例) | IP 并发、IP 窗口、Key 配额窗口、轮换状态 | 10 万请求/天,5GB,13k GB-s/天 |
| Static Assets | 管理面板前端 | 免费,不计 Worker 请求 |
| Cloudflare Access | admin 域名身份验证 | Zero Trust 免费版 50 用户 |
| Cron Trigger | 每日清理过期 IP 覆盖与过期请求日志 | 免费 |

> v1.0 原设计为"每 IP 一个 DO",v1.1 因 Key 总额度必须跨 IP 共享而改为**全局单实例 DO**(见 §13 决策 2/9)。流量规模远低于单实例吞吐上限,且保证跨 IP 原子性。

## 3. 请求生命周期

1. 客户端请求 `POST /v1/chat/completions`
2. Worker 解析请求体、读取配置(直接读 D1;`CACHE_TTL_MS = 0` 等价无缓存)
3. **鉴权**:按 `auth_mode` 校验 `Authorization: Bearer <key>`;命中则加载 Key 记录(哈希查询;缓存 TTL 为 0,等价每次直读 D1),未命中/无效按模式放行或 401
4. 由 `model` 解析内容方案 profile(未知 model 回退默认方案,可开严格模式)
5. 组装限流 scope:
   - `ip:<ip>`(全局 IP 规则或该 IP 的覆盖规则)
   - 有 Key 且配额非无限时:`key:<keyId>`(total 模式)或 `key:<keyId>:<ip>`(per_ip 模式)
6. 调 `Limiter.acquire(...)`:检查并发 → 各 scope 剩余取最小 → 预留额度;失败返回 429
7. 解释器按预留额度生成内容(触顶即截断)
8. 输出:先由 `resolvePacing(config, profile)` 决定本次首字延迟与输出速度——**方案覆盖优先,方案未设置或覆盖值非法(非有限数、延迟 < 0、速度 ≤ 0)时回退全局** `first_delay_ms`/`chars_per_second`(`chunk_size`、`max_duration_s` 恒为全局):
   - 流式:sleep(首字延迟) → 按分块 + 速度吐 SSE → 结算
   - 非流式:可选 sleep(首字延迟) → 整段 JSON 返回
9. `Limiter.settle(...)` 结算:记录消耗到所有 scope、释放并发
10. `ctx.waitUntil` 写逐请求日志 `request_logs`(含 key_id、ip);统计由 D1 聚合
11. 异常/客户端断开(`request.signal` abort)在 finally 中 settle;DO alarm 兜底回收未结算租约

## 4. 数据模型(D1)

```sql
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model_id   TEXT NOT NULL UNIQUE,   -- 客户端请求的 model 名,如 loremium-lorem
  program    TEXT NOT NULL,          -- BlockProgram JSON
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  first_delay_ms   INTEGER,          -- NULL = 继承全局 config.first_delay_ms
  chars_per_second REAL,             -- NULL = 继承全局 config.chars_per_second
  updated_at INTEGER NOT NULL
);

CREATE TABLE rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  window_seconds INTEGER NOT NULL,   -- 窗口时长,如 300
  limit_chars    INTEGER NOT NULL,   -- 窗口内输出字符上限
  enabled        INTEGER NOT NULL DEFAULT 1,
  note           TEXT
);

CREATE TABLE ip_overrides (
  ip          TEXT PRIMARY KEY,
  concurrency INTEGER,               -- NULL = 用全局配置
  rules       TEXT,                  -- JSON 规则数组;NULL = 用全局规则
  expires_at  INTEGER,               -- NULL = 永久
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,               -- 内部 id(如 key_xxx)
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,           -- SHA-256(full key)
  key_prefix    TEXT NOT NULL,                  -- 展示用前缀,如 sk-lorem-a1b2c3…
  quota_mode    TEXT NOT NULL DEFAULT 'unlimited'
                CHECK (quota_mode IN ('unlimited','per_ip','total')),
  quota_rules   TEXT,                           -- JSON [{window_seconds, limit_chars, enabled, note}]
  enabled       INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- key_ips 表已废弃:已由 migrations/0004_drop_key_ips.sql 删除。
-- Key 调用 IP 改为聚合 request_logs(见 §8),不再由 Cron 同步。

CREATE TABLE request_logs (                     -- 逐请求日志,默认保留 7 天(可用 request_log_retention_days 配置)
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  key_id        TEXT,
  ip            TEXT NOT NULL,
  model         TEXT NOT NULL,
  profile       TEXT,
  status        INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  ttft_ms       INTEGER NOT NULL DEFAULT 0,
  is_stream     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_request_logs_key ON request_logs(key_id, id DESC);
CREATE INDEX idx_request_logs_ip ON request_logs(ip, id DESC);
CREATE INDEX idx_request_logs_created ON request_logs(created_at);
```

> `migrations/0001`–`0003` 均使用 `CREATE TABLE/INDEX IF NOT EXISTS` 与 `INSERT OR IGNORE`,可安全重复执行;`0004` 删除已废弃的 `key_ips` 表;`0005_profile_pacing.sql` 为 `profiles` 增加 `first_delay_ms INTEGER` / `chars_per_second REAL`(均可为 NULL,表示继承全局)。

配置默认值(`config` 表):

| key | 默认 | 说明 |
|---|---|---|
| first_delay_ms | 300 | 首字延迟毫秒(面板 0–60000) |
| chars_per_second | 30 | 输出速度(面板 0.5–1000) |
| chunk_size | 4 | 每块字符数(面板上限 4096) |
| max_duration_s | 120 | 单次响应时长上限(含首字延迟) |
| max_output_chars | 32000 | 单次输出硬上限 |
| concurrency_limit | 2 | 每 IP 并发上限 |
| over_limit_behavior | truncate | 触顶行为:truncate / reject |
| default_model | loremium-unicode | 未知 model 回退方案 |
| strict_model | false | true 时未知 model 直接 404 |
| cors_origin | * | CORS 允许来源 |
| auth_mode | optional | off / optional / required,见 §5.8 |
| request_log_enabled | true | 是否逐请求落库 `request_logs` |
| request_log_retention_days | 7 | 日志保留天数,每日 Cron 清理 |

> `first_delay_ms`/`chars_per_second` 为全局默认值,每个内容方案可分别覆盖(见 §7);`chunk_size`、`max_duration_s` 不支持按方案覆盖。

## 5. 限流器(Durable Object)

### 5.1 实例模型

- **全局单实例**:`env.LIMITER.idFromName("global")`
- 所有 IP 窗口、Key 配额、并发、轮换状态集中在同一实例,跨 IP 的 Key 总额度天然原子
- 单实例串行处理,每次 acquire/settle 为内存级操作(亚毫秒),免费额度规模(≤5 万次/天)下无吞吐压力

### 5.2 Scope 与状态

| scope 格式 | 用途 |
|---|---|
| `ip:<ipKey>` | 该 IP 的滑动窗口(全局规则或覆盖规则) |
| `key:<keyId>` | Key 总额度(quota_mode=total) |
| `key:<keyId>:<ipKey>` | Key 按 IP 配额(quota_mode=per_ip) |

`ipKey` 为聚合键:IPv4 原样;IPv6 归并到 `/64`(前缀内所有地址共享同一份额度与并发);IPv4-mapped IPv6 归一为 IPv4。策略匹配(单 IP 专属规则/IP 组)仍按原始 IP 精确匹配。

每个 scope 维护一组窗口桶:`buckets[scope] = { "<windowSeconds>": [{ts, chars, pending?}] }`。
另有:`inflight[ipKey]`(并发计数+租约)、`reservations[reservationId]`(未结算预留)、`rotations[key]`(轮换计数器,全局上限 20000 个 key,超出后新 key 不再轮换)。

### 5.3 接口

| 方法 | 入参 | 返回 |
|---|---|---|
| acquire | {ip, concurrencyLimit, reserveCap, scopes:[{scope, rules:[{windowSeconds, limitChars}]}], rotateKeys?: [{key, mode, scope, count, options}]} | {ok:true, reserved, rotations?, reservationId} 或 {ok:false, reason:'concurrency'\|'quota', retryAfterMs, scope?} |
| settle | {ip, scopes:[scopeString], used, reservationId?} | {ok:true}(未知 reservationId 视为已结算,不重复记账) |
| status | {scopes:[scopeString], ip?} | 各 scope 每窗口已用(含未结算预留)、inflight[ip]、rotations |
| reset | {scopes:[scopeString], ip?} | 清空指定窗口/并发/该 IP 的未结算预留 |

### 5.4 算法(伪代码)

```
acquire(ip, concurrencyLimit, reserveCap, scopes, rotateKeys):
  now = Date.now()
  purgeExpired(now)
  if inflight[ip].count >= concurrencyLimit:
      return fail('concurrency', retryAfter = 最早租约释放时间)
  remaining = +∞
  for {scope, rules} in scopes:
      for r in rules:
          used = sum(chars in buckets[scope][r.windowSeconds] within window)
          remaining = min(remaining, r.limitChars - used)
  if remaining <= 0:
      return fail('quota', retryAfter = 累计到额度回落所需时间,多规则取最大)
  reserved = min(remaining, reserveCap)
  # 立即按 reserved 预扣,防止并发请求各拿全额
  for {scope, rules} in scopes:
      for r in rules:
          buckets[scope][r.windowSeconds].push({ts: now, chars: reserved, pending: reservationId})
  reservations[reservationId] = {ip, scopes, expiresAt: now + maxDurationMs + 30s}
  inflight[ip].count += 1; inflight[ip].lease = now + maxDurationMs + 30s
  rotations = resolveRotations(rotateKeys)   # 顺带解析,省一次调用
  return ok(reserved, rotations, reservationId)

settle(ip, scopes, used, reservationId):
  now = Date.now()
  reservation = reservations[reservationId]
  if reservationId:
      scanScopes = reservation ? reservation.scopes : 所有 buckets scope   # 驱逐后 reservation 丢失,全量扫 pending
      for scope in scanScopes:
          for windowSeconds in buckets[scope]:
              将 pending === reservationId 的条目 chars 改写为 used 并清除 pending   # 多扣部分退回
  else:
      # 兼容路径:直接追加 used
  移除该 ip 最早的 lease
  persist()

alarm():
  for each expired lease: inflight[ip].count -= 1(按预留记账,不退还)
  purgeExpired(now); GC 空 scope 与过期 reservations;persist()
```

### 5.5 预留 / 结算 / 退回

- acquire 按 `min(所有 scope 所有规则剩余, max_output_chars, max_tokens)` 预扣:窗口内以 `pending` 条目计入已用,并发请求不再各拿全额
- settle 将 pending 条目的 `chars` 改写为实际产出 `used`(≤ 预留),未用部分即时退回
- 计费口径是**服务端实际生成的字符数**,与客户端是否读完整、是否中断流无关;客户端在流式响应中断开仍按已生成量计费
- 若 Worker 未能 settle(进程被杀等),pending 条目保持预扣额度直到窗口过期,不产生免费额度
- 未认证请求只有 `ip:` scope;`auth_mode=optional` 认证成功或 `auth_mode=required` 认证成功的请求额外有 Key scope;`auth_mode=off` 即使携带有效 Key 也不产生 Key scope;`unlimited` Key 不产生 Key scope

### 5.6 429 响应

- 状态码 429 + `Retry-After: <秒>`
- body 为 OpenAI 错误格式(见 API 文档);message 不包含内部 scope/key id

### 5.7 持久化

- 内存为主,变更后合并写 DO SQLite(表 `buckets`、`inflight`、`rotations`)
- settle 每次必写;acquire 的 inflight 变化最多每秒写一次
- DO 被驱逐后从 SQLite 恢复;桶内时间戳保证窗口自然过期
- 若驱逐后收到携带 `reservationId` 的 settle,内存 reservations 已丢失,则扫描所有 scope 的 pending 条目恢复结算,并始终释放该 IP 的租约

### 5.8 API Key 鉴权流程

`auth_mode`:

| 模式 | 无 Key | 有效 Key | 无效 Key |
|---|---|---|---|
| off | 放行(仅 IP 限流) | 放行(仅 IP 限流,不叠加 Key 配额) | 401 |
| optional(默认) | 放行(仅 IP 限流) | 放行(Key 配额生效) | 401 |
| required | 401 | 放行(Key 配额生效) | 401 |

- `off` 仍校验 Key 有效性(无效 → 401),但不产生 Key 限流 scope,故不叠加 Key 配额

- Key 格式:`sk-lorem-` + 48 位 base62;仅创建时返回一次明文,库中只存 SHA-256 哈希与展示前缀
- 查询:哈希 → `api_keys`;无跨请求缓存,每次请求直接读 D1,管理端变更即时生效
- 校验:enabled=1 且(expires_at 为空或未过期)
- 记录:逐请求日志 `request_logs` 携带 `key_id` 与 `ip`;Key 调用 IP 与用量均由该表聚合(保留期同日志)

### 5.9 IP 分层策略(v1.2)

请求按以下顺序解析,命中即用:

1. **单 IP 专属规则**(`ip_overrides`):规则为空则回退全局;并发为空则回退全局
2. **IP 组**(`ip_groups` + `ip_group_members`):启用组按 priority 升序取第一个命中;成员支持单 IP 与 CIDR(v4/v6);组规则/并发为空回退全局
3. **全局规则**(`rules`):对所有被允许的 IP 生效
4. **未登记 IP 默认策略**(`unlisted_ip_policy`):`allow` 时未登记 IP 套全局规则;`deny` 时直接 403(`permission_error` / `ip_not_allowed`)

多规则仍取最低剩余截断。`GET /admin/api/ip-policy/resolve` 可查看某 IP 命中的层级与实时窗口状态。

## 6. 输出生成与节流

### 6.1 解释器

- 输入:BlockProgram(JSON)+ 额度上限 `budget`
- 递归求值产出字符串;达到 budget 立即停止并标记 truncated
- 随机源:`crypto.getRandomValues`;字符池支持 Unicode 码点范围
- 校验限制(以 `public/js/interpreter.js:11-16` 常量为准):嵌套 ≤ 16 层、节点 ≤ 10000、单次 repeat ≤ 1000000、随机/轮换选项 1–1024、字符池 1–16384 码点、总求值步数 ≤ 50000000、输出 ≤ max_output_chars

### 6.2 节流(流式)

```
sleep(first_delay_ms)                            # 首字延迟,不耗 CPU
for chunk in split(text, chunk_size):
    yield sse_chunk(chunk)
    sleep(chunk_size / chars_per_second * 1000)  # 输出速度
预算耗尽 / 超过 max_duration_s → finish_reason = "length"
否则 → finish_reason = "stop"
```

- 上式两处的 `first_delay_ms` / `chars_per_second` 取自 `resolvePacing(config, profile)`:方案覆盖优先,方案未设置或覆盖值非法时回退全局;`chunk_size`、`max_duration_s` 恒为全局
- sleep 为 wall-clock,不计 CPU;Worker 流式响应期间没有 wall-clock 硬限制,但客户端可能超时,`max_duration_s` 默认 120s
- 非流式:可选仅应用首字延迟后整段返回

### 6.3 SSE 结构

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"content":"▓▒"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

`stream_options.include_usage = true` 时,在 finish 块**之后**追加一个 `choices: []` 且带 `usage` 的块,随后才是 `[DONE]`;此时其余 chunk 带 `"usage": null`。

## 7. 内容方案与轮换

- `profiles` 表:方案 = name + model_id + BlockProgram + 可选节奏覆盖(`first_delay_ms` / `chars_per_second`,NULL 继承全局);内置三套(lorem / unicode-garbage / fixed)
- `rotate` 块:key + mode(cycle | random)+ scope(ip | global)+ options
- 解析时机:随 acquire 响应一并返回(所有请求都会调用 acquire,天然省一次 DO 调用)
- scope=ip 的计数器按 `rotate:<key>:ip:<ip>` 存储;global 按 `rotate:<key>` 存储

## 8. 统计(D1 `request_logs` 聚合)

统计直接对 D1 `request_logs` 做参数化 SQL 聚合,不再使用 Analytics Engine:

- 按小时分桶(`created_at / 3600`):`COUNT(*)` 请求数、`SUM(output_tokens)` 字数、`status >= 400` 计错误
- 活跃 IP:`COUNT(DISTINCT ip)`;series 自动补齐空桶
- 今日调用量、时序图、错误率、Key 用量、调用 IP 均来自 `request_logs`
- **口径限制**:仅覆盖 `request_logs` 保留期内的数据(`request_log_retention_days`,默认 7 天)
- 若 `request_log_enabled=false`,overview / keyUsage 返回 `unavailable:true` 与中文 note,面板显示提示
- Key 调用 IP:`requestLogIpSummary` 聚合 `request_logs`,与 DO 实时数据合并(原 `key_ips` 表已删除)

## 9. 管理面板

- 域名:`admin.ai.example.com`,Cloudflare Access 保护(管理员邮箱 / OTP / SSO)
- Worker 侧双保险:admin 路由要求 Host 在 `ADMIN_HOST` 允许列表内,且 Access 注入的 `Cf-Access-Jwt-Assertion` 通过 RS256 验签(aud/exp/iss,`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`);缺失或无效返回 403。Access 应用放行管理员邮箱(OTP 登录)与自动化服务令牌
- 页面:仪表盘 / 限流 / API Keys / 内容(Blockly)/ 行为 / IP 查询(共 6 个标签,无独立"设置"页)
- API Keys 页:创建(明文仅显示一次)、启停、配额模式与规则、用量曲线、调用 IP 列表、单 Key 实时状态与重置
- 请求日志面板:每个 Key 可查看逐请求明细(时间、模型、状态、输入/输出 token、耗时、流式标记、来源 IP);点击来源 IP 下钻查看该 IP 跨 Key 的全部请求,游标分页(`before`)
- 前端:静态 HTML + Alpine.js + Pico.css + 自托管 Blockly,无构建步骤
- 共享解释器:`public/js/interpreter.js` 同时被浏览器预览与 Worker 引用(wrangler 直接打包),保证预览与实际输出一致
- 管理 API 见 `API.md`

## 10. 安全

- admin 面板仅 Access 可达 + Host 允许列表 + JWT 验签;服务令牌用于自动化;workers.dev 上的 admin 路由因 Host 不匹配自动 403;`ACCESS_AUD` 未配置时直接 403(不信任任何客户端可伪造的请求头)
- admin 写请求强制 `Content-Type: application/json`,带 `Origin` 时其 hostname 必须在 `ADMIN_HOST` 允许列表,否则 403;`DEV_BYPASS_ADMIN=true` 仅在未配置 `ACCESS_AUD` 或请求 host 为 localhost/127.0.0.1/::1 时生效(fail-closed)
- Access JWT 强制校验 `iss`(必须等于 `https://<ACCESS_TEAM_DOMAIN>`)与 `exp`(必须为未来时间),未知 `kid` 触发限频 JWKS 刷新且 fetch 5s 超时;客户端 IP 只取 `CF-Connecting-IP`,不信任 `X-Forwarded-For`
- `/v1` 请求先鉴权后解析 body,未通过鉴权的请求不会被完整读取
- API Key 仅存哈希与前缀,明文只在创建响应中出现一次;面板不可回显
- CORS 默认 `*`(中转站性质),可收紧为白名单;admin 路由不返回 CORS 头,预检不放行
- 输入上限:admin 与 `/v1` 请求体均流式读取并以 1MB 为上限(`/v1` 超出返回 413,admin 超限按非法请求 400 拒绝),`max_tokens` 等仅作近似上限且要求为正整数,非正整数返回 400
- 输出上限:`max_output_chars`,解释器另有节点/深度/循环次数/总步数(5000 万次)护栏
- 静态面板通过 `public/_headers` 与 Worker 响应头附加 nosniff / X-Frame-Options:DENY / Referrer-Policy,以及收紧的 CSP:`default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'`(`'unsafe-eval'` 为 Alpine 3 运行时表达式求值所必需,已实测无它面板无法初始化;仍禁止内联/第三方脚本);原内联引导脚本已移至 `public/js/boot.js`
- 任何密钥(如自动化服务令牌)一律 `wrangler secret put`,不入库、不入代码、不打印日志
- 可选:管理操作审计日志(D1 `admin_audit`,backlog)

## 11. 免费额度预算

| 资源 | 免费额度 | 每次 API 请求消耗 | 推导上限 |
|---|---|---|---|
| Workers 请求 | 100,000/天 | 1(静态资源不计) | 10 万次/天 |
| Workers CPU | 10ms/请求 | <1ms(生成 KB 级文本) | 无压力 |
| DO 请求 | 100,000/天 | 2(acquire + settle) | **约 5 万次/天(瓶颈)** |
| D1 写 | 100,000 行/天 | ~1(逐请求日志,可关闭)+ 配置与 Cron 写 | 无压力 |
| D1 读 | 5,000,000 行/天 | ~5(配置/方案/规则/Key 每次读 + 统计聚合) | 无压力 |
| Static Assets | 免费不限 | - | - |
| Access | 50 用户 | - | - |

**结论:免费额度下实际容量约 5 万次 API 调用/天。** 需要更大容量时可升级 Workers Paid(DO 100 万请求/月,起价 $5)或降级为 D1 计数器方案(轻微竞态)。

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| DO 10 万请求/天 | 容量 ~5 万次/天 | 面板监控调用量;超额可升级或切换 D1 降级方案 |
| 全局单 DO 热点 | 极端并发下排队 | 单次操作亚毫秒,免费规模无压力;必要时按 scope 分片(backlog) |
| Key/配置即时生效 | 无 | 每请求直接读 D1,管理端变更立即生效 |
| D1 读延迟 | 每请求多 ~3–4 次读 | 毫秒级,免费读额度充足 |
| 输出速度过慢 | 客户端超时断开 | `max_duration_s` 默认 120s;面板对速度设下限提示 |
| Access 配置错误 | 面板暴露 | Host + 请求头双校验;关闭 workers.dev 预览域 |
| Blockly CDN 不可用 | 编辑功能不可用 | 自托管到 `public/vendor/blockly` |
| 零宽/组合字符 | 预览显示空白 | 预览器转义展示为 `[U+200B]` 等 |
| 统计仅覆盖日志保留期 | 超过 `request_log_retention_days` 的数据不可查 | 需要更长历史时调大保留期(受 D1 额度约束) |
| 免费计划无 SLA | 偶发 5xx | 可接受;配置读失败则本次请求 500 |

## 13. 决策记录

1. 统计直接聚合 D1 `request_logs`(取代早期 Analytics Engine 方案):简化部署,无需 AE 数据集与查询令牌,口径与日志保留期一致
2. 限流状态放 Durable Object 而非 D1 条件更新:强一致、无竞态
3. 预留/结算模型而非"先输出后记账":防并发超发
4. Blockly 自托管而非 CDN:可用性
5. 单 Worker + Static Assets 而非 Worker + Pages:部署简单、同域
6. Access 而非内置密码登录:零代码、更安全
7. `max_tokens` 按 1 token : 1 字符近似:简单且可预期
8. IP 规则、Key 配额、并发统一收敛到同一 DO 的 scope 模型:取最小截断逻辑只有一处
9. v1.1 由"每 IP 一个 DO"改为"全局单实例":Key 总额度跨 IP 必须原子,免费规模下单实例足够
10. API Key 只存哈希:泄露数据库也无法还原 Key;明文仅创建时返回一次
11. 逐请求明细与统计统一落 D1 `request_logs`(默认开,可关,保留 7 天);Key 调用 IP 由该表聚合 + DO 实时合并,不再维护 `key_ips`(已由 0004 删除):面板需要请求级下钻,1 行/请求在免费写额度内
12. 首字延迟与输出速度支持按内容方案覆盖、NULL 回退全局值(`resolvePacing`):不同假模型可独立设定节奏,同时保留全局默认;非法覆盖值在解析时静默回退全局而非拒绝请求

## 14. 部署拓扑与绑定

```jsonc
// wrangler.jsonc(草图)
{
  "name": "loremium",
  "main": "src/index.js",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "public",
    "binding": "ASSETS",
    "run_worker_first": ["/v1/*", "/admin/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "loremium", "database_id": "<部署时填入>" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "LIMITER", "class_name": "Limiter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Limiter"] }],
  "triggers": { "crons": ["0 4 * * *"] },
  "observability": { "enabled": true }
}
```

无需 Analytics Engine 数据集或 `AE_QUERY_TOKEN`;部署仅需已有 D1 与 Access 配置。

域名与 Access(手动步骤,见 `PLAN.md` 部署清单):`ai.example.com`(API,公开)与 `admin.ai.example.com`(面板,Access 保护)均作为 Custom Domain 绑定到同一个 Worker。
