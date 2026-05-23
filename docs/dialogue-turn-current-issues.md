# Dialogue Turn Current Issues

本文档只暴露“每轮对话强制 begin/end”这条新链路当前仍然存在的问题，不替代整体风险文档。

## P0

### 宿主仍然必须强制调用

现状：

- 新工具已经提供了稳定入口
- 但 MCP server 不会自己知道“对话开始了”或“对话结束了”

影响：

- 如果宿主没有在每轮前后固定调用，统计仍会漏

建议：

- 在客户端、中间层或插件里做 before-turn / after-turn hook

## P1

### 同一轮内混入人工改动的风险仍在

现状：

- `begin_ai_dialogue_turn` 保存 baseline
- `end_ai_dialogue_turn` 用 baseline 和当前工作区做 diff

影响：

- 只要 begin 和 end 之间用户手工也改了文件，这些改动会一起被统计进本轮

结论：

- 这条链路解决的是“每轮都触发”
- 不能彻底解决“同工作区多人/多来源同时改动”的归因问题

### modelName 在纯对话分支不是强制字段

现状：

- `dialogue_only` 分支允许 `modelName` 缺失
- 缺失时本地 token event 会记录空模型名

影响：

- 后续按模型维度分析时，会出现一部分事件无法归类

建议：

- 宿主统一在 begin/end 都传 `modelName`

### begin 后未 end 会留下临时 baseline

现状：

- 正常 `end_ai_dialogue_turn` 会清理 baseline
- 如果宿主 begin 后崩溃，baseline 文件会暂时残留

影响：

- 不影响新 turn 正常写入
- 但 `.mcp-toolbox/round-baselines` 会积累孤儿文件

建议：

- 后续增加 baseline GC 或过期清理命令

## P2

### 纯对话事件默认不绑定 round

现状：

- `dialogue_only` 分支会写入 token event
- 它不会自动补成一个“空 round”
- 返回里会有 `needsProjectBinding: true`

影响：

- 如果你的报表只看 round，不看 token events，会觉得这轮对话“没记录”

建议：

- 报表层同时聚合 `rounds` 和 `token_usage_events`
- 或后续增加“对话轮次表”

### sourceEventId 需要宿主保证唯一

现状：

- token event 对 `sourceEventId` 做了唯一约束

影响：

- 宿主如果重复使用同一个 `sourceEventId`，后一次可能被判定为重复事件

建议：

- 用 `conversationId + turnId + phase` 生成唯一值

## 本轮新增链路建议验收点

```text
1. begin_ai_dialogue_turn 在 Git 仓库里能创建 baseline
2. end_ai_dialogue_turn 无代码改动时返回 dialogue_only
3. end_ai_dialogue_turn 有代码改动时返回 coding_round
4. end 之后 baseline 被清理
5. 重复 sourceEventId 不会产生重复 token event
```
