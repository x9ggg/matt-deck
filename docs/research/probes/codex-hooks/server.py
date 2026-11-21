"""Serve the Codex hook and Session identity probe over MCP stdio (Python 3).

Every tools/call is written to probe-log.txt next to this file with its
arguments and `_meta`, so the log shows what Codex tells a server about the
Session. The process also logs its start, its working directory and how it ends.
"""

import json
import os
import signal
import sys
from datetime import datetime
from pathlib import Path


TITLE = "Matt Deck · 钩子探针"
URI = "ui://matt-deck-hook-probe/probe.html"
MIME = "text/html;profile=mcp-app"
REPOSITORY = str(Path(__file__).resolve().parents[4])
NO_INPUT = {"type": "object", "properties": {}, "additionalProperties": False}
TOOLS = [
    {
        "name": "open_probe",
        "title": TITLE,
        "description": "Open the Matt Deck hook probe in this conversation.",
        "inputSchema": NO_INPUT,
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
        "_meta": {
            "ui": {"resourceUri": URI},
            "openai/ui": {"entrypoints": [{"type": "thread"}], "preferredModelDisplayMode": "fullscreen"},
        },
    },
    {
        "name": "probe_page",
        "title": "记录页面的调用",
        "description": "Log one call from the probe page. Called by the probe page only.",
        "inputSchema": {"type": "object", "properties": {"line": {"type": "string"}}, "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "openWorldHint": False},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "probe_hook",
        "title": "记录钩子的调用",
        "description": "Log one call from a Codex hook. Called by the probe's hooks only.",
        "inputSchema": {"type": "object", "additionalProperties": True},
        "annotations": {"readOnlyHint": False, "openWorldHint": False},
    },
    {
        "name": "probe_agent",
        "title": "记录 agent 的调用",
        "description": "Log one call from the agent. Call it when the user asks for probe_agent.",
        "inputSchema": NO_INPUT,
        "annotations": {"readOnlyHint": False, "openWorldHint": False},
    },
]


def log(text):
    line = f"{datetime.now().isoformat(timespec='seconds')} pid={os.getpid()} {text}\n"
    with Path(__file__).with_name("probe-log.txt").open("a", encoding="utf-8") as file:
        file.write(line)


def reply(method, params):
    if method == "initialize":
        versions = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
        requested = params.get("protocolVersion")
        log(f"initialize requested={requested} client={json.dumps(params.get('clientInfo'), ensure_ascii=False)}")
        return {
            "protocolVersion": requested if requested in versions else versions[0],
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "matt-deck-hook-probe", "title": TITLE, "version": "1.0.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "resources/list":
        return {"resources": [{"uri": URI, "name": "hook-probe", "mimeType": MIME}]}
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != URI:
            raise ValueError("Unknown resource URI")
        html = Path(__file__).with_name("probe.html").read_text(encoding="utf-8")
        return {"contents": [{"uri": URI, "mimeType": MIME, "text": html}]}
    if method == "tools/call":
        name = params.get("name")
        if name not in [tool["name"] for tool in TOOLS]:
            raise ValueError("Unknown tool")
        arguments = dict(params.get("arguments") or {})
        # 提示词只在本仓库的 Session 里记原文，别的项目里只记长度。
        if "prompt" in arguments and not os.getcwd().startswith(REPOSITORY):
            arguments["prompt"] = f"<{len(str(arguments['prompt']))} chars>"
        log(
            f"call {name} arguments={json.dumps(arguments, ensure_ascii=False)} "
            f"_meta={json.dumps(params.get('_meta'), ensure_ascii=False)}"
        )
        # 钩子调用的输出可能被宿主当成上下文注入，所以不返回文字。
        return {"content": [] if name == "probe_hook" else [{"type": "text", "text": TITLE}]}
    raise NotImplementedError(method)


def ended_by(number, _frame):
    log(f"signal {signal.Signals(number).name}")
    sys.exit(0)


if __name__ == "__main__":
    log(f"start cwd={os.getcwd()} ppid={os.getppid()}")
    for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(number, ended_by)
    for line in sys.stdin:
        response = {"jsonrpc": "2.0", "id": None}
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            response["id"] = request["id"]
            response["result"] = reply(request["method"], request.get("params", {}))
        except json.JSONDecodeError:
            response["error"] = {"code": -32700, "message": "Parse error"}
        except ValueError as error:
            response["error"] = {"code": -32602, "message": str(error)}
        except NotImplementedError as error:
            response["error"] = {"code": -32601, "message": f"Unknown method: {error}"}
        print(json.dumps(response), flush=True)
    log("stdin closed")
