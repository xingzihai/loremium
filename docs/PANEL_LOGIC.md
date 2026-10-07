# Loremium 管理面板逻辑审计(PANEL_LOGIC)

审计日期:2026-10-04 · 最后同步:2026-10-05(统计改为 D1 `request_logs` 聚合后) · 审计方式:只读通读代码,未修改任何文件 · 引用格式:`文件:行号`

> **2026-10-05 同步说明**:面板成熟化改造后本文已重校。此前版本中"`public/js/blocks.js` 是死文件/调用即抛错""`public/vendor/blockly` 不存在""内容页无图形化、无预览""保存方案不做校验""规则/覆盖只能手写 JSON""限流窗口只能填秒""没有自然日今日选项"等结论均已失效,已在对应小节更正。
>
> **2026-10-05 统计重构同步**:统计功能已从 Cloudflare Analytics Engine 改为直接聚合 D1 `request_logs`。本文中"统计依赖 AE 绑定/AE_QUERY_TOKEN/CF_ACCOUNT_ID""Key 调用 IP 经 Cron 每小时落 `key_ips`、延迟 1–2 小时"等结论均已失效;`src/stats.js` 现导出 `overview/overviewToday/queryStats/keyUsage/cleanup`,Cron 仅剩每日一条。§3 的 `admin-api.js` 行号已按当前代码更新;`public/js/app.js`、`public/index.html` 行号仍为改造后快照。
>

本文回答三个问题:面板上的每个按钮/输入框实际做了什么、后端每个接口到底操作了什么、这些操作与原始需求的差距在哪里。

---

## 1. 页面加载链路

### 1.1 静态资源与脚本加载

1. 浏览器访问管理域(如 `admin.example.com`,见 `wrangler.example.jsonc`),HTML 由 Static Assets 直接返回(`wrangler.jsonc:5-9` 中只有 `/v1/*`、`/admin/api/*` 强行进 Worker;其余走 `env.ASSETS.fetch`,见 `src/index.js:384`)。
2. `public/index.html:8-9` 加载本地 Pico.css 与 `style.css`(第 7 行为内联 SVG favicon);`index.html:10` 注册 `alpine:init` 监听;`index.html:11` 加载 `app.js`(defer),`index.html:12` 加载 `public/vendor/alpine.min.js`(defer)。两者按文档顺序执行,所以 `app.js` 先运行并把对象挂到 `window.__loremiumAdmin`(`public/js/app.js:1519`)。
3. `app.js` 以**动态 import** 按需加载 `blocks.js` 与 `interpreter.js`:`ensureBlockly()` 在切到积木模式时 `await import('/js/blocks.js')`(`app.js:586-602`),`previewProfile()` 在预览时 `await import('/js/interpreter.js')`(`app.js:670-685`)。`public/js/blocks.js` 已是完整实现(注册 8 种积木并导出 `mountBlocklyEditor`/`compileToProgram` 等),`public/vendor/blockly/` 目录存在(`blockly.min.js`、`msg/zh-hans.js`、`media/`)。§5-G1 的"死文件/调用即抛错"结论作废。

### 1.2 Alpine 初始化

- `alpine:init` 触发时执行 `window.Alpine.data('admin', () => window.__loremiumAdmin || {})`(`index.html:10`)。
- `<body x-data="admin" x-init="init()">`(`index.html:14`)取用该单例对象作为面板状态,并在挂载后调用 `init()`。

### 1.3 `init()` 实际发出的请求

`app.js:268-284`:解析 `location.hash` 初始化 tab,注册 `hashchange` 监听,然后 `await Promise.all([...])` **并行**发起七个 GET。每个函数内部用 `guard()` 捕获异常(`app.js:305-311`),单个失败写入全局错误横幅(`app.js:300-303`),不阻断其他请求;错误横幅现在**固定置顶且需手动关闭**,不再 5 秒自动消失:

| 顺序 | 调用 | 端点 | 代码位置 |
|---|---|---|---|
| 1 | `loadOverview()` | `GET /admin/api/overview`(默认 24h;可选 `range=today`) | app.js:275,313-328 |
| 2 | `loadConfig()` | `GET /admin/api/config` | app.js:276,414-430 |
| 3 | `loadProfiles()` | `GET /admin/api/profiles` | app.js:277,491-500 |
| 4 | `loadRules()` | `GET /admin/api/rules` | app.js:278,773-778 |
| 5 | `loadOverrides()` | `GET /admin/api/ip-overrides` | app.js:279,1101-1106 |
| 6 | `loadIpGroups()` | `GET /admin/api/ip-groups` | app.js:280,948-953 |
| 7 | `loadKeys()` | `GET /admin/api/api-keys` | app.js:281,1259-1264 |

### 1.4 请求封装

- `request(method, path, body)`(`app.js:84-105`):`fetch('/admin/api'+path)`;只要 `res.ok=false`、响应非 JSON、或 `payload.ok !== true` 就 throw(`app.js:97-103`),错误统一进 `error` 横幅;成功返回 `payload.data`。
- 后端入口还有一层门禁:`/admin/api` 必须 Host ∈ `ADMIN_HOST`(`wrangler.jsonc:26`),且 Access 校验通过(JWT 验签),否则 403(`src/index.js:386-407`);仅当 `DEV_BYPASS_ADMIN==='true'` 且(未配置 `ACCESS_AUD` 或请求 host 为 localhost/127.0.0.1/::1)时才跳过(fail-closed)。此外还校验 Origin 与写请求 `Content-Type: application/json`,客户端 IP 只认 `CF-Connecting-IP`。

---

## 2. 六个标签页的完整逻辑链

标签切换统一走 `setTab(tab)`(`app.js:286-290`):设置 `this.tab` 并把 `#dashboard/#limits/#keys/#content/#behavior/#ip` 写入 `location.hash`;`init()` 注册的 `hashchange` 监听(`app.js:271-274`)让浏览器前进/后退与刷新都可停留在当前 tab。切换本身不触发额外请求(首次进入时 `init()` 已并行拉取七份数据)。

### 2.1 仪表盘(`index.html:41-81`)

**链路 1:时间范围下拉 + 刷新按钮**
`index.html:46-52` `select x-model="overviewRange"`(选项含 `today`(自然日)、6/24/72/168 小时;`@change`)或 `index.html:54` 刷新按钮 → `loadOverview()`(`app.js:313-328`):`today` 走 `GET /admin/api/overview?range=today`,否则 `?hours=N` → `admin-api.js:209-217` 分支 → `stats.overview()` / `overviewToday()` → **聚合 D1 `request_logs`(参数化 SQL,按小时分桶)** → 返回 `{requests, chars, errors, activeIps, series[]}` → 赋给 `this.overview` → 四张卡片 `x-text` 渲染(`index.html:58-63`),时序图用 `barHeight()` 算高度(`app.js:330-332`)、`overviewMax()` 标峰值(`index.html:67`)。
横轴标签做了**抽稀**:`tickEvery(n)` 在序列 > 24 根时每 `ceil(n/12)` 根标一次(`app.js:352-355`),`timeTickLabel()` 在范围 > 24h 时显示"月/日"、否则显示"时:00"(`app.js:357-364`),`chartTickLabel()` 按当前范围选择(`app.js:366-370`);每个柱子 `:title` 悬停显示完整时间/次数/字符(`index.html:73`),序列 > 24 时页面给出抽稀提示(`index.html:79`)。

**链路 2:日志关闭时的统计降级**
`admin-api.js` 的 `withLogNote()`(`admin-api.js:182-189`):当 `request_log_enabled=false` 时给 `/overview`、`/api-keys/:id/usage` 的响应补 `unavailable:true` + 中文 `note` → 前端显示灰色提示(`index.html:57`),**不报错**;此时统计自然为 0(因为聚合源 `request_logs` 无数据)。统计仅覆盖 `request_log_retention_days`(默认 7 天)内的数据。

### 2.2 限流(`index.html:82-254`)

**链路 3:刷新**
`index.html:85` → `reloadLimits()`(`app.js:748-750`)并行 `loadRules()`、`loadOverrides()`、`loadIpGroups()`(三个 GET)。

**链路 4:总体策略(只读)**
限流页顶部的"未登记 IP 默认策略"只展示当前值并提供跳转按钮(`index.html:88-95`,`@click="tab='behavior'"`);该值**仅在行为页可改**,限流页不再提供编辑入口。

**链路 5:全局规则「编辑」/「编辑全部规则」/「删除」**
单条编辑 → `openGlobalRuleEditor(r)`(`index.html:112`,`app.js:792-802`);「编辑全部规则」→ `openGlobalRulesEditor()`(`index.html:99`,`app.js:780-790`),两者都打开规则弹窗(`ruleEditor`)并记录快照用于脏检查。
删除 → `deleteRule(r)`(`index.html:113`,`app.js:940-947`)→ `confirm` → `DELETE /admin/api/rules/:id` → `admin-api.js:267-269` → `config.js:284-288 deleteRule()` → **D1 `DELETE FROM rules`** → 重新 `loadRules()`。

**链路 6:规则弹窗编辑与保存(含模板/批量事务)**
弹窗(`index.html:653-693`)逐行编辑:窗口"数值 + 单位(秒/分钟/小时/天)"、限额(字符)、备注、启用;每行有"窗口/限额模板"下拉,`applyRulePreset()`(`app.js:831-837`)按 `RULE_PRESETS`(`app.js:21-26`)一键填入 5 分钟/5000、15 分钟/1 万、1 小时/2 万、1 天/10 万;实时预览 `rulePreview()`。
「确定」→ `confirmRuleEditor()`(`app.js:872-904`):先 `validateRuleRows()`(`app.js:839-853`)做字段级校验(窗口 > 0、限额 ≥ 0),错误写 `ruleEditorError` 标红;全局规则走 `saveGlobalRuleRows()`(`app.js:911-938`):单条用 `PUT /rules/:id`,**整体保存用 `PUT /admin/api/rules`(请求体 `{rules:[...]}`)** → `admin-api.js:269-277` → `config.replaceRules()`(`config.js:299-326`)**在一个 D1 `batch` 内先 DELETE 再 INSERT**,失败整体回滚,不再出现"删了一半"的半损坏状态;`createRule`/`updateRule` 仍保留供单条接口使用。弹窗关闭有**未保存脏检查**(`ruleEditorIsDirty()`/`requestCloseRuleEditor()`,`app.js:855-864`),保存中禁止关闭(`savingRules`)。

**链路 7:IP 组与成员管理**
新建/编辑 `index.html:126-175`(`newGroup`/`editGroup`/`saveGroup`,`app.js:962-1016`);成员管理 `openMembers()`/`submitMembers()`/`deleteMember()`(`app.js:1034-1099`),批量添加每行一个 IP 或 CIDR;后端 `POST/PUT/DELETE /ip-groups` 与 `/ip-groups/:id/members`(`admin-api.js:287-327`)。

**链路 8:单 IP 专属规则**
表格「编辑/删除」(`index.html:216-227`);编辑 → `editOverride(o)`(`app.js:1112-1121`,时间转 `datetime-local`);规则不再手写 JSON,而是与全局规则共用同一弹窗(`openRuleEditorFor('override')`,`app.js:891-896` 写回表单)。保存 → `saveOverride()`(`app.js:1123-1148`)→ `PUT /admin/api/ip-overrides/:ip` → `admin-api.js:276-280` → `config.js:355-376 upsertIpOverride()` → **D1 `INSERT ... ON CONFLICT(ip) DO UPDATE`**。

**链路 9/10:IP 实时状态查询与重置 → 已迁至「IP 查询」页**
限流页**移除了重复的"实时查询"**;`loadIpStatus()`/`resetIp()`(`app.js:1488-1516`)现仅在「IP 查询」标签页提供(见 §2.6)。

### 2.3 API Keys(`index.html:255-449`)

**链路 11:刷新**
`index.html:258` → `loadKeys()`(`app.js:1259-1264`)→ `GET /admin/api/api-keys` → `admin-api.js:378` → `keys.js:123-126 listKeys()` → **D1 `SELECT * FROM api_keys`**(`rowKey` 只映射前缀,不含哈希,`keys.js:75-88`)→ `this.keys` 渲染表格。

**链路 12:创建/编辑 Key 表单**
`index.html:263-288`:名称、配额模式(`unlimited/per_ip/total`)、过期时间、备注、配额规则(通过规则弹窗编辑,`index.html:274-283`)→ `saveKey()`(`app.js:1290-1326`),提交按钮有 `savingKey` busy/disabled 防重复:
- 非 unlimited 且规则非法或为空 → 前端直接报错(`app.js:1296-1303`);
- 无 id → `POST /api-keys` → `admin-api.js:379-391` → `keys.js:132-164 createKey()` → **D1 INSERT `api_keys`**(SHA-256 哈希 + 前缀,明文只存在响应里)→ 返回 `{...key, key: 明文}` → 一次性明文弹窗(`index.html:640-651`);该弹窗**不允许点遮罩关闭**,只能点「复制明文」或「我已保存」。
- 有 id → `PUT /api-keys/:id` → `admin-api.js:392-397` → `keys.js:166-204` → **D1 UPDATE**。

**链路 13:停用/启用 / 用量 / 调用 IP / 状态 / 请求日志 / 重置 / 删除**
Key 表格操作列改为「编辑」+「更多」(`index.html:296-324`);「更多」展开二级行,包含:停用启用(`toggleKey` `app.js:1328-1335`)、用量(`loadKeyUsage` `app.js:1370-1379`)、IP(`loadKeyIps` `app.js:1381-1391`)、状态(`loadKeyStatus` `app.js:1400-1409`)、请求日志(`openKeyLogs` `app.js:1411-1417`)、重置(`resetKey` `app.js:1463-1474`)、删除(`deleteKey` `app.js:1337-1344`);**重置与删除使用危险样式** `btn-danger`。
重置对 `unlimited` 模式会直接提示"没有可重置的配额窗口"并不发请求(`app.js:1464-1468`),修正了旧版"空操作却提示已重置"的误导。

**链路 14:Key 详情(单一面板内 Tab)**
点击「用量/IP/状态/请求日志」打开同一详情面板(`index.html:329-448`),`switchKeyDetail(tab)`(`app.js:1351-1359`)在**用量 / 调用 IP / 实时状态 / 请求日志**四个页签间切换:
- 用量:`GET /api-keys/:id/usage?days=7` → `admin-api.js:440-444` → 聚合 D1 `request_logs` 按 `key_id`,卡片 + 近 7 天趋势(含峰值标注与标签抽稀);`request_log_enabled=false` 时降级 0 + `unavailable`。
- 调用 IP:`GET /api-keys/:id/ips` → `admin-api.js:445-461`,合并 `request_logs` 聚合(`requestLogIpSummary`)与 DO 实时行,标注"实时/历史",空列表有提示(`index.html:380`,已随本次重构更新为"历史行来自请求日志聚合")。
- 实时状态:`GET /api-keys/:id/status` → `admin-api.js:432-435`;先由 `keyScopeList()`(`admin-api.js:191-203`)决定 scope:total→`key:<id>`;per_ip→聚合 D1 `request_logs`(`requestLogIpSummary`,取最近 50 个 IP)拼 `key:<id>:<ip>` + 前缀;unlimited→空 → DO `status`;前端渲染为**中文表格**(进行中请求/窗口用量/内容轮换计数),原始 JSON 收进 `<details>` 折叠(`index.html:382-415`),不再裸 JSON。
- 请求日志:`GET /logs?key_id=…`(`admin-api.js:451-461`),点击来源 IP 可下钻为跨 Key 全部请求(`openIpLogs` `app.js:1419-1425`),游标分页。

### 2.4 内容(`index.html:450-524`)

**链路 19:刷新 / 列表选择 / 新建**
`index.html:453` → `loadProfiles()`(`app.js:507-514`)→ `GET /profiles` → `admin-api.js:231` → `config.js:129-136 listProfiles()` → **D1 `SELECT * FROM profiles`** → 左侧列表(`index.html:463-471`);「新建方案」→ `newProfile()`(`app.js:546-553`,表单含两个节奏覆盖输入,默认留空);点击某方案 → `editProfile(p)`(`app.js:555-571`,把 `program` 对象 `JSON.stringify(...,2)` 填进文本框并同步到积木,`firstDelayMs`/`charsPerSecond` 为 null 时回填空字符串)。

**链路 20:双编辑模式(积木 / JSON)与示例插入**
`index.html:478-481` 切换「积木编辑 / JSON 编辑」→ `setProfileMode()`(`app.js:635-656`):切积木时先解析 JSON,失败则留在 JSON 模式并报错;成功则 `ensureBlockly()`(`app.js:586-602`,动态 `import('/js/blocks.js')` 并 `loadBlockly()`)、`mountBlocks()`(`app.js:604-633`)装载 Blockly 工作区,改动经 `onChange` 同步回 JSON 文本。
「插入示例」按钮(`index.html:484-489`)→ `insertProfileExample()`(`app.js:520-527`),`profileExamples` 提供回显请求输入、随机中文乱码、Lorem 占位、轮换问候语四种(`app.js:502-518`),同时写入文本框与积木工作区。

**链路 21:校验与预览**
校验 → `validateProfile()`(`app.js:658-668`)→ `POST /profiles/validate {program}` → `admin-api.js:228-232` → `public/js/interpreter.js` 的 `validateProgram()`(纯前端共享代码,Worker 打包)→ 返回 `{ok, errors[]}` → 页面显示通过/失败(`index.html:502-511`,错误详情经 `humanizeDetail()` 中文化)。
预览 → `previewProfile()`(`app.js:670-685`)→ `await import('/js/interpreter.js')` 调 `interpret(program, {budget:2000, inputs})`,显示在 `index.html:513-521`;零宽字符以 `[U+200B]` 标注。

**链路 22:保存/创建(保存前强制校验)**
`index.html:474-504` → `saveProfile()`(`app.js:770-831`,提交按钮 `savingProfile` busy/disabled):先本地 `JSON.parse`,再 `POST /profiles/validate`,**校验不通过则阻止保存**;随后本地校验两个节奏覆盖输入——「首字延迟覆盖(毫秒)」须为 0–60000、「输出速度覆盖(字符/秒)」须为 0.5–1000,留空则不校验;通过后按有无 id 走 `PUT /profiles/:id` 或 `POST /profiles`,请求体带 `first_delay_ms`/`chars_per_second`(留空发 `null` 以清除覆盖、继承全局)→ `admin-api.js:229-257`(`profileInput` 接受 camelCase/snake_case,`null`/`""` 归一为 NULL);且服务端 create/update 同样 `validateProgram`,失败返回 400 `invalid_program` → `config.js:148-221` → **D1 INSERT/UPDATE `profiles`** → 重新拉列表。旧版"保存路径不做校验"的问题已修复(§5-G4 作废)。

**链路 23:删除**
`index.html:498` → `deleteProfile()`(`app.js:738-747`)→ `DELETE /profiles/:id` → `config.js:204-211`(**默认方案抛错拒删**)→ D1 DELETE。

### 2.5 行为(`index.html:526-578`)

**链路 24:刷新**
`index.html:529` → `GET /config` → `admin-api.js:212` → `readConfigRaw()`(`admin-api.js:138-143`,默认值合并 D1 行)→ `this.config`。

**链路 25:保存配置(字段级校验 + busy 防重)**
控件(`index.html:533-572`):首字延迟、输出速度、分块大小、时长上限、单次输出字符上限、每 IP 并发上限、超限行为、默认模型、严格模型、CORS Origin、鉴权模式、未登记 IP 默认策略、统计时区偏移、请求日志开关与保留天数。提交 `saveConfig()`(`app.js:472-489`):先 `validateConfigFields()`(`app.js:443-470`)按 `CONFIG_NUMBER_FIELDS` 做**字段级校验**(必填/数字/整数/上下界),不通过则把错误写 `fieldErrors` 标红对应输入框(`index.html` 各 `:class="fieldErrors.xxx ? 'field-invalid' : ''"`)并阻止提交;通过后按 `CONFIG_KEYS` 白名单(`app.js:2-18`)全部 `String()` 后 `PUT /admin/api/config`,保存期间 `savingConfig` 禁用按钮。
术语已统一为「单 IP 专属规则」(原"特批")与「未登记 IP 默认策略」(原"总闸"),字符限额单位统一用「字符」。

> 该页没有 `max_tokens_policy` 控件;该死配置已从 `config.js` 的 `CONFIG_DEFAULTS`/`normalizeConfig` 与迁移种子行中删除(见 §5-G6)。

### 2.6 IP 查询(`index.html:580-637`)

**链路 26:策略命中 / 实时状态 / 重置**
本页独立承载 IP 查询,不再与限流页共用查询入口:
- `resolveIpPolicy()`(`app.js:1244-1253`)→ `GET /admin/api/ip-policy/resolve?ip=…`(`admin-api.js:329-359`)→ 显示命中层级(`resolveSourceText` `app.js:1183-1194`)、生效规则、并发、窗口用量与预计可重试时间。
- "查询实时状态" → `loadIpStatus()`(`app.js:1488-1497`)→ `GET /admin/api/ip/:ip/status`(`admin-api.js:361-373`)→ 中文表格 + `<details>` 折叠原始 JSON(`index.html:620-635`)。
- "重置该 IP" → `resetIp()`(`app.js:1504-1516`)→ `confirm` → `POST /admin/api/ip/:ip/reset`(`admin-api.js:369-371`)→ DO `reset` 删除该 `ip:<scopeKey>` 全部窗口桶 + 并发租约(不涉及 D1)→ 自动重查状态。
- 顶部"刷新"按钮 → `reloadIpTab()`(`app.js:1499-1502`)同时刷新状态与命中策略。

---

## 3. 管理 API 全量清单

统一前缀 `/admin/api`(`admin-api.js:35,486-508`);除明确标注外,所有异常被 `handleAdminApi` 捕获后统一返回 `400 {"ok":false,"error":...}`(`admin-api.js:505-507`),未知路由 `404`(`admin-api.js:45-47,504`)。所有接口均直读/直写 D1;统计类接口(`/overview`、`/stats`、Key 用量)聚合 D1 `request_logs`。下表"admin-api 分支"已按当前代码行号更新;序号未重排,新增项以 `10a`/`26a` 等标注。

| # | 方法 路径 | 参数 | admin-api 分支 | 底层行为 | 返回 `data` | 异常/降级 |
|---|---|---|---|---|---|---|
| 1 | GET `/overview` | `hours`(默认 24,`parseIntOr`)/`range=today` | 209-217 | 聚合 D1 `request_logs`:总量 + 小时序列(series 补齐空桶) | `{requests,chars,errors,activeIps,series}` | 日志关闭→全 0+`unavailable:true`+中文 `note`(`withLogNote` 182-189) |
| 2 | GET `/config` | - | 219-220 | `readConfigRaw`:`CONFIG_DEFAULTS`+D1 `config` 全表 | 全量配置(原始字符串) | D1 报错→400 |
| 3 | PUT `/config` | `{key:value,...}` | 221→146-161 | 白名单过滤,逐 key D1 UPSERT `config` | 同 GET | 非法 JSON→`invalid json` |
| 4 | GET `/profiles` | - | 231 | D1 `SELECT * FROM profiles ORDER BY is_default DESC,id` | 方案数组(program 已解析为对象,含 `firstDelayMs`/`charsPerSecond`,null=继承全局) | - |
| 5 | POST `/profiles` | `name,model_id,program,is_default,enabled,first_delay_ms?,chars_per_second?` | 232-239 | 写库前 `validateProgram`→D1 INSERT(`first_delay_ms`/`chars_per_second` 原样入库,NULL=继承);若默认则清其他默认 | 新建方案 | 校验失败→400 `invalid_program`+`details`;节奏字段无服务端范围校验 |
| 6 | PUT `/profiles/:id` | 同上(增量;`first_delay_ms`/`chars_per_second` 传 `null` 或 `""` 清除覆盖) | 245-254 | 有 program 时先 `validateProgram`→存在性检查→D1 UPDATE(动态 SET) | 更新后方案 / `null` | 校验失败→400 `invalid_program`;不存在返回 `data:null` 仍是 200 |
| 7 | DELETE `/profiles/:id` | - | 251-253 | D1 DELETE;**默认方案抛错** | `true`/`{deleted:true}` | 默认方案→400 `cannot delete default profile` |
| 8 | POST `/profiles/validate` | `{program}` | 236-240 | 纯 JS `validateProgram`(`interpreter.js:110-181`) | `{ok,errors[]}` | 不落库 |
| 9 | GET `/rules` | - | 259 | D1 `SELECT * FROM rules ORDER BY id` | 规则数组(`{id,windowSeconds,limitChars,enabled,note}`) | - |
| 10 | POST `/rules` | `window_seconds,limit_chars,enabled,note` | 260-268 | `ruleValues` 服务端校验后 D1 INSERT,rules 自增 id | 新规则 | 窗口 ≤ 0 / 限额 < 0 / 缺字段 → 400 `invalid_rule_window` / `invalid_rule_limit` |
| 10a | **PUT `/rules`** | `{rules:[{id?,window_seconds,limit_chars,enabled,note}]}` | 269-277 | `replaceRules`(`config.js:299-326`)→D1 `batch`:先 `DELETE FROM rules` 再逐条 INSERT,**单事务整体替换** | 替换后的规则数组 | 非法行→400 `invalid_rule_window` / `invalid_rule_limit`,整体不写 |
| 11 | PUT `/rules/:id` | 同上增量 | 278-286 | 同上服务端校验后 D1 UPDATE | 更新后规则 / `null` | 非法数值→400;不存在返回 `null` 仍是 200 |
| 12 | DELETE `/rules/:id` | - | 287-289 | D1 DELETE | `changes>0` | 不存在返回 `false`(仍是 200) |
| 13 | GET `/ip-overrides` | - | 295 | D1 查询未过期覆盖(`config.js:355`) | 覆盖数组(rules 已解析) | - |
| 14 | PUT `/ip-overrides/:ip` | `concurrency,rules,expires_at,note` | 296-300 | D1 `INSERT ... ON CONFLICT(ip) DO UPDATE` | 保存后的覆盖 | `rules` 可以是数组或字符串 |
| 15 | DELETE `/ip-overrides/:ip` | - | 301-303 | D1 DELETE | `changes>0` | - |
| 16 | GET `/ip/:ip/status` | - | 386-388 | DO `status(scopes:['ip:<scopeKey>'],ip)` | `{scopes:[{scope,windows:[{windowSeconds,used}]}],inflight,rotations}` | DO 错误→400;**只有 used,无 remaining/limit**(`API.md` 已同步修正该表述;面板自行结合生效规则计算剩余) |
| 17 | POST `/ip/:ip/reset` | - | 389-391 | DO `reset` →删窗口桶+并发租约 | `{ok:true}` | - |
| 18 | GET `/api-keys` | - | 398 | D1 `SELECT * FROM api_keys ORDER BY created_at DESC` | Key 数组(无哈希,有前缀/配额规则) | - |
| 19 | POST `/api-keys` | `name,quota_mode,quota_rules,expires_at,note` | 399-411 | `createKey`→生成 48 位明文+哈希→D1 INSERT;`quota_rules` 规范化保留 `enabled`/`note` | Key 对象 + **一次性明文 `key`** | 不校验 quota_mode 取值,由 D1 CHECK 约束兜底 |
| 20 | PUT `/api-keys/:id` | 同上 + `enabled` | 412-417 | D1 UPDATE | 更新后 Key | 不存在返回 `null` |
| 21 | DELETE `/api-keys/:id` | - | 418-426 | D1 `DELETE FROM api_keys`(`keys.js:211-215`);随后 DO `reset({scopes:['key:<id>'],scopePrefix:'key:<id>:',keyId})` 清该 Key 的 scope 与 live IP(无 `key_ips` 级联,表已删除) | `changes>0` | - |
| 22 | GET `/api-keys/:id/status` | - | 432-435 | `keyScopeList`(total→1 scope;per_ip→聚合 D1 `request_logs` 最近 50 IP;unlimited→[])→DO `status` | DO 状态 | Key 不存在→404 `key_not_found` |
| 23 | POST `/api-keys/:id/reset` | - | 436-439 | 同上 →DO `reset` | `{ok:true}` | 前端对 unlimited Key 直接拦截并提示"没有可重置的配额窗口"(`app.js:1464-1468`),不再空操作后谎报成功 |
| 24 | GET `/api-keys/:id/usage` | `days`(默认 7) | 440-444 | 聚合 D1 `request_logs` 按 `key_id` | `{requests,chars,series}` | 日志关闭→0+`unavailable`(`withLogNote`) |
| 25 | GET `/api-keys/:id/ips` | `limit`(默认 100,上限 1000) | 445-461 | 合并 `request_logs` 聚合(`requestLogIpSummary`)+ DO 实时 | `[{ip,requests,chars,firstSeen,lastSeen,live}]` | 仅覆盖日志保留期(见 §6) |
| 26a | GET `/logs` | `key_id, ip, before, limit` | 467-477 | D1 `request_logs` 游标分页 | `{items,nextBefore}` | - |
| 26b | GET/POST/PUT/DELETE `/ip-groups`,`/ip-groups/:id/members` | 组字段/`{values:[...]}` | 307-347 | D1 `ip_groups`/`ip_group_members`;成员支持 IP 与 CIDR | 组/成员/`{added,invalid}` | 组不存在→404 `group_not_found` |
| 26c | GET `/ip-policy/resolve` | `ip` | 349-379 | `resolveIpPolicy`→策略命中 + DO 实时窗口,计算 remaining/retryAfterMs | `{source,rules,concurrency,status,...}` | 缺 ip→400 `missing ip` |
| 26 | GET `/stats` | `from,to,ip,model,status,key_id,limit` | 479-481 | D1 `request_logs` 明细(参数化 SQL,`limit≤1000`) | 事件数组 | 无数据→空数组(无 `unavailable` 包装);面板无任何入口调用该端点 |
| 27 | 其他 | - | - | - | - | 404 `not_found` |

入口处非 admin-api 逻辑:`OPTIONS` 直接 204(`index.js:368-370`);Host/Access 校验 403(`index.js:373-394`);Worker 异常统一 500(`index.js:407-411`)。

---

## 4. 与原始需求的逐条对照

| 需求 | 结论 | 代码证据 | 诚实说明 |
|---|---|---|---|
| **R1** 管理员可调节:首字延迟、输出速度、输出内容 | **已实现** | 延迟/速度/分块/上限:面板 `index.html:533-572`,保存 `app.js:472-489`,入库 `admin-api.js:145-160`,生效 `index.js:120-125` + `openai.js:60-64,98`;输出内容:方案 CRUD + 积木/JSON 双模式 `index.html:471-500` + `config.js:142-202` | 行为参数全可调且即时生效;"输出内容"现同时提供 **Blockly 图形化积木**与 JSON 文本两种编辑方式,并支持实时预览(R4 已实现) |
| **R2** 查看今日调用量 | **已实现** | 仪表盘 `index.html:41-81` → `admin-api.js:209-217` → `stats.js` `overview()`/`overviewToday()`(聚合 D1 `request_logs`) | 时间范围下拉已提供**「今日(自然日)」**选项(`index.html:47`,按 `stats_tz_offset` 划分),另保留 6/24/72/168 小时滚动窗口。统计已改为直接聚合 D1 `request_logs`,不再依赖 AE;仅覆盖 `request_log_retention_days`(默认 7 天)内的数据。若 `request_log_enabled=false`,overview 返回 `unavailable:true` + 中文 note(`admin-api.js:182-189`),面板显示灰色提示而不报错 |
| **R3** 每 IP 调用限制:并发数;可自定义多条"每 x 分钟限额 xx 字"规则,按更低限额截断 | **已实现** | 并发:全局 `index.html:538`→`index.js:104-111`;单 IP 专属规则并发 `index.html:235`→`config.js:355-376`;多条规则弹窗 CRUD + 批量保存 `index.html:653-693`→`config.js:239-317`;取最小截断 `limiter-core.js`、`limiter-do.js`、`index.js:203` | 算法与面板完整。窗口单位支持**秒/分钟/小时/天**(`index.html:668-675`),并提供带限额模板;单 IP 专属规则也改用同一规则弹窗,不再手写 JSON |
| **R4** 能用方便的图形化代码块实现输出内容循环 | **已实现** | `public/js/blocks.js` 注册 8 种积木并导出 `mountBlocklyEditor`/`compileToProgram`(`blocks.js:34-211,572-646`),`app.js:586-633` 动态加载并挂载,`index.html:478-481,491` 提供「积木编辑」切换与工作区;`public/vendor/blockly/` 含 `blockly.min.js`/`msg/zh-hans.js`/`media/` | 内容页提供积木拖拽编辑、示例一键插入、校验与实时预览;`repeat`/`rotate` 等循环/轮换块可用 |
| **R5** API Key 机制:单独配额(无限 / 按 IP / 不按 IP 但单 Key 总额度有限),并记录调用 IP | **已实现**(受日志保留期限制) | 三种模式:面板 `index.html:162-180`→`keys.js:127-159`→D1;生效 `keys.js:207-211`→`index.js:99-111`→DO `limiter-do.js:184-203`;记录 IP:逐请求日志 `request_logs` → 面板聚合 `request_logs`(`requestLogIpSummary`)+ DO 实时行(`admin-api.js:445-461`) | 三种配额均可用;"记录调用 IP"现由 `request_logs` 聚合 + DO 实时合并,受日志保留期限制(不再有 1–2 小时 Cron 延迟);per_ip Key 的状态/重置覆盖 `request_logs` 中最近 50 个 IP(`admin-api.js:191-203`);Key 级并发限制明确不做(`DESIGN.md:22` backlog) |

---

## 5. 明确的差距清单(按严重程度排序)

### G1(已解决)图形化积木不存在 —— 对应 R4

- **更正(2026-10-05)**:`public/js/blocks.js` 已是完整实现(注册 8 种积木,导出 `loadBlockly`/`mountBlocklyEditor`/`compileToProgram`,`blocks.js:278-313,563-646`);`public/vendor/blockly/` 目录存在;`app.js:586-633` 通过 `await import('/js/blocks.js')` 动态加载并挂载;内容页有「积木编辑 / JSON 编辑」切换、示例插入、校验与实时预览。原"死文件/调用即抛错/目录不存在/无预览"的结论已作废,README.md、DESIGN.md 的相关宣称现与代码一致。

### G2(已解决)统计链路已从 AE 改为 D1 `request_logs` 聚合 —— 对应 R2

- **已解决(2026-10-05 统计重构)**:`src/stats.js` 现导出 `overview/overviewToday/queryStats/keyUsage/cleanup`,全部用参数化 SQL 聚合 `request_logs`(按小时分桶、`SUM(output_tokens)`、`status>=400` 计错误、`COUNT(DISTINCT ip)`);不再有 `writeEvent`/`queryAE`/`syncKeyIps`,不再需要 AE 数据集、`AE_QUERY_TOKEN`、`CF_ACCOUNT_ID`。
- 唯一条件限制:统计仅覆盖 `request_logs` 保留期(`request_log_retention_days`,默认 7 天);`request_log_enabled=false` 时 overview/keyUsage 返回 `unavailable:true` + 中文 note(`admin-api.js:182-189`)。
- "今日"独立选项 `range=today` 保留,按 `stats_tz_offset` 划分自然日(`admin-api.js:211-213`)。

### G3(已解决)Key 调用 IP 不再延迟 1–2 小时;unlimited 重置仍拦截

- **已解决(2026-10-05 统计重构)**:`key_ips` 表与每小时 `syncKeyIps` Cron 已移除(`migrations/0004_drop_key_ips.sql`;Cron 仅剩 `0 4 * * *`)。`/api-keys/:id/ips` 现直接聚合 D1 `request_logs`(`requestLogIpSummary`)并与 DO 实时行合并(`admin-api.js:445-461`),历史行近实时(日志写入为异步)。
- `per_ip` Key 的"状态/重置"依赖聚合出的最近 50 个 IP(`admin-api.js:191-203`);没有日志的旧 IP 不再出现。
- **保留(2026-10-05)**:`unlimited` Key 点"重置"会被前端直接拦截并提示"没有可重置的配额窗口"(`app.js:1464-1468`),不再发出空操作请求后谎报成功。
- 空列表提示文案(`index.html:380`)已随本次重构更新为"历史行来自请求日志聚合(受日志保留期限制)"。

### G4(已解决)内容方案保存不做校验 —— 对应 R1/R4

- **更正(2026-10-05)**:`saveProfile()` 在保存前先本地解析、再调 `POST /profiles/validate`,校验不通过**阻止保存**并把错误详情中文化展示(`app.js:692-736`);服务端 `POST/PUT /profiles` 写库前也调用 `validateProgram`,失败返回 400 `invalid_program`(`admin-api.js:220-242`)。因此通过面板或管理 API 都无法再存入非法结构,旧版"一次误保存可让对应 model 直接 500"的风险已消除。
- 保存前另有积木/JSON 切换、校验结果面板与实时预览(`index.html:495-521`),不再只能靠手动点"校验"。

### G5(部分解决)规则与内容的编辑形态原始

- **已改善**:单 IP 专属规则、IP 组规则、Key 配额规则、全局规则统一使用结构化规则弹窗,不再手写 JSON(`index.html:653-693`;`openRuleEditorFor` `app.js:804-821`);窗口单位支持秒/分钟/小时/天并提供带限额模板(`app.js:21-26,831-837`);`PUT /rules` 批量保存对每行做窗口/限额校验(`config.js:299-326`);行为页数字字段做字段级校验并标红(`app.js:443-470`)。
- **已改善(2026-10-05 二轮)**:单条 `POST /rules`、`PUT /rules/:id` 现由 `config.js:237-291` 做服务端校验(`window_seconds` > 0、`limit_chars` ≥ 0),非法返回 400 `invalid_rule_window` / `invalid_rule_limit`;`PUT /config` 仍仅白名单/原样写入,数值防护依赖面板端校验与表单 `min/max`。

### G6(已解决)`max_tokens_policy` 死配置已清理

- **已解决(2026-10-05 二轮)**:`max_tokens_policy` 已从 `src/config.js` 的 `CONFIG_DEFAULTS`/`normalizeConfig` 及 `migrations/0001_init.sql` 种子行中删除(已部署库中的残留行被忽略);`max_tokens` 仍按 1 token : 1 字符的固定策略换算,不再可配置。面板也没有该项(`app.js:2-18` 白名单)。
- **已修正(2026-10-05)**:DESIGN.md 原称配置"内存缓存 30s"、Key 哈希查询"30s 缓存",与实际 `CACHE_TTL_MS = 0`(`config.js:23`,`keys.js:5`)矛盾,已改为"无缓存/直读 D1"。
- **已修正**:DESIGN.md 原列的"设置"页不存在,已改为 6 个标签(`index.html:21-26`)。
- **已修正**:API.md 原称 IP/Key `status` 返回"已用/剩余",已改为"仅返回已用,剩余由调用方计算";面板在拿到生效规则后自行计算剩余(`app.js:1225-1242`)。

### G7(低·行为瑕疵)重置与清理的盲区

- 面板任何"重置"都不会清 rotate 轮换计数:DO `reset` 支持 `rotations` 参数,但 admin-api 从不传(`admin-api.js:389-391,436-439`),轮换内容无法通过面板归零。
- 修改规则 `window_seconds` 后,DO 里旧窗口桶不会被主动删除(只随 `purge`/alarm 自然过期,`limiter-do.js:354-367`),不影响限额正确性但 `status` 会同时显示新旧窗口。
- `/stats` 端点存在且无 UI 入口;查 D1 `request_logs` 明细,无数据时返回空数组(不套 `unavailable` 包装,`admin-api.js:479-481`)。

---

## 6. 数据一致性 / 生效路径说明

### 6.1 关键事实:全部"直读/直写 D1"(统计聚合 `request_logs`),改动下一次请求即生效

- 配置缓存 `CACHE_TTL_MS = 0`(`config.js:22`,读 `config.js:85` getConfig);方案 `config.js:121-130`;规则 `config.js:221-230`;IP 覆盖 `config.js:355-362`;Key 哈希查询 `keys.js:5-7,94-112` 同样是 TTL=0 的 Map,等价不缓存。`invalidateConfigCache()` 实际是空操作(批量保存 `replaceRules` 亦调用它,`config.js:324`)。
- 因此 DESIGN.md:62 描述的"30s 缓存延迟"在当前代码中不存在。

### 6.2 各改动的端到端路径与延迟

| 面板改动 | 写入位置 | `/v1` 读取/生效点 | 生效延迟 |
|---|---|---|---|
| 行为配置(延迟/速度/上限等) | D1 `config`(`admin-api.js:126-134`) | 下一次请求 `getConfig`(`index.js:293-295`)→ 节流参数 `index.js:120-125`,首字 `index.js:222`/`openai.js:98` | 下一次请求(通常 <1s) |
| 内容方案 | D1 `profiles` | 下一次请求 `getProfileByModel`(`index.js:84`)与 `/v1/models`(`index.js:48-52`) | 下一次请求 |
| 限流规则 | D1 `rules` | 下一次请求 `getEnabledRules`(`index.js:96`)→ 随 acquire 传入 DO | 下一次请求 |
| IP 覆盖/过期 | D1 `ip_overrides` | 下一次请求 `getIpOverride`(`index.js:95`),过期时间为惰性判断(`config.js:304`) | 下一次请求;过期即失效 |
| API Key 新建/改/删 | D1 `api_keys` | 下一次请求 `authenticate`(`index.js:65`,`keys.js:109-116`),无缓存 | 下一次请求 |
| IP/Key 限流状态重置 | DO 内存+SQLite(`limiter-do.js:287-310`) | 立即(DO RPC) | 立即 |
| 仪表盘/Key 用量 | D1 `request_logs`(聚合) | 面板查询时 `stats.js` 参数化 SQL 聚合 | 仅覆盖日志保留期;写入为异步,近实时 |
| Key 调用 IP 列表 | D1 `request_logs` 聚合(`requestLogIpSummary`)+ DO 实时 | 面板查 D1(`admin-api.js:445-461`) | 仅覆盖日志保留期;无 1–2 小时 Cron 延迟 |
| 过期 IP 覆盖与请求日志清理 | D1 清理 | Cron 每日 04:00(`index.js:414-421`) | 展示层已按时间过滤,清理仅省空间 |

### 6.3 DO(限流)一致性要点

- 全局单实例 `idFromName('global')`(`limiter.js:2`),所有 IP/Key 窗口、并发租约、rotate 计数集中一处。
- 预留-结算模型:acquire 按"所有 scope 剩余的最小值 ∩ 单次上限"预留(`limiter-do.js:194-281`),settle 按 reservationId 把 pending 改写为实际产出(`limiter-do.js:283-308`);若实例驱逐导致 reservation 丢失,settle 会扫描所有 scope 的 pending 条目恢复结算并始终释放租约(`limiter-do.js:288-305`)。并发靠租约 = 请求时长 + 30s 宽限(`limiter-do.js:8,258`),alarm 兜底回收(`limiter-do.js:450-473`),状态落 DO SQLite(`limiter-do.js:540-602`)。
- 规则/Key 配额改动无需通知 DO:每次请求都在 Worker 侧把最新规则随 `acquire` 参数传入(`index.js:94-111`)。

### 6.4 统计链路(直接聚合 D1,近实时)

```
请求结束 → writeRequestLog(ctx.waitUntil) ──> D1 request_logs(仅 request_log_enabled 时写入,保留 request_log_retention_days 天)
                                                     │
面板仪表盘/Key 用量/调用 IP ── 参数化 SQL 聚合 request_logs ──┘(requestLogIpSummary 也用于 per_ip Key 的 status/reset)
                                                     │
DO 实时行(keyIps)与 request_logs 聚合结果合并 ──> 面板「调用 IP」列表(实时/历史)

Cron 每日 04:00 ──> stats.cleanup(过期 ip_overrides)+ cleanupRequestLogs(过期请求日志)
```

---

## 7. 未能确认事项(不做猜测)

1. 线上是否设置了 `DEV_BYPASS_ADMIN=true`(仅当未配置 `ACCESS_AUD` 或请求 host 为 localhost 时才会跳过 Host 与 Access 校验,`index.js:375`;配置了 Access 则该项无效)。
2. 线上 `request_log_enabled` / `request_log_retention_days` 的实际取值(D1 `config` 表,不在仓库内)。
3. 线上 Access 应用/策略是否与 `ACCESS_AUD` 等变量匹配(Access 配置部分不在仓库内)。

> 早期"线上是否另配 AE 绑定""`AE_QUERY_TOKEN` 是否配置""AE 摄入延迟"等待确认事项已随统计改 D1 聚合而失效,不再列入。

---

## 8. 面板成熟化改造变更汇总(2026-10-05)

以下为本次改造新增/变更的面板行为,均已对照当前 `public/js/app.js`、`public/index.html`、`public/style.css`。

### 8.1 导航与提示

- **tab 哈希**:`setTab()` 把当前页写入 `location.hash`(`#dashboard/#limits/#keys/#content/#behavior/#ip`),`init()` 注册 `hashchange`(`app.js:268-290`),刷新与浏览器前进/后退可恢复所在 tab;`TABS` 白名单见 `app.js:27`。
- **toast 堆叠**:`notify()` 不再单例,而是 push 到 `toasts` 数组并各自 3.2s 后移除(`app.js:292-298`);DOM 用 `<template x-for>` 渲染 `.toast-stack`(`index.html:34-38`),`aria-live="polite"`。
- **错误横幅**:固定置顶、**不再 6 秒自动消失**,需点「关闭」(`index.html:30-33`);`role="alert" aria-live="assertive"`;`humanizeError()` 做错误码中文化(`app.js:41-56`),校验详情另有 `humanizeDetail()`(`app.js:58-79`)。
- **提交防重**:`savingConfig`/`savingProfile`/`savingOverride`/`savingGroup`/`savingKey`/`savingRules`/`membersPanel.saving` 等 busy 标志 + 按钮 `:disabled` 与"保存中…"文案(如 `index.html:171,203,249,285,497,574,689`)。

### 8.2 弹窗与表单

- **规则弹窗**:未保存脏检查 `ruleEditorIsDirty()`(`app.js:861-864`),关闭时 `requestCloseRuleEditor()` 弹确认(`app.js:855-859`);保存中禁止关闭;`role="dialog" aria-modal`、打开时焦点移到「添加规则」、Esc 关闭(`index.html:653`)。
- **创建 Key 明文弹窗**:不允许点遮罩关闭,仅提供「复制明文」「我已保存」(`index.html:640-651`);`role="dialog"`、自动聚焦复制按钮。
- **规则模板**:`RULE_PRESETS` 提供 5 分钟/5000、15 分钟/1 万、1 小时/2 万、1 天/10 万四档带限额模板(`app.js:21-26`),下拉选择即回填窗口数值、单位与限额(`app.js:831-837`)。
- **示例插入**:新建/编辑方案提供「回显请求输入 / 随机中文乱码 / Lorem 占位 / 轮换问候语」四种一键示例(`app.js:502-527`,`index.html:484-489`)。
- **字段级校验**:行为配置按 `CONFIG_NUMBER_FIELDS` 校验必填/数字/整数/上下界,失败写 `fieldErrors` 并给输入框加 `field-invalid` 标红(`app.js:28-37,443-470`);规则弹窗按行校验窗口 > 0、限额 ≥ 0(`app.js:839-853`)。

### 8.3 限流页

- **全局规则批量事务保存**:整体保存改走 `PUT /admin/api/rules`,服务端 `replaceRules()` 在 D1 `batch` 内先 DELETE 再 INSERT(`config.js:299-326`,`admin-api.js:269-277`),失败整体不写,消除旧版"删了一半"的半损坏状态。
- **移除重复实时查询**:限流页不再做 IP 实时查询,IP 查询/重置集中在「IP 查询」页(见 §2.2/§2.6)。
- **未登记 IP 默认策略只读**:限流页只展示状态并跳转行为页修改(`index.html:88-95`);仅行为页可改(`index.html:562-569`)。
- **术语统一**:"单 IP 专属规则"(原"特批")、"未登记 IP 默认策略"(原"总闸");限额单位统一为「字符」。

### 8.4 API Keys 页

- 表格操作列改为「编辑 / 更多」+ 展开行,展开行含停用、用量、IP、状态、请求日志、重置、删除;重置/删除为 `btn-danger`(`index.html:305-320`)。
- Key 详情合并为单一面板内的 Tab:用量 / 调用 IP / 实时状态 / 请求日志(`index.html:334-339`,`switchKeyDetail` `app.js:1351-1359`);DO 状态由裸 JSON 改为中文表格 + `<details>` 折叠原始 JSON(`index.html:382-415`);调用 IP 列表标注"实时/历史"并给出延迟说明(`index.html:362-380`)。

### 8.5 仪表盘与可访问性/响应式

- **图表抽稀与峰值**:横轴标签在 > 24 根时每 ~12 根标一次,> 24h 显示"月/日"(`app.js:352-370`);时序图与 Key 用量图均标注峰值(`index.html:67,349`),柱子 `:title` 提供完整数值。
- **可访问性**:`<h1>Loremium`(`index.html:17`)、模态 `role="dialog" aria-modal` + `aria-labelledby`、规则弹窗 Esc 关闭、错误 `role="alert"`、toast `aria-live`、导航 `aria-label`、内联 SVG favicon(`index.html:7`)。
- **暗色模式与响应式**:`@media (prefers-color-scheme: dark)` 配色(`style.css:633+`)、移动端表格横向滚动 `.table-wrap`(`style.css:156-161,269+`)、触控目标在 `pointer: coarse` 下放大(`style.css:302-308`)。

### 8.6 P0/P1/P2 修复补充(2026-10-05 二轮)

- **网络错误中文化**:`humanizeError()` 识别 `Failed to fetch` 等网络异常并显示"网络连接失败,请检查网络后重试"(`app.js:55-62`)。
- **请求序号防乱序**:仪表盘 `overviewSeq`(`app.js:327,332`)与 Key 详情 `detailSeq`(`app.js:1462,1475,1496,1529`)在响应返回时校验序号,丢弃过期响应;`openKeyDetail()`/`closeKeyDetail()` 会递增序号并重置详情状态(`app.js:1412-1452`)。
- **日志刷新/加载更多**:按钮在 `logPanel.loading` 时 `:disabled` 防重复(`index.html:422,445`);调用统一经 `guard(...)` 包裹,失败写入错误横幅(`loadLogs` `app.js:1518-1536`)。
- **删除 Key 关闭详情**:`deleteKey()` 删除后若详情面板正指向该 Key 则自动 `closeKeyDetail()`(`app.js:1402-1410`)。
- **方案编辑脏检查**:`profileIsDirty()`(`app.js:581-584`)+ `confirmDiscardProfile()`(`app.js:586-588`)在切换/放弃时提示;`init()` 注册 `beforeunload`,方案或规则弹窗有未保存修改时拦截离开(`app.js:282-287`)。
- **模态焦点陷阱与 Esc**:`trapFocus()` 实现 Tab 循环(`app.js:590-606`);规则弹窗(`index.html:653`)与创建 Key 明文弹窗(`index.html:640`)均 `role="dialog" aria-modal`,Esc 关闭(创建 Key 弹窗 Esc/关闭前经 `confirmCloseCreatedKey()` 二次确认,`app.js:608-610`)。
- **暗色对比度**:`@media (prefers-color-scheme: dark)` 为 `.global-msg`、`.tag-*`、`.toast`、`.status-*`、`.btn-danger`、`pre.key-text` 等补足对比色(`style.css:663-695`)。

### 8.7 内容方案节奏覆盖(2026-10-06)

- **表单新增两输入**:`index.html:478-479` 新增「首字延迟覆盖(毫秒)」(min 0/max 60000)与「输出速度覆盖(字符/秒)」(min 0.5/max 1000),绑定 `profileForm.firstDelayMs`/`profileForm.charsPerSecond`(`emptyProfile` 初值为空字符串,`app.js:191-202`);留空即继承全局,`0` 表示首字不等待。
- **保存链路**:`saveProfile()`(`app.js:770-831`)在原有 program 校验后做字段级范围校验(超出报中文错误并阻止保存),提交 `first_delay_ms`/`chars_per_second`(留空发 `null`);`admin-api.js:92-106 profileInput` 兼容 camelCase/snake_case,`null`/`""` 归一为 NULL(清除覆盖);服务端与全局配置一致不做范围校验。
- **列表展示**:方案列表在 `modelId` 后显示覆盖摘要 `profilePacingText()`(`app.js:586-591`,如「延迟 1200ms · 50 字/秒」;两项皆空则不显示),见 `index.html:467`。
- **脏检查**:`profileSnapshotValue()`(`app.js:573-584`)已纳入两个节奏字段,切换/放弃方案时未保存修改会被提示。
