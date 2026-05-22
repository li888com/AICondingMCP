#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createCodeSnapshot, findGitRoot, loadRoundBaseline, saveRoundBaseline, } from "./code-stats.js";
import { recordRound } from "./database.js";
import { getAutoSyncState, getRounds, getTokenUsageEvents, patchAutoSyncState, } from "./local-storage.js";
const args = process.argv.slice(2);
await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
async function main() {
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
    if (command === "finish") {
        await finish(rest);
        return;
    }
    if (command === "sync") {
        await runScript("sync:online", rest);
        return;
    }
    if (command === "tokens") {
        if (rest[0] !== "sync") {
            throw new Error("Usage: ai-coding-stats tokens sync [--round-id <id>] [--client codex|claude-code|all]");
        }
        await runScript("tokens:backfill", rest.slice(1));
        return;
    }
    if (command === "pipeline") {
        await runScript("sync:pipeline", rest);
        return;
    }
    if (command === "doctor") {
        await doctor();
        return;
    }
    if (command === "stop") {
        await stop();
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}
async function start(argv) {
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
async function begin(argv) {
    const parsed = parseOptions(argv);
    const projectPath = resolve(parsed.projectPath ?? process.cwd());
    const gitRoot = await findGitRoot(projectPath);
    if (!gitRoot) {
        throw new Error(`No Git workspace found for ${projectPath}`);
    }
    const conversationId = parsed.conversationId ?? defaultConversationId(gitRoot);
    const snapshot = await createCodeSnapshot(gitRoot);
    const saved = await saveRoundBaseline(conversationId, gitRoot, snapshot);
    console.log(JSON.stringify({
        conversationId,
        projectPath: gitRoot,
        startedAt: snapshot.createdAt,
        baselineId: saved.baselineId,
        baselinePath: saved.path,
        filesTracked: snapshot.files.length,
    }, null, 2));
}
async function finish(argv) {
    const parsed = parseOptions(argv);
    const projectPath = resolve(parsed.projectPath ?? process.cwd());
    const gitRoot = await findGitRoot(projectPath);
    if (!gitRoot) {
        throw new Error(`No Git workspace found for ${projectPath}`);
    }
    const conversationId = parsed.conversationId ?? defaultConversationId(gitRoot);
    const baseline = await loadRoundBaseline(conversationId, gitRoot);
    const endedAt = new Date().toISOString();
    const startedAt = parsed.startedAt ?? baseline?.snapshot.createdAt ?? endedAt;
    const recorded = await recordRound({
        conversationId,
        startedAt,
        endedAt,
        modelName: parsed.modelName ?? "unknown",
        promptText: parsed.promptText ?? "auto finished AI coding round",
        totalTokens: 0,
        metadata: {
            client: parsed.client ?? "codex",
            projectPath: gitRoot,
            turnId: parsed.turnId ?? undefined,
            autoFinished: true,
            ...(baseline ? {
                baselineId: baseline.baselineId,
                baselinePath: baseline.path,
                baselineCreatedAt: baseline.snapshot.createdAt,
            } : {
                baselineMissing: true,
            }),
            tokenStatsSource: "pending_log_backfill",
            tokenStatsUnavailable: true,
        },
    });
    console.log(JSON.stringify({
        recorded,
        next: parsed.noPipeline
            ? "pipeline skipped"
            : "token backfill and online sync pipeline started",
    }, null, 2));
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
async function status() {
    const [rounds, tokenEvents, state] = await Promise.all([
        getRounds(),
        getTokenUsageEvents(),
        getAutoSyncState(),
    ]);
    const pendingTokens = rounds.filter((round) => ["pending", "failed", "needs_review"].includes(round.tokenSyncStatus)).length;
    const pendingUploads = rounds.filter((round) => round._sync?.status !== "synced" && round._sync?.status !== "skipped").length;
    const latestRound = [...rounds].sort((a, b) => b.id - a.id)[0] ?? null;
    console.log(JSON.stringify({
        autoRunner: state ?? { status: "idle" },
        rounds: rounds.length,
        pendingTokens,
        pendingUploads,
        tokenUsageEvents: tokenEvents.length,
        latestRound: latestRound
            ? {
                id: latestRound.id,
                conversationId: latestRound.conversationId,
                endedAt: latestRound.endedAt,
                codeLinesChanged: latestRound.codeLinesChanged,
                totalTokens: latestRound.totalTokens,
                tokenSyncStatus: latestRound.tokenSyncStatus,
            }
            : null,
    }, null, 2));
}
async function doctor() {
    const checks = [
        await checkCommand("node", ["--version"]),
        await checkCommand(npmCommand(), ["--version"], "npm"),
        await checkCommand("git", ["--version"]),
        await checkBuildOutput(),
    ];
    for (const check of checks) {
        console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
    }
    if (checks.some((check) => !check.ok)) {
        process.exitCode = 1;
    }
}
async function stop() {
    const state = await getAutoSyncState();
    const pid = state?.pid;
    if (!pid || state?.status !== "running") {
        console.log("No running auto-runner found.");
        return;
    }
    try {
        process.kill(pid, process.platform === "win32" ? undefined : "SIGTERM");
        await patchAutoSyncState({
            status: "stopped",
            lastHeartbeatAt: new Date().toISOString(),
            lastError: null,
        });
        console.log(`Stopped auto-runner pid ${pid}.`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await patchAutoSyncState({ status: "failed", lastError: message });
        throw new Error(`Failed to stop auto-runner pid ${pid}: ${message}`);
    }
}
async function runScript(script, argv) {
    const result = await runCommand(npmCommand(), ["run", script, "--", ...argv]);
    process.stdout.write(result.output);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}
function startDetachedNpmScript(script, argv) {
    const child = spawnCommand(npmCommand(), ["run", script, "--", ...argv], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: process.env,
    });
    child.unref();
}
async function checkCommand(command, argv, name = command) {
    const result = await runCommand(command, argv).catch((error) => ({
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
    }));
    return {
        name,
        ok: result.exitCode === 0,
        detail: result.output.trim().split(/\r?\n/u)[0] ?? "",
    };
}
function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}
async function checkBuildOutput() {
    const distPath = resolve("dist", "ai-coding-stats-server.js");
    try {
        await access(distPath);
        return { name: "dist", ok: true, detail: distPath };
    }
    catch {
        return { name: "dist", ok: false, detail: "Run npm run build before production use" };
    }
}
function runCommand(command, argv) {
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
function spawnCommand(command, argv, options) {
    if (process.platform !== "win32" || !command.endsWith(".cmd")) {
        return spawn(command, argv, options);
    }
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...argv], options);
}
function parseOptions(argv) {
    const parsed = {};
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
        else if (arg === "--client" && next) {
            parsed.client = next;
            index += 1;
        }
        else if (arg === "--model-name" && next) {
            parsed.modelName = next;
            index += 1;
        }
        else if (arg === "--prompt-text" && next) {
            parsed.promptText = next;
            index += 1;
        }
        else if (arg === "--poll-interval-ms" && next) {
            parsed.pollIntervalMs = next;
            index += 1;
        }
        else if (arg === "--settle-ms" && next) {
            parsed.settleMs = next;
            index += 1;
        }
        else if (arg === "--started-at" && next) {
            parsed.startedAt = next;
            index += 1;
        }
        else if (arg === "--turn-id" && next) {
            parsed.turnId = next;
            index += 1;
        }
        else if (arg === "--token-delay-ms" && next) {
            parsed.tokenDelayMs = next;
            index += 1;
        }
        else if (arg === "--no-sync-online") {
            parsed.noSyncOnline = true;
        }
        else if (arg === "--no-pipeline") {
            parsed.noPipeline = true;
        }
    }
    return parsed;
}
function defaultConversationId(projectPath) {
    const normalized = resolve(projectPath).replaceAll("\\", "/");
    return `codex:${normalized.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase())}`;
}
function printHelp() {
    console.log(`Usage: ai-coding-stats <command>

Commands:
  start       Start the background auto-runner for the current Git workspace
  begin       Capture a Git baseline for one explicit coding round
  finish      Record the current round, then queue token backfill and upload
  status      Print local rounds, token, upload, and worker state
  sync        Upload pending local data to the configured online API
  tokens sync Backfill pending token usage from Codex/Claude logs
  pipeline    Run online sync, token backfill, then online sync again
  doctor      Check local runtime prerequisites
  stop        Stop the background auto-runner started by this CLI
`);
}
