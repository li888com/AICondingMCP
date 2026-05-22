#!/usr/bin/env python3
import json
import os
import re
import shutil
import sqlite3
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


HOME = Path.home()


def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def iso_from_epoch(value):
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except Exception:
        return None


def key_values(text):
    return dict(re.findall(r"([a-zA-Z_][a-zA-Z0-9_.]*)=([^ ]+)", text or ""))


def read_jsonl(path):
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
                    pass
    except Exception:
        pass
    return rows


def recent_files(root, pattern, limit):
    if not root.exists():
        return []
    files = [item for item in root.rglob(pattern) if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[:limit]


def copy_codex_db():
    src = HOME / ".codex" / "logs_2.sqlite"
    dst = Path(tempfile.gettempdir()) / "ai_coding_probe_codex_logs.sqlite"
    shutil.copy2(src, dst)
    return dst


def analyze_codex():
    db = copy_codex_db()
    con = sqlite3.connect(str(db))
    cur = con.cursor()

    cur.execute(
        """
        select id, ts, level, target, feedback_log_body
        from logs
        where feedback_log_body like '%response.completed%'
           or feedback_log_body like '%input_token_count=%'
           or feedback_log_body like '%turn.id=%'
           or feedback_log_body like '%event.name="codex.tool_result"%'
           or feedback_log_body like '%response.custom_tool_call_input.done%'
        order by id desc
        limit 5000
        """
    )
    rows = cur.fetchall()
    con.close()

    token_events = []
    turn_context_events = []
    tool_events = []
    for log_id, ts, level, target, body in rows:
        body = body or ""
        kv = key_values(body)
        turn_match = re.search(r"turn\.id=([0-9a-f-]+)|turn_id=([0-9a-f-]+)", body)
        thread_match = re.search(r"thread_id=([0-9a-f-]+)|thread\.id=([0-9a-f-]+)", body)
        response_match = re.search(r'"id":"(resp_[^"]+)"', body)
        item = {
            "logId": log_id,
            "logTimestamp": iso_from_epoch(ts),
            "level": level,
            "target": target,
            "conversationId": kv.get("conversation.id") or (thread_match.group(1) or thread_match.group(2) if thread_match else None),
            "turnId": (turn_match.group(1) or turn_match.group(2)) if turn_match else None,
            "eventKind": kv.get("event.kind"),
            "eventTimestamp": kv.get("event.timestamp"),
            "responseId": response_match.group(1) if response_match else None,
            "inputTokens": int(kv["input_token_count"]) if kv.get("input_token_count", "").isdigit() else None,
            "outputTokens": int(kv["output_token_count"]) if kv.get("output_token_count", "").isdigit() else None,
            "cachedTokens": int(kv["cached_token_count"]) if kv.get("cached_token_count", "").isdigit() else None,
            "reasoningTokens": int(kv["reasoning_token_count"]) if kv.get("reasoning_token_count", "").isdigit() else None,
            "toolTokens": int(kv["tool_token_count"]) if kv.get("tool_token_count", "").isdigit() else None,
        }
        if item["inputTokens"] is not None or item["outputTokens"] is not None:
            token_events.append(item)
        if item["turnId"]:
            turn_context_events.append(item)
        if "codex.tool_result" in body or "custom_tool_call_input.done" in body:
            tool_events.append(item)

    by_token_signature = defaultdict(list)
    for event in token_events:
        signature = (
            event.get("conversationId"),
            event.get("turnId"),
            event.get("eventTimestamp"),
            event.get("inputTokens"),
            event.get("outputTokens"),
            event.get("cachedTokens"),
            event.get("reasoningTokens"),
            event.get("toolTokens"),
        )
        by_token_signature[signature].append(event)

    dedup_samples = []
    for signature, events in list(by_token_signature.items())[:20]:
        dedup_samples.append(
            {
                "signature": {
                    "conversationId": signature[0],
                    "turnId": signature[1],
                    "eventTimestamp": signature[2],
                    "inputTokens": signature[3],
                    "outputTokens": signature[4],
                    "cachedTokens": signature[5],
                    "reasoningTokens": signature[6],
                    "toolTokens": signature[7],
                },
                "duplicates": len(events),
                "targets": sorted(set(event["target"] for event in events)),
                "logIds": [event["logId"] for event in events[:8]],
            }
        )

    delays = []
    for event in token_events:
        event_ts = parse_iso(event.get("eventTimestamp"))
        log_ts = parse_iso(event.get("logTimestamp"))
        if event_ts and log_ts:
            delays.append(round((log_ts - event_ts).total_seconds(), 3))

    turn_token_candidates = [event for event in token_events if event.get("turnId")]
    completed_without_turn = [event for event in token_events if not event.get("turnId") and event.get("eventKind") == "response.completed"]

    return {
        "tokenEventCountRaw": len(token_events),
        "tokenEventCountDedupBySignature": len(by_token_signature),
        "turnTokenCandidateCount": len(turn_token_candidates),
        "completedWithoutTurnCount": len(completed_without_turn),
        "delaySeconds": {
            "sampleCount": len(delays),
            "min": min(delays) if delays else None,
            "max": max(delays) if delays else None,
            "avg": round(sum(delays) / len(delays), 3) if delays else None,
        },
        "dedupRuleRecommended": "dedupe by conversationId + turnId + eventTimestamp + token counts; prefer rows with turnId, otherwise fallback to response.completed rows by conversationId + eventTimestamp + token counts",
        "toolOrFileChangeSignal": {
            "toolEventCount": len(tool_events),
            "availableSignals": ["codex.tool_result", "response.custom_tool_call_input.done"],
            "note": "Can observe tool calls and apply_patch input; exact file landing should still be confirmed by Git diff snapshot at turn end.",
        },
        "dedupSamples": dedup_samples[:10],
    }


def claude_project_root():
    return HOME / ".claude" / "projects" / "c--Users-00232924-Desktop-mcp"


def analyze_claude():
    files = recent_files(claude_project_root(), "*.jsonl", 12)
    turn_summaries = []
    duplicate_message_groups = []
    all_delays = []
    file_snapshot_count = 0

    for path in files:
        rows = read_jsonl(path)
        turns = []
        current = None
        message_groups = defaultdict(list)
        for row in rows:
            typ = row.get("type")
            if typ == "file-history-snapshot":
                file_snapshot_count += 1
            if typ == "user":
                if current:
                    turns.append(current)
                current = {
                    "userUuid": row.get("uuid"),
                    "promptId": row.get("promptId"),
                    "sessionId": row.get("sessionId"),
                    "start": row.get("timestamp"),
                    "assistantMessages": [],
                }
            if typ == "assistant":
                msg = row.get("message") if isinstance(row.get("message"), dict) else {}
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                event = {
                    "uuid": row.get("uuid"),
                    "parentUuid": row.get("parentUuid"),
                    "timestamp": row.get("timestamp"),
                    "messageId": msg.get("id") or row.get("uuid"),
                    "stopReason": msg.get("stop_reason"),
                    "model": msg.get("model"),
                    "inputTokens": usage.get("input_tokens"),
                    "outputTokens": usage.get("output_tokens"),
                    "cacheCreationInputTokens": usage.get("cache_creation_input_tokens"),
                    "cacheReadInputTokens": usage.get("cache_read_input_tokens"),
                }
                message_groups[event["messageId"]].append(event)
                if current:
                    current["assistantMessages"].append(event)
        if current:
            turns.append(current)

        for message_id, events in message_groups.items():
            if len(events) > 1:
                duplicate_message_groups.append(
                    {
                        "file": str(path),
                        "messageId": message_id,
                        "count": len(events),
                        "first": events[0]["timestamp"],
                        "last": events[-1]["timestamp"],
                        "stopReasons": list(dict.fromkeys(event["stopReason"] for event in events)),
                        "recommendedUsage": events[-1],
                    }
                )

        for turn in turns[:10]:
            unique = {}
            for event in turn["assistantMessages"]:
                unique[event["messageId"]] = event
            final_events = list(unique.values())
            completed = [event for event in final_events if event.get("stopReason") in ("end_turn", "stop_sequence")]
            if turn["start"] and final_events:
                start = parse_iso(turn["start"])
                end = parse_iso(final_events[-1]["timestamp"])
                if start and end:
                    all_delays.append(round((end - start).total_seconds(), 3))
            turn_summaries.append(
                {
                    "file": str(path),
                    "sessionId": turn.get("sessionId"),
                    "promptId": turn.get("promptId"),
                    "start": turn.get("start"),
                    "assistantRawCount": len(turn["assistantMessages"]),
                    "assistantUniqueMessageCount": len(final_events),
                    "hasEndTurn": bool(completed),
                    "finalStopReason": final_events[-1].get("stopReason") if final_events else None,
                    "tokenSumByUniqueMessages": {
                        "inputTokens": sum((event.get("inputTokens") or 0) for event in final_events),
                        "outputTokens": sum((event.get("outputTokens") or 0) for event in final_events),
                        "cacheCreationInputTokens": sum((event.get("cacheCreationInputTokens") or 0) for event in final_events),
                        "cacheReadInputTokens": sum((event.get("cacheReadInputTokens") or 0) for event in final_events),
                    },
                }
            )

    return {
        "filesAnalyzed": len(files),
        "turnSamples": turn_summaries[:20],
        "duplicateMessageGroupCount": len(duplicate_message_groups),
        "duplicateMessageSamples": duplicate_message_groups[:10],
        "turnDurationSeconds": {
            "sampleCount": len(all_delays),
            "min": min(all_delays) if all_delays else None,
            "max": max(all_delays) if all_delays else None,
            "avg": round(sum(all_delays) / len(all_delays), 3) if all_delays else None,
        },
        "aggregationRuleRecommended": "Within one user-to-next-user window, group assistant events by message.id, keep the latest event for each message.id, then sum usage across unique model calls. Treat end_turn/stop_sequence as final user-visible completion.",
        "fileChangeSignal": {
            "fileHistorySnapshotCount": file_snapshot_count,
            "note": "file-history-snapshot exists, but code line statistics should still rely on Git baseline/final snapshot.",
        },
    }


def main():
    result = {
        "codex": analyze_codex(),
        "claude": analyze_claude(),
    }
    out = Path("probe-detailed-analysis.json")
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
