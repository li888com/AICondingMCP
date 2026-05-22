#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closePool } from "./database.js";
import { registerAiCodingStatsTools } from "./tools/ai-coding-stats.js";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const idleTimeoutMs = readIdleTimeoutMs();
let idleTimer: NodeJS.Timeout | null = null;
let activeRequests = 0;
let shuttingDown = false;

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
  await closePool();
  process.exit(exitCode);
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
