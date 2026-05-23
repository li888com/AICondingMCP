import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createTokenUsageEvent, createAiCodingCorrection, getTokenUsageCandidate, getRounds, getTokenUsageEvents, patchAutoSyncState, replaceTokenUsageCandidates, updateRound, updateTokenUsageCandidate, updateTokenUsageEvent, } from "./local-storage.js";
const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
async function main() {
    await patchAutoSyncState({
        currentStep: "tokens:backfill",
        currentStatus: "running",
        lastTokenSyncAt: new Date().toISOString(),
        lastTokenSyncStartedAt: new Date().toISOString(),
        lastTokenSyncStatus: "running",
    });
    try {
        const rounds = (await getRounds()).filter(shouldBackfillRound);
        const existingEvents = await getTokenUsageEvents();
        const existingSourceEventIds = new Set(existingEvents.map((event) => event.sourceEventId).filter((value) => Boolean(value)));
        const exportedEvents = await readExportedEvents(args.client);
        let matched = 0;
        let matchedDialogueEvents = 0;
        let scanned = 0;
        for (const round of rounds) {
            scanned += 1;
            const event = pickBestEvent(round, exportedEvents, existingSourceEventIds);
            const candidates = findCandidateEvents(round, exportedEvents, existingSourceEventIds);
            await persistCandidates(round, candidates);
            if (!event) {
                await recordUnmatchedScan(round);
                continue;
            }
            const totalTokens = event.totalTokens || event.inputTokens + event.outputTokens;
            const matchQuality = event.turnId && event.turnId === metadataString(round, "turnId")
                ? "turn_id"
                : "time_window";
            await createTokenUsageEvent({
                roundId: round.id,
                client: event.client,
                sourcePath: event.sourcePath,
                sourceEventId: event.sourceEventId,
                conversationId: event.conversationId ?? round.conversationId,
                turnId: event.turnId,
                modelName: event.modelName ?? round.modelName,
                startedAt: round.startedAt,
                endedAt: event.endedAt ?? round.endedAt,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalTokens,
                matchQuality,
                rawEvent: {
                    ...(event.raw ?? {}),
                    cachedTokens: event.cachedTokens ?? null,
                    reasoningTokens: event.reasoningTokens ?? null,
                    toolTokens: event.toolTokens ?? null,
                    matchedRoundId: round.id,
                    matchedRoundEndedAt: round.endedAt,
                    tokenStatsSource: "tool_log",
                },
            });
            round.inputTokens = event.inputTokens;
            round.outputTokens = event.outputTokens;
            round.totalTokens = totalTokens;
            round.tokenSource = "tool_log";
            round.tokenMatchQuality = matchQuality;
            round.tokenSyncedAt = new Date().toISOString();
            round.tokenSyncStatus = "synced";
            round.tokenSyncNote = null;
            await updateRound(round);
            if (event.sourceEventId) {
                existingSourceEventIds.add(event.sourceEventId);
            }
            matched += 1;
        }
        const dialogueEvents = existingEvents.filter(shouldBackfillDialogueEvent);
        for (const dialogueEvent of dialogueEvents) {
            scanned += 1;
            const event = pickBestDialogueEvent(dialogueEvent, exportedEvents, existingSourceEventIds);
            if (!event)
                continue;
            const totalTokens = event.totalTokens || event.inputTokens + event.outputTokens;
            dialogueEvent.client = event.client;
            dialogueEvent.sourcePath = event.sourcePath;
            dialogueEvent.sourceEventId = event.sourceEventId;
            dialogueEvent.conversationId = event.conversationId ?? dialogueEvent.conversationId;
            dialogueEvent.turnId = event.turnId ?? dialogueEvent.turnId;
            dialogueEvent.modelName = event.modelName ?? dialogueEvent.modelName;
            dialogueEvent.endedAt = event.endedAt ?? dialogueEvent.endedAt;
            dialogueEvent.inputTokens = event.inputTokens;
            dialogueEvent.outputTokens = event.outputTokens;
            dialogueEvent.totalTokens = totalTokens;
            dialogueEvent.matchQuality = event.turnId && event.turnId === dialogueEvent.turnId
                ? "turn_id"
                : isDeterministicTurnEvent(event)
                    ? "turn_id"
                    : "time_window";
            dialogueEvent.rawEvent = {
                ...(dialogueEvent.rawEvent ?? {}),
                ...(event.raw ?? {}),
                cachedTokens: event.cachedTokens ?? null,
                reasoningTokens: event.reasoningTokens ?? null,
                toolTokens: event.toolTokens ?? null,
                tokenStatsSource: "tool_log",
                backfilledDialogueTokenUsage: true,
            };
            await updateTokenUsageEvent(dialogueEvent);
            if (event.sourceEventId) {
                existingSourceEventIds.add(event.sourceEventId);
            }
            matchedDialogueEvents += 1;
        }
        await patchAutoSyncState({
            lastTokenSyncAt: new Date().toISOString(),
            lastTokenSyncFinishedAt: new Date().toISOString(),
            lastTokenSyncStatus: "completed",
            currentStep: null,
            currentStatus: null,
            lastTokenSyncSummary: {
                scannedRounds: scanned,
                exportedEvents: exportedEvents.length,
                matched,
                matchedDialogueEvents,
            },
        });
        console.log(`Token backfill completed: matched ${matched} rounds and ${matchedDialogueEvents} dialogue events from ${scanned} pending items`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await patchAutoSyncState({
            lastTokenSyncAt: new Date().toISOString(),
            lastTokenSyncFinishedAt: new Date().toISOString(),
            lastTokenSyncStatus: "failed",
            currentStep: null,
            currentStatus: null,
            lastError: message,
        });
        throw error;
    }
}
function isDeterministicTurnEvent(event) {
    return Boolean(event.turnId &&
        (event.raw?.matchStrategy === "session_jsonl_task_complete" ||
            event.raw?.matchStrategy === "claude_jsonl_assistant_usage"));
}
function shouldBackfillDialogueEvent(event) {
    if (args.roundId !== null)
        return false;
    if (event.roundId !== null)
        return false;
    if (event.totalTokens > 0)
        return false;
    if (!event.endedAt)
        return false;
    if (!args.rescan && event.rawEvent?.tokenSyncStatus === "not_found")
        return false;
    return true;
}
function shouldBackfillRound(round) {
    if (args.roundId !== null && round.id !== args.roundId)
        return false;
    if (round.totalTokens > 0)
        return false;
    if (!args.rescan && round.tokenSyncStatus === "not_found")
        return false;
    if (!["pending", "failed", "needs_review", "not_found"].includes(round.tokenSyncStatus))
        return false;
    return true;
}
async function readExportedEvents(client) {
    const script = resolve("scripts", "export-token-events.py");
    const { stdout } = await execFileAsync("python", [
        script,
        "--client",
        client,
        "--limit",
        String(args.limit),
        ...(args.since ? ["--since", args.since] : []),
    ], {
        cwd: process.cwd(),
        maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed.events) ? parsed.events.filter(isUsableEvent) : [];
}
function isUsableEvent(event) {
    return Boolean(event.client && event.endedAt && (event.inputTokens > 0 || event.outputTokens > 0 || event.totalTokens > 0));
}
function pickBestEvent(round, events, existingSourceEventIds) {
    return findCandidateEvents(round, events, existingSourceEventIds)[0] ?? null;
}
function findCandidateEvents(round, events, existingSourceEventIds) {
    const roundClient = metadataString(round, "client");
    const roundEnded = new Date(round.endedAt).getTime();
    if (!Number.isFinite(roundEnded))
        return [];
    const started = new Date(round.startedAt).getTime() - args.beforeWindowMs;
    const ended = roundEnded + args.afterWindowMs;
    const metadataTurnId = metadataString(round, "turnId");
    const candidates = events
        .filter((event) => !event.sourceEventId || !existingSourceEventIds.has(event.sourceEventId))
        .filter((event) => !roundClient || event.client === roundClient)
        .map((event) => ({ event, time: new Date(event.endedAt ?? "").getTime() }))
        .filter((item) => Number.isFinite(item.time) && item.time >= started && item.time <= ended)
        .sort((a, b) => {
        const aTurnMatch = metadataTurnId && a.event.turnId === metadataTurnId ? 0 : 1;
        const bTurnMatch = metadataTurnId && b.event.turnId === metadataTurnId ? 0 : 1;
        if (aTurnMatch !== bTurnMatch)
            return aTurnMatch - bTurnMatch;
        return Math.abs(a.time - roundEnded) - Math.abs(b.time - roundEnded);
    });
    return candidates.map((item) => item.event).slice(0, args.maxCandidatesPerRound);
}
async function persistCandidates(round, events) {
    await replaceTokenUsageCandidates(round.id, args.client === "all" ? (metadataString(round, "client") || "codex") : args.client, events.map((event) => ({
        roundId: round.id,
        client: event.client,
        sourcePath: event.sourcePath,
        sourceEventId: event.sourceEventId,
        conversationId: event.conversationId ?? round.conversationId,
        turnId: event.turnId,
        modelName: event.modelName ?? round.modelName,
        startedAt: round.startedAt,
        endedAt: event.endedAt ?? round.endedAt,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens || event.inputTokens + event.outputTokens,
        matchQuality: event.turnId && event.turnId === metadataString(round, "turnId") ? "turn_id" : "time_window",
        note: null,
        rawEvent: event.raw ?? null,
    })));
}
async function recordUnmatchedScan(round) {
    const scans = tokenScanCount(round) + 1;
    round.metadata = {
        ...(round.metadata ?? {}),
        tokenBackfillScans: scans,
        tokenLastScannedAt: new Date().toISOString(),
    };
    if (!shouldMarkNotFound(round, scans)) {
        await updateRound(round);
        return;
    }
    const before = { tokenSyncStatus: round.tokenSyncStatus, tokenSyncNote: round.tokenSyncNote, metadata: round.metadata };
    round.tokenSyncStatus = "not_found";
    round.tokenSyncNote = `No token event found after ${scans} scans`;
    round.metadata = {
        ...(round.metadata ?? {}),
        tokenBackfillScans: scans,
        tokenNotFoundAt: new Date().toISOString(),
    };
    await updateRound(round);
    await createAiCodingCorrection({
        correctionType: "token_reset",
        targetType: "round",
        targetId: round.id,
        roundId: round.id,
        actor: "token-backfill",
        reason: "pending token aged to not_found",
        before,
        after: { tokenSyncStatus: round.tokenSyncStatus, tokenSyncNote: round.tokenSyncNote, metadata: round.metadata },
    });
}
function shouldMarkNotFound(round, scans) {
    if (args.rescan || args.roundId !== null)
        return false;
    const endedAt = new Date(round.endedAt).getTime();
    if (!Number.isFinite(endedAt))
        return false;
    const ageMs = Date.now() - endedAt;
    return ageMs >= args.notFoundAfterMs && scans >= args.notFoundMinScans;
}
function tokenScanCount(round) {
    const scans = Number(round.metadata?.tokenBackfillScans ?? 0);
    return Number.isSafeInteger(scans) && scans >= 0 ? scans : 0;
}
function pickBestDialogueEvent(dialogueEvent, events, existingSourceEventIds) {
    const endedAt = new Date(dialogueEvent.endedAt ?? "").getTime();
    if (!Number.isFinite(endedAt))
        return null;
    const startedAt = dialogueEvent.startedAt
        ? new Date(dialogueEvent.startedAt).getTime()
        : endedAt - args.beforeWindowMs;
    const windowStart = (Number.isFinite(startedAt) ? startedAt : endedAt) - args.beforeWindowMs;
    const windowEnd = endedAt + args.afterWindowMs;
    const candidates = events
        .filter((event) => !event.sourceEventId || !existingSourceEventIds.has(event.sourceEventId))
        .filter((event) => event.client === dialogueEvent.client)
        .map((event) => ({ event, time: new Date(event.endedAt ?? "").getTime() }))
        .filter((item) => Number.isFinite(item.time) && item.time >= windowStart && item.time <= windowEnd)
        .sort((a, b) => Math.abs(a.time - endedAt) - Math.abs(b.time - endedAt));
    return candidates[0]?.event ?? null;
}
function metadataString(round, key) {
    const value = round.metadata?.[key];
    return typeof value === "string" ? value.trim() : "";
}
function parseArgs(argv) {
    const parsed = {
        roundId: null,
        client: "all",
        limit: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_EVENT_LIMIT, 200),
        beforeWindowMs: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_BEFORE_MS, 5 * 60 * 1000),
        afterWindowMs: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_AFTER_MS, 30 * 60 * 1000),
        since: process.env.AI_CODING_TOKEN_BACKFILL_SINCE || "",
        rescan: false,
        notFoundAfterMs: readNumber(process.env.AI_CODING_TOKEN_NOT_FOUND_AFTER_MS, 24 * 60 * 60 * 1000),
        notFoundMinScans: readNumber(process.env.AI_CODING_TOKEN_NOT_FOUND_MIN_SCANS, 3),
        maxCandidatesPerRound: readNumber(process.env.AI_CODING_TOKEN_CANDIDATES_PER_ROUND, 10),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === "--round-id" && next) {
            parsed.roundId = readNumber(next, 0) || null;
            index += 1;
        }
        else if (arg === "--client" && (next === "codex" || next === "claude-code" || next === "all")) {
            parsed.client = next;
            index += 1;
        }
        else if (arg === "--limit" && next) {
            parsed.limit = readNumber(next, parsed.limit);
            index += 1;
        }
        else if (arg === "--before-window-ms" && next) {
            parsed.beforeWindowMs = readNumber(next, parsed.beforeWindowMs);
            index += 1;
        }
        else if (arg === "--after-window-ms" && next) {
            parsed.afterWindowMs = readNumber(next, parsed.afterWindowMs);
            index += 1;
        }
        else if (arg === "--since" && next) {
            parsed.since = next;
            index += 1;
        }
        else if (arg === "--rescan") {
            parsed.rescan = true;
        }
        else if (arg === "--not-found-after-ms" && next) {
            parsed.notFoundAfterMs = readNumber(next, parsed.notFoundAfterMs);
            index += 1;
        }
        else if (arg === "--not-found-min-scans" && next) {
            parsed.notFoundMinScans = readNumber(next, parsed.notFoundMinScans);
            index += 1;
        }
    }
    return parsed;
}
export async function bindTokenCandidate(candidateId, reason) {
    const candidate = await getTokenUsageCandidate(candidateId);
    if (!candidate)
        throw new Error(`Token usage candidate ${candidateId} not found`);
    const round = (await getRounds()).find((item) => item.id === candidate.roundId);
    if (!round)
        throw new Error(`Round ${candidate.roundId} not found`);
    const before = { ...round };
    const totalTokens = candidate.totalTokens || candidate.inputTokens + candidate.outputTokens;
    await createTokenUsageEvent({
        roundId: round.id,
        client: candidate.client,
        sourcePath: candidate.sourcePath,
        sourceEventId: candidate.sourceEventId,
        conversationId: candidate.conversationId ?? round.conversationId,
        turnId: candidate.turnId,
        modelName: candidate.modelName ?? round.modelName,
        startedAt: candidate.startedAt ?? round.startedAt,
        endedAt: candidate.endedAt ?? round.endedAt,
        inputTokens: candidate.inputTokens,
        outputTokens: candidate.outputTokens,
        totalTokens,
        matchQuality: "manual",
        rawEvent: {
            ...(candidate.rawEvent ?? {}),
            selectedCandidateId: candidate.id,
            tokenStatsSource: "manual_candidate_bind",
        },
    });
    round.inputTokens = candidate.inputTokens;
    round.outputTokens = candidate.outputTokens;
    round.totalTokens = totalTokens;
    round.tokenSource = "tool_log";
    round.tokenMatchQuality = "manual";
    round.tokenSyncedAt = new Date().toISOString();
    round.tokenSyncStatus = "synced";
    round.tokenSyncNote = reason;
    await updateRound(round);
    await updateTokenUsageCandidate({ ...candidate, selectedAt: new Date().toISOString(), matchQuality: "manual", note: reason });
    await createAiCodingCorrection({
        correctionType: "token_manual_bind",
        targetType: "token_usage_candidate",
        targetId: candidate.id,
        roundId: round.id,
        actor: "cli",
        reason,
        before,
        after: { ...round },
    });
}
export async function markRoundTokenUnavailable(roundId, reason) {
    const round = (await getRounds()).find((item) => item.id === roundId);
    if (!round)
        throw new Error(`Round ${roundId} not found`);
    const before = { ...round };
    round.inputTokens = 0;
    round.outputTokens = 0;
    round.totalTokens = 0;
    round.tokenSource = "unavailable";
    round.tokenMatchQuality = null;
    round.tokenSyncedAt = new Date().toISOString();
    round.tokenSyncStatus = "unavailable";
    round.tokenSyncNote = reason ?? "Token usage marked unavailable manually";
    await updateRound(round);
    await createAiCodingCorrection({
        correctionType: "token_reset",
        targetType: "round",
        targetId: round.id,
        roundId: round.id,
        actor: "cli",
        reason,
        before,
        after: { ...round },
    });
}
function readNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
