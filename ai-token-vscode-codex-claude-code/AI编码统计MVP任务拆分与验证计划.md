# AI 编码统计 MVP 任务拆分与验证计划

## 1. 目标

在正式开发完整 `ai-coding-reporter` 前，先通过分段验证脚本拿到真实数据，确认 Codex / Claude Code / 本地上传 / token 回填等关键链路可行。

原则：

```text
先验证，再实现
先分段跑通，再整体串联
先暴露问题，再进入完整 CLI 开发
```

## 2. 第一版范围

第一版要实现：

```text
1. 每轮 AI 对话 turn 统计
2. 工号登录并生成用户配置文件
3. 需求绑定
4. start/end 记录
5. Git 代码行数统计
6. 基础文件过滤
7. token pending 和异步回填
8. 线上上传
9. 断网失败后补传
10. 手动 sync / tokens sync / reconcile
11. status 查看本地状态
12. stop 停止本工具启动的脚本
13. doctor 校验本地配置
14. probe codex / probe claude 工具适配验证
```

第一版暂不做：

```text
1. VSCode 插件
2. daemon 常驻
3. 撤销监听
4. 多仓库 / 多窗口并发
5. 复杂安全脱敏
6. 绝对精确的 AI 亲手写入代码归因
```

## 3. 阶段一：工具适配验证

### 3.1 probe codex

命令：

```bash
ai-coding-reporter probe codex
```

目标：

```text
验证 Codex 是否能稳定拿到每轮对话开始、结束、turnId 和 token 日志。
```

需要收集：

```text
1. Codex 日志目录
2. 最近日志文件路径
3. 日志格式
4. 是否存在 turnId
5. 是否存在 requestId / messageId
6. 用户 prompt 时间
7. AI 开始响应时间
8. AI 回复完成时间
9. 代码文件落盘时间
10. token 日志写入时间
11. 日志生成延迟
12. 可用的结束判断信号
```

输出示例：

```json
{
  "tool": "codex",
  "captureLevel": "A",
  "logPaths": ["..."],
  "hasTurnId": true,
  "hasRequestId": true,
  "startSignal": "user_message",
  "endSignal": "turn_completed",
  "tokenDelayMs": 8000,
  "recommendedMatchStrategy": "turnId"
}
```

验收标准：

```text
1. 能找到 Codex 日志目录
2. 能读取至少一个真实日志文件
3. 能解析至少一条真实 token 记录，或明确说明当前日志无 token 字段
4. 能判断是否存在 turnId / requestId / messageId
5. 能给出对话开始信号和结束信号
6. 能输出 token 日志生成延迟
7. 能输出 captureLevel
8. 如果只能达到 C 级，需要明确第一版降级为 start/end 或包装命令粒度
```

### 3.2 probe claude

命令：

```bash
ai-coding-reporter probe claude
```

目标：

```text
验证 Claude Code 是否能稳定拿到每轮对话开始、结束、turnId 和 token 日志。
```

收集项同 Codex。

验收标准同 Codex：

```text
1. 能找到 Claude Code 日志目录
2. 能读取至少一个真实日志文件
3. 能解析至少一条真实 token 记录，或明确说明当前日志无 token 字段
4. 能判断是否存在 turnId / requestId / messageId
5. 能给出对话开始信号和结束信号
6. 能输出 token 日志生成延迟
7. 能输出 captureLevel
8. 如果只能达到 C 级，需要明确第一版降级为 start/end 或包装命令粒度
```

### 3.3 captureLevel 定义

```text
A：能稳定拿到 turnId + start/end
B：能拿到日志事件，但需要时间窗口辅助
C：只能通过 start/end 或包装命令统计
```

只有拿到 `probe` 的真实结果后，才进入完整 CLI 开发。

### 3.4 probe 已验证结论

当前已完成第一轮和详细验证：

```text
Codex captureLevel = A
Claude Code captureLevel = A
```

结果文件：

```text
codex-probe-result.json
claude-probe-result.json
probe-detailed-analysis.json
AI编码Probe验证结果.md
AI编码Probe详细验证结果.md
```

Codex 实现规则：

```text
1. 日志位置：C:\Users\00232924\.codex\sessions 和 C:\Users\00232924\.codex\logs_2.sqlite
2. 读取 SQLite 时先复制快照，避免忙碌或 IO 错误
3. response.completed 可作为结束信号
4. token event 必须去重
5. 去重签名：conversationId + turnId + eventTimestamp + token counts
6. 优先使用带 turnId 的事件；没有 turnId 时使用 conversationId + eventTimestamp + token counts 降级匹配
```

Claude Code 实现规则：

```text
1. 日志位置：C:\Users\00232924\.claude\sessions 和 C:\Users\00232924\.claude\projects
2. user 事件可作为开始信号
3. assistant.message.usage 可作为 token 来源
4. assistant event 需要按 message.id 去重，保留最后一条
5. tool_use 不是最终完成信号
6. end_turn / stop_sequence 更适合作为一轮完成信号
```

token 延迟结论：

```text
Codex token 日志存在明显延迟，本次样本平均约 65 秒，最大约 237 秒。
因此第一版必须支持 token pending 后异步回填。
```

代码统计验证结论：

```text
基础过滤规则验证通过。
但 git diff --numstat 默认不统计未跟踪文件，正式实现必须单独处理 untracked 文件。
```

## 4. 阶段二：本地基础能力

### 4.1 初始化和配置

任务：

```text
1. 创建本地配置目录
2. 创建 SQLite 数据库
3. 初始化 schema
4. 创建 config.json
```

Windows 默认位置：

```text
当前脚本目录下的 .ai-coding-reporter/
```

说明：

```text
第一版先把配置和本地数据库生成在当前脚本目录下，方便开发、调试、查看和手动修改。
后续团队推广时，再考虑迁移到 %APPDATA% 或用户级目录。
```

### 4.2 login

命令：

```bash
ai-coding-reporter login --employee-id 00232924
```

行为：

```text
1. 生成用户配置文件
2. 写入 employeeId
3. 可写入 apiBaseUrl / accessToken
4. 同步写入 user_profile 表
```

配置文件可手动修改。

配置文件路径：

```text
当前脚本目录/.ai-coding-reporter/config.json
```

配置优先级：

```text
命令行参数 > 环境变量 > config.json > 默认值
```

### 4.3 doctor

命令：

```bash
ai-coding-reporter doctor
```

检查：

```text
1. 配置文件是否存在
2. employeeId 是否存在
3. apiBaseUrl 是否可访问
4. accessToken 是否可用
5. SQLite 是否可写
6. git 是否可用
7. 当前目录是否在 Git 仓库内
8. Codex / Claude 日志路径是否可访问
```

`doctor` 不上传数据。

## 5. 阶段三：需求绑定

### 5.1 查询需求

命令：

```bash
ai-coding-reporter req
ai-coding-reporter req 订单
```

### 5.2 绑定需求

命令：

```bash
ai-coding-reporter req 123
```

行为：

```text
1. 调线上需求绑定 API
2. 成功后写入 requirement_selections
3. 后续 turn 自动带 requirementId
```

## 6. 阶段四：代码统计

### 6.1 start

命令：

```bash
ai-coding-reporter start
```

记录：

```text
turnId
conversationId
startedAt
gitBranch
commitBefore
baseline diff snapshot
untracked snapshot
requirementId
employeeId
```

baseline 必须同时记录：

```text
1. trackedNumstat：git diff --numstat 输出
2. untrackedFiles：git ls-files --others --exclude-standard 输出
3. untrackedFileLineCounts：未跟踪文本文件行数
4. fileEditObserved：本轮是否发生过文件写入、格式化、生成或删除
```

不能只记录 Git HEAD，因为同一工作区可能已经有多轮未提交变更。

### 6.2 end

命令：

```bash
ai-coding-reporter end --tool codex
```

行为：

```text
1. 读取结束快照
2. 计算本轮增量
3. 应用基础过滤
4. 写入 turns 表
5. tokenStatus = pending
6. 写入 upload_queue
```

结束快照同样读取：

```text
git diff --numstat
git ls-files --others --exclude-standard
```

单轮统计规则：

```text
本轮变更 = 结束快照 - 开始快照
```

未跟踪文件规则：

```text
1. 开始时不存在、结束时存在：按当前文本行数计新增行
2. 开始时存在、结束时仍存在：按结束行数 - 开始行数计本轮新增行
3. 二进制未跟踪文件跳过
```

确认类、问答类、只读排查类轮次：

```text
如果本轮没有文件写入、格式化、生成、删除等操作，记录 roundChanged = 0。
没有 baseline 时不能用工作区累计 diff 兜底。
```

metadata 建议：

```json
{
  "codeStatsSource": "baseline diff snapshot",
  "codeStatsPrecision": "exact",
  "workspaceCumulativeChanged": 710,
  "roundChanged": 46
}
```

基础过滤：

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

后续允许用户通过配置文件扩展 include / exclude。

过滤规则文件：

```text
当前脚本目录/.ai-coding-reporter/code-stats.ignore
```

规则风格参考 `.gitignore`：

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

后续用户可以直接编辑这个文件添加过滤规则。

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

## 7. 阶段五：token 回填

### 7.1 tokens sync

命令：

```bash
ai-coding-reporter tokens sync
ai-coding-reporter tokens sync --recent
ai-coding-reporter tokens sync --rescan --turn <turnId>
ai-coding-reporter tokens sync --since 2026-05-21T00:00:00+08:00
```

扫描策略：

```text
1. 记录 filePath / fileId / lastOffset / lastModified
2. 优先从 lastOffset 增量读取
3. 发现新增日志文件时读取新增文件
4. 日志轮转或 fileId 变化时按新文件处理
5. lookback 只用于补偿延迟写入
6. --rescan / --since 用于人工扩大扫描范围
```

### 7.2 token 状态

可结束状态：

```text
completed
unavailable
not_found
```

未完成或需处理状态：

```text
pending
failed
needs_review
conflict
running
```

`not_found` 规则：

```text
pending 超过 24 小时
并且至少执行过多次 token sync
仍没有找到候选
才自动转为 not_found
```

用户可以手动重新扫描 `not_found`。

## 8. 阶段六：上传和补传

### 8.1 sync

命令：

```bash
ai-coding-reporter sync --dry-run
ai-coding-reporter sync
ai-coding-reporter sync --retry-failed
```

规则：

```text
1. dry-run 只检查不上传
2. sync 上传 pending 数据
3. retry-failed 重试失败数据
4. 上传成功后写入 remoteId / syncedAt
```

### 8.2 幂等

固定使用：

```text
idempotencyKey = local-turn-<turnId>
```

后端要求：

```text
1. 重复 idempotencyKey 不重复入库
2. 返回已有记录
3. remoteId 允许是字符串
```

## 9. 阶段七：reconcile / status / stop

### 9.1 reconcile

命令：

```bash
ai-coding-reporter reconcile
```

执行：

```text
1. 检查是否有未完成状态
2. 有 pending token 时执行 token sync
3. 有 failed upload 时执行 retry upload
4. 汇总状态
5. 输出仍未完成的数据
```

防重复：

```text
同一 workerType 同时只能运行一个
已有任务运行时，新的 reconcile 直接提示
```

### 9.2 status

命令：

```bash
ai-coding-reporter status
```

第一版输出：

```text
ok
running
pending
actionRequired
pending token 数
running worker 数
failed upload 数
needs_review 数
conflict 数
```

先保持简单，不强制拆成复杂分层指标。

### 9.3 stop

命令：

```bash
ai-coding-reporter stop
```

只停止本工具启动的脚本。

第一版 stop 只处理以下 worker：

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

Windows 安全校验：

```text
workerId 匹配
pid 匹配
startedAt 匹配
commandPath 属于 ai-coding-reporter
```

不能影响其他进程。

## 10. 阶段八：专项测试

### 10.1 中文乱码测试

必须覆盖：

```text
中文需求名
中文项目名
中文 prompt
中文路径
PowerShell
cmd
Git Bash
HTTP 上传后线上展示
```

### 10.2 状态测试

必须覆盖：

```text
pending
completed
unavailable
not_found
failed
needs_review
conflict
running
```

### 10.3 断网补传测试

必须覆盖：

```text
上传失败进入 upload_queue
恢复网络后 retry-failed 成功
重复上传不重复入库
```

## 11. 推荐开发任务顺序

```text
1. probe codex
2. probe claude
3. SQLite schema
4. login / config
5. doctor
6. req 查询和绑定
7. start baseline
8. end code stats
9. 基础过滤
10. sync dry-run / sync
11. upload_queue
12. tokens sync
13. reconcile
14. status
15. stop
16. 中文乱码测试
17. 断网补传测试
18. 线上接口联调
```

## 12. 当前需要先暴露的问题

开发前必须先拿到这些结果：

```text
1. Codex 每轮对话开始/结束事件是否稳定
2. Claude Code 每轮对话开始/结束事件是否稳定
3. Codex token 日志路径、格式、延迟
4. Claude Code token 日志路径、格式、延迟
5. 日志中是否有 turnId / requestId / messageId
6. 线上接口是否支持 turnId / idempotencyKey / employeeId / requirementId / tokenStatus / metadata
7. Windows 下 stop 是否能只停止 reporter 启动的脚本
8. 中文字段全链路是否乱码
```

这些问题验证完成后，再进入完整 CLI 主体开发。

当前状态：

```text
1. Codex 每轮对话开始/结束事件：已验证，captureLevel A
2. Claude Code 每轮对话开始/结束事件：已验证，captureLevel A
3. Codex token 日志路径、格式、延迟：已验证
4. Claude Code token 日志路径、格式、延迟：已验证
5. 日志中 turnId / messageId：已验证，Codex 有 turnId，Claude 有 message.id
6. Windows 下 stop：尚未进入实现验证
7. 中文字段全链路：尚未进入专项验证
8. 线上接口：后续接口设计阶段验证
```

## 13. MVP 当前开发状态

已新增可运行 CLI：

```text
ai-coding-reporter.py
ai_coding_reporter/cli.py
```

当前已实现：

```text
1. login --employee-id
2. doctor / doctor --api
3. req 查询、搜索、绑定、清除项目需求
4. start / end 单轮代码统计
5. tracked + untracked 文件统计
6. 基础过滤 code-stats.ignore
7. probe codex / probe claude
8. tokens sync 基础 token 回填
9. status
10. sync --dry-run
```

当前验证结果：

```text
1. GPM 需求接口可访问，能按工号返回项目需求
2. 需求列表展示格式已符合 demandCode / demandId 方案
3. 支持按 demandCode 绑定到本地 SQLite
4. start/end 在临时 Git 仓库中验证通过
5. 未跟踪 src/app.ts 被统计，dist 和 package-lock 被过滤
6. tokens sync 能读取 Codex / Claude 日志并回填测试 turn
```

当前未实现：

```text
1. 线上 AI turn 上传接口
2. daemon 常驻
3. VSCode 插件
4. stop 真正停止 worker
5. task 级绑定
```
