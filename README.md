# Loremium

OpenAI 兼容的"垃圾 AI 中转站"。无论客户端请求什么内容,都按照管理员配置的策略返回占位文本、乱码字符或自定义内容,并模拟真实模型的首字延迟与输出速度;内置精细的按 IP 限流与图形化内容编排面板。

> 状态:**M0–M5 代码完成并已上线**(169 个单测、47 项本地冒烟通过;生产冒烟 41 项,其中 6 项带 `!PROD` 跳过)。面板:积木编辑器(支持换行文本与"原样输出请求输入")、IP 分层策略(单 IP 专属规则/组/CIDR/未登记 IP 默认策略)、Key 实时 IP、每 Key 请求日志与来源 IP 下钻。已通过安全加固:预留式额度记账、IPv6 /64 聚合、认证前置与 1MB 体积上限、admin Access fail-closed(未配置 `ACCESS_AUD` 直接 403,`DEV_BYPASS_ADMIN` 仅在未配置 Access 或 localhost 时生效)、Origin/写请求 Content-Type 校验、CSP 收紧与只认 `CF-Connecting-IP`;逐请求日志存 D1(可关/可设保留天数);`/v1/responses`(Responses API,流式+非流式)可用。面板成熟化:全局规则支持整体批量事务保存(不再半损坏)、tab 写入 URL 哈希可刷新/前进后退、Key 详情合并为四个页签、错误横幅需手动关闭并做错误码中文化。

## 特性

- **OpenAI 兼容接口**:`/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/v1/responses`(Responses API);流式(SSE)与非流式
- **输出内容可编排**:文本(支持换行)、随机、加权随机、字符池、Lorem、重复循环、跨请求轮换、**原样回显请求输入**
- **图形化积木**:Blockly 拖拽编辑内容方案,浏览器内实时预览
- **请求日志**:按 Key 查看逐请求明细(输入/输出 token、耗时、来源 IP、状态),点击 IP 下钻查看跨 Key 全部请求
- **行为模拟**:首字延迟、字符级输出速度、分块大小、响应时长上限;首字延迟与输出速度支持按内容方案(模型)覆盖,未覆盖时回退全局
- **精细化限流**:每 IP 并发数 + 多条滑动窗口字数规则,有效额度取最低限额截断;支持按 IP 覆盖
- **API Key 机制**:多把 Key、独立配额(无限 / 按 IP 配额 / 单 Key 总额度)、调用 IP 记录;auth_mode 三态鉴权
- **管理面板**:今日调用量、请求统计、规则管理(全局规则批量事务保存)、内容方案、API Key、IP 实时状态;tab 写入 URL 哈希,支持刷新与前进后退
- **零成本运行**:全部构建在 Cloudflare 免费计划额度内,约 5 万次 API 调用/天

## 架构一览

```
客户端 ──> ai.example.com      ─┐
                                ├─> Worker(loremium)
管理员 ──> admin.ai.example.com ─┘     ├─ D1:配置/方案/规则/Key/请求日志(统计聚合)
        (Cloudflare Access)            ├─ DO(全局):IP并发/窗口/Key配额/轮换
                                       └─ Static Assets:管理面板
```

详细设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 总体架构、数据模型、限流与 Key 配额、额度预算、决策记录 |
| [docs/INTERFACES.md](docs/INTERFACES.md) | 模块接口契约(开发用) |
| [docs/API.md](docs/API.md) | OpenAI 兼容接口与管理 API 规范 |
| [docs/BLOCKS.md](docs/BLOCKS.md) | 积木程序(BlockProgram)规范与 Blockly 映射 |
| [docs/PLAN.md](docs/PLAN.md) | M0–M6 实施计划、验收标准、部署清单 |

## 目录结构(非穷举)

```
loremium/
├── wrangler.example.jsonc # 复制为 wrangler.jsonc 并填入自己的配置
├── package.json
├── docs/                  # 设计文档
├── migrations/            # D1 迁移
├── src/
│   ├── index.js           # 路由入口
│   ├── openai.js          # 协议解析与响应构造
│   ├── generator.js       # 生成与节流
│   ├── limiter.js         # DO 调用封装
│   ├── limiter-core.js    # 窗口算法纯函数(可单测)
│   ├── limiter-do.js      # Durable Object 实现(全局单实例)
│   ├── admin-api.js       # 管理 API
│   ├── keys.js            # API Key 创建/校验/缓存
│   ├── access.js          # Access JWT 验签与 JWKS 缓存
│   ├── ip-match.js        # IP/CIDR 匹配与 IPv6 /64 归一
│   ├── stats.js           # D1 request_logs 统计聚合
│   ├── logs.js            # 逐请求日志(D1)读写与清理
│   ├── config.js          # 配置加载与缓存
│   └── util.js            # JSON/错误响应/随机 id 等工具
└── public/                # 管理面板(Static Assets)
    ├── index.html
    ├── style.css
    ├── js/app.js          # 面板状态与管理 API 调用
    ├── js/boot.js         # Alpine 引导脚本(CSP 兼容)
    ├── js/interpreter.js  # 与 Worker 共享的解释器
    ├── js/blocks.js       # Blockly 自定义积木
    └── vendor/blockly/
```

## 快速开始

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc   # 填入自己的 database_id / ADMIN_HOST / ACCESS_*
npx wrangler d1 migrations apply loremium --local
npm run dev
npm test          # 169 个单元测试
npm run smoke     # 端到端冒烟:本地 47 项(需 dev 服务 + DEV_BYPASS_ADMIN);生产模式 41 项(6 项带 !PROD 跳过)
# 本地管理面板调试(跳过 Access 校验,仅开发环境):
# npx wrangler dev --var DEV_BYPASS_ADMIN:true --test-scheduled
```

生产冒烟(经 Access 服务令牌,出口 IP 需与请求一致):

```bash
NODE_USE_ENV_PROXY=1 SMOKE_MODE=prod SMOKE_IP=<出口IP> \
SMOKE_ACCESS_CLIENT_ID=<svc-id> SMOKE_ACCESS_CLIENT_SECRET=<svc-secret> \
node test/smoke.mjs https://<域名>
```

部署见 [`docs/PLAN.md`](docs/PLAN.md) 的部署与配置清单(创建 D1、填入 database_id、绑定域名、配置 Access)及**部署加固清单**(设置 `workers_dev: false`、从 `ADMIN_HOST` 移除公开 API 域、Access Cookie `SameSite`、生产不设 `DEV_BYPASS_ADMIN`)。统计直接聚合 D1 `request_logs`,无需 Analytics Engine 数据集或 `AE_QUERY_TOKEN` 查询令牌。

> 本仓库不含任何真实凭据:`wrangler.jsonc`(含 database_id、域名、Access AUD)已被 `.gitignore` 忽略,提交的是占位符模板 `wrangler.example.jsonc`。

## 许可证

待定。
