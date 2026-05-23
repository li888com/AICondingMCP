## 对话级 begin/end 接入说明

### 当前行为

- `begin_ai_dialogue_turn` 会创建一份 baseline。
- `end_ai_dialogue_turn` 会始终落一条对话轮次记录到 `dialogue_turns`。
- 如果本轮检测到代码改动，会生成 `rounds` 记录，并把 `dialogue_turns.mode` 记为 `coding_round`。
- 如果本轮没有代码改动，会生成 `token_usage_events` 记录，并把 `dialogue_turns.mode` 记为 `dialogue_only`。

### 宿主侧必须保证

- 每一轮用户对话开始前调用一次 `begin_ai_dialogue_turn`。
- 每一轮 assistant 结束后调用一次 `end_ai_dialogue_turn`。
- `turnId` 在同一个 `conversationId` 内唯一。
- 优先显式传 `modelName`。未传时系统会回退为 `unknown`，但不利于模型维度汇总。

### sourceEventId 规则

- 建议宿主自己生成稳定唯一值。
- 推荐格式：`<client>:<conversationId>:<turnId>:<endedAt>`
- 如果宿主未传，MCP 会按上面的格式自动补一个默认值。
- 同一个 `sourceEventId` 会被视为同一条 token 事件，重复上报不会生成新记录。

### baseline 清理

- begin 后若宿主异常退出，baseline 文件可能残留。
- 可以用 CLI 查看：
  - `ai-coding-stats baselines list`
- 可以用 CLI 清理：
  - `ai-coding-stats baselines cleanup --max-age-minutes 1440`
- MCP 也提供：
  - `list_ai_dialogue_baselines`
  - `cleanup_ai_dialogue_baselines`

### 报表侧建议

- 如果要统计“所有对话轮次”，不要只看 `rounds`。
- 应同时聚合：
  - `dialogue_turns`
  - `rounds`
  - `token_usage_events`

### 仍然存在的边界

- baseline diff 统计的是工作区改动，无法天然区分 AI 改动和人工改动。
- token 延迟到达时，仍然需要保留 `tokens:backfill` 异步回填链路。
