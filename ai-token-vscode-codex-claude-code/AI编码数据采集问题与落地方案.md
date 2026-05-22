# AI 编码数据采集问题与落地方案

## 1. 背景

目前团队希望统计 AI 写代码过程中的两类核心数据：

- AI 对话或编码轮次的 token 消耗
- AI 实际产生的代码变更行数

涉及的工具包括：

- VSCode 中的 AI 插件或内置能力
- Codex
- Claude Code

目标不是只做单个工具的统计，而是建立一套大家都能适配、可以统一上传到线上、后续能做团队看板和成本分析的数据采集方案。

## 2. 核心结论

推荐采用：

```text
全局本地采集器 + 线上统一上报接口 + token 异步回填
```

整体架构：

```text
VSCode / Codex / Claude Code
        |
        v
本地 ai-coding-reporter
        |
        | 统计 Git 代码变更
        | 读取或等待 token 日志
        | 本地 SQLite 缓存
        | 异步上传和失败重试
        v
线上 API / 数据库 / 看板
```

不建议第一版直接绑定某一个工具，也不建议每个项目安装一份采集工具。更合适的做法是开发者电脑上全局安装一次，所有项目共用。

## 3. 为什么选择全局本地采集器

### 3.1 不需要每个项目安装

采集器全局安装一次即可，例如：

```bash
ai-coding-reporter login
ai-coding-reporter status
```

进入任意 Git 项目目录后，采集器可以自动识别当前项目：

```bash
cd your-project
ai-coding-reporter start
ai-coding-reporter end --tool codex
```

每个项目只在有特殊规则时才需要可选配置文件：

```text
.ai-coding-reporter.json
```

例如：

```json
{
  "projectName": "订单系统",
  "exclude": ["dist", "coverage", "package-lock.json"]
}
```

### 3.2 工具适配性最好

统一采集器可以同时适配：

- Codex CLI
- Claude Code
- VSCode 扩展
- 未来其他 AI 编码工具

各工具只需要把数据交给同一个本地采集器，线上只接收一种统一数据结构。

## 4. 统计粒度

用户期望是：

```text
每次 AI 对话之后就能统计本次消耗和本次代码变更
```

因此建议统计粒度定义为：

```text
AI 对话轮次 turn
```

一条 turn 记录代表一次用户 prompt 到 AI 回复完成之间的过程。

示例数据：

```json
{
  "turnId": "codex-20260521-xxxx",
  "conversationId": "codex-session-xxxx",
  "tool": "codex",
  "modelName": "gpt-5-codex",
  "startedAt": "2026-05-21T10:00:00+08:00",
  "endedAt": "2026-05-21T10:03:00+08:00",
  "filesChanged": 3,
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150,
  "inputTokens": 12000,
  "outputTokens": 3000,
  "totalTokens": 15000,
  "tokenStatus": "completed"
}
```

## 5. 如何判断对话开始和结束

不能用单一规则硬猜所有工具。推荐按可靠度分层处理。

### 5.1 对话开始

优先级从高到低：

```text
1. 用户提交 prompt 的事件
2. 包装命令启动 AI 工具前
3. AI 工具进程或日志开始活跃
```

VSCode 场景：

```text
用户点击发送 prompt = 对话开始
```

Codex / Claude Code 场景：

```text
ai-codex / ai-claude 包装器启动真实工具前 = 对话开始
```

对话开始时需要记录：

```text
turnId
conversationId
startedAt
当前 Git 基线
当前分支
当前 commit
```

### 5.2 对话结束

优先级从高到低：

```text
1. AI 回复完成事件
2. 日志里出现 response completed / message stop / turn completed
3. CLI 回到等待输入状态
4. 一次性命令进程退出
5. AI 输出停止 + 文件变更稳定若干秒
```

VSCode 场景：

```text
AI 回复完成事件 / 插件回调 = 对话结束
```

Codex / Claude Code 场景：

```text
优先使用 hook 或日志事件
没有事件时使用包装命令或终端状态判断
```

对话结束时立即做：

```text
1. 统计本轮 Git 代码变更
2. 保存本地 turn 记录
3. 上传代码变更数据
4. token 如果没拿到，标记 pending
```

## 6. 代码行数统计

代码变更建议使用 Git diff，而不是扫描整个项目。

推荐统计口径：

```text
AI 代码变更行数 = 新增行数 + 删除行数
净增行数 = 新增行数 - 删除行数
```

推荐命令：

```bash
git diff --numstat
```

未跟踪新文件需要单独处理：

```bash
git ls-files --others --exclude-standard
```

原因：

```text
git diff --numstat 默认只统计已跟踪文件的工作区变更，不会统计未跟踪新文件。
如果 AI 新建了文件但尚未 git add，直接使用 git diff --numstat 会漏算。
```

未跟踪文本文件的统计规则：

```text
linesAdded = 文件当前文本行数
linesDeleted = 0
codeLinesChanged = linesAdded
```

二进制未跟踪文件跳过。

更重要的是，第一版不能把当前工作区累计 diff 直接当作本轮变更。必须采用：

```text
本轮变更 = 结束快照 - 开始快照
```

开始快照需要记录：

```text
1. trackedNumstat：git diff --numstat 输出
2. untrackedFiles：git ls-files --others --exclude-standard 输出
3. untrackedFileLineCounts：未跟踪文本文件行数
```

结束时再次读取同样数据，并计算本轮增量。

如果某个未跟踪文件在本轮开始时不存在、结束时存在：

```text
本轮新增行 = 文件当前行数
```

如果某个未跟踪文件在本轮开始时已经存在、结束时仍存在：

```text
本轮新增行 = 结束行数 - 开始行数
```

如果本轮只是确认、解释、排查，没有执行文件写入、格式化、生成或删除操作：

```text
roundChanged = 0
codeStatsSource = no file edits in this round
codeStatsPrecision = exact
```

不能因为工作区已有未提交变更，就把累计 diff 重复记到当前轮次。

默认排除：

```text
node_modules
dist
build
coverage
.next
out
target
lock 文件
图片
压缩包
二进制文件
```

为什么代码变更要在对话结束后立刻统计：

- 用户可能马上继续下一轮 AI 对话
- 用户可能手动修改代码
- 代码边界一旦错过，很难准确还原

因此代码行数是必须即时固化的数据。

## 7. Token 采集问题

### 7.1 现实问题

很多工具的 token 日志不是 AI 回复完成时立即可用，而是稍后才写入日志文件。

这会导致：

```text
代码变更已经能统计
token 消耗暂时拿不到
```

如果强行等待 token 日志，会带来问题：

- 用户体验变差
- 本轮代码边界容易被下一轮修改污染
- 日志迟迟不生成时整条记录卡住

### 7.2 推荐方案：token 异步回填

不要等待 token。采用两阶段上报：

```text
第一阶段：对话结束后立即上报代码变更
第二阶段：token 日志生成后异步回填
```

第一阶段数据：

```json
{
  "turnId": "codex-20260521-xxxx",
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150,
  "tokenStatus": "pending",
  "codeStatus": "completed"
}
```

第二阶段回填：

```http
PATCH /api/ai-codingTurns/{turnId}/tokens
```

```json
{
  "inputTokens": 12000,
  "outputTokens": 3000,
  "totalTokens": 15000,
  "tokenStatus": "completed",
  "tokenSource": "log_delayed"
}
```

## 8. 避免所有 pending 都扫描日志

不能让每条 pending 记录都单独扫描日志，否则 pending 一多会重复读取日志，性能很差。

正确方式：

```text
不是 pending turn 去找日志
而是一个日志增量采集器读取新增日志
再把 token event 匹配给 pending turn
```

推荐结构：

```text
日志文件
  |
  v
token watcher
  |
  | 只读取新增内容
  v
token_events 表
  |
  v
批量匹配 pending turns
```

token watcher 需要做：

```text
1. 记录每个日志文件上次读到的 offset
2. 下次只读取新增内容
3. 解析新增 token event
4. 批量匹配 token_status = pending 的 turns
```

匹配优先级：

```text
1. messageId / requestId
2. sessionId + turnIndex
3. sessionId + 时间窗口
4. 最近 pending turn
```

如果仅靠时间窗口且匹配不唯一，不要强行回填，应该标记：

```text
tokenStatus = ambiguous
```

## 9. Token 状态设计

推荐 token_status：

```text
pending      等待日志回填
completed    已拿到 token
timeout      超时未拿到
unavailable  当前工具不支持 token 获取
ambiguous    匹配不唯一
```

推荐 token_source：

```text
official      官方 API 或官方 usage
tool_log      工具日志
log_delayed   延迟日志回填
estimated     本地估算
unavailable   无法获取
```

pending 不应该无限期存在。建议：

```text
10 分钟内高频匹配
24 小时内低频补偿
超过 24 小时标记 timeout
```

## 10. 本地存储方案

推荐使用 SQLite。

### 10.1 是否需要单独安装 SQLite

一般不需要开发者单独安装 SQLite。

SQLite 可以作为采集器内置依赖：

```text
Node.js / TypeScript：better-sqlite3 或 sqlite3
Go：modernc.org/sqlite 或 mattn/go-sqlite3
Python：标准库 sqlite3
Rust：rusqlite
```

用户只需要安装采集器：

```bash
ai-coding-reporter login
ai-coding-reporter status
```

### 10.2 本地数据库位置

推荐位置：

```text
Windows:
%APPDATA%\ai-coding-reporter\reporter.db

macOS:
~/Library/Application Support/ai-coding-reporter/reporter.db

Linux:
~/.local/share/ai-coding-reporter/reporter.db
```

### 10.3 核心表

#### turns

每次 AI 对话轮次记录。

```sql
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  model_name TEXT,

  project_path TEXT,
  project_name TEXT,
  git_branch TEXT,
  commit_before TEXT,
  commit_after TEXT,

  started_at TEXT NOT NULL,
  ended_at TEXT,

  files_changed INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_deleted INTEGER DEFAULT 0,
  code_lines_changed INTEGER DEFAULT 0,

  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  token_status TEXT NOT NULL DEFAULT 'pending',
  token_source TEXT,

  upload_status TEXT NOT NULL DEFAULT 'pending',
  remote_id TEXT,

  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### token_events

从日志中解析出来的 token 事件。

```sql
CREATE TABLE token_events (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  session_id TEXT,
  message_id TEXT,
  request_id TEXT,

  occurred_at TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,

  matched_turn_id TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);
```

#### log_offsets

记录日志文件读到哪里，避免重复扫描。

```sql
CREATE TABLE log_offsets (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_id TEXT,
  last_offset INTEGER NOT NULL DEFAULT 0,
  last_modified TEXT,
  updated_at TEXT NOT NULL
);
```

#### upload_queue

上传失败重试队列。

```sql
CREATE TABLE upload_queue (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 11. 线上接口设计

### 11.1 创建对话轮次

```http
POST /api/ai-codingTurns
```

请求示例：

```json
{
  "turnId": "codex-20260521-xxxx",
  "conversationId": "codex-session-xxxx",
  "tool": "codex",
  "modelName": "gpt-5-codex",
  "projectName": "订单系统",
  "gitBranch": "feature/order",
  "startedAt": "2026-05-21T10:00:00+08:00",
  "endedAt": "2026-05-21T10:03:00+08:00",
  "filesChanged": 3,
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150,
  "tokenStatus": "pending"
}
```

### 11.2 回填 token

```http
PATCH /api/ai-codingTurns/{turnId}/tokens
```

请求示例：

```json
{
  "inputTokens": 12000,
  "outputTokens": 3000,
  "totalTokens": 15000,
  "tokenStatus": "completed",
  "tokenSource": "log_delayed"
}
```

### 11.3 接口要求

线上接口应该支持：

```text
1. token 字段允许为空
2. turnId 幂等
3. token 可后续 PATCH 回填
4. 重复上传不会产生重复记录
5. 支持上传失败后重试
```

## 12. 上传失败和补传

本地采集器不能因为线上接口失败就丢数据。

推荐策略：

```text
1. 对话结束后先写本地 SQLite
2. 再尝试上传
3. 上传失败写入 upload_queue
4. 后台定时重试
5. 成功后更新 upload_status
```

upload_status：

```text
pending
uploaded
failed
```

重试策略：

```text
5 秒
30 秒
2 分钟
10 分钟
30 分钟
之后低频重试
```

## 13. 乱码问题处理

Prompt 出现乱码通常不是 SQLite 的问题，而是采集、命令行、日志读取、HTTP 上传某一环编码不一致。

推荐统一规则：

```text
全链路 UTF-8
不通过命令行参数传完整中文 prompt
不手写 JSON 拼接
HTTP 使用 POST JSON
```

### 13.1 SQLite

SQLite 原生支持 UTF-8，字段使用 TEXT 即可。

建议默认不保存完整 prompt，只保存：

```text
prompt_hash
prompt_preview
prompt_encoding = utf-8
```

### 13.2 日志读取

读取日志时明确指定：

```text
encoding = utf8
```

不要使用系统默认编码。Windows 中文环境下默认编码可能导致 UTF-8 日志被读成乱码。

### 13.3 HTTP 上传

请求头：

```http
Content-Type: application/json; charset=utf-8
```

不要把 prompt 放到 URL query 中。

不推荐：

```http
GET /report?prompt=修复中文乱码
```

推荐：

```http
POST /api/ai-codingTurns
Content-Type: application/json; charset=utf-8
```

### 13.4 跨进程传 prompt

不要这样传：

```bash
ai-coding-reporter end --prompt "帮我修复中文乱码"
```

推荐方式：

```text
1. 工具内部从日志读取 prompt
2. stdin
3. UTF-8 JSON 临时文件
4. Base64
5. 只传 promptHash
```

### 13.5 JSON 序列化

必须使用语言内置 JSON 序列化，不要手写字符串拼接。

## 14. 性能影响

如果采用事件触发和 Git diff，性能影响很低。

推荐目标：

```text
对话开始开销 < 200ms
对话结束本地统计 < 1s
上传不阻塞用户
常驻进程 CPU 接近 0
内存几十 MB 以内
```

避免以下做法：

```text
持续扫描整个项目
每次文件变化都跑完整 diff
扫描 node_modules / dist / build
解析所有源码文件计算行数
每条 pending 都重复扫描日志
同步等待网络上传
```

正确做法：

```text
1. 只在对话开始和结束时统计
2. 使用 git diff --numstat
3. token watcher 只增量读取日志
4. 上传异步执行
5. 大仓库统计超时后转后台补算
```

## 15. 推荐落地阶段

### 第一阶段：CLI MVP

目标：快速跑通数据链路。

能力：

```text
1. 全局安装 ai-coding-reporter
2. 手动 start / end
3. Git diff 统计代码行数
4. 本地 SQLite 存储
5. 上传线上 API
6. token 字段允许 pending / unavailable
```

示例：

```bash
ai-coding-reporter start
ai-coding-reporter end --tool codex --model gpt-5-codex
```

### 第二阶段：包装命令

目标：减少用户手动操作。

示例：

```bash
ai-codex
ai-claude
```

内部流程：

```text
记录开始
启动真实 AI 工具
检测对话结束
统计代码变更
上传
等待 token 日志后回填
```

### 第三阶段：VSCode 扩展

目标：覆盖编辑器内 AI 对话。

能力：

```text
1. 监听用户发送 prompt
2. 监听 AI 回复完成
3. 调用本地采集器
4. 显示上传状态
5. 失败时允许重试
```

### 第四阶段：自动 token 接入和看板

目标：提升统计完整度。

能力：

```text
1. Codex token 日志解析
2. Claude Code token 日志解析
3. VSCode 插件 token 接入
4. 线上看板
5. 按人、项目、工具、模型统计成本和产出
```

## 16. 最终建议

最适合团队落地的方案是：

```text
全局本地采集器
+ SQLite 本地缓存
+ Git diff 统计代码行数
+ token 延迟回填
+ 线上统一 API
+ VSCode/CLI 分别适配
```

关键原则：

```text
1. 代码行数对话结束后立即统计
2. token 不阻塞，允许 pending 后续回填
3. 日志只由一个 watcher 增量读取
4. 本地必须有 SQLite 缓存和上传队列
5. 全链路使用 UTF-8，避免 prompt 乱码
6. 线上接口必须支持幂等和 PATCH 回填
```

这套方式能兼顾准确性、性能、工具适配性和团队推广成本。
## 17. 后续增强：AI 输出代码撤销监听

当前第一版不实现精确的“点击撤销”监听，只统计对话结束后最终保留的代码变更。撤销监听作为后续增强能力实现。

### 17.1 需要区分两个指标

后续统计时建议区分：

```text
generated code changes：AI 曾经生成或写入过的代码量
retained code changes：对话结束后最终保留下来的代码量
discarded code changes：AI 生成后又被撤销、删除或覆盖的代码量
```

示例：

```text
AI 输出并插入 100 行
用户点击撤销
最终文件没有变化
```

应记录为：

```json
{
  "generatedLinesAdded": 100,
  "retainedLinesAdded": 0,
  "discardedLines": 100,
  "discardStatus": "discarded"
}
```

## 18. 当前风险与口径边界

### 18.1 对话边界可能不准

“每次对话开始/结束”在不同工具里不一定都有稳定事件。

可能出现：

```text
上一轮 AI 改的代码，被算到下一轮
用户手动改的代码，被算成 AI 代码
AI 还没结束，采集器提前统计
```

第一版建议接受“轮次统计近似准确”，不要承诺 100% 精确。对外口径应定义为：

```text
AI 会话期间产生的最终代码变更
```

而不是：

```text
AI 亲手写入的全部代码
```

### 18.2 代码归因不一定准确

Git diff 只能看到最终文件变化，不能天然区分是谁造成的。

同一段时间内可能混入：

```text
AI 修改
用户手动修改
格式化工具修改
另一个 AI 工具修改
git 操作造成的变化
```

因此第一版的代码行数指标更准确地说是：

```text
AI 会话窗口内的代码变更
```

不是绝对精确的：

```text
AI 独立贡献代码行数
```

后续如果要提升归因准确度，需要接入 VSCode 扩展、AI 写入 patch、文件变化事件等更细粒度数据。

### 18.3 token 和代码行数可能对不上

token 来自工具日志或 API，代码行数来自 Git diff，两者可用时间不同。

可能出现：

```text
代码行数已经上报，token 还没生成
用户继续下一轮修改，影响后续匹配
token 日志按时间窗口匹配到错误 turn
多个 pending turn 同时等待 token 回填
```

处理原则：

```text
代码行数立即上报
token 异步回填
使用 turnId / sessionId / requestId / 时间窗口匹配
匹配不唯一时标记 ambiguous
```

不要为了等 token 阻塞代码行数上报。

### 18.4 需求绑定粒度可能太粗

第一版建议：

```text
conversationId = <client>:<absolute project path>
```

这个规则简单稳定，但存在限制：

```text
同一项目同时做多个需求时，需要手动切换绑定
多窗口同时操作同一项目时，可能互相影响
同一个 AI 会话中切换需求时，历史 turn 不自动迁移
```

第一版需要明确限制：

```text
同一项目、同一工具、同一时间默认只绑定一个需求
```

后续可升级为：

```text
conversationId = <client>:<absolute project path>:<sessionId>
```

### 18.5 skill 和 CLI 容易造成用户理解混乱

如果同时存在 `ai-coding-requirement` skill 和 `ai-coding-reporter req` 命令，用户可能误以为：

```text
/req 123
```

就是正式绑定入口。

当前推荐正式入口是：

```bash
ai-coding-reporter req 123
```

skill 只做说明、提示或低频兜底，不进入主链路。需要在用户文档和 CLI 提示里明确：

```text
正式需求绑定以 ai-coding-reporter CLI / VSCode 扩展为准
```

### 18.6 本地 SQLite 和线上状态可能不一致

本地缓存会带来同步问题。

可能出现：

```text
本地绑定成功，线上绑定失败
线上绑定被修改，本地没有同步
用户换电脑后没有本地缓存
用户删除本地数据库
离线时无法确认需求权限
```

建议原则：

```text
线上为准，本地是缓存
```

本地绑定成功但线上失败时，不应直接认为绑定已完成，应进入待同步状态或提示用户重试。

### 18.7 中文乱码风险需要实测

Windows 环境下，以下位置都可能出现中文乱码：

```text
命令行参数
日志文件读取
PowerShell 输出
HTTP body
JSON 序列化
中文路径
中文需求名
中文 prompt preview
```

必须测试：

```text
中文需求标题
中文项目名称
中文 prompt
中文路径
中英文混合 JSON
```

实现上坚持：

```text
全链路 UTF-8
HTTP 使用 application/json; charset=utf-8
不通过命令行参数传完整中文 prompt
使用 JSON 序列化
```

### 18.8 撤销监听不要过早承诺

CLI 无法知道用户是否点击了撤销按钮，只能判断 AI 生成内容是否被删除、覆盖或恢复。

对外口径建议：

```text
第一版不统计撤销
后续统计 AI 代码被保留/被丢弃
不承诺统计用户是否点击撤销按钮
```

精确监听撤销动作需要 VSCode 扩展阶段再实现。

### 18.9 性能问题主要来自错误实现

方案本身性能影响较低，但错误实现会导致明显性能问题。

需要避免：

```text
每个 pending turn 都扫描日志
每次文件变化都执行 git diff
监听 node_modules / dist / build
同步等待上传完成
全仓库扫描源码计算行数
```

必须坚持：

```text
事件触发
日志增量读取
异步上传
排除大目录
大仓库超时后后台补算
```

### 18.10 指标口径可能被误读

`codeLinesChanged` 容易被误解为“AI 有效产出”，但它可能包含：

```text
删除行
格式化变化
反复修改
最终被丢弃的代码
用户手动补充的代码
```

看板中建议区分：

```text
AI 会话变更行数
最终保留行数
token 消耗
需求归属
token 是否完整
数据置信度
```

最重要的第一版口径：

```text
第一版统计的是“AI 会话期间的最终代码变更”和“该会话 token 消耗”，
不是绝对精确的“AI 亲手写入且最终有效的代码量”。
```

## 19. 风险项解决方案

本章节用于把第 18 章中的风险转成第一版可执行方案。撤销监听暂时不处理，只作为后续可能增强项保留。

### 19.1 对话边界不准的解决方案

采用“开始基线 + 结束快照”的单轮统计口径。

开始时记录：

```text
startedAt
conversationId
turnId
tool
projectPath
gitBranch
commitBefore
tracked diff snapshot
untracked files snapshot
```

结束时再次读取：

```text
tracked diff snapshot
untracked files snapshot
endedAt
```

本轮变更按下面方式计算：

```text
本轮代码变更 = 结束快照 - 开始基线
```

这样可以避免多轮未提交时反复把历史工作区 diff 算进去。

具体规则：

```text
1. 不直接把当前 git diff --numstat 当成本轮变更
2. 每轮开始都保存 baseline
3. 每轮结束都保存 final snapshot
4. 单轮统计只计算 baseline 到 final 的增量
5. 如果无法计算增量，在 metadata 中标记 codeStatsPrecision = estimated
```

推荐 metadata：

```json
{
  "codeStatsSource": "baseline diff snapshot",
  "codeStatsPrecision": "exact",
  "workspaceCumulativeChanged": 710,
  "roundChanged": 46
}
```

### 19.2 代码归因不准的解决方案

第一版不承诺“AI 独立贡献代码行数”，统一定义为：

```text
AI 会话窗口内的最终代码变更
```

为了降低误差，执行以下约束：

```text
1. start 和 end 之间尽量只执行当前 AI 编码任务
2. 包装命令 ai-codex / ai-claude 自动包住 AI 会话窗口
3. VSCode 场景由扩展提供开始统计和结束上传按钮
4. 上报时写入 codeStatsAttribution = ai_session_window
5. 用户手工修改较多时允许标记 codeStatsPrecision = mixed
```

Dashboard 展示时不要写成“AI 生成代码行数”，建议使用：

```text
AI 会话变更行数
```

后续如果要进一步提升归因准确度，再接入：

```text
AI 写入 patch
编辑器文档变更事件
文件级 before/after hash
```

### 19.3 token 和代码行数对不上的解决方案

采用两阶段上报：

```text
第一阶段：对话结束后立即上报代码变更
第二阶段：token 日志可用后异步回填
```

第一阶段：

```json
{
  "turnId": "codex-20260521-xxxx",
  "codeStatus": "completed",
  "tokenStatus": "pending",
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150
}
```

第二阶段：

```json
{
  "turnId": "codex-20260521-xxxx",
  "inputTokens": 12000,
  "outputTokens": 3000,
  "totalTokens": 15000,
  "tokenStatus": "completed",
  "tokenSource": "log_delayed"
}
```

匹配 token 时按优先级处理：

```text
1. requestId / messageId 精确匹配
2. sessionId + turnId 匹配
3. sessionId + 时间窗口匹配
4. projectPath + tool + 最近 pending turn 匹配
```

如果存在多个候选，不自动绑定，状态改为：

```text
needs_review
```

如果候选已经被其他 turn 占用，状态改为：

```text
conflict
```

token 状态建议统一为：

```text
pending
completed
not_found
needs_review
conflict
failed
unavailable
```

### 19.4 需求绑定粒度太粗的解决方案

第一版维持简单规则：

```text
conversationId = <client>:<absolute project path>
```

并明确限制：

```text
同一项目、同一工具、同一时间默认只绑定一个需求
```

为避免误绑，绑定切换时采用“只影响后续 turn”的规则：

```text
1. ai-coding-reporter req 123 之后的新 turn 绑定 #123
2. 切换到 #124 后，只有新 turn 绑定 #124
3. 历史 turn 不自动改绑
4. 历史迁移交给线上管理能力处理
```

本地 `turns` 表在生成 turn 时固化：

```text
requirement_id
requirement_title
selection_version 或 selected_at
```

后续升级方案：

```text
conversationId = <client>:<absolute project path>:<sessionId>
```

### 19.5 skill 和 CLI 混用的解决方案

正式入口只保留一个：

```bash
ai-coding-reporter req 123
```

skill 不进入主链路，只做提示：

```text
当前正式绑定命令是 ai-coding-reporter req <requirementId>
```

CLI 输出中明确当前绑定状态：

```text
Current requirement: #123 订单系统 AI 编码统计
Source: local cache, synced online
```

VSCode 扩展中也使用同一套本地 CLI 或同一套 HTTP API，避免出现多套绑定状态。

### 19.6 本地 SQLite 和线上状态不一致的解决方案

原则：

```text
线上为准，本地是缓存
```

本地绑定状态增加同步状态：

```text
synced
pending_sync
sync_failed
stale
```

绑定流程：

```text
1. 用户执行 ai-coding-reporter req 123
2. CLI 调线上绑定 API
3. 线上成功后写入本地 requirement_selections，状态 synced
4. 线上失败时不标记为正式绑定，只记录失败原因并提示重试
```

离线场景：

```text
1. 如果本地已有 synced 绑定，可以继续使用缓存
2. 如果要新增绑定但无法访问线上，进入 pending_sync
3. pending_sync 数据上报时标记 requirementBindingStatus = pending_sync
4. 网络恢复后补同步
```

上报使用幂等键：

```text
idempotencyKey = local-turn-<turnId>
```

后端必须保证重复提交不会重复入库。

### 19.7 中文乱码的解决方案

实现时按 UTF-8 全链路处理。

硬性要求：

```text
1. SQLite TEXT 字段保存 UTF-8
2. HTTP 请求头使用 Content-Type: application/json; charset=utf-8
3. 后端数据库使用 UTF8 / utf8mb4
4. 日志读取显式指定 utf8
5. JSON 使用语言内置序列化，不手写拼接
6. 不通过命令行参数传完整中文 prompt
```

跨进程传中文时优先使用：

```text
stdin
UTF-8 JSON 文件
Base64
promptHash + promptPreview
```

测试用例必须覆盖：

```text
中文需求名
中文项目名
中文路径
中文 prompt preview
中英文混合 JSON
Windows PowerShell
cmd
Git Bash
```

### 19.8 撤销监听的处理策略

暂时不处理，不在第一版承诺。

第一版只统计：

```text
retained code changes：对话结束后最终保留的代码变更
```

对外不承诺：

```text
用户是否点击撤销按钮
AI 代码是否曾经生成后又被撤销
```

后续如需处理，预留方向：

```text
1. VSCode 扩展监听 onDidChangeTextDocument
2. AI edit 写入时记录 patch
3. 后续判断 patch 是否被反向抵消
4. 增加 generated / retained / discarded 三类指标
```

当前文档只保留该方向，不进入第一版实施范围。

### 19.9 性能问题的解决方案

性能控制原则：

```text
事件触发，不持续全量扫描
日志增量读取，不重复扫全量日志
异步上传，不阻塞用户
大目录默认排除
大仓库超时后后台补算
```

具体约束：

```text
1. 只在 start/end 或 AI turn 完成时统计代码
2. 不在每次文件变化时执行 git diff
3. token watcher 保存 file offset，只读取新增日志
4. pending turn 不逐条扫描日志
5. 排除 node_modules、dist、build、coverage、.next、target、out
6. 本地统计超过 2 秒转后台任务
7. 上传失败进入 upload_queue，后台重试
```

目标：

```text
对话开始开销 < 200ms
对话结束本地统计 < 1s
上传不阻塞
常驻进程 CPU 接近 0
```

### 19.10 指标口径误读的解决方案

Dashboard 和 API 字段需要拆分含义，避免把所有代码行数都叫“AI 有效产出”。

推荐展示：

```text
AI 会话变更行数
最终保留行数
token 消耗
token 完整状态
数据置信度
需求归属
```

推荐 metadata：

```json
{
  "codeStatsSource": "baseline diff snapshot",
  "codeStatsAttribution": "ai_session_window",
  "codeStatsPrecision": "exact",
  "tokenStatus": "completed",
  "tokenSource": "log_delayed"
}
```

Dashboard 文案避免：

```text
AI 有效代码产出
AI 亲手写入代码量
```

建议使用：

```text
AI 会话变更
本轮代码变更
最终保留变更
```

## 20. 第一版实施决策

本章节记录当前已确认的第一版落地决策。

### 20.1 统计粒度

第一版目标是统计到：

```text
每一轮 AI 对话的数据
```

一轮 AI 对话定义为：

```text
用户提交一次 prompt
  ↓
AI 完成一次回复和代码处理
  ↓
采集器生成一条 turn 统计
```

每条 turn 至少包含：

```text
turnId
conversationId
tool
modelName
startedAt
endedAt
requirementId
filesChanged
linesAdded
linesDeleted
codeLinesChanged
tokenStatus
inputTokens
outputTokens
totalTokens
uploadStatus
```

如果某个工具暂时无法稳定识别每轮对话结束，则该工具先降级为：

```text
一次 start/end = 一条 turn
```

但数据模型仍按 turn 设计，后续工具能力增强后可以平滑升级。

开发前必须做实测验证：

```text
1. Codex CLI 是否能稳定拿到每轮对话开始和结束事件
2. Claude Code 是否能稳定拿到每轮对话开始和结束事件
3. 日志中是否存在 turnId / messageId / requestId
4. 交互式会话是否能判断 AI 已回到等待输入状态
5. 如果无法拿到明确事件，记录可用的降级流程
```

实测结果需要沉淀为工具适配表：

```text
tool
startSignal
endSignal
turnIdSource
fallbackMode
knownLimitations
```

每个工具必须产出具体测试数据，不只写结论。至少包含 prompt 时间、AI 回复完成时间、日志写入时间、代码落盘时间、可用的 turnId/requestId/messageId 和结束判断信号。

### 20.2 Codex / Claude Code token 来源

token 来源参考 `C:\Users\00232924\Desktop\mcp` 项目中的已有实现：

```text
scripts/sync-token-usage.ts
scripts/sync-token-usage-recent.ts
scripts/auto-sync-loop.ts
```

第一版复用其中的思路：

```text
1. 先记录 turn
2. token 日志延迟生成时先标记 pending
3. 后台或手动脚本扫描 Codex / Claude Code 日志
4. 解析 token usage event
5. 根据 turnId / sessionId / 时间窗口匹配 turn
6. 匹配成功后回填 token
7. 匹配不唯一进入 needs_review / conflict
```

优先匹配顺序：

```text
exact tool call / requestId
turnId
sessionId + turnIndex
sessionId + 时间窗口
tool + projectPath + 最近 pending turn
```

开发前必须实测：

```text
1. Codex token 日志路径
2. Claude Code token 日志路径
3. 日志格式和关键字段
4. 日志生成延迟
5. 日志轮转规则
6. 多轮对话时 token event 是否能区分
7. 多项目同时使用时是否能区分 projectPath / sessionId
```

实测结果需要保存为配置或适配文档：

```text
client
logPaths
eventFormat
tokenFields
sessionField
turnField
delayRange
matchStrategy
```

### 20.3 CLI 启动、关闭和监听模式

第一版需要同时支持三种模式，方便不同团队习惯使用。

#### 手动模式

用户显式执行：

```bash
ai-coding-reporter start
ai-coding-reporter end --tool codex
```

适合：

```text
调试
早期试点
用户希望自己控制统计边界
```

#### 单次自动模式

执行一次完整链路：

```bash
ai-coding-reporter run --tool codex
```

内部流程：

```text
start
启动真实 AI 工具或等待本轮结束
end
token sync once
upload once
```

也可以提供包装命令：

```bash
ai-codex
ai-claude
```

#### 常驻监听模式

用户可自行开启：

```bash
ai-coding-reporter daemon start
```

用户可自行关闭：

```bash
ai-coding-reporter daemon stop
```

查看状态：

```bash
ai-coding-reporter daemon status
```

支持自定义监听配置：

```bash
ai-coding-reporter daemon start --token-interval 180 --upload-interval 600
```

配置项建议：

```text
enableTokenWatcher
enableUploadWorker
tokenIntervalSeconds
uploadIntervalSeconds
lookbackMinutes
maxBatchSize
excludedPaths
```

实现上参考 `mcp` 项目 `scripts/auto-sync-loop.ts`：

```text
1. 使用 lock 防止多个 daemon 同时运行
2. 保存 heartbeat 状态
3. 支持 --once 单次执行
4. 支持 SIGINT / SIGTERM 优雅停止
5. 定时执行 token sync 和 online sync
```

第一版暂不实现常驻 daemon，避免拖慢 MVP。

第一版只实现：

```text
1. 手动 start/end
2. 手动 token sync
3. 手动 online sync
4. 手动 reconcile
5. status 状态查看
6. stop 停止当前正在运行的 reporter 脚本
```

daemon 作为后续增强：

```text
ai-coding-reporter daemon start
ai-coding-reporter daemon stop
ai-coding-reporter daemon status
```

### 20.4 用户身份和工号绑定

第一版需要支持用户工号，后续用户可以根据自己的工号查看线上数据。

推荐使用命令行登录，并生成用户配置文件。用户后续可以根据需要修改配置文件。

登录命令：

```bash
ai-coding-reporter login
```

也支持直接指定工号：

```bash
ai-coding-reporter login --employee-id 00232924
```

交互内容：

```text
请输入工号
请输入访问 token 或进行浏览器授权
```

也支持非交互模式，方便脚本和批量部署：

```bash
ai-coding-reporter login --employee-id 00232924 --token <token>
```

本地保存：

```text
employeeId
userName
teamId
accessToken
tokenExpiresAt
apiBaseUrl
```

保存位置：

```text
当前脚本目录/.ai-coding-reporter/config.json

同时 SQLite 中保存 user_profile 表，方便查询和上报关联。
```

第一版先把配置和本地数据库放在当前脚本目录下，方便开发、调试、查看和手动修改。后续团队推广时，再考虑迁移到 `%APPDATA%` 或用户级目录。

生成的配置文件示例：

```json
{
  "employeeId": "00232924",
  "userName": "",
  "teamId": "",
  "apiBaseUrl": "https://ai-test.sbtjt.com/api/ai-coding",
  "accessToken": "",
  "createdAt": "2026-05-21T10:00:00+08:00",
  "updatedAt": "2026-05-21T10:00:00+08:00"
}
```

注意事项：

```text
1. 配置文件不要生成到项目目录，避免误提交
2. login 命令负责创建和更新配置文件
3. 用户可手动修改 employeeId / apiBaseUrl / token
4. 修改后可执行 ai-coding-reporter status 验证配置是否可用
```

建议本地表：

```sql
CREATE TABLE user_profile (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  user_name TEXT,
  team_id TEXT,
  api_base_url TEXT NOT NULL,
  token_expires_at TEXT,
  login_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

上报 turn 时带上：

```json
{
  "employeeId": "00232924",
  "userName": "张三"
}
```

如果 token 过期：

```text
1. CLI 提示重新 login
2. 已采集数据继续保留在本地 upload_queue
3. 登录恢复后继续补传
```

### 20.5 线上接口幂等规则

幂等规则参考 `C:\Users\00232924\Desktop\mcp\scripts\sync-to-online.ts`。

第一版固定使用：

```text
idempotencyKey = local-turn-<turnId>
```

或：

```text
idempotencyKey = local-round-<localRoundId>
```

推荐统一为：

```text
idempotencyKey = local-turn-<turnId>
```

规则：

```text
1. turnId 本地全局唯一
2. POST /turns 必须带 idempotencyKey
3. 后端收到重复 idempotencyKey 时返回已有记录
4. 不允许重复创建 turn
5. token 回填只允许更新同一个 turn
6. token event 也需要 sourceEventId 防重复
```

本地上传成功后保存：

```text
remoteId
uploadStatus = uploaded
syncedAt
```

如果后端返回的是雪花 ID 或大整数，前端和本地都按字符串保存。

### 20.6 本地数据保留策略

本地 SQLite 不应该无限增长。

建议第一版保留策略：

```text
1. 未上传 / 上传失败 / token pending 数据永久保留，直到完成或用户手动清理
2. 已上传且 token completed 的 turn 默认保留 90 天
3. token_events 默认保留 30 天
4. log_offsets 长期保留
5. upload_queue 成功记录保留 30 天，失败记录保留 90 天
6. debug 原始日志不复制保存，只记录 sourcePath、offset、eventId
```

提供清理命令：

```bash
ai-coding-reporter cleanup
ai-coding-reporter cleanup --before 2026-01-01
ai-coding-reporter cleanup --uploaded-older-than 90d
```

提供导出命令：

```bash
ai-coding-reporter export --from 2026-05-01 --to 2026-05-21
```

清理前必须保护：

```text
pending
failed
needs_review
conflict
```

这些状态的数据不能默认删除。

### 20.7 多仓库和多窗口

第一版暂不考虑复杂多仓库、多窗口并发。

当前限制：

```text
单机单用户
单项目上下文
同一时间默认一个活跃 turn
```

后续如果要支持并发，再引入：

```text
workspaceId
sessionId
active_turns 表
多窗口锁
```

### 20.8 代码行数过滤策略

第一版需要做基础过滤，避免 lock 文件、生成文件和依赖目录造成统计失真。

默认排除：

```text
node_modules/
dist/
build/
coverage/
.next/
out/
target/
package-lock.json
pnpm-lock.yaml
yarn.lock
*.min.js
*.map
二进制文件
```

默认统计：

```text
源码
文档
配置
测试
普通文本文件
```

后续看板可以继续拆分：

```text
sourceLinesChanged
docLinesChanged
configLinesChanged
testLinesChanged
generatedLinesChanged
otherLinesChanged
```

配置文件允许用户扩展过滤规则：

```json
{
  "exclude": ["generated/**", "*.lock"],
  "include": ["src/**", "docs/**"]
}
```

用户可以通过配置文件追加或覆盖 include / exclude 规则，不需要修改程序代码。

第一版也可以提供类似 `.gitignore` 风格的过滤文件：

```text
当前脚本目录/.ai-coding-reporter/code-stats.ignore
```

默认内容：

```text
node_modules/
dist/
build/
coverage/
.next/
out/
target/
package-lock.json
pnpm-lock.yaml
yarn.lock
*.min.js
*.map
```

基础过滤测试样例：

```text
src/app.ts                 应统计
docs/readme.md             应统计
package-lock.json          不统计
pnpm-lock.yaml             不统计
node_modules/a/index.js    不统计
dist/app.js                不统计
build/output.js            不统计
coverage/lcov.info         不统计
```

### 20.9 安全和隐私

第一版暂不做复杂安全和隐私处理。

仅保留最低要求：

```text
1. 登录 token 不写入代码仓库
2. 不把配置文件放到项目目录
3. prompt 可以先按现有需求保存；后续再改成 hash + preview
4. 后续再处理项目路径脱敏、prompt 脱敏、token 加密存储
```

### 20.10 手动脚本补跑和状态检查

需要保留手动执行脚本能力。这个能力非常重要，用于：

```text
1. 自动同步失败后人工补跑
2. 调试 token 回填
3. 验证线上上传是否完成
4. 排查 pending / failed / needs_review
5. 在没有 daemon 的情况下手动完成全流程
```

推荐命令：

```bash
ai-coding-reporter sync --dry-run
ai-coding-reporter sync
ai-coding-reporter sync --retry-failed
ai-coding-reporter tokens sync
ai-coding-reporter tokens sync --recent
ai-coding-reporter status
ai-coding-reporter stop
```

也提供一次性完整补跑：

```bash
ai-coding-reporter reconcile
```

内部执行：

```text
1. token sync
2. online sync
3. 状态汇总
4. 输出仍未完成的数据
```

参考 `mcp` 项目已有命令：

```text
npm run sync:online:dry
npm run sync:online
npm run auto-sync:once
npm run tokens:sync
npm run tokens:sync:recent
```

手动状态检查输出建议：

```json
{
  "turns": {
    "pendingUpload": 0,
    "uploaded": 120,
    "failed": 0
  },
  "tokens": {
    "pending": 2,
    "completed": 118,
    "needsReview": 1,
    "conflict": 0
  },
  "queue": {
    "pending": 0,
    "failed": 0
  },
  "ok": false
}
```

当所有状态完成时：

```json
{
  "ok": true,
  "message": "All local AI coding data has been uploaded and token sync is complete."
}
```

状态定义必须统一。

可结束状态：

```text
completed
unavailable
not_found
uploaded
synced
skipped
```

未完成或需处理状态：

```text
pending
failed
needs_review
conflict
running
```

`reconcile` 执行规则：

```text
1. 如果没有 pending / failed / needs_review / conflict，直接提示无需补跑
2. 如果存在 pending token，执行 token sync
3. 如果存在 failed upload，执行 retry upload
4. 如果存在 needs_review / conflict，不自动处理，只提示人工处理
5. 如果日志尚未生成导致 token 仍 pending，保留 pending 并提示下次再执行
```

`not_found` 不能第一次扫描没找到就立即标记。建议 pending 超过 24 小时，且至少执行过多次 token sync 后仍无候选，才自动转为 `not_found`。进入 `not_found` 后自动流程不再反复扫描，用户仍可通过 `tokens sync --rescan --turn <turnId>` 或 `tokens sync --since <time>` 手动重新扫描。

`reconcile` 必须防重复运行。同一 workerType 同时只能运行一个；已有任务运行时，新命令直接提示用户执行 `status` 查看，必要时执行 `stop` 停止本工具启动的任务。

停止命令：

```bash
ai-coding-reporter stop
```

用途：

```text
1. 停止当前 reporter 启动的 token sync / online sync / reconcile
2. 清理本地运行锁
3. 将运行状态标记为 stopped
4. 不删除任何已采集数据
```

如果第一版没有 daemon，`stop` 只需要处理当前由 reporter 启动并记录 PID 的脚本。

Windows 上不能只按 PID 直接停止。必须校验 `workerId`、`pid`、`startedAt`、`commandPath` 都匹配，并且命令路径属于 `ai-coding-reporter`，只允许关闭本工具启动的脚本，不影响其他进程。

第一版 `stop` 只处理以下 worker：

```text
token-sync
online-sync
reconcile
```

第一版不停止：

```text
start
end
用户真实启动的 codex 进程
用户真实启动的 claude 进程
其他非 ai-coding-reporter 启动的进程
```

### 20.10.1 token 扫描策略

token 扫描不只依赖时间，也不应该每次全量扫描。

第一版采用：

```text
日志文件 offset
文件修改时间
新增日志文件发现
lookback 时间窗口
```

规则：

```text
1. 对已知日志文件记录 filePath / fileId / lastOffset / lastModified
2. 下次优先从 lastOffset 继续读取
3. 如果发现新增日志文件，读取新增文件
4. 如果日志轮转或 fileId 变化，按新文件处理
5. lookback 用于补偿日志延迟写入，不作为唯一扫描条件
6. 用户可通过 --since 或 --rescan 手动扩大扫描范围
```

### 20.11 状态可观测性

第一版需要能感知当前还有多少 token 在扫描、多少脚本还在执行。

`status` 命令需要展示：

```text
当前是否有脚本运行
正在运行的脚本名称
脚本 PID
脚本开始时间
最后心跳时间
pending token 数量
正在扫描的日志文件数量
本轮扫描已解析 token event 数
等待上传的 turn 数
上传失败数
needs_review 数
conflict 数
```

建议本地增加运行状态表：

```sql
CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  finished_at TEXT,
  current_step TEXT,
  scanned_files INTEGER DEFAULT 0,
  parsed_events INTEGER DEFAULT 0,
  pending_tokens INTEGER DEFAULT 0,
  uploaded_items INTEGER DEFAULT 0,
  failed_items INTEGER DEFAULT 0,
  last_error TEXT,
  metadata_json TEXT
);
```

`status` 输出示例：

```json
{
  "ok": false,
  "runningWorkers": [
    {
      "type": "token-sync",
      "pid": 12345,
      "currentStep": "scanning codex logs",
      "startedAt": "2026-05-21T10:00:00+08:00",
      "lastHeartbeatAt": "2026-05-21T10:00:30+08:00"
    }
  ],
  "tokens": {
    "pending": 3,
    "completed": 120,
    "unavailable": 4,
    "notFound": 2,
    "needsReview": 1,
    "conflict": 0
  },
  "uploads": {
    "pending": 2,
    "failed": 0,
    "uploaded": 121
  }
}
```

如果没有未完成状态，并且没有运行脚本：

```json
{
  "ok": true,
  "runningWorkers": [],
  "message": "All done. No pending token sync or upload tasks."
}
```

为了避免第一版 `status` 过度复杂，先给出一个总状态和简要分类：

```text
ok: 是否没有需要处理的数据和运行中脚本
running: 是否有脚本正在运行
pending: 是否还有等待处理数据
actionRequired: 是否需要人工处理
```

后续再扩展更细的 `uploadOk`、`tokenOk` 等分层指标。

### 20.11.1 配置校验命令

允许用户手动修改配置文件后，需要提供校验命令：

```bash
ai-coding-reporter doctor
```

检查内容：

```text
1. 配置文件是否存在
2. employeeId 是否存在
3. apiBaseUrl 是否可访问
4. accessToken 是否可用
5. SQLite 是否可写
6. git 是否可用
7. 当前目录是否在 Git 仓库内
8. 日志路径是否可访问
```

`doctor` 不上传数据，只做本地和接口连通性检查。

### 20.11.2 工具适配验证脚本

第一版正式开发前，先做工具适配验证脚本。

推荐命令：

```bash
ai-coding-reporter probe codex
ai-coding-reporter probe claude
```

输出内容：

```text
是否找到日志目录
最近日志文件路径
是否能解析 token
是否存在 turnId
是否存在 requestId/messageId
日志生成延迟
是否能识别对话开始
是否能识别对话结束
推荐 captureLevel
```

captureLevel 定义：

```text
A: 能稳定拿到 turnId + start/end
B: 能拿到日志事件，但需要时间窗口辅助
C: 只能通过 start/end 或包装命令统计
```

probe 验收标准：

```text
1. 能找到对应工具日志目录
2. 能读取至少一个真实日志文件
3. 能解析至少一条真实 token 记录，或明确说明当前日志无 token 字段
4. 能判断是否存在 turnId / requestId / messageId
5. 能给出对话开始信号和结束信号
6. 能输出 token 日志生成延迟
7. 能输出 captureLevel
8. 如果只能达到 C 级，需要明确第一版降级为 start/end 或包装命令粒度
```

当前验证结果：

```text
Codex captureLevel = A
Claude Code captureLevel = A
```

已生成结果文件：

```text
codex-probe-result.json
claude-probe-result.json
probe-detailed-analysis.json
AI编码Probe验证结果.md
AI编码Probe详细验证结果.md
```

Codex 已验证结论：

```text
1. 日志目录：C:\Users\00232924\.codex\sessions
2. token 数据库：C:\Users\00232924\.codex\logs_2.sqlite
3. 开始信号：session JSONL 中的 task_started / SQLite 中的 turn.id
4. 结束信号：SQLite logs.feedback_log_body 中的 response.completed
5. token 字段：input_token_count / output_token_count / cached_token_count / reasoning_token_count / tool_token_count
6. SQLite 原库可能忙碌或 IO 错误，读取前需要复制快照
7. token event 存在重复，需要按 conversationId + turnId + eventTimestamp + token counts 去重
8. 没有 turnId 的 response.completed 事件可用 conversationId + eventTimestamp + token counts 降级匹配
9. 本次日志延迟样本平均约 65 秒，最大约 237 秒
```

Claude Code 已验证结论：

```text
1. 日志目录：C:\Users\00232924\.claude\sessions 和 C:\Users\00232924\.claude\projects
2. 开始信号：project JSONL 中的 user 事件
3. 结束信号：assistant.message.stop_reason = end_turn / stop_sequence
4. token 来源：assistant.message.usage
5. token 字段：input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens
6. 同一个 assistant.message.id 会重复写入，必须按 message.id 去重并保留最后一条
7. tool_use 不是最终完成信号，不能直接作为一轮结束
```

代码统计验证结论：

```text
1. 基础过滤规则验证通过
2. 被统计样例：src/app.ts、docs/readme.md
3. 被过滤样例：package-lock.json、pnpm-lock.yaml、node_modules、dist、build、coverage、*.min.js、*.map
4. git diff --numstat 默认不统计未跟踪文件
5. 正式实现需要单独处理 untracked 文件，或采用不污染用户 index 的等价策略
```

### 20.12 第一版成功标准

第一版验收标准：

```text
1. 能通过工号登录
2. 能绑定线上需求
3. 能记录每一轮 AI 对话 turn
4. 能记录 start/end
5. 能统计代码行数
6. 能上传线上
7. 断网后能本地保留并补传
8. token 拿不到时不阻塞代码行数上报
9. token 日志生成后可以异步回填
10. 中文需求名、中文 prompt、中文路径不乱码
11. 重复上传不重复入库
12. 能手动执行 sync / token sync / reconcile 补跑
13. status 能展示当前是否全部完成
14. stop 能停止 reporter 启动的运行中脚本
15. status 能展示 pending token 数和运行中脚本数
16. 基础过滤能排除 lock 文件、生成文件和依赖目录
17. probe codex / probe claude 能输出工具适配验证结果
18. doctor 能检查本地配置、接口、SQLite、git、日志路径
```

第一版暂不做：

```text
1. VSCode 插件
2. 撤销监听
3. 多仓库 / 多窗口并发
4. 文件类型过滤
5. 复杂安全脱敏
6. 绝对精确的 AI 亲手写入代码归因
```


### 17.2 CLI 场景的能力边界

CLI 不能可靠监听用户是否“点击了撤销按钮”或按了 `Ctrl+Z`，因为这些动作发生在编辑器内部，普通 CLI 拿不到 VSCode 的 undo stack 和命令事件。

CLI 能做的是推断结果：

```text
1. AI 写文件时记录 before hash、after hash 和 patch
2. 后续监听文件变化或在对话结束时重新读取文件
3. 对比当前文件和 AI 写入后的 patch
4. 判断 AI 生成内容是否被删除、覆盖或恢复到写入前状态
```

因此 CLI 中建议使用这些状态：

```text
retained
partially_retained
discarded
overwritten
reverted_or_overwritten
```

不建议在 CLI 里直接记录为：

```text
undo_clicked
```

因为 CLI 无法确认用户是否真的点击了撤销，也可能是手动删除、格式化、git checkout 或下一轮 AI 覆盖。

### 17.3 VSCode 场景的实现方式

如果要精确监听“AI 输出代码后用户点击撤销”，建议在 VSCode 扩展阶段实现。

推荐流程：

```text
AI edit applied
  ↓
记录 editId、fileUri、rangeBefore、textBefore、rangeAfter、textAfter、patch hash
  ↓
监听 vscode.workspace.onDidChangeTextDocument
  ↓
发现后续文本变化反向抵消 AI patch
  ↓
标记该 AI edit 已被撤销或丢弃
  ↓
上报 generatedLines、retainedLines、discardedLines
```

需要注意：VSCode API 不一定直接提供 `isUndo = true`。更可靠的方式是通过文本变化反向匹配判断：

```text
1. 删除范围是否覆盖 AI 插入范围
2. 删除后的文档 hash 是否接近 AI 写入前 hash
3. AI 插入文本是否从当前文件中消失
4. 是否发生在 AI edit 后的合理时间窗口内
```

### 17.4 如果 AI 代码来自第三方插件

如果 AI 代码是团队自己的 VSCode 扩展插入的，可以比较准确记录每次 AI edit。

如果 AI 代码来自第三方插件，例如其他 AI 编码插件，VSCode 不一定告诉我们某次文本变化来自 AI。此时只能做近似判断：

```text
1. 在 AI 回复完成后的短时间窗口内出现的大段插入，推断为 AI edit
2. 后续如果这段内容被删除或恢复，推断为 discarded
3. 匹配不确定时标记 ambiguous，不强行认定为撤销
```

### 17.5 推荐落地策略

第一版：

```text
只统计 retained code changes，也就是最终保留代码变更
```

第二版：

```text
CLI 记录 AI 写入 patch，通过文件 hash 和 diff 判断 AI 内容是否被删除或覆盖
```

第三版：

```text
VSCode 扩展监听文档变化，精确记录 AI edit 是否被撤销
```

最终上报字段可以扩展为：

```json
{
  "generatedLinesAdded": 100,
  "generatedLinesDeleted": 20,
  "retainedLinesAdded": 60,
  "retainedLinesDeleted": 10,
  "discardedLines": 50,
  "discardStatus": "partially_retained",
  "discardReason": "reverted_or_overwritten"
}
```

