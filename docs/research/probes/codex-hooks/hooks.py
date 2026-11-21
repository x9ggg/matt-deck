"""The probe's Codex hooks (Python 3).

  hooks.py install   add the probe's hooks to ~/.codex/hooks.json, keeping what is there
  hooks.py remove    take the probe's hooks out again
  hooks.py log       the command hook itself: append the event on stdin to probe-log.txt
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPOSITORY = str(HERE.parents[3])
SERVER = "matt_deck_hook_probe"
HOOKS_FILE = Path.home() / ".codex" / "hooks.json"
BACKUP = HOOKS_FILE.with_name("hooks.json.before-matt-deck-hook-probe")
COMMAND = {"type": "command", "command": f"/usr/bin/python3 '{HERE / 'hooks.py'}' log", "timeout": 5}


def tool(event, **fields):
    template = {"event": event, "session_id": "${session_id}", "cwd": "${cwd}", **fields}
    return {"type": "mcp_tool", "server": SERVER, "tool": "probe_hook", "input": template, "timeout": 5}


# SessionEnd 不支持调 MCP 工具的钩子，所以只挂命令。
PROBE_HOOKS = {
    "SessionStart": [COMMAND, tool("SessionStart", source="${source}")],
    "UserPromptSubmit": [COMMAND, tool("UserPromptSubmit", prompt="${prompt}")],
    "Stop": [COMMAND],
    "SessionEnd": [COMMAND],
}


def is_ours(group):
    return any(
        handler.get("server") == SERVER or str(HERE) in handler.get("command", "")
        for handler in group.get("hooks", [])
    )


def without_ours(config):
    hooks = {
        event: [group for group in groups if not is_ours(group)]
        for event, groups in config.get("hooks", {}).items()
    }
    return {**config, "hooks": {event: groups for event, groups in hooks.items() if groups}}


def write(config):
    HOOKS_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "log":
        event = json.load(sys.stdin)
        # 提示词和回答只在本仓库的 Session 里记原文，别的项目里只记长度。
        for private in ("prompt", "last_assistant_message"):
            if private in event and not str(event.get("cwd", "")).startswith(REPOSITORY):
                event[private] = f"<{len(str(event[private]))} chars>"
        line = f"{datetime.now().isoformat(timespec='seconds')} pid={os.getpid()} hook-command {json.dumps(event, ensure_ascii=False)}\n"
        with (HERE / "probe-log.txt").open("a", encoding="utf-8") as file:
            file.write(line)
    elif action in ("install", "remove"):
        config = json.loads(HOOKS_FILE.read_text(encoding="utf-8")) if HOOKS_FILE.exists() else {}
        if action == "install" and HOOKS_FILE.exists() and not BACKUP.exists():
            BACKUP.write_text(HOOKS_FILE.read_text(encoding="utf-8"), encoding="utf-8")
        config = without_ours(config)
        if action == "install":
            for event, handlers in PROBE_HOOKS.items():
                config.setdefault("hooks", {}).setdefault(event, []).append({"hooks": handlers})
        write(config)
        print(f"{action}: {HOOKS_FILE}")
    else:
        sys.exit(__doc__)
