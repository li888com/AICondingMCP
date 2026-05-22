# AI 编码 Reporter 基础 CLI 使用文档

本文档用于说明如何在本机配置并运行 `ai-coding-reporter`，把 AI 编码过程中的代码变更行数、需求绑定、token 消耗上传到后端。

## 1. 工具位置

当前 CLI 脚本位置：

```powershell
D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py
```

后续未做全局安装前，建议通过完整路径执行。本文档后续命令均以当前新目录为准。

## 2. 基础配置

### 2.1 本地后端测试配置

本地 `9906` 服务启动后，使用下面命令配置：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" login --employee-id 00232924 --demand-api-base-url https://gpm-uat.sbtjt.com --report-api-base-url http://127.0.0.1:9906 --turn-api-path /ai-codingTurns
```

配置含义：

```text
demandApiBaseUrl: 需求查询接口地址
reportApiBaseUrl: AI 编码统计上报接口地址
turnApiPath: turn 上传接口路径
employeeId: 当前用户工号
```

### 2.2 线上网关配置

如果要切到 UAT 网关上报，使用：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" login --employee-id 00232924 --demand-api-base-url https://gpm-uat.sbtjt.com --report-api-base-url https://gpm-uat.sbtjt.com --turn-api-path /api/ai-codingTurns
```

需求接口和上报接口是分开的，不会互相冲突：

```text
req / req bind:
https://gpm-uat.sbtjt.com/api/plugins/sbt/consultantSettlement/demand

sync / tokens sync / watch:
http://127.0.0.1:9906/ai-codingTurns
或
https://gpm-uat.sbtjt.com/api/ai-codingTurns
```

## 3. 检查配置

在任意目录执行：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" doctor --api
```

期望看到：

```text
OK stateDir
OK config
OK employeeId
OK database
OK git
OK demandApi
```

如果当前目录不是 Git 仓库，`currentGitRepo` 会提示失败；进入项目目录后再执行即可。

## 4. 绑定需求

进入要统计的 Git 项目目录，例如：

```powershell
cd "D:\GIT\【2026-01-16 PIGX-AI】\pigx-ai"
```

查看可绑定需求：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req
```

按关键字搜索：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req 测试
```

绑定需求，支持三种方式：

```powershell
# 按列表序号绑定
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req bind 1

# 按 demandCode 绑定
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req bind MR20251208000001

# 按 demandId 绑定
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req bind 01495d56-0f64-499f-ad90-85ae25771893
```

清除当前项目需求绑定：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req clear
```

## 5. 推荐模式：自动监听

如果希望启动后不用再手动 `start/end/sync`，使用 `watch`。

### 5.1 Codex 自动监听

```powershell
cd "D:\GIT\【2026-01-16 PIGX-AI】\pigx-ai"

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" watch --tool codex --poll-seconds 10
```

运行后 CLI 会：

```text
1. 记录当前 Git 基线
2. 轮询 Codex 日志
3. 发现新的 response.completed
4. 自动统计本轮代码变更
5. 自动创建 turn
6. 自动写入 token
7. 自动上传后端
8. 更新基线，继续等待下一轮
```

停止监听：

```text
Ctrl+C
```

### 5.2 Claude 自动监听

```powershell
cd "D:\GIT\【2026-01-16 PIGX-AI】\pigx-ai"

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" watch --tool claude --poll-seconds 10
```

### 5.3 测试 watch 是否能启动

只扫描一次后退出：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" watch --tool codex --once
```

注意：`--include-existing` 是测试参数，会处理最近一条已有日志事件，正常使用不要加。

## 6. 手动模式

如果暂时不使用 `watch`，也可以手动记录一轮。

进入项目目录：

```powershell
cd "D:\GIT\【2026-01-16 PIGX-AI】\pigx-ai"
```

开始记录：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" start --tool codex
```

使用 AI 修改代码后，结束记录：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" end --tool codex
```

上传代码行数：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" sync
```

自动扫描日志并回填 token：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" tokens sync
```

如果 token 日志生成较晚，可以扩大延迟窗口：

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" tokens sync --delay-minutes 60
```

## 7. 查看状态

```powershell
python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" status
```

常见字段：

```text
open_turns: 未结束的手动 turn
pending_tokens: 等待 token 回填的 turn
pending_uploads: 等待上传的 turn
selection: 当前项目绑定的需求
```

## 8. 代码统计规则

当前统计规则：

```text
已跟踪文件: git diff --numstat
未跟踪文件: git ls-files --others --exclude-standard
本轮变更: 结束快照 - 开始快照
```

默认会过滤：

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

过滤配置文件：

```text
D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\.ai-coding-reporter\code-stats.ignore
```

规则风格类似 `.gitignore`，后续可以按项目情况补充。

## 9. 本地数据位置

当前本地数据目录：

```text
D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\.ai-coding-reporter
```

包含：

```text
config.json
reporter.db
code-stats.ignore
last-requirements.json
```

说明：当前版本还不是全局安装版，配置和数据库暂时保存在当前 MCP 项目下的 reporter 工具目录中。

## 10. MCP 同步配置关系

当前 `ai-coding-stats-mcp` 的线上同步脚本也会读取 reporter 的配置文件：

```text
D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\.ai-coding-reporter\config.json
```

也就是说，`npm run sync:online` 使用的 `employeeId`、`reportApiBaseUrl`、`turnApiPath`、`accessToken`、`externalSysKey`、`externalSysSecret` 默认和 reporter 保持一致。

MCP 同步配置优先级：

```text
环境变量 > ai-token-vscode-codex-claude-code/.ai-coding-reporter/config.json > .mcp-toolbox/config.json > 默认值
```

MCP 上传本地记录：

```powershell
cd "D:\MCP\ai-coding-stats-mcp"
npm run sync:online -- --retry-failed-now
```

## 11. 一套完整命令示例

本地后端测试：

```powershell
cd "D:\GIT\【2026-01-16 PIGX-AI】\pigx-ai"

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" login --employee-id 00232924 --demand-api-base-url https://gpm-uat.sbtjt.com --report-api-base-url http://127.0.0.1:9906 --turn-api-path /ai-codingTurns

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" doctor --api

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" req bind 1

python "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code\ai-coding-reporter.py" watch --tool codex --poll-seconds 10
```
