import { readFile, writeFile, mkdir, rmdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const LEGACY_STORAGE_DIR = join(homedir(), ".mcp-toolbox");
const DEFAULT_STORAGE_DIR = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"));
const STORAGE_FILE = "data.json";
const LOCK_DIR = ".lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 50;

type Conversation = {
  conversationId: string;
  currentRequirementId: number | null;
  lastRoundId: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

type Requirement = {
  requirementId: number;
  title: string | null;
  projectName: string | null;
  gpmNumber: string | null;
  status: "active" | "done" | "archived";
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

type SyncStatus = "pending" | "synced" | "skipped" | "failed";

type SyncState = {
  status: SyncStatus;
  onlineId?: number;
  syncedAt?: string;
  error?: string;
};

type TokenMatchQuality =
  | "mcp_payload"
  | "exact_tool_call"
  | "turn_id"
  | "prompt_tool_call"
  | "time_window"
  | "manual";

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
  tokenMatchQuality: TokenMatchQuality | null;
  tokenSyncedAt: string | null;
  tokenSyncStatus: string;
  tokenSyncNote: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  _sync?: SyncState;
};

type RoundRevert = {
  id: number;
  targetRoundId: number;
  conversationId: string;
  modelName: string;
  promptText: string | null;
  revertedAt: string;
  reason: string | null;
  filesChanged: number | null;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  _sync?: SyncState;
};

type TokenUsageEvent = {
  id: number;
  roundId: number | null;
  client: "codex" | "claude-code";
  sourcePath: string;
  sourceEventId: string | null;
  conversationId: string | null;
  turnId: string | null;
  modelName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  matchQuality: TokenMatchQuality | null;
  rawEvent: Record<string, unknown> | null;
  createdAt: string;
  _sync?: SyncState;
};

type TokenUsageCandidate = {
  id: number;
  roundId: number;
  client: "codex" | "claude-code";
  sourcePath: string;
  sourceEventId: string | null;
  conversationId: string | null;
  turnId: string | null;
  modelName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  matchQuality: TokenMatchQuality | null;
  note: string | null;
  rawEvent: Record<string, unknown> | null;
  selectedAt: string | null;
  createdAt: string;
};

type AiCodingCorrection = {
  id: number;
  correctionType: "token_manual_bind" | "token_reset" | "round_update" | "round_ignore" | "round_restore";
  targetType: "round" | "token_usage_candidate" | "token_usage_event";
  targetId: number | null;
  roundId: number | null;
  actor: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

type AutoSyncState = {
  workerId: string | null;
  status: "idle" | "running" | "stopped" | "failed";
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastTokenSyncSince: string | null;
  lastTokenSyncAt: string | null;
  lastOnlineSyncAt: string | null;
  lastTokenSyncStatus: string | null;
  lastOnlineSyncStatus: string | null;
  lastTokenSyncSummary: Record<string, unknown> | null;
  lastOnlineSyncSummary: Record<string, unknown> | null;
  lastError: string | null;
  updatedAt: string;
};

type StorageData = {
  conversations: Conversation[];
  requirements: Requirement[];
  rounds: Round[];
  roundReverts: RoundRevert[];
  tokenUsageEvents: TokenUsageEvent[];
  tokenUsageCandidates: TokenUsageCandidate[];
  aiCodingCorrections: AiCodingCorrection[];
  autoSyncState: AutoSyncState | null;
  nextRoundId: number;
  nextRoundRevertId: number;
  nextTokenUsageEventId: number;
  nextTokenUsageCandidateId: number;
  nextAiCodingCorrectionId: number;
};

let storageDir = DEFAULT_STORAGE_DIR;
let cachedData: StorageData | null = null;
let lastModified: number = 0;

export function setStorageDir(dir: string) {
  storageDir = dir;
  cachedData = null;
}

function getStoragePath(): string {
  return join(storageDir, STORAGE_FILE);
}

async function ensureStorageDir(): Promise<void> {
  try {
    await mkdir(storageDir, { recursive: true });
  } catch {
    // Directory already exists or error will be thrown when writing
  }
}

async function withStorageLock<T>(action: () => Promise<T>): Promise<T> {
  await ensureStorageDir();
  const lockPath = join(storageDir, LOCK_DIR);

  // Acquire lock via atomic mkdir.
  // This is intentionally simple: it's meant to avoid concurrent writes corrupting JSON.
  // If the lock is stale, it is removed and acquisition retried.
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }

      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lockPath).catch(() => undefined);
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS)));
    }
  }

  try {
    return await action();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

async function loadData(forceReload = false): Promise<StorageData> {
  const storagePath = getStoragePath();

  try {
    const stats = await stat(storagePath);
    if (!forceReload && cachedData && stats.mtimeMs === lastModified) {
      return cachedData;
    }

    const content = await readFile(storagePath, "utf8");
    cachedData = normalizeStorageData(JSON.parse(content));
    lastModified = stats.mtimeMs;
    return cachedData;
  } catch {
    // Migrate from legacy path if present.
    const legacyPath = join(LEGACY_STORAGE_DIR, STORAGE_FILE);
    if (storagePath !== legacyPath) {
      try {
        const legacyContent = await readFile(legacyPath, "utf8");
        const migrated = normalizeStorageData(JSON.parse(legacyContent));
        await saveData(migrated);
        return migrated;
      } catch {
        // ignore migration failures, fall back to empty data
      }
    }

    // File doesn't exist, return empty data
    const emptyData: StorageData = {
      conversations: [],
      requirements: [],
      rounds: [],
      roundReverts: [],
      tokenUsageEvents: [],
      tokenUsageCandidates: [],
      aiCodingCorrections: [],
      autoSyncState: null,
      nextRoundId: 1,
      nextRoundRevertId: 1,
      nextTokenUsageEventId: 1,
      nextTokenUsageCandidateId: 1,
      nextAiCodingCorrectionId: 1,
    };
    await saveData(emptyData);
    return emptyData;
  }
}

function normalizeStorageData(value: unknown): StorageData {
  const data = isRecord(value) ? value : {};
  const storage = data as Partial<StorageData>;

  storage.conversations = Array.isArray(storage.conversations) ? storage.conversations : [];
  storage.requirements = Array.isArray(storage.requirements) ? storage.requirements : [];
  storage.rounds = Array.isArray(storage.rounds) ? storage.rounds : [];
  storage.roundReverts = Array.isArray(storage.roundReverts) ? storage.roundReverts : [];
  storage.tokenUsageEvents = Array.isArray(storage.tokenUsageEvents) ? storage.tokenUsageEvents : [];
  storage.tokenUsageCandidates = Array.isArray(storage.tokenUsageCandidates) ? storage.tokenUsageCandidates : [];
  storage.aiCodingCorrections = Array.isArray(storage.aiCodingCorrections) ? storage.aiCodingCorrections : [];
  storage.autoSyncState = normalizeAutoSyncState(storage.autoSyncState);

  storage.nextRoundId = normalizeNextId(storage.nextRoundId, storage.rounds);
  storage.nextRoundRevertId = normalizeNextId(storage.nextRoundRevertId, storage.roundReverts);
  storage.nextTokenUsageEventId = normalizeNextId(storage.nextTokenUsageEventId, storage.tokenUsageEvents);
  storage.nextTokenUsageCandidateId = normalizeNextId(storage.nextTokenUsageCandidateId, storage.tokenUsageCandidates);
  storage.nextAiCodingCorrectionId = normalizeNextId(storage.nextAiCodingCorrectionId, storage.aiCodingCorrections);

  return storage as StorageData;
}

function normalizeNextId(value: unknown, rows: Array<{ id?: unknown }>): number {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }

  const maxId = rows.reduce((max, row) => {
    const id = Number(row.id);
    return Number.isSafeInteger(id) && id > max ? id : max;
  }, 0);
  return maxId + 1;
}

function normalizeAutoSyncState(value: unknown): AutoSyncState | null {
  if (!isRecord(value)) return null;
  return {
    workerId: typeof value.workerId === "string" ? value.workerId : null,
    status: ["idle", "running", "stopped", "failed"].includes(String(value.status))
      ? value.status as AutoSyncState["status"]
      : "idle",
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    lastHeartbeatAt: typeof value.lastHeartbeatAt === "string" ? value.lastHeartbeatAt : null,
    lastTokenSyncSince: typeof value.lastTokenSyncSince === "string" ? value.lastTokenSyncSince : null,
    lastTokenSyncAt: typeof value.lastTokenSyncAt === "string" ? value.lastTokenSyncAt : null,
    lastOnlineSyncAt: typeof value.lastOnlineSyncAt === "string" ? value.lastOnlineSyncAt : null,
    lastTokenSyncStatus: typeof value.lastTokenSyncStatus === "string" ? value.lastTokenSyncStatus : null,
    lastOnlineSyncStatus: typeof value.lastOnlineSyncStatus === "string" ? value.lastOnlineSyncStatus : null,
    lastTokenSyncSummary: isRecord(value.lastTokenSyncSummary) ? value.lastTokenSyncSummary : null,
    lastOnlineSyncSummary: isRecord(value.lastOnlineSyncSummary) ? value.lastOnlineSyncSummary : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveData(data: StorageData): Promise<void> {
  await ensureStorageDir();
  const storagePath = getStoragePath();
  const content = JSON.stringify(data, null, 2);
  await writeFile(storagePath, content, "utf8");
  cachedData = data;
  const stats = await stat(storagePath);
  lastModified = stats.mtimeMs;
}

export type {
  Conversation,
  Requirement,
  Round,
  RoundRevert,
  SyncState,
  SyncStatus,
  TokenMatchQuality,
  TokenUsageEvent,
  TokenUsageCandidate,
  AiCodingCorrection,
  AutoSyncState,
  StorageData
};

export async function getConversations(): Promise<Conversation[]> {
  const data = await loadData();
  return data.conversations;
}

export async function getConversation(conversationId: string): Promise<Conversation | undefined> {
  const data = await loadData();
  return data.conversations.find((c) => c.conversationId === conversationId);
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.conversations.findIndex((c) => c.conversationId === conversation.conversationId);
    if (index >= 0) {
      data.conversations[index] = conversation;
    } else {
      data.conversations.push(conversation);
    }
    await saveData(data);
  });
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.conversations.findIndex((c) => c.conversationId === conversationId);
    if (index >= 0) {
      data.conversations.splice(index, 1);
      await saveData(data);
      return true;
    }
    return false;
  });
}

export async function getRequirements(): Promise<Requirement[]> {
  const data = await loadData();
  return data.requirements;
}

export async function getRequirement(requirementId: number): Promise<Requirement | undefined> {
  const data = await loadData();
  return data.requirements.find((r) => r.requirementId === requirementId);
}

export async function saveRequirement(requirement: Requirement): Promise<void> {
  await withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.requirements.findIndex((r) => r.requirementId === requirement.requirementId);
    if (index >= 0) {
      data.requirements[index] = requirement;
    } else {
      data.requirements.push(requirement);
    }
    await saveData(data);
  });
}

export async function deleteRequirement(requirementId: number): Promise<boolean> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.requirements.findIndex((r) => r.requirementId === requirementId);
    if (index >= 0) {
      data.requirements.splice(index, 1);
      await saveData(data);
      return true;
    }
    return false;
  });
}

export async function getRounds(): Promise<Round[]> {
  const data = await loadData();
  return data.rounds;
}

export async function getRound(id: number): Promise<Round | undefined> {
  const data = await loadData();
  return data.rounds.find((r) => r.id === id);
}

export async function getRoundsByConversation(conversationId: string): Promise<Round[]> {
  const data = await loadData();
  return data.rounds.filter((r) => r.conversationId === conversationId);
}

export async function createRound(round: Omit<Round, "id" | "createdAt">): Promise<Round> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const id = data.nextRoundId++;
    const createdAt = new Date().toISOString();
    const newRound: Round = { ...round, id, createdAt };
    data.rounds.push(newRound);
    await saveData(data);
    return newRound;
  });
}

export async function updateRound(round: Round): Promise<void> {
  await withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.rounds.findIndex((r) => r.id === round.id);
    if (index >= 0) {
      data.rounds[index] = round;
      await saveData(data);
      return;
    }
    throw new Error(`Round ${round.id} not found`);
  });
}

export async function deleteRound(id: number): Promise<boolean> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.rounds.findIndex((r) => r.id === id);
    if (index >= 0) {
      data.rounds.splice(index, 1);
      data.tokenUsageEvents = data.tokenUsageEvents.filter((event) => event.roundId !== id);
      data.tokenUsageCandidates = data.tokenUsageCandidates.filter((candidate) => candidate.roundId !== id);
      data.aiCodingCorrections = data.aiCodingCorrections.filter((correction) => correction.roundId !== id);
      await saveData(data);
      return true;
    }
    return false;
  });
}

export async function getRoundReverts(): Promise<RoundRevert[]> {
  const data = await loadData();
  return data.roundReverts;
}

export async function getRoundRevertByTarget(targetRoundId: number): Promise<RoundRevert | undefined> {
  const data = await loadData();
  return data.roundReverts.find((rr) => rr.targetRoundId === targetRoundId);
}

export async function createRoundRevert(revert: Omit<RoundRevert, "id" | "createdAt">): Promise<RoundRevert> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const id = data.nextRoundRevertId++;
    const createdAt = new Date().toISOString();
    const newRevert: RoundRevert = { ...revert, id, createdAt };
    data.roundReverts.push(newRevert);
    await saveData(data);
    return newRevert;
  });
}

export async function deleteRoundRevertByTarget(targetRoundId: number): Promise<boolean> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.roundReverts.findIndex((revert) => revert.targetRoundId === targetRoundId);
    if (index >= 0) {
      data.roundReverts.splice(index, 1);
      await saveData(data);
      return true;
    }
    return false;
  });
}

export async function getTokenUsageEvents(): Promise<TokenUsageEvent[]> {
  const data = await loadData();
  return data.tokenUsageEvents;
}

export async function createTokenUsageEvent(event: Omit<TokenUsageEvent, "id" | "createdAt">): Promise<TokenUsageEvent> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const id = data.nextTokenUsageEventId++;
    const createdAt = new Date().toISOString();
    const newEvent: TokenUsageEvent = { ...event, id, createdAt };
    data.tokenUsageEvents.push(newEvent);
    await saveData(data);
    return newEvent;
  });
}

export async function deleteTokenUsageEventsByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const before = data.tokenUsageEvents.length;
    data.tokenUsageEvents = data.tokenUsageEvents.filter((event) => event.roundId !== roundId);
    const deleted = before - data.tokenUsageEvents.length;
    if (deleted > 0) {
      await saveData(data);
    }
    return deleted;
  });
}

export async function getTokenUsageCandidates(roundId?: number): Promise<TokenUsageCandidate[]> {
  const data = await loadData();
  const candidates = data.tokenUsageCandidates;
  return roundId === undefined ? candidates : candidates.filter((candidate) => candidate.roundId === roundId);
}

export async function getTokenUsageCandidate(id: number): Promise<TokenUsageCandidate | undefined> {
  const data = await loadData();
  return data.tokenUsageCandidates.find((candidate) => candidate.id === id);
}

export async function replaceTokenUsageCandidates(
  roundId: number,
  client: "codex" | "claude-code",
  candidates: Array<Omit<TokenUsageCandidate, "id" | "createdAt" | "selectedAt">>
): Promise<TokenUsageCandidate[]> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    data.tokenUsageCandidates = data.tokenUsageCandidates.filter(
      (candidate) => !(candidate.roundId === roundId && candidate.client === client && candidate.selectedAt === null)
    );

    const createdAt = new Date().toISOString();
    const created = candidates.map((candidate) => {
      const id = data.nextTokenUsageCandidateId++;
      return { ...candidate, id, createdAt, selectedAt: null };
    });

    data.tokenUsageCandidates.push(...created);
    await saveData(data);
    return created;
  });
}

export async function updateTokenUsageCandidate(candidate: TokenUsageCandidate): Promise<void> {
  await withStorageLock(async () => {
    const data = await loadData(true);
    const index = data.tokenUsageCandidates.findIndex((item) => item.id === candidate.id);
    if (index >= 0) {
      data.tokenUsageCandidates[index] = candidate;
      await saveData(data);
      return;
    }
    throw new Error(`Token usage candidate ${candidate.id} not found`);
  });
}

export async function deleteTokenUsageCandidatesByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const before = data.tokenUsageCandidates.length;
    data.tokenUsageCandidates = data.tokenUsageCandidates.filter((candidate) => candidate.roundId !== roundId);
    const deleted = before - data.tokenUsageCandidates.length;
    if (deleted > 0) {
      await saveData(data);
    }
    return deleted;
  });
}

export async function createAiCodingCorrection(
  correction: Omit<AiCodingCorrection, "id" | "createdAt">
): Promise<AiCodingCorrection> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const id = data.nextAiCodingCorrectionId++;
    const createdAt = new Date().toISOString();
    const newCorrection: AiCodingCorrection = { ...correction, id, createdAt };
    data.aiCodingCorrections.push(newCorrection);
    await saveData(data);
    return newCorrection;
  });
}

export async function getAiCodingCorrections(roundId?: number): Promise<AiCodingCorrection[]> {
  const data = await loadData();
  const corrections = data.aiCodingCorrections;
  return roundId === undefined ? corrections : corrections.filter((correction) => correction.roundId === roundId);
}

export async function getAutoSyncState(): Promise<AutoSyncState | null> {
  const data = await loadData();
  return data.autoSyncState;
}

export async function saveAutoSyncState(state: AutoSyncState): Promise<void> {
  await withStorageLock(async () => {
    const data = await loadData(true);
    data.autoSyncState = state;
    await saveData(data);
  });
}

export async function patchAutoSyncState(patch: Partial<AutoSyncState>): Promise<AutoSyncState> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const now = new Date().toISOString();
    const current: AutoSyncState = data.autoSyncState ?? {
      workerId: null,
      status: "idle",
      startedAt: null,
      lastHeartbeatAt: null,
      lastTokenSyncSince: null,
      lastTokenSyncAt: null,
      lastOnlineSyncAt: null,
      lastTokenSyncStatus: null,
      lastOnlineSyncStatus: null,
      lastTokenSyncSummary: null,
      lastOnlineSyncSummary: null,
      lastError: null,
      updatedAt: now,
    };
    const next: AutoSyncState = { ...current, ...patch, updatedAt: now };
    data.autoSyncState = next;
    await saveData(data);
    return next;
  });
}

export async function deleteAiCodingCorrectionsByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const data = await loadData(true);
    const before = data.aiCodingCorrections.length;
    data.aiCodingCorrections = data.aiCodingCorrections.filter((correction) => correction.roundId !== roundId);
    const deleted = before - data.aiCodingCorrections.length;
    if (deleted > 0) {
      await saveData(data);
    }
    return deleted;
  });
}

export async function clearAllData(): Promise<void> {
  await withStorageLock(async () => {
    const emptyData: StorageData = {
      conversations: [],
      requirements: [],
      rounds: [],
      roundReverts: [],
      tokenUsageEvents: [],
      tokenUsageCandidates: [],
      aiCodingCorrections: [],
      autoSyncState: null,
      nextRoundId: 1,
      nextRoundRevertId: 1,
      nextTokenUsageEventId: 1,
      nextTokenUsageCandidateId: 1,
      nextAiCodingCorrectionId: 1,
    };
    await saveData(emptyData);
  });
}
