import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function createCodeSnapshot(projectPath) {
    const root = resolve(projectPath);
    const paths = await listWorkspaceFiles(root);
    const files = [];
    for (const filePath of paths) {
        const lineCount = await countTextLines(root, filePath);
        files.push({
            path: filePath,
            exists: true,
            text: lineCount !== null,
            lines: lineCount ?? 0,
        });
    }
    return {
        version: 1,
        projectPath: root,
        createdAt: new Date().toISOString(),
        files,
    };
}
export async function findGitRoot(projectPath = process.cwd()) {
    const root = resolve(projectPath);
    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd: root,
            maxBuffer: 1024 * 1024,
        });
        return resolve(stdout.trim());
    }
    catch {
        return null;
    }
}
export async function getCodeStatsSinceSnapshot(projectPath, snapshot) {
    const root = resolve(projectPath);
    const before = new Map(snapshot.files.map((file) => [file.path, file]));
    const currentPaths = await listWorkspaceFiles(root);
    const allPaths = new Set([...before.keys(), ...currentPaths]);
    const files = [];
    for (const filePath of Array.from(allPaths).sort()) {
        const previous = before.get(filePath);
        const current = await getFileSnapshot(root, filePath);
        const currentExists = current.exists;
        const previousLines = previous?.exists && previous.text ? previous.lines : 0;
        const currentLines = current.exists && current.text ? current.lines : 0;
        const delta = currentLines - previousLines;
        if (previous?.exists && !previous.text && current.exists && !current.text) {
            continue;
        }
        if (!previous && currentExists && current.text) {
            files.push(toFileStat(filePath, currentLines, 0));
        }
        else if (previous && !currentExists) {
            files.push(toFileStat(filePath, 0, previousLines));
        }
        else if (delta > 0) {
            files.push(toFileStat(filePath, delta, 0));
        }
        else if (delta < 0) {
            files.push(toFileStat(filePath, 0, Math.abs(delta)));
        }
    }
    return summarizeStats(files, {
        codeStatsSource: "mcp baseline snapshot diff",
        codeStatsPrecision: "round-baseline",
        baselineCreatedAt: snapshot.createdAt,
        projectPath: root,
        files: files.map((file) => ({ ...file })),
    });
}
export async function getWorkspaceCodeStats(projectPath) {
    const root = resolve(projectPath);
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "diff", "--numstat"], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
    });
    const trackedFiles = parseNumstat(stdout);
    const untrackedFiles = await getUntrackedFileStats(root);
    const files = [...trackedFiles, ...untrackedFiles];
    return summarizeStats(files, {
        codeStatsSource: "mcp workspace cumulative git diff",
        codeStatsPrecision: "workspace-cumulative",
        trackedDiffNumstat: stdout.trimEnd(),
        includesUntracked: true,
        projectPath: root,
        files: files.map((file) => ({ ...file })),
    });
}
export async function saveRoundBaseline(conversationId, projectPath, snapshot) {
    const baselineId = baselineKey(conversationId, projectPath);
    const dir = baselineDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${baselineId}.json`);
    await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
    return { baselineId, path };
}
export async function loadRoundBaseline(conversationId, projectPath) {
    const baselineId = baselineKey(conversationId, projectPath);
    const path = join(baselineDir(), `${baselineId}.json`);
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw)
        return null;
    return {
        baselineId,
        path,
        snapshot: JSON.parse(raw),
    };
}
function baselineDir() {
    return resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"), "round-baselines");
}
function baselineKey(conversationId, projectPath) {
    return createHash("sha256")
        .update(`${conversationId.trim().replaceAll("\\", "/")}\n${resolve(projectPath)}`)
        .digest("hex")
        .slice(0, 32);
}
async function listWorkspaceFiles(root) {
    const { stdout } = await execFileAsync("git", [
        "-c",
        "core.quotePath=false",
        "ls-files",
        "--cached",
        "--modified",
        "--others",
        "--exclude-standard",
    ], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
    });
    return Array.from(new Set(stdout.split(/\r?\n/u).filter(Boolean)))
        .filter((filePath) => !isStorageFile(root, filePath))
        .sort();
}
async function countTextLines(root, filePath) {
    const snapshot = await getFileSnapshot(root, filePath);
    return snapshot.exists && snapshot.text ? snapshot.lines : null;
}
async function getFileSnapshot(root, filePath) {
    const fullPath = resolve(root, filePath);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isFile()) {
        return {
            path: filePath,
            exists: false,
            text: false,
            lines: 0,
        };
    }
    const buffer = await readFile(fullPath).catch(() => null);
    if (!buffer || buffer.includes(0)) {
        return {
            path: filePath,
            exists: true,
            text: false,
            lines: 0,
        };
    }
    const content = buffer.toString("utf8");
    if (content.length === 0) {
        return {
            path: filePath,
            exists: true,
            text: true,
            lines: 0,
        };
    }
    const newlineCount = content.match(/\n/gu)?.length ?? 0;
    return {
        path: filePath,
        exists: true,
        text: true,
        lines: content.endsWith("\n") ? newlineCount : newlineCount + 1,
    };
}
function parseNumstat(value) {
    return value
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
        const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t");
        const linesAdded = parseNumstatNumber(addedRaw);
        const linesDeleted = parseNumstatNumber(deletedRaw);
        return toFileStat(filePath, linesAdded, linesDeleted);
    });
}
function parseNumstatNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
async function getUntrackedFileStats(root) {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
    });
    const files = stdout.split(/\r?\n/u).filter(Boolean);
    const stats = [];
    for (const filePath of files) {
        if (isStorageFile(root, filePath))
            continue;
        const lineCount = await countTextLines(root, filePath);
        if (lineCount === null)
            continue;
        stats.push(toFileStat(filePath, lineCount, 0));
    }
    return stats;
}
function isStorageFile(root, filePath) {
    const storageRoot = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(root, ".mcp-toolbox"));
    const fullPath = resolve(root, filePath);
    const normalizedStorageRoot = normalizePathForCompare(storageRoot);
    const normalizedFullPath = normalizePathForCompare(fullPath);
    return normalizedFullPath === normalizedStorageRoot || normalizedFullPath.startsWith(`${normalizedStorageRoot}/`);
}
function normalizePathForCompare(value) {
    return resolve(value).replaceAll("\\", "/").toLowerCase();
}
function toFileStat(filePath, linesAdded, linesDeleted) {
    return {
        path: filePath,
        linesAdded,
        linesDeleted,
        codeLinesChanged: linesAdded + linesDeleted,
    };
}
function summarizeStats(files, metadata) {
    const linesAdded = files.reduce((sum, file) => sum + file.linesAdded, 0);
    const linesDeleted = files.reduce((sum, file) => sum + file.linesDeleted, 0);
    return {
        filesChanged: files.length,
        linesAdded,
        linesDeleted,
        codeLinesChanged: linesAdded + linesDeleted,
        metadata,
    };
}
