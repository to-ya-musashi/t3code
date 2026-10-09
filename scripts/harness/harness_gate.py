"""Codex hook: inject the harness instructions only when the session's model is a harness orchestrator,
and record the decision for T3 Code.

Registered in ~/.codex/hooks.json for SessionStart and UserPromptSubmit (both receive `model`).
- Orchestrator list: ~/.agents/harness-orchestrators.txt (case-insensitive substring match).
- SessionStart: prints the activation notice + ~/.agents/harness-agent.md, or an inactive notice.
- UserPromptSubmit: prints only when the decision changed since the last evaluation in this session.
- HARNESS_ROLE set (role_exec.py children) or a spawned child (rollout has parent_thread_id): prints nothing.
- Every evaluation of a session with a usable session_id atomically rewrites
  ~/.agents/state/harness-status-<sha256(session_id)>.json (version 1, read by the T3 Code server).
Plain stdout becomes developer context in Codex.
"""
import hashlib
import json
import os
import sys
import tempfile
import tomllib
from datetime import datetime, timezone
from pathlib import Path


def is_native_child(transcript):
    # Codex-native spawned children (spawn_agent) run hooks too; their rollout's session_meta carries parent_thread_id.
    if not os.path.isfile(transcript):
        return False
    with open(transcript, encoding="utf-8") as f:
        first = f.readline()
    return bool(first and json.loads(first).get("payload", {}).get("parent_thread_id"))


def is_inside(path, root):
    # Resolve aliases before comparing ancestry; similarly named siblings remain outside.
    path = Path(os.path.normcase(os.path.realpath(path)))
    root = Path(os.path.normcase(os.path.realpath(root)))
    return path == root or root in path.parents


def read_role_model(home, role):
    try:
        with open(os.path.join(home, ".codex", "agents", f"{role}.toml"), "rb") as f:
            model = tomllib.load(f).get("model")
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None
    return model if isinstance(model, str) and model else None


def state_path(home, session_id):
    # Missing, non-string or unencodable session IDs yield no state; the digest keeps the ID out of the file name.
    if not isinstance(session_id, str) or not session_id:
        return None
    try:
        digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        return None
    return os.path.join(home, ".agents", "state", f"harness-status-{digest}.json")


def read_previous(path):
    try:
        with open(path, encoding="utf-8") as f:
            previous = json.load(f)
    except (OSError, ValueError):
        return None
    return previous if isinstance(previous, dict) else None


def write_state(path, state):
    # Persistence problems must not block instruction delivery, so they only produce a sanitized warning.
    tmp = None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".harness-status-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError as e:
        print(f"harness_gate: warning: could not save harness status ({type(e).__name__})", file=sys.stderr)
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    event = json.load(sys.stdin)
    home = os.path.expanduser("~")
    agents = os.path.join(home, ".agents")
    model = event.get("model") or ""
    cwd = os.path.abspath(event.get("cwd") or "")
    event_name = event.get("hook_event_name")

    notice = None
    if os.environ.get("HARNESS_ROLE"):
        status, reason = "off", "child_role"
    elif is_native_child(event.get("transcript_path") or ""):
        status, reason = "off", "native_child"
    elif is_inside(cwd, os.path.join(home, "wiki", "llm-wiki")):
        # Inside the llm-wiki repo the session is its librarian (the repo's own CLAUDE.md), never the harness orchestrator.
        status, reason = "off", "wiki"
        if event_name == "SessionStart":
            notice = ("HARNESS INACTIVE: this session runs inside the llm-wiki repo. Act only as its librarian "
                      "per the repo's CLAUDE.md; ignore harness routing.")
    else:
        inactive = (f"HARNESS INACTIVE: this session's model `{model}` is not a harness orchestrator. "
                    "Ignore any harness routing (~/.agents/harness-agent.md, role TOMLs, grokbot/x_search policy); "
                    "work directly unless the user asks otherwise.")
        if not model:
            status, reason, notice = "unknown", "missing_model", inactive
        else:
            try:
                with open(os.path.join(agents, "harness-orchestrators.txt"), encoding="utf-8") as f:
                    patterns = [l.strip().lower() for l in f if l.strip() and not l.lstrip().startswith("#")]
                if any(p in model.lower() for p in patterns):
                    # The instructions are read before ON is recorded, so a broken install never reports ON.
                    with open(os.path.join(agents, "harness-agent.md"), encoding="utf-8") as f:
                        harness = f.read()
                    status, reason = "on", "orchestrator_model"
                    notice = (f"HARNESS ACTIVE: this session's model `{model}` is a harness orchestrator "
                              "(~/.agents/harness-orchestrators.txt). You are the orchestrator; follow the harness below.\n\n"
                              + harness)
                else:
                    status, reason, notice = "off", "non_orchestrator_model", inactive
            except (OSError, UnicodeDecodeError) as e:
                status, reason = "unknown", "configuration_error"
                print(f"harness_gate: warning: harness configuration unreadable ({type(e).__name__})", file=sys.stderr)

    unchanged = False
    path = state_path(home, event.get("session_id"))
    if path:
        if event_name == "UserPromptSubmit":
            previous = read_previous(path)
            unchanged = bool(previous) and (previous.get("model"), previous.get("status"), previous.get("reason")) == (model, status, reason)
        write_state(path, {
            "version": 1,
            "sessionId": event["session_id"],
            "model": model,
            "status": status,
            "reason": reason,
            "evaluatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "cwd": cwd,
            "roles": {
                "orchestrator": model if status == "on" else None,
                "implementer": read_role_model(home, "implementer"),
                "reviewer": read_role_model(home, "reviewer"),
            },
        })
    elif event_name == "UserPromptSubmit":
        # Without a session ID there is no baseline to compare against, so only SessionStart announces.
        notice = None
    if notice and not unchanged:
        print(notice)


main()
