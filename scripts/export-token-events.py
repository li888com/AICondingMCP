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
CODEX_SESSIONS = HOME / ".codex" / "sessions"


def iso_from_epoch(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def parse_key_values(text):
    result = {}
    for key, value in re.findall(r"([a-zA-Z_][a-zA-Z0-9_.]*)=([^ ]+)", text or ""):
        result[key] = value.strip('"')
    return result


def int_or_none(value):
    if value is None:
        return None
    try:
        return int(value)
    except Exception:
        return None


def codex_events(limit):
    session_events = codex_session_events(limit)
    if session_events:
        return session_events[:limit]

    sqlite_path = HOME / ".codex" / "logs_2.sqlite"
    if not sqlite_path.exists():
        return []

    copied = Path(tempfile.gettempdir()) / f"ai_coding_token_export_{os.getpid()}_{uuid.uuid4().hex}.sqlite"
    events = []
    try:
        shutil.copy2(sqlite_path, copied)
        con = sqlite3.connect(str(copied))
        cur = con.cursor()
        cur.execute(
            """
            select id, ts, target, feedback_log_body
            from logs
            where feedback_log_body like '%response.completed%'
            order by id desc
            limit ?
            """,
            (limit,),
        )
        for log_id, ts, target, body in cur.fetchall():
            kv = parse_key_values(body or "")
            input_tokens = int_or_none(kv.get("input_token_count"))
            output_tokens = int_or_none(kv.get("output_token_count"))
            if input_tokens is None and output_tokens is None:
                continue
            turn_match = re.search(r"turn\.id=([0-9a-fA-F-]+)", body or "")
            event_timestamp = kv.get("event.timestamp") or iso_from_epoch(ts)
            events.append(
                {
                    "client": "codex",
                    "sourcePath": str(sqlite_path),
                    "sourceEventId": f"codex-sqlite:{log_id}",
                    "conversationId": kv.get("conversation.id"),
                    "turnId": turn_match.group(1) if turn_match else None,
                    "modelName": kv.get("model"),
                    "endedAt": event_timestamp,
                    "inputTokens": input_tokens or 0,
                    "outputTokens": output_tokens or 0,
                    "totalTokens": (input_tokens or 0) + (output_tokens or 0),
                    "cachedTokens": int_or_none(kv.get("cached_token_count")),
                    "reasoningTokens": int_or_none(kv.get("reasoning_token_count")),
                    "toolTokens": int_or_none(kv.get("tool_token_count")),
                    "raw": {
                        "logId": log_id,
                        "target": target,
                        "timestamp": iso_from_epoch(ts),
                    },
                }
            )
        con.close()
    finally:
        try:
            copied.unlink(missing_ok=True)
        except Exception:
            pass
    return events


def codex_session_files(limit):
    if not CODEX_SESSIONS.exists():
        return []
    files = [item for item in CODEX_SESSIONS.rglob("*.jsonl") if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[: max(5, min(limit, 100))]


def codex_session_events(limit):
    events = []
    seen = set()
    for path in codex_session_files(limit):
        conversation_id = None
        current_turn = None
        last_token_usage = None
        last_token_timestamp = None

        for row in read_jsonl(path):
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            payload_type = payload.get("type")

            if row.get("type") == "session_meta" and isinstance(payload.get("id"), str):
                conversation_id = payload.get("id")

            if payload_type == "task_started":
                current_turn = {
                    "turnId": payload.get("turn_id"),
                    "startedAt": iso_from_epoch_ms(payload.get("started_at")),
                }
                last_token_usage = None
                last_token_timestamp = None

            if payload_type == "token_count":
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                usage = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else None
                if usage:
                    last_token_usage = usage
                    last_token_timestamp = row.get("timestamp")

            if payload_type == "task_complete" and current_turn and last_token_usage:
                turn_id = payload.get("turn_id") or current_turn.get("turnId")
                input_tokens = int_or_none(last_token_usage.get("input_tokens")) or 0
                output_tokens = int_or_none(last_token_usage.get("output_tokens")) or 0
                total_tokens = int_or_none(last_token_usage.get("total_tokens")) or input_tokens + output_tokens
                signature = (conversation_id, turn_id, payload.get("completed_at"), input_tokens, output_tokens, total_tokens)
                if signature in seen:
                    continue
                seen.add(signature)
                events.append(
                    {
                        "client": "codex",
                        "sourcePath": str(path),
                        "sourceEventId": f"codex-session:{conversation_id}:{turn_id}",
                        "conversationId": conversation_id,
                        "turnId": turn_id,
                        "modelName": None,
                        "startedAt": current_turn.get("startedAt"),
                        "endedAt": iso_from_epoch_ms(payload.get("completed_at")) or last_token_timestamp or row.get("timestamp"),
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                        "totalTokens": total_tokens,
                        "cachedTokens": int_or_none(last_token_usage.get("cached_input_tokens")),
                        "reasoningTokens": int_or_none(last_token_usage.get("reasoning_output_tokens")),
                        "toolTokens": total_tokens,
                        "raw": {
                            "sessionPath": str(path),
                            "lastTokenTimestamp": last_token_timestamp,
                            "taskCompletedAt": payload.get("completed_at"),
                            "matchStrategy": "session_jsonl_task_complete",
                        },
                    }
                )
                current_turn = None
                last_token_usage = None
                last_token_timestamp = None

    events.sort(key=lambda item: item.get("endedAt") or "", reverse=True)
    return events


def iso_from_epoch_ms(value):
    if value is None:
        return None
    try:
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric = numeric / 1000
        return datetime.fromtimestamp(numeric, timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def read_jsonl(path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue
    except Exception:
        return


def claude_events(limit):
    root = HOME / ".claude" / "projects"
    if not root.exists():
        return []

    files = [item for item in root.rglob("*.jsonl") if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    events = []
    seen = set()
    for path in files[: max(10, min(limit, 100))]:
        for row in read_jsonl(path):
            if row.get("type") != "assistant":
                continue
            if row.get("isSidechain") is True:
                continue
            message = row.get("message") if isinstance(row.get("message"), dict) else {}
            usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
            if not usage:
                continue
            row_uuid = row.get("uuid")
            message_id = message.get("id") or row.get("uuid")
            input_tokens = int_or_none(usage.get("input_tokens")) or 0
            output_tokens = int_or_none(usage.get("output_tokens")) or 0
            total_tokens = input_tokens + output_tokens
            if total_tokens <= 0:
                continue
            signature = (row.get("sessionId"), row_uuid, input_tokens, output_tokens, row.get("timestamp"))
            if signature in seen:
                continue
            seen.add(signature)
            events.append(
                {
                    "client": "claude-code",
                    "sourcePath": str(path),
                    "sourceEventId": f"claude:{row_uuid or message_id}",
                    "conversationId": row.get("sessionId"),
                    "turnId": row.get("promptId") or row.get("parentUuid"),
                    "modelName": message.get("model"),
                    "endedAt": row.get("timestamp"),
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "totalTokens": total_tokens,
                    "cachedTokens": (int_or_none(usage.get("cache_creation_input_tokens")) or 0)
                    + (int_or_none(usage.get("cache_read_input_tokens")) or 0),
                    "reasoningTokens": None,
                    "toolTokens": total_tokens,
                    "raw": {
                        "uuid": row.get("uuid"),
                        "parentUuid": row.get("parentUuid"),
                        "promptId": row.get("promptId"),
                        "messageId": message_id,
                        "stopReason": message.get("stop_reason"),
                        "matchStrategy": "claude_jsonl_assistant_usage",
                    },
                }
            )
            if len(events) >= limit:
                return events
    return events[:limit]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client", choices=["codex", "claude-code", "all"], default="all")
    parser.add_argument("--limit", type=int, default=200)
    args = parser.parse_args()

    events = []
    if args.client in ("codex", "all"):
        events.extend(codex_events(args.limit))
    if args.client in ("claude-code", "all"):
        events.extend(claude_events(args.limit))

    events.sort(key=lambda item: item.get("endedAt") or "", reverse=True)
    print(json.dumps({"events": events[: args.limit]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
