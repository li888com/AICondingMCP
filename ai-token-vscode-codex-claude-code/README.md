# AI Coding Reporter MVP

当前目录已经包含第一版可运行 CLI：

```bash
python ai-coding-reporter.py --help
```

## 已实现

```text
1. login 工号配置
2. doctor 本地检查和 GPM 需求接口检查
3. req 查询 / 搜索 / 绑定 / 清除项目需求
4. start / end 记录单轮代码变更
5. 代码统计支持 tracked + untracked 文件
6. 基础过滤 code-stats.ignore
7. probe codex / claude
8. tokens sync 基础回填
9. status
10. sync --dry-run 队列查看
```

## 快速使用

登录：

```bash
python ai-coding-reporter.py login --employee-id 00232924
```

检查：

```bash
python ai-coding-reporter.py doctor --api
```

查看需求：

```bash
python ai-coding-reporter.py req
```

搜索需求：

```bash
python ai-coding-reporter.py req 需求规划
```

绑定需求：

```bash
python ai-coding-reporter.py req bind 1
python ai-coding-reporter.py req bind MR20251029000001
python ai-coding-reporter.py req bind 0e81d4a6-0b2a-4864-bcaf-62a5d214be09
```

清除绑定：

```bash
python ai-coding-reporter.py req clear
```

在 Git 项目中记录一轮：

```bash
python C:\Users\00232924\Documents\Codex\2026-05-21\ai-token-vscode-codex-claude-code\ai-coding-reporter.py start --tool codex
# 使用 AI 修改代码
python C:\Users\00232924\Documents\Codex\2026-05-21\ai-token-vscode-codex-claude-code\ai-coding-reporter.py end --tool codex
```

回填 token：

```bash
python ai-coding-reporter.py tokens sync
```

查看状态：

```bash
python ai-coding-reporter.py status
python ai-coding-reporter.py sync --dry-run
```

## 当前未实现

```text
1. 线上 AI turn 上传接口，因为接口字段还未最终确定
2. daemon 常驻
3. VSCode 插件
4. stop 真正停止 worker，目前只是占位
5. task 级绑定，目前只绑定 demand
```

## 本地数据

本地数据目录：

```text
.ai-coding-reporter/
```

包含：

```text
config.json
reporter.db
code-stats.ignore
last-requirements.json
```
