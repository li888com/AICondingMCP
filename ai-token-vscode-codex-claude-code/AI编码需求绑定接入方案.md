# AI 编码需求绑定接入方案

## 1. 目标

通过本地 `ai-coding-reporter` 采集器，把当前 AI 编码会话绑定到线上需求，让后续每一次 AI 编码统计都能自动带上需求信息。

最终实现：

```text
用户选择线上需求
  ↓
本地保存当前会话的 demandId
  ↓
AI 每轮编码统计代码行数和 token
  ↓
上报线上时自动带 demandId
  ↓
线上按需求统计 AI 成本、代码产出、工具使用情况
```

## 2. 总体方案

当前阶段不使用 MCP，推荐采用：

```text
本地 CLI + 本地 SQLite + 线上 HTTP API
```

整体架构：

```text
用户 / Codex / Claude Code / VSCode
        |
        v
ai-coding-reporter CLI
        |
        | 查询线上需求
        | 绑定当前会话需求
        | 本地 SQLite 缓存绑定关系
        | AI 编码统计上报时自动带 demandId
        v
线上服务 / 数据库 / 看板
```

这套方式不依赖 MCP 工具注册，Codex、Claude Code、VSCode 都可以通过同一个本地采集器接入。

当前实现状态：

```text
1. 已完成方案设计
2. 已完成 GPM 需求返回结构分析
3. 已更新 ai-coding-requirement skill 为 demandId / demandCode 口径
4. 已定义 ai-coding-reporter req 命令格式
5. 尚未实现可执行的 ai-coding-reporter CLI
```

因此当前直接执行：

```bash
ai-coding-reporter req
```

可能会出现命令不存在或子命令未实现。后续需要进入 CLI 开发阶段后，才能真正执行需求查询、绑定、清除和本地缓存。

同时，不建议把 `ai-coding-requirement` skill 作为需求查询和绑定的主链路。当前 skill 调用耗时约 1 分钟，放在需求绑定这种高频前置流程里体验较差。更合适的分工是：

```text
CLI / VSCode 扩展：
  直接调用线上 HTTP API，负责真实查询、绑定、缓存和上传

skill：
  只作为交互说明、入口提示或低频兜底，不进入主流程
```

## 3. 角色分工

### 3.1 ai-coding-reporter CLI

负责：

```text
1. 登录线上服务
2. 查询需求列表
3. 搜索需求
4. 绑定当前会话到需求
5. 清除当前会话需求绑定
6. 本地保存绑定关系
7. AI 编码统计上报时自动带 demandId
```

### 3.2 本地 SQLite

负责保存：

```text
1. 当前会话绑定的需求
2. AI 编码 turn 记录
3. token 延迟回填状态
4. 上传失败重试队列
```

### 3.3 线上服务

负责：

```text
1. 提供需求查询 API
2. 保存会话与需求的绑定关系
3. 接收 AI 编码统计数据
4. 按需求聚合 token 和代码行数
```

### 3.4 ai-coding-requirement skill

当前阶段只建议作为辅助入口，不作为正式数据链路。

适合承担：

```text
1. 告诉用户如何使用 ai-coding-reporter req
2. 解释当前需求绑定方案
3. 在用户不知道命令时给出提示
4. 低频查看本地绑定状态
```

不建议承担：

```text
1. 查询线上需求列表
2. 搜索线上需求
3. 绑定需求
4. 清除绑定
5. 每次 AI 编码上报前查询需求
6. 上传 AI 编码统计数据
```

原因是这些动作需要稳定、快速、可重试，放在本地 CLI 或 VSCode 扩展里更合适。

## 4. 命令设计

把需求绑定能力做成本地命令：

```bash
ai-coding-reporter req
ai-coding-reporter req <keyword>
ai-coding-reporter req bind <序号|demandCode|demandId>
ai-coding-reporter req clear
```

命令含义：

```text
ai-coding-reporter req
  查询最近或活跃需求

ai-coding-reporter req 订单
  按关键词搜索需求

ai-coding-reporter req bind MR20251029000001
  绑定当前会话到项目需求

ai-coding-reporter req clear
  清除当前会话的需求绑定
```

推荐完整使用流程：

```bash
ai-coding-reporter login
ai-coding-reporter req
ai-coding-reporter req bind MR20251029000001
ai-coding-reporter start
ai-coding-reporter end --tool codex
```

绑定完成后，后续 AI 编码统计会自动带上 `demandId`、`demandCode` 和 `demandName`。

登录建议使用命令行交互，不建议让用户手写配置文件：

```bash
ai-coding-reporter login
```

登录后本地保存用户工号，后续上报 AI 编码数据时带上 `employeeId`，用于线上按个人查看统计数据。

## 5. conversationId 规则

需求绑定需要一个稳定的会话标识。第一版建议使用：

```text
conversationId = <client>:<absolute project path>
```

示例：

```text
codex:C:/xxx/project
claude:C:/xxx/project
vscode:C:/xxx/project
```

这样同一个项目下，不同工具的绑定可以区分开。

如果后续能拿到真实 AI sessionId，可以升级为：

```text
<client>:<absolute project path>:<sessionId>
```

第一版不建议过度复杂，先按项目路径维度绑定即可。

## 6. 核心数据关系

推荐关系：

```text
requirement
  1
  |
  n
conversation_requirement_selection
  1
  |
  n
ai_coding_turn
```

解释：

```text
一个需求可以关联多个 AI 会话
一个 AI 会话当前最多绑定一个需求
一个 AI 会话可以产生多条 AI 编码 turn 统计
```

## 7. 线上 API 设计

### 7.1 查询需求列表

```http
GET /api/ai-coding/requirements?status=active&limit=10
```

返回：

```json
{
  "items": [
    {
      "id": 123,
      "title": "订单系统 AI 编码统计",
      "project": "订单系统",
      "gpm": "张三",
      "status": "active"
    }
  ]
}
```

### 7.2 按关键词搜索需求

```http
GET /api/ai-coding/requirements?keyword=订单&limit=10
```

返回：

```json
{
  "items": [
    {
      "id": 123,
      "title": "订单系统 AI 编码统计",
      "project": "订单系统",
      "gpm": "张三",
      "status": "active"
    }
  ]
}
```

### 7.3 绑定当前会话需求

```http
PUT /api/ai-coding/conversation-requirement-selection
```

请求体：

```json
{
  "conversationId": "codex:C:/xxx/project",
  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "phaseName": "开发中",
  "projectCode": "2025-09-1701",
  "projectName": "GPM-版本化项目",
  "taskId": null,
  "selectedBy": "codex"
}
```

返回：

```json
{
  "conversationId": "codex:C:/xxx/project",
  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "phaseName": "开发中",
  "projectCode": "2025-09-1701",
  "projectName": "GPM-版本化项目",
  "taskId": null,
  "selectedAt": "2026-05-21T10:00:00+08:00"
}
```

### 7.4 清除当前会话绑定

```http
DELETE /api/ai-coding/conversation-requirement-selection?conversationId=codex:C:/xxx/project
```

返回：

```json
{
  "conversationId": "codex:C:/xxx/project",
  "cleared": true
}
```

### 7.5 查询当前会话绑定

为了让本地采集器可以校准绑定关系，建议提供查询接口：

```http
GET /api/ai-coding/conversation-requirement-selection?conversationId=codex:C:/xxx/project
```

已绑定时返回：

```json
{
  "conversationId": "codex:C:/xxx/project",
  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "projectName": "GPM-版本化项目",
  "taskId": null
}
```

未绑定时返回：

```json
{
  "conversationId": "codex:C:/xxx/project",
  "demandId": null,
  "taskId": null
}
```

## 8. 本地 SQLite 设计

### 8.1 requirement_selections

保存当前会话和需求的绑定关系。

```sql
CREATE TABLE requirement_selections (
  conversation_id TEXT PRIMARY KEY,
  binding_level TEXT NOT NULL DEFAULT 'demand',
  demand_id TEXT,
  demand_code TEXT,
  demand_name TEXT,
  phase_name TEXT,
  project_code TEXT,
  project_name TEXT,
  task_id TEXT,
  task_code TEXT,
  task_name TEXT,
  status TEXT,
  selected_by TEXT,
  selected_at TEXT NOT NULL,
  synced_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

使用规则：

```text
1. ai-coding-reporter req bind <demandCode|demandId> 绑定成功后，写入本地表
2. 每次 AI turn 上报前，优先查本地绑定
3. 找到 demandId 就带上
4. 找不到就按未关联需求上报
5. 本地缓存可定期和线上校准
```

### 8.2 turns 表扩展

AI 编码统计的 turns 表需要增加需求字段：

```sql
ALTER TABLE turns ADD COLUMN binding_level TEXT;
ALTER TABLE turns ADD COLUMN demand_id TEXT;
ALTER TABLE turns ADD COLUMN demand_code TEXT;
ALTER TABLE turns ADD COLUMN demand_name TEXT;
ALTER TABLE turns ADD COLUMN phase_name TEXT;
ALTER TABLE turns ADD COLUMN project_code TEXT;
ALTER TABLE turns ADD COLUMN project_name TEXT;
ALTER TABLE turns ADD COLUMN task_id TEXT;
ALTER TABLE turns ADD COLUMN task_code TEXT;
ALTER TABLE turns ADD COLUMN task_name TEXT;
```

每次生成 turn 时，把当前绑定的需求写入 turn。

### 8.3 upload_queue

上传失败时，队列中的 payload 也要保留需求字段，避免重试时丢失归属关系。

```json
{
  "turnId": "codex-20260521-xxxx",
  "conversationId": "codex:C:/xxx/project",
  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "projectCode": "2025-09-1701",
  "projectName": "GPM-版本化项目",
  "taskId": null,
  "taskCode": null,
  "taskName": null,
  "tool": "codex",
  "codeLinesChanged": 150,
  "tokenStatus": "pending"
}
```

## 9. AI 编码统计上报扩展

后续每次上报 turn 数据时增加需求字段：

```json
{
  "turnId": "codex-20260521-xxxx",
  "conversationId": "codex:C:/xxx/project",
  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "phaseName": "开发中",
  "projectCode": "2025-09-1701",
  "projectName": "GPM-版本化项目",
  "taskId": null,
  "taskCode": null,
  "taskName": null,
  "tool": "codex",
  "modelName": "gpt-5-codex",
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150,
  "inputTokens": 12000,
  "outputTokens": 3000,
  "totalTokens": 15000,
  "tokenStatus": "completed"
}
```

注意：

```text
demandId 可以为空
为空代表本次 AI 编码未关联项目需求
```

## 10. 用户交互流程

### 10.0 GPM 需求返回结构和绑定层级

当前需求查询接口参考：

```http
POST https://gpm-uat.sbtjt.com/api/plugins/sbt/consultantSettlement/demand
```

请求体：

```json
{
  "userId": "00232924"
}
```

返回的需求对象主要字段：

```text
demandId       需求唯一 ID
demandCode     需求编号，例如 MR20251029000001
demandName     需求名称
phaseName      需求阶段，例如 开发中、审核中、版本发布
projectCode    项目编号
projectName    项目名称
taskInfoVOList 项目需求下的任务列表
bugDemandVOS   需求关联缺陷列表
```

当前第一版只绑定到“项目需求”，也就是：

```text
bindingLevel = demand
绑定字段 = demandId
```

后续如果要绑定到项目需求下的任务，再扩展：

```text
bindingLevel = task
绑定字段 = demandId + taskId
```

因此本地和上报数据建议从第一版就预留任务字段：

```text
demandId
demandCode
demandName
projectCode
projectName
phaseName
taskId        第一版为空
taskCode      第一版为空
taskName      第一版为空
bindingLevel  第一版固定 demand
```

### 10.0.1 CLI 需求列表显示格式

第一版 CLI 查询需求时，应展示“可以绑定的项目需求”，不直接让用户绑定任务。

推荐展示字段：

```text
序号. [需求编号] 需求名称
    阶段: 阶段名称 | 项目: 项目名称/项目编号 | 任务: N 个 | 缺陷: N 个
    demandId: xxx
```

示例：

```text
可绑定的项目需求：

1. [MR20251029000001] 需求规划时间校验
   阶段: 开发中 | 项目: GPM-版本化项目 / 2025-09-1701 | 任务: 20 个 | 缺陷: 0 个
   demandId: 0e81d4a6-0b2a-4864-bcaf-62a5d214be09

2. [MR20260126000001] 测试节点
   阶段: 待规划 | 项目: GPM版本化测试项目 / 2026-01-0401 | 任务: 5 个 | 缺陷: 8 个
   demandId: 0f423f11-131e-4ba1-84cd-df4028b8c9eb

3. [MR20251208000001] 测试
   阶段: 审核中 | 项目: 未关联项目 | 任务: 0 个 | 缺陷: 0 个
   demandId: 01495d56-0f64-499f-ad90-85ae25771893
```

绑定提示：

```text
使用 ai-coding-reporter req bind <序号>
或 ai-coding-reporter req bind <demandCode>
或 ai-coding-reporter req bind <demandId>
```

不建议只用短数字 ID 作为绑定入口，因为当前返回的 `demandId` 是 UUID，`demandCode` 才是用户容易识别的业务编号。

推荐支持三种绑定方式：

```bash
ai-coding-reporter req bind 1
ai-coding-reporter req bind MR20251029000001
ai-coding-reporter req bind 0e81d4a6-0b2a-4864-bcaf-62a5d214be09
```

为了兼容早期简写，也可以保留：

```bash
ai-coding-reporter req MR20251029000001
```

但文档和提示中优先推荐 `req bind`，避免和关键词搜索混淆。

### 10.1 查询最近需求

用户执行：

```bash
ai-coding-reporter req
```

CLI 展示：

```text
可绑定的项目需求：

1. [MR20251029000001] 需求规划时间校验
   阶段: 开发中 | 项目: GPM-版本化项目 / 2025-09-1701 | 任务: 20 个 | 缺陷: 0 个
   demandId: 0e81d4a6-0b2a-4864-bcaf-62a5d214be09

2. [MR20260126000001] 测试节点
   阶段: 待规划 | 项目: GPM版本化测试项目 / 2026-01-0401 | 任务: 5 个 | 缺陷: 8 个
   demandId: 0f423f11-131e-4ba1-84cd-df4028b8c9eb
```

提示：

```text
使用 ai-coding-reporter req bind <序号|demandCode|demandId> 绑定项目需求。
```

### 10.2 搜索需求

用户执行：

```bash
ai-coding-reporter req 订单
```

CLI 展示匹配结果：

```text
1. [MR20251029000001] 需求规划时间校验
   阶段: 开发中 | 项目: GPM-版本化项目 / 2025-09-1701 | 任务: 20 个 | 缺陷: 0 个
   demandId: 0e81d4a6-0b2a-4864-bcaf-62a5d214be09
```

如果只有一个明确结果，可以提示用户执行绑定命令。

### 10.3 绑定需求

用户执行：

```bash
ai-coding-reporter req bind MR20251029000001
```

CLI 调用线上绑定接口，成功后写入本地 SQLite。

成功提示：

```text
当前会话已绑定到项目需求：
[MR20251029000001] 需求规划时间校验
项目：GPM-版本化项目 / 2025-09-1701
阶段：开发中

后续 AI 编码统计会自动关联该需求。
```

### 10.4 清除绑定

用户执行：

```bash
ai-coding-reporter req clear
```

CLI 调用线上清除接口，并删除或清空本地绑定。

成功提示：

```text
当前会话需求绑定已清除，后续统计将不关联需求。
```

## 11. 和 AI 编码采集器的衔接

AI 编码采集器每次生成 turn 时：

```text
1. 根据当前工具和项目路径计算 conversationId
2. 查询本地 requirement_selections
3. 如果本地没有绑定，可选择查询线上绑定做校准
4. 把 demandId / demandCode / demandName 写入 turns 表
5. 生成上报 payload
6. 上传线上
7. 上传失败则进入 upload_queue
```

代码变更和 token 的采集仍按原方案：

```text
代码行数：对话结束后立即统计并上报
token：如果日志延迟生成，先标记 pending，后续回填
```

## 12. 包装命令方案

为了减少用户操作，可以增加包装命令：

```bash
ai-codex
ai-claude
```

也可以支持一次性指定需求：

```bash
ai-codex --demand MR20251029000001
ai-claude --demand MR20251029000001
```

或者先绑定一次，再运行：

```bash
ai-coding-reporter req bind MR20251029000001
ai-codex
```

包装命令内部流程：

```text
1. 读取当前需求绑定
2. 记录对话开始
3. 启动真实 AI 工具
4. 检测对话结束
5. 统计代码变更
6. 上传 turn 数据
7. 等待 token 日志后回填
```

## 13. VSCode 场景

VSCode 可以做一个小扩展或面板，底层仍然调用同一个 `ai-coding-reporter`。

面板能力：

```text
1. 登录
2. 搜索需求
3. 选择并绑定需求
4. 开始统计
5. 结束并上传
6. 查看本次上传状态
```

这样 VSCode、Codex、Claude Code 可以共用同一套本地存储和线上 API。

## 14. 异常处理

### 14.1 需求不存在

提示：

```text
没有找到项目需求 MR20251029000001，请检查 demandCode / demandId，或用 ai-coding-reporter req <keyword> 搜索。
```

### 14.2 线上 API 不可用

处理：

```text
1. 不阻塞 AI 编码统计
2. 本次统计可以先按未关联需求上报
3. 也可以进入本地 upload_queue 等待补传
4. 提示用户需求服务暂不可用
```

### 14.3 当前没有绑定需求

处理：

```text
正常上报，demandId = null
```

### 14.4 需求绑定变更

如果用户从 MR20251029000001 切换到 MR20260126000001：

```text
切换后的新 turn 关联 #124
历史已上报 turn 不自动改动
```

如果确实需要迁移历史数据，应由线上提供单独的管理能力。

## 15. 权限和安全

建议：

```text
1. 查询需求需要用户登录 token
2. 绑定需求时校验用户是否有该需求权限
3. 上报 AI turn 时校验 demandId 是否对当前用户可见
4. 本地不保存完整敏感 token
5. prompt 默认只保存 hash 和 preview
6. HTTP 请求统一使用 UTF-8 JSON
```

第一版用户身份方案：

```text
1. 通过 ai-coding-reporter login 登录
2. 记录 employeeId / userName / teamId / accessToken
3. 上报 turn 时带 employeeId
4. token 过期时提示重新登录
5. 登录失败不丢本地数据，数据进入 upload_queue 等待补传
```

## 16. 推荐落地顺序

### 第一阶段：CLI 跑通需求绑定

实现：

```text
ai-coding-reporter login
ai-coding-reporter req
ai-coding-reporter req <keyword>
ai-coding-reporter req bind <序号|demandCode|demandId>
ai-coding-reporter req clear
```

目标：

```text
查询线上需求
绑定当前会话
写入本地 SQLite
```

这一阶段不要依赖 skill 调用线上 API，避免 1 分钟级别等待影响落地体验。

### 第二阶段：统计上报带需求

实现：

```text
requirement_selections 表
turns.requirement_id
turns.requirement_title
上报 payload 自动带 demandId / demandCode / demandName
```

目标：

```text
AI 编码统计可以按需求归属。
```

### 第三阶段：包装命令

实现：

```text
ai-codex
ai-claude
ai-codex --demand MR20251029000001
ai-claude --demand MR20251029000001
```

目标：

```text
减少用户手动 start/end 和手动绑定成本。
```

### 第四阶段：VSCode 扩展

实现：

```text
需求搜索
需求绑定
开始统计
结束并上传
上传状态展示
```

目标：

```text
覆盖 VSCode 内 AI 编码场景。
```

### 第五阶段：线上看板

增加按需求维度统计：

```text
需求维度 token 消耗
需求维度代码变更行数
需求维度工具分布
需求维度模型分布
需求维度人员贡献
```

### 手动补跑能力

第一版需要保留手动执行能力，方便自动同步失败后排查和补传。

推荐命令：

```bash
ai-coding-reporter sync --dry-run
ai-coding-reporter sync --retry-failed
ai-coding-reporter tokens sync
ai-coding-reporter reconcile
ai-coding-reporter status
```

其中：

```text
sync --dry-run     只检查待上传数据，不真正上传
sync --retry-failed  重试失败数据
tokens sync        手动执行 token 日志回填
reconcile          依次执行 token sync + online sync + 状态汇总
status             查看本地是否还有 pending / failed / needs_review
```

## 17. 总结

当前阶段推荐不使用 MCP，直接采用：

```text
本地 ai-coding-reporter CLI
+ 线上 HTTP API
+ 本地 SQLite 缓存
+ AI 编码上报自动带 demandId
```

这种方式实现快、依赖少、适配 Codex / Claude Code / VSCode，能先把需求归属和 AI 编码统计链路跑通。

关键原则：

```text
1. 需求绑定通过 CLI 完成
2. 绑定关系本地 SQLite 缓存
3. 每次 turn 上报前自动读取 demandId
4. demandId 允许为空
5. 线上按需求聚合 token 和代码行数
```

## 18. 当前存在的问题

### 18.1 skill 调用耗时过长

当前 `ai-coding-requirement` skill 调用耗时约 1 分钟。如果把它作为需求查询、搜索、绑定的主流程，会带来明显问题：

```text
1. 用户绑定需求时等待时间太长
2. VSCode / Codex / Claude Code 自动化接入体验差
3. 网络或工具异常时不容易做本地重试
4. 不适合每次 AI 编码上报前调用
```

处理建议：

```text
正式主链路使用 ai-coding-reporter CLI 或 VSCode 扩展直接调线上 HTTP API
skill 只保留为说明、提示或低频兜底
```

### 18.2 需求绑定和 AI 统计不能依赖对话系统

需求绑定属于数据采集链路的一部分，需要满足：

```text
1. 快速响应
2. 本地缓存
3. 离线可用
4. 上传失败可重试
5. 不依赖当前 AI 对话是否可用
```

skill 更适合做人机交互提示，不适合作为后台稳定数据链路。

### 18.3 token 日志可能延迟生成

AI 对话结束后，代码变更可以立即统计，但 token 日志可能稍后才生成。

现象：

```text
1. 代码行数已经能拿到
2. token 消耗暂时拿不到
3. 如果等待 token，会拖慢整次上报
```

处理建议：

```text
代码行数立即上报
token 先标记 pending
日志生成后异步回填
```

### 18.4 pending token 不能逐条扫描日志

如果每条 pending turn 都自己扫描日志，会造成重复读取和性能浪费。

处理建议：

```text
只保留一个 token watcher
按日志 offset 增量读取新增内容
解析 token event
批量匹配 pending turns
```

### 18.5 prompt 和中文字段可能乱码

需求标题、prompt preview、项目名称都可能包含中文。

风险点：

```text
1. Windows 命令行参数编码不一致
2. 日志读取使用系统默认编码
3. HTTP 请求没有声明 charset
4. 手写 JSON 拼接导致转义错误
```

处理建议：

```text
1. 全链路使用 UTF-8
2. HTTP 使用 application/json; charset=utf-8
3. 不通过命令行参数传完整中文 prompt
4. 使用 JSON 序列化，不手写拼接
5. prompt 默认只保存 hash 和 preview
```

### 18.6 需求绑定粒度需要后续确认

第一版建议：

```text
conversationId = <client>:<absolute project path>
```

这个粒度简单稳定，但也有局限：

```text
1. 同一个项目同时做多个需求时，需要手动切换绑定
2. 同一个 AI 会话内切换需求时，历史 turn 不自动迁移
3. 多窗口同时操作同一项目时可能需要更细 sessionId
```

后续可升级：

```text
conversationId = <client>:<absolute project path>:<sessionId>
```

但第一版不建议直接做太细，先保证链路跑通。
