import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDE_PATTERNS = [
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    ".next/",
    "out/",
    "target/",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "*.min.js",
    "*.map",
];
let cachedIgnorePatterns = null;
export async function createCodeSnapshot(projectPath) {
    const root = resolve(projectPath);
    const paths = await listWorkspaceFiles(root);
    const files = [];
    for (const filePath of paths) {
        files.push(await getFileSnapshot(root, filePath));
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
        if (previous?.exists && !previous.text && current.exists && !current.text) {
            continue;
        }
        if (!previous && current.exists && current.text) {
            files.push(toFileStat(filePath, current.lines, 0));
        }
        else if (previous && !current.exists) {
            files.push(toFileStat(filePath, 0, previous.lines));
        }
        else if (previous?.text && current.text) {
            const fileStat = await diffTextFile(filePath, previous, current);
            if (fileStat.codeLinesChanged > 0) {
                files.push(fileStat);
            }
        }
    }
    return summarizeStats(files, {
        codeStatsSource: "mcp baseline snapshot diff",
        codeStatsPrecision: "round-baseline-content-diff",
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
    const trackedFiles = parseNumstat(stdout).filter((file) => !shouldIgnoreFile(root, file.path));
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
export async function saveRoundBaseline(conversationId, projectPath, snapshot, options = {}) {
    const baselineId = baselineKey(conversationId, projectPath, options.turnId);
    const dir = baselineDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${baselineId}.json`);
    const payload = {
        version: 1,
        snapshot,
        startedAt: options.startedAt?.trim() || snapshot.createdAt,
        conversationId,
        projectPath: resolve(projectPath),
        turnId: options.turnId?.trim() || null,
    };
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
    return { baselineId, path };
}
export async function loadRoundBaseline(conversationId, projectPath, options = {}) {
    const baselineId = baselineKey(conversationId, projectPath, options.turnId);
    const path = join(baselineDir(), `${baselineId}.json`);
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw)
        return null;
    const parsed = JSON.parse(raw);
    const snapshot = isRoundBaseline(parsed) ? parsed.snapshot : parsed;
    return {
        baselineId,
        path,
        snapshot,
        startedAt: isRoundBaseline(parsed) ? (parsed.startedAt?.trim() || snapshot.createdAt) : snapshot.createdAt,
    };
}
export async function deleteRoundBaseline(conversationId, projectPath, options = {}) {
    const baselineId = baselineKey(conversationId, projectPath, options.turnId);
    const path = join(baselineDir(), `${baselineId}.json`);
    await unlink(path).catch(() => undefined);
}
export async function listRoundBaselines() {
    const dir = baselineDir();
    const names = await readdir(dir).catch(() => []);
    const entries = [];
    const now = Date.now();
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        const path = join(dir, name);
        const raw = await readFile(path, "utf8").catch(() => null);
        if (!raw)
            continue;
        const parsed = JSON.parse(raw);
        const roundBaseline = isRoundBaseline(parsed) ? parsed : null;
        const snapshot = roundBaseline ? roundBaseline.snapshot : parsed;
        const startedAt = roundBaseline ? (roundBaseline.startedAt?.trim() || snapshot.createdAt) : snapshot.createdAt;
        const baselineCreatedAt = snapshot.createdAt;
        entries.push({
            baselineId: name.replace(/\.json$/u, ""),
            path,
            conversationId: roundBaseline?.conversationId?.trim() || "",
            projectPath: roundBaseline?.projectPath?.trim() || snapshot.projectPath || "",
            turnId: roundBaseline?.turnId?.trim() || null,
            startedAt,
            baselineCreatedAt,
            ageMs: Math.max(0, now - new Date(startedAt ?? baselineCreatedAt).getTime()),
        });
    }
    return entries.sort((a, b) => b.ageMs - a.ageMs);
}
export async function cleanupRoundBaselines(maxAgeMs) {
    const entries = await listRoundBaselines();
    const deleted = [];
    for (const entry of entries) {
        if (entry.ageMs < maxAgeMs)
            continue;
        await unlink(entry.path).catch(() => undefined);
        deleted.push(entry);
    }
    return {
        deleted,
        kept: entries.length - deleted.length,
    };
}
function baselineDir() {
    return resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(process.cwd(), ".mcp-toolbox"), "round-baselines");
}
function baselineKey(conversationId, projectPath, turnId) {
    return createHash("sha256")
        .update(`${conversationId.trim().replaceAll("\\", "/")}\n${resolve(projectPath)}\n${turnId?.trim() || ""}`)
        .digest("hex")
        .slice(0, 32);
}
function isRoundBaseline(value) {
    return typeof value === "object" && value !== null && "snapshot" in value;
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
        .filter((filePath) => !shouldIgnoreFile(root, filePath))
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
    const hash = createHash("sha256").update(content).digest("hex");
    if (content.length === 0) {
        return {
            path: filePath,
            exists: true,
            text: true,
            lines: 0,
            hash,
            content,
        };
    }
    const newlineCount = content.match(/\n/gu)?.length ?? 0;
    return {
        path: filePath,
        exists: true,
        text: true,
        lines: content.endsWith("\n") ? newlineCount : newlineCount + 1,
        hash,
        content,
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
        if (shouldIgnoreFile(root, filePath))
            continue;
        const lineCount = await countTextLines(root, filePath);
        if (lineCount === null)
            continue;
        stats.push(toFileStat(filePath, lineCount, 0));
    }
    return stats;
}
function shouldIgnoreFile(root, filePath) {
    return isStorageFile(root, filePath) || matchesIgnorePattern(root, filePath);
}
function isStorageFile(root, filePath) {
    const storageRoot = resolve(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(root, ".mcp-toolbox"));
    const fullPath = resolve(root, filePath);
    const normalizedStorageRoot = normalizePathForCompare(storageRoot);
    const normalizedFullPath = normalizePathForCompare(fullPath);
    return normalizedFullPath === normalizedStorageRoot || normalizedFullPath.startsWith(`${normalizedStorageRoot}/`);
}
function matchesIgnorePattern(root, filePath) {
    const normalized = normalizeRelativePath(filePath);
    return getIgnorePatterns(root).some((pattern) => matchesPattern(normalized, pattern));
}
function getIgnorePatterns(root) {
    const normalizedRoot = resolve(root);
    if (cachedIgnorePatterns?.root === normalizedRoot) {
        return cachedIgnorePatterns.patterns;
    }
    const configPath = resolve(process.env.AI_CODING_CODE_STATS_IGNORE_FILE?.trim() ||
        join(process.env.MCP_TOOLBOX_STORAGE_DIR?.trim() || join(normalizedRoot, ".mcp-toolbox"), "code-stats.ignore"));
    const customPatterns = readIgnoreFileSyncSafe(configPath);
    const patterns = [...DEFAULT_EXCLUDE_PATTERNS, ...customPatterns]
        .map(normalizeIgnorePattern)
        .filter(Boolean);
    cachedIgnorePatterns = { root: normalizedRoot, patterns };
    return patterns;
}
function readIgnoreFileSyncSafe(path) {
    try {
        return readFileSync(path, "utf8")
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
    }
    catch {
        return [];
    }
}
function normalizeIgnorePattern(pattern) {
    return pattern.trim().replaceAll("\\", "/").replace(/^\.?\//u, "");
}
function normalizeRelativePath(filePath) {
    return filePath.replaceAll("\\", "/").replace(/^\.?\//u, "");
}
function matchesPattern(filePath, pattern) {
    if (!pattern)
        return false;
    if (pattern.endsWith("/")) {
        const directory = pattern.slice(0, -1);
        return filePath === directory || filePath.startsWith(`${directory}/`) || filePath.includes(`/${directory}/`);
    }
    if (!pattern.includes("*")) {
        return filePath === pattern || filePath.endsWith(`/${pattern}`);
    }
    const regex = new RegExp(`^${pattern
        .split("*")
        .map(escapeRegExp)
        .join(".*")}$`, "u");
    const basenameRegex = new RegExp(`(^|/)${pattern
        .split("*")
        .map(escapeRegExp)
        .join("[^/]*")}$`, "u");
    return regex.test(filePath) || basenameRegex.test(filePath);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
async function diffTextFile(filePath, previous, current) {
    if (previous.hash && current.hash && previous.hash === current.hash) {
        return toFileStat(filePath, 0, 0);
    }
    if (typeof previous.content !== "string" || typeof current.content !== "string") {
        return diffByLineCount(filePath, previous.lines, current.lines);
    }
    const previousContent = previous.content;
    const currentContent = current.content;
    return diffContentWithGit(filePath, previousContent, currentContent)
        .catch(() => diffLines(filePath, splitLines(previousContent), splitLines(currentContent)));
}
function diffByLineCount(filePath, previousLines, currentLines) {
    const delta = currentLines - previousLines;
    if (delta > 0)
        return toFileStat(filePath, delta, 0);
    if (delta < 0)
        return toFileStat(filePath, 0, Math.abs(delta));
    return toFileStat(filePath, 0, 0);
}
function splitLines(value) {
    const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    if (normalized.length === 0)
        return [];
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}
async function diffContentWithGit(filePath, previousContent, currentContent) {
    const dir = await mkdtemp(join(tmpdir(), "mcp-code-diff-"));
    try {
        const beforePath = join(dir, "before.txt");
        const afterPath = join(dir, "after.txt");
        await writeFile(beforePath, previousContent, "utf8");
        await writeFile(afterPath, currentContent, "utf8");
        const { stdout } = await execFileAsync("git", [
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-index",
            "--numstat",
            "--",
            beforePath,
            afterPath,
        ], {
            cwd: dir,
            maxBuffer: 1024 * 1024,
        }).catch((error) => {
            const output = typeof error === "object" && error !== null && "stdout" in error
                ? String(error.stdout ?? "")
                : "";
            if (output.trim()) {
                return { stdout: output };
            }
            throw error;
        });
        const [line] = stdout.split(/\r?\n/u).filter(Boolean);
        if (!line)
            return toFileStat(filePath, 0, 0);
        const [addedRaw, deletedRaw] = line.split("\t");
        return toFileStat(filePath, parseNumstatNumber(addedRaw), parseNumstatNumber(deletedRaw));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
function diffLines(filePath, previousLines, currentLines) {
    const rows = previousLines.length + 1;
    const cols = currentLines.length + 1;
    const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = previousLines.length - 1; i >= 0; i -= 1) {
        for (let j = currentLines.length - 1; j >= 0; j -= 1) {
            lcs[i][j] = previousLines[i] === currentLines[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const commonLines = lcs[0][0];
    return toFileStat(filePath, currentLines.length - commonLines, previousLines.length - commonLines);
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
