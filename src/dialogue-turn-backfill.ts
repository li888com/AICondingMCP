import {
  getDialogueTurns,
  getRounds,
  getTokenUsageEvents,
  patchAutoSyncState,
  upsertDialogueTurn,
  type DialogueTurn,
  type Round,
  type TokenUsageEvent,
} from "./local-storage.js";

type Client = "codex" | "claude-code";

type BackfillArgs = {
  conversationId: string | null;
  dryRun: boolean;
  includeSynthetic: boolean;
};

type TurnSeed = {
  conversationId: string;
  turnId: string;
  client: Client;
  modelName: string;
  startedAt: string;
  endedAt: string;
  promptText: string | null;
  mode: "coding_round" | "dialogue_only";
  projectPath: string | null;
  roundId: number | null;
  tokenUsageEventId: number | null;
  sourceEventId: string | null;
  metadata: Record<string, unknown> | null;
  confidence: "exact" | "synthetic";
  sourceKind: "round" | "token_usage_event";
  sourceId: number;
};

const args = parseArgs(process.argv.slice(2));

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await patchAutoSyncState({
    currentStep: "dialogue-turns:backfill",
    currentStatus: "running",
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    const [rounds, tokenEvents, dialogueTurns] = await Promise.all([
      getRounds(),
      getTokenUsageEvents(),
      getDialogueTurns(),
    ]);

    const existingKeySet = new Set(dialogueTurns.map((item) => dialogueKey(item.conversationId, item.turnId)));
    const seeds = collectSeeds(rounds, tokenEvents, existingKeySet);

    let createdCodingRounds = 0;
    let createdDialogueOnly = 0;
    let skippedExisting = 0;
    let skippedMissingIds = 0;
    let skippedSynthetic = 0;

    for (const seed of seeds) {
      if (args.conversationId && seed.conversationId !== args.conversationId) {
        continue;
      }

      const key = dialogueKey(seed.conversationId, seed.turnId);
      if (existingKeySet.has(key)) {
        skippedExisting += 1;
        continue;
      }

      if (seed.confidence === "synthetic" && !args.includeSynthetic) {
        skippedSynthetic += 1;
        continue;
      }

      if (!seed.turnId.trim() || !seed.conversationId.trim()) {
        skippedMissingIds += 1;
        continue;
      }

      if (!args.dryRun) {
        await upsertDialogueTurn({
          conversationId: seed.conversationId,
          turnId: seed.turnId,
          client: seed.client,
          modelName: seed.modelName,
          startedAt: seed.startedAt,
          endedAt: seed.endedAt,
          promptText: seed.promptText,
          mode: seed.mode,
          projectPath: seed.projectPath,
          roundId: seed.roundId,
          tokenUsageEventId: seed.tokenUsageEventId,
          sourceEventId: seed.sourceEventId,
          metadata: {
            ...(seed.metadata ?? {}),
            dialogueTurnBackfilledAt: new Date().toISOString(),
            dialogueTurnBackfillSourceKind: seed.sourceKind,
            dialogueTurnBackfillSourceId: seed.sourceId,
            dialogueTurnBackfillConfidence: seed.confidence,
          },
        });
      }

      existingKeySet.add(key);
      if (seed.mode === "coding_round") {
        createdCodingRounds += 1;
      } else {
        createdDialogueOnly += 1;
      }
    }

    const summary = {
      ok: true,
      dryRun: args.dryRun,
      includeSynthetic: args.includeSynthetic,
      conversationId: args.conversationId,
      scanned: {
        rounds: rounds.length,
        dialogueOnlyTokenEvents: tokenEvents.filter((item) => item.roundId === null).length,
        existingDialogueTurns: dialogueTurns.length,
      },
      created: {
        codingRounds: createdCodingRounds,
        dialogueOnly: createdDialogueOnly,
        total: createdCodingRounds + createdDialogueOnly,
      },
      skipped: {
        existing: skippedExisting,
        synthetic: skippedSynthetic,
        missingIds: skippedMissingIds,
      },
    };

    await patchAutoSyncState({
      currentStep: null,
      currentStatus: null,
      lastHeartbeatAt: new Date().toISOString(),
      lastTokenSyncSummary: {
        ...(summary as Record<string, unknown>),
        worker: "dialogue-turns-backfill",
      },
    });

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await patchAutoSyncState({
      currentStep: null,
      currentStatus: null,
      lastHeartbeatAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function collectSeeds(
  rounds: Round[],
  tokenEvents: TokenUsageEvent[],
  existingKeySet: Set<string>
): TurnSeed[] {
  const seeds: TurnSeed[] = [];

  for (const round of rounds) {
    const seed = roundToSeed(round);
    if (!seed) continue;
    if (existingKeySet.has(dialogueKey(seed.conversationId, seed.turnId))) continue;
    seeds.push(seed);
  }

  for (const event of tokenEvents.filter((item) => item.roundId === null)) {
    const seed = tokenEventToSeed(event);
    if (!seed) continue;
    if (existingKeySet.has(dialogueKey(seed.conversationId, seed.turnId))) continue;
    seeds.push(seed);
  }

  return seeds.sort((a, b) => {
    const timeA = new Date(a.endedAt).getTime();
    const timeB = new Date(b.endedAt).getTime();
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    if (a.conversationId !== b.conversationId) {
      return a.conversationId.localeCompare(b.conversationId);
    }
    return a.turnId.localeCompare(b.turnId);
  });
}

function roundToSeed(round: Round): TurnSeed | null {
  const turnId = metadataString(round.metadata, "turnId")
    || metadataString(round.metadata, "baselineTurnId")
    || synthesizeTurnId("round", round.id, round.endedAt);
  const confidence = hasStableTurnId(round.metadata) ? "exact" : "synthetic";
  const client = normalizeClient(metadataString(round.metadata, "client"));
  const projectPath = metadataString(round.metadata, "projectPath") || null;

  return {
    conversationId: round.conversationId,
    turnId,
    client,
    modelName: round.modelName || "unknown",
    startedAt: round.startedAt || round.endedAt,
    endedAt: round.endedAt,
    promptText: round.promptText,
    mode: "coding_round",
    projectPath,
    roundId: round.id,
    tokenUsageEventId: null,
    sourceEventId: metadataString(round.metadata, "sourceEventId") || null,
    metadata: round.metadata ?? null,
    confidence,
    sourceKind: "round",
    sourceId: round.id,
  };
}

function tokenEventToSeed(event: TokenUsageEvent): TurnSeed | null {
  if (!event.conversationId) return null;

  const turnId = event.turnId?.trim()
    || synthesizeTurnId("token", event.id, event.endedAt ?? event.startedAt ?? event.createdAt);
  const confidence = event.turnId?.trim() ? "exact" : "synthetic";

  return {
    conversationId: event.conversationId,
    turnId,
    client: normalizeClient(event.client),
    modelName: event.modelName?.trim() || "unknown",
    startedAt: event.startedAt ?? event.endedAt ?? event.createdAt,
    endedAt: event.endedAt ?? event.startedAt ?? event.createdAt,
    promptText: rawPromptText(event.rawEvent),
    mode: "dialogue_only",
    projectPath: rawProjectPath(event.rawEvent),
    roundId: null,
    tokenUsageEventId: event.id,
    sourceEventId: event.sourceEventId,
    metadata: rawMetadata(event.rawEvent),
    confidence,
    sourceKind: "token_usage_event",
    sourceId: event.id,
  };
}

function rawPromptText(rawEvent: Record<string, unknown> | null): string | null {
  const value = rawEvent?.promptText;
  return typeof value === "string" ? value : null;
}

function rawProjectPath(rawEvent: Record<string, unknown> | null): string | null {
  const metadata = rawMetadata(rawEvent);
  const value = metadata?.projectPath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawMetadata(rawEvent: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = rawEvent?.metadata;
  return isRecord(value) ? value : null;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function hasStableTurnId(metadata: Record<string, unknown> | null | undefined): boolean {
  return Boolean(metadataString(metadata, "turnId") || metadataString(metadata, "baselineTurnId"));
}

function normalizeClient(value: string): Client {
  return value === "claude-code" ? "claude-code" : "codex";
}

function synthesizeTurnId(prefix: "round" | "token", id: number, time: string): string {
  const safeTime = (time || "unknown-time").replace(/[^\dA-Za-z]+/g, "-");
  return `backfill:${prefix}:${id}:${safeTime}`;
}

function dialogueKey(conversationId: string, turnId: string): string {
  return `${conversationId}::${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): BackfillArgs {
  const parsed: BackfillArgs = {
    conversationId: null,
    dryRun: false,
    includeSynthetic: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--conversation-id" && next) {
      parsed.conversationId = next;
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--exact-only") {
      parsed.includeSynthetic = false;
    } else if (arg === "--include-synthetic") {
      parsed.includeSynthetic = true;
    }
  }

  return parsed;
}
