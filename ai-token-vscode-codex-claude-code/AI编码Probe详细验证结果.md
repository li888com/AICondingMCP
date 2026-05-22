# AI 编码 Probe 详细验证结果

## 1. 验证范围

本次验证覆盖：

```text
1. Codex 日志路径、turn 信号、token 字段、去重规则、日志延迟
2. Claude Code 日志路径、user/assistant 事件、token 字段、聚合规则
3. 代码行数基础过滤规则
4. 当前验证发现的实现注意点
```

验证脚本：

```text
scripts/probe-ai-logs.py
scripts/analyze-probe-details.py
scripts/validate-code-stats-filter.py
```

验证结果文件：

```text
codex-probe-result.json
claude-probe-result.json
probe-detailed-analysis.json
code-stats-filter-validation.json
probe-result-all-rerun.json
```

## 2. 总体结论

Codex 和 Claude Code 当前都具备每轮对话级采集基础：

```text
Codex captureLevel = A
Claude Code captureLevel = A
```

但两者都不能直接“读到什么就入库”，必须做去重和聚合：

```text
Codex：response.completed / token event 存在重复，需要按签名去重
Claude：同一个 assistant message 会多次写入，需要按 message.id 保留最后一条
```

## 3. Codex 详细验证

### 3.1 日志位置

已验证位置：

```text
C:\Users\00232924\.codex\sessions
C:\Users\00232924\.codex\logs_2.sqlite
```

### 3.2 开始和结束信号

可用开始信号：

```text
session JSONL 中的 task_started
SQLite 日志中的 turn.id
```

可用结束信号：

```text
SQLite logs.feedback_log_body 中的 response.completed
```

推荐第一版匹配策略：

```text
conversation.id + turn.id + response.completed
```

如果没有 turn.id，则降级为：

```text
conversation.id + event.timestamp + token counts
```

### 3.3 token 字段

已识别字段：

```text
input_token_count
output_token_count
cached_token_count
reasoning_token_count
tool_token_count
conversation.id
event.timestamp
model
```

### 3.4 去重规则

详细分析结果：

```text
raw token events = 20
dedup token events = 10
turn token candidates = 8
response.completed without turn = 12
```

说明 Codex 日志里存在重复事件，例如同一条 token 可能同时出现在：

```text
codex_otel.log_only
codex_otel.trace_safe
codex_client::transport
```

推荐去重签名：

```text
conversationId
turnId
eventTimestamp
inputTokens
outputTokens
cachedTokens
reasoningTokens
toolTokens
```

优先使用带 `turnId` 的事件；没有 `turnId` 时，再按：

```text
conversationId + eventTimestamp + token counts
```

做 fallback 去重和匹配。

### 3.5 日志延迟

本次样本：

```text
sampleCount = 20
min = -0.856s
max = 237.185s
avg = 65.047s
```

注意：

```text
1. 存在日志写入延迟，token 必须支持 pending 后异步回填
2. 存在极小负值，说明不同时间源之间可能有微小偏差，不能依赖毫秒级精确比较
```

### 3.6 SQLite 读取方式

直接读：

```text
C:\Users\00232924\.codex\logs_2.sqlite
```

可能遇到 SQLite 忙碌或 IO 错误。

推荐方式：

```text
先复制 SQLite 快照到临时目录，再读取快照
```

第一版 token sync 应采用该方式，避免影响 Codex 正常运行。

实现注意：

```text
1. 每次复制快照要使用唯一临时文件名
2. 读取完成后清理临时快照
3. 不要复用固定临时文件名，否则可能被上一次 probe 或同步进程占用
```

### 3.7 工具和文件变更信号

已发现可用信号：

```text
codex.tool_result
response.custom_tool_call_input.done
```

本次样本中相关工具事件：

```text
toolEventCount = 367
```

这些信号可辅助判断 AI 工具调用和 patch 输入，但代码行数仍应以对话结束时 Git diff 结果为准。

## 4. Claude Code 详细验证

### 4.1 日志位置

已验证位置：

```text
C:\Users\00232924\.claude\sessions
C:\Users\00232924\.claude\projects
C:\Users\00232924\.claude\projects\c--Users-00232924-Desktop-mcp
```

### 4.2 开始和结束信号

可用开始信号：

```text
project JSONL 中的 user 事件
```

可用结束信号：

```text
project JSONL 中的 assistant 事件
message.stop_reason = end_turn / stop_sequence
```

需要注意：

```text
tool_use 不是最终用户可见完成信号
end_turn / stop_sequence 才更适合作为本轮完成
```

### 4.3 token 字段

token 来源：

```text
assistant.message.usage
```

已识别字段：

```text
input_tokens
output_tokens
cache_creation_input_tokens
cache_read_input_tokens
```

### 4.4 聚合规则

详细分析发现：

```text
duplicateMessageGroupCount = 93
```

说明同一个 `message.id` 可能多次写入日志。

推荐聚合规则：

```text
1. 以一个 user 事件到下一个 user 事件之间作为候选 turn 窗口
2. 在窗口内按 assistant.message.id 分组
3. 同一个 message.id 只保留最后一条 assistant 事件
4. 对去重后的 unique message usage 求和
5. end_turn / stop_sequence 作为最终完成信号
```

### 4.5 时长样本

本次样本：

```text
sampleCount = 33
min = 0.065s
max = 276.773s
avg = 33.566s
```

这说明 Claude Code 的一轮对话跨度可能从极短到数分钟不等，不能只用固定短超时判断结束。

### 4.6 文件变更信号

发现：

```text
file-history-snapshot count = 22
```

但第一版不建议依赖这个信号统计代码行数。原因：

```text
1. 它是工具内部快照，不等价于最终 Git 变更
2. 可能无法覆盖所有实际落盘变化
3. 与 Codex 的统计口径不统一
```

第一版仍然统一使用：

```text
开始 Git 基线 + 结束 Git diff
```

## 5. 代码行数过滤验证

验证脚本：

```text
scripts/validate-code-stats-filter.py
```

结果文件：

```text
code-stats-filter-validation.json
```

验证结果：

```text
filesChanged = 2
linesAdded = 4
linesDeleted = 0
codeLinesChanged = 4
ignoredFiles = 8
```

被统计文件：

```text
src/app.ts
docs/readme.md
```

被过滤文件：

```text
package-lock.json
pnpm-lock.yaml
node_modules/a/index.js
dist/app.js
build/output.js
coverage/lcov.info
web/app.min.js
web/app.js.map
```

### 5.1 重要发现：未跟踪文件

`git diff --numstat` 默认不统计未跟踪文件。

如果 AI 新建了文件，但文件还没有进入 Git index，直接执行：

```bash
git diff --numstat
```

会漏掉这些新文件。

第一版需要处理未跟踪文件。可选策略：

```text
1. 统计前临时使用 git add -N . 让未跟踪文件进入 intent-to-add
2. 或单独读取 git ls-files --others --exclude-standard 并计算新增行数
```

为了避免修改用户真实 index，正式实现更推荐第二种：

```text
git diff --numstat
+ git ls-files --others --exclude-standard
+ 对未跟踪文本文件单独计新增行数
```

结合 `C:\Users\00232924\Desktop\mcp\docs\AI-Coding代码变更统计规则.md`，正式实现还需要区分：

```text
工作区累计变更 != 本轮 AI Coding 变更
```

因此 start 时需要保存 baseline：

```text
trackedNumstat
untrackedFiles
untrackedFileLineCounts
```

end 时再次读取同样快照，并计算：

```text
本轮变更 = 结束快照 - 开始快照
```

如果本轮只是确认、解释、排查，没有文件写入、格式化、生成、删除操作，应记录：

```text
roundChanged = 0
codeStatsSource = no file edits in this round
codeStatsPrecision = exact
```

不能把当前工作区累计 diff 重复计入确认类轮次。

## 6. 当前验证结论

可以进入完整 CLI 开发前的下一阶段，但实现时必须固化以下规则：

```text
1. Codex SQLite 读取必须使用快照复制
2. Codex token event 必须按签名去重
3. Claude assistant event 必须按 message.id 去重，保留最后一条
4. Claude tool_use 不能直接当最终完成，end_turn / stop_sequence 才是完成信号
5. token 延迟真实存在，必须 pending 后异步回填
6. 代码行数统计必须处理未跟踪文件
7. 基础过滤规则验证通过，可以作为第一版默认规则
```

## 7. 仍需后续验证

后续进入完整 CLI 前，还建议继续验证：

```text
1. 在真实 Codex 编码会话中，代码落盘时间与 response.completed 的先后关系
2. 在真实 Claude Code 编码会话中，工具调用多段 tool_use 到最终 end_turn 的完整链路
3. 多个连续 turn 的 token 是否能稳定匹配到本地 turnId
4. 中文路径、中文需求名、中文 prompt 的读取和上传是否乱码
5. 线上接口接入后幂等和失败补传是否符合预期
```
