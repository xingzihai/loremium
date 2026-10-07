# Loremium 积木程序(BlockProgram)规范

## 1. 概述

内容方案的核心是一个 JSON 树,称为 **BlockProgram**,由 Blockly 积木编译而来,存于 `profiles.program`。Worker 端解释器与面板端预览器共用同一份实现(`public/js/interpreter.js`),保证所见即所得。

顶层节点通常是 `sequence`,按顺序拼接子块输出;整个程序为纯函数式(除 `rotate` 外,轮换需跨请求状态)。

## 2. 通用限制

| 项目 | 限制 |
|---|---|
| 嵌套深度 | ≤ 16 |
| 节点总数 | ≤ 10000 |
| 单次 repeat 次数 | ≤ 1000000 |
| 随机/轮换选项数 | 1–1024 |
| 字符池长度 | 1–16384 个码点 |
| 解释器总求值步数 | ≤ 50000000(防止空循环耗尽 CPU) |
| 输出总长 | ≤ `max_output_chars`,且受本次请求预留额度截断 |

保存方案时在管理端校验一次(`POST/PUT /profiles` 与 `/profiles/validate` 调用 `validateProgram`,`src/admin-api.js:224,231,238`);Worker 运行时按当前实现**不再二次校验**,`config.js` 的 `parseProgram` 仅容错解析、失败回退 `{}`。校验失败拒绝保存。步数上限只在解释执行时生效,超出按截断处理(`finish_reason=length`)。

## 3. 块参考

### 3.1 text 文本

```json
{ "type": "text", "value": "第一行\n第二行" }
```

原样输出固定文本,`value` 支持换行与任意 Unicode 字符;面板积木为多行输入框。

### 3.2 random 随机选择

```json
{ "type": "random", "options": ["▓", "▒", "░"] }
```

均匀随机取一项。`options` 1–1024 项。

### 3.3 weighted 加权选择

```json
{
  "type": "weighted",
  "options": [
    { "value": "正常文本", "weight": 3 },
    { "value": "▓▒░", "weight": 1 }
  ]
}
```

权重为正整数,按权重比例随机。

### 3.4 charset 字符池

```json
{ "type": "charset", "pool": "unicode-garbage", "min": 8, "max": 24 }
```

生成长度在 `[min, max]` 均匀随机的字符序列。`pool` 支持三种形式:

| 形式 | 示例 | 说明 |
|---|---|---|
| 预设名 | `"unicode-garbage"` | 见下表 |
| 字面字符串 | `"▓▒░"` | 直接从中随机取字符 |
| 码点范围 | `{"range": ["U+E000", "U+F8FF"]}` | 范围内均匀取码点 |

预设字符池:

| 名称 | 内容概要 |
|---|---|
| `unicode-garbage` | `▓▒░█▄▀■□▪▫◘◙◆◇○●` 及制表/方框符号 |
| `zero-width` | U+200B U+200C U+200D U+2060 U+FEFF |
| `private-use` | U+E000–U+F8FF 私用区 |
| `combining` | U+0300–U+036F 组合附加符号 |
| `ascii-noise` | `!@#$%^&*()_+-=[]{}|;:,.<>?/~\`` |

> 零宽与组合字符在客户端可能显示为空白或文字重叠,这是预期效果;面板预览会用 `[U+200B]` 形式标注。

### 3.5 lorem 占位文本

```json
{ "type": "lorem", "words": { "min": 5, "max": 20 }, "capitalize": true }
```

从内置约 60 个拉丁词表中随机取词,空格连接;`capitalize` 为首字母大写。

### 3.6 repeat 重复

```json
{
  "type": "repeat",
  "times": { "min": 1, "max": 5 },
  "children": [
    { "type": "text", "value": ">" },
    { "type": "charset", "pool": "ascii-noise", "min": 1, "max": 3 }
  ]
}
```

`times` 可为整数或 `{min, max}` 区间;`children` 为按顺序执行的块数组。

### 3.7 rotate 跨请求轮换

```json
{
  "type": "rotate",
  "key": "greeting",
  "mode": "cycle",
  "scope": "ip",
  "options": ["A", "B", "C"]
}
```

| 字段 | 说明 |
|---|---|
| `key` | 轮换组标识;同 key 共享计数 |
| `mode` | `cycle` 按请求次序轮转;`random` 随机 |
| `scope` | `ip` 每 IP 独立计数;`global` 全局共享 |
| `options` | 1–1024 个字符串 |

状态存于 Durable Object;若本次请求已启用限流,rotate 结果随 acquire 响应一并返回(不额外消耗 DO 调用)。

### 3.8 echo 原样输出请求输入

```json
{ "type": "echo", "source": "all" }
```

把客户端本次请求的输入文本原样输出,仍受额度与预算截断。

| 字段 | 说明 |
|---|---|
| `source` | `all`(默认)= 拼接全部输入文本;`last` = 最后一条 user 消息 |

各接口的输入提取:

| 接口 | all | last |
|---|---|---|
| `/v1/chat/completions` | 所有消息的文本按顺序以换行连接 | 最后一条 `role=user` 消息 |
| `/v1/completions` | `prompt`(字符串或字符串数组) | 同 all |
| `/v1/responses` | `input`(字符串/消息数组/对象) | 最后一条 user 输入 |

### 3.9 sequence 顺序

```json
{ "type": "sequence", "children": [ ... ] }
```

从上到下拼接。作为根节点时即整个程序。

## 4. 解释器语义

```
interpret(node, budget, state) -> string:
  switch node.type:
    text      -> node.value
    random    -> pick(node.options)
    weighted  -> pickWeighted(node.options)
    charset   -> randomString(node.pool, randInt(node.min, node.max))
    lorem     -> randomWords(node.words)
    echo      -> node.source == 'last' ? state.inputs.last : state.inputs.all
    sequence  -> concat(interpret(child) for child in node.children)
    repeat    -> concat(interpret(children) for n in randInt(node.times))
    rotate    -> state.rotation[node.key]
```

- 每步拼接前检查 `budget`:超出预算立即截断并返回,不再执行后续块
- 随机数统一使用 `crypto.getRandomValues`,保证 Worker 与浏览器预览行为一致
- `charset` 的码点范围在生成时按 `String.fromCodePoint` 处理,避免代理对问题
- 解释过程无副作用(除 rotate 的读取),可安全用于预览

## 5. Blockly 映射

### 5.1 积木类型

| 积木 | BlockProgram type | 输入/字段设计 |
|---|---|---|
| 文本 | text | 多行文本字段(支持换行) |
| 原样输出请求输入 | echo | 下拉:全部输入 / 最后一条用户消息 |
| 随机选择 | random | 多行文本,每行一个选项 |
| 加权选择 | weighted | 多行文本,每行 `权重 空格 内容` |
| 字符池 | charset | 下拉(预设/自定义/范围)+ 最小/最大数字 |
| Lorem | lorem | 最小词数 / 最大词数 / 首字母大写复选框 |
| 重复 | repeat | 次数最小值 / 最大值 + statement 输入(children) |
| 轮换 | rotate | key 字段 + mode/scope 下拉 + 多行选项 |
| 顺序 | sequence | 无对应积木;工作区顶层块按顺序连接,由 `compileToProgram()` 自动包成 `{type:'sequence'}`(`blocks.js:563-570`) |

> 简化策略:列表类选项用多行文本(每行一项)而非 mutator,降低实现复杂度;后续可升级。

### 5.2 编译与序列化

- 编译:`compileToProgram(workspace)` 遍历顶层块 → BlockProgram(JSON)(`blocks.js:563-570`)
- 加载:`buildChain()`/`buildBlock()` 手工按 BlockProgram 创建并连接积木(`blocks.js:412-488`),**未使用** `Blockly.serialization` API
- 编辑器改动:变更监听去抖 300ms 后经 `onChange` 把 `compileToProgram()` 结果写回 JSON 文本框(`blocks.js:589-602`),**不会**自动触发校验或预览;校验/预览由用户点击"校验"/"预览"按钮显式执行(`app.js:658-685`)

### 5.3 工具箱分类

```
内容  : text / echo / lorem
随机  : random / weighted / charset
循环  : repeat
高级  : rotate
```

## 6. 内置方案示例

### 6.1 unicode 乱码

```json
{
  "type": "sequence",
  "children": [
    { "type": "charset", "pool": "unicode-garbage", "min": 12, "max": 40 },
    { "type": "text", "value": "\n" },
    { "type": "charset", "pool": { "range": ["U+E000", "U+F8FF"] }, "min": 6, "max": 16 }
  ]
}
```

### 6.2 lorem 循环

```json
{
  "type": "repeat",
  "times": { "min": 2, "max": 4 },
  "children": [
    { "type": "lorem", "words": { "min": 8, "max": 16 }, "capitalize": true },
    { "type": "text", "value": ". " }
  ]
}
```

### 6.3 轮换问候 + 乱码

```json
{
  "type": "sequence",
  "children": [
    { "type": "rotate", "key": "greeting", "mode": "cycle", "scope": "ip",
      "options": ["你好,", "Bonjour,", "こんにちは,", "Привет,"] },
    { "type": "text", "value": " " },
    { "type": "charset", "pool": "ascii-noise", "min": 20, "max": 60 }
  ]
}
```
