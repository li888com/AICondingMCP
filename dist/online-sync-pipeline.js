import { spawn } from "node:child_process";
import { patchAutoSyncState } from "./local-storage.js";
const args = parseArgs(process.argv.slice(2));
async function main() {
    await runNpmScript("sync:online", [
        "--",
        "--retry-failed-now",
        ...(args.roundId ? ["--round-id", String(args.roundId)] : []),
    ]);
    if (args.delayMs > 0) {
        await delay(args.delayMs);
    }
    const backfillArgs = [
        "--",
        ...(args.roundId ? ["--round-id", String(args.roundId)] : []),
        "--client",
        args.client,
    ];
    await runNpmScript("tokens:backfill", backfillArgs);
    await runNpmScript("sync:online", [
        "--",
        "--retry-failed-now",
        ...(args.roundId ? ["--round-id", String(args.roundId)] : []),
    ]);
    await patchAutoSyncState({ lastError: null });
}
async function runNpmScript(script, extraArgs) {
    const startedAt = new Date().toISOString();
    await patchAutoSyncState({
        currentStep: script,
        currentStatus: "running",
        ...(script === "sync:online" ? { lastOnlineSyncAt: startedAt, lastOnlineSyncStartedAt: startedAt } : {}),
        ...(script === "tokens:backfill" ? { lastTokenSyncAt: startedAt, lastTokenSyncStartedAt: startedAt } : {}),
    });
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const childArgs = ["run", script, ...extraArgs];
    const child = spawn(command, process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...childArgs] : childArgs, {
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
    if (script === "sync:online") {
        await patchAutoSyncState({
            lastOnlineSyncAt: new Date().toISOString(),
            lastOnlineSyncFinishedAt: new Date().toISOString(),
            lastOnlineSyncStatus: exitCode === 0 ? "completed" : "failed",
            lastOnlineSyncSummary: {
                script,
                exitCode,
                output: output.trim().slice(-4000),
            },
            currentStep: null,
            currentStatus: null,
        });
    }
    else if (script === "tokens:backfill") {
        await patchAutoSyncState({
            lastTokenSyncAt: new Date().toISOString(),
            lastTokenSyncFinishedAt: new Date().toISOString(),
            lastTokenSyncStatus: exitCode === 0 ? "completed" : "failed",
            lastTokenSyncSummary: {
                script,
                exitCode,
                output: output.trim().slice(-4000),
            },
            currentStep: null,
            currentStatus: null,
        });
    }
    if (exitCode !== 0) {
        throw new Error(`${script} failed with exit code ${exitCode}: ${output.trim().slice(-1000)}`);
    }
}
function parseArgs(argv) {
    const parsed = {
        roundId: null,
        delayMs: readNumber(process.env.AI_CODING_TOKEN_BACKFILL_DELAY_MS, 2 * 60 * 1000),
        client: parseClient(process.env.AI_CODING_CLIENT),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === "--round-id" && next) {
            parsed.roundId = readNumber(next, 0) || null;
            index += 1;
        }
        else if (arg === "--delay-ms" && next) {
            parsed.delayMs = readNumber(next, parsed.delayMs);
            index += 1;
        }
        else if (arg === "--client" && next) {
            parsed.client = parseClient(next);
            index += 1;
        }
    }
    return parsed;
}
function parseClient(value) {
    if (value === "claude-code")
        return "claude-code";
    if (value === "all")
        return "all";
    return "codex";
}
function readNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await patchAutoSyncState({
        lastError: message,
    }).catch(() => undefined);
    console.error(message);
    process.exitCode = 1;
});
