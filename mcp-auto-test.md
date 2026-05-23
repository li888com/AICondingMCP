# MCP 自动统计与对话级强制触发测试

本文档说明两类能力：

- 传统编码轮次统计：`begin_ai_coding_round` / `record_ai_coding_round`
- 对话级强制触发统计：`begin_ai_dialogue_turn` / `end_ai_dialogue_turn`

目标是让宿主在“每次对话开始”和“每次对话结束”都固定调用 MCP，不再依赖模型临场记忆是否调用。

## 推荐接入方式

宿主统一在每轮对话前后各调用一次：

```text
before user turn -> begin_ai_dialogue_turn
after assistant turn -> end_ai_dialogue_turn
```

`end_ai_dialogue_turn` 会自动判断：

- 如果本轮有代码改动，写入 `rounds`
- 如果本轮没有代码改动，只写入 `token_usage_events`

这样宿主不需要自己判断“这是聊天轮次还是编码轮次”。

## MCP 示例

### 1. 对话开始

```json
{
  "name": "begin_ai_dialogue_turn",
  "arguments": {
    "conversationId": "codex:/workspace/demo-project",
    "projectPath": "/workspace/demo-project",
    "turnId": "turn-20260523-001",
    "startedAt": "2026-05-23T08:00:00.000Z",
    "promptText": "请帮我修复首页按钮样式",
    "modelName": "gpt-5",
    "client": "codex",
    "metadata": {
      "entry": "host-before-turn"
    }
  }
}
```

预期：

- 如果 `projectPath` 能解析到 Git 工作区，会创建 baseline
- 如果解析不到 Git 工作区，会返回 `skipped: true`

### 2. 对话结束

```json
{
  "name": "end_ai_dialogue_turn",
  "arguments": {
    "conversationId": "codex:/workspace/demo-project",
    "projectPath": "/workspace/demo-project",
    "turnId": "turn-20260523-001",
    "endedAt": "2026-05-23T08:01:30.000Z",
    "promptText": "请帮我修复首页按钮样式",
    "modelName": "gpt-5",
    "client": "codex",
    "inputTokens": 1200,
    "outputTokens": 600,
    "totalTokens": 1800,
    "sourceEventId": "host-turn-20260523-001",
    "metadata": {
      "entry": "host-after-turn"
    }
  }
}
```

预期返回分两种：

```json
{
  "mode": "coding_round",
  "turnId": "turn-20260523-001",
  "roundId": 12,
  "codeLinesChanged": 18
}
```

或：

```json
{
  "mode": "dialogue_only",
  "turnId": "turn-20260523-001",
  "dialogueEventId": 27,
  "totalTokens": 1800
}
```

## 什么时候仍然用旧工具

下面这些场景仍然建议保留旧工具：

- 你已经有显式任务边界，并且只想统计代码轮次
- 你只想手工补 token
- 你要做回滚审计

对应工具：

- `begin_ai_coding_round`
- `record_ai_coding_round`
- `record_dialogue_token_usage`
- `record_ai_coding_round_revert`

## 宿主侧最小事件流

```text
1. 收到用户消息
2. 生成 turnId
3. 调 begin_ai_dialogue_turn
4. 让模型处理任务
5. 收到最终回复和 token
6. 调 end_ai_dialogue_turn
7. 如 token 延迟，再定时跑 tokens:backfill
```

## 本地验证结论

2026-05-23 已补充对话级强制入口，并做了本地真实 MCP server + stdio client 的端到端验证，覆盖：

- 纯对话轮次
- 有代码改动的轮次
- 重复 `sourceEventId` 的幂等表现
- baseline 清理

本次验证使用临时 Git 仓库：

```text
C:\Users\00232924\AppData\Local\Temp\ai-coding-stats-dialogue-e2e
```

验证结果：

- `begin_ai_dialogue_turn` 能成功创建 baseline
- 无代码改动时，`end_ai_dialogue_turn` 返回 `dialogue_only`
- 有代码改动时，`end_ai_dialogue_turn` 返回 `coding_round`
- 本地 SQLite 成功生成
- 重复 `sourceEventId=evt-dialogue-only` 没有生成重复 token event
- `round-baselines` 目录在轮次结束后已清空

实测样例：

```json
{
  "mode": "dialogue_only",
  "turnId": "turn-dialogue-only",
  "dialogueEventId": 1,
  "totalTokens": 30
}
```

```json
{
  "mode": "coding_round",
  "turnId": "turn-coding-round",
  "roundId": 1,
  "filesChanged": 1,
  "linesAdded": 1,
  "linesDeleted": 0,
  "codeLinesChanged": 1,
  "totalTokens": 90
}
```

## 当前限制

- 代码行数准确性仍然依赖“begin 和 end 之间只有这一轮改动”这个前提
- 如果用户和模型同时改同一工作区，本轮行数仍可能混入人工改动
- token 仍可能晚于回复完成时间到达，建议保留 `tokens:backfill`
- `projectPath` 必须最终能解析到 Git 仓库，否则只能记录纯对话事件或直接跳过 baseline
- `begin_ai_dialogue_turn.startedAt` 现在会持久化到 baseline；`end_ai_dialogue_turn` 和 CLI `finish` 会优先复用这个值
