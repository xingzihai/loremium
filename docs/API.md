# Loremium API 规范

## 1. 通用约定

- API 主机:`https://ai.example.com`
- 管理面板:`https://admin.ai.example.com`(Cloudflare Access 保护)
- 鉴权:[API Key 机制](#11-api-key-机制),由 `auth_mode` 控制(off / optional / required)
- 请求 `Content-Type: application/json`;流式响应 `Content-Type: text/event-stream`
- CORS:按 `cors_origin` 配置返回;`OPTIONS *` 返回 `204`
- 错误统一为 OpenAI 格式:

```json
{
  "error": {
    "message": "Rate limit exceeded for this IP. Retry after 42 seconds.",
    "type": "rate_limit_exceeded",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

- 限流响应带 `Retry-After: <秒>` 响应头;额度类 429 的值为**累计到额度回落所需时间**(多规则取最大),并发类为最早租约释放时间

### 1.1 API Key 机制

Key 格式:`sk-lorem-` + 48 位 base62。请求头 `Authorization: Bearer <key>`。

鉴权模式(`auth_mode` 配置):

| 模式 | 无 Key | 有效 Key | 无效 Key |
|---|---|---|---|
| off | 放行(仅 IP 限流) | 放行(仅 IP 限流,即使 Key 有效也不叠加 Key 配额) | 401 |
| optional(默认) | 放行(仅 IP 限流) | 放行(Key 配额生效) | 401 |
| required | 401 | 放行(Key 配额生效) | 401 |

`off` 模式下仍校验 Key 有效性(无效返回 401),但不产生 Key 限流 scope,因此不叠加 Key 配额。

Key 配额模式(`quota_mode`,规则为 `[{window_seconds, limit_chars, enabled?, note?}]`,多规则取最小截断;`enabled:false` 的规则不参与限流,`note` 仅作展示):

| 模式 | 说明 |
|---|---|
| unlimited | Key 无独立配额,仅受 IP 规则限制 |
| per_ip | 配额的每个 IP 独立计算(Key + IP 维度) |
| total | 配额的该 Key 所有 IP 共享总额度 |

最终单次可输出字符数 = min(各 IP 规则剩余,各 Key 规则剩余,`max_tokens` 换算值,`max_output_chars`)。

IP 维度按聚合键计数:IPv4 按单地址,IPv6 按 `/64` 前缀(同一 /64 内所有地址共享额度与并发);管理面板的策略匹配仍按原始 IP。

额度在请求开始时预扣,结算时按服务端实际生成字符数回填;客户端中断流式响应也按已生成量计费。请求体上限 1MB,超出返回 413。

调用 IP 记录:每次请求写入 D1 `request_logs`;管理面板据此聚合 Key 的调用 IP 列表与前缀(与 DO 实时数据合并)。

## 2. GET /v1/models

列出所有启用方案对应的假模型。

响应:

```json
{
  "object": "list",
  "data": [
    { "id": "loremium-default",  "object": "model", "created": 1759536000, "owned_by": "loremium" },
    { "id": "loremium-lorem",    "object": "model", "created": 1759536000, "owned_by": "loremium" },
    { "id": "loremium-unicode",  "object": "model", "created": 1759536000, "owned_by": "loremium" }
  ]
}
```

## 3. POST /v1/chat/completions

### 3.1 请求字段

| 字段 | 处理 |
|---|---|
| `model` | 映射到内容方案;未知 model 回退 `default_model`(strict_model=true 时 404) |
| `messages` | 仅用于估算 prompt_tokens,内容无关;可为空数组 |
| `stream` | true 走 SSE;缺省 false |
| `stream_options.include_usage` | true 时在 finish 块**之后**追加 usage 块(`choices` 为空数组),且其余 chunk 带 `"usage": null` |
| `max_tokens` / `max_completion_tokens` / `max_output_tokens` | 按 1 token : 1 字符换算为本次字符上限,与其他上限取最小;非正整数返回 400 |
| 其他字段(temperature、top_p 等) | 忽略 |

### 3.2 非流式响应

```json
{
  "id": "chatcmpl-9xK2mQ0fTz",
  "object": "chat.completion",
  "created": 1759536000,
  "model": "loremium-unicode",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "▓▒░█▄▀..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 128, "total_tokens": 140 }
}
```

### 3.3 流式响应(SSE)

```
data: {"id":"chatcmpl-9xK2mQ0fTz","object":"chat.completion.chunk","created":1759536000,"model":"loremium-unicode","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-9xK2mQ0fTz","object":"chat.completion.chunk","created":1759536000,"model":"loremium-unicode","choices":[{"index":0,"delta":{"content":"▓▒"},"finish_reason":null}]}

data: {"id":"chatcmpl-9xK2mQ0fTz","object":"chat.completion.chunk","created":1759536000,"model":"loremium-unicode","choices":[{"index":0,"delta":{"content":"░█"},"finish_reason":null}]}

data: {"id":"chatcmpl-9xK2mQ0fTz","object":"chat.completion.chunk","created":1759536000,"model":"loremium-unicode","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

`include_usage = true` 时,在 `finish_reason` 块**之后**、`[DONE]` 之前追加 usage 块(`choices` 为空数组;`completion_tokens` 为实际下发字符数);此时其余 chunk 均带 `"usage": null`:

```
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":128,"total_tokens":140}}

```

### 3.4 字段语义

| 字段 | 值 |
|---|---|
| `id` | `chatcmpl-` + 随机 base62 |
| `finish_reason` | `stop`(自然结束)/ `length`(触顶截断、预算耗尽、超时) |
| `usage.prompt_tokens` | `JSON.stringify(messages).length / 4` 向上取整(模拟值) |
| `usage.completion_tokens` | 实际输出字符数(1 token = 1 字符近似) |
| `usage.total_tokens` | 两者之和 |

## 4. POST /v1/completions

兼容旧版接口。

- 请求:`prompt`(字符串或数组)、`model`、`stream`、`max_tokens`
- 非流式响应:`object` 为 `text_completion`,`choices[0].text` 为输出,无 `message`
- 流式:每个 chunk 的 `choices[0]` 含 `text` 字段(非 `delta`),`object` 为 `text_completion`

## 5. POST /v1/responses

OpenAI Responses API 兼容(Codex CLI / 新版 SDK 使用)。

- 请求:`input`(字符串、消息数组或对象,必填)、`model`、`stream`、`max_output_tokens`、`instructions`;其余字段忽略
- 非流式响应:`object` 为 `response`,输出位于 `output[0].content[0].text`(SDK 的 `output_text`);`status` 为 `completed`,触顶时为 `incomplete` 且 `incomplete_details.reason=max_output_tokens`;响应回显请求中的 `instructions` 与实际解析出的 `max_output_tokens`(未提供则为 `null`)
- 流式:标准命名事件序列 `response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → 多个 `response.output_text.delta` → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`(截断时为 `response.incomplete`);不以 `[DONE]` 结尾。`response.created`/`response.in_progress` 的 `incomplete_details` 为 `null`,仅 `response.incomplete` 带 `reason`;watchdog 超时(超过 `max_duration_s`)会补发 `response.incomplete` 等终止事件
- `usage` 字段为 `input_tokens` / `output_tokens` / `total_tokens`;流式 `output_tokens` 等于实际已下发字符数(客户端中断/超时口径一致)

## 6. 错误码

| 状态 | type | 场景 |
|---|---|---|
| 400 | invalid_request_error | JSON 非法、缺少 model/messages/prompt/input 等;`max_tokens`/`max_completion_tokens`/`max_output_tokens` 非正整数 |
| 401 | authentication_error | auth_mode=required 且无 Key;或提供了无效/过期/停用的 Key |
| 404 | not_found_error | 未知路径;strict_model 下未知 model |
| 413 | invalid_request_error | 请求体超过 1MB |
| 429 | rate_limit_exceeded | 并发超限或额度耗尽,带 `Retry-After` |
| 500 | internal_error | 未预期异常 |

## 7. 管理 API

前缀 `https://admin.ai.example.com/admin/api`,经 Cloudflare Access + Worker 双重校验。写请求强制 `Content-Type: application/json`(否则 403),跨源 `Origin` 不在 `ADMIN_HOST` 允许列表时 403;服务端只认 `CF-Connecting-IP` 作为客户端 IP,不信任 `X-Forwarded-For`;响应带 `Cache-Control: no-store`。响应统一 `{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/overview?hours=24` | 调用量/字数/错误数/活跃 IP/时序数组;参数化 SQL 聚合 D1 `request_logs`(series 补齐空桶);`request_log_enabled=false` 时返回 `unavailable:true` + 中文 note |
| GET | `/config` | 读取全部配置 |
| PUT | `/config` | 批量更新配置(`{key: value, ...}`) |
| GET | `/profiles` | 方案列表 |
| POST | `/profiles` | 新建方案(name, model_id, program, is_default, first_delay_ms?, chars_per_second?) |
| PUT | `/profiles/:id` | 更新方案(增量,字段同 POST;节奏覆盖传 `null` 或 `""` 清除并继承全局) |
| DELETE | `/profiles/:id` | 删除方案(默认方案不可删) |
| POST | `/profiles/validate` | 校验 BlockProgram(`{program}` → 校验结果) |
| GET | `/rules` | 限流规则列表 |
| POST | `/rules` | 新建规则(window_seconds, limit_chars, enabled, note) |
| PUT | `/rules` | **整体替换**全部全局规则(`{rules:[{id?, window_seconds, limit_chars, enabled, note}]}`,D1 单事务先 DELETE 再 INSERT) |
| PUT | `/rules/:id` | 更新单条规则 |
| DELETE | `/rules/:id` | 删除单条规则 |
| GET | `/ip-overrides` | IP 覆盖列表 |
| PUT | `/ip-overrides/:ip` | 设置覆盖(`{concurrency?, rules?, expires_at?, note?}`) |
| DELETE | `/ip-overrides/:ip` | 删除覆盖 |
| GET | `/ip/:ip/status` | 该 IP 的 DO 实时状态(各窗口已用字符数与窗口秒数、inflight、rotations;原始响应不含剩余/上限,剩余由调用方结合生效规则计算) |
| POST | `/ip/:ip/reset` | 清空该 IP 的窗口与并发 |
| GET | `/api-keys` | Key 列表(不含哈希,仅前缀) |
| POST | `/api-keys` | 新建 Key(name, quota_mode, quota_rules, expires_at?, note),响应含**一次性明文** |
| PUT | `/api-keys/:id` | 更新 Key(name, quota_mode, quota_rules, enabled, expires_at, note) |
| DELETE | `/api-keys/:id` | 删除 Key(D1 删除 `api_keys`,并清理 DO 中该 Key 的 scope/live IP 记录) |
| GET | `/api-keys/:id/status` | 该 Key 的 DO 实时状态(各窗口已用;total 模式全局,per_ip 模式按 `request_logs` 聚合出的最近 IP 列表;剩余需结合 Key 配额规则计算) |
| POST | `/api-keys/:id/reset` | 清空该 Key 的所有窗口 |
| GET | `/api-keys/:id/usage?days=7` | Key 聚合用量(请求数、字数、时序;聚合 D1 `request_logs`,保留期同日志) |
| GET | `/api-keys/:id/ips` | 调用 IP 列表(合并 D1 `request_logs` 聚合与 DO 实时数据,含请求数/字数/首末时间) |
| GET | `/stats` | 明细统计(`from, to, ip, model, status, key_id, limit`;参数化 SQL 查 D1 `request_logs`,`limit` ≤ 1000;无数据时返回空数组) |
| GET | `/logs` | 逐请求日志(`key_id`, `ip`, `before`(id 游标), `limit` 默认 100/上限 500);返回 `{items, nextBefore}`,item 含 `createdAt, keyId, ip, model, profile, status, finishReason, inputTokens, outputTokens, durationMs, ttftMs, isStream` |
| GET | `/ip-groups` | IP 组列表(含 memberCount) |
| POST | `/ip-groups` | 新建 IP 组(name, priority, concurrency?, rules?, enabled?, note?) |
| PUT | `/ip-groups/:id` | 更新 IP 组 |
| DELETE | `/ip-groups/:id` | 删除 IP 组(级联成员) |
| GET | `/ip-groups/:id/members` | 组成员列表 |
| POST | `/ip-groups/:id/members` | 批量加成员 `{values:[...]}`,每项 IP 或 CIDR,返回 `{added, invalid}` |
| DELETE | `/ip-groups/:id/members/:value` | 删除成员(value 为 URL 编码原始值) |
| GET | `/ip-policy/resolve?ip=x` | 策略判定:命中层级(source/groupId/groupName)、生效规则、并发、实时窗口状态;未登记禁止时 `allowed:false` |
| GET | `/overview?range=today` | 今日(自然日,按 `stats_tz_offset`)统计;兼容 `?hours=N` |
| GET | `/api-keys/:id/ips` | 调用 IP:`{ip,requests,chars,firstSeen,lastSeen,live}`;历史来自 `request_logs` 聚合,live 来自 DO 实时 |

IP 分层策略(判定顺序):单 IP 专属规则 `ip_overrides` → 启用 IP 组(按 priority 升序,支持 CIDR)→ 全局 `rules` → 未登记 IP 默认策略 `unlisted_ip_policy`。禁止时 `/v1` 返回 403,`error.type='permission_error'`、`error.code='ip_not_allowed'`。

全局规则批量保存(`PUT /admin/api/rules`):请求体 `{rules:[{id?, window_seconds, limit_chars, enabled, note}]}`,语义为**整体替换全部全局规则**——先 `DELETE FROM rules` 再逐条 INSERT,由 D1 `batch` 单事务执行;任一行非法则整体放弃(不会出现"删了一半"的半损坏状态)。`window_seconds` 必填且必须 > 0,`limit_chars` 必填且必须 ≥ 0,`enabled` 缺省为 true,`note` 可空,`id` 可选(提供时按该 id 重建以保持稳定排序)。非法行返回 400 `{"ok":false,"error":"invalid_rule_window"}` 或 `invalid_rule_limit`;传空数组即清空全部规则。`POST /rules`、`PUT /rules/:id`、`DELETE /rules/:id` 仍保留用于单条操作,其中 `POST/PUT` 同样做服务端校验(`window_seconds` 必填且 > 0、`limit_chars` 必填且 ≥ 0,非法返回 400)。

内容保存强校验:`POST/PUT /profiles` 在写库前调用 `validateProgram`,不通过返回 400 `{ok:false,error:'invalid_program',details:[...]}`。

**方案节奏覆盖(per-profile pacing)**:`POST/PUT /profiles` 额外接受两个可选字段,支持 camelCase `firstDelayMs`/`charsPerSecond` 或 snake_case `first_delay_ms`/`chars_per_second`,分别覆盖全局 `config.first_delay_ms`/`chars_per_second`。传 `null` 或空字符串 `""`(创建时字段缺省)表示**清除覆盖、继承全局**;`GET /profiles` 返回的每个方案含 `firstDelayMs`/`charsPerSecond`,值为 `null` 即继承全局。服务端与全局配置一致**不做范围校验**(面板表单限制 `firstDelayMs` 0–60000、`charsPerSecond` 0.5–1000);生成阶段若覆盖值非法(非有限数、`firstDelayMs < 0`、`charsPerSecond <= 0`)则回退全局。`chunk_size`、`max_duration_s` 仍为全局配置,不支持按方案覆盖。覆盖对流式与非流式均生效。

逐请求日志由配置项 `request_log_enabled`(默认 `true`)控制,保留 `request_log_retention_days`(默认 7)天,每日 Cron 清理;写入异步进行,失败不影响 API 响应。

### 7.1 API Key 创建响应示例

```json
{
  "ok": true,
  "data": {
    "id": "key_8f2a1c",
    "name": "demo-client",
    "key": "sk-lorem-9xK2mQ0fTz...",
    "key_prefix": "sk-lorem-9xK2mQ…",
    "quota_mode": "total",
    "quota_rules": [{ "window_seconds": 3600, "limit_chars": 20000, "enabled": true, "note": "" }],
    "enabled": true
  }
}
```

`key` 字段仅此一次返回,之后任何接口都不再显示。

`quota_rules` 每条支持 `enabled`(缺省 true;`false` 的规则被 `keyScopes()` 过滤,不再参与 Key 配额限流)与 `note`(备注,仅展示)。创建/更新 Key 时均接受数组形式,服务端会把规则规范化后以 JSON 存入 `api_keys.quota_rules`。

### 7.2 /overview 响应示例

```json
{
  "ok": true,
  "data": {
    "requests": 1234,
    "chars": 987654,
    "errors": 17,
    "activeIps": 42,
    "series": [
      { "t": "2026-10-04T00:00:00Z", "requests": 50, "chars": 40000 }
    ]
  }
}
```

统计口径:聚合 D1 `request_logs`,仅覆盖日志保留期(`request_log_retention_days`,默认 7 天)内的数据;若 `request_log_enabled=false`,`/overview` 与 `/api-keys/:id/usage` 返回 `{unavailable:true, note}`(中文提示),面板据此显示"日志已关闭";`/stats` 不套用该降级包装,无数据时返回空数组。
