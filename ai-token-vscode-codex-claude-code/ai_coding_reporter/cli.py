#!/usr/bin/env python3
import argparse
import fnmatch
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request


ROOT_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT_DIR / ".ai-coding-reporter"
CONFIG_PATH = STATE_DIR / "config.json"
DB_PATH = STATE_DIR / "reporter.db"
IGNORE_PATH = STATE_DIR / "code-stats.ignore"
LAST_REQ_PATH = STATE_DIR / "last-requirements.json"

DEFAULT_API_BASE_URL = "https://gpm-uat.sbtjt.com"
DEMAND_API_PATH = "/api/plugins/sbt/consultantSettlement/demand"
TURN_API_PATH = "/api/ai-codingTurns"
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


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ensure_state_dir():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not IGNORE_PATH.exists():
        IGNORE_PATH.write_text("\n".join(DEFAULT_IGNORE) + "\n", encoding="utf-8")


def read_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_config():
    config = read_json(CONFIG_PATH, {})
    return {
        "employeeId": os.environ.get("AI_CODING_EMPLOYEE_ID") or config.get("employeeId") or "",
        "userName": os.environ.get("AI_CODING_USER_NAME") or config.get("userName") or "",
        "teamId": os.environ.get("AI_CODING_TEAM_ID") or config.get("teamId") or "",
        "demandApiBaseUrl": os.environ.get("AI_CODING_DEMAND_API_BASE_URL") or config.get("demandApiBaseUrl") or config.get("apiBaseUrl") or DEFAULT_API_BASE_URL,
        "demandApiPath": os.environ.get("AI_CODING_DEMAND_API_PATH") or config.get("demandApiPath") or DEMAND_API_PATH,
        "reportApiBaseUrl": os.environ.get("AI_CODING_REPORT_API_BASE_URL") or config.get("reportApiBaseUrl") or config.get("apiBaseUrl") or DEFAULT_API_BASE_URL,
        "turnApiPath": os.environ.get("AI_CODING_TURN_API_PATH") or config.get("turnApiPath") or TURN_API_PATH,
        "accessToken": os.environ.get("AI_CODING_ACCESS_TOKEN") or config.get("accessToken") or "",
        "externalSysKey": os.environ.get("AI_CODING_EXTERNAL_SYS_KEY") or config.get("externalSysKey") or "",
        "externalSysSecret": os.environ.get("AI_CODING_EXTERNAL_SYS_SECRET") or config.get("externalSysSecret") or "",
        "createdAt": config.get("createdAt") or now_iso(),
        "updatedAt": config.get("updatedAt") or now_iso(),
    }


def save_config(config):
    existing = read_json(CONFIG_PATH, {})
    merged = {**existing, **config, "updatedAt": now_iso()}
    if not merged.get("createdAt"):
        merged["createdAt"] = now_iso()
    write_json(CONFIG_PATH, merged)


def db():
    ensure_state_dir()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    ensure_state_dir()
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS user_profile (
              id TEXT PRIMARY KEY,
              employee_id TEXT NOT NULL,
              user_name TEXT,
              team_id TEXT,
              api_base_url TEXT NOT NULL,
              login_status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS requirement_selections (
              conversation_id TEXT PRIMARY KEY,
              binding_level TEXT NOT NULL DEFAULT 'demand',
              demand_id TEXT,
              demand_code TEXT,
              demand_name TEXT,
              phase_name TEXT,
              project_code TEXT,
              project_name TEXT,
              task_id TEXT,
              task_code TEXT,
              task_name TEXT,
              status TEXT,
              selected_by TEXT,
              selected_at TEXT NOT NULL,
              synced_at TEXT,
              metadata_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS turns (
              id TEXT PRIMARY KEY,
              conversation_id TEXT,
              tool TEXT NOT NULL,
              model_name TEXT,
              project_path TEXT,
              project_name TEXT,
              git_branch TEXT,
              commit_before TEXT,
              commit_after TEXT,
              started_at TEXT NOT NULL,
              ended_at TEXT,
              files_changed INTEGER DEFAULT 0,
              lines_added INTEGER DEFAULT 0,
              lines_deleted INTEGER DEFAULT 0,
              code_lines_changed INTEGER DEFAULT 0,
              input_tokens INTEGER,
              output_tokens INTEGER,
              total_tokens INTEGER,
              token_status TEXT NOT NULL DEFAULT 'pending',
              token_source TEXT,
              upload_status TEXT NOT NULL DEFAULT 'pending',
              remote_id TEXT,
              binding_level TEXT,
              demand_id TEXT,
              demand_code TEXT,
              demand_name TEXT,
              phase_name TEXT,
              project_code TEXT,
              project_name_bound TEXT,
              task_id TEXT,
              task_code TEXT,
              task_name TEXT,
              baseline_json TEXT,
              end_snapshot_json TEXT,
              metadata_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS upload_queue (
              id TEXT PRIMARY KEY,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              action TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              retry_count INTEGER NOT NULL DEFAULT 0,
              next_retry_at TEXT,
              last_error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS worker_runs (
              id TEXT PRIMARY KEY,
              worker_type TEXT NOT NULL,
              pid INTEGER,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              last_heartbeat_at TEXT,
              finished_at TEXT,
              current_step TEXT,
              scanned_files INTEGER DEFAULT 0,
              parsed_events INTEGER DEFAULT 0,
              pending_tokens INTEGER DEFAULT 0,
              uploaded_items INTEGER DEFAULT 0,
              failed_items INTEGER DEFAULT 0,
              last_error TEXT,
              metadata_json TEXT
            );
            """
        )


def run_cmd(cmd, cwd=None, check=True):
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=check,
    )


def git_root(path):
    try:
        proc = run_cmd(["git", "rev-parse", "--show-toplevel"], cwd=path)
        return Path(proc.stdout.strip())
    except Exception:
        return None


def git_value(args, cwd):
    try:
        return run_cmd(["git", *args], cwd=cwd).stdout.strip()
    except Exception:
        return ""


def conversation_id(tool="manual", cwd=None):
    root = git_root(cwd or Path.cwd()) or Path(cwd or Path.cwd()).resolve()
    return f"{tool}:{root}"


def project_binding_id(cwd=None):
    root = git_root(cwd or Path.cwd()) or Path(cwd or Path.cwd()).resolve()
    return f"project:{root}"


def load_ignore_patterns():
    ensure_state_dir()
    return [
        line.strip()
        for line in IGNORE_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def ignored(path, patterns):
    normalized = path.replace("\\", "/")
    for pattern in patterns:
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


def text_line_count(path):
    try:
        data = Path(path).read_bytes()
    except Exception:
        return None
    if b"\0" in data:
        return None
    for enc in ("utf-8", "gbk"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            text = None
    if text is None:
        return None
    if not text:
        return 0
    return len(text.splitlines())


def parse_numstat(text, patterns):
    files = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added, deleted, file_path = parts[0], parts[1], parts[2]
        if added == "-" or deleted == "-" or ignored(file_path, patterns):
            continue
        files[file_path.replace("\\", "/")] = {"added": int(added), "deleted": int(deleted)}
    return files


def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def iso_from_epoch(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except Exception:
        return None


def parse_key_values(text):
    result = {}
    for key, value in re.findall(r"([a-zA-Z_][a-zA-Z0-9_.]*)=([^ ]+)", text or ""):
        result[key] = value.strip('"')
    return result


def snapshot(cwd):
    root = git_root(cwd)
    if not root:
        raise RuntimeError("当前目录不是 Git 仓库，无法统计代码变更")
    patterns = load_ignore_patterns()
    tracked = parse_numstat(git_value(["diff", "--numstat"], root), patterns)
    untracked = {}
    others = git_value(["ls-files", "--others", "--exclude-standard"], root)
    for file_path in others.splitlines():
        normalized = file_path.replace("\\", "/")
        if ignored(normalized, patterns):
            continue
        count = text_line_count(root / normalized)
        if count is not None:
            untracked[normalized] = {"lines": count}
    totals = snapshot_totals(tracked, untracked)
    return {
        "gitRoot": str(root),
        "tracked": tracked,
        "untracked": untracked,
        "totals": totals,
        "capturedAt": now_iso(),
    }


def snapshot_totals(tracked, untracked):
    added = sum(item["added"] for item in tracked.values()) + sum(item["lines"] for item in untracked.values())
    deleted = sum(item["deleted"] for item in tracked.values())
    return {
        "filesChanged": len(tracked) + len(untracked),
        "linesAdded": added,
        "linesDeleted": deleted,
        "codeLinesChanged": added + deleted,
    }


def diff_snapshots(start, end):
    paths = set(start.get("tracked", {})) | set(end.get("tracked", {}))
    files = {}
    for path in paths:
        a = start.get("tracked", {}).get(path, {"added": 0, "deleted": 0})
        b = end.get("tracked", {}).get(path, {"added": 0, "deleted": 0})
        added = b["added"] - a["added"]
        deleted = b["deleted"] - a["deleted"]
        if added or deleted:
            files[path] = {"added": added, "deleted": deleted, "source": "tracked"}
    paths = set(start.get("untracked", {})) | set(end.get("untracked", {}))
    for path in paths:
        a = start.get("untracked", {}).get(path, {"lines": 0})
        b = end.get("untracked", {}).get(path, {"lines": 0})
        added = b["lines"] - a["lines"]
        if added:
            files[path] = {"added": added, "deleted": 0, "source": "untracked"}
    totals = {
        "filesChanged": len(files),
        "linesAdded": sum(max(0, item["added"]) for item in files.values()),
        "linesDeleted": sum(max(0, item["deleted"]) for item in files.values()),
    }
    totals["codeLinesChanged"] = totals["linesAdded"] + totals["linesDeleted"]
    return {"files": files, "totals": totals}


def demand_count(items):
    return len(items) if isinstance(items, list) else 0


def normalize_demand(item):
    tasks = item.get("taskInfoVOList") if isinstance(item.get("taskInfoVOList"), list) else []
    bugs = item.get("bugDemandVOS") if isinstance(item.get("bugDemandVOS"), list) else []
    return {
        "bindingLevel": "demand",
        "demandId": item.get("demandId"),
        "demandCode": item.get("demandCode") or "",
        "demandName": item.get("demandName") or "",
        "phaseName": item.get("phaseName") or "",
        "projectCode": item.get("projectCode") or "",
        "projectName": item.get("projectName") or "",
        "taskCount": len(tasks),
        "bugCount": len(bugs),
        "taskInfoVOList": tasks,
        "bugDemandVOS": bugs,
    }


def format_demand(index, demand):
    phase = demand.get("phaseName") or "未知"
    project_name = demand.get("projectName") or "未关联项目"
    project_code = demand.get("projectCode") or "-"
    code = demand.get("demandCode") or "-"
    name = demand.get("demandName") or "未命名需求"
    return (
        f"{index}. [{code}] {name}\n"
        f"   阶段: {phase} | 项目: {project_name} / {project_code} | "
        f"任务: {demand.get('taskCount', 0)} 个 | 缺陷: {demand.get('bugCount', 0)} 个\n"
        f"   demandId: {demand.get('demandId')}"
    )


def fetch_demands(keyword=None):
    config = load_config()
    employee = config.get("employeeId")
    if not employee:
        raise RuntimeError("请先执行 login，例如：python ai-coding-reporter.py login --employee-id 00232924")
    url = config["demandApiBaseUrl"].rstrip("/") + config.get("demandApiPath", DEMAND_API_PATH)
    payload = json.dumps({"userId": employee}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if config.get("accessToken"):
        headers["Authorization"] = f"Bearer {config['accessToken']}"
    req = request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except error.URLError as exc:
        raise RuntimeError(f"需求接口请求失败：{exc}") from exc
    data = json.loads(body)
    if data.get("code") != 200:
        raise RuntimeError(f"需求接口返回异常：{data.get('msg') or data.get('code')}")
    demands = [normalize_demand(item) for item in data.get("data") or []]
    if keyword:
        k = keyword.lower()
        demands = [
            item
            for item in demands
            if k in (item.get("demandCode") or "").lower()
            or k in (item.get("demandName") or "").lower()
            or k in (item.get("projectName") or "").lower()
            or k in (item.get("projectCode") or "").lower()
            or k in (item.get("demandId") or "").lower()
        ]
    return demands


def post_json(url, payload, headers=None, method="POST"):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req_headers = {"Content-Type": "application/json; charset=utf-8"}
    if headers:
        req_headers.update(headers)
    req = request.Request(url, data=data, headers=req_headers, method=method)
    with request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body) if body else {}


def auth_headers(config):
    headers = {}
    if config.get("accessToken"):
        headers["Authorization"] = f"Bearer {config['accessToken']}"
    if config.get("externalSysKey"):
        headers["sys_key"] = config["externalSysKey"]
    if config.get("externalSysSecret"):
        headers["sys_secret"] = config["externalSysSecret"]
    return headers


def build_turn_upload_payload(turn, queued_payload=None):
    queued_payload = queued_payload or {}
    config = load_config()
    metadata = read_json_from_text(turn["metadata_json"], {})
    return {
        "idempotencyKey": queued_payload.get("idempotencyKey") or f"local-turn-{turn['id']}",
        "turnId": turn["id"],
        "conversationId": turn["conversation_id"],
        "employeeId": queued_payload.get("employeeId") or config.get("employeeId"),
        "userName": queued_payload.get("userName") or config.get("userName"),
        "teamId": queued_payload.get("teamId") or config.get("teamId"),
        "tool": turn["tool"],
        "modelName": queued_payload.get("modelName") or turn["model_name"],
        "projectPath": turn["project_path"],
        "projectName": turn["project_name"],
        "gitBranch": turn["git_branch"],
        "commitBefore": turn["commit_before"],
        "commitAfter": turn["commit_after"],
        "startedAt": turn["started_at"],
        "endedAt": turn["ended_at"],
        "filesChanged": turn["files_changed"] or 0,
        "linesAdded": turn["lines_added"] or 0,
        "linesDeleted": turn["lines_deleted"] or 0,
        "codeLinesChanged": turn["code_lines_changed"] or 0,
        "tokenStatus": turn["token_status"] or "pending",
        "tokenSource": turn["token_source"],
        "inputTokens": turn["input_tokens"],
        "outputTokens": turn["output_tokens"],
        "totalTokens": turn["total_tokens"],
        "bindingLevel": turn["binding_level"] or "none",
        "demandId": turn["demand_id"],
        "demandCode": turn["demand_code"],
        "demandName": turn["demand_name"],
        "phaseName": turn["phase_name"],
        "projectCode": turn["project_code"],
        "projectNameBound": turn["project_name_bound"],
        "taskId": turn["task_id"],
        "taskCode": turn["task_code"],
        "taskName": turn["task_name"],
        "codeStatsSource": metadata.get("codeStatsSource") or "baseline diff snapshot",
        "codeStatsPrecision": metadata.get("codeStatsPrecision") or "exact",
        "metadata": metadata,
    }


def read_json_from_text(text, default):
    if not text:
        return default
    try:
        return json.loads(text)
    except Exception:
        return default


def save_last_demands(demands):
    write_json(LAST_REQ_PATH, {"createdAt": now_iso(), "items": demands})


def load_last_demands():
    return read_json(LAST_REQ_PATH, {}).get("items") or []


def find_demand(selector):
    items = load_last_demands()
    if selector.isdigit():
        idx = int(selector)
        if 1 <= idx <= len(items):
            return items[idx - 1]
    lowered = selector.lower()
    for item in items:
        if lowered in {
            (item.get("demandCode") or "").lower(),
            (item.get("demandId") or "").lower(),
        }:
            return item
    fetched = fetch_demands(selector)
    for item in fetched:
        if lowered in {
            (item.get("demandCode") or "").lower(),
            (item.get("demandId") or "").lower(),
        }:
            return item
    if len(fetched) == 1:
        return fetched[0]
    return None


def current_selection(cwd=None):
    conv = project_binding_id(cwd)
    with db() as con:
        return con.execute("select * from requirement_selections where conversation_id = ?", (conv,)).fetchone()


def cmd_login(args):
    ensure_state_dir()
    init_db()
    config = load_config()
    if args.employee_id:
        config["employeeId"] = args.employee_id
    if args.token is not None:
        config["accessToken"] = args.token
    if args.external_sys_key is not None:
        config["externalSysKey"] = args.external_sys_key
    if args.external_sys_secret is not None:
        config["externalSysSecret"] = args.external_sys_secret
    if args.api_base_url:
        config["demandApiBaseUrl"] = args.api_base_url
        config["reportApiBaseUrl"] = args.api_base_url
    if args.demand_api_base_url:
        config["demandApiBaseUrl"] = args.demand_api_base_url
    if args.demand_api_path:
        config["demandApiPath"] = args.demand_api_path
    if args.report_api_base_url:
        config["reportApiBaseUrl"] = args.report_api_base_url
    if args.turn_api_path:
        config["turnApiPath"] = args.turn_api_path
    if not config.get("employeeId"):
        raise RuntimeError("缺少工号，请使用 --employee-id 00232924")
    save_config(config)
    with db() as con:
        con.execute(
            """
            insert into user_profile(id, employee_id, user_name, team_id, api_base_url, login_status, created_at, updated_at)
            values('default', ?, ?, ?, ?, 'logged_in', ?, ?)
            on conflict(id) do update set
              employee_id=excluded.employee_id,
              user_name=excluded.user_name,
              team_id=excluded.team_id,
              api_base_url=excluded.api_base_url,
              login_status='logged_in',
              updated_at=excluded.updated_at
            """,
            (config["employeeId"], config.get("userName"), config.get("teamId"), config["demandApiBaseUrl"], now_iso(), now_iso()),
        )
    print(f"已登录配置：employeeId={config['employeeId']}")
    print(f"配置文件：{CONFIG_PATH}")


def cmd_req(args):
    init_db()
    if args.req_args and args.req_args[0] == "clear":
        conv = project_binding_id()
        with db() as con:
            con.execute("delete from requirement_selections where conversation_id = ?", (conv,))
        print("当前会话需求绑定已清除。")
        return
    if args.req_args and args.req_args[0] == "bind":
        if len(args.req_args) < 2:
            raise RuntimeError("请提供绑定目标：序号、demandCode 或 demandId")
        demand = find_demand(args.req_args[1])
        if not demand:
            raise RuntimeError("没有找到项目需求，请先执行 req 搜索，或检查 demandCode / demandId。")
        conv = project_binding_id()
        ts = now_iso()
        with db() as con:
            con.execute(
                """
                insert into requirement_selections(
                  conversation_id, binding_level, demand_id, demand_code, demand_name, phase_name,
                  project_code, project_name, task_id, task_code, task_name, status, selected_by,
                  selected_at, metadata_json, created_at, updated_at
                ) values(?, 'demand', ?, ?, ?, ?, ?, ?, null, null, null, 'selected', 'cli', ?, ?, ?, ?)
                on conflict(conversation_id) do update set
                  binding_level='demand',
                  demand_id=excluded.demand_id,
                  demand_code=excluded.demand_code,
                  demand_name=excluded.demand_name,
                  phase_name=excluded.phase_name,
                  project_code=excluded.project_code,
                  project_name=excluded.project_name,
                  task_id=null,
                  task_code=null,
                  task_name=null,
                  status='selected',
                  selected_by='cli',
                  selected_at=excluded.selected_at,
                  metadata_json=excluded.metadata_json,
                  updated_at=excluded.updated_at
                """,
                (
                    conv,
                    demand.get("demandId"),
                    demand.get("demandCode"),
                    demand.get("demandName"),
                    demand.get("phaseName"),
                    demand.get("projectCode"),
                    demand.get("projectName"),
                    ts,
                    json.dumps(demand, ensure_ascii=False),
                    ts,
                    ts,
                ),
            )
        print("当前会话已绑定到项目需求：")
        print(format_demand(1, demand))
        return

    keyword = " ".join(args.req_args) if args.req_args else None
    demands = fetch_demands(keyword)
    save_last_demands(demands)
    if not demands:
        print("没有找到可绑定的项目需求。")
        return
    print("可绑定的项目需求：\n")
    for i, demand in enumerate(demands[:20], start=1):
        print(format_demand(i, demand))
        print()
    print("绑定方式：python ai-coding-reporter.py req bind <序号|demandCode|demandId>")


def cmd_doctor(args):
    init_db()
    config = load_config()
    checks = []
    checks.append(("stateDir", STATE_DIR.exists(), str(STATE_DIR)))
    checks.append(("config", CONFIG_PATH.exists(), str(CONFIG_PATH)))
    checks.append(("employeeId", bool(config.get("employeeId")), config.get("employeeId") or "missing"))
    checks.append(("database", DB_PATH.exists(), str(DB_PATH)))
    checks.append(("git", shutil.which("git") is not None, shutil.which("git") or "missing"))
    root = git_root(Path.cwd())
    checks.append(("currentGitRepo", root is not None, str(root) if root else "not a git repo"))
    for name, ok, detail in checks:
        print(f"{'OK' if ok else 'FAIL'} {name}: {detail}")
    if args.api:
        try:
            demands = fetch_demands()
            print(f"OK demandApi: {len(demands)} demands")
        except Exception as exc:
            print(f"FAIL demandApi: {exc}")


def cmd_start(args):
    init_db()
    tool = args.tool or "manual"
    snap = snapshot(Path.cwd())
    root = Path(snap["gitRoot"])
    turn_id = args.turn_id or f"{tool}-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    conv = conversation_id(tool, root)
    ts = now_iso()
    selection = current_selection(root)
    with db() as con:
        con.execute(
            """
            insert into turns(
              id, conversation_id, tool, model_name, project_path, project_name, git_branch,
              commit_before, started_at, token_status, upload_status, binding_level, demand_id,
              demand_code, demand_name, phase_name, project_code, project_name_bound, task_id,
              task_code, task_name, baseline_json, metadata_json, created_at, updated_at
            ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                turn_id,
                conv,
                tool,
                args.model,
                str(root),
                root.name,
                git_value(["branch", "--show-current"], root),
                git_value(["rev-parse", "HEAD"], root),
                ts,
                selection["binding_level"] if selection else None,
                selection["demand_id"] if selection else None,
                selection["demand_code"] if selection else None,
                selection["demand_name"] if selection else None,
                selection["phase_name"] if selection else None,
                selection["project_code"] if selection else None,
                selection["project_name"] if selection else None,
                selection["task_id"] if selection else None,
                selection["task_code"] if selection else None,
                selection["task_name"] if selection else None,
                json.dumps(snap, ensure_ascii=False),
                json.dumps({"codeStatsSource": "baseline diff snapshot"}, ensure_ascii=False),
                ts,
                ts,
            ),
        )
    print(f"已开始记录 turn：{turn_id}")
    print(f"Git 项目：{root}")


def create_completed_turn_from_snapshots(tool, model, root, baseline, end_snap, started_at, ended_at, event=None):
    turn_id = f"{tool}-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    conv = conversation_id(tool, root)
    selection = current_selection(root)
    delta = diff_snapshots(baseline, end_snap)
    totals = delta["totals"]
    metadata = {
        "codeStatsSource": "watch baseline diff snapshot",
        "codeStatsPrecision": "exact",
        "roundChanged": totals["codeLinesChanged"],
        "files": delta["files"],
        "watchEvent": event or {},
    }
    input_tokens = output_tokens = total_tokens = None
    token_status = "pending"
    token_source = None
    if event and (event.get("inputTokens") is not None or event.get("outputTokens") is not None):
        input_tokens = event.get("inputTokens")
        output_tokens = event.get("outputTokens")
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
        token_status = "completed"
        token_source = "tool_log"
    ts = now_iso()
    with db() as con:
        con.execute(
            """
            insert into turns(
              id, conversation_id, tool, model_name, project_path, project_name, git_branch,
              commit_before, commit_after, started_at, ended_at, files_changed, lines_added,
              lines_deleted, code_lines_changed, input_tokens, output_tokens, total_tokens,
              token_status, token_source, upload_status, binding_level, demand_id, demand_code,
              demand_name, phase_name, project_code, project_name_bound, task_id, task_code,
              task_name, baseline_json, end_snapshot_json, metadata_json, created_at, updated_at
            ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                turn_id,
                conv,
                tool,
                model,
                str(root),
                root.name,
                git_value(["branch", "--show-current"], root),
                git_value(["rev-parse", "HEAD"], root),
                git_value(["rev-parse", "HEAD"], root),
                started_at,
                ended_at,
                totals["filesChanged"],
                totals["linesAdded"],
                totals["linesDeleted"],
                totals["codeLinesChanged"],
                input_tokens,
                output_tokens,
                total_tokens,
                token_status,
                token_source,
                selection["binding_level"] if selection else None,
                selection["demand_id"] if selection else None,
                selection["demand_code"] if selection else None,
                selection["demand_name"] if selection else None,
                selection["phase_name"] if selection else None,
                selection["project_code"] if selection else None,
                selection["project_name"] if selection else None,
                selection["task_id"] if selection else None,
                selection["task_code"] if selection else None,
                selection["task_name"] if selection else None,
                json.dumps(baseline, ensure_ascii=False),
                json.dumps(end_snap, ensure_ascii=False),
                json.dumps(metadata, ensure_ascii=False),
                ts,
                ts,
            ),
        )
        payload = build_turn_upload_payload(con.execute("select * from turns where id=?", (turn_id,)).fetchone())
        con.execute(
            """
            insert into upload_queue(id, entity_type, entity_id, action, payload_json, status, created_at, updated_at)
            values(?, 'turn', ?, 'upsert', ?, 'pending', ?, ?)
            """,
            (f"queue-{turn_id}", turn_id, json.dumps(payload, ensure_ascii=False), ts, ts),
        )
    return turn_id, totals, token_status


def latest_open_turn(tool):
    with db() as con:
        if tool:
            return con.execute(
                "select * from turns where tool=? and ended_at is null order by started_at desc limit 1", (tool,)
            ).fetchone()
        return con.execute("select * from turns where ended_at is null order by started_at desc limit 1").fetchone()


def cmd_end(args):
    init_db()
    row = None
    with db() as con:
        if args.turn_id:
            row = con.execute("select * from turns where id=?", (args.turn_id,)).fetchone()
        else:
            row = latest_open_turn(args.tool)
    if not row:
        raise RuntimeError("没有找到未结束的 turn，请先执行 start。")
    end_snap = snapshot(Path(row["project_path"]))
    base = json.loads(row["baseline_json"])
    delta = diff_snapshots(base, end_snap)
    totals = delta["totals"]
    ts = now_iso()
    metadata = {
        "codeStatsSource": "baseline diff snapshot",
        "codeStatsPrecision": "exact",
        "roundChanged": totals["codeLinesChanged"],
        "files": delta["files"],
    }
    payload = {
        "idempotencyKey": f"local-turn-{row['id']}",
        "turnId": row["id"],
        "conversationId": row["conversation_id"],
        "employeeId": load_config().get("employeeId"),
        "userName": load_config().get("userName"),
        "teamId": load_config().get("teamId"),
        "tool": args.tool or row["tool"],
        "modelName": args.model or row["model_name"],
        "projectPath": row["project_path"],
        "projectName": row["project_name"],
        "gitBranch": row["git_branch"],
        "commitBefore": row["commit_before"],
        "commitAfter": git_value(["rev-parse", "HEAD"], Path(row["project_path"])),
        "startedAt": row["started_at"],
        "endedAt": ts,
        **totals,
        "tokenStatus": "pending",
        "bindingLevel": row["binding_level"],
        "demandId": row["demand_id"],
        "demandCode": row["demand_code"],
        "demandName": row["demand_name"],
        "phaseName": row["phase_name"],
        "projectCode": row["project_code"],
        "projectNameBound": row["project_name_bound"],
        "taskId": row["task_id"],
        "taskCode": row["task_code"],
        "taskName": row["task_name"],
        "codeStatsSource": metadata["codeStatsSource"],
        "codeStatsPrecision": metadata["codeStatsPrecision"],
        "metadata": metadata,
    }
    with db() as con:
        con.execute(
            """
            update turns set ended_at=?, files_changed=?, lines_added=?, lines_deleted=?,
              code_lines_changed=?, token_status='pending', end_snapshot_json=?, metadata_json=?,
              updated_at=? where id=?
            """,
            (
                ts,
                totals["filesChanged"],
                totals["linesAdded"],
                totals["linesDeleted"],
                totals["codeLinesChanged"],
                json.dumps(end_snap, ensure_ascii=False),
                json.dumps(metadata, ensure_ascii=False),
                ts,
                row["id"],
            ),
        )
        con.execute(
            """
            insert into upload_queue(id, entity_type, entity_id, action, payload_json, status, created_at, updated_at)
            values(?, 'turn', ?, 'upsert', ?, 'pending', ?, ?)
            """,
            (f"queue-{row['id']}", row["id"], json.dumps(payload, ensure_ascii=False), ts, ts),
        )
    print(f"已结束 turn：{row['id']}")
    print(json.dumps(totals, ensure_ascii=False, indent=2))


def cmd_status(args):
    init_db()
    with db() as con:
        turns = con.execute(
            """
            select
              coalesce(sum(case when ended_at is null then 1 else 0 end), 0) open_turns,
              coalesce(sum(case when token_status='pending' then 1 else 0 end), 0) pending_tokens,
              coalesce(sum(case when upload_status='pending' then 1 else 0 end), 0) pending_uploads,
              count(*) total
            from turns
            """
        ).fetchone()
        selection = current_selection()
        selection_summary = None
        if selection:
            selection_summary = {
                "conversationId": selection["conversation_id"],
                "bindingLevel": selection["binding_level"],
                "demandId": selection["demand_id"],
                "demandCode": selection["demand_code"],
                "demandName": selection["demand_name"],
                "phaseName": selection["phase_name"],
                "projectCode": selection["project_code"],
                "projectName": selection["project_name"],
                "taskId": selection["task_id"],
                "selectedAt": selection["selected_at"],
            }
    print(
        json.dumps(
            {
                "ok": not (turns["open_turns"] or turns["pending_tokens"] or turns["pending_uploads"]),
                "turns": dict(turns),
                "selection": selection_summary,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_sync(args):
    init_db()
    config = load_config()
    if not config.get("employeeId"):
        raise RuntimeError("请先执行 login --employee-id <工号>")
    url = config["reportApiBaseUrl"].rstrip("/") + config.get("turnApiPath", TURN_API_PATH)
    with db() as con:
        rows = con.execute("select * from upload_queue where status in ('pending', 'failed') order by created_at").fetchall()
    if args.dry_run:
        print(json.dumps({
            "pendingItems": len(rows),
            "dryRun": True,
            "implementedOnlineUpload": True,
            "url": url,
            "items": [
                {
                    "id": row["id"],
                    "entityType": row["entity_type"],
                    "entityId": row["entity_id"],
                    "action": row["action"],
                    "status": row["status"],
                    "retryCount": row["retry_count"],
                }
                for row in rows[:20]
            ],
        }, ensure_ascii=False, indent=2))
        return

    uploaded = 0
    failed = 0
    results = []
    with db() as con:
        for row in rows:
            turn = con.execute("select * from turns where id=?", (row["entity_id"],)).fetchone()
            if not turn:
                failed += 1
                con.execute(
                    "update upload_queue set status='failed', retry_count=retry_count+1, last_error=?, updated_at=? where id=?",
                    ("turn not found", now_iso(), row["id"]),
                )
                continue
            queued_payload = read_json_from_text(row["payload_json"], {})
            payload = build_turn_upload_payload(turn, queued_payload)
            try:
                response = post_json(url, payload, auth_headers(config), method="POST")
                if response.get("code") not in (0, 200):
                    raise RuntimeError(response.get("msg") or f"unexpected response code {response.get('code')}")
                data = response.get("data") or {}
                remote_id = data.get("remoteId")
                con.execute(
                    "update turns set upload_status='uploaded', remote_id=?, updated_at=? where id=?",
                    (str(remote_id) if remote_id is not None else None, now_iso(), row["entity_id"]),
                )
                con.execute(
                    "update upload_queue set status='uploaded', last_error=null, updated_at=? where id=?",
                    (now_iso(), row["id"]),
                )
                uploaded += 1
                results.append({"id": row["id"], "entityId": row["entity_id"], "uploaded": True, "remoteId": remote_id})
            except Exception as exc:
                failed += 1
                con.execute(
                    """
                    update upload_queue set status='failed', retry_count=retry_count+1,
                      last_error=?, updated_at=? where id=?
                    """,
                    (str(exc), now_iso(), row["id"]),
                )
                results.append({"id": row["id"], "entityId": row["entity_id"], "uploaded": False, "error": str(exc)})
    print(json.dumps({
        "pendingItems": len(rows),
        "dryRun": False,
        "implementedOnlineUpload": True,
        "uploaded": uploaded,
        "failed": failed,
        "results": results[:20],
        "url": url,
    }, ensure_ascii=False, indent=2))
    return
    summary = {
        "pendingItems": len(rows),
        "dryRun": bool(args.dry_run),
        "implementedOnlineUpload": False,
        "message": "线上 AI 编码 turn 上传接口尚未配置，当前 sync 只做本地队列检查。",
    }
    if args.dry_run:
        summary["items"] = [
            {
                "id": row["id"],
                "entityType": row["entity_type"],
                "entityId": row["entity_id"],
                "action": row["action"],
                "status": row["status"],
                "retryCount": row["retry_count"],
            }
            for row in rows[:20]
        ]
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cmd_probe(args):
    scripts = ROOT_DIR / "scripts" / "probe-ai-logs.py"
    cmd = [sys.executable, str(scripts), args.tool]
    if args.out:
        cmd.extend(["--out", args.out])
    proc = subprocess.run(cmd, text=True)
    raise SystemExit(proc.returncode)


def codex_token_events():
    sqlite_path = Path.home() / ".codex" / "logs_2.sqlite"
    if not sqlite_path.exists():
        return []
    copied = Path(tempfile.gettempdir()) / f"ai_coding_tokens_codex_{os.getpid()}_{uuid.uuid4().hex}.sqlite"
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
            limit 2000
            """
        )
        seen = set()
        for log_id, ts, target, body in cur.fetchall():
            kv = parse_key_values(body or "")
            if not (kv.get("input_token_count") or kv.get("output_token_count")):
                continue
            turn_match = re.search(r"turn\.id=([0-9a-fA-F-]+)|turn_id=([0-9a-fA-F-]+)", body or "")
            event = {
                "sourceEventId": f"codex:{log_id}",
                "tool": "codex",
                "occurredAt": kv.get("event.timestamp") or iso_from_epoch(ts),
                "conversationId": kv.get("conversation.id"),
                "turnId": (turn_match.group(1) or turn_match.group(2)) if turn_match else None,
                "inputTokens": int(kv["input_token_count"]) if kv.get("input_token_count", "").isdigit() else None,
                "outputTokens": int(kv["output_token_count"]) if kv.get("output_token_count", "").isdigit() else None,
                "cachedTokens": int(kv["cached_token_count"]) if kv.get("cached_token_count", "").isdigit() else None,
                "reasoningTokens": int(kv["reasoning_token_count"]) if kv.get("reasoning_token_count", "").isdigit() else None,
                "toolTokens": int(kv["tool_token_count"]) if kv.get("tool_token_count", "").isdigit() else None,
            }
            signature = (
                event["conversationId"],
                event["turnId"],
                event["occurredAt"],
                event["inputTokens"],
                event["outputTokens"],
                event["cachedTokens"],
                event["reasoningTokens"],
                event["toolTokens"],
            )
            if signature in seen:
                continue
            seen.add(signature)
            events.append(event)
        con.close()
    finally:
        try:
            copied.unlink(missing_ok=True)
        except Exception:
            pass
    return events


def claude_project_logs():
    root = Path.home() / ".claude" / "projects"
    if not root.exists():
        return []
    files = [item for item in root.rglob("*.jsonl") if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[:30]


def claude_token_events():
    events = []
    for path in claude_project_logs():
        try:
            rows = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        by_message = {}
        for line in rows:
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("type") != "assistant":
                continue
            msg = row.get("message") if isinstance(row.get("message"), dict) else {}
            usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
            if not usage:
                continue
            message_id = msg.get("id") or row.get("uuid")
            by_message[message_id] = {
                "sourceEventId": f"claude:{message_id}",
                "tool": "claude",
                "occurredAt": row.get("timestamp"),
                "conversationId": row.get("sessionId"),
                "turnId": row.get("promptId") or row.get("parentUuid"),
                "messageId": message_id,
                "stopReason": msg.get("stop_reason"),
                "inputTokens": usage.get("input_tokens"),
                "outputTokens": usage.get("output_tokens"),
                "cachedTokens": (usage.get("cache_creation_input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0),
                "reasoningTokens": None,
                "toolTokens": None,
            }
        events.extend(by_message.values())
    return events


def match_token_event(turn, events, delay_minutes=30, used_event_ids=None):
    used_event_ids = used_event_ids or set()
    started = parse_iso(turn["started_at"])
    ended = parse_iso(turn["ended_at"]) or datetime.now(timezone.utc).astimezone()
    latest = ended
    if delay_minutes:
        latest = latest.replace()
        from datetime import timedelta
        latest = ended + timedelta(minutes=delay_minutes)
    candidates = []
    for event in events:
        if event.get("sourceEventId") in used_event_ids:
            continue
        occurred = parse_iso(event.get("occurredAt"))
        if not occurred:
            continue
        if started and started <= occurred <= latest:
            candidates.append(event)
    if len(candidates) == 1:
        return candidates[0], "completed"
    if len(candidates) > 1:
        candidates.sort(key=lambda item: parse_iso(item["occurredAt"]) or datetime.min.replace(tzinfo=timezone.utc))
        after_end = [item for item in candidates if (parse_iso(item.get("occurredAt")) or datetime.min.replace(tzinfo=timezone.utc)) >= ended]
        if after_end:
            return after_end[0], "needs_review"
        return candidates[-1], "needs_review"
    return None, "pending"


def backfill_remote_token(config, turn, event, token_status, total):
    path = config.get("turnApiPath", TURN_API_PATH).rstrip("/")
    url = config["reportApiBaseUrl"].rstrip("/") + f"{path}/{turn['id']}/tokens"
    payload = {
        "sourceEventId": event.get("sourceEventId"),
        "tokenStatus": token_status,
        "tokenSource": "tool_log",
        "inputTokens": event.get("inputTokens"),
        "outputTokens": event.get("outputTokens"),
        "totalTokens": total,
        "cachedTokens": event.get("cachedTokens"),
        "reasoningTokens": event.get("reasoningTokens"),
        "toolTokens": event.get("toolTokens"),
        "occurredAt": event.get("occurredAt"),
        "metadata": {
            "tool": turn["tool"],
            "matchStrategy": "time_window",
            "confidence": "exact" if token_status == "completed" else "needs_review",
        },
    }
    response = post_json(url, payload, auth_headers(config), method="PATCH")
    if response.get("code") not in (0, 200):
        raise RuntimeError(response.get("msg") or f"unexpected response code {response.get('code')}")
    return response.get("data") or {}


def cmd_tokens_sync(args):
    init_db()
    config = load_config()
    codex_events = codex_token_events()
    claude_events = claude_token_events()
    by_tool = {"codex": codex_events, "claude": claude_events}
    updated = 0
    needs_review = 0
    remote_updated = 0
    remote_failed = 0
    remote_results = []
    used_event_ids = set()
    with db() as con:
        turns = con.execute(
            "select * from turns where ended_at is not null and token_status in ('pending', 'failed', 'needs_review')"
            " order by ended_at"
        ).fetchall()
        for turn in turns:
            events = by_tool.get(turn["tool"], [])
            event, status = match_token_event(turn, events, args.delay_minutes, used_event_ids)
            if not event:
                continue
            used_event_ids.add(event.get("sourceEventId"))
            total = (event.get("inputTokens") or 0) + (event.get("outputTokens") or 0)
            token_status = "completed" if status == "completed" else "needs_review"
            if token_status == "needs_review":
                needs_review += 1
            remote_result = None
            if turn["upload_status"] == "uploaded":
                try:
                    remote_result = backfill_remote_token(config, turn, event, token_status, total)
                    remote_updated += 1
                except Exception as exc:
                    remote_failed += 1
                    remote_result = {"error": str(exc)}
            con.execute(
                """
                update turns set input_tokens=?, output_tokens=?, total_tokens=?,
                  token_status=?, token_source='tool_log', updated_at=? where id=?
                """,
                (event.get("inputTokens"), event.get("outputTokens"), total, token_status, now_iso(), turn["id"]),
            )
            updated += 1
            remote_results.append({
                "turnId": turn["id"],
                "tokenStatus": token_status,
                "remote": remote_result,
            })
    print(
        json.dumps(
            {
                "updatedTurns": updated,
                "needsReview": needs_review,
                "remoteUpdated": remote_updated,
                "remoteFailed": remote_failed,
                "remoteResults": remote_results[:20],
                "codexEvents": len(codex_events),
                "claudeEvents": len(claude_events),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def token_events_for_tool(tool):
    if tool == "codex":
        return codex_token_events()
    if tool == "claude":
        return claude_token_events()
    return codex_token_events() + claude_token_events()


def event_sort_key(event):
    return parse_iso(event.get("occurredAt")) or datetime.min.replace(tzinfo=timezone.utc)


def cmd_watch(args):
    init_db()
    config = load_config()
    if not config.get("employeeId"):
        raise RuntimeError("请先执行 login --employee-id <工号>")
    root = git_root(Path.cwd())
    if not root:
        raise RuntimeError("当前目录不是 Git 仓库，无法启动 watch")
    baseline = snapshot(root)
    baseline_time = now_iso()
    initial_events = token_events_for_tool(args.tool)
    seen = {event.get("sourceEventId") for event in initial_events}
    seen.discard(None)
    if args.include_existing and initial_events:
        latest = sorted(initial_events, key=event_sort_key)[-1].get("sourceEventId")
        seen.discard(latest)
    print(json.dumps({
        "watch": "started",
        "tool": args.tool,
        "gitRoot": str(root),
        "pollSeconds": args.poll_seconds,
        "seenEvents": len(seen),
        "baselineAt": baseline_time,
    }, ensure_ascii=False, indent=2))
    loops = 0
    try:
        while True:
            loops += 1
            events = sorted(token_events_for_tool(args.tool), key=event_sort_key)
            new_events = [event for event in events if event.get("sourceEventId") and event.get("sourceEventId") not in seen]
            for event in new_events:
                seen.add(event.get("sourceEventId"))
                end_snap = snapshot(root)
                turn_id, totals, token_status = create_completed_turn_from_snapshots(
                    args.tool,
                    args.model,
                    root,
                    baseline,
                    end_snap,
                    baseline_time,
                    event.get("occurredAt") or now_iso(),
                    event,
                )
                print(json.dumps({
                    "watch": "turnCompleted",
                    "turnId": turn_id,
                    "sourceEventId": event.get("sourceEventId"),
                    "tokenStatus": token_status,
                    **totals,
                }, ensure_ascii=False, indent=2))
                cmd_sync(argparse.Namespace(dry_run=False))
                baseline = end_snap
                baseline_time = now_iso()
            if args.once:
                break
            if args.max_loops and loops >= args.max_loops:
                break
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        print("watch stopped")


def cmd_stop(args):
    init_db()
    print("第一版没有常驻 daemon。stop 只会在后续停止 token-sync / online-sync / reconcile worker。当前无需停止。")


def cmd_reconcile(args):
    init_db()
    print("第一版 reconcile 占位：当前可先手动执行 tokens sync 和 status。")


def build_parser():
    parser = argparse.ArgumentParser(prog="ai-coding-reporter")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("login")
    p.add_argument("--employee-id")
    p.add_argument("--token", default=None)
    p.add_argument("--external-sys-key", default=None)
    p.add_argument("--external-sys-secret", default=None)
    p.add_argument("--api-base-url", help="兼容旧参数：同时设置需求接口和上报接口 base url")
    p.add_argument("--demand-api-base-url")
    p.add_argument("--demand-api-path")
    p.add_argument("--report-api-base-url")
    p.add_argument("--turn-api-path")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("doctor")
    p.add_argument("--api", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("req")
    p.add_argument("req_args", nargs="*")
    p.set_defaults(func=cmd_req)

    p = sub.add_parser("start")
    p.add_argument("--tool", default="manual")
    p.add_argument("--model", default=None)
    p.add_argument("--turn-id", default=None)
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("end")
    p.add_argument("--tool", default=None)
    p.add_argument("--model", default=None)
    p.add_argument("--turn-id", default=None)
    p.set_defaults(func=cmd_end)

    p = sub.add_parser("status")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("sync")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--retry-failed", action="store_true")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("probe")
    p.add_argument("tool", choices=["codex", "claude", "all"])
    p.add_argument("--out")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("tokens")
    token_sub = p.add_subparsers(dest="token_cmd", required=True)
    p_sync = token_sub.add_parser("sync")
    p_sync.add_argument("--delay-minutes", type=int, default=30, help="允许 token 日志在 turn 结束后延迟生成的分钟数")
    p_sync.set_defaults(func=cmd_tokens_sync)

    p = sub.add_parser("watch")
    p.add_argument("--tool", choices=["codex", "claude", "all"], default="codex")
    p.add_argument("--model", default=None)
    p.add_argument("--poll-seconds", type=int, default=10)
    p.add_argument("--once", action="store_true", help="只扫描一次后退出，方便测试")
    p.add_argument("--max-loops", type=int, default=0, help="最多轮询次数，0 表示一直运行")
    p.add_argument("--include-existing", action="store_true", help="测试用：处理最近一条已存在事件")
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("reconcile")
    p.set_defaults(func=cmd_reconcile)

    p = sub.add_parser("stop")
    p.set_defaults(func=cmd_stop)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
