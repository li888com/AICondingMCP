import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type SyncStatus = "pending" | "synced" | "skipped" | "failed";

type SyncState = {
  status: SyncStatus;
  onlineId?: number | string;
  syncedAt?: string;
  error?: string;
  failedAttempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
};

type Requirement = {
  requirementId: number;
  title: string | null;
  projectName: string | null;
  gpmNumber: string | null;
};

type Round = {
  id: number;
  conversationId: string;
  requirementId: number | null;
  requirementSource: "prompt" | "context" | "empty";
  modelName: string;
  startedAt: string;
  endedAt: string;
  promptText: string | null;
  filesChanged: number | null;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: string;
  tokenMatchQuality?: string | null;
  tokenSyncedAt: string | null;
  tokenSyncStatus: string;
  tokenSyncNote: string | null;
  metadata: Record<string, unknown> | null;
  _sync?: SyncState;
};

type RoundRevert = {
  id: number;
  targetRoundId: number;
  conversationId: string;
  modelName: string;
  promptText: string | null;
  revertedAt: string;
  _sync?: SyncState;
};

type TokenUsageEvent = {
  id: number;
  roundId: number | null;
  client: "codex" | "claude-code";
  sourcePath: string;
  sourceEventId: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  modelName?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  matchQuality?: string | null;
  rawEvent: Record<string, unknown> | null;
  _sync?: SyncState;
};

type StorageData = {
  requirements?: Requirement[];
  rounds?: Round[];
  roundReverts?: RoundRevert[];
  tokenUsageEvents?: TokenUsageEvent[];
  [key: string]: unknown;
};

type ApiResponse<T> = {
  code?: number;
  msg?: string | null;
  data?: T;
};

type SyncReport = {
  rounds: number;
  roundReverts: number;
  tokenUsageEvents: number;
  retryDeferred: number;
  skipped: number;
  failed: number;
  processed: number;
};

type SyncConfig = {
  apiBaseUrl?: string;
  reportApiBaseUrl?: string;
  turnApiPath?: string;
  token?: string;
  accessToken?: string;
  externalSysKey?: string;
  externalSysSecret?: string;
  employeeId?: string;
  userName?: string;
  teamId?: string;
};

const args = parseArgs(process.argv.slice(2));
const dryRun = args.dryRun;
const storageDir = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || ".mcp-toolbox");
const storagePath = resolve(
  process.env.MCP_TOOLBOX_STORAGE_FILE?.trim() ||
    resolve(storageDir, "data.json")
);
const reporterConfigPath = resolve("ai-token-vscode-codex-claude-code", ".ai-coding-reporter", "config.json");
const mcpConfigPath = resolve(storageDir, "config.json");
const configPaths = process.env.AI_CODING_SYNC_CONFIG_FILE?.trim()
  ? [resolve(process.env.AI_CODING_SYNC_CONFIG_FILE.trim())]
  : [reporterConfigPath, mcpConfigPath];
const config = await loadMergedConfig(configPaths);
const baseUrl = configValue(
  process.env.AI_CODING_REPORT_API_BASE_URL,
  process.env.SYNC_API_BASE_URL,
  config.reportApiBaseUrl,
  config.apiBaseUrl,
  "http://127.0.0.1:9906"
).replace(/\/+$/, "");
const turnApiPath = normalizePath(configValue(process.env.AI_CODING_TURN_API_PATH, process.env.SYNC_TURN_API_PATH, config.turnApiPath, "/ai-codingTurns"));
const token = optionalConfigValue(process.env.SYNC_API_TOKEN, process.env.AI_CODING_ACCESS_TOKEN, config.token, config.accessToken);
const externalSysKey = optionalConfigValue(process.env.AI_CODING_EXTERNAL_SYS_KEY, config.externalSysKey);
const externalSysSecret = optionalConfigValue(process.env.AI_CODING_EXTERNAL_SYS_SECRET, config.externalSysSecret);
const employeeId = configValue(process.env.AI_CODING_EMPLOYEE_ID, config.employeeId, "");
const userName = configValue(process.env.AI_CODING_USER_NAME, config.userName, "");
const teamId = configValue(process.env.AI_CODING_TEAM_ID, config.teamId, "");

async function main(): Promise<void> {
  const data = await loadData();
  const report: SyncReport = {
    rounds: 0,
    roundReverts: 0,
    tokenUsageEvents: 0,
    retryDeferred: 0,
    skipped: 0,
    failed: 0,
    processed: 0,
  };

  await syncRounds(data, report);
  await syncRoundReverts(data, report);
  await syncTokenUsageEvents(data, report);

  if (!dryRun) {
    await saveData(data);
  }

  printReport(report);
}

async function loadData(): Promise<StorageData> {
  return JSON.parse(await readFile(storagePath, "utf8")) as StorageData;
}

async function saveData(data: StorageData): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  const tempPath = `${storagePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tempPath, storagePath);
}

async function syncRounds(data: StorageData, report: SyncReport): Promise<void> {
  const requirementsById = new Map((data.requirements || []).map((item) => [item.requirementId, item]));

  for (const round of data.rounds || []) {
    if (!shouldUpload(round, report)) continue;
    if (isLimitReached(report)) break;

    const requirement = round.requirementId === null ? undefined : requirementsById.get(round.requirementId);
    await uploadItem(round, report, "rounds", async () => {
      const turnId = buildTurnId(round);
      const response = await request<{ id?: number | string; remoteId?: number | string }>(turnApiPath, "POST", {
        idempotencyKey: `local-turn-${turnId}`,
        turnId,
        conversationId: round.conversationId,
        employeeId: String(round.metadata?.employeeId ?? employeeId),
        userName: String(round.metadata?.userName ?? userName),
        teamId: String(round.metadata?.teamId ?? teamId),
        tool: String(round.metadata?.client ?? "codex"),
        modelName: round.modelName,
        projectPath: String(round.metadata?.projectPath ?? ""),
        projectName: String(requirement?.projectName ?? round.metadata?.projectName ?? ""),
        gitBranch: String(round.metadata?.gitBranch ?? ""),
        commitBefore: round.metadata?.commitBefore ?? null,
        commitAfter: round.metadata?.commitAfter ?? null,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        filesChanged: round.filesChanged ?? 0,
        linesAdded: round.linesAdded,
        linesDeleted: round.linesDeleted,
        codeLinesChanged: round.codeLinesChanged,
        tokenStatus: mapTokenStatus(round.tokenSyncStatus),
        tokenSource: round.tokenSource === "unavailable" ? null : round.tokenSource,
        inputTokens: round.totalTokens > 0 ? round.inputTokens : null,
        outputTokens: round.totalTokens > 0 ? round.outputTokens : null,
        totalTokens: round.totalTokens > 0 ? round.totalTokens : null,
        bindingLevel: round.requirementId === null ? "none" : "demand",
        demandId: round.metadata?.demandId ?? null,
        demandCode: round.metadata?.demandCode ?? (round.requirementId === null ? null : String(round.requirementId)),
        demandName: requirement?.title ?? null,
        phaseName: round.metadata?.phaseName ?? null,
        projectCode: round.metadata?.projectCode ?? null,
        projectNameBound: requirement?.projectName ?? null,
        taskId: round.metadata?.taskId ?? null,
        taskCode: round.metadata?.taskCode ?? null,
        taskName: round.metadata?.taskName ?? null,
        codeStatsSource: compactCodeStatsSource(round.metadata?.codeStatsSource),
        codeStatsPrecision: String(round.metadata?.codeStatsPrecision ?? "best-effort"),
        metadata: {
          ...(round.metadata || {}),
          localRoundId: round.id,
          promptText: round.promptText,
          requirementId: round.requirementId,
          requirementSource: round.requirementSource,
          tokenMatchQuality: round.tokenMatchQuality ?? null,
          tokenSyncedAt: round.tokenSyncedAt,
          tokenSyncNote: round.tokenSyncNote,
        },
      });
      return parseOnlineId(response?.remoteId ?? response?.id ?? turnId, "turn response id");
    });

    await saveCheckpoint(data);
  }
}

async function syncRoundReverts(data: StorageData, report: SyncReport): Promise<void> {
  for (const revert of data.roundReverts || []) {
    if (!shouldUpload(revert, report)) continue;
    if (isLimitReached(report)) break;

    markSkipped(revert, "ai-codingTurns API does not define a revert endpoint.");
    report.roundReverts += 1;
    report.skipped += 1;
    report.processed += 1;
    await saveCheckpoint(data);
  }
}

async function syncTokenUsageEvents(data: StorageData, report: SyncReport): Promise<void> {
  for (const event of data.tokenUsageEvents || []) {
    if (!shouldUpload(event, report)) continue;
    if (isLimitReached(report)) break;

    const localRound = event.roundId === null
      ? null
      : (data.rounds || []).find((round) => round.id === event.roundId) ?? null;
    if (event.roundId !== null && !localRound) {
      markFailed(event, `Missing local round ${event.roundId}`);
      report.failed += 1;
      report.processed += 1;
      await saveCheckpoint(data);
      continue;
    }

    await uploadItem(event, report, "tokenUsageEvents", async () =>
      request<boolean>(`${turnApiPath}/${encodeURIComponent(buildTokenEventTurnId(event, localRound))}/tokens`, "PATCH", {
        sourceEventId: event.sourceEventId ?? `local-token-event-${event.id}`,
        tokenStatus: event.matchQuality === "ambiguous" ? "needs_review" : "completed",
        tokenSource: event.sourcePath.startsWith("mcp:") ? "mcp_payload" : "tool_log",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        cachedTokens: numberValue(event.rawEvent?.cachedTokens),
        reasoningTokens: numberValue(event.rawEvent?.reasoningTokens),
        toolTokens: event.totalTokens,
        occurredAt: event.endedAt ?? event.startedAt ?? new Date().toISOString(),
        metadata: {
          tool: event.client,
          conversationId: event.conversationId ?? localRound?.conversationId ?? null,
          modelName: event.modelName ?? localRound?.modelName ?? null,
          needsProjectBinding: event.roundId === null,
          projectBindingWarning: event.roundId === null ? "No roundId was provided. Please bind this dialogue to a project/AI Coding round." : null,
          sourcePath: event.sourcePath,
          localTokenUsageEventId: event.id,
          localRoundId: event.roundId,
          matchStrategy: "mcp-token-sync",
          confidence: event.matchQuality ?? null,
          rawEvent: event.rawEvent,
        },
      })
    );
    await saveCheckpoint(data);
  }
}

async function uploadItem<T extends { _sync?: SyncState }>(
  item: T,
  report: SyncReport,
  key: "rounds" | "roundReverts" | "tokenUsageEvents",
  upload: () => Promise<unknown>
): Promise<void> {
  try {
    if (dryRun) {
      report[key] += 1;
      report.processed += 1;
      return;
    }

    const result = await upload();
    markSynced(item, typeof result === "string" || typeof result === "number" ? result : undefined);
    report[key] += 1;
    report.processed += 1;
  } catch (error) {
    markFailed(item, error instanceof Error ? error.message : String(error));
    report.failed += 1;
    report.processed += 1;
  }
}

async function request<T>(path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(externalSysKey ? { sys_key: externalSysKey } : {}),
      ...(externalSysSecret ? { sys_secret: externalSysSecret } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as ApiResponse<T>) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${parsed.msg || text || response.statusText}`);
  }
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 200) {
    throw new Error(parsed.msg || `API returned code ${parsed.code}`);
  }

  return parsed.data as T;
}

function shouldUpload(item: { _sync?: SyncState }, report?: SyncReport): boolean {
  if (item._sync?.status === "synced" || item._sync?.status === "skipped") return false;
  if (args.retryFailedNow) return true;
  if (item._sync?.status !== "failed") return true;
  if (!item._sync.nextRetryAt) return true;
  const ready = new Date(item._sync.nextRetryAt).getTime() <= Date.now();
  if (!ready && report) {
    report.retryDeferred += 1;
  }
  return ready;
}

function markSynced(item: { _sync?: SyncState }, onlineId?: number | string): void {
  item._sync = {
    status: "synced",
    ...(onlineId !== undefined ? { onlineId } : {}),
    syncedAt: new Date().toISOString(),
  };
}

function markSkipped(item: { _sync?: SyncState }, reason: string): void {
  item._sync = { status: "skipped", error: reason };
}

function markFailed(item: { _sync?: SyncState }, error: string): void {
  const now = new Date();
  const failedAttempts = (item._sync?.failedAttempts ?? 0) + 1;
  const delayMinutes = Math.min(60, 5 * 2 ** Math.max(failedAttempts - 1, 0));
  item._sync = {
    ...item._sync,
    status: "failed",
    error,
    failedAttempts,
    lastAttemptAt: now.toISOString(),
    nextRetryAt: new Date(now.getTime() + delayMinutes * 60 * 1000).toISOString(),
  };
}

async function saveCheckpoint(data: StorageData): Promise<void> {
  if (!dryRun) {
    await saveData(data);
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/ai-codingTurns";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

async function loadMergedConfig(paths: string[]): Promise<SyncConfig> {
  const configs = await Promise.all(paths.map((path) => loadConfig(path)));
  return configs.reduceRight((merged, item) => ({ ...merged, ...item }), {});
}

async function loadConfig(path: string): Promise<SyncConfig> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function configValue(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function optionalConfigValue(...values: Array<unknown>): string | undefined {
  const value = configValue(...values);
  return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildTurnId(round: Round): string {
  const metadataTurnId = round.metadata?.turnId;
  if (typeof metadataTurnId === "string" && metadataTurnId.trim()) {
    return metadataTurnId.trim();
  }
  return `codex-mcp-round-${round.id}`;
}

function buildTokenEventTurnId(event: TokenUsageEvent, round: Round | null): string {
  if (round) {
    return buildTurnId(round);
  }
  if (event.turnId?.trim()) {
    return event.turnId.trim();
  }
  return `codex-mcp-dialogue-token-${event.id}`;
}

function mapTokenStatus(status: string): string {
  if (status === "synced") return "completed";
  if (status === "ambiguous") return "needs_review";
  if (status === "failed") return "failed";
  return "pending";
}

function compactCodeStatsSource(value: unknown): string {
  const text = String(value ?? "git diff");
  if (text.includes("baseline")) return "baseline";
  if (text.includes("manual")) return "manual";
  if (text.includes("git diff")) return "git diff";
  if (text.includes("snapshot")) return "snapshot";
  return text.slice(0, 32) || "unknown";
}

function parseOnlineId(value: number | string | undefined, label: string): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Missing or invalid ${label}.`);
}

function numberValue(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isLimitReached(report: SyncReport): boolean {
  return report.processed >= args.limit;
}

function printReport(report: SyncReport): void {
  console.log(`Sync ${dryRun ? "dry run" : "completed"} for ${storagePath}`);
  console.log(`API base: ${baseUrl}`);
  console.log(`turnApiPath: ${turnApiPath}`);
  console.log(`limit: ${args.limit}`);
  console.log(`processed: ${report.processed}`);
  console.log(`rounds: ${report.rounds}`);
  console.log(`roundReverts: ${report.roundReverts}`);
  console.log(`tokenUsageEvents: ${report.tokenUsageEvents}`);
  console.log(`retryDeferred: ${report.retryDeferred}`);
  console.log(`skipped: ${report.skipped}`);
  console.log(`failed: ${report.failed}`);
}

function parseArgs(argv: string[]): { dryRun: boolean; limit: number; retryFailedNow: boolean } {
  const parsed = {
    dryRun: false,
    limit: readNumberEnv("ONLINE_SYNC_LIMIT", 200),
    retryFailedNow: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--retry-failed-now") {
      parsed.retryFailedNow = true;
    } else if (arg === "--limit" && next) {
      parsed.limit = Number(next);
      index += 1;
    }
  }

  if (!Number.isSafeInteger(parsed.limit) || parsed.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  return parsed;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
