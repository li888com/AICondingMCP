# Local Storage Risk Plan

## Current Decision

Local storage has been moved from a single JSON file to SQLite:

- Primary database: `.mcp-toolbox/storage.db`
- Legacy JSON snapshot: `.mcp-toolbox/data.json`
- SQLite mode: WAL enabled, `busy_timeout = 5000`
- Migration: the first SQLite open imports existing `data.json` or legacy `~/.mcp-toolbox/data.json`

The TypeScript API in `src/local-storage.ts` remains stable, so MCP tools, CLI commands, token backfill, and the auto runner can continue using the same storage functions.

## Risks Removed By SQLite

### Whole-file JSON Rewrite

Old risk:
Every update rewrote the full `data.json`. A crash or concurrent process could corrupt or overwrite unrelated changes.

SQLite mitigation:
Writes now go through SQLite transactions and WAL. Single-entity updates no longer rewrite the whole dataset.

Residual risk:
Some bulk paths still replace the full dataset, mainly online sync checkpoint persistence through `replaceAllStorageData`.

Next action:
Move online sync to per-entity update functions after each upload attempt.

### Weak Concurrent Writes

Old risk:
JSON used a directory lock. It was simple, but stale locks and multi-process writes were fragile.

SQLite mitigation:
SQLite handles locking with WAL and a busy timeout.

Residual risk:
Long-running sync jobs can still race logically with the auto runner if both update the same entity.

Next action:
Add per-worker state and per-entity optimistic version fields.

### Poor Queryability

Old risk:
Status, diagnostics, and future dashboards needed to load and scan the whole JSON document.

SQLite mitigation:
Each entity category now has its own table and indexes for common keys.

Residual risk:
Rows currently store the full business object as `payload_json`; only a few index columns are normalized.

Next action:
Normalize frequently queried fields: upload status, token status, demand id/code, timestamps, and client.

## Remaining Operational Risks

### Legacy JSON Still Exists

Impact:
Old dist processes or stale auto runners may continue writing `data.json`, while new code writes `storage.db`.

Symptoms:
`data.json` timestamp changes after SQLite migration, or status differs between old and new commands.

Mitigation:
Restart the MCP server and auto runner after deployment. Treat `storage.db` as authoritative.

Next action:
Add a startup warning if `data.json` is modified after `json_migrated_at`.

### Upload Failures Still Need Diagnosis

Impact:
SQLite prevents local data loss, but it does not fix remote API failures. Failed uploads remain local until the online API is reachable and compatible.

Mitigation:
Keep failed upload state in `_sync`, including `failedAttempts`, `lastAttemptAt`, `nextRetryAt`, and error text.

Next action:
Add `diagnose uploads` and `sync --verbose` to print failed rows and API config.

### Token Pending Can Accumulate

Impact:
Pending token rows can remain forever if logs are missing, delayed beyond the scan window, or not matchable.

Mitigation:
Token rows are durable in SQLite, and backfill can be rerun.

Next action:
Add pending aging rules:

```text
pending older than 24 hours
+ scanned at least 3 times
+ no candidate found
= not_found
```

Also add manual commands:

```bash
ai-coding-stats tokens bind --round-id <id> --event-id <id>
ai-coding-stats tokens mark-unavailable --round-id <id>
```

### Auto Runner State Is Too Coarse

Impact:
`lastOnlineSyncStatus` can be confused with current running state.

Mitigation:
SQLite keeps the state durably, but the schema still mirrors the old coarse model.

Next action:
Split state into:

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

### Stop Safety On Windows

Impact:
Stopping by PID alone can target the wrong process if the PID is reused.

Mitigation:
Current stop only uses locally recorded runner state, but it is not enough for strict safety.

Next action:
Before killing a process, validate:

```text
pid exists
workerId matches
command line contains auto-runner.js
cwd is the expected project/storage root
startedAt is consistent with process start time when available
```

### Backup And Recovery

Impact:
SQLite is more robust than JSON, but the database file can still be deleted, corrupted, or manually edited.

Mitigation:
Legacy JSON remains as a migration source for now.

Lifecycle policy:

- `.mcp-toolbox/storage.db` is the runtime source of truth once SQLite opens successfully.
- `.mcp-toolbox/data.json` is migration and rollback input only; normal commands must not write it.
- Status and storage doctor may report `data.json` presence and mtime for drift detection, but should not treat it as active runtime storage.
- Keep `data.json` through the first stable SQLite release. After that release, preserve it only as an explicit backup/export artifact or remove it during a documented cleanup step.
- If `data.json` mtime changes after `json_migrated_at`, treat that as a stale process warning and restart old runners or MCP servers.

Next action:
Add:

```bash
ai-coding-stats storage backup
ai-coding-stats storage doctor
ai-coding-stats storage export
```

Backup target:

```text
.mcp-toolbox/backups/storage-YYYYMMDD-HHmmss.db
```

## Recommended Rollout

1. Stop existing auto runners and MCP server processes.
2. Build the project.
3. Run `ai-coding-stats status` once to trigger JSON-to-SQLite migration.
4. Confirm `.mcp-toolbox/storage.db` exists.
5. Run `ai-coding-stats sync --dry-run`.
6. Restart the MCP server and auto runner using the rebuilt `dist`.
7. Keep `data.json` for one release as rollback input.
8. After one stable release, make JSON export explicit instead of automatic runtime storage.

## Acceptance Checks

```bash
npm run build
npm run cli -- status
npm run sync:online:dry -- --limit 5
```

Expected:

- Build succeeds.
- Status reads existing historical rounds.
- Sync output says it is using `.mcp-toolbox/storage.db`.
- `data.json` is no longer the authoritative storage file.
