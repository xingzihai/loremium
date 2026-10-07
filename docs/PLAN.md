# Loremium 实施计划

## 里程碑总览

| 里程碑 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| M0 | 项目初始化与 Cloudflare 资源 | - | 已完成:D1/Worker/Access/根域已上线 |
| M1 | OpenAI 兼容接口(流式/非流式) | M0 | 代码完成,单测 + 本地冒烟通过 |
| M2 | 配置、内容方案与解释器 | M1 | 代码完成,单测通过 |
| M3 | DO 限流器 | M2 | 代码完成,本地验证配额/并发/租约 |
| M4 | 管理面板 | M2、M3 | 代码完成;Access 应用 + JWT 验签已上线 |
| M5 | Blockly 积木编辑器与轮换 | M4 | 已完成(自托管 Blockly 13.3,8 种积木,往返语义一致) |
| M6 | 收尾、测试与部署手册 | M3–M5 | 进行中(冒烟脚本完成,其余待办) |

## M0 项目初始化

任务:

- [ ] `wrangler` 工程:`package.json`、`wrangler.jsonc`(绑定见 `DESIGN.md` §14)
- [ ] D1 建库 + `migrations/0001_init.sql`(config / profiles / rules / ip_overrides / api_keys + 默认数据);`0002` IP 组、`0003` 逐请求日志、`0004` 删除废弃的 `key_ips`、`0005` 方案节奏覆盖(`profiles.first_delay_ms` / `chars_per_second`)
- [ ] Durable Object `Limiter` 类骨架 + `new_sqlite_classes` 迁移(全局单实例)
- [ ] Static Assets 目录 `public/` 与 `run_worker_first` 路由
- [ ] `wrangler dev` 本地跑通(本地 D1/DO)
- [ ] 自定义域 `ai.example.com`、`admin.ai.example.com` 绑定
- [ ] Cloudflare Access 应用与策略(锁定管理员邮箱)
- [ ] Cron 单条:`0 4 * * *` 每日清理过期 IP 覆盖与过期请求日志

验收标准:

- `wrangler dev` 与部署后的自定义域均能返回健康检查
- `wrangler d1 migrations apply` 成功;DO 实例可创建
- 未登录 Access 访问 admin 域被拦截

## M1 OpenAI 兼容接口

任务:

- [ ] 路由分发 + CORS/OPTIONS + OpenAI 错误格式
- [ ] `GET /v1/models`(静态方案列表)
- [ ] `POST /v1/chat/completions` 非流式(固定内容)
- [ ] SSE 流式输出:role 块 → 内容块 → finish 块 → `[DONE]`
- [ ] `stream_options.include_usage` 支持
- [ ] 首字延迟、字符速度、分块大小、`max_duration_s` 生效
- [ ] `POST /v1/completions` 旧接口兼容
- [ ] API Key 鉴权:哈希查询(无缓存,直读 D1)、`auth_mode` 三态、401 语义

验收标准:

- `curl` 流式/非流式均返回合法结构;`finish_reason` 正确
- 首字延迟与速度可通过时间戳观察
- NextChat / Cherry Studio / Open WebUI 能通过连接测试并收到回复
- 无效 Key 返回 401;required 模式下无 Key 返回 401

## M2 配置与内容方案

任务:

- [x] config 读写 + 默认值,直接读 D1(管理端变更即时生效)
- [ ] profiles CRUD 数据访问层 + 内置三套方案(lorem / unicode-garbage / fixed)
- [ ] 解释器:`text / random / weighted / charset / lorem / repeat / sequence`
- [ ] BlockProgram 校验器(深度/节点/长度限制)
- [ ] model → profile 映射、未知 model 回退、strict_model
- [ ] api_keys 数据访问层:创建(哈希+前缀)、查询、更新、删除、校验
- [ ] Key 配额 scope 组装(`ip:` / `key:` / `key:ip:`)与 `unlimited` 短路

验收标准:

- 修改 D1 中的方案/配置后,API 输出立即变化
- `/v1/models` 随方案增删变化
- 三种预设字符池输出符合预期
- 创建 Key 后仅能通过明文调用,库中无明文

## M3 DO 限流器

任务:

- [ ] DO `acquire / settle / status / reset` + SQLite 持久化
- [ ] 滑动窗口多规则:有效剩余 = min(各规则剩余)
- [ ] 预留/结算/退回,`Retry-After` 计算
- [ ] 与生成器联动:触顶截断、`finish_reason=length`
- [ ] 并发上限与超限 429
- [ ] ip_overrides 合并(并发/规则覆盖、过期时间)
- [ ] Key 配额:total(跨 IP 共享)/ per_ip(按 IP 独立)/ unlimited(短路)
- [ ] alarm 兜底:租约超时自动释放;客户端断开 finally settle
- [ ] `over_limit_behavior`:truncate / reject

验收标准:

- 配置 3 条规则时,输出长度按最低剩余额度截断
- 并发第 `concurrency_limit + 1` 个请求立即 429,带正确 `Retry-After`
- 强杀客户端后,并发计数在租约超时内自动恢复
- total 模式 Key 被两个 IP 同时使用时,总消耗不超过额度;per_ip 模式互不影响
- 同一 IP / 同一 Key 的 `status` 与结算数据一致

## M4 管理面板

任务:

- [ ] Access + Host/请求头双校验中间件(计划中)
- [ ] 管理 API:overview / config / profiles / rules / ip-overrides / api-keys / ip status / stats
- [ ] 统计聚合封装(参数化 SQL 聚合 D1 `request_logs`)与 Key 用量/Key 调用 IP 查询
- [ ] 面板骨架(Static Assets + Alpine.js + Pico.css)
- [ ] 页面:仪表盘(今日调用量、时序、Top IP、错误率)
- [ ] 页面:行为配置(首字延迟/速度/分块/时长上限/CORS/auth_mode)
- [ ] 页面:限流规则表 + IP 覆盖管理 + 单 IP 实时状态/重置
- [ ] 页面:API Keys(创建一次性明文、配额模式/规则、用量、调用 IP 列表、状态/重置)
- [ ] 页面:内容方案管理与纯文本编辑(v1,积木编辑器 M5)

验收标准:

- 面板所有写操作在 30s 内对 API 生效
- 今日调用量与实际请求数一致(直接聚合 D1 `request_logs`,无采样误差)
- 非 Access 请求 403

## M5 Blockly 积木编辑器与轮换

任务:

- [ ] 自托管 Blockly(`public/vendor/blockly`)
- [ ] 8 种自定义积木 + 工具箱
- [ ] `compileToProgram` / 反编译加载
- [ ] 共享解释器接入浏览器预览(含零宽字符标注)
- [ ] 程序校验与错误提示
- [ ] rotate 块:DO 状态、cycle/random、ip/global、随 acquire 解析

验收标准:

- 拖拽积木保存后,API 输出与浏览器预览分布一致
- rotate cycle 模式严格按请求次序轮换(ip 维度独立)
- 非法程序(超深/超大)被拒绝并提示

## M6 收尾

任务:

- [ ] Cron 每日清理过期 ip_overrides 与过期请求日志(`request_logs`)
- [ ] 日志与可观测性(wrangler observability、关键路径埋点)
- [ ] 客户端兼容矩阵回归(Cherry Studio / NextChat / Open WebUI)
- [ ] 长流稳定性测试(max_duration_s=120 持续输出)
- [x] 冒烟脚本(`test/smoke.mjs`,47 项端到端断言:API/鉴权/配额/并发/节奏/轮换/管理端/Cron;生产模式 41 项,其中 6 项带 `!PROD` 跳过)
- [ ] 部署手册(从零到上线步骤)+ 额度监控说明
- [ ] README 更新为可用状态

验收标准:

- 连续 24h 运行无 5xx(免费计划偶发除外)
- 每日用量(Worker/DO/D1)可在面板或 dashboard 核对

## 测试策略

| 类型 | 手段 | 覆盖 |
|---|---|---|
| 单元测试 | `npm test`(node:test,169 项) | 解释器、校验器、窗口算法、Retry-After、Key 哈希/scope、SSE、limiter-do、admin/stats(D1 聚合)、方案节奏覆盖(`resolvePacing`)等 |
| 端到端冒烟 | `npm run smoke`(本地 47 项 / 生产 41 项) | 双接口流式/非流式、鉴权三态、Key 三种配额、IP 规则/覆盖、并发/租约、节奏、轮换、管理 API、Cron、静态资源 |
| 客户端矩阵 | 真实客户端手动 | 连接测试、流式渲染、usage 兼容 |
| 负载测试 | 小规模并发脚本 | 429 行为、截断正确性、并发恢复 |

## 部署与配置清单

1. `wrangler d1 create loremium` → 将 `database_id` 填入 `wrangler.jsonc`
2. `wrangler d1 migrations apply loremium --remote`(含 `0004_drop_key_ips.sql`、`0005_profile_pacing.sql`)
3. `wrangler deploy`(首次自动创建 DO;无需 AE 数据集)
4. Dashboard → Worker → Settings → Domains & Routes:绑定 `ai.example.com`、`admin.ai.example.com`
5. Zero Trust → Access → Applications:为 admin 域创建应用与管理员策略
6. 关闭或限制 workers.dev 预览域(admin 路由有 Host 校验,仍建议关闭)
7. 冒烟:`curl https://ai.example.com/v1/models` 与管理面板登录

> 统计直接聚合已有 D1 `request_logs`,**无需**创建 Analytics Engine 数据集、AE 查询 API Token,也无需 `AE_QUERY_TOKEN` secret;部署只需要已有 D1 + Access 配置,然后 `npm run deploy`。

### 部署加固清单(建议;线上实际状态未验证)

1. **设置 `workers_dev: false`**,避免生产 Worker 暴露在 `*.workers.dev`(仓库默认已关闭)。
2. **从 `ADMIN_HOST` 允许列表移除公开 API 域**,只保留 admin 域,防止 `/admin/api` 在公开 API 主机上被路由。
3. **Access 应用 Cookie** 的 `SameSite` 设为 `Lax` 或 `Strict`。
4. **确保生产环境不设置 `DEV_BYPASS_ADMIN`**:该项仅在未配置 `ACCESS_AUD` 或请求 host 为 localhost 时生效,生产域名下即使误设也无效;仍需确认生产变量中不存在该值。(线上变量未验证)

## 风险检查点

- M3 完成后:实测每次请求的 DO 调用数与日消耗模型
- M5 完成后:实测 120s 长流在主流客户端的稳定性
- 上线后每日:核对 DO 请求量、D1 读/写行数是否接近免费上限

## 未来可选(Backlog)

- `POST /v1/embeddings` 返回固定/全零假向量
- 管理操作审计日志(D1 `admin_audit`)
- 全局每日调用上限与熔断
- D1 降级限流模式(不依赖 DO)
- Key 级并发限制(当前仅字符额度)
- 每个方案独立限流规则与配额
- 多管理员与只读账号
