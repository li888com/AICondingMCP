#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCodeSnapshot, findGitRoot, getCodeStatsSinceSnapshot, saveRoundBaseline, } from "./code-stats.js";
import { recordDialogueTokenUsage, recordRound } from "./database.js";
import { patchAutoSyncState } from "./local-storage.js";
const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const workerId = `auto-runner-${process.pid}`;
const projectPath = resolve(args.projectPath);
const storageDir = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"));
const statePath = resolve(storageDir, "auto-runner-state.json");
const conversationId = args.conversationId || `codex:${projectPath.replaceAll("\\", "/")}`;
let shuttingDown = false;
await main();
async function main() {
    const gitRoot = await findGitRoot(projectPath);
    if (!gitRoot) {
        throw new Error(`No Git workspace found for ${projectPath}`);
    }
    if (args.dialogue) {
        await recordDialogueTurn(gitRoot);
        return;
    }
    await patchAutoSyncState({
        workerId,
        pid: process.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        lastError: null,
    });
    process.on("SIGINT", () => {
        shuttingDown = true;
    });
    process.on("SIGTERM", () => {
        shuttingDown = true;
    });
    console.log(`AI coding auto-runner started for ${gitRoot}`);
    console.log(`conversationId: ${conversationId}`);
    console.log(`pollIntervalMs: ${args.pollIntervalMs}`);
    console.log(`settleMs: ${args.settleMs}`);
    while (!shuttingDown) {
        try {
            await tick(gitRoot);
            await patchAutoSyncState({
                workerId,
                pid: process.pid,
                status: "running",
                lastHeartbeatAt: new Date().toISOString(),
                lastError: null,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            await patchAutoSyncState({
                workerId,
                pid: process.pid,
                status: "failed",
                lastHeartbeatAt: new Date().toISOString(),
                lastError: message,
            });
        }
        await delay(args.pollIntervalMs);
    }
    await patchAutoSyncState({
        workerId,
        pid: process.pid,
        status: "stopped",
        lastHeartbeatAt: new Date().toISOString(),
    });
}
async function recordDialogueTurn(gitRoot) {
    const recorded = await recordDialogueTokenUsage({
        conversationId,
        client: args.client,
        sourcePath: "auto-runner:dialogue",
        sourceEventId: args.sourceEventId || undefined,
        turnId: args.turnId || undefined,
        modelName: args.modelName,
        startedAt: args.startedAt || undefined,
        endedAt: args.endedAt || new Date().toISOString(),
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        totalTokens: args.totalTokens,
        promptText: args.promptText,
        metadata: {
            projectPath: gitRoot,
            autoRecorded: true,
            trigger: "command_dialogue",
            recordsWithoutCodeChanges: true,
            tokenStatsSource: args.totalTokens > 0 ? "cli_payload" : "unavailable",
        },
    });
    console.log(`Recorded dialogue token usage ${recorded.id}`);
    if (recorded.warning) {
        console.log(recorded.warning);
    }
}
async function tick(gitRoot) {
    const state = await loadState();
    const signature = await getWorkspaceSignature(gitRoot);
    const now = new Date();
    if (!state.activeRound && !state.idleBaseline) {
        state.idleBaseline = await createBaseline(gitRoot, signature);
    }
    if (signature !== state.lastSignature) {
        if (!state.activeRound && state.idleBaseline && signature !== state.idleBaseline.signatureAtStart) {
            state.activeRound = state.idleBaseline;
            state.idleBaseline = null;
            console.log(`Detected workspace change from baseline ${state.activeRound.baselineId}`);
        }
        state.lastSignature = signature;
        state.lastChangedAt = now.toISOString();
    }
    if (state.activeRound && signature !== state.activeRound.signatureAtStart && state.lastChangedAt) {
        const quietForMs = now.getTime() - new Date(state.lastChangedAt).getTime();
        if (quietForMs >= args.settleMs) {
            await finishRound(state, gitRoot, signature);
            state.idleBaseline = await createBaseline(gitRoot, signature);
        }
    }
    if (args.syncOnline && shouldSync(state.lastSyncAt, now)) {
        state.lastSyncAt = now.toISOString();
        await saveState(state);
        await syncOnline();
        return;
    }
    await saveState(state);
}
async function createBaseline(gitRoot, signature) {
    const startedAt = new Date().toISOString();
    const snapshot = await createCodeSnapshot(gitRoot);
    const baseline = await saveRoundBaseline(conversationId, gitRoot, snapshot);
    return {
        conversationId,
        projectPath: gitRoot,
        startedAt,
        baselineId: baseline.baselineId,
        baselinePath: baseline.path,
        baselineCreatedAt: snapshot.createdAt,
        promptText: args.promptText,
        signatureAtStart: signature,
    };
}
async function finishRound(state, gitRoot, signature) {
    if (!state.activeRound)
        return;
    const endedAt = new Date().toISOString();
    const snapshotRaw = await readFile(state.activeRound.baselinePath, "utf8");
    const stats = await getCodeStatsSinceSnapshot(gitRoot, JSON.parse(snapshotRaw));
    if (stats.codeLinesChanged <= 0) {
        state.activeRound = null;
        await saveState(state);
        return;
    }
    const recorded = await recordRound({
        conversationId: state.activeRound.conversationId,
        startedAt: state.activeRound.startedAt,
        endedAt,
        modelName: args.modelName,
        promptText: state.activeRound.promptText,
        filesChanged: stats.filesChanged,
        linesAdded: stats.linesAdded,
        linesDeleted: stats.linesDeleted,
        codeLinesChanged: stats.codeLinesChanged,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        metadata: {
            client: args.client,
            projectPath: gitRoot,
            autoRecorded: true,
            workerId,
            baselineId: state.activeRound.baselineId,
            baselinePath: state.activeRound.baselinePath,
            baselineCreatedAt: state.activeRound.baselineCreatedAt,
            signatureAtStart: state.activeRound.signatureAtStart,
            signatureAtEnd: signature,
            ...stats.metadata,
            tokenStatsSource: "pending_log_backfill",
            tokenStatsUnavailable: true,
        },
    });
    state.recordedSignatures = [...state.recordedSignatures, signature].slice(-100);
    state.activeRound = null;
    await saveState(state);
    console.log(`Recorded round ${recorded.id}: ${recorded.codeLinesChanged} changed lines`);
}
async function getWorkspaceSignature(gitRoot) {
    const { stdout } = await execFileAsync("git", [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
    ], {
        cwd: gitRoot,
        maxBuffer: 20 * 1024 * 1024,
    });
    return stdout
        .split(/\r?\n/u)
        .filter((line) => line && !line.includes(".mcp-toolbox/"))
        .filter((line) => !isStorageStatusLine(gitRoot, line))
        .sort()
        .join("\n");
}
function isStorageStatusLine(gitRoot, line) {
    const filePath = line.slice(3).trim();
    const storageRoot = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(gitRoot, ".mcp-toolbox"));
    const fullPath = resolve(gitRoot, filePath);
    const normalizedStorageRoot = normalizePathForCompare(storageRoot);
    const normalizedFullPath = normalizePathForCompare(fullPath);
    return normalizedFullPath === normalizedStorageRoot || normalizedFullPath.startsWith(`${normalizedStorageRoot}/`);
}
function normalizePathForCompare(value) {
    return resolve(value).replaceAll("\\", "/").toLowerCase();
}
async function syncOnline() {
    await patchAutoSyncState({
        currentStep: "sync:online",
        currentStatus: "running",
        lastOnlineSyncAt: new Date().toISOString(),
        lastOnlineSyncStartedAt: new Date().toISOString(),
    });
    const child = spawn(process.execPath, ["dist/sync-to-online.js"], {
        cwd: process.cwd(),
        stdio: "pipe",
        env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
        output += String(chunk);
    });
    const exitCode = await new Promise((resolveExit) => {
        child.on("exit", resolveExit);
    });
    await patchAutoSyncState({
        lastOnlineSyncAt: new Date().toISOString(),
        lastOnlineSyncFinishedAt: new Date().toISOString(),
        lastOnlineSyncStatus: exitCode === 0 ? "completed" : "failed",
        currentStep: null,
        currentStatus: null,
        lastOnlineSyncSummary: {
            exitCode,
            output: output.trim().slice(-4000),
        },
    });
}
function shouldSync(lastSyncAt, now) {
    if (!lastSyncAt)
        return true;
    return now.getTime() - new Date(lastSyncAt).getTime() >= args.syncIntervalMs;
}
async function loadState() {
    const raw = await readFile(statePath, "utf8").catch(() => null);
    if (!raw) {
        return {
            activeRound: null,
            idleBaseline: null,
            lastSignature: null,
            lastChangedAt: null,
            lastSyncAt: null,
            recordedSignatures: [],
        };
    }
    const parsed = JSON.parse(raw);
    return {
        activeRound: parsed.activeRound ?? null,
        idleBaseline: parsed.idleBaseline ?? null,
        lastSignature: parsed.lastSignature ?? null,
        lastChangedAt: parsed.lastChangedAt ?? null,
        lastSyncAt: parsed.lastSyncAt ?? null,
        recordedSignatures: Array.isArray(parsed.recordedSignatures) ? parsed.recordedSignatures : [],
    };
}
async function saveState(state) {
    await mkdir(storageDir, { recursive: true });
    const tempPath = `${statePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, statePath);
}
function parseArgs(argv) {
    const parsed = {
        projectPath: process.env.AI_CODING_PROJECT_PATH || process.cwd(),
        conversationId: process.env.AI_CODING_CONVERSATION_ID || "",
        promptText: process.env.AI_CODING_PROMPT_TEXT || "auto recorded AI coding round",
        modelName: process.env.AI_CODING_MODEL_NAME || "unknown",
        client: parseClient(process.env.AI_CODING_CLIENT),
        pollIntervalMs: readNumber(process.env.AI_CODING_AUTO_POLL_MS, 5000),
        settleMs: readNumber(process.env.AI_CODING_AUTO_SETTLE_MS, 120000),
        syncIntervalMs: readNumber(process.env.AI_CODING_AUTO_SYNC_MS, 300000),
        syncOnline: process.env.AI_CODING_AUTO_SYNC_ONLINE !== "0",
        dialogue: process.env.AI_CODING_RECORD_DIALOGUE === "1",
        sourceEventId: process.env.AI_CODING_SOURCE_EVENT_ID || "",
        turnId: process.env.AI_CODING_TURN_ID || "",
        startedAt: process.env.AI_CODING_STARTED_AT || "",
        endedAt: process.env.AI_CODING_ENDED_AT || "",
        inputTokens: readNonNegativeNumber(process.env.AI_CODING_INPUT_TOKENS, 0),
        outputTokens: readNonNegativeNumber(process.env.AI_CODING_OUTPUT_TOKENS, 0),
        totalTokens: readNonNegativeNumber(process.env.AI_CODING_TOTAL_TOKENS, 0),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === "--project-path" && next) {
            parsed.projectPath = next;
            index += 1;
        }
        else if (arg === "--conversation-id" && next) {
            parsed.conversationId = next;
            index += 1;
        }
        else if (arg === "--prompt-text" && next) {
            parsed.promptText = next;
            index += 1;
        }
        else if (arg === "--model-name" && next) {
            parsed.modelName = next;
            index += 1;
        }
        else if (arg === "--client" && next) {
            parsed.client = parseClient(next);
            index += 1;
        }
        else if (arg === "--poll-interval-ms" && next) {
            parsed.pollIntervalMs = readNumber(next, parsed.pollIntervalMs);
            index += 1;
        }
        else if (arg === "--settle-ms" && next) {
            parsed.settleMs = readNumber(next, parsed.settleMs);
            index += 1;
        }
        else if (arg === "--sync-interval-ms" && next) {
            parsed.syncIntervalMs = readNumber(next, parsed.syncIntervalMs);
            index += 1;
        }
        else if (arg === "--no-sync-online") {
            parsed.syncOnline = false;
        }
        else if (arg === "--dialogue") {
            parsed.dialogue = true;
        }
        else if (arg === "--source-event-id" && next) {
            parsed.sourceEventId = next;
            index += 1;
        }
        else if (arg === "--turn-id" && next) {
            parsed.turnId = next;
            index += 1;
        }
        else if (arg === "--started-at" && next) {
            parsed.startedAt = next;
            index += 1;
        }
        else if (arg === "--ended-at" && next) {
            parsed.endedAt = next;
            index += 1;
        }
        else if (arg === "--input-tokens" && next) {
            parsed.inputTokens = readNonNegativeNumber(next, parsed.inputTokens);
            index += 1;
        }
        else if (arg === "--output-tokens" && next) {
            parsed.outputTokens = readNonNegativeNumber(next, parsed.outputTokens);
            index += 1;
        }
        else if (arg === "--total-tokens" && next) {
            parsed.totalTokens = readNonNegativeNumber(next, parsed.totalTokens);
            index += 1;
        }
    }
    return parsed;
}
function readNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function readNonNegativeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
function parseClient(value) {
    return value === "claude-code" ? "claude-code" : "codex";
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
