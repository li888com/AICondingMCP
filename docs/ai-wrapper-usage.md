# AI Wrapper Usage

`ai-codex.cmd` and `ai-claude.cmd` wrap one AI client process with:

1. `ai-coding-stats turn begin`
2. launch the real client command
3. `ai-coding-stats turn end`

Current scope:

- This is **session-window orchestration**
- One wrapper process equals one tracked turn window
- It is useful immediately for forcing the stats MCP path to run at session start/end

Current limitation:

- It does **not** yet hook every message inside a long-lived interactive client process
- For true per-message begin/end, the host must expose message-level hooks and call `turn begin` / `turn end` around each message

Windows examples:

```powershell
cd "D:\MCP\ai-coding-stats-mcp\ai-token-vscode-codex-claude-code"
.\ai-codex.cmd
.\ai-claude.cmd
```

Optional environment variables:

```powershell
$env:AI_CODEX_REAL_CMD = "C:\path\to\codex.exe"
$env:AI_CLAUDE_REAL_CMD = "C:\path\to\claude.exe"
$env:AI_CODING_STATS_CLI_CMD = "node D:\MCP\ai-coding-stats-mcp\dist\cli.js"
$env:AI_CODING_WRAPPER_MODEL_NAME = "gpt-5"
```
