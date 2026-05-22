import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function loadReporterDemandBinding(projectPath) {
    const reporterPath = await findReporterPath(projectPath);
    if (!reporterPath)
        return null;
    try {
        const { stdout } = await execFileAsync("python", [reporterPath, "status"], {
            cwd: projectPath || process.cwd(),
            env: {
                ...process.env,
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
            },
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const parsed = JSON.parse(stdout);
        return normalizeSelection(parsed.selection);
    }
    catch {
        return null;
    }
}
async function findReporterPath(projectPath) {
    const candidates = [
        projectPath ? resolve(projectPath, "ai-token-vscode-codex-claude-code", "ai-coding-reporter.py") : null,
        resolve("ai-token-vscode-codex-claude-code", "ai-coding-reporter.py"),
    ].filter((path) => path !== null);
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        }
        catch {
            // Try the next candidate.
        }
    }
    return null;
}
function normalizeSelection(selection) {
    if (!selection || selection.bindingLevel !== "demand")
        return null;
    const demandId = stringValue(selection.demandId);
    if (!demandId)
        return null;
    return {
        bindingLevel: "demand",
        demandId,
        demandCode: stringValue(selection.demandCode),
        demandName: stringValue(selection.demandName),
        phaseName: stringValue(selection.phaseName),
        projectCode: stringValue(selection.projectCode),
        projectName: stringValue(selection.projectName),
        taskId: stringValue(selection.taskId),
        selectedAt: stringValue(selection.selectedAt),
    };
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
