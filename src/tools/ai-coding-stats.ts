import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  cleanupRoundBaselines,
  createCodeSnapshot,
  deleteRoundBaseline,
  findGitRoot,
  getCodeStatsSinceSnapshot,
  listRoundBaselines,
  loadRoundBaseline,
  saveRoundBaseline,
} from "../code-stats.js";
import { recordDialogueTokenUsage, recordRound, recordRoundRevert } from "../database.js";
import { upsertDialogueTurn } from "../local-storage.js";

const nonNegativeInteger = z.number().int().nonnegative();

type RequestLifecycleHooks = {
  beforeRequest?: () => void;
  afterRequest?: () => void;
};

export function registerAiCodingStatsTools(server: McpServer, hooks: RequestLifecycleHooks = {}): void {
  server.tool(
    "begin_ai_dialogue_turn",
    "Force-start one dialogue turn. This captures a baseline up front so every conversation turn can be closed consistently later, even if no code changes happen.",
    {
      conversationId: z.string().min(1).describe("Stable id for the AI conversation/thread."),
      projectPath: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute Git workspace path. Defaults to metadata.projectPath, project path parsed from conversationId, or the current Git workspace."),
      startedAt: z.string().datetime().optional().describe("Dialogue turn start time, ISO 8601. Defaults to now."),
      turnId: z.string().min(1).describe("Stable turn id for this dialogue turn."),
      promptText: z.string().optional().describe("User prompt text for this turn."),
      client: z.enum(["codex", "claude-code"]).optional().describe("AI coding client. Defaults to codex."),
      modelName: z.string().optional().describe("AI model name expected for this turn."),
      metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    },
    withLifecycle(hooks, async (input) => {
      const projectResolution = await resolveProjectPath(input.conversationId, input.projectPath, input.metadata);
      const startedAt = input.startedAt ?? new Date().toISOString();
      const metadata = {
        ...(input.metadata ?? {}),
        turnId: input.turnId,
        promptText: input.promptText ?? null,
        client: input.client ?? stringValue(input.metadata?.client) ?? "codex",
        modelName: input.modelName ?? stringValue(input.metadata?.modelName) ?? null,
      };

      if (!projectResolution.projectPath) {
        const result = {
          conversationId: input.conversationId,
          projectPath: null,
          startedAt,
          turnId: input.turnId,
          skipped: true,
          reason: projectResolution.reason,
          metadata,
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
      const saved = await saveRoundBaseline(input.conversationId, projectResolution.projectPath, snapshot, {
        turnId: input.turnId,
        startedAt,
      });
      const result = {
        conversationId: input.conversationId,
        projectPath: snapshot.projectPath,
        startedAt,
        baselineId: saved.baselineId,
        baselinePath: saved.path,
        baselineCreatedAt: snapshot.createdAt,
        filesTracked: snapshot.files.length,
        turnId: input.turnId,
        mode: "dialogue",
        metadata,
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
    })
  );

  server.tool(
    "list_ai_dialogue_baselines",
    "List unfinished dialogue baselines that are still present on disk.",
    {},
    withLifecycle(hooks, async () => {
      const baselines = await listRoundBaselines();
      const result = {
        count: baselines.length,
        baselines,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    })
  );

  server.tool(
    "cleanup_ai_dialogue_baselines",
    "Delete stale dialogue baselines older than the given threshold.",
    {
      maxAgeMinutes: nonNegativeInteger.optional().describe("Delete baselines older than this many minutes. Defaults to 1440."),
    },
    withLifecycle(hooks, async (input) => {
      const maxAgeMinutes = input.maxAgeMinutes ?? 1440;
      const result = await cleanupRoundBaselines(maxAgeMinutes * 60 * 1000);
      const payload = {
        maxAgeMinutes,
        deleted: result.deleted.length,
        kept: result.kept,
        baselines: result.deleted,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    })
  );

  server.tool(
    "record_dialogue_token_usage",
    "Record token usage for any dialogue turn, including turns that did not change code and therefore do not have an AI Coding round.",
    {
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
    },
    withLifecycle(hooks, async (input) => {
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
    })
  );

  server.tool(
    "begin_ai_coding_round",
    "Capture a Git workspace baseline at the start of an AI Coding round. record_ai_coding_round can later use this baseline to compute per-round code line stats.",
    {
      conversationId: z.string().min(1).describe("Stable id for the AI Coding conversation/thread."),
      projectPath: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute Git workspace path. Defaults to metadata.projectPath, project path parsed from conversationId, or the current Git workspace."),
      startedAt: z.string().datetime().optional().describe("Round start time, ISO 8601. Defaults to now."),
      turnId: z.string().optional().describe("Stable turn id for this AI coding round. Use this to isolate multiple dialogue rounds in the same conversation."),
      metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    },
    withLifecycle(hooks, async (input) => {
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
      const startedAt = input.startedAt ?? snapshot.createdAt;
      const saved = await saveRoundBaseline(input.conversationId, projectResolution.projectPath, snapshot, {
        turnId: input.turnId,
        startedAt,
      });
      const result = {
        conversationId: input.conversationId,
        projectPath: snapshot.projectPath,
        startedAt,
        baselineId: saved.baselineId,
        baselinePath: saved.path,
        baselineCreatedAt: snapshot.createdAt,
        filesTracked: snapshot.files.length,
        turnId: input.turnId ?? null,
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
    })
  );

  server.tool(
    "record_ai_coding_round",
    "Record one finished AI Coding round into local JSON storage. Code line stats are computed by this MCP from the saved begin_ai_coding_round baseline when available; token usage should be backfilled later from tool logs.",
    {
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
    },
    withLifecycle(hooks, async (input) => {
      const projectResolution = await resolveProjectPath(input.conversationId, input.projectPath, input.metadata);
      const projectPath = projectResolution.projectPath;
      const turnId = stringValue(input.metadata?.turnId);
      const computedCodeStats = projectPath ? await computeMcpCodeStats(input.conversationId, projectPath, turnId) : null;
      const hasExplicitCodeStats = input.codeLinesChanged !== undefined || input.linesAdded !== undefined || input.linesDeleted !== undefined || input.filesChanged !== undefined;
      if (projectPath && !computedCodeStats && !hasExplicitCodeStats) {
        throw new Error("No begin_ai_coding_round baseline found. Accurate per-dialogue code stats require calling begin_ai_coding_round before record_ai_coding_round.");
      }
      const metadata = {
        ...(input.metadata ?? {}),
        ...(projectPath ? { projectPath } : {}),
        ...(computedCodeStats?.metadata ?? {
          codeStatsSource: input.codeLinesChanged !== undefined ? "mcp payload explicit code stats" : "mcp code stats unavailable",
          codeStatsPrecision: input.codeLinesChanged !== undefined ? "payload-explicit" : "unavailable",
          codeStatsSkippedReason: projectResolution.reason,
        }),
        tokenStatsSource: hasTokenPayload(input) ? "mcp_payload" : "pending_log_backfill",
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
        totalTokens: input.totalTokens,
        metadata,
      });
      const summary = buildLineChangeSummary(recorded);
      triggerOnlineSyncPipeline(recorded.id, metadata);

      return {
        content: [
          {
            type: "text",
            text: formatLineChangeSummary(summary)
          }
        ],
        structuredContent: summary
      };
    })
  );

  server.tool(
    "record_ai_coding_round_revert",
    "Record that a previous AI Coding round's code changes were reverted. The original round is preserved for audit, and effective statistics should exclude reverted rounds.",
    {
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
    },
    withLifecycle(hooks, async (input) => {
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
    })
  );

  server.tool(
    "end_ai_dialogue_turn",
    "Force-end one dialogue turn. If code changed since begin_ai_dialogue_turn, record an AI coding round; otherwise record dialogue token usage only.",
    {
      conversationId: z.string().min(1).describe("Stable id for the AI conversation/thread."),
      turnId: z.string().min(1).describe("Stable turn id for this dialogue turn."),
      endedAt: z.string().datetime().optional().describe("Dialogue turn end time, ISO 8601. Defaults to now."),
      startedAt: z.string().datetime().optional().describe("Dialogue turn start time, ISO 8601. Optional override; defaults to the saved baseline time when present."),
      projectPath: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute Git workspace path. Defaults to metadata.projectPath or project path parsed from conversationId."),
      client: z.enum(["codex", "claude-code"]).optional().describe("AI coding client. Defaults to codex."),
      modelName: z.string().optional().describe("AI model name used in this turn."),
      promptText: z.string().optional().describe("User prompt text for this turn."),
      inputTokens: nonNegativeInteger.optional().describe("Consumed input tokens."),
      outputTokens: nonNegativeInteger.optional().describe("Consumed output tokens."),
      totalTokens: nonNegativeInteger
        .optional()
        .describe("Total consumed tokens. Defaults to inputTokens + outputTokens."),
      sourceEventId: z.string().optional().describe("Stable source event id for idempotency when available."),
      sourcePath: z.string().optional().describe("Source log path or logical source for pure dialogue token events."),
      metadata: z.record(z.unknown()).optional().describe("Optional extra structured data.")
    },
    withLifecycle(hooks, async (input) => {
      const projectResolution = await resolveProjectPath(input.conversationId, input.projectPath, input.metadata);
      const endedAt = input.endedAt ?? new Date().toISOString();
      const client = input.client ?? "codex";
      const modelName = input.modelName?.trim() || "unknown";
      const sourceEventId = normalizeSourceEventId(input.sourceEventId, input.conversationId, input.turnId, endedAt, client);
      const metadata = {
        ...(input.metadata ?? {}),
        turnId: input.turnId,
        client,
        modelName,
        ...(projectResolution.projectPath ? { projectPath: projectResolution.projectPath } : {}),
      };

      const projectPath = projectResolution.projectPath;
      const baseline = projectPath
        ? await loadRoundBaseline(input.conversationId, projectPath, { turnId: input.turnId })
        : null;
      const startedAt = input.startedAt ?? baseline?.startedAt ?? baseline?.snapshot.createdAt ?? endedAt;

      let codeStats = null as Awaited<ReturnType<typeof computeMcpCodeStats>>;
      if (projectPath && baseline) {
        codeStats = await computeMcpCodeStats(input.conversationId, projectPath, input.turnId);
      }

      try {
        if (projectPath && codeStats && codeStats.codeLinesChanged > 0) {
          const roundMetadata = {
            ...metadata,
            dialogueTurnMode: "forced-per-turn",
            sourceTool: "end_ai_dialogue_turn",
            ...(input.modelName ? { modelName: input.modelName } : {}),
          };
          const recorded = await recordRound({
            conversationId: input.conversationId,
            startedAt,
            endedAt,
            modelName,
            promptText: input.promptText,
            filesChanged: codeStats.filesChanged,
            linesAdded: codeStats.linesAdded,
            linesDeleted: codeStats.linesDeleted,
            codeLinesChanged: codeStats.codeLinesChanged,
            inputTokens: input.inputTokens ?? 0,
            outputTokens: input.outputTokens ?? 0,
            totalTokens: input.totalTokens,
            metadata: {
              ...roundMetadata,
              ...codeStats.metadata,
              tokenStatsSource: hasTokenPayload(input) ? "mcp_payload" : "pending_log_backfill",
              tokenStatsUnavailable: !hasTokenPayload(input),
            },
          });
          await upsertDialogueTurn({
            conversationId: input.conversationId,
            turnId: input.turnId,
            client,
            modelName,
            startedAt,
            endedAt,
            promptText: input.promptText ?? null,
            mode: "coding_round",
            projectPath,
            roundId: recorded.id,
            tokenUsageEventId: null,
            sourceEventId,
            metadata: roundMetadata,
          });
          const summary = {
            mode: "coding_round" as const,
            turnId: input.turnId,
            startedAt,
            endedAt,
            roundId: recorded.id,
            filesChanged: recorded.filesChanged ?? 0,
            linesAdded: recorded.linesAdded,
            linesDeleted: recorded.linesDeleted,
            codeLinesChanged: recorded.codeLinesChanged,
            totalTokens: recorded.totalTokens,
            tokenSyncStatus: recorded.tokenSyncStatus,
          };
          triggerOnlineSyncPipeline(recorded.id, roundMetadata);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(summary, null, 2)
              }
            ],
            structuredContent: summary
          };
        }

        const dialogue = await recordDialogueTokenUsage({
          conversationId: input.conversationId,
          client,
          sourcePath: input.sourcePath?.trim() || "mcp:end_ai_dialogue_turn",
          sourceEventId,
          turnId: input.turnId,
          modelName,
          startedAt,
          endedAt,
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          totalTokens: input.totalTokens,
          promptText: input.promptText,
          metadata: {
            ...metadata,
            dialogueTurnMode: "forced-per-turn",
            sourceTool: "end_ai_dialogue_turn",
            codeStatsSource: baseline ? "mcp baseline snapshot diff" : "no baseline available",
            codeStatsPrecision: baseline ? "round-baseline-content-diff" : "unavailable",
            codeLinesChanged: 0,
          },
        });
        await upsertDialogueTurn({
          conversationId: input.conversationId,
          turnId: input.turnId,
          client,
          modelName,
          startedAt,
          endedAt,
          promptText: input.promptText ?? null,
          mode: "dialogue_only",
          projectPath,
          roundId: null,
          tokenUsageEventId: dialogue.id,
          sourceEventId: dialogue.sourceEventId,
          metadata,
        });
        const summary = {
          mode: "dialogue_only" as const,
          turnId: input.turnId,
          startedAt,
          endedAt,
          dialogueEventId: dialogue.id,
          sourceEventId: dialogue.sourceEventId,
          totalTokens: dialogue.totalTokens,
          needsProjectBinding: dialogue.needsProjectBinding,
          warning: dialogue.warning,
          hostResponsibility: "Host must call begin_ai_dialogue_turn before each turn and end_ai_dialogue_turn after each turn.",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2)
            }
          ],
          structuredContent: summary
        };
      } finally {
        if (projectPath) {
          await deleteRoundBaseline(input.conversationId, projectPath, { turnId: input.turnId });
        }
      }
    })
  );
}

function buildLineChangeSummary(recorded: {
  id: number;
  filesChanged: number | null;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  totalTokens: number;
  tokenSyncStatus: string;
}) {
  return {
    roundId: recorded.id,
    filesChanged: recorded.filesChanged ?? 0,
    linesAdded: recorded.linesAdded,
    linesDeleted: recorded.linesDeleted,
    codeLinesChanged: recorded.codeLinesChanged,
    totalTokens: recorded.totalTokens,
    tokenSyncStatus: recorded.tokenSyncStatus,
  };
}

function formatLineChangeSummary(summary: {
  roundId: number;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  codeLinesChanged: number;
  totalTokens: number;
  tokenSyncStatus: string;
}): string {
  return `本次记录 round ${summary.roundId}：修改 ${summary.filesChanged} 个文件，新增 ${summary.linesAdded} 行，删除 ${summary.linesDeleted} 行，合计 ${summary.codeLinesChanged} 行；token 状态 ${summary.tokenSyncStatus}，totalTokens ${summary.totalTokens}`;
}

function hasTokenPayload(input: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): boolean {
  return (input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0)) > 0;
}

function normalizeSourceEventId(
  sourceEventId: string | undefined,
  conversationId: string,
  turnId: string,
  endedAt: string,
  client: string
): string {
  const trimmed = sourceEventId?.trim();
  if (trimmed) return trimmed;
  return `${client}:${conversationId.trim().replaceAll("\\", "/")}:${turnId.trim()}:${endedAt}`;
}

function withLifecycle<TInput, TResult>(
  hooks: RequestLifecycleHooks,
  handler: (input: TInput) => Promise<TResult>
): (input: TInput) => Promise<TResult> {
  return async (input) => {
    hooks.beforeRequest?.();
    try {
      return await handler(input);
    } finally {
      hooks.afterRequest?.();
    }
  };
}

function triggerOnlineSyncPipeline(roundId: number, metadata: Record<string, unknown>): void {
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

async function computeMcpCodeStats(conversationId: string, projectPath: string, turnId?: string) {
  const baseline = await loadRoundBaseline(conversationId, projectPath, { turnId });
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

  return null;
}

async function resolveProjectPath(
  conversationId: string,
  explicitProjectPath?: string,
  metadata?: Record<string, unknown>
): Promise<{ projectPath: string | null; reason?: string }> {
  const candidates = [
    explicitProjectPath,
    stringValue(metadata?.projectPath),
    projectFromConversationId(conversationId),
    process.env.AI_CODING_PROJECT_PATH,
    process.env.CODEX_WORKSPACE,
    process.env.WORKSPACE_FOLDER,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));

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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function projectFromConversationId(conversationId: string): string | undefined {
  const marker = ":";
  const index = conversationId.indexOf(marker);
  if (index === -1) return undefined;
  const value = conversationId.slice(index + marker.length).trim();
  return value || undefined;
}
