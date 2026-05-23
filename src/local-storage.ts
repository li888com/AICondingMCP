import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const LEGACY_STORAGE_DIR = join(homedir(), ".mcp-toolbox");
const DEFAULT_STORAGE_DIR = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"));
const STORAGE_FILE = "data.json";
const SQLITE_FILE = "storage.db";

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
  onlineId?: number | string;
  syncedAt?: string;
  error?: string;
  failedAttempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
};

type TokenMatchQuality =
  | "mcp_payload"
  | "exact_tool_call"
  | "turn_id"
  | "prompt_tool_call"
  | "time_window"
  | "manual"
  | "ambiguous";

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

type DialogueTurn = {
  id: number;
  conversationId: string;
  turnId: string;
  client: "codex" | "claude-code";
  modelName: string;
  startedAt: string;
  endedAt: string;
  promptText: string | null;
  mode: "coding_round" | "dialogue_only" | "skipped";
  projectPath: string | null;
  roundId: number | null;
  tokenUsageEventId: number | null;
  sourceEventId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
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
  pid: number | null;
  status: "idle" | "running" | "stopped" | "failed";
  currentStep?: string | null;
  currentStatus?: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastTokenSyncSince: string | null;
  lastTokenSyncAt: string | null;
  lastTokenSyncStartedAt?: string | null;
  lastTokenSyncFinishedAt?: string | null;
  lastOnlineSyncAt: string | null;
  lastOnlineSyncStartedAt?: string | null;
  lastOnlineSyncFinishedAt?: string | null;
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
  dialogueTurns: DialogueTurn[];
  tokenUsageCandidates: TokenUsageCandidate[];
  aiCodingCorrections: AiCodingCorrection[];
  autoSyncState: AutoSyncState | null;
  nextRoundId: number;
  nextRoundRevertId: number;
  nextTokenUsageEventId: number;
  nextDialogueTurnId: number;
  nextTokenUsageCandidateId: number;
  nextAiCodingCorrectionId: number;
};

let storageDir = DEFAULT_STORAGE_DIR;
let cachedData: StorageData | null = null;
let db: Database.Database | null = null;
let dbPath: string | null = null;

export function setStorageDir(dir: string) {
  storageDir = resolve(dir);
  cachedData = null;
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}

function getStoragePath(): string {
  return join(storageDir, STORAGE_FILE);
}

function getSqlitePath(): string {
  return resolve(process.env.MCP_TOOLBOX_SQLITE_FILE?.trim() || join(storageDir, SQLITE_FILE));
}

async function ensureStorageDir(): Promise<void> {
  try {
    await mkdir(storageDir, { recursive: true });
  } catch {
    // Directory already exists or error will be thrown when writing
  }
}

function ensureStorageDirSync(): void {
  mkdirSync(storageDir, { recursive: true });
}

function getDb(): Database.Database {
  const path = getSqlitePath();
  if (db && dbPath === path) {
    return db;
  }

  if (db) {
    db.close();
  }

  ensureStorageDirSync();
  db = new Database(path);
  dbPath = path;
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  initializeSchema(db);
  migrateJsonIfNeeded(db);
  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requirements (
      requirement_id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      token_sync_status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS round_reverts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_round_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      reverted_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NULL,
      client TEXT NOT NULL,
      source_event_id TEXT NULL,
      ended_at TEXT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dialogue_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_event_id TEXT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_usage_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      client TEXT NOT NULL,
      selected_at TEXT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_coding_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auto_sync_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_conversation_id ON rounds(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_token_sync_status ON rounds(token_sync_status);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_round_id ON token_usage_events(round_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_turns_conversation_id ON dialogue_turns(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_candidates_round_id ON token_usage_candidates(round_id);
    CREATE INDEX IF NOT EXISTS idx_corrections_round_id ON ai_coding_corrections(round_id);
  `);
  ensureColumn(database, "rounds", "upload_status", "TEXT NULL");
  ensureColumn(database, "rounds", "demand_id", "TEXT NULL");
  ensureColumn(database, "rounds", "demand_code", "TEXT NULL");
  ensureColumn(database, "rounds", "client", "TEXT NULL");
  ensureColumn(database, "rounds", "model_name", "TEXT NULL");
  ensureColumn(database, "rounds", "project_path", "TEXT NULL");
  ensureColumn(database, "rounds", "started_at", "TEXT NULL");
  ensureColumn(database, "round_reverts", "upload_status", "TEXT NULL");
  ensureColumn(database, "round_reverts", "model_name", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "upload_status", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "conversation_id", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "turn_id", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "model_name", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "started_at", "TEXT NULL");
  ensureColumn(database, "token_usage_events", "total_tokens", "INTEGER NULL");
  ensureColumn(database, "dialogue_turns", "project_path", "TEXT NULL");
  ensureColumn(database, "dialogue_turns", "model_name", "TEXT NULL");
  ensureColumn(database, "dialogue_turns", "client", "TEXT NULL");
  ensureColumn(database, "token_usage_candidates", "source_event_id", "TEXT NULL");
  ensureColumn(database, "token_usage_candidates", "ended_at", "TEXT NULL");
  ensureColumn(database, "token_usage_candidates", "total_tokens", "INTEGER NULL");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_rounds_upload_status ON rounds(upload_status);
    CREATE INDEX IF NOT EXISTS idx_rounds_demand_id ON rounds(demand_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_client ON rounds(client);
    CREATE INDEX IF NOT EXISTS idx_rounds_model_name ON rounds(model_name);
    CREATE INDEX IF NOT EXISTS idx_rounds_project_path ON rounds(project_path);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_upload_status ON token_usage_events(upload_status);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_turn_id ON token_usage_events(turn_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_total_tokens ON token_usage_events(total_tokens);
    CREATE INDEX IF NOT EXISTS idx_dialogue_turns_turn_id ON dialogue_turns(turn_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dialogue_turns_conversation_turn_unique ON dialogue_turns(conversation_id, turn_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_candidates_source_event_id ON token_usage_candidates(source_event_id);
  `);
  enforceTokenSourceEventUniqueness(database);
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function enforceTokenSourceEventUniqueness(database: Database.Database): void {
  const duplicateIds = database.prepare(`
    SELECT id
    FROM token_usage_events
    WHERE source_event_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM token_usage_events
        WHERE source_event_id IS NOT NULL
        GROUP BY source_event_id
      )
  `).all() as Array<{ id: number }>;

  for (const row of duplicateIds) {
    const payloadRow = database.prepare("SELECT payload_json FROM token_usage_events WHERE id = ?").get(row.id) as { payload_json: string } | undefined;
    if (!payloadRow) continue;
    const event = parseJson<TokenUsageEvent>(payloadRow.payload_json);
    const nextEvent = { ...event, sourceEventId: null };
    database.prepare("UPDATE token_usage_events SET source_event_id = NULL, payload_json = ? WHERE id = ?")
      .run(json(nextEvent), row.id);
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_events_source_event_id_unique
    ON token_usage_events(source_event_id)
    WHERE source_event_id IS NOT NULL;
  `);
}

function migrateJsonIfNeeded(database: Database.Database): void {
  const migrated = database.prepare("SELECT value FROM storage_meta WHERE key = ?").get("json_migrated") as { value: string } | undefined;
  if (migrated?.value === "1") {
    return;
  }

  const storagePath = getStoragePath();
  const legacyPath = join(LEGACY_STORAGE_DIR, STORAGE_FILE);
  const sourcePath = existsSync(storagePath) ? storagePath : existsSync(legacyPath) ? legacyPath : null;
  if (!sourcePath) {
    database.prepare("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)").run("json_migrated", "1");
    return;
  }

  const data = normalizeStorageData(JSON.parse(stripBom(readFileSync(sourcePath, "utf8"))));
  const transaction = database.transaction(() => {
    saveDataSync(database, data);
    database.prepare("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)").run("json_migrated", "1");
    database.prepare("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)").run("json_migration_source", sourcePath);
    database.prepare("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)").run("json_migrated_at", new Date().toISOString());
  });
  transaction();
}

async function withStorageLock<T>(action: () => Promise<T>): Promise<T> {
  return action();
}

async function loadData(forceReload = false): Promise<StorageData> {
  cachedData = loadDataSync(getDb());
  return cachedData;
}

function normalizeStorageData(value: unknown): StorageData {
  const data = isRecord(value) ? value : {};
  const storage = data as Partial<StorageData>;

  storage.conversations = Array.isArray(storage.conversations) ? storage.conversations : [];
  storage.requirements = Array.isArray(storage.requirements) ? storage.requirements : [];
  storage.rounds = Array.isArray(storage.rounds) ? storage.rounds : [];
  storage.roundReverts = Array.isArray(storage.roundReverts) ? storage.roundReverts : [];
  storage.tokenUsageEvents = Array.isArray(storage.tokenUsageEvents) ? storage.tokenUsageEvents : [];
  storage.dialogueTurns = Array.isArray(storage.dialogueTurns) ? storage.dialogueTurns : [];
  storage.tokenUsageCandidates = Array.isArray(storage.tokenUsageCandidates) ? storage.tokenUsageCandidates : [];
  storage.aiCodingCorrections = Array.isArray(storage.aiCodingCorrections) ? storage.aiCodingCorrections : [];
  storage.autoSyncState = normalizeAutoSyncState(storage.autoSyncState);

  storage.nextRoundId = normalizeNextId(storage.nextRoundId, storage.rounds);
  storage.nextRoundRevertId = normalizeNextId(storage.nextRoundRevertId, storage.roundReverts);
  storage.nextTokenUsageEventId = normalizeNextId(storage.nextTokenUsageEventId, storage.tokenUsageEvents);
  storage.nextDialogueTurnId = normalizeNextId(storage.nextDialogueTurnId, storage.dialogueTurns);
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
    pid: Number.isSafeInteger(Number(value.pid)) ? Number(value.pid) : null,
    status: ["idle", "running", "stopped", "failed"].includes(String(value.status))
      ? value.status as AutoSyncState["status"]
      : "idle",
    currentStep: typeof value.currentStep === "string" ? value.currentStep : null,
    currentStatus: typeof value.currentStatus === "string" ? value.currentStatus : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    lastHeartbeatAt: typeof value.lastHeartbeatAt === "string" ? value.lastHeartbeatAt : null,
    lastTokenSyncSince: typeof value.lastTokenSyncSince === "string" ? value.lastTokenSyncSince : null,
    lastTokenSyncAt: typeof value.lastTokenSyncAt === "string" ? value.lastTokenSyncAt : null,
    lastTokenSyncStartedAt: typeof value.lastTokenSyncStartedAt === "string" ? value.lastTokenSyncStartedAt : null,
    lastTokenSyncFinishedAt: typeof value.lastTokenSyncFinishedAt === "string" ? value.lastTokenSyncFinishedAt : null,
    lastOnlineSyncAt: typeof value.lastOnlineSyncAt === "string" ? value.lastOnlineSyncAt : null,
    lastOnlineSyncStartedAt: typeof value.lastOnlineSyncStartedAt === "string" ? value.lastOnlineSyncStartedAt : null,
    lastOnlineSyncFinishedAt: typeof value.lastOnlineSyncFinishedAt === "string" ? value.lastOnlineSyncFinishedAt : null,
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
  saveDataSync(getDb(), normalizeStorageData(data));
  cachedData = data;
}

function loadDataSync(database: Database.Database): StorageData {
  const conversations = selectPayloads<Conversation>(database, "conversations", "conversation_id");
  const requirements = selectPayloads<Requirement>(database, "requirements", "requirement_id");
  const rounds = selectPayloads<Round>(database, "rounds", "id");
  const roundReverts = selectPayloads<RoundRevert>(database, "round_reverts", "id");
  const tokenUsageEvents = selectPayloads<TokenUsageEvent>(database, "token_usage_events", "id");
  const dialogueTurns = selectPayloads<DialogueTurn>(database, "dialogue_turns", "id");
  const tokenUsageCandidates = selectPayloads<TokenUsageCandidate>(database, "token_usage_candidates", "id");
  const aiCodingCorrections = selectPayloads<AiCodingCorrection>(database, "ai_coding_corrections", "id");
  const autoSyncRow = database.prepare("SELECT payload_json FROM auto_sync_state WHERE singleton_id = 1").get() as { payload_json: string } | undefined;
  const autoSyncState = autoSyncRow ? parseJson<AutoSyncState>(autoSyncRow.payload_json) : null;

  return normalizeStorageData({
    conversations,
    requirements,
    rounds,
    roundReverts,
    tokenUsageEvents,
    dialogueTurns,
    tokenUsageCandidates,
    aiCodingCorrections,
    autoSyncState,
    nextRoundId: maxId(rounds) + 1,
    nextRoundRevertId: maxId(roundReverts) + 1,
    nextTokenUsageEventId: maxId(tokenUsageEvents) + 1,
    nextDialogueTurnId: maxId(dialogueTurns) + 1,
    nextTokenUsageCandidateId: maxId(tokenUsageCandidates) + 1,
    nextAiCodingCorrectionId: maxId(aiCodingCorrections) + 1,
  });
}

function saveDataSync(database: Database.Database, data: StorageData): void {
  const normalized = normalizeStorageData(data);
  const transaction = database.transaction(() => {
    clearEntityTables(database);
    for (const conversation of normalized.conversations) upsertConversationSync(database, conversation);
    for (const requirement of normalized.requirements) upsertRequirementSync(database, requirement);
    for (const round of normalized.rounds) upsertRoundSync(database, round);
    for (const revert of normalized.roundReverts) upsertRoundRevertSync(database, revert);
    for (const event of normalized.tokenUsageEvents) upsertTokenUsageEventSync(database, event);
    for (const dialogueTurn of normalized.dialogueTurns) upsertDialogueTurnSync(database, dialogueTurn);
    for (const candidate of normalized.tokenUsageCandidates) upsertTokenUsageCandidateSync(database, candidate);
    for (const correction of normalized.aiCodingCorrections) upsertAiCodingCorrectionSync(database, correction);
    if (normalized.autoSyncState) {
      upsertAutoSyncStateSync(database, normalized.autoSyncState);
    }
    resetSequence(database, "rounds", normalized.nextRoundId - 1);
    resetSequence(database, "round_reverts", normalized.nextRoundRevertId - 1);
    resetSequence(database, "token_usage_events", normalized.nextTokenUsageEventId - 1);
    resetSequence(database, "dialogue_turns", normalized.nextDialogueTurnId - 1);
    resetSequence(database, "token_usage_candidates", normalized.nextTokenUsageCandidateId - 1);
    resetSequence(database, "ai_coding_corrections", normalized.nextAiCodingCorrectionId - 1);
  });
  transaction();
}

function clearEntityTables(database: Database.Database): void {
  database.exec(`
    DELETE FROM conversations;
    DELETE FROM requirements;
    DELETE FROM rounds;
    DELETE FROM round_reverts;
    DELETE FROM token_usage_events;
    DELETE FROM dialogue_turns;
    DELETE FROM token_usage_candidates;
    DELETE FROM ai_coding_corrections;
    DELETE FROM auto_sync_state;
  `);
}

function selectPayloads<T>(database: Database.Database, table: string, orderBy: string): T[] {
  const rows = database.prepare(`SELECT payload_json FROM ${table} ORDER BY ${orderBy}`).all() as Array<{ payload_json: string }>;
  return rows.map((row) => parseJson<T>(row.payload_json));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function maxId(rows: Array<{ id?: unknown }>): number {
  return rows.reduce((max, row) => {
    const id = Number(row.id);
    return Number.isSafeInteger(id) && id > max ? id : max;
  }, 0);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function resetSequence(database: Database.Database, table: string, value: number): void {
  if (value <= 0) return;
  database.prepare("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, value);
}

function upsertConversationSync(database: Database.Database, item: Conversation): void {
  database.prepare("INSERT OR REPLACE INTO conversations (conversation_id, payload_json) VALUES (?, ?)")
    .run(item.conversationId, json(item));
}

function upsertRequirementSync(database: Database.Database, item: Requirement): void {
  database.prepare("INSERT OR REPLACE INTO requirements (requirement_id, payload_json) VALUES (?, ?)")
    .run(item.requirementId, json(item));
}

function upsertRoundSync(database: Database.Database, item: Round): void {
  database.prepare(`
    INSERT OR REPLACE INTO rounds (
      id, conversation_id, ended_at, token_sync_status, upload_status, demand_id, demand_code,
      client, model_name, project_path, started_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.conversationId,
    item.endedAt,
    item.tokenSyncStatus,
    item._sync?.status ?? "pending",
    stringOrNull(item.metadata?.demandId),
    stringOrNull(item.metadata?.demandCode),
    stringOrNull(item.metadata?.client),
    item.modelName,
    stringOrNull(item.metadata?.projectPath),
    item.startedAt,
    json(item)
  );
}

function upsertRoundRevertSync(database: Database.Database, item: RoundRevert): void {
  database.prepare(`
    INSERT OR REPLACE INTO round_reverts (
      id, target_round_id, conversation_id, reverted_at, upload_status, model_name, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(item.id, item.targetRoundId, item.conversationId, item.revertedAt, item._sync?.status ?? "pending", item.modelName, json(item));
}

function upsertTokenUsageEventSync(database: Database.Database, item: TokenUsageEvent): void {
  const normalizedItem = normalizeTokenUsageEventForUniqueSourceEvent(database, item);
  database.prepare(`
    INSERT OR REPLACE INTO token_usage_events (
      id, round_id, client, source_event_id, ended_at, upload_status, conversation_id,
      turn_id, model_name, started_at, total_tokens, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizedItem.id,
    normalizedItem.roundId,
    normalizedItem.client,
    normalizedItem.sourceEventId,
    normalizedItem.endedAt,
    normalizedItem._sync?.status ?? "pending",
    normalizedItem.conversationId,
    normalizedItem.turnId,
    normalizedItem.modelName,
    normalizedItem.startedAt,
    normalizedItem.totalTokens,
    json(normalizedItem)
  );
}

function upsertDialogueTurnSync(database: Database.Database, item: DialogueTurn): void {
  database.prepare(`
    INSERT OR REPLACE INTO dialogue_turns (
      id, conversation_id, turn_id, ended_at, mode, source_event_id, project_path, model_name, client, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.conversationId,
    item.turnId,
    item.endedAt,
    item.mode,
    item.sourceEventId,
    item.projectPath,
    item.modelName,
    item.client,
    json(item)
  );
}

function normalizeTokenUsageEventForUniqueSourceEvent(database: Database.Database, item: TokenUsageEvent): TokenUsageEvent {
  if (!item.sourceEventId) {
    return item;
  }
  const existing = database.prepare("SELECT id FROM token_usage_events WHERE source_event_id = ? AND id <> ?")
    .get(item.sourceEventId, item.id) as { id: number } | undefined;
  return existing ? { ...item, sourceEventId: null } : item;
}

function upsertTokenUsageCandidateSync(database: Database.Database, item: TokenUsageCandidate): void {
  database.prepare(`
    INSERT OR REPLACE INTO token_usage_candidates (
      id, round_id, client, selected_at, source_event_id, ended_at, total_tokens, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.id, item.roundId, item.client, item.selectedAt, item.sourceEventId, item.endedAt, item.totalTokens, json(item));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function upsertAiCodingCorrectionSync(database: Database.Database, item: AiCodingCorrection): void {
  database.prepare("INSERT OR REPLACE INTO ai_coding_corrections (id, round_id, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(item.id, item.roundId, item.targetType, item.targetId, json(item));
}

function upsertAutoSyncStateSync(database: Database.Database, item: AutoSyncState): void {
  database.prepare("INSERT OR REPLACE INTO auto_sync_state (singleton_id, payload_json) VALUES (1, ?)")
    .run(json(item));
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
  DialogueTurn,
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
    upsertConversationSync(getDb(), conversation);
    cachedData = null;
  });
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
    cachedData = null;
    return result.changes > 0;
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
    upsertRequirementSync(getDb(), requirement);
    cachedData = null;
  });
}

export async function deleteRequirement(requirementId: number): Promise<boolean> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM requirements WHERE requirement_id = ?").run(requirementId);
    cachedData = null;
    return result.changes > 0;
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
    const createdAt = new Date().toISOString();
    const result = getDb().prepare(
      "INSERT INTO rounds (conversation_id, ended_at, token_sync_status, payload_json) VALUES (?, ?, ?, ?)"
    ).run(round.conversationId, round.endedAt, round.tokenSyncStatus, "{}");
    const newRound: Round = { ...round, id: Number(result.lastInsertRowid), createdAt };
    upsertRoundSync(getDb(), newRound);
    cachedData = null;
    return newRound;
  });
}

export async function updateRound(round: Round): Promise<void> {
  await withStorageLock(async () => {
    const existing = getDb().prepare("SELECT id FROM rounds WHERE id = ?").get(round.id);
    if (!existing) {
      throw new Error(`Round ${round.id} not found`);
    }
    upsertRoundSync(getDb(), round);
    cachedData = null;
  });
}

export async function deleteRound(id: number): Promise<boolean> {
  return withStorageLock(async () => {
    const database = getDb();
    const transaction = database.transaction(() => {
      const result = database.prepare("DELETE FROM rounds WHERE id = ?").run(id);
      database.prepare("DELETE FROM token_usage_events WHERE round_id = ?").run(id);
      database.prepare("DELETE FROM token_usage_candidates WHERE round_id = ?").run(id);
      database.prepare("DELETE FROM ai_coding_corrections WHERE round_id = ?").run(id);
      return result.changes > 0;
    });
    const deleted = transaction() as boolean;
    cachedData = null;
    return deleted;
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
    const createdAt = new Date().toISOString();
    const result = getDb().prepare(
      "INSERT INTO round_reverts (target_round_id, conversation_id, reverted_at, payload_json) VALUES (?, ?, ?, ?)"
    ).run(revert.targetRoundId, revert.conversationId, revert.revertedAt, "{}");
    const newRevert: RoundRevert = { ...revert, id: Number(result.lastInsertRowid), createdAt };
    upsertRoundRevertSync(getDb(), newRevert);
    cachedData = null;
    return newRevert;
  });
}

export async function deleteRoundRevertByTarget(targetRoundId: number): Promise<boolean> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM round_reverts WHERE target_round_id = ?").run(targetRoundId);
    cachedData = null;
    return result.changes > 0;
  });
}

export async function getTokenUsageEvents(): Promise<TokenUsageEvent[]> {
  const data = await loadData();
  return data.tokenUsageEvents;
}

export async function getDialogueTurns(): Promise<DialogueTurn[]> {
  const data = await loadData();
  return data.dialogueTurns;
}

export async function getDialogueTurnsByConversation(conversationId: string): Promise<DialogueTurn[]> {
  const data = await loadData();
  return data.dialogueTurns.filter((item) => item.conversationId === conversationId);
}

export async function upsertDialogueTurn(
  turn: Omit<DialogueTurn, "id" | "createdAt"> & { id?: number }
): Promise<DialogueTurn> {
  return withStorageLock(async () => {
    const database = getDb();
    const existingRow = database.prepare(
      "SELECT payload_json FROM dialogue_turns WHERE conversation_id = ? AND turn_id = ?"
    ).get(turn.conversationId, turn.turnId) as { payload_json: string } | undefined;
    const existing = existingRow ? parseJson<DialogueTurn>(existingRow.payload_json) : null;
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const inserted = database.prepare(
      "INSERT OR IGNORE INTO dialogue_turns (conversation_id, turn_id, ended_at, mode, source_event_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(turn.conversationId, turn.turnId, turn.endedAt, turn.mode, turn.sourceEventId, "{}");
    const id = existing?.id ?? Number(inserted.lastInsertRowid);
    const nextTurn: DialogueTurn = { ...turn, id, createdAt };
    upsertDialogueTurnSync(database, nextTurn);
    cachedData = null;
    return nextTurn;
  });
}

export async function createTokenUsageEvent(event: Omit<TokenUsageEvent, "id" | "createdAt">): Promise<TokenUsageEvent> {
  return withStorageLock(async () => {
    const database = getDb();
    const createdAt = new Date().toISOString();
    const result = database.prepare(
      "INSERT OR IGNORE INTO token_usage_events (round_id, client, source_event_id, ended_at, payload_json) VALUES (?, ?, ?, ?, ?)"
    ).run(event.roundId, event.client, event.sourceEventId, event.endedAt, "{}");
    if (result.changes === 0 && event.sourceEventId) {
      const existing = database.prepare("SELECT payload_json FROM token_usage_events WHERE source_event_id = ?")
        .get(event.sourceEventId) as { payload_json: string } | undefined;
      if (existing) {
        return parseJson<TokenUsageEvent>(existing.payload_json);
      }
    }
    const newEvent: TokenUsageEvent = { ...event, id: Number(result.lastInsertRowid), createdAt };
    upsertTokenUsageEventSync(database, newEvent);
    cachedData = null;
    return newEvent;
  });
}

export async function updateTokenUsageEvent(event: TokenUsageEvent): Promise<void> {
  await withStorageLock(async () => {
    const existing = getDb().prepare("SELECT id FROM token_usage_events WHERE id = ?").get(event.id);
    if (!existing) {
      throw new Error(`Token usage event ${event.id} not found`);
    }
    upsertTokenUsageEventSync(getDb(), event);
    cachedData = null;
  });
}

export async function deleteTokenUsageEventsByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM token_usage_events WHERE round_id = ?").run(roundId);
    cachedData = null;
    return result.changes;
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
    const database = getDb();
    const createdAt = new Date().toISOString();
    const created: TokenUsageCandidate[] = [];
    const transaction = database.transaction(() => {
      database.prepare("DELETE FROM token_usage_candidates WHERE round_id = ? AND client = ? AND selected_at IS NULL").run(roundId, client);
      for (const candidate of candidates) {
        const result = database.prepare(
          "INSERT INTO token_usage_candidates (round_id, client, selected_at, payload_json) VALUES (?, ?, ?, ?)"
        ).run(candidate.roundId, candidate.client, null, "{}");
        const newCandidate: TokenUsageCandidate = { ...candidate, id: Number(result.lastInsertRowid), createdAt, selectedAt: null };
        upsertTokenUsageCandidateSync(database, newCandidate);
        created.push(newCandidate);
      }
    });
    transaction();
    cachedData = null;
    return created;
  });
}

export async function updateTokenUsageCandidate(candidate: TokenUsageCandidate): Promise<void> {
  await withStorageLock(async () => {
    const existing = getDb().prepare("SELECT id FROM token_usage_candidates WHERE id = ?").get(candidate.id);
    if (!existing) {
      throw new Error(`Token usage candidate ${candidate.id} not found`);
    }
    upsertTokenUsageCandidateSync(getDb(), candidate);
    cachedData = null;
  });
}

export async function deleteTokenUsageCandidatesByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM token_usage_candidates WHERE round_id = ?").run(roundId);
    cachedData = null;
    return result.changes;
  });
}

export async function createAiCodingCorrection(
  correction: Omit<AiCodingCorrection, "id" | "createdAt">
): Promise<AiCodingCorrection> {
  return withStorageLock(async () => {
    const createdAt = new Date().toISOString();
    const result = getDb().prepare(
      "INSERT INTO ai_coding_corrections (round_id, target_type, target_id, payload_json) VALUES (?, ?, ?, ?)"
    ).run(correction.roundId, correction.targetType, correction.targetId, "{}");
    const newCorrection: AiCodingCorrection = { ...correction, id: Number(result.lastInsertRowid), createdAt };
    upsertAiCodingCorrectionSync(getDb(), newCorrection);
    cachedData = null;
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
    upsertAutoSyncStateSync(getDb(), state);
    cachedData = null;
  });
}

export async function patchAutoSyncState(patch: Partial<AutoSyncState>): Promise<AutoSyncState> {
  return withStorageLock(async () => {
    const now = new Date().toISOString();
    const current = await getAutoSyncState() ?? {
      workerId: null,
      pid: null,
      status: "idle",
      currentStep: null,
      currentStatus: null,
      startedAt: null,
      lastHeartbeatAt: null,
      lastTokenSyncSince: null,
      lastTokenSyncAt: null,
      lastTokenSyncStartedAt: null,
      lastTokenSyncFinishedAt: null,
      lastOnlineSyncAt: null,
      lastOnlineSyncStartedAt: null,
      lastOnlineSyncFinishedAt: null,
      lastTokenSyncStatus: null,
      lastOnlineSyncStatus: null,
      lastTokenSyncSummary: null,
      lastOnlineSyncSummary: null,
      lastError: null,
      updatedAt: now,
    };
    const next: AutoSyncState = { ...current, ...patch, updatedAt: now };
    upsertAutoSyncStateSync(getDb(), next);
    cachedData = null;
    return next;
  });
}

export async function deleteAiCodingCorrectionsByRound(roundId: number): Promise<number> {
  return withStorageLock(async () => {
    const result = getDb().prepare("DELETE FROM ai_coding_corrections WHERE round_id = ?").run(roundId);
    cachedData = null;
    return result.changes;
  });
}

export async function clearAllData(): Promise<void> {
  await withStorageLock(async () => {
    const database = getDb();
    const transaction = database.transaction(() => {
      clearEntityTables(database);
      database.prepare("DELETE FROM sqlite_sequence WHERE name IN (?, ?, ?, ?, ?, ?)")
        .run("rounds", "round_reverts", "token_usage_events", "dialogue_turns", "token_usage_candidates", "ai_coding_corrections");
    });
    transaction();
    cachedData = null;
  });
}

export async function getAllStorageData(): Promise<StorageData> {
  return loadData(true);
}

export async function replaceAllStorageData(data: StorageData): Promise<void> {
  await saveData(normalizeStorageData(data));
}

export async function updateRoundSyncState(roundId: number, syncState: SyncState): Promise<void> {
  await withStorageLock(async () => {
    const row = getDb().prepare("SELECT payload_json FROM rounds WHERE id = ?").get(roundId) as { payload_json: string } | undefined;
    if (!row) {
      throw new Error(`Round ${roundId} not found`);
    }
    const round = parseJson<Round>(row.payload_json);
    upsertRoundSync(getDb(), { ...round, _sync: syncState });
    cachedData = null;
  });
}

export async function updateRoundRevertSyncState(revertId: number, syncState: SyncState): Promise<void> {
  await withStorageLock(async () => {
    const row = getDb().prepare("SELECT payload_json FROM round_reverts WHERE id = ?").get(revertId) as { payload_json: string } | undefined;
    if (!row) {
      throw new Error(`Round revert ${revertId} not found`);
    }
    const revert = parseJson<RoundRevert>(row.payload_json);
    upsertRoundRevertSync(getDb(), { ...revert, _sync: syncState });
    cachedData = null;
  });
}

export async function updateTokenUsageEventSyncState(eventId: number, syncState: SyncState): Promise<void> {
  await withStorageLock(async () => {
    const row = getDb().prepare("SELECT payload_json FROM token_usage_events WHERE id = ?").get(eventId) as { payload_json: string } | undefined;
    if (!row) {
      throw new Error(`Token usage event ${eventId} not found`);
    }
    const event = parseJson<TokenUsageEvent>(row.payload_json);
    upsertTokenUsageEventSync(getDb(), { ...event, _sync: syncState });
    cachedData = null;
  });
}

export function getStorageInfo(): { storageMode: "sqlite"; storageDir: string; sqlitePath: string; legacyJsonPath: string; sqliteExists: boolean; legacyJsonExists: boolean; legacyJsonMtime: string | null } {
  const legacyJsonPath = getStoragePath();
  const legacyJsonStat = existsSync(legacyJsonPath) ? statSync(legacyJsonPath) : null;
  return {
    storageMode: "sqlite",
    storageDir,
    sqlitePath: getSqlitePath(),
    legacyJsonPath,
    sqliteExists: existsSync(getSqlitePath()),
    legacyJsonExists: Boolean(legacyJsonStat),
    legacyJsonMtime: legacyJsonStat ? legacyJsonStat.mtime.toISOString() : null,
  };
}

export async function backupStorage(backupPath: string): Promise<void> {
  await getDb().backup(backupPath);
}
