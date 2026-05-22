# AI 编码 Probe 验证结果

## 1. 验证时间

```text
2026-05-21
```

## 2. 验证脚本

脚本路径：

```text
scripts/probe-ai-logs.py
```

执行命令：

```bash
python scripts/probe-ai-logs.py codex --out codex-probe-result.json
python scripts/probe-ai-logs.py claude --out claude-probe-result.json
```

结果文件：

```text
codex-probe-result.json
claude-probe-result.json
```

## 3. Codex 验证结果

### 3.1 采集等级

```text
captureLevel = A
```

原因：

```text
1. 能找到 Codex 日志目录
2. 能找到 session JSONL
3. 能找到 SQLite 日志库
4. 能识别 turnId
5. 能识别 response.completed
6. 能解析 token 字段
```

### 3.2 日志位置

```text
C:\Users\00232924\.codex
C:\Users\00232924\.codex\sessions
C:\Users\00232924\.codex\logs_2.sqlite
```

### 3.3 开始信号

可用信号：

```text
session JSONL 中的 task_started
SQLite 日志中的 turn.id
```

示例字段：

```text
turn_id
thread_id
conversation.id
model
cwd
```

### 3.4 结束信号

可用信号：

```text
SQLite logs.feedback_log_body 中的 response.completed
```

### 3.5 token 来源

token 来源：

```text
SQLite logs.feedback_log_body response.completed token counts
```

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

### 3.6 重要发现

直接读取：

```text
C:\Users\00232924\.codex\logs_2.sqlite
```

可能遇到 SQLite 忙碌或 IO 错误。

建议读取策略：

```text
先复制 SQLite 快照到临时目录
再读取快照
```

probe 当前采用：

```text
copy snapshot before reading
```

## 4. Claude Code 验证结果

### 4.1 采集等级

```text
captureLevel = A
```

原因：

```text
1. 能找到 Claude session 文件
2. 能找到项目 JSONL 日志
3. 能识别 user 事件
4. 能识别 assistant 事件
5. assistant 事件中包含 usage
6. 能解析 messageId、sessionId、timestamp、stopReason
```

### 4.2 日志位置

```text
C:\Users\00232924\.claude
C:\Users\00232924\.claude\sessions
C:\Users\00232924\.claude\projects
C:\Users\00232924\.claude\projects\c--Users-00232924-Desktop-mcp
```

### 4.3 活跃 session 信息

已识别字段：

```text
pid
sessionId
cwd
entrypoint
kind
version
startedAt
```

示例：

```text
entrypoint = claude-vscode
kind = interactive
cwd = c:\Users\00232924\Desktop\mcp
```

### 4.4 开始信号

可用信号：

```text
project JSONL 中的 user 事件
```

已识别字段：

```text
uuid
timestamp
sessionId
promptId
cwd
gitBranch
```

### 4.5 结束信号

可用信号：

```text
project JSONL 中的 assistant 事件
```

结束判断字段：

```text
message.stop_reason
message.usage
timestamp
```

### 4.6 token 来源

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

## 5. 当前结论

### 5.1 Codex

```text
可以做每轮对话级采集。
```

推荐匹配策略：

```text
conversation.id + turn.id + response.completed
```

注意：

```text
读取 SQLite 时需要复制快照，不能直接依赖原库只读连接。
```

### 5.2 Claude Code

```text
可以做每轮对话级采集。
```

推荐匹配策略：

```text
sessionId + user.uuid / assistant.parentUuid + message.id
```

### 5.3 第一版可行性

当前验证结果支持第一版目标：

```text
统计到每一轮 AI 对话的数据
```

Codex 和 Claude Code 当前都达到：

```text
captureLevel = A
```

## 6. 后续需要继续验证

还需要继续补充：

```text
1. 日志生成延迟的多次样本统计
2. Codex 同一 turn 下多条 response.completed 如何去重
3. Claude assistant 多段 tool_use / end_turn 如何聚合成一轮
4. 实际代码落盘时间与 AI 结束时间的对应关系
5. 真实 start/end 统计与日志 turn 的关联方式
```

这些问题进入下一轮验证。

## 7. 详细验证补充

已继续执行详细验证：

```text
scripts/analyze-probe-details.py
scripts/validate-code-stats-filter.py
```

详细报告：

```text
AI编码Probe详细验证结果.md
```

关键补充结论：

```text
1. Codex token event 存在重复，需要按 conversationId + turnId + eventTimestamp + token counts 去重
2. Codex 读取 logs_2.sqlite 时应先复制快照，再读取快照
3. Codex token 日志延迟样本平均约 65 秒，最大样本约 237 秒
4. Claude assistant event 同一个 message.id 会重复写入，需要保留最后一条
5. Claude tool_use 不是最终完成信号，end_turn / stop_sequence 更适合作为一轮完成
6. 代码统计基础过滤验证通过
7. git diff --numstat 默认不统计未跟踪文件，正式实现需要单独处理 untracked 文件
```
