# AI 编码统计线上接口需求文档

## 1. 背景

当前本地 `ai-coding-reporter` MVP 已实现：

```text
1. 工号登录配置
2. GPM 项目需求查询和本地绑定
3. start / end 单轮代码变更统计
4. Codex / Claude Code token 日志扫描
5. token 异步回填
6. 本地 SQLite 和 upload_queue
7. sync --dry-run 本地上传队列检查
```

当前缺口是：

```text
线上 AI turn 上传接口尚未实现。
```

因此需要后端提供 AI 编码统计上报接口，用于接收本地采集器上传的每轮 AI 编码数据，并支持后续 token 回填、幂等、防重复、失败补传。

## 2. 目标

线上需要支持：

```text
1. 创建或更新 AI 编码 turn
2. token 延迟回填
3. 幂等上传，重复请求不重复入库
4. 按工号、项目需求、工具、模型、日期聚合统计
5. demand 级绑定，后续预留 task 级绑定
6. token 为空时允许先入库
7. 本地断网后重试不产生重复数据
```

第一版不要求：

```text
1. VSCode 插件接入
2. daemon 常驻状态上报
3. 撤销监听
4. 精确 AI 亲手写入归因
5. task 级绑定强制启用
```

## 3. 数据口径

### 3.1 统计粒度

一条记录代表一次 AI 编码 turn：

```text
用户发起一轮 AI 编码
  ↓
AI 回复并产生代码变更
  ↓
本地 end 统计代码行数
  ↓
上传一条 turn
```

### 3.2 代码行数口径

本地采用单轮增量口径：

```text
本轮变更 = 结束快照 - 开始快照
```

本地统计来源：

```text
已跟踪文件：git diff --numstat
未跟踪文件：git ls-files --others --exclude-standard
```

线上只接收本地统计后的结果，不重新计算代码行数。

核心字段：

```text
filesChanged
linesAdded
linesDeleted
codeLinesChanged = linesAdded + linesDeleted
```

### 3.3 token 口径

token 可能延迟生成。

第一阶段上传 turn 时：

```text
tokenStatus = pending
inputTokens = null
outputTokens = null
totalTokens = null
```

后续通过 PATCH 回填：

```text
tokenStatus = completed / needs_review / not_found / unavailable
```

## 4. 需求绑定口径

当前第一版绑定 GPM 项目需求：

```text
bindingLevel = demand
```

字段：

```text
demandId
demandCode
demandName
phaseName
projectCode
projectName
```

后续预留任务绑定：

```text
bindingLevel = task
taskId
taskCode
taskName
```

第一版 `taskId/taskCode/taskName` 可以为空。

## 5. 接口设计

### 5.1 创建或更新 AI 编码 turn

接口：

```http
POST /api/ai-codingTurns
```

请求头：

```http
Content-Type: application/json; charset=utf-8
Idempotency-Key: local-turn-<turnId>
Authorization: Bearer <token>
```

请求体：

```json
{
  "idempotencyKey": "local-turn-codex-20260521103000-abc123",
  "turnId": "codex-20260521103000-abc123",
  "conversationId": "codex:C:/workspace/order-service",
  "employeeId": "00232924",
  "userName": "张三",
  "teamId": "",

  "tool": "codex",
  "modelName": "gpt-5.5",
  "projectPath": "C:/workspace/order-service",
  "projectName": "order-service",
  "gitBranch": "feature/order-ai",
  "commitBefore": "abc123",
  "commitAfter": "def456",

  "startedAt": "2026-05-21T10:00:00+08:00",
  "endedAt": "2026-05-21T10:03:00+08:00",

  "filesChanged": 3,
  "linesAdded": 120,
  "linesDeleted": 30,
  "codeLinesChanged": 150,

  "tokenStatus": "pending",
  "tokenSource": null,
  "inputTokens": null,
  "outputTokens": null,
  "totalTokens": null,

  "bindingLevel": "demand",
  "demandId": "0e81d4a6-0b2a-4864-bcaf-62a5d214be09",
  "demandCode": "MR20251029000001",
  "demandName": "需求规划时间校验",
  "phaseName": "开发中",
  "projectCode": "2025-09-1701",
  "projectNameBound": "GPM-版本化项目",
  "taskId": null,
  "taskCode": null,
  "taskName": null,

  "codeStatsSource": "baseline diff snapshot",
  "codeStatsPrecision": "exact",
  "metadata": {
    "workspaceCumulativeChanged": 710,
    "roundChanged": 150,
    "files": {
      "src/app.ts": {
        "added": 120,
        "deleted": 30,
        "source": "tracked"
      }
    }
  }
}
```

成功返回：

```json
{
  "code": 200,
  "data": {
    "remoteId": "1930000000000000001",
    "turnId": "codex-20260521103000-abc123",
    "idempotencyKey": "local-turn-codex-20260521103000-abc123",
    "created": true,
    "uploadStatus": "uploaded"
  },
  "msg": "操作成功"
}
```

重复上传返回：

```json
{
  "code": 200,
  "data": {
    "remoteId": "1930000000000000001",
    "turnId": "codex-20260521103000-abc123",
    "idempotencyKey": "local-turn-codex-20260521103000-abc123",
    "created": false,
    "uploadStatus": "uploaded"
  },
  "msg": "重复请求，已返回已有记录"
}
```

### 5.2 回填 token

接口：

```http
PATCH /api/ai-codingTurns/{turnId}/tokens
```

请求头：

```http
Content-Type: application/json; charset=utf-8
Idempotency-Key: token-event-<sourceEventId>
Authorization: Bearer <token>
```

请求体：

```json
{
  "sourceEventId": "codex:3442899",
  "tokenStatus": "completed",
  "tokenSource": "tool_log",
  "inputTokens": 198376,
  "outputTokens": 1419,
  "totalTokens": 199795,
  "cachedTokens": 194432,
  "reasoningTokens": 434,
  "toolTokens": 199795,
  "occurredAt": "2026-05-21T13:26:13+00:00",
  "metadata": {
    "tool": "codex",
    "matchStrategy": "time_window",
    "confidence": "exact"
  }
}
```

成功返回：

```json
{
  "code": 200,
  "data": {
    "turnId": "codex-20260521103000-abc123",
    "tokenStatus": "completed",
    "updated": true
  },
  "msg": "操作成功"
}
```

如果 turn 不存在：

```json
{
  "code": 404,
  "data": null,
  "msg": "turn 不存在"
}
```

### 5.3 查询上传状态

接口：

```http
GET /api/ai-codingTurns/{turnId}
```

返回：

```json
{
  "code": 200,
  "data": {
    "remoteId": "1930000000000000001",
    "turnId": "codex-20260521103000-abc123",
    "uploadStatus": "uploaded",
    "tokenStatus": "completed",
    "demandCode": "MR20251029000001",
    "codeLinesChanged": 150,
    "totalTokens": 199795
  },
  "msg": "操作成功"
}
```

### 5.4 批量查询本地待同步状态可选接口

第一版可不做。后续如果需要本地校准远程状态，可提供：

```http
POST /api/ai-codingTurns/status-batch
```

请求：

```json
{
  "turnIds": [
    "codex-20260521103000-abc123"
  ]
}
```

## 6. 状态定义

### 6.1 uploadStatus

```text
pending     本地待上传，线上一般不会存该状态
uploaded    已上传
failed      上传失败，本地使用为主
```

线上建议使用：

```text
uploaded
```

如果后端需要记录异常，也可以扩展：

```text
rejected
```

### 6.2 tokenStatus

```text
pending       等待 token 回填
completed     已完成
unavailable   当前工具无法提供 token
not_found     超过时间仍未找到 token
needs_review  匹配到了多个候选，需要人工确认
conflict       token 回填冲突
```

### 6.3 bindingLevel

```text
demand  项目需求级
task    项目需求下任务级，后续扩展
none    未绑定
```

## 7. 幂等规则

### 7.1 turn 创建幂等

唯一键：

```text
idempotencyKey
```

推荐值：

```text
local-turn-<turnId>
```

规则：

```text
1. 同一个 idempotencyKey 只能创建一条 turn
2. 重复 POST 返回已有记录
3. 如果同一个 idempotencyKey 的 payload 关键字段冲突，返回已有记录并标记 conflict，或返回 409
4. turnId 也建议唯一
```

### 7.2 token 回填幂等

唯一键：

```text
sourceEventId
```

推荐值：

```text
codex:<logId>
claude:<messageId>
```

规则：

```text
1. 同一个 sourceEventId 只能回填一次
2. 重复 PATCH 不重复写 token event
3. 如果 token 值相同，返回成功
4. 如果 token 值不同，标记 conflict
```

## 8. MySQL 表结构建议

### 8.1 ai_coding_turns

```sql
CREATE TABLE ai_coding_turns (
  id BIGINT NOT NULL PRIMARY KEY COMMENT '主键，可使用雪花 ID',
  turn_id VARCHAR(128) NOT NULL COMMENT '本地 turnId',
  idempotency_key VARCHAR(180) NOT NULL COMMENT '幂等键',
  conversation_id VARCHAR(512) DEFAULT NULL COMMENT '会话 ID',

  employee_id VARCHAR(64) NOT NULL COMMENT '工号',
  user_name VARCHAR(128) DEFAULT NULL COMMENT '用户姓名',
  team_id VARCHAR(128) DEFAULT NULL COMMENT '团队 ID',

  tool VARCHAR(64) NOT NULL COMMENT 'AI 工具，如 codex/claude/vscode',
  model_name VARCHAR(128) DEFAULT NULL COMMENT '模型名称',
  project_path VARCHAR(1024) DEFAULT NULL COMMENT '本地项目路径，可后续改为 hash',
  project_name VARCHAR(255) DEFAULT NULL COMMENT '本地项目名',
  git_branch VARCHAR(255) DEFAULT NULL COMMENT 'Git 分支',
  commit_before VARCHAR(128) DEFAULT NULL COMMENT '开始 commit',
  commit_after VARCHAR(128) DEFAULT NULL COMMENT '结束 commit',

  started_at DATETIME(3) NOT NULL COMMENT '开始时间',
  ended_at DATETIME(3) DEFAULT NULL COMMENT '结束时间',

  files_changed INT NOT NULL DEFAULT 0 COMMENT '变更文件数',
  lines_added INT NOT NULL DEFAULT 0 COMMENT '新增行数',
  lines_deleted INT NOT NULL DEFAULT 0 COMMENT '删除行数',
  code_lines_changed INT NOT NULL DEFAULT 0 COMMENT '新增+删除',

  token_status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'token 状态',
  token_source VARCHAR(64) DEFAULT NULL COMMENT 'token 来源',
  input_tokens BIGINT DEFAULT NULL COMMENT '输入 token',
  output_tokens BIGINT DEFAULT NULL COMMENT '输出 token',
  total_tokens BIGINT DEFAULT NULL COMMENT '总 token',
  cached_tokens BIGINT DEFAULT NULL COMMENT '缓存 token',
  reasoning_tokens BIGINT DEFAULT NULL COMMENT '推理 token',
  tool_tokens BIGINT DEFAULT NULL COMMENT '工具调用 token',

  binding_level VARCHAR(32) NOT NULL DEFAULT 'none' COMMENT 'demand/task/none',
  demand_id VARCHAR(64) DEFAULT NULL COMMENT 'GPM demandId',
  demand_code VARCHAR(64) DEFAULT NULL COMMENT 'GPM demandCode',
  demand_name VARCHAR(512) DEFAULT NULL COMMENT '需求名称',
  phase_name VARCHAR(128) DEFAULT NULL COMMENT '需求阶段',
  project_code VARCHAR(128) DEFAULT NULL COMMENT 'GPM 项目编号',
  project_name_bound VARCHAR(512) DEFAULT NULL COMMENT 'GPM 项目名称',
  task_id VARCHAR(64) DEFAULT NULL COMMENT '任务 ID，后续预留',
  task_code VARCHAR(64) DEFAULT NULL COMMENT '任务编号，后续预留',
  task_name VARCHAR(512) DEFAULT NULL COMMENT '任务名称，后续预留',

  code_stats_source VARCHAR(128) DEFAULT NULL COMMENT '代码统计来源',
  code_stats_precision VARCHAR(64) DEFAULT NULL COMMENT '代码统计精度',
  upload_status VARCHAR(32) NOT NULL DEFAULT 'uploaded' COMMENT '上传状态',
  metadata_json JSON DEFAULT NULL COMMENT '扩展元数据',

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_turn_id (turn_id),
  UNIQUE KEY uk_idempotency_key (idempotency_key),
  KEY idx_employee_time (employee_id, started_at),
  KEY idx_demand_time (demand_id, started_at),
  KEY idx_demand_code_time (demand_code, started_at),
  KEY idx_tool_time (tool, started_at),
  KEY idx_token_status (token_status),
  KEY idx_project_code_time (project_code, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 编码 turn 统计表';
```

### 8.2 ai_coding_token_events

```sql
CREATE TABLE ai_coding_token_events (
  id BIGINT NOT NULL PRIMARY KEY COMMENT '主键，可使用雪花 ID',
  turn_id VARCHAR(128) NOT NULL COMMENT '关联 turnId',
  source_event_id VARCHAR(180) NOT NULL COMMENT 'token 事件幂等 ID',
  tool VARCHAR(64) NOT NULL COMMENT '工具',
  token_source VARCHAR(64) NOT NULL COMMENT 'token 来源',

  occurred_at DATETIME(3) DEFAULT NULL COMMENT 'token 事件发生时间',
  input_tokens BIGINT DEFAULT NULL,
  output_tokens BIGINT DEFAULT NULL,
  total_tokens BIGINT DEFAULT NULL,
  cached_tokens BIGINT DEFAULT NULL,
  reasoning_tokens BIGINT DEFAULT NULL,
  tool_tokens BIGINT DEFAULT NULL,

  match_strategy VARCHAR(64) DEFAULT NULL COMMENT '匹配策略',
  confidence VARCHAR(32) DEFAULT NULL COMMENT '匹配置信度',
  raw_json JSON DEFAULT NULL COMMENT '原始或摘要数据',

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_source_event_id (source_event_id),
  KEY idx_turn_id (turn_id),
  KEY idx_tool_time (tool, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 编码 token 回填事件表';
```

### 8.3 ai_coding_upload_idempotency

如果后端已有统一幂等组件，可以不单独建表。否则建议：

```sql
CREATE TABLE ai_coding_upload_idempotency (
  id BIGINT NOT NULL PRIMARY KEY COMMENT '主键',
  idempotency_key VARCHAR(180) NOT NULL COMMENT '幂等键',
  entity_type VARCHAR(64) NOT NULL COMMENT 'turn/token',
  entity_id VARCHAR(128) NOT NULL COMMENT 'turnId 或 sourceEventId',
  request_hash VARCHAR(128) DEFAULT NULL COMMENT '请求体 hash',
  response_json JSON DEFAULT NULL COMMENT '首次响应',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_idempotency_key (idempotency_key),
  KEY idx_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 编码上传幂等表';
```

## 9. PostgreSQL 表结构建议

如果线上使用 PostgreSQL，可以用以下结构。

### 9.1 ai_coding_turns

```sql
CREATE TABLE ai_coding_turns (
  id BIGSERIAL PRIMARY KEY,
  turn_id VARCHAR(128) NOT NULL UNIQUE,
  idempotency_key VARCHAR(180) NOT NULL UNIQUE,
  conversation_id VARCHAR(512),

  employee_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(128),
  team_id VARCHAR(128),

  tool VARCHAR(64) NOT NULL,
  model_name VARCHAR(128),
  project_path VARCHAR(1024),
  project_name VARCHAR(255),
  git_branch VARCHAR(255),
  commit_before VARCHAR(128),
  commit_after VARCHAR(128),

  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,

  files_changed INTEGER NOT NULL DEFAULT 0,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_deleted INTEGER NOT NULL DEFAULT 0,
  code_lines_changed INTEGER NOT NULL DEFAULT 0,

  token_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  token_source VARCHAR(64),
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  cached_tokens BIGINT,
  reasoning_tokens BIGINT,
  tool_tokens BIGINT,

  binding_level VARCHAR(32) NOT NULL DEFAULT 'none',
  demand_id VARCHAR(64),
  demand_code VARCHAR(64),
  demand_name VARCHAR(512),
  phase_name VARCHAR(128),
  project_code VARCHAR(128),
  project_name_bound VARCHAR(512),
  task_id VARCHAR(64),
  task_code VARCHAR(64),
  task_name VARCHAR(512),

  code_stats_source VARCHAR(128),
  code_stats_precision VARCHAR(64),
  upload_status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
  metadata_json JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_coding_turns_employee_time ON ai_coding_turns(employee_id, started_at);
CREATE INDEX idx_ai_coding_turns_demand_time ON ai_coding_turns(demand_id, started_at);
CREATE INDEX idx_ai_coding_turns_tool_time ON ai_coding_turns(tool, started_at);
CREATE INDEX idx_ai_coding_turns_token_status ON ai_coding_turns(token_status);
```

### 9.2 ai_coding_token_events

```sql
CREATE TABLE ai_coding_token_events (
  id BIGSERIAL PRIMARY KEY,
  turn_id VARCHAR(128) NOT NULL,
  source_event_id VARCHAR(180) NOT NULL UNIQUE,
  tool VARCHAR(64) NOT NULL,
  token_source VARCHAR(64) NOT NULL,

  occurred_at TIMESTAMPTZ,
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  cached_tokens BIGINT,
  reasoning_tokens BIGINT,
  tool_tokens BIGINT,

  match_strategy VARCHAR(64),
  confidence VARCHAR(32),
  raw_json JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_coding_token_events_turn_id ON ai_coding_token_events(turn_id);
CREATE INDEX idx_ai_coding_token_events_tool_time ON ai_coding_token_events(tool, occurred_at);
```

## 10. 后端处理逻辑

### 10.1 POST /turns

处理流程：

```text
1. 校验 employeeId、turnId、idempotencyKey、tool、startedAt
2. 查询 idempotencyKey 是否已存在
3. 已存在：返回已有 turn
4. 不存在：写入 ai_coding_turns
5. 保存幂等记录
6. 返回 remoteId
```

### 10.2 PATCH /turns/{turnId}/tokens

处理流程：

```text
1. 校验 turnId 是否存在
2. 校验 sourceEventId 是否已处理
3. 已处理且值一致：返回成功
4. 已处理但值不一致：标记 conflict 或返回 409
5. 写入 ai_coding_token_events
6. 更新 ai_coding_turns token 字段和 token_status
7. 返回成功
```

## 11. 错误码建议

```text
200 成功
400 参数错误
401 未登录或 token 失效
403 无权限访问该 demandId
404 turn 不存在
409 幂等冲突或 token 冲突
500 服务内部错误
```

错误返回：

```json
{
  "code": 400,
  "data": null,
  "msg": "turnId 不能为空"
}
```

## 12. Dashboard 聚合建议

常用统计：

```sql
-- 按需求统计 token 和代码变更
SELECT
  demand_code,
  demand_name,
  COUNT(*) AS turn_count,
  SUM(code_lines_changed) AS code_lines_changed,
  SUM(total_tokens) AS total_tokens
FROM ai_coding_turns
WHERE started_at >= ? AND started_at < ?
GROUP BY demand_code, demand_name;
```

```sql
-- 按人统计
SELECT
  employee_id,
  user_name,
  COUNT(*) AS turn_count,
  SUM(code_lines_changed) AS code_lines_changed,
  SUM(total_tokens) AS total_tokens
FROM ai_coding_turns
WHERE started_at >= ? AND started_at < ?
GROUP BY employee_id, user_name;
```

```sql
-- token 待回填监控
SELECT
  token_status,
  COUNT(*) AS count
FROM ai_coding_turns
GROUP BY token_status;
```

## 13. 和本地 CLI 的映射

本地 `upload_queue.payload_json` 中的数据应直接映射到：

```text
POST /api/ai-codingTurns
```

本地 token sync 回填后，应调用：

```text
PATCH /api/ai-codingTurns/{turnId}/tokens
```

本地上传成功后更新：

```text
turns.remote_id = remoteId
turns.upload_status = uploaded
upload_queue.status = uploaded
```

失败时：

```text
upload_queue.status = failed
upload_queue.retry_count += 1
upload_queue.last_error = 接口错误信息
```

## 14. 当前待后端确认项

```text
1. API 前缀是否使用 /api/ai-coding
2. 认证方式是否使用 Bearer token
3. employeeId 是否从 token 中解析，还是请求体也必须传
4. 主键使用雪花 ID、UUID，还是数据库自增
5. MySQL 还是 PostgreSQL
6. metadata_json 是否允许 JSON 类型
7. projectPath 是否允许上传明文，后续是否需要改为 hash
8. demandId 权限校验是否调用 GPM
9. turn 上传是否需要批量接口
10. token 回填冲突时返回 409 还是标记 conflict
```

