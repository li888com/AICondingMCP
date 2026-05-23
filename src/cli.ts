#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  cleanupRoundBaselines,
  createCodeSnapshot,
  deleteRoundBaseline,
  findGitRoot,
  getCodeStatsSinceSnapshot,
  listRoundBaselines,
  loadRoundBaseline,
  saveRoundBaseline,
} from "./code-stats.js";
import { recordDialogueTokenUsage, recordRound } from "./database.js";
import {
  getAutoSyncState,
  backupStorage,
  getStorageInfo,
  getRounds,
  getRoundReverts,
  getDialogueTurns,
  getTokenUsageEvents,
  getTokenUsageCandidates,
  getTokenUsageCandidate,
  patchAutoSyncState,
  upsertDialogueTurn,
  updateRound,
  updateTokenUsageCandidate,
  createTokenUsageEvent,
  createAiCodingCorrection,
} from "./local-storage.js";

type CommandResult = {
  exitCode: number;
  output: string;
};

const args = process.argv.slice(2);

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = args[0] ?? "help";
  const rest = args.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "start") {
    await start(rest);
    return;
  }

  if (command === "begin") {
    await begin(rest);
    return;
  }

  if (command === "status") {
    await status();
    return;
  }

  if (command === "dialogue-turns") {
    const subcommand = rest[0];
    if (subcommand === "backfill") {
      await runScript("dialogue-turns:backfill", rest.slice(1));
      return;
    }
    await dialogueTurnsCommand(rest);
    return;
  }

  if (command === "turn") {
    await turnCommand(rest);
    return;
  }

  if (command === "baselines") {
    await baselines(rest);
    return;
  }

  if (command === "finish") {
    await finish(rest);
    return;
  }

  if (command === "sync") {
    await runScript("sync:online", rest);
    return;
  }

  if (command === "tokens") {
    const subcommand = rest[0];
    if (subcommand === "sync") {
      await runScript("tokens:backfill", rest.slice(1));
      return;
    }
    if (subcommand === "pending") {
      await listPendingTokens(rest.slice(1));
      return;
    }
    if (subcommand === "candidates") {
      await listTokenCandidates(rest.slice(1));
      return;
    }
    if (subcommand === "bind") {
      await bindTokenCandidate(rest.slice(1));
      return;
    }
    if (subcommand === "unavailable") {
      await markTokenUnavailable(rest.slice(1));
      return;
    }
    throw new Error("Usage: ai-coding-stats tokens <sync|pending|candidates|bind|unavailable>");
  }

  if (command === "pipeline") {
    await runScript("sync:pipeline", rest);
    return;
  }

  if (command === "reconcile") {
    await reconcile(rest);
    return;
  }

  if (command === "doctor") {
    await doctor();
    return;
  }

  if (command === "diagnose") {
    await diagnose(rest);
    return;
  }

  if (command === "storage") {
    await storage(rest);
    return;
  }

  if (command === "init-config") {
    await initConfig(rest);
    return;
  }

  if (command === "stop") {
    await stop();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function start(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const scriptArgs = [
    "--project-path",
    parsed.projectPath ?? process.cwd(),
    "--client",
    parsed.client ?? "codex",
    "--model-name",
    parsed.modelName ?? "unknown",
    "--prompt-text",
    parsed.promptText ?? "auto recorded AI coding round",
    "--poll-interval-ms",
    parsed.pollIntervalMs ?? "5000",
    "--settle-ms",
    parsed.settleMs ?? "120000",
    ...(parsed.conversationId ? ["--conversation-id", parsed.conversationId] : []),
    ...(parsed.noSyncOnline ? ["--no-sync-online"] : []),
  ];

  const child = spawnCommand(npmCommand(), ["run", "auto", "--", ...scriptArgs], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  await patchAutoSyncState({
    workerId: `auto-runner-${child.pid}`,
    pid: child.pid ?? null,
    status: "running",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    lastError: null,
  });

  console.log(`AI coding auto-runner started with pid ${child.pid ?? "unknown"}.`);
}

async function begin(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const projectPath = resolve(parsed.projectPath ?? process.cwd());
  const gitRoot = await findGitRoot(projectPath);
  if (!gitRoot) {
    throw new Error(`No Git workspace found for ${projectPath}`);
  }

  const conversationId = parsed.conversationId ?? defaultConversationId(gitRoot);
  const snapshot = await createCodeSnapshot(gitRoot);
  const startedAt = parsed.startedAt ?? snapshot.createdAt;
  const saved = await saveRoundBaseline(conversationId, gitRoot, snapshot, {
    turnId: parsed.turnId,
    startedAt,
  });

  console.log(JSON.stringify({
    conversationId,
    projectPath: gitRoot,
    startedAt,
    baselineId: saved.baselineId,
    baselinePath: saved.path,
    filesTracked: snapshot.files.length,
    turnId: parsed.turnId ?? null,
  }, null, 2));
}

async function finish(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const projectPath = resolve(parsed.projectPath ?? process.cwd());
  const gitRoot = await findGitRoot(projectPath);
  if (!gitRoot) {
    throw new Error(`No Git workspace found for ${projectPath}`);
  }

  const conversationId = parsed.conversationId ?? defaultConversationId(gitRoot);
  const baseline = await loadRoundBaseline(conversationId, gitRoot, { turnId: parsed.turnId });
  if (!baseline) {
    throw new Error("No round baseline found. Run `ai-coding-stats begin` before `ai-coding-stats finish` to record accurate per-dialogue code stats.");
  }

  const stats = await getCodeStatsSinceSnapshot(gitRoot, baseline.snapshot);
  const endedAt = new Date().toISOString();
  const startedAt = parsed.startedAt ?? baseline.startedAt ?? baseline.snapshot.createdAt;

  const recorded = await recordRound({
    conversationId,
    startedAt,
    endedAt,
    modelName: parsed.modelName ?? "unknown",
    promptText: parsed.promptText ?? "auto finished AI coding round",
    filesChanged: stats.filesChanged,
    linesAdded: stats.linesAdded,
    linesDeleted: stats.linesDeleted,
    codeLinesChanged: stats.codeLinesChanged,
    totalTokens: 0,
    metadata: {
      client: parsed.client ?? "codex",
      projectPath: gitRoot,
      turnId: parsed.turnId ?? undefined,
      autoFinished: true,
      baselineId: baseline.baselineId,
      baselinePath: baseline.path,
      baselineCreatedAt: baseline.snapshot.createdAt,
      baselineTurnId: parsed.turnId ?? null,
      ...stats.metadata,
      tokenStatsSource: "pending_log_backfill",
      tokenStatsUnavailable: true,
    },
  });

  console.log(formatReadableLineChangeSummary(buildLineChangeSummary(recorded)));

  if (!parsed.noPipeline) {
    startDetachedNpmScript("sync:pipeline:start", [
      "--round-id",
      String(recorded.id),
      "--client",
      parsed.client ?? "codex",
      "--delay-ms",
      parsed.tokenDelayMs ?? process.env.AI_CODING_TOKEN_BACKFILL_DELAY_MS ?? "120000",
    ]);
  }
}

async function turnCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? "";
  if (subcommand === "begin") {
    await turnBegin(argv.slice(1));
    return;
  }
  if (subcommand === "end") {
    await turnEnd(argv.slice(1));
    return;
  }
  throw new Error("Usage: ai-coding-stats turn <begin|end> [options]");
}

async function turnBegin(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const projectPath = resolve(parsed.projectPath ?? process.cwd());
  const gitRoot = await findGitRoot(projectPath);
  if (!gitRoot) {
    throw new Error(`No Git workspace found for ${projectPath}`);
  }

  const client = normalizeClient(parsed.client);
  const conversationId = parsed.conversationId ?? defaultConversationIdForClient(gitRoot, client);
  const turnId = parsed.turnId?.trim();
  if (!turnId) {
    throw new Error("Usage: ai-coding-stats turn begin --turn-id <id> [--conversation-id <id>]");
  }

  const snapshot = await createCodeSnapshot(gitRoot);
  const startedAt = parsed.startedAt ?? snapshot.createdAt;
  const saved = await saveRoundBaseline(conversationId, gitRoot, snapshot, {
    turnId,
    startedAt,
  });

  console.log(JSON.stringify({
    ok: true,
    mode: "dialogue",
    action: "begin",
    conversationId,
    turnId,
    client,
    modelName: parsed.modelName ?? null,
    promptText: parsed.promptText ?? null,
    projectPath: gitRoot,
    startedAt,
    baselineId: saved.baselineId,
    baselinePath: saved.path,
    baselineCreatedAt: snapshot.createdAt,
    filesTracked: snapshot.files.length,
  }, null, 2));
}

async function turnEnd(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const projectPath = resolve(parsed.projectPath ?? process.cwd());
  const gitRoot = await findGitRoot(projectPath);
  if (!gitRoot) {
    throw new Error(`No Git workspace found for ${projectPath}`);
  }

  const client = normalizeClient(parsed.client);
  const conversationId = parsed.conversationId ?? defaultConversationIdForClient(gitRoot, client);
  const turnId = parsed.turnId?.trim();
  if (!turnId) {
    throw new Error("Usage: ai-coding-stats turn end --turn-id <id> [--conversation-id <id>]");
  }

  const baseline = await loadRoundBaseline(conversationId, gitRoot, { turnId });
  const endedAt = new Date().toISOString();
  const modelName = parsed.modelName ?? "unknown";
  const promptText = parsed.promptText ?? null;
  const sourceEventId = `${client}:${conversationId.replaceAll("\\", "/")}:${turnId}:${endedAt}`;
  const startedAt = parsed.startedAt ?? baseline?.startedAt ?? baseline?.snapshot.createdAt ?? endedAt;

  try {
    if (baseline) {
      const stats = await getCodeStatsSinceSnapshot(gitRoot, baseline.snapshot);
      if (stats.codeLinesChanged > 0) {
        const recorded = await recordRound({
          conversationId,
          startedAt,
          endedAt,
          modelName,
          promptText: promptText ?? undefined,
          filesChanged: stats.filesChanged,
          linesAdded: stats.linesAdded,
          linesDeleted: stats.linesDeleted,
          codeLinesChanged: stats.codeLinesChanged,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          metadata: {
            client,
            turnId,
            projectPath: gitRoot,
            dialogueTurnMode: "forced-per-turn-cli",
            sourceTool: "cli:turn:end",
            codeStatsSource: "mcp baseline snapshot diff",
            codeStatsPrecision: "round-baseline-content-diff",
            baselineId: baseline.baselineId,
            baselinePath: baseline.path,
            tokenStatsSource: "pending_log_backfill",
            tokenStatsUnavailable: true,
          },
        });
        await upsertDialogueTurn({
          conversationId,
          turnId,
          client,
          modelName,
          startedAt,
          endedAt,
          promptText,
          mode: "coding_round",
          projectPath: gitRoot,
          roundId: recorded.id,
          tokenUsageEventId: null,
          sourceEventId,
          metadata: {
            client,
            turnId,
            projectPath: gitRoot,
            sourceTool: "cli:turn:end",
          },
        });

        console.log(JSON.stringify({
          ok: true,
          action: "end",
          mode: "coding_round",
          conversationId,
          turnId,
          client,
          modelName,
          startedAt,
          endedAt,
          roundId: recorded.id,
          filesChanged: recorded.filesChanged ?? 0,
          linesAdded: recorded.linesAdded,
          linesDeleted: recorded.linesDeleted,
          codeLinesChanged: recorded.codeLinesChanged,
          tokenSyncStatus: recorded.tokenSyncStatus,
        }, null, 2));
        return;
      }
    }

    const dialogue = await recordDialogueTokenUsage({
      conversationId,
      client,
      sourcePath: "cli:turn:end",
      sourceEventId,
      turnId,
      modelName,
      startedAt,
      endedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      promptText: promptText ?? undefined,
      metadata: {
        client,
        turnId,
        projectPath: gitRoot,
        dialogueTurnMode: "forced-per-turn-cli",
        sourceTool: "cli:turn:end",
        codeStatsSource: baseline ? "mcp baseline snapshot diff" : "no baseline available",
        codeStatsPrecision: baseline ? "round-baseline-content-diff" : "unavailable",
        codeLinesChanged: 0,
      },
    });
    await upsertDialogueTurn({
      conversationId,
      turnId,
      client,
      modelName,
      startedAt,
      endedAt,
      promptText,
      mode: "dialogue_only",
      projectPath: gitRoot,
      roundId: null,
      tokenUsageEventId: dialogue.id,
      sourceEventId: dialogue.sourceEventId,
      metadata: {
        client,
        turnId,
        projectPath: gitRoot,
        sourceTool: "cli:turn:end",
      },
    });

    console.log(JSON.stringify({
      ok: true,
      action: "end",
      mode: "dialogue_only",
      conversationId,
      turnId,
      client,
      modelName,
      startedAt,
      endedAt,
      dialogueEventId: dialogue.id,
      sourceEventId: dialogue.sourceEventId,
      warning: dialogue.warning,
    }, null, 2));
  } finally {
    await deleteRoundBaseline(conversationId, gitRoot, { turnId });
  }
}

async function status(): Promise<void> {
  const [rounds, roundReverts, tokenEvents, dialogueTurns, state] = await Promise.all([
    getRounds(),
    getRoundReverts(),
    getTokenUsageEvents(),
    getDialogueTurns(),
    getAutoSyncState(),
  ]);

  const pendingTokenRounds = rounds.filter((round) => ["pending", "failed", "running"].includes(round.tokenSyncStatus)).length;
  const needsReviewTokenRounds = rounds.filter((round) => ["needs_review", "conflict"].includes(round.tokenSyncStatus)).length;
  const pendingDialogueTokenEvents = tokenEvents.filter((event) => event.roundId === null && event.totalTokens <= 0).length;
  const pendingUploads = rounds.filter(isUploadPending).length + tokenEvents.filter(isUploadPending).length + roundReverts.filter(isUploadPending).length;
  const failedUploads = rounds.filter(isUploadFailed).length + tokenEvents.filter(isUploadFailed).length + roundReverts.filter(isUploadFailed).length;
  const syncedUploads = rounds.filter(isUploadSynced).length + tokenEvents.filter(isUploadSynced).length + roundReverts.filter(isUploadSynced).length;
  const skippedUploads = rounds.filter(isUploadSkipped).length + tokenEvents.filter(isUploadSkipped).length + roundReverts.filter(isUploadSkipped).length;
  const running = state?.status === "running";
  const pending = pendingTokenRounds > 0 || pendingDialogueTokenEvents > 0 || pendingUploads > 0 || failedUploads > 0;
  const actionRequired = needsReviewTokenRounds > 0 || failedUploads > 0 || state?.status === "failed";
  const latestRound = [...rounds].sort((a, b) => b.id - a.id)[0] ?? null;
  const storage = getStorageInfo();
  const dialogueSummary = buildDialogueTurnSummary(dialogueTurns, rounds, tokenEvents);

  console.log(JSON.stringify({
    ok: !running && !pending && !actionRequired,
    running,
    pending,
    actionRequired,
    storage,
    autoRunner: state ?? { status: "idle" },
    currentJob: state?.currentStep
      ? {
          step: state.currentStep ?? null,
          status: state.currentStatus ?? state.status,
          startedAt: currentJobStartedAt(state),
          stale: isCurrentJobStale(state),
          heartbeatAgeSeconds: state.lastHeartbeatAt ? Math.round((Date.now() - new Date(state.lastHeartbeatAt).getTime()) / 1000) : null,
        }
      : null,
    rounds: {
      total: rounds.length,
      reverted: roundReverts.length,
    },
    dialogueTurns: {
      total: dialogueTurns.length,
      dialogueOnly: dialogueTurns.filter((turn) => turn.mode === "dialogue_only").length,
      codingRounds: dialogueTurns.filter((turn) => turn.mode === "coding_round").length,
      linkedRounds: dialogueSummary.linkedRounds,
      linkedTokenUsageEvents: dialogueSummary.linkedTokenUsageEvents,
      missingRoundLinks: dialogueSummary.missingRoundLinks,
      missingTokenEventLinks: dialogueSummary.missingTokenEventLinks,
      orphanRounds: dialogueSummary.orphanRounds,
      orphanDialogueTokenEvents: dialogueSummary.orphanDialogueTokenEvents,
    },
    tokens: {
      pending: pendingTokenRounds + pendingDialogueTokenEvents,
      needsReview: needsReviewTokenRounds,
      completed: rounds.filter((round) => round.tokenSyncStatus === "synced").length,
      events: tokenEvents.length,
    },
    uploads: {
      pending: pendingUploads,
      failed: failedUploads,
      synced: syncedUploads,
      skipped: skippedUploads,
    },
    latestRound: latestRound
      ? {
          id: latestRound.id,
          conversationId: latestRound.conversationId,
          endedAt: latestRound.endedAt,
          filesChanged: latestRound.filesChanged,
          linesAdded: latestRound.linesAdded,
          linesDeleted: latestRound.linesDeleted,
          codeLinesChanged: latestRound.codeLinesChanged,
          totalTokens: latestRound.totalTokens,
          tokenSyncStatus: latestRound.tokenSyncStatus,
          turnId: stringValue(latestRound.metadata?.turnId) ?? stringValue(latestRound.metadata?.baselineTurnId) ?? null,
          demandCode: stringValue(latestRound.metadata?.demandCode) ?? null,
          demandName: stringValue(latestRound.metadata?.demandName) ?? null,
          projectName: stringValue(latestRound.metadata?.projectName) ?? null,
          codeStatsPrecision: stringValue(latestRound.metadata?.codeStatsPrecision) ?? null,
        }
      : null,
  }, null, 2));
}

async function baselines(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? "list";
  if (subcommand === "list") {
    const baselines = await listRoundBaselines();
    console.log(JSON.stringify({ count: baselines.length, baselines }, null, 2));
    return;
  }

  if (subcommand === "cleanup") {
    const parsed = parseOptions(argv.slice(1));
    const maxAgeMinutes = Number(parsed.maxAgeMinutes ?? "1440");
    if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) {
      throw new Error("Usage: ai-coding-stats baselines cleanup [--max-age-minutes <number>]");
    }
    const result = await cleanupRoundBaselines(maxAgeMinutes * 60 * 1000);
    console.log(JSON.stringify({
      maxAgeMinutes,
      deleted: result.deleted.length,
      kept: result.kept,
      baselines: result.deleted,
    }, null, 2));
    return;
  }

  throw new Error("Usage: ai-coding-stats baselines <list|cleanup [--max-age-minutes <number>]>");
}

async function dialogueTurnsCommand(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const limit = Number(parsed.limit ?? "50");
  const maxRows = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  const conversationId = parsed.conversationId?.trim();
  const mode = parsed.mode?.trim();
  const [dialogueTurns, rounds, tokenEvents] = await Promise.all([
    getDialogueTurns(),
    getRounds(),
    getTokenUsageEvents(),
  ]);

  const roundById = new Map(rounds.map((item) => [item.id, item]));
  const tokenEventById = new Map(tokenEvents.map((item) => [item.id, item]));
  const filtered = dialogueTurns
    .filter((item) => !conversationId || item.conversationId === conversationId)
    .filter((item) => !mode || item.mode === mode)
    .sort((a, b) => {
      const timeDelta = new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return b.id - a.id;
    })
    .slice(0, maxRows)
    .map((item) => {
      const round = item.roundId !== null ? roundById.get(item.roundId) : null;
      const tokenEvent = item.tokenUsageEventId !== null ? tokenEventById.get(item.tokenUsageEventId) : null;
      return {
        dialogueTurnId: item.id,
        conversationId: item.conversationId,
        turnId: item.turnId,
        mode: item.mode,
        client: item.client,
        modelName: item.modelName,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        roundId: item.roundId,
        tokenUsageEventId: item.tokenUsageEventId,
        codeLinesChanged: round?.codeLinesChanged ?? 0,
        totalTokens: round?.totalTokens ?? tokenEvent?.totalTokens ?? 0,
        sourceEventId: item.sourceEventId,
        projectPath: item.projectPath,
      };
    });

  console.log(JSON.stringify({
    total: filtered.length,
    items: filtered,
    summary: buildDialogueTurnSummary(dialogueTurns, rounds, tokenEvents),
  }, null, 2));
}

async function bindTokenCandidate(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const candidateId = Number(parsed.candidateId ?? argv[0]);
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
    throw new Error("Usage: ai-coding-stats tokens bind <candidate-id> [--reason <text>]");
  }
  const candidate = await getTokenUsageCandidate(candidateId);
  if (!candidate) throw new Error(`Token usage candidate ${candidateId} not found`);
  const round = (await getRounds()).find((item) => item.id === candidate.roundId);
  if (!round) throw new Error(`Round ${candidate.roundId} not found`);
  const before = { ...round };
  const reason = parsed.reason ?? "manual token candidate bind";
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
  await updateRound({
    ...round,
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens,
    tokenSource: "tool_log",
    tokenMatchQuality: "manual",
    tokenSyncedAt: new Date().toISOString(),
    tokenSyncStatus: "synced",
    tokenSyncNote: reason,
  });
  await updateTokenUsageCandidate({ ...candidate, selectedAt: new Date().toISOString(), matchQuality: "manual", note: reason });
  await createAiCodingCorrection({
    correctionType: "token_manual_bind",
    targetType: "token_usage_candidate",
    targetId: candidate.id,
    roundId: round.id,
    actor: "cli",
    reason,
    before,
    after: { roundId: round.id, totalTokens, tokenSyncStatus: "synced" },
  });
  console.log(`Bound token candidate ${candidate.id} to round ${round.id}.`);
}

async function markTokenUnavailable(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const roundId = Number(parsed.roundId ?? argv[0]);
  if (!Number.isSafeInteger(roundId) || roundId <= 0) {
    throw new Error("Usage: ai-coding-stats tokens unavailable <round-id> [--reason <text>]");
  }
  const round = (await getRounds()).find((item) => item.id === roundId);
  if (!round) throw new Error(`Round ${roundId} not found`);
  const before = { ...round };
  const reason = parsed.reason ?? "Token usage marked unavailable manually";
  await updateRound({
    ...round,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenSource: "unavailable",
    tokenMatchQuality: null,
    tokenSyncedAt: new Date().toISOString(),
    tokenSyncStatus: "unavailable",
    tokenSyncNote: reason,
  });
  await createAiCodingCorrection({
    correctionType: "token_reset",
    targetType: "round",
    targetId: round.id,
    roundId: round.id,
    actor: "cli",
    reason,
    before,
    after: { roundId: round.id, tokenSyncStatus: "unavailable" },
  });
  console.log(`Marked round ${round.id} token usage unavailable.`);
}

async function reconcile(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);

  if (parsed.noTokens !== true) {
    console.log("Running token backfill...");
    await runScript("tokens:backfill", ["--client", parsed.client ?? "all"]);
  }

  if (parsed.noSyncOnline !== true) {
    console.log("Running online sync...");
    await runScript("sync:online", ["--retry-failed-now"]);
  }

  console.log("Reconcile complete. Current status:");
  await status();
}

function buildLineChangeSummary(recorded: {
  id: number;
  filesChanged: number | null;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  totalTokens: number;
  tokenSyncStatus: string;
}) {
  return {
    roundId: recorded.id,
    filesChanged: recorded.filesChanged ?? 0,
    linesAdded: recorded.linesAdded,
    linesDeleted: recorded.linesDeleted,
    codeLinesChanged: recorded.codeLinesChanged,
    totalTokens: recorded.totalTokens,
    tokenSyncStatus: recorded.tokenSyncStatus,
  };
}

function formatReadableLineChangeSummary(summary: {
  roundId: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  totalTokens: number;
  tokenSyncStatus: string;
}): string {
  return `本次记录 round ${summary.roundId}：修改 ${summary.filesChanged} 个文件，新增 ${summary.linesAdded} 行，删除 ${summary.linesDeleted} 行，合计 ${summary.codeLinesChanged} 行；token 状态 ${summary.tokenSyncStatus}，totalTokens ${summary.totalTokens}`;
}

function formatLineChangeSummary(summary: {
  roundId: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  totalTokens: number;
  tokenSyncStatus: string;
}): string {
  return `本次记录 round ${summary.roundId}：修改 ${summary.filesChanged} 个文件，新增 ${summary.linesAdded} 行，删除 ${summary.linesDeleted} 行，合计 ${summary.codeLinesChanged} 行；token 状态 ${summary.tokenSyncStatus}，totalTokens ${summary.totalTokens}`;
}

async function listPendingTokens(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const limit = Number(parsed.limit ?? "50");
  const maxRows = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  const pendingStatuses = new Set(["pending", "failed", "needs_review", "not_found"]);
  const roundId = parsed.roundId ? Number(parsed.roundId) : null;
  const candidates = await getTokenUsageCandidates();
  const rounds = (await getRounds())
    .filter((round) => pendingStatuses.has(round.tokenSyncStatus) && round.totalTokens <= 0)
    .filter((round) => !roundId || round.id === roundId)
    .sort((a, b) => b.id - a.id)
    .slice(0, maxRows)
    .map((round) => {
      const roundCandidates = candidates.filter((candidate) => candidate.roundId === round.id && !candidate.selectedAt);
      return {
        roundId: round.id,
        status: round.tokenSyncStatus,
        note: round.tokenSyncNote,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        conversationId: round.conversationId,
        turnId: stringValue(round.metadata?.turnId) ?? stringValue(round.metadata?.baselineTurnId) ?? null,
        scans: numberValue(round.metadata?.tokenBackfillScans),
        lastScannedAt: stringValue(round.metadata?.tokenLastScannedAt) ?? null,
        candidates: roundCandidates.length,
        candidateIds: roundCandidates.slice(0, 10).map((candidate) => candidate.id),
      };
    });

  console.log(JSON.stringify({ pending: rounds.length, rounds }, null, 2));
}

async function listTokenCandidates(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const roundId = parsed.roundId ? Number(parsed.roundId) : undefined;
  const limit = Number(parsed.limit ?? "50");
  const maxRows = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  const candidates = (await getTokenUsageCandidates(roundId))
    .filter((candidate) => parsed.all || !candidate.selectedAt)
    .sort((a, b) => b.id - a.id)
    .slice(0, maxRows)
    .map((candidate) => ({
      id: candidate.id,
      roundId: candidate.roundId,
      client: candidate.client,
      totalTokens: candidate.totalTokens,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      matchQuality: candidate.matchQuality,
      endedAt: candidate.endedAt,
      turnId: candidate.turnId,
      sourceEventId: candidate.sourceEventId,
      selectedAt: candidate.selectedAt,
    }));

  console.log(JSON.stringify({ candidates: candidates.length, items: candidates }, null, 2));
}

async function doctor(): Promise<void> {
  const syncConfig = await loadSyncConfig();
  const checks = [
    await checkCommand("node", ["--version"]),
    await checkCommand(npmCommand(), ["--version"], "npm"),
    await checkCommand("git", ["--version"]),
    await checkBuildOutput(),
    await checkDistFreshness(),
    checkSyncConfig(syncConfig),
    checkAuthConfig(syncConfig),
    checkTurnApiPath(syncConfig),
    await checkApiConnectivity(syncConfig),
  ];

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

async function diagnose(argv: string[]): Promise<void> {
  if (argv[0] !== "uploads") {
    throw new Error("Usage: ai-coding-stats diagnose uploads");
  }

  const [rounds, reverts, tokenEvents] = await Promise.all([
    getRounds(),
    getRoundReverts(),
    getTokenUsageEvents(),
  ]);
  const failed = [
    ...rounds.filter(isUploadFailed).map((item) => ({
      entityType: "round",
      entityId: item.id,
      endpoint: "POST /ai-codingTurns",
      sync: item._sync,
      endedAt: item.endedAt,
    })),
    ...reverts.filter(isUploadFailed).map((item) => ({
      entityType: "roundRevert",
      entityId: item.id,
      endpoint: "(skipped/local)",
      sync: item._sync,
      endedAt: item.revertedAt,
    })),
    ...tokenEvents.filter(isUploadFailed).map((item) => ({
      entityType: "tokenUsageEvent",
      entityId: item.id,
      endpoint: "PATCH /ai-codingTurns/{turnId}/tokens",
      sync: item._sync,
      endedAt: item.endedAt,
    })),
  ];

  console.log(JSON.stringify({
    storage: getStorageInfo(),
    failed: failed.length,
    uploads: failed.map((item) => ({
      entityType: item.entityType,
      entityId: item.entityId,
      endpoint: item.endpoint,
      status: item.sync?.status ?? "pending",
      error: item.sync?.error ?? null,
      failedAttempts: item.sync?.failedAttempts ?? 0,
      lastAttemptAt: item.sync?.lastAttemptAt ?? null,
      nextRetryAt: item.sync?.nextRetryAt ?? null,
      endedAt: item.endedAt ?? null,
    })),
  }, null, 2));
}

async function storage(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? "doctor";
  if (subcommand === "doctor") {
    const [rounds, reverts, tokenEvents, dialogueTurns] = await Promise.all([
      getRounds(),
      getRoundReverts(),
      getTokenUsageEvents(),
      getDialogueTurns(),
    ]);
    const dialogueSummary = buildDialogueTurnSummary(dialogueTurns, rounds, tokenEvents);
    console.log(JSON.stringify({
      ok: true,
      ...getStorageInfo(),
      counts: {
        rounds: rounds.length,
        roundReverts: reverts.length,
        tokenUsageEvents: tokenEvents.length,
        dialogueTurns: dialogueTurns.length,
      },
      dialogueSummary,
    }, null, 2));
    return;
  }

  if (subcommand === "backup") {
    const info = getStorageInfo();
    await access(info.sqlitePath);
    const backupDir = join(info.storageDir, "backups");
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "").replace("T", "-");
    const backupPath = join(backupDir, `storage-${stamp}.db`);
    await backupStorage(backupPath);
    console.log(`Created backup ${backupPath}`);
    return;
  }

  if (subcommand === "export") {
    const outputPath = resolve(argv[1] ?? join(getStorageInfo().storageDir, "storage-export.json"));
    const [rounds, roundReverts, tokenUsageEvents, dialogueTurns, autoSyncState] = await Promise.all([
      getRounds(),
      getRoundReverts(),
      getTokenUsageEvents(),
      getDialogueTurns(),
      getAutoSyncState(),
    ]);
    const dialogueSummary = buildDialogueTurnSummary(dialogueTurns, rounds, tokenUsageEvents);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({
      summary: {
        rounds: rounds.length,
        roundReverts: roundReverts.length,
        tokenUsageEvents: tokenUsageEvents.length,
        dialogueTurns: dialogueTurns.length,
        dialogueSummary,
      },
      rounds,
      roundReverts,
      tokenUsageEvents,
      dialogueTurns,
      autoSyncState,
    }, null, 2)}\n`, "utf8");
    console.log(`Exported storage snapshot to ${outputPath}`);
    return;
  }

  throw new Error("Usage: ai-coding-stats storage <doctor|backup|export [path]>");
}

async function initConfig(argv: string[]): Promise<void> {
  const parsed = parseOptions(argv);
  const storageDir = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"));
  const configPath = resolve(parsed.configPath ?? join(storageDir, "config.json"));
  const config = {
    apiBaseUrl: parsed.apiBaseUrl ?? "http://127.0.0.1:9906",
    reportApiBaseUrl: parsed.reportApiBaseUrl ?? parsed.apiBaseUrl ?? "http://127.0.0.1:9906",
    turnApiPath: parsed.turnApiPath ?? "/ai-codingTurns",
    employeeId: parsed.employeeId ?? "",
    userName: parsed.userName ?? "",
    teamId: parsed.teamId ?? "",
    token: parsed.token ?? "",
    accessToken: parsed.accessToken ?? parsed.token ?? "",
    externalSysKey: parsed.externalSysKey ?? "",
    externalSysSecret: parsed.externalSysSecret ?? "",
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`Wrote sync config to ${configPath}`);
}

async function stop(): Promise<void> {
  const state = await getAutoSyncState();
  const pid = state?.pid;
  if (!pid || state?.status !== "running") {
    console.log("No running auto-runner found.");
    return;
  }

  const validation = await validateAutoRunnerProcess(pid, state.workerId, state.startedAt);
  if (!validation.ok) {
    throw new Error(`Refusing to stop pid ${pid}: ${validation.detail}`);
  }

  try {
    process.kill(pid, process.platform === "win32" ? undefined : "SIGTERM");
    await patchAutoSyncState({
      status: "stopped",
      lastHeartbeatAt: new Date().toISOString(),
      lastError: null,
    });
    console.log(`Stopped auto-runner pid ${pid}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchAutoSyncState({ status: "failed", lastError: message });
    throw new Error(`Failed to stop auto-runner pid ${pid}: ${message}`);
  }
}

async function runScript(script: string, argv: string[]): Promise<void> {
  const result = await runCommand(npmCommand(), ["run", script, "--", ...argv]);
  process.stdout.write(result.output);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

function startDetachedNpmScript(script: string, argv: string[]): void {
  const child = spawnCommand(npmCommand(), ["run", script, "--", ...argv], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function checkCommand(command: string, argv: string[], name = command) {
  const result = await runCommand(command, argv).catch((error: unknown) => ({
    exitCode: 1,
    output: error instanceof Error ? error.message : String(error),
  }));
  return {
    name,
    ok: result.exitCode === 0,
    detail: result.output.trim().split(/\r?\n/u)[0] ?? "",
  };
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function checkBuildOutput() {
  const distPath = resolve("dist", "ai-coding-stats-server.js");
  try {
    await access(distPath);
    return { name: "dist", ok: true, detail: distPath };
  } catch {
    return { name: "dist", ok: false, detail: "Run npm run build before production use" };
  }
}

async function checkDistFreshness() {
  const srcFiles = await listFiles(resolve("src"), ".ts").catch(() => []);
  const distFiles = await listFiles(resolve("dist"), ".js").catch(() => []);
  if (srcFiles.length === 0 || distFiles.length === 0) {
    return { name: "dist freshness", ok: false, detail: "Missing src or dist files" };
  }
  const newestSrc = Math.max(...(await Promise.all(srcFiles.map(async (file) => (await stat(file)).mtimeMs))));
  const newestDist = Math.max(...(await Promise.all(distFiles.map(async (file) => (await stat(file)).mtimeMs))));
  return {
    name: "dist freshness",
    ok: newestDist >= newestSrc,
    detail: newestDist >= newestSrc ? "dist is newer than src" : "dist is older than src; run npm run build",
  };
}

async function listFiles(root: string, extension: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, extension);
    return entry.isFile() && fullPath.endsWith(extension) ? [fullPath] : [];
  }));
  return files.flat();
}

type SyncConfig = {
  sourcePaths: string[];
  apiBaseUrl: string;
  turnApiPath: string;
  hasAuth: boolean;
};

async function loadSyncConfig(): Promise<SyncConfig> {
  const storageDir = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"));
  const paths = process.env.AI_CODING_SYNC_CONFIG_FILE?.trim()
    ? [resolve(process.env.AI_CODING_SYNC_CONFIG_FILE.trim())]
    : [
        resolve("ai-token-vscode-codex-claude-code", ".ai-coding-reporter", "config.json"),
        resolve(storageDir, "config.json"),
      ];
  const configs = await Promise.all(paths.map(async (path) => {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      return { path, parsed };
    } catch {
      return null;
    }
  }));
  const loaded = configs.filter((item): item is { path: string; parsed: Record<string, unknown> } => Boolean(item));
  const merged = loaded.reduce((acc, item) => ({ ...acc, ...item.parsed }), {} as Record<string, unknown>);
  const apiBaseUrl = stringValue(process.env.AI_CODING_REPORT_API_BASE_URL)
    ?? stringValue(process.env.SYNC_API_BASE_URL)
    ?? stringValue(merged.reportApiBaseUrl)
    ?? stringValue(merged.apiBaseUrl)
    ?? "http://127.0.0.1:9906";
  const turnApiPath = normalizeApiPath(
    stringValue(process.env.AI_CODING_TURN_API_PATH)
    ?? stringValue(process.env.SYNC_TURN_API_PATH)
    ?? stringValue(merged.turnApiPath)
    ?? "/ai-codingTurns"
  );
  const hasAuth = Boolean(
    stringValue(process.env.SYNC_API_TOKEN)
    ?? stringValue(process.env.AI_CODING_ACCESS_TOKEN)
    ?? stringValue(merged.token)
    ?? stringValue(merged.accessToken)
    ?? (stringValue(process.env.AI_CODING_EXTERNAL_SYS_KEY) && stringValue(process.env.AI_CODING_EXTERNAL_SYS_SECRET))
    ?? (stringValue(merged.externalSysKey) && stringValue(merged.externalSysSecret))
  );
  return { sourcePaths: loaded.map((item) => item.path), apiBaseUrl, turnApiPath, hasAuth };
}

function checkSyncConfig(config: SyncConfig) {
  return {
    name: "sync config",
    ok: config.sourcePaths.length > 0,
    detail: config.sourcePaths.length > 0 ? `sources: ${config.sourcePaths.join(", ")}` : "No config file found; env/defaults will be used",
  };
}

function checkTurnApiPath(config: SyncConfig) {
  return {
    name: "turnApiPath",
    ok: config.turnApiPath.length > 1,
    detail: `${config.turnApiPath}; auth ${config.hasAuth ? "configured" : "not configured"}`,
  };
}

function checkAuthConfig(config: SyncConfig) {
  return {
    name: "sync auth",
    ok: config.hasAuth,
    detail: config.hasAuth ? "auth headers configured" : "No token or external sys credentials configured",
  };
}

async function checkApiConnectivity(config: SyncConfig) {
  const url = `${config.apiBaseUrl.replace(/\/+$/u, "")}${config.turnApiPath}`;
  try {
    const response = await fetch(url, { method: "OPTIONS" });
    const acceptable = response.ok || response.status === 204 || response.status === 405;
    return {
      name: "api connectivity",
      ok: acceptable,
      detail: acceptable
        ? `${url} -> HTTP ${response.status}`
        : `${url} -> HTTP ${response.status}; expected 2xx/204 or 405 from an existing route`,
    };
  } catch (error) {
    return {
      name: "api connectivity",
      ok: false,
      detail: `${url} -> ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizeApiPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/u, "") : `/${trimmed.replace(/\/+$/u, "")}`;
}

async function validateAutoRunnerProcess(pid: number, workerId: string | null, startedAt: string | null): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== "win32") {
    return { ok: true, detail: "non-Windows process validation uses pid only" };
  }
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $gp = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ CommandLine = $p.CommandLine; ExecutablePath = $p.ExecutablePath; StartTime = if ($gp -and $gp.StartTime) { $gp.StartTime.ToUniversalTime().ToString("o") } else { $null } } | ConvertTo-Json -Compress }`,
  ]);
  const output = result.output.trim();
  if (result.exitCode !== 0 || !output) {
    return { ok: false, detail: "process does not exist" };
  }
  const processInfo = parseJsonObject(output);
  const commandLine = stringValue(processInfo.CommandLine) ?? "";
  const executablePath = stringValue(processInfo.ExecutablePath) ?? "";
  const processStartedAt = stringValue(processInfo.StartTime) ?? null;
  const normalizedCommand = commandLine.replaceAll("\\", "/").toLowerCase();
  const expectedProject = process.cwd().replaceAll("\\", "/").toLowerCase();
  const expectedDistScript = resolve("dist", "auto-runner.js").replaceAll("\\", "/").toLowerCase();
  const expectedSrcScript = resolve("src", "auto-runner.ts").replaceAll("\\", "/").toLowerCase();
  const isAutoRunnerCommand =
    normalizedCommand.includes(expectedDistScript) ||
    normalizedCommand.includes(expectedSrcScript) ||
    normalizedCommand.includes("npm.cmd run auto") ||
    normalizedCommand.includes("npm run auto");
  if (!isAutoRunnerCommand) {
    return { ok: false, detail: `command line does not reference auto-runner: ${commandLine}` };
  }
  if (!normalizedCommand.includes(expectedProject)) {
    return { ok: false, detail: `command line does not reference expected project ${process.cwd()}: ${commandLine}` };
  }
  if (startedAt && processStartedAt) {
    const deltaMs = Math.abs(new Date(processStartedAt).getTime() - new Date(startedAt).getTime());
    if (Number.isFinite(deltaMs) && deltaMs > 5 * 60 * 1000) {
      return { ok: false, detail: `process start time ${processStartedAt} does not match recorded ${startedAt}` };
    }
  }
  if (workerId && !workerId.endsWith(String(pid))) {
    return { ok: false, detail: `workerId ${workerId} does not match pid ${pid}` };
  }
  return { ok: true, detail: `${commandLine}; executable=${executablePath}; started=${processStartedAt || "unknown"}` };
}

function runCommand(command: string, argv: string[]): Promise<CommandResult> {
  return new Promise((resolveRun) => {
    const child = spawnCommand(command, argv, {
      cwd: process.cwd(),
      stdio: "pipe",
      env: process.env,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      resolveRun({ exitCode: 1, output: error.message });
    });
    child.on("exit", (exitCode) => {
      resolveRun({ exitCode: exitCode ?? 1, output });
    });
  });
}

function spawnCommand(
  command: string,
  argv: string[],
  options: Parameters<typeof spawn>[2]
) {
  if (process.platform !== "win32" || !command.endsWith(".cmd")) {
    return spawn(command, argv, options);
  }

  return spawn("cmd.exe", ["/d", "/s", "/c", command, ...argv], options);
}

function parseOptions(argv: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--project-path" && next) {
      parsed.projectPath = next;
      index += 1;
    } else if (arg === "--conversation-id" && next) {
      parsed.conversationId = next;
      index += 1;
    } else if (arg === "--client" && next) {
      parsed.client = next;
      index += 1;
    } else if (arg === "--model-name" && next) {
      parsed.modelName = next;
      index += 1;
    } else if (arg === "--prompt-text" && next) {
      parsed.promptText = next;
      index += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      parsed.pollIntervalMs = next;
      index += 1;
    } else if (arg === "--settle-ms" && next) {
      parsed.settleMs = next;
      index += 1;
    } else if (arg === "--started-at" && next) {
      parsed.startedAt = next;
      index += 1;
    } else if (arg === "--turn-id" && next) {
      parsed.turnId = next;
      index += 1;
    } else if (arg === "--token-delay-ms" && next) {
      parsed.tokenDelayMs = next;
      index += 1;
    } else if (arg === "--candidate-id" && next) {
      parsed.candidateId = next;
      index += 1;
    } else if (arg === "--round-id" && next) {
      parsed.roundId = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      parsed.limit = next;
      index += 1;
    } else if (arg === "--mode" && next) {
      parsed.mode = next;
      index += 1;
    } else if (arg === "--max-age-minutes" && next) {
      parsed.maxAgeMinutes = next;
      index += 1;
    } else if (arg === "--reason" && next) {
      parsed.reason = next;
      index += 1;
    } else if (arg === "--config-path" && next) {
      parsed.configPath = next;
      index += 1;
    } else if (arg === "--api-base-url" && next) {
      parsed.apiBaseUrl = next;
      index += 1;
    } else if (arg === "--report-api-base-url" && next) {
      parsed.reportApiBaseUrl = next;
      index += 1;
    } else if (arg === "--turn-api-path" && next) {
      parsed.turnApiPath = next;
      index += 1;
    } else if (arg === "--employee-id" && next) {
      parsed.employeeId = next;
      index += 1;
    } else if (arg === "--user-name" && next) {
      parsed.userName = next;
      index += 1;
    } else if (arg === "--team-id" && next) {
      parsed.teamId = next;
      index += 1;
    } else if (arg === "--token" && next) {
      parsed.token = next;
      index += 1;
    } else if (arg === "--access-token" && next) {
      parsed.accessToken = next;
      index += 1;
    } else if (arg === "--external-sys-key" && next) {
      parsed.externalSysKey = next;
      index += 1;
    } else if (arg === "--external-sys-secret" && next) {
      parsed.externalSysSecret = next;
      index += 1;
    } else if (arg === "--no-sync-online") {
      parsed.noSyncOnline = true;
    } else if (arg === "--no-pipeline") {
      parsed.noPipeline = true;
    } else if (arg === "--no-tokens") {
      parsed.noTokens = true;
    } else if (arg === "--all") {
      parsed.all = true;
    }
  }

  return parsed as {
    projectPath?: string;
    conversationId?: string;
    client?: string;
    modelName?: string;
    promptText?: string;
    pollIntervalMs?: string;
    settleMs?: string;
    startedAt?: string;
    turnId?: string;
    tokenDelayMs?: string;
    candidateId?: string;
    roundId?: string;
    limit?: string;
    mode?: string;
    maxAgeMinutes?: string;
    reason?: string;
    configPath?: string;
    apiBaseUrl?: string;
    reportApiBaseUrl?: string;
    turnApiPath?: string;
    employeeId?: string;
    userName?: string;
    teamId?: string;
    token?: string;
    accessToken?: string;
    externalSysKey?: string;
    externalSysSecret?: string;
    noSyncOnline?: boolean;
    noPipeline?: boolean;
    noTokens?: boolean;
    all?: boolean;
  };
}

function currentJobStartedAt(state: Awaited<ReturnType<typeof getAutoSyncState>>): string | null {
  if (!state?.currentStep) return null;
  if (state.currentStep.includes("token")) return state.lastTokenSyncStartedAt ?? null;
  if (state.currentStep.includes("online")) return state.lastOnlineSyncStartedAt ?? null;
  return null;
}

function isCurrentJobStale(state: Awaited<ReturnType<typeof getAutoSyncState>>): boolean {
  if (!state?.currentStep || state.currentStatus !== "running" || !state.lastHeartbeatAt) return false;
  const ageMs = Date.now() - new Date(state.lastHeartbeatAt).getTime();
  return Number.isFinite(ageMs) && ageMs > 10 * 60 * 1000;
}

function defaultConversationId(projectPath: string): string {
  const normalized = resolve(projectPath).replaceAll("\\", "/");
  return `codex:${normalized.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase())}`;
}

function defaultConversationIdForClient(projectPath: string, client: string): string {
  const normalized = resolve(projectPath).replaceAll("\\", "/");
  return `${client}:${normalized.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase())}`;
}

function normalizeClient(value: string | undefined): "codex" | "claude-code" {
  return value === "claude-code" ? "claude-code" : "codex";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function buildDialogueTurnSummary(
  dialogueTurns: Awaited<ReturnType<typeof getDialogueTurns>>,
  rounds: Awaited<ReturnType<typeof getRounds>>,
  tokenEvents: Awaited<ReturnType<typeof getTokenUsageEvents>>
) {
  const roundIds = new Set(rounds.map((item) => item.id));
  const dialogueTokenEventIds = new Set(tokenEvents.filter((item) => item.roundId === null).map((item) => item.id));
  const dialogueKeys = new Set(dialogueTurns.map((item) => `${item.conversationId}::${item.turnId}`));
  const linkedRoundIds = new Set(
    dialogueTurns
      .filter((item) => item.mode === "coding_round" && item.roundId !== null)
      .map((item) => item.roundId as number)
  );
  const linkedDialogueTokenEventIds = new Set(
    dialogueTurns
      .filter((item) => item.mode === "dialogue_only" && item.tokenUsageEventId !== null)
      .map((item) => item.tokenUsageEventId as number)
  );

  const linkedRounds = dialogueTurns.filter((item) => item.mode === "coding_round" && item.roundId !== null && roundIds.has(item.roundId)).length;
  const linkedTokenUsageEvents = dialogueTurns.filter((item) => item.mode === "dialogue_only" && item.tokenUsageEventId !== null && dialogueTokenEventIds.has(item.tokenUsageEventId)).length;
  const missingRoundLinks = dialogueTurns
    .filter((item) => item.mode === "coding_round" && (item.roundId === null || !roundIds.has(item.roundId)))
    .map((item) => ({ dialogueTurnId: item.id, conversationId: item.conversationId, turnId: item.turnId, roundId: item.roundId }));
  const missingTokenEventLinks = dialogueTurns
    .filter((item) => item.mode === "dialogue_only" && (item.tokenUsageEventId === null || !dialogueTokenEventIds.has(item.tokenUsageEventId)))
    .map((item) => ({ dialogueTurnId: item.id, conversationId: item.conversationId, turnId: item.turnId, tokenUsageEventId: item.tokenUsageEventId }));
  const orphanRounds = rounds
    .filter((item) => {
      if (linkedRoundIds.has(item.id)) {
        return false;
      }
      const turnId = stringValue(item.metadata?.turnId) ?? stringValue(item.metadata?.baselineTurnId);
      return !turnId || !dialogueKeys.has(`${item.conversationId}::${turnId}`);
    })
    .map((item) => ({
      roundId: item.id,
      conversationId: item.conversationId,
      turnId: stringValue(item.metadata?.turnId) ?? stringValue(item.metadata?.baselineTurnId) ?? null,
    }));
  const orphanDialogueTokenEvents = tokenEvents
    .filter((item) => item.roundId === null)
    .filter((item) => {
      if (linkedDialogueTokenEventIds.has(item.id)) {
        return false;
      }
      return !item.turnId || !item.conversationId || !dialogueKeys.has(`${item.conversationId}::${item.turnId}`);
    })
    .map((item) => ({
      tokenUsageEventId: item.id,
      conversationId: item.conversationId ?? null,
      turnId: item.turnId ?? null,
      sourceEventId: item.sourceEventId,
    }));

  return {
    total: dialogueTurns.length,
    codingRounds: dialogueTurns.filter((item) => item.mode === "coding_round").length,
    dialogueOnly: dialogueTurns.filter((item) => item.mode === "dialogue_only").length,
    skipped: dialogueTurns.filter((item) => item.mode === "skipped").length,
    linkedRounds,
    linkedTokenUsageEvents,
    missingRoundLinks: missingRoundLinks.length,
    missingTokenEventLinks: missingTokenEventLinks.length,
    orphanRounds: orphanRounds.length,
    orphanDialogueTokenEvents: orphanDialogueTokenEvents.length,
    issues: {
      missingRoundLinks,
      missingTokenEventLinks,
      orphanRounds,
      orphanDialogueTokenEvents,
    },
  };
}

function isUploadPending(item: { _sync?: { status?: string } }): boolean {
  return !item._sync || item._sync.status === "pending";
}

function isUploadFailed(item: { _sync?: { status?: string } }): boolean {
  return item._sync?.status === "failed";
}

function isUploadSynced(item: { _sync?: { status?: string } }): boolean {
  return item._sync?.status === "synced";
}

function isUploadSkipped(item: { _sync?: { status?: string } }): boolean {
  return item._sync?.status === "skipped";
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function printHelp(): void {
  console.log(`Usage: ai-coding-stats <command>

Commands:
  start       Start the background auto-runner for the current Git workspace
  begin       Capture a Git baseline for one explicit coding round
  turn        Force one dialogue turn begin/end for host-side per-turn orchestration
  dialogue-turns Query dialogue turns as the primary reporting view
  dialogue-turns backfill Backfill missing dialogue_turns from historical rounds/token events
  baselines   List or clean stale begin/end baseline files
  finish      Record the current round, then queue token backfill and upload
  status      Print local rounds, token, upload, and worker state
  sync        Upload pending local data to the configured online API
  tokens sync Backfill pending token usage from Codex/Claude logs
  tokens pending List rounds still waiting for token usage
  tokens candidates List token candidates available for manual bind
  pipeline    Run online sync, token backfill, then online sync again
  reconcile   Backfill tokens, retry upload, then print status
  diagnose    Diagnose failed uploads, e.g. diagnose uploads
  storage     Storage doctor, backup, or export helpers
  doctor      Check local runtime prerequisites
  init-config Write .mcp-toolbox/config.json for online sync
  stop        Stop the background auto-runner started by this CLI
`);
}
