#!/usr/bin/env python3
import os
import shlex
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_CLI = ROOT_DIR / "dist" / "cli.js"
SRC_CLI = ROOT_DIR / "src" / "cli.ts"


def now_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def make_turn_id(tool: str) -> str:
    return f"{tool}-{now_stamp()}-{uuid.uuid4().hex[:8]}"


def resolve_stats_cli():
    override = os.environ.get("AI_CODING_STATS_CLI_CMD", "").strip()
    if override:
      return shlex.split(override)
    if DIST_CLI.exists():
      return ["node", str(DIST_CLI)]
    return ["npx", "tsx", str(SRC_CLI)]


def resolve_real_command(tool: str):
    env_key = "AI_CODEX_REAL_CMD" if tool == "codex" else "AI_CLAUDE_REAL_CMD"
    override = os.environ.get(env_key, "").strip()
    if override:
      return shlex.split(override)

    candidates = ["codex.exe", "codex"] if tool == "codex" else ["claude.exe", "claude"]
    for candidate in candidates:
      found = shutil.which(candidate)
      if found:
        return [found]
    raise RuntimeError(
      f"Could not find real {tool} command. Set {env_key} to the executable path."
    )


def infer_tool(argv0: str):
    name = Path(argv0).stem.lower()
    if "claude" in name:
      return "claude-code"
    return "codex"


def normalize_tool_name(tool: str):
    return "claude-code" if tool == "claude-code" else "codex"


def begin_turn(tool: str, turn_id: str, passthrough_args):
    prompt_text = build_prompt_text(tool, passthrough_args, "session begin")
    cmd = resolve_stats_cli() + [
      "turn",
      "begin",
      "--turn-id",
      turn_id,
      "--client",
      normalize_tool_name(tool),
      "--model-name",
      os.environ.get("AI_CODING_WRAPPER_MODEL_NAME", "unknown"),
      "--prompt-text",
      prompt_text,
    ]
    run_checked(cmd)


def end_turn(tool: str, turn_id: str, passthrough_args):
    prompt_text = build_prompt_text(tool, passthrough_args, "session end")
    cmd = resolve_stats_cli() + [
      "turn",
      "end",
      "--turn-id",
      turn_id,
      "--client",
      normalize_tool_name(tool),
      "--model-name",
      os.environ.get("AI_CODING_WRAPPER_MODEL_NAME", "unknown"),
      "--prompt-text",
      prompt_text,
    ]
    run_checked(cmd)


def build_prompt_text(tool: str, passthrough_args, prefix: str):
    rendered = " ".join(shlex.quote(arg) for arg in passthrough_args).strip()
    return f"{prefix}: {tool} {rendered}".strip()


def run_checked(cmd):
    completed = subprocess.run(
      cmd,
      cwd=str(ROOT_DIR),
      text=True,
      encoding="utf-8",
      errors="replace",
      capture_output=True,
      check=False,
    )
    if completed.stdout:
      sys.stdout.write(completed.stdout)
    if completed.returncode != 0:
      if completed.stderr:
        sys.stderr.write(completed.stderr)
      raise RuntimeError(f"Command failed: {' '.join(cmd)}")


def run_real_command(tool: str, passthrough_args):
    cmd = resolve_real_command(tool) + passthrough_args
    process = subprocess.run(cmd, check=False)
    return process.returncode


def main():
    tool = infer_tool(sys.argv[0])
    passthrough_args = sys.argv[1:]
    turn_id = os.environ.get("AI_CODING_TURN_ID", "").strip() or make_turn_id(tool)

    begin_turn(tool, turn_id, passthrough_args)
    exit_code = 1
    try:
      exit_code = run_real_command(tool, passthrough_args)
      return exit_code
    finally:
      try:
        end_turn(tool, turn_id, passthrough_args)
      except Exception as exc:
        print(f"[ai-turn-wrapper] end failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
