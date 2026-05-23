# Current Risks And Issues

## Snapshot

Current implementation has moved local storage to SQLite and the core chain is runnable:

```text
MCP tools -> local SQLite storage -> token backfill -> online sync pipeline
```

But it is not yet production-stable. The risks below are the current exposed problems that should remain visible until each one has an owner and an acceptance check.

## P0 Issues

### Online Sync Is Not Proven End-to-End

Evidence:

```text
status currently shows uploads.failed = 15
online sync target defaults to http://127.0.0.1:9906/ai-codingTurns
```

Impact:

Local records are durable, but the online dashboard or backend will not receive all turns and token events until the API is reachable and compatible.

Likely causes:

```text
backend service is not running
API path differs from local config
auth headers are missing or invalid
payload contract differs from backend expectation
failed rows are waiting for retry window
```

Required fix:

```text
1. Add doctor API connectivity check.
2. Add sync --verbose to print failed entity id, endpoint, HTTP status, error body, failedAttempts, nextRetryAt.
3. Add diagnose uploads.
4. Confirm backend route and auth contract.
```

Acceptance:

```text
npm run sync:online -- --retry-failed-now
npm run cli -- status
```

Expected:

```text
uploads.failed = 0
uploads.pending = 0
```

## P1 Issues

### Old Auto Runner Processes May Still Write Legacy JSON

Evidence:

After SQLite migration, old runner status summaries can still mention:

```text
.mcp-toolbox/data.json
```

Impact:

If a stale process was started before the SQLite build, it may keep using old `dist` code and write stale state into `data.json`, while new commands use `storage.db`.

Risk:

Two storage worlds can appear to exist temporarily:

```text
new code -> storage.db
old process -> data.json
```

Required fix:

```text
1. Stop existing auto runner and MCP server processes after deploying SQLite.
2. Restart from rebuilt dist.
3. Add startup warning when data.json changes after SQLite migration.
4. Add storage info to status output.
```

Acceptance:

```text
status and sync output both reference storage.db
data.json timestamp no longer changes during normal operation
```

### Token Pending Still Accumulates

Evidence:

Current status has shown:

```text
tokens.pending = 12
```

Impact:

Code-change records may be uploaded with pending token state for too long. Cost/capacity reports stay incomplete.

Likely causes:

```text
historical rows do not have turnId
tool logs are delayed
scan window is too small
Codex/Claude log format variations
time-window matching is ambiguous
```

Required fix:

```text
1. Add tokens sync --since.
2. Add tokens sync --rescan.
3. Persist tokenUsageCandidates when matches are uncertain.
4. Add manual bind/unavailable commands.
5. Add pending aging rule to mark not_found.
```

Acceptance:

```text
pending older than 24h + scanned >= 3 + no candidate -> not_found
ambiguous matches -> needs_review with candidate list
manual bind can resolve a pending round
```

### Runner State Is Ambiguous

Evidence:

`lastOnlineSyncStatus` can show `running` while `lastOnlineSyncSummary` is from a previous completed run.

Impact:

Operators cannot easily tell whether a sync is currently running, recently completed, or stuck.

Required fix:

Split state fields:

```text
currentStep
currentStatus
lastOnlineSyncStartedAt
lastOnlineSyncFinishedAt
lastOnlineSyncStatus
lastTokenSyncStartedAt
lastTokenSyncFinishedAt
lastTokenSyncStatus
```

Acceptance:

```text
status can distinguish current running job from last completed job
stale running job is detectable by heartbeat age
```

## P2 Issues

### SQLite Schema Is Transitional

Evidence:

SQLite now stores entities in separate tables, but most business fields remain inside:

```text
payload_json
```

Impact:

This removes JSON whole-file rewrite risk, but does not fully unlock efficient querying, reporting, or constraint validation.

Required fix:

Normalize common fields:

```text
rounds: upload status, token status, demand id/code, client, modelName, projectPath, startedAt, endedAt
token events: sourceEventId unique key, turnId, client, occurredAt, totalTokens
worker state: current status fields
```

Acceptance:

```text
status and diagnose queries do not need to parse every payload_json row
sourceEventId duplicate prevention is enforced by SQLite
```

### Online Sync Still Uses Bulk Checkpoint Replacement

Evidence:

`sync-to-online.ts` loads a full storage snapshot and writes it back after checkpoint updates.

Impact:

SQLite is now the backend, but this sync path still behaves like a bulk snapshot update. It can overwrite changes made by another process between load and save.

Required fix:

```text
1. Add updateRoundSyncState(roundId, syncState).
2. Add updateTokenUsageEventSyncState(eventId, syncState).
3. Add updateRoundRevertSyncState(revertId, syncState).
4. Change sync-to-online to update only the processed entity.
```

Acceptance:

```text
online sync no longer calls replaceAllStorageData during normal checkpointing
concurrent token backfill and online sync do not overwrite each other
```

### Stop Command Is Not Safe Enough On Windows

Evidence:

Stop relies on recorded PID and state.

Impact:

PID reuse could terminate the wrong process in rare cases.

Required fix:

Before killing a process, validate:

```text
pid exists
workerId matches
command line contains auto-runner.js
cwd is expected project/storage root
process start time is consistent with recorded startedAt when available
```

Acceptance:

```text
stop refuses to kill a process that does not match expected command/cwd
```

### Configuration Validation Is Too Thin

Evidence:

`init-config` writes config, but `doctor` currently checks runtime basics more than API/auth correctness.

Impact:

Users can have a config that looks present but cannot upload.

Required fix:

```text
1. doctor shows effective config source.
2. doctor checks API base reachability.
3. doctor checks auth/header presence.
4. doctor validates turnApiPath.
```

Acceptance:

```text
doctor reports whether sync is expected to work before data is generated
```

## P3 Issues

### Legacy JSON Migration Needs Lifecycle Policy

Evidence:

`data.json` remains after migration.

Impact:

It is useful for rollback, but confusing if left forever.

Required fix:

```text
1. Keep data.json for one release as rollback input.
2. Add storage export command for explicit JSON export.
3. After stabilization, stop treating data.json as runtime storage.
```

Acceptance:

```text
docs clearly say storage.db is authoritative
data.json is backup/migration only
```

### No Storage Backup Command Yet

Impact:

SQLite is more reliable than JSON, but users still need backup/export for recovery and support.

Required fix:

```bash
ai-coding-stats storage backup
ai-coding-stats storage doctor
ai-coding-stats storage export
```

Acceptance:

```text
backup creates .mcp-toolbox/backups/storage-YYYYMMDD-HHmmss.db
storage doctor validates schema and basic row counts
```

### Dist And Running Process Drift

Evidence:

The project builds to `dist`, and runtime scripts may execute `dist/*.js`.

Impact:

After source edits, failing to rebuild or restart can leave production runtime on old code.

Required fix:

```text
1. Document rebuild/restart after storage changes.
2. Add version/storage-mode output to status.
3. Add doctor check that dist is newer than src.
```

Acceptance:

```text
doctor warns if dist is older than src
status shows storageMode = sqlite
```

## Recommended Fix Order

1. Stop/restart old runners after SQLite migration.
2. Add storage mode and SQLite path to `status`.
3. Add `diagnose uploads`.
4. Add API checks to `doctor`.
5. Replace online sync bulk checkpoint writes with per-entity updates.
6. Add token pending aging and manual resolution commands.
7. Harden Windows stop.
8. Add storage backup/export/doctor commands.
9. Normalize SQLite fields beyond `payload_json`.

## Current Acceptance Baseline

These commands should stay green while fixing the issues:

```bash
npm run build
npm run cli -- status
npm run sync:online:dry -- --limit 5
```

Expected baseline:

```text
build succeeds
status reads historical rows from SQLite
sync dry run reports .mcp-toolbox/storage.db
```

