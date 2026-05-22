import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  createTokenUsageEvent,
  getRounds,
  getTokenUsageEvents,
  patchAutoSyncState,
  updateRound,
  updateTokenUsageEvent,
  type Round,
  type TokenMatchQuality,
  type TokenUsageEvent,
} from "./local-storage.js";

const execFileAsync = promisify(execFile);

type Client = "codex" | "claude-code";

type ExportedTokenEvent = {
  client: Client;
  sourcePath: string;
  sourceEventId: string | null;
  conversationId: string | null;
  turnId: string | null;
  modelName: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  toolTokens?: number | null;
  raw?: Record<string, unknown>;
};

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  await patchAutoSyncState({
    lastTokenSyncAt: new Date().toISOString(),
    lastTokenSyncStatus: "running",
  });

  try {
    const rounds = (await getRounds()).filter(shouldBackfillRound);
    const existingEvents = await getTokenUsageEvents();
    const existingSourceEventIds = new Set(
      existingEvents.map((event) => event.sourceEventId).filter((value): value is string => Boolean(value))
    );
    const exportedEvents = await readExportedEvents(args.client);
    let matched = 0;
    let matchedDialogueEvents = 0;
    let scanned = 0;

    for (const round of rounds) {
      scanned += 1;
      const event = pickBestEvent(round, exportedEvents, existingSourceEventIds);
      if (!event) continue;

      const totalTokens = event.totalTokens || event.inputTokens + event.outputTokens;
      const matchQuality: TokenMatchQuality = event.turnId && event.turnId === metadataString(round, "turnId")
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
      if (!event) continue;

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
      lastTokenSyncStatus: "completed",
      lastTokenSyncSummary: {
        scannedRounds: scanned,
        exportedEvents: exportedEvents.length,
        matched,
        matchedDialogueEvents,
      },
    });

    console.log(`Token backfill completed: matched ${matched} rounds and ${matchedDialogueEvents} dialogue events from ${scanned} pending items`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchAutoSyncState({
      lastTokenSyncAt: new Date().toISOString(),
      lastTokenSyncStatus: "failed",
      lastError: message,
    });
    throw error;
  }
}

function isDeterministicTurnEvent(event: ExportedTokenEvent): boolean {
  return Boolean(
    event.turnId &&
    (
      event.raw?.matchStrategy === "session_jsonl_task_complete" ||
      event.raw?.matchStrategy === "claude_jsonl_assistant_usage"
    )
  );
}

function shouldBackfillDialogueEvent(event: TokenUsageEvent): boolean {
  if (args.roundId !== null) return false;
  if (event.roundId !== null) return false;
  if (event.totalTokens > 0) return false;
  if (!event.endedAt) return false;
  return true;
}

function shouldBackfillRound(round: Round): boolean {
  if (args.roundId !== null && round.id !== args.roundId) return false;
  if (round.totalTokens > 0) return false;
  if (!["pending", "failed", "needs_review"].includes(round.tokenSyncStatus)) return false;
  return true;
}

async function readExportedEvents(client: Client | "all"): Promise<ExportedTokenEvent[]> {
  const script = resolve("scripts", "export-token-events.py");
  const { stdout } = await execFileAsync("python", [
    script,
    "--client",
    client,
    "--limit",
    String(args.limit),
  ], {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { events?: ExportedTokenEvent[] };
  return Array.isArray(parsed.events) ? parsed.events.filter(isUsableEvent) : [];
}

function isUsableEvent(event: ExportedTokenEvent): boolean {
  return Boolean(event.client && event.endedAt && (event.inputTokens > 0 || event.outputTokens > 0 || event.totalTokens > 0));
}

function pickBestEvent(
  round: Round,
  events: ExportedTokenEvent[],
  existingSourceEventIds: Set<string>
): ExportedTokenEvent | null {
  const roundClient = metadataString(round, "client") as Client | "";
  const roundEnded = new Date(round.endedAt).getTime();
  if (!Number.isFinite(roundEnded)) return null;

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
      if (aTurnMatch !== bTurnMatch) return aTurnMatch - bTurnMatch;
      return Math.abs(a.time - roundEnded) - Math.abs(b.time - roundEnded);
    });

  return candidates[0]?.event ?? null;
}

function pickBestDialogueEvent(
  dialogueEvent: TokenUsageEvent,
  events: ExportedTokenEvent[],
  existingSourceEventIds: Set<string>
): ExportedTokenEvent | null {
  const endedAt = new Date(dialogueEvent.endedAt ?? "").getTime();
  if (!Number.isFinite(endedAt)) return null;
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

function metadataString(round: Round, key: string): string {
  const value = round.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseArgs(argv: string[]) {
  const parsed = {
    roundId: null as number | null,
    client: "all" as Client | "all",
    limit: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_EVENT_LIMIT, 200),
    beforeWindowMs: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_BEFORE_MS, 5 * 60 * 1000),
    afterWindowMs: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_AFTER_MS, 30 * 60 * 1000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--round-id" && next) {
      parsed.roundId = readNumber(next, 0) || null;
      index += 1;
    } else if (arg === "--client" && (next === "codex" || next === "claude-code" || next === "all")) {
      parsed.client = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      parsed.limit = readNumber(next, parsed.limit);
      index += 1;
    } else if (arg === "--before-window-ms" && next) {
      parsed.beforeWindowMs = readNumber(next, parsed.beforeWindowMs);
      index += 1;
    } else if (arg === "--after-window-ms" && next) {
      parsed.afterWindowMs = readNumber(next, parsed.afterWindowMs);
      index += 1;
    }
  }

  return parsed;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
