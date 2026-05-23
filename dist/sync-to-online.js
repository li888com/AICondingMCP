import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAllStorageData, getStorageInfo, updateRoundRevertSyncState, updateRoundSyncState, updateTokenUsageEventSyncState, } from "./local-storage.js";
const args = parseArgs(process.argv.slice(2));
const dryRun = args.dryRun;
const storageDir = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || ".mcp-toolbox");
const reporterConfigPath = resolve("ai-token-vscode-codex-claude-code", ".ai-coding-reporter", "config.json");
const mcpConfigPath = resolve(storageDir, "config.json");
const configPaths = process.env.AI_CODING_SYNC_CONFIG_FILE?.trim()
    ? [resolve(process.env.AI_CODING_SYNC_CONFIG_FILE.trim())]
    : [reporterConfigPath, mcpConfigPath];
const config = await loadMergedConfig(configPaths);
const baseUrl = configValue(process.env.AI_CODING_REPORT_API_BASE_URL, process.env.SYNC_API_BASE_URL, config.reportApiBaseUrl, config.apiBaseUrl, "http://127.0.0.1:9906").replace(/\/+$/, "");
const turnApiPath = normalizePath(configValue(process.env.AI_CODING_TURN_API_PATH, process.env.SYNC_TURN_API_PATH, config.turnApiPath, "/ai-codingTurns"));
const token = optionalConfigValue(process.env.SYNC_API_TOKEN, process.env.AI_CODING_ACCESS_TOKEN, config.token, config.accessToken);
const externalSysKey = optionalConfigValue(process.env.AI_CODING_EXTERNAL_SYS_KEY, config.externalSysKey);
const externalSysSecret = optionalConfigValue(process.env.AI_CODING_EXTERNAL_SYS_SECRET, config.externalSysSecret);
const employeeId = configValue(process.env.AI_CODING_EMPLOYEE_ID, config.employeeId, "");
const userName = configValue(process.env.AI_CODING_USER_NAME, config.userName, "");
const teamId = configValue(process.env.AI_CODING_TEAM_ID, config.teamId, "");
async function main() {
    const data = await loadData();
    const report = {
        rounds: 0,
        roundReverts: 0,
        tokenUsageEvents: 0,
        retryDeferred: 0,
        skipped: 0,
        failed: 0,
        processed: 0,
        failures: [],
    };
    await syncRounds(data, report);
    await syncRoundReverts(data, report);
    await syncTokenUsageEvents(data, report);
    printReport(report);
}
async function loadData() {
    return getAllStorageData();
}
async function syncRounds(data, report) {
    const requirementsById = new Map((data.requirements || []).map((item) => [item.requirementId, item]));
    for (const round of data.rounds || []) {
        if (args.roundId !== null && round.id !== args.roundId)
            continue;
        if (!shouldUpload(round, report))
            continue;
        if (isLimitReached(report))
            break;
        const requirement = round.requirementId === null ? undefined : requirementsById.get(round.requirementId);
        const hasDemandBinding = typeof round.metadata?.demandId === "string" && round.metadata.demandId.trim().length > 0;
        await uploadItem(round, report, "rounds", "round", turnApiPath, async () => {
            const turnId = buildTurnId(round);
            const idempotencyKey = `local-turn-${turnId}`;
            const response = await request(turnApiPath, "POST", {
                idempotencyKey,
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
                bindingLevel: hasDemandBinding ? "demand" : (round.requirementId === null ? "none" : "demand"),
                demandId: round.metadata?.demandId ?? null,
                demandCode: round.metadata?.demandCode ?? (round.requirementId === null ? null : String(round.requirementId)),
                demandName: round.metadata?.demandName ?? requirement?.title ?? null,
                phaseName: round.metadata?.phaseName ?? null,
                projectCode: round.metadata?.projectCode ?? null,
                projectNameBound: round.metadata?.projectName ?? requirement?.projectName ?? null,
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
            }, idempotencyKey);
            return parseOnlineId(response?.remoteId ?? response?.id ?? turnId, "turn response id");
        });
    }
}
async function syncRoundReverts(data, report) {
    for (const revert of data.roundReverts || []) {
        if (args.roundId !== null && revert.targetRoundId !== args.roundId)
            continue;
        if (!shouldUpload(revert, report))
            continue;
        if (isLimitReached(report))
            break;
        markSkipped(revert, "ai-codingTurns API does not define a revert endpoint.");
        await persistSyncState("roundRevert", revert.id, revert._sync);
        report.roundReverts += 1;
        report.skipped += 1;
        report.processed += 1;
    }
}
async function syncTokenUsageEvents(data, report) {
    for (const event of data.tokenUsageEvents || []) {
        if (args.roundId !== null && event.roundId !== args.roundId)
            continue;
        if (!shouldUpload(event, report))
            continue;
        if (isLimitReached(report))
            break;
        const localRound = event.roundId === null
            ? null
            : (data.rounds || []).find((round) => round.id === event.roundId) ?? null;
        if (event.roundId !== null && !localRound) {
            markFailed(event, `Missing local round ${event.roundId}`);
            await persistSyncState("tokenUsageEvent", event.id, event._sync);
            collectFailure(report, "tokenUsageEvent", event.id, "(local validation)", event._sync);
            report.failed += 1;
            report.processed += 1;
            continue;
        }
        await uploadItem(event, report, "tokenUsageEvents", "tokenUsageEvent", `${turnApiPath}/${encodeURIComponent(buildTokenEventTurnId(event, localRound))}/tokens`, async () => {
            const sourceEventId = event.sourceEventId ?? `local-token-event-${event.id}`;
            return request(`${turnApiPath}/${encodeURIComponent(buildTokenEventTurnId(event, localRound))}/tokens`, "PATCH", {
                sourceEventId,
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
            }, `token-event-${sourceEventId}`);
        });
    }
}
async function uploadItem(item, report, key, entityType, endpoint, upload) {
    try {
        if (dryRun) {
            report[key] += 1;
            report.processed += 1;
            return;
        }
        const result = await upload();
        markSynced(item, typeof result === "string" || typeof result === "number" ? result : undefined);
        await persistSyncState(entityType, item.id, item._sync);
        report[key] += 1;
        report.processed += 1;
    }
    catch (error) {
        if (entityType === "tokenUsageEvent" && isMissingOnlineTurnError(error)) {
            markSkipped(item, `Online turn does not exist for token backfill: ${error instanceof Error ? error.message : String(error)}`);
            await persistSyncState(entityType, item.id, item._sync);
            report[key] += 1;
            report.skipped += 1;
            report.processed += 1;
            return;
        }
        markFailed(item, error instanceof Error ? error.message : String(error));
        const syncState = item._sync;
        if (syncState && isHttpError(error)) {
            syncState.error = error.message;
        }
        await persistSyncState(entityType, item.id, syncState);
        collectFailure(report, entityType, item.id, endpoint, syncState, error);
        report.failed += 1;
        report.processed += 1;
    }
}
async function persistSyncState(entityType, entityId, syncState) {
    if (dryRun || !syncState)
        return;
    if (entityType === "round") {
        await updateRoundSyncState(entityId, syncState);
    }
    else if (entityType === "roundRevert") {
        await updateRoundRevertSyncState(entityId, syncState);
    }
    else {
        await updateTokenUsageEventSyncState(entityId, syncState);
    }
}
async function request(path, method, body, idempotencyKey) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(externalSysKey ? { sys_key: externalSysKey } : {}),
            ...(externalSysSecret ? { sys_secret: externalSysSecret } : {}),
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
        throw new HttpRequestError(`HTTP ${response.status}: ${parsed.msg || text || response.statusText}`, response.status, text);
    }
    if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 200) {
        throw new Error(parsed.msg || `API returned code ${parsed.code}`);
    }
    return parsed.data;
}
function shouldUpload(item, report) {
    if (item._sync?.status === "synced" || item._sync?.status === "skipped")
        return false;
    if (args.retryFailedNow)
        return true;
    if (item._sync?.status !== "failed")
        return true;
    if (!item._sync.nextRetryAt)
        return true;
    const ready = new Date(item._sync.nextRetryAt).getTime() <= Date.now();
    if (!ready && report) {
        report.retryDeferred += 1;
    }
    return ready;
}
function markSynced(item, onlineId) {
    item._sync = {
        status: "synced",
        ...(onlineId !== undefined ? { onlineId } : {}),
        syncedAt: new Date().toISOString(),
    };
}
function markSkipped(item, reason) {
    item._sync = { status: "skipped", error: reason };
}
function markFailed(item, error) {
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
function normalizePath(path) {
    const trimmed = path.trim();
    if (!trimmed)
        return "/ai-codingTurns";
    return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}
async function loadMergedConfig(paths) {
    const configs = await Promise.all(paths.map((path) => loadConfig(path)));
    return configs.reduceRight((merged, item) => ({ ...merged, ...item }), {});
}
async function loadConfig(path) {
    try {
        const content = await readFile(path, "utf8");
        const parsed = JSON.parse(content);
        return isRecord(parsed) ? parsed : {};
    }
    catch (error) {
        const code = error instanceof Error ? error.code : undefined;
        if (code === "ENOENT") {
            return {};
        }
        throw error;
    }
}
function configValue(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}
function optionalConfigValue(...values) {
    const value = configValue(...values);
    return value || undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function buildTurnId(round) {
    const metadataTurnId = round.metadata?.turnId;
    if (typeof metadataTurnId === "string" && metadataTurnId.trim()) {
        return metadataTurnId.trim();
    }
    return `codex-mcp-round-${round.id}`;
}
function buildTokenEventTurnId(event, round) {
    if (round) {
        return buildTurnId(round);
    }
    if (event.turnId?.trim()) {
        return event.turnId.trim();
    }
    return `codex-mcp-dialogue-token-${event.id}`;
}
function mapTokenStatus(status) {
    if (status === "synced")
        return "completed";
    if (status === "ambiguous")
        return "needs_review";
    if (status === "failed")
        return "failed";
    return "pending";
}
function compactCodeStatsSource(value) {
    const text = String(value ?? "git diff");
    if (text.includes("baseline"))
        return "baseline";
    if (text.includes("manual"))
        return "manual";
    if (text.includes("git diff"))
        return "git diff";
    if (text.includes("snapshot"))
        return "snapshot";
    return text.slice(0, 32) || "unknown";
}
function parseOnlineId(value, label) {
    if (typeof value === "number" && Number.isFinite(value))
        return String(Math.trunc(value));
    if (typeof value === "string" && value.trim())
        return value;
    throw new Error(`Missing or invalid ${label}.`);
}
function numberValue(value) {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
}
function isLimitReached(report) {
    return report.processed >= args.limit;
}
function printReport(report) {
    console.log(`Sync ${dryRun ? "dry run" : "completed"} for ${getStorageInfo().sqlitePath}`);
    console.log(`API base: ${baseUrl}`);
    console.log(`turnApiPath: ${turnApiPath}`);
    console.log(`limit: ${args.limit}`);
    console.log(`roundId: ${args.roundId ?? "all"}`);
    console.log(`processed: ${report.processed}`);
    console.log(`rounds: ${report.rounds}`);
    console.log(`roundReverts: ${report.roundReverts}`);
    console.log(`tokenUsageEvents: ${report.tokenUsageEvents}`);
    console.log(`retryDeferred: ${report.retryDeferred}`);
    console.log(`skipped: ${report.skipped}`);
    console.log(`failed: ${report.failed}`);
    if (args.verbose && report.failures.length > 0) {
        console.log("failures:");
        for (const failure of report.failures) {
            console.log(JSON.stringify(failure));
        }
    }
}
function collectFailure(report, entityType, entityId, endpoint, syncState, error) {
    if (!args.verbose)
        return;
    report.failures.push({
        entityType,
        entityId,
        endpoint: `${baseUrl}${endpoint}`,
        error: syncState?.error ?? (error instanceof Error ? error.message : String(error ?? "unknown")),
        ...(isHttpError(error) ? { status: error.status, body: error.body.slice(0, 2000) } : {}),
        failedAttempts: syncState?.failedAttempts,
        nextRetryAt: syncState?.nextRetryAt,
    });
}
class HttpRequestError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
function isHttpError(error) {
    return error instanceof HttpRequestError;
}
function isMissingOnlineTurnError(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("turn does not exist") || (isHttpError(error) && error.status === 404);
}
function parseArgs(argv) {
    const parsed = {
        dryRun: false,
        limit: readNumberEnv("ONLINE_SYNC_LIMIT", 200),
        retryFailedNow: false,
        roundId: null,
        verbose: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === "--dry-run") {
            parsed.dryRun = true;
        }
        else if (arg === "--verbose") {
            parsed.verbose = true;
        }
        else if (arg === "--retry-failed-now") {
            parsed.retryFailedNow = true;
        }
        else if (arg === "--limit" && next) {
            parsed.limit = Number(next);
            index += 1;
        }
        else if (arg === "--round-id" && next) {
            const roundId = Number(next);
            if (!Number.isSafeInteger(roundId) || roundId <= 0) {
                throw new Error("--round-id must be a positive integer");
            }
            parsed.roundId = roundId;
            index += 1;
        }
    }
    if (!Number.isSafeInteger(parsed.limit) || parsed.limit <= 0) {
        throw new Error("--limit must be a positive integer");
    }
    return parsed;
}
function readNumberEnv(name, fallback) {
    const value = process.env[name];
    if (!value)
        return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
