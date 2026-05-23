# ai-coding-stats-mcp

一个用于 AI Coding 统计的轻量级 MCP 服务。它的目标是把一次 AI 对话或编码回合中的代码变更、token 使用量、对话轮次和同步状态，稳定地落到本地存储，并在需要时继续回填和上传。

这个项目适合两类场景：

- 作为 MCP Server，被宿主或客户端调用，记录对话轮次与编码回合
- 作为本地 CLI 工具，独立完成 baseline、代码统计、token 回填和同步排障

## 核心能力

- 按回合记录 AI Coding 数据
  - 记录 `rounds`，统计文件变更数、增删行数、总代码变更量
- 按对话轮次记录数据
  - 区分“仅对话无代码变更”和“发生代码变更的编码轮次”
- 使用 Git baseline 做差异统计
  - 在 begin 时保存快照，在 end 时计算本轮真实代码差异
- 支持 token 延迟回填
  - MCP 先记录代码回合，token 可后续从日志补齐
- 支持本地状态管理与线上同步
  - 本地先持久化，再通过脚本或流水线上传
- 支持自动巡检模式
  - 后台观察工作区变化，自动生成 coding round

## 项目结构

- [src/ai-coding-stats-server.ts](/d:/MCP/ai-coding-stats-mcp/src/ai-coding-stats-server.ts:1)
  MCP 服务入口，注册工具并管理 idle shutdown、auto-runner
- [src/tools/ai-coding-stats.ts](/d:/MCP/ai-coding-stats-mcp/src/tools/ai-coding-stats.ts:1)
  MCP 工具定义与主流程实现
- [src/cli.ts](/d:/MCP/ai-coding-stats-mcp/src/cli.ts:1)
  CLI 入口，提供 begin/finish/turn/status/tokens/sync 等命令
- [src/auto-runner.ts](/d:/MCP/ai-coding-stats-mcp/src/auto-runner.ts:1)
  自动巡检工作区变更并生成 round
- `src/database.ts` / `src/local-storage.ts`
  本地存储、记录写入、状态维护
- `src/token-backfill.ts`
  token 回填逻辑
- `src/online-sync-pipeline.ts` / `src/sync-to-online.ts`
  上传流水线与线上同步
- [docs](/d:/MCP/ai-coding-stats-mcp/docs:1)
  接入说明、风险说明、同步配置样例等补充文档

## MCP 工具

当前核心 MCP 工具分为三组。

### 1. 对话轮次

- `begin_ai_dialogue_turn`
  在一轮对话开始前创建 baseline
- `end_ai_dialogue_turn`
  在一轮对话结束后收口
  如果检测到代码变更，会记录为 `coding_round`
  如果没有代码变更，会记录为 `dialogue_only`
- `list_ai_dialogue_baselines`
  查看未完成的 baseline
- `cleanup_ai_dialogue_baselines`
  清理过期 baseline

### 2. 编码回合

- `begin_ai_coding_round`
  手动开始一个 coding round，保存 Git 快照
- `record_ai_coding_round`
  结束并记录 round，优先基于 baseline 计算代码差异
- `record_ai_coding_round_revert`
  记录一次回滚操作，保留审计信息

### 3. token 记录

- `record_dialogue_token_usage`
  单独记录 token 使用量，适合无代码变更场景或补录场景

## 推荐接入方式

推荐宿主按“每轮对话一进一出”的方式接入。

1. 用户发起一轮新对话前，调用 `begin_ai_dialogue_turn`
2. assistant 完成回复后，调用 `end_ai_dialogue_turn`
3. 保证同一个 `conversationId` 下的 `turnId` 唯一
4. 尽量显式传入 `modelName`
5. 如果 token 当下拿不到，可以先传 0，后续再走回填链路

这种模式的好处是：

- 对话轮次完整
- 能自动区分纯对话和编码轮次
- baseline 生命周期清晰
- 更适合后续报表聚合

补充参考：

- [docs/dialogue-turn-integration-guide.md](/d:/MCP/ai-coding-stats-mcp/docs/dialogue-turn-integration-guide.md:1)

## CLI 命令

构建：

```bash
npm install
npm run build
```

本地启动 MCP：

```bash
npm run start
```

开发模式启动：

```bash
npm run dev
```

常用 CLI：

```bash
ai-coding-stats begin
ai-coding-stats finish
ai-coding-stats turn begin --turn-id turn-1
ai-coding-stats turn end --turn-id turn-1
ai-coding-stats baselines list
ai-coding-stats baselines cleanup --max-age-minutes 1440
ai-coding-stats tokens sync
ai-coding-stats sync
ai-coding-stats status
```

命令大意如下：

- `begin` / `finish`
  手动包裹一个显式 coding round
- `turn begin` / `turn end`
  按对话轮次强制收口，适合宿主侧编排
- `tokens sync`
  回填待补 token
- `sync`
  上传本地待同步数据
- `status`
  查看 rounds、dialogue turns、token、upload、worker 状态

## 自动模式

项目支持 auto-runner。它会持续观察 Git 工作区变化，在改动稳定后自动记录一条 coding round。

启动：

```bash
npm run auto:start
```

对话模式自动记录：

```bash
npm run dialogue:start
```

MCP 服务默认也会尝试拉起 auto-runner，除非显式设置：

```bash
AI_CODING_MCP_AUTO_RUNNER=0
```

## 本地存储

默认数据目录是：

```text
.mcp-toolbox/
```

通常会包含这些内容：

- baseline 文件
- 本地状态文件
- 本地数据库或 JSON 存储
- 自动任务状态
- 同步配置

这个目录会被统计逻辑主动排除，避免把自身元数据误算进代码变更。

## 工作流说明

一个典型流程如下：

1. begin 阶段保存工作区快照
2. 用户或 AI 修改代码
3. end 阶段对比快照与当前工作区
4. 如果有代码变更，写入 round
5. 如果没有代码变更，写入 dialogue token event
6. token 不完整时进入待回填状态
7. 后续运行 backfill 或 pipeline，补 token 并上传

## 适用前提

- 项目目录需要位于 Git 工作区中
- 代码统计依赖 Git 快照和工作区差异
- 如果没有可解析的 Git 根目录，部分能力会被跳过或报错

## 常见问题

### 1. 为什么必须先 begin 再 end

因为精确的“本轮代码变更”依赖 baseline。如果没有 begin 生成的快照，系统无法可靠判断这一轮到底改了多少代码。

### 2. 为什么 round 的 token 可能先是 0

这是设计允许的。代码回合可以先落库，token 后续从日志回填，避免因为日志延迟导致主流程阻塞。

### 3. 为什么会有残留 baseline

通常是 begin 后宿主异常退出，或 end 没有执行。可以使用：

```bash
ai-coding-stats baselines list
ai-coding-stats baselines cleanup --max-age-minutes 1440
```

### 4. 为什么没有统计到代码

常见原因有：

- 当前目录不在 Git 仓库内
- 没有先创建 baseline
- 改动被过滤
- 改动尚未稳定，auto-runner 还没收口

## 相关文档

- [docs/dialogue-turn-integration-guide.md](/d:/MCP/ai-coding-stats-mcp/docs/dialogue-turn-integration-guide.md:1)
- [docs/current-risks-and-issues.md](/d:/MCP/ai-coding-stats-mcp/docs/current-risks-and-issues.md:1)
- [docs/local-storage-risk-plan.md](/d:/MCP/ai-coding-stats-mcp/docs/local-storage-risk-plan.md:1)
- [docs/ai-wrapper-usage.md](/d:/MCP/ai-coding-stats-mcp/docs/ai-wrapper-usage.md:1)
- [docs/sync-config.example.json](/d:/MCP/ai-coding-stats-mcp/docs/sync-config.example.json:1)

## 一句话总结

`ai-coding-stats-mcp` 是一个围绕“AI 对话轮次 + 编码回合 + token 回填 + 本地同步”设计的统计中枢，适合给 Codex、Claude Code 或类似宿主做低侵入接入。
