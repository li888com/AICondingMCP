import { resolveRequirementId } from "./requirement.js";
import * as localStorage from "./local-storage.js";

type TokenClient = "codex" | "claude-code";

export type RecordRoundInput = {
  conversationId: string;
  startedAt: string;
  endedAt: string;
  modelName: string;
  promptText?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesDeleted?: number;
  codeLinesChanged?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  metadata?: Record<string, unknown>;
};

export type RecordedRound = {
  id: number;
  conversationId: string;
  requirementId: number | null;
  requirementSource: "prompt" | "context" | "empty";
  modelName: string;
  durationMs: number;
  codeLinesChanged: number;
  totalTokens: number;
};

export type RecordDialogueTokenUsageInput = {
  conversationId: string;
  roundId?: number;
  client?: TokenClient;
  sourcePath?: string;
  sourceEventId?: string;
  turnId?: string;
  modelName?: string;
  startedAt?: string;
  endedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptText?: string;
  metadata?: Record<string, unknown>;
};

export type RecordedDialogueTokenUsage = {
  id: number;
  conversationId: string;
  client: TokenClient;
  turnId: string | null;
  modelName: string | null;
  totalTokens: number;
  needsProjectBinding: boolean;
  warning: string | null;
};

export type RecordRoundRevertInput = {
  conversationId: string;
  targetRoundId?: number;
  revertedAt: string;
  modelName: string;
  promptText?: string;
  reason?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesDeleted?: number;
  codeLinesChanged?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  metadata?: Record<string, unknown>;
};

export type RecordedRoundRevert = {
  id: number;
  targetRoundId: number;
  conversationId: string;
  requirementId: number | null;
  modelName: string;
  revertedAt: string;
  codeLinesChanged: number;
  totalTokens: number;
};

export function getPool() {
  throw new Error("SQL pool is not available in local storage mode");
}

export async function closePool(): Promise<void> {
  // No-op for local storage
}

export async function recordRound(input: RecordRoundInput): Promise<RecordedRound> {
  validateInput(input);

  const conversationId = normalizeConversationId(input.conversationId);
  const metadata = normalizeMetadata(input.metadata, conversationId);

  // Get or create conversation
  let conversation = await localStorage.getConversation(conversationId);
  const now = new Date().toISOString();
  if (!conversation) {
    conversation = {
      conversationId,
      currentRequirementId: null,
      lastRoundId: null,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  } else {
    conversation.lastSeenAt = now;
  }

  const resolution = resolveRequirementId(input.promptText, conversation.currentRequirementId);
  const codeLinesChanged =
    input.codeLinesChanged ?? (input.linesAdded ?? 0) + (input.linesDeleted ?? 0);
  const totalTokens = input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
  const tokenSource = totalTokens > 0 ? "mcp_payload" : "unavailable";
  const tokenMatchQuality: localStorage.TokenMatchQuality | null = totalTokens > 0 ? "mcp_payload" : null;
  const tokenSyncStatus = totalTokens > 0 ? "synced" : "pending";
  const tokenSyncNote = totalTokens > 0 ? null : "Token usage unavailable in MCP payload";

  // Create round
  const round = await localStorage.createRound({
    conversationId,
    requirementId: resolution.requirementId,
    requirementSource: resolution.source,
    modelName: input.modelName,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    promptText: input.promptText ?? null,
    filesChanged: input.filesChanged ?? null,
    linesAdded: input.linesAdded ?? 0,
    linesDeleted: input.linesDeleted ?? 0,
    codeLinesChanged,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    totalTokens,
    tokenSource,
    tokenMatchQuality,
    tokenSyncedAt: null,
    tokenSyncStatus,
    tokenSyncNote,
    metadata,
  });

  // Update conversation
  conversation.currentRequirementId = resolution.requirementId;
  conversation.lastRoundId = round.id;
  await localStorage.saveConversation(conversation);

  // Calculate duration
  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  const durationMs = endedAt.getTime() - startedAt.getTime();

  return {
    id: round.id,
    conversationId: round.conversationId,
    requirementId: round.requirementId,
    requirementSource: round.requirementSource,
    modelName: round.modelName,
    durationMs,
    codeLinesChanged: round.codeLinesChanged,
    totalTokens: round.totalTokens,
  };
}

export async function recordDialogueTokenUsage(input: RecordDialogueTokenUsageInput): Promise<RecordedDialogueTokenUsage> {
  validateDialogueTokenUsageInput(input);

  const conversationId = normalizeConversationId(input.conversationId);
  const metadata = normalizeMetadata(input.metadata, conversationId);
  const now = new Date().toISOString();

  let conversation = await localStorage.getConversation(conversationId);
  if (!conversation) {
    conversation = {
      conversationId,
      currentRequirementId: null,
      lastRoundId: null,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  } else {
    conversation.lastSeenAt = now;
  }

  const roundId = input.roundId ?? null;
  if (roundId !== null) {
    const round = await localStorage.getRound(roundId);
    if (!round || round.conversationId !== conversationId) {
      throw new Error(`Round ${roundId} not found or does not belong to this conversation`);
    }
  }
  await localStorage.saveConversation(conversation);

  const totalTokens = input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
  const warning = roundId === null ? "No roundId was provided. Please bind this dialogue to a project/AI Coding round." : null;
  const event = await localStorage.createTokenUsageEvent({
    roundId,
    client: input.client ?? "codex",
    sourcePath: input.sourcePath?.trim() || "mcp:record_dialogue_token_usage",
    sourceEventId: input.sourceEventId?.trim() || null,
    conversationId,
    turnId: input.turnId?.trim() || null,
    modelName: input.modelName?.trim() || null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? now,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    totalTokens,
    matchQuality: totalTokens > 0 ? "mcp_payload" : null,
    rawEvent: {
      ...(metadata ? { metadata } : {}),
      ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
      tokenStatsSource: totalTokens > 0 ? "mcp_payload" : "unavailable",
      needsProjectBinding: roundId === null,
      warning,
    },
  });

  return {
    id: event.id,
    conversationId: event.conversationId ?? conversationId,
    client: event.client,
    turnId: event.turnId,
    modelName: event.modelName,
    totalTokens: event.totalTokens,
    needsProjectBinding: event.roundId === null,
    warning,
  };
}

export async function recordRoundRevert(input: RecordRoundRevertInput): Promise<RecordedRoundRevert> {
  validateRevertInput(input);

  const conversationId = normalizeConversationId(input.conversationId);
  const metadata = normalizeMetadata(input.metadata, conversationId);

  // Get or create conversation
  let conversation = await localStorage.getConversation(conversationId);
  const now = new Date().toISOString();
  if (!conversation) {
    conversation = {
      conversationId,
      currentRequirementId: null,
      lastRoundId: null,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  } else {
    conversation.lastSeenAt = now;
  }
  await localStorage.saveConversation(conversation);

  // Resolve target round id
  let targetRoundId = input.targetRoundId;
  if (targetRoundId === undefined) {
    const rounds = await localStorage.getRoundsByConversation(conversationId);
    const reverts = await localStorage.getRoundReverts();
    const revertedRoundIds = new Set(reverts.map((revert) => revert.targetRoundId));
    const activeRounds = rounds
      .filter((round) => !revertedRoundIds.has(round.id))
      .sort((a, b) => {
        const dateA = new Date(a.endedAt);
        const dateB = new Date(b.endedAt);
        if (dateB.getTime() !== dateA.getTime()) {
          return dateB.getTime() - dateA.getTime();
        }
        return b.id - a.id;
      });
    if (activeRounds.length === 0) {
      throw new Error(`No active round found for conversation ${input.conversationId}`);
    }
    targetRoundId = activeRounds[0].id;
  }

  // Validate target round exists and is not already reverted
  const targetRound = await localStorage.getRound(targetRoundId);
  if (!targetRound || targetRound.conversationId !== conversationId) {
    throw new Error(`Round ${targetRoundId} not found or does not belong to this conversation`);
  }
  const existingRevert = await localStorage.getRoundRevertByTarget(targetRoundId);
  if (existingRevert) {
    throw new Error(`Round ${targetRoundId} is already reverted`);
  }

  const codeLinesChanged =
    input.codeLinesChanged ?? (input.linesAdded ?? 0) + (input.linesDeleted ?? 0);
  const totalTokens = input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);

  // Create revert
  const revert = await localStorage.createRoundRevert({
    targetRoundId,
    conversationId,
    modelName: input.modelName,
    promptText: input.promptText ?? null,
    revertedAt: input.revertedAt,
    reason: input.reason ?? null,
    filesChanged: input.filesChanged ?? null,
    linesAdded: input.linesAdded ?? 0,
    linesDeleted: input.linesDeleted ?? 0,
    codeLinesChanged,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    totalTokens,
    metadata,
  });

  return {
    id: revert.id,
    targetRoundId: revert.targetRoundId,
    conversationId: revert.conversationId,
    requirementId: targetRound.requirementId,
    modelName: revert.modelName,
    revertedAt: revert.revertedAt,
    codeLinesChanged: revert.codeLinesChanged,
    totalTokens: revert.totalTokens,
  };
}

function normalizeConversationId(conversationId: string): string {
  return conversationId.trim().replaceAll("\\", "/");
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
  conversationId: string
): Record<string, unknown> | null {
  const normalized: Record<string, unknown> = metadata ? { ...metadata } : {};

  if (typeof normalized.client === "string") {
    normalized.client = normalized.client.trim();
  }

  const projectPath =
    typeof normalized.projectPath === "string" && normalized.projectPath.trim()
      ? normalized.projectPath
      : projectFromConversationId(conversationId);

  if (projectPath) {
    normalized.projectPath = normalizePathForMetadata(projectPath);
  }

  if (Object.keys(normalized).length === 0) {
    return null;
  }

  return normalized;
}

function projectFromConversationId(conversationId: string): string | undefined {
  const match = conversationId.match(/^(?:codex|claude):(.+?)(?::[^/].*)?$/);
  return match?.[1];
}

function normalizePathForMetadata(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function validateInput(input: RecordRoundInput): void {
  if (!input.conversationId.trim()) {
    throw new Error("conversationId is required");
  }

  if (!input.modelName.trim()) {
    throw new Error("modelName is required");
  }

  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.endedAt);
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error("startedAt must be a valid date-time string");
  }

  if (Number.isNaN(endedAt.getTime())) {
    throw new Error("endedAt must be a valid date-time string");
  }

  if (endedAt.getTime() < startedAt.getTime()) {
    throw new Error("endedAt must be greater than or equal to startedAt");
  }
}

function validateDialogueTokenUsageInput(input: RecordDialogueTokenUsageInput): void {
  if (!input.conversationId.trim()) {
    throw new Error("conversationId is required");
  }

  if (input.client !== undefined && input.client !== "codex" && input.client !== "claude-code") {
    throw new Error("client must be codex or claude-code");
  }

  if (input.roundId !== undefined && (!Number.isSafeInteger(input.roundId) || input.roundId <= 0)) {
    throw new Error("roundId must be a positive integer");
  }

  if (input.startedAt !== undefined && Number.isNaN(new Date(input.startedAt).getTime())) {
    throw new Error("startedAt must be a valid date-time string");
  }

  if (input.endedAt !== undefined && Number.isNaN(new Date(input.endedAt).getTime())) {
    throw new Error("endedAt must be a valid date-time string");
  }

  if (input.startedAt !== undefined && input.endedAt !== undefined) {
    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);
    if (endedAt.getTime() < startedAt.getTime()) {
      throw new Error("endedAt must be greater than or equal to startedAt");
    }
  }
}

function validateRevertInput(input: RecordRoundRevertInput): void {
  if (!input.conversationId.trim()) {
    throw new Error("conversationId is required");
  }

  if (!input.modelName.trim()) {
    throw new Error("modelName is required");
  }

  if (input.targetRoundId !== undefined && (!Number.isSafeInteger(input.targetRoundId) || input.targetRoundId <= 0)) {
    throw new Error("targetRoundId must be a positive integer");
  }

  const revertedAt = new Date(input.revertedAt);
  if (Number.isNaN(revertedAt.getTime())) {
    throw new Error("revertedAt must be a valid date-time string");
  }
}
