#!/usr/bin/env python3
import fnmatch
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


DEFAULT_IGNORE = [
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
]


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=True)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def ignored(path, patterns):
    normalized = path.replace("\\", "/")
    for pattern in patterns:
        pattern = pattern.strip()
        if not pattern or pattern.startswith("#"):
            continue
        if pattern.endswith("/"):
            prefix = pattern.rstrip("/")
            if normalized == prefix or normalized.startswith(prefix + "/"):
                return True
            continue
        if "/" not in pattern and fnmatch.fnmatch(Path(normalized).name, pattern):
            return True
        if fnmatch.fnmatch(normalized, pattern):
            return True
    return False


def parse_numstat(text, patterns):
    rows = []
    totals = {
        "filesChanged": 0,
        "linesAdded": 0,
        "linesDeleted": 0,
        "codeLinesChanged": 0,
        "ignoredFiles": 0,
    }
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added, deleted, path = parts[0], parts[1], parts[2]
        is_binary = added == "-" or deleted == "-"
        is_ignored = is_binary or ignored(path, patterns)
        row = {
            "path": path,
            "added": None if is_binary else int(added),
            "deleted": None if is_binary else int(deleted),
            "ignored": is_ignored,
        }
        rows.append(row)
        if is_ignored:
            totals["ignoredFiles"] += 1
            continue
        totals["filesChanged"] += 1
        totals["linesAdded"] += row["added"] or 0
        totals["linesDeleted"] += row["deleted"] or 0
    totals["codeLinesChanged"] = totals["linesAdded"] + totals["linesDeleted"]
    return rows, totals


def read_text_line_count(path):
    try:
        data = path.read_bytes()
    except Exception:
        return None
    if b"\0" in data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = data.decode("gbk")
        except UnicodeDecodeError:
            return None
    if not text:
        return 0
    return len(text.splitlines())


def untracked_snapshot(root, patterns):
    output = run(["git", "ls-files", "--others", "--exclude-standard"], root).stdout
    files = []
    for item in output.splitlines():
        if ignored(item, patterns):
            continue
        line_count = read_text_line_count(root / item)
        if line_count is None:
            continue
        files.append({"path": item.replace("\\", "/"), "lines": line_count})
    return files


def main():
    root = Path(tempfile.mkdtemp(prefix="ai-code-stats-filter-"))
    try:
        run(["git", "init"], root)
        run(["git", "config", "user.email", "probe@example.local"], root)
        run(["git", "config", "user.name", "Probe"], root)
        write(root / "README.md", "base\n")
        run(["git", "add", "."], root)
        run(["git", "commit", "-m", "base"], root)

        write(root / "src" / "app.ts", "const a = 1;\nconst b = 2;\n")
        write(root / "docs" / "readme.md", "# 文档\n说明\n")
        write(root / "package-lock.json", "{\n  \"lock\": true\n}\n")
        write(root / "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
        write(root / "node_modules" / "a" / "index.js", "module.exports = 1\n")
        write(root / "dist" / "app.js", "console.log('built')\n")
        write(root / "build" / "output.js", "console.log('build')\n")
        write(root / "coverage" / "lcov.info", "TN:\n")
        write(root / "web" / "app.min.js", "minified\n")
        write(root / "web" / "app.js.map", "{}\n")

        tracked_numstat_without_intent = run(["git", "diff", "--numstat"], root).stdout
        untracked_files = untracked_snapshot(root, DEFAULT_IGNORE)
        run(["git", "add", "-N", "."], root)
        numstat = run(["git", "diff", "--numstat"], root).stdout
        rows, totals = parse_numstat(numstat, DEFAULT_IGNORE)
        result = {
            "tempRepo": str(root),
            "ignorePatterns": DEFAULT_IGNORE,
            "trackedDiffWithoutIntentToAddRows": tracked_numstat_without_intent.splitlines(),
            "untrackedFilesByLsFiles": untracked_files,
            "rows": rows,
            "totals": totals,
            "recommendedRule": "Use git diff --numstat for tracked files plus git ls-files --others --exclude-standard for untracked files; do not modify the user's index in production.",
            "expected": {
                "counted": ["src/app.ts", "docs/readme.md"],
                "ignored": [
                    "package-lock.json",
                    "pnpm-lock.yaml",
                    "node_modules/a/index.js",
                    "dist/app.js",
                    "build/output.js",
                    "coverage/lcov.info",
                    "web/app.min.js",
                    "web/app.js.map",
                ],
            },
        }
        Path("code-stats-filter-validation.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
