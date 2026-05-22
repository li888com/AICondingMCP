import { z } from "zod";
import { createCodeSnapshot, getCodeStatsSinceSnapshot, getWorkspaceCodeStats, loadRoundBaseline, saveRoundBaseline, } from "../code-stats.js";
import { recordRound, recordRoundRevert } from "../database.js";
const nonNegativeInteger = z.number().int().nonnegative();
export function registerAiCodingStatsTools(server) {
    server.tool("begin_ai_coding_round", "Capture a Git workspace baseline at the start of an AI Coding round. record_ai_coding_round can later use this baseline to compute per-round code line stats.", {
        conversationId: z.string().min(1).describe("Stable id for the AI Coding conversation/thread."),
        projectPath: z.string().min(1).describe("Absolute Git workspace path."),
        startedAt: z.string().datetime().optional().describe("Round start time, ISO 8601. Defaults to now."),
        metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    }, async (input) => {
        const snapshot = await createCodeSnapshot(input.projectPath);
        const saved = await saveRoundBaseline(input.conversationId, input.projectPath, snapshot);
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
    });
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
    }, async (input) => {
        const projectPath = input.projectPath ?? stringValue(input.metadata?.projectPath) ?? projectFromConversationId(input.conversationId);
        const computedCodeStats = projectPath ? await computeMcpCodeStats(input.conversationId, projectPath) : null;
        const metadata = {
            ...(input.metadata ?? {}),
            ...(projectPath ? { projectPath } : {}),
            ...(computedCodeStats?.metadata ?? {
                codeStatsSource: input.codeLinesChanged !== undefined ? "mcp payload explicit code stats" : "mcp code stats unavailable",
                codeStatsPrecision: input.codeLinesChanged !== undefined ? "payload-explicit" : "unavailable",
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
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(recorded, null, 2)
                }
            ],
            structuredContent: recorded
        };
    });
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
    }, async (input) => {
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
    });
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
