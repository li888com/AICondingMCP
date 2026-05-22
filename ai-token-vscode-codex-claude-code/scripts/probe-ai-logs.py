#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


HOME = Path.home()


def iso_from_epoch(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except Exception:
        return None


def read_jsonl(path, limit=None):
    rows = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    rows.append({"_parseError": True})
                if limit and len(rows) >= limit:
                    break
    except Exception as error:
        return rows, str(error)
    return rows, None


def find_recent_files(root, pattern="*", limit=20):
    if not root.exists():
        return []
    files = [item for item in root.rglob(pattern) if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[:limit]


def parse_key_values(text):
    result = {}
    for key, value in re.findall(r"([a-zA-Z_][a-zA-Z0-9_.]*)=([^ ]+)", text or ""):
        result[key] = value.strip('"')
    return result


def probe_codex():
    codex_dir = HOME / ".codex"
    sessions_dir = codex_dir / "sessions"
    sqlite_path = codex_dir / "logs_2.sqlite"
    session_files = find_recent_files(sessions_dir, "*.jsonl", 20)

    session_samples = []
    has_task_started = False
    jsonl_turn_ids = set()
    cwd_values = set()

    for path in session_files[:5]:
        rows, error = read_jsonl(path, limit=40)
        types = []
        for row in rows:
            item_type = row.get("type")
            if item_type:
                types.append(item_type)
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            if payload.get("type") == "task_started":
                has_task_started = True
                if payload.get("turn_id"):
                    jsonl_turn_ids.add(payload["turn_id"])
            meta = payload if item_type == "session_meta" else row.get("payload", {})
            if isinstance(meta, dict):
                inner = meta.get("payload") if isinstance(meta.get("payload"), dict) else meta
                if inner.get("cwd"):
                    cwd_values.add(inner["cwd"])
        session_samples.append(
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "modifiedAt": iso_from_epoch(path.stat().st_mtime),
                "parseError": error,
                "eventTypes": sorted(set(types))[:20],
            }
        )

    sqlite_summary = {
        "path": str(sqlite_path),
        "exists": sqlite_path.exists(),
        "readMode": None,
        "error": None,
        "tables": [],
        "recentCompletedEvents": [],
        "recentTurnIds": [],
    }

    if sqlite_path.exists():
        copied = None
        try:
            copied = Path(tempfile.gettempdir()) / f"ai_coding_probe_codex_logs_{os.getpid()}_{uuid.uuid4().hex}.sqlite"
            shutil.copy2(sqlite_path, copied)
            sqlite_summary["readMode"] = "copied_snapshot"
            con = sqlite3.connect(str(copied))
            cur = con.cursor()
            cur.execute("select name from sqlite_master where type='table' order by name")
            sqlite_summary["tables"] = [row[0] for row in cur.fetchall()]

            cur.execute(
                """
                select id, ts, level, target, feedback_log_body
                from logs
                where feedback_log_body like '%response.completed%'
                order by id desc
                limit 20
                """
            )
            for row in cur.fetchall():
                log_id, ts, level, target, body = row
                kv = parse_key_values(body or "")
                sqlite_summary["recentCompletedEvents"].append(
                    {
                        "logId": log_id,
                        "timestamp": iso_from_epoch(ts),
                        "level": level,
                        "target": target,
                        "conversationId": kv.get("conversation.id"),
                        "model": kv.get("model"),
                        "inputTokens": int(kv["input_token_count"]) if kv.get("input_token_count", "").isdigit() else None,
                        "outputTokens": int(kv["output_token_count"]) if kv.get("output_token_count", "").isdigit() else None,
                        "cachedTokens": int(kv["cached_token_count"]) if kv.get("cached_token_count", "").isdigit() else None,
                        "reasoningTokens": int(kv["reasoning_token_count"]) if kv.get("reasoning_token_count", "").isdigit() else None,
                        "toolTokens": int(kv["tool_token_count"]) if kv.get("tool_token_count", "").isdigit() else None,
                        "eventTimestamp": kv.get("event.timestamp"),
                    }
                )

            cur.execute(
                """
                select id, ts, feedback_log_body
                from logs
                where feedback_log_body like '%turn.id=%'
                order by id desc
                limit 30
                """
            )
            turn_ids = []
            for log_id, ts, body in cur.fetchall():
                match = re.search(r"turn\.id=([0-9a-fA-F-]+)", body or "")
                if match:
                    turn_ids.append({"logId": log_id, "timestamp": iso_from_epoch(ts), "turnId": match.group(1)})
            sqlite_summary["recentTurnIds"] = turn_ids[:10]
            con.close()
        except Exception as error:
            sqlite_summary["error"] = str(error)
        finally:
            if copied:
                try:
                    copied.unlink(missing_ok=True)
                except Exception:
                    pass

    completed = sqlite_summary["recentCompletedEvents"]
    has_token = any(event.get("inputTokens") is not None or event.get("outputTokens") is not None for event in completed)
    has_turn_id = bool(jsonl_turn_ids or sqlite_summary["recentTurnIds"])
    has_end = bool(completed)
    capture_level = "A" if has_turn_id and has_end and has_token else ("B" if has_end or has_token else "C")

    return {
        "tool": "codex",
        "captureLevel": capture_level,
        "logRoots": [str(codex_dir), str(sessions_dir), str(sqlite_path)],
        "signals": {
            "startSignal": "session JSONL task_started and SQLite turn.id context" if has_task_started or has_turn_id else None,
            "endSignal": "SQLite response.completed event" if has_end else None,
            "tokenSource": "SQLite logs.feedback_log_body response.completed token counts" if has_token else None,
            "hasTurnId": has_turn_id,
            "hasRequestIdOrMessageId": bool(completed),
        },
        "observations": {
            "sqliteBusyFallbackNeeded": True,
            "sqliteReadStrategy": "copy snapshot before reading",
            "sessionCwds": sorted(cwd_values)[:10],
            "jsonlTurnIds": sorted(jsonl_turn_ids)[:10],
        },
        "sessionFiles": session_samples,
        "sqlite": sqlite_summary,
    }


def project_dir_for_cwd(cwd):
    normalized = cwd.replace("\\", "-").replace("/", "-").replace(":", "-")
    candidates = [
        normalized,
        normalized[:1].lower() + normalized[1:],
        normalized[:1].upper() + normalized[1:],
    ]
    base = HOME / ".claude" / "projects"
    for candidate in candidates:
        path = base / candidate
        if path.exists():
            return path
    return base


def probe_claude(cwd=None):
    claude_dir = HOME / ".claude"
    sessions_dir = claude_dir / "sessions"
    projects_root = claude_dir / "projects"
    active_sessions = find_recent_files(sessions_dir, "*.json", 10)

    active = []
    cwd_values = set()
    for path in active_sessions:
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            if data.get("cwd"):
                cwd_values.add(data["cwd"])
            active.append(
                {
                    "path": str(path),
                    "pid": data.get("pid"),
                    "sessionId": data.get("sessionId"),
                    "cwd": data.get("cwd"),
                    "entrypoint": data.get("entrypoint"),
                    "kind": data.get("kind"),
                    "version": data.get("version"),
                    "startedAt": iso_from_epoch(data.get("startedAt", 0) / 1000) if data.get("startedAt") else None,
                }
            )
        except Exception as error:
            active.append({"path": str(path), "error": str(error)})

    target_cwd = cwd or (next(iter(cwd_values)) if cwd_values else None)
    search_root = project_dir_for_cwd(target_cwd) if target_cwd else projects_root
    project_logs = find_recent_files(search_root, "*.jsonl", 20)

    logs = []
    assistant_events = []
    user_events = []
    for path in project_logs[:10]:
        rows, error = read_jsonl(path)
        event_types = {}
        usage_count = 0
        for row in rows:
            item_type = row.get("type")
            if item_type:
                event_types[item_type] = event_types.get(item_type, 0) + 1
            message = row.get("message") if isinstance(row.get("message"), dict) else {}
            if item_type == "user":
                user_events.append(
                    {
                        "path": str(path),
                        "uuid": row.get("uuid"),
                        "timestamp": row.get("timestamp"),
                        "sessionId": row.get("sessionId"),
                        "promptId": row.get("promptId"),
                    }
                )
            if item_type == "assistant":
                usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
                if usage:
                    usage_count += 1
                assistant_events.append(
                    {
                        "path": str(path),
                        "uuid": row.get("uuid"),
                        "parentUuid": row.get("parentUuid"),
                        "timestamp": row.get("timestamp"),
                        "sessionId": row.get("sessionId"),
                        "messageId": message.get("id"),
                        "model": message.get("model"),
                        "stopReason": message.get("stop_reason"),
                        "inputTokens": usage.get("input_tokens"),
                        "outputTokens": usage.get("output_tokens"),
                        "cacheCreationInputTokens": usage.get("cache_creation_input_tokens"),
                        "cacheReadInputTokens": usage.get("cache_read_input_tokens"),
                    }
                )
        logs.append(
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "modifiedAt": iso_from_epoch(path.stat().st_mtime),
                "parseError": error,
                "eventTypes": event_types,
                "assistantUsageEvents": usage_count,
            }
        )

    has_token = any(event.get("inputTokens") is not None or event.get("outputTokens") is not None for event in assistant_events)
    has_turn = bool(user_events and assistant_events)
    has_message_id = any(event.get("messageId") for event in assistant_events)
    capture_level = "A" if has_token and has_turn and has_message_id else ("B" if has_token or has_turn else "C")

    return {
        "tool": "claude",
        "captureLevel": capture_level,
        "logRoots": [str(claude_dir), str(sessions_dir), str(projects_root), str(search_root)],
        "signals": {
            "startSignal": "project JSONL user event",
            "endSignal": "project JSONL assistant event with stop_reason and usage",
            "tokenSource": "assistant.message.usage",
            "hasTurnId": has_turn,
            "hasRequestIdOrMessageId": has_message_id,
        },
        "activeSessions": active,
        "projectLogs": logs,
        "recentUserEvents": user_events[-5:],
        "recentAssistantEvents": assistant_events[-10:],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tool", choices=["codex", "claude", "all"])
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    if args.tool == "codex":
        result = probe_codex()
    elif args.tool == "claude":
        result = probe_claude(args.cwd)
    else:
        result = {"results": [probe_codex(), probe_claude(args.cwd)]}

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
