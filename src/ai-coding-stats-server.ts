#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { closePool } from "./database.js";
import { registerAiCodingStatsTools } from "./tools/ai-coding-stats.js";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const idleTimeoutMs = readIdleTimeoutMs();
let idleTimer: NodeJS.Timeout | null = null;
let activeRequests = 0;
let shuttingDown = false;
let autoRunner: ChildProcess | null = null;

const server = new McpServer({
  name: "ai-coding-stats-mcp",
  version: "0.1.0"
});

registerAiCodingStatsTools(server, {
  beforeRequest: markRequestStarted,
  afterRequest: markRequestFinished,
});

const transport = new StdioServerTransport();

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

await server.connect(transport);
startAutoRunner();
scheduleIdleShutdown();

function markRequestStarted(): void {
  activeRequests += 1;
  clearIdleTimer();
}

function markRequestFinished(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  scheduleIdleShutdown();
}

function scheduleIdleShutdown(): void {
  clearIdleTimer();

  if (idleTimeoutMs <= 0 || activeRequests > 0) {
    return;
  }

  idleTimer = setTimeout(() => {
    void shutdown(0);
  }, idleTimeoutMs);
  idleTimer.unref();
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearIdleTimer();
  stopAutoRunner();
  await closePool();
  process.exit(exitCode);
}

function startAutoRunner(): void {
  if (process.env.AI_CODING_MCP_AUTO_RUNNER === "0") {
    return;
  }

  const scriptPath = resolve("dist", "auto-runner.js");
  const projectPath = process.env.AI_CODING_PROJECT_PATH || process.cwd();
  const conversationId = process.env.AI_CODING_CONVERSATION_ID || `codex:${resolve(projectPath).replaceAll("\\", "/")}`;
  const settleMs = process.env.AI_CODING_AUTO_SETTLE_MS || "30000";

  autoRunner = spawn(process.execPath, [
    scriptPath,
    "--project-path",
    projectPath,
    "--conversation-id",
    conversationId,
    "--settle-ms",
    settleMs,
  ], {
    cwd: process.cwd(),
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      AI_CODING_AUTO_SYNC_ONLINE: process.env.AI_CODING_AUTO_SYNC_ONLINE ?? "1",
    },
    windowsHide: true,
  });

  autoRunner.on("exit", () => {
    autoRunner = null;
  });
}

function stopAutoRunner(): void {
  if (!autoRunner?.pid) {
    return;
  }

  try {
    autoRunner.kill();
  } catch {
    // The worker may already have exited.
  }
  autoRunner = null;
}

function readIdleTimeoutMs(): number {
  const value = process.env.AI_CODING_MCP_IDLE_TIMEOUT_MS?.trim();
  if (!value) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }

  return Math.trunc(parsed);
}
