import { spawn } from "node:child_process";
import { z } from "zod";
import { createCodeSnapshot, findGitRoot, getCodeStatsSinceSnapshot, getWorkspaceCodeStats, loadRoundBaseline, saveRoundBaseline, } from "../code-stats.js";
import { recordDialogueTokenUsage, recordRound, recordRoundRevert } from "../database.js";
const nonNegativeInteger = z.number().int().nonnegative();
export function registerAiCodingStatsTools(server, hooks = {}) {
    server.tool("record_dialogue_token_usage", "Record token usage for any dialogue turn, including turns that did not change code and therefore do not have an AI Coding round.", {
        conversationId: z.string().min(1).describe("Stable id for the AI conversation/thread."),
        roundId: z.number().int().positive().optional().describe("AI Coding round id to bind this token usage to. If omitted, the result reminds the caller to bind a project."),
        client: z.enum(["codex", "claude-code"]).optional().describe("AI coding client. Defaults to codex."),
        sourcePath: z.string().optional().describe("Source log path or logical source. Defaults to this MCP tool."),
        sourceEventId: z.string().optional().describe("Stable source event id for idempotency when available."),
        turnId: z.string().optional().describe("Stable turn id when available."),
        modelName: z.string().optional().describe("AI model name used in this dialogue turn."),
        startedAt: z.string().datetime().optional().describe("Dialogue start time, ISO 8601."),
        endedAt: z.string().datetime().optional().describe("Dialogue end time, ISO 8601. Defaults to now."),
        inputTokens: nonNegativeInteger.optional().describe("Consumed input tokens."),
        outputTokens: nonNegativeInteger.optional().describe("Consumed output tokens."),
        totalTokens: nonNegativeInteger
            .optional()
            .describe("Total consumed tokens. Defaults to inputTokens + outputTokens."),
        promptText: z.string().optional().describe("User prompt text for this turn, if available."),
        metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    }, withLifecycle(hooks, async (input) => {
        const recorded = await recordDialogueTokenUsage(input);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(recorded, null, 2)
                }
            ],
            structuredContent: recorded
        };
    }));
    server.tool("begin_ai_coding_round", "Capture a Git workspace baseline at the start of an AI Coding round. record_ai_coding_round can later use this baseline to compute per-round code line stats.", {
        conversationId: z.string().min(1).describe("Stable id for the AI Coding conversation/thread."),
        projectPath: z
            .string()
            .min(1)
            .optional()
            .describe("Absolute Git workspace path. Defaults to metadata.projectPath, project path parsed from conversationId, or the current Git workspace."),
        startedAt: z.string().datetime().optional().describe("Round start time, ISO 8601. Defaults to now."),
        metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    }, withLifecycle(hooks, async (input) => {
        const projectResolution = await resolveProjectPath(input.conversationId, input.projectPath, input.metadata);
        if (!projectResolution.projectPath) {
            const result = {
                conversationId: input.conversationId,
                projectPath: null,
                startedAt: input.startedAt ?? new Date().toISOString(),
                skipped: true,
                reason: projectResolution.reason,
                metadata: input.metadata ?? null,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ],
                structuredContent: result
            };
        }
        const snapshot = await createCodeSnapshot(projectResolution.projectPath);
        const saved = await saveRoundBaseline(input.conversationId, projectResolution.projectPath, snapshot);
        const result = {
            conversationId: input.conversationId,
            projectPath: snapshot.projectPath,
            startedAt: input.startedAt ?? snapshot.createdAt,
            baselineId: saved.baselineId,
            baselinePath: saved.path,
            baselineCreatedAt: snapshot.createdAt,
            filesTracked: snapshot.files.length,
            metadata: input.metadata ?? null,
        };
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                }
            ],
            structuredContent: result
        };
    }));
    server.tool("record_ai_coding_round", "Record one finished AI Coding round into local JSON storage. Code line stats are computed by this MCP from the saved begin_ai_coding_round baseline when available; token usage should be backfilled later from tool logs.", {
        conversationId: z
            .string()
            .min(1)
            .describe("Stable id for the AI Coding conversation/thread."),
        startedAt: z.string().datetime().describe("Round start time, ISO 8601."),
        endedAt: z.string().datetime().describe("Round end time, ISO 8601."),
        modelName: z.string().min(1).describe("AI model name used in this round."),
        promptText: z.string().optional().describe("User prompt text. A token such as #12 means requirement id 12."),
        projectPath: z
            .string()
            .min(1)
            .optional()
            .describe("Absolute Git workspace path. Defaults to metadata.projectPath or project path parsed from conversationId."),
        filesChanged: nonNegativeInteger.optional().describe("Number of changed files."),
        linesAdded: nonNegativeInteger.optional().describe("Added code lines."),
        linesDeleted: nonNegativeInteger.optional().describe("Deleted code lines."),
        codeLinesChanged: nonNegativeInteger
            .optional()
            .describe("Total changed code lines. Defaults to linesAdded + linesDeleted."),
        inputTokens: nonNegativeInteger.optional().describe("Consumed input tokens."),
        outputTokens: nonNegativeInteger.optional().describe("Consumed output tokens."),
        totalTokens: nonNegativeInteger
            .optional()
            .describe("Total consumed tokens. Defaults to inputTokens + outputTokens."),
        metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    }, withLifecycle(hooks, async (input) => {
        const projectResolution = await resolveProjectPath(input.conversationId, input.projectPath, input.metadata);
        const projectPath = projectResolution.projectPath;
        const computedCodeStats = projectPath ? await computeMcpCodeStats(input.conversationId, projectPath) : null;
        const metadata = {
            ...(input.metadata ?? {}),
            ...(projectPath ? { projectPath } : {}),
            ...(computedCodeStats?.metadata ?? {
                codeStatsSource: input.codeLinesChanged !== undefined ? "mcp payload explicit code stats" : "mcp code stats unavailable",
                codeStatsPrecision: input.codeLinesChanged !== undefined ? "payload-explicit" : "unavailable",
                codeStatsSkippedReason: projectResolution.reason,
            }),
            tokenStatsSource: "tool_log_backfill",
            tokenStatsUnavailable: (input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0)) <= 0,
        };
        const recorded = await recordRound({
            ...input,
            filesChanged: computedCodeStats?.filesChanged ?? input.filesChanged,
            linesAdded: computedCodeStats?.linesAdded ?? input.linesAdded,
            linesDeleted: computedCodeStats?.linesDeleted ?? input.linesDeleted,
            codeLinesChanged: computedCodeStats?.codeLinesChanged ?? input.codeLinesChanged,
            inputTokens: input.inputTokens ?? 0,
            outputTokens: input.outputTokens ?? 0,
            totalTokens: input.totalTokens ?? 0,
            metadata,
        });
        triggerOnlineSyncPipeline(recorded.id, metadata);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(recorded, null, 2)
                }
            ],
            structuredContent: recorded
        };
    }));
    server.tool("record_ai_coding_round_revert", "Record that a previous AI Coding round's code changes were reverted. The original round is preserved for audit, and effective statistics should exclude reverted rounds.", {
        conversationId: z
            .string()
            .min(1)
            .describe("Stable id for the AI Coding conversation/thread."),
        targetRoundId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Round id to mark as reverted. If omitted, the latest active round in the conversation is used."),
        revertedAt: z.string().datetime().describe("Revert completion time, ISO 8601."),
        modelName: z.string().min(1).describe("AI model name used for the revert operation."),
        promptText: z.string().optional().describe("User prompt that requested the revert."),
        reason: z.string().max(512).optional().describe("Short reason for the revert."),
        filesChanged: nonNegativeInteger.optional().describe("Number of files changed by the revert operation."),
        linesAdded: nonNegativeInteger.optional().describe("Added lines from the revert operation."),
        linesDeleted: nonNegativeInteger.optional().describe("Deleted lines from the revert operation."),
        codeLinesChanged: nonNegativeInteger
            .optional()
            .describe("Total changed code lines from the revert operation. Defaults to linesAdded + linesDeleted."),
        inputTokens: nonNegativeInteger.optional().describe("Consumed input tokens for the revert operation."),
        outputTokens: nonNegativeInteger.optional().describe("Consumed output tokens for the revert operation."),
        totalTokens: nonNegativeInteger
            .optional()
            .describe("Total consumed tokens for the revert operation. Defaults to inputTokens + outputTokens."),
        metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    }, withLifecycle(hooks, async (input) => {
        const recorded = await recordRoundRevert(input);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(recorded, null, 2)
                }
            ],
            structuredContent: recorded
        };
    }));
}
function withLifecycle(hooks, handler) {
    return async (input) => {
        hooks.beforeRequest?.();
        try {
            return await handler(input);
        }
        finally {
            hooks.afterRequest?.();
        }
    };
}
function triggerOnlineSyncPipeline(roundId, metadata) {
    if (process.env.AI_CODING_AUTO_UPLOAD_ON_MCP === "0") {
        return;
    }
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const args = [
        "run",
        "sync:pipeline:start",
        "--",
        "--round-id",
        String(roundId),
        "--client",
        typeof metadata.client === "string" ? metadata.client : "codex",
        "--delay-ms",
        process.env.AI_CODING_TOKEN_BACKFILL_DELAY_MS ?? "120000",
    ];
    const child = spawn(command, process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args, {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: process.env,
    });
    child.unref();
}
async function computeMcpCodeStats(conversationId, projectPath) {
    const baseline = await loadRoundBaseline(conversationId, projectPath);
    if (baseline) {
        const stats = await getCodeStatsSinceSnapshot(projectPath, baseline.snapshot);
        return {
            ...stats,
            metadata: {
                ...stats.metadata,
                baselineId: baseline.baselineId,
                baselinePath: baseline.path,
            }
        };
    }
    return getWorkspaceCodeStats(projectPath).then((stats) => ({
        ...stats,
        metadata: {
            ...stats.metadata,
            codeStatsNote: "No begin_ai_coding_round baseline found; used workspace cumulative diff as fallback",
        }
    })).catch((error) => ({
        filesChanged: 0,
        linesAdded: 0,
        linesDeleted: 0,
        codeLinesChanged: 0,
        metadata: {
            codeStatsSource: "mcp code stats unavailable",
            codeStatsPrecision: "unavailable",
            codeStatsError: error instanceof Error ? error.message : String(error),
        }
    }));
}
async function resolveProjectPath(conversationId, explicitProjectPath, metadata) {
    const candidates = [
        explicitProjectPath,
        stringValue(metadata?.projectPath),
        projectFromConversationId(conversationId),
        process.env.AI_CODING_PROJECT_PATH,
        process.env.CODEX_WORKSPACE,
        process.env.WORKSPACE_FOLDER,
        process.cwd(),
    ].filter((value) => Boolean(value));
    for (const candidate of candidates) {
        const gitRoot = await findGitRoot(candidate);
        if (gitRoot) {
            return { projectPath: gitRoot };
        }
    }
    return {
        projectPath: null,
        reason: "No Git workspace found from projectPath, metadata.projectPath, conversationId, workspace environment variables, or current working directory",
    };
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function projectFromConversationId(conversationId) {
    const marker = ":";
    const index = conversationId.indexOf(marker);
    if (index === -1)
        return undefined;
    const value = conversationId.slice(index + marker.length).trim();
    return value || undefined;
}
