"""Serve the ADR 0006 thread-tab probe over MCP stdio (Python 3)."""

import itertools
import json
import os
import sys
from datetime import datetime
from pathlib import Path


TITLE = "Matt Deck · ADR 0006"
URI = "ui://matt-deck-adr6/probe.html"
MIME = "text/html;profile=mcp-app"
RESOURCE = {"uri": URI, "name": "adr6-probe", "mimeType": MIME}
TOOL = {
    "name": "open_probe",
    "title": TITLE,
    "description": "Open the Matt Deck ADR 0006 experiment in this conversation.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    "annotations": {"readOnlyHint": True, "openWorldHint": False},
    "_meta": {
        "ui": {"resourceUri": URI},
        "openai/ui": {"entrypoints": [{"type": "thread"}], "preferredModelDisplayMode": "fullscreen"},
    },
}
READ_TOOL = {
    "name": "probe_read",
    "title": "读取探针状态",
    "description": "Return this probe server's process id, call count and clock. Called by the probe page only.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    "annotations": {"readOnlyHint": True, "openWorldHint": False},
    "_meta": {"ui": {"visibility": ["app"]}},
}
READS = itertools.count(1)
LOG_TOOL = {
    "name": "probe_log",
    "title": "记录页面日志",
    "description": "Append one line of the probe page's log to page-log.txt next to this server. Called by the probe page only.",
    "inputSchema": {
        "type": "object",
        "properties": {"line": {"type": "string"}},
        "required": ["line"],
        "additionalProperties": False,
    },
    "annotations": {"readOnlyHint": False, "openWorldHint": False},
    "_meta": {"ui": {"visibility": ["app"]}},
}


def reply(method, params):
    if method == "initialize":
        versions = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
        requested = params.get("protocolVersion")
        return {
            "protocolVersion": requested if requested in versions else versions[0],
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "matt-deck-adr6", "title": TITLE, "version": "1.0.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL, READ_TOOL, LOG_TOOL]}
    if method == "resources/list":
        return {"resources": [RESOURCE]}
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != URI:
            raise ValueError("Unknown resource URI")
        html = Path(__file__).with_name("probe.html").read_text(encoding="utf-8")
        return {"contents": [{"uri": URI, "mimeType": MIME, "text": html}]}
    if method == "tools/call":
        if params.get("name") == LOG_TOOL["name"]:
            line = f"{datetime.now().isoformat(timespec='seconds')} pid={os.getpid()} {params['arguments']['line']}\n"
            with Path(__file__).with_name("page-log.txt").open("a", encoding="utf-8") as log:
                log.write(line)
            return {"content": [{"type": "text", "text": "logged"}]}
        if params.get("arguments", {}) != {}:
            raise ValueError("Expected no arguments")
        if params.get("name") == TOOL["name"]:
            return {"content": [{"type": "text", "text": TITLE}]}
        if params.get("name") == READ_TOOL["name"]:
            state = {"pid": os.getpid(), "calls": next(READS), "time": datetime.now().isoformat(timespec="seconds")}
            return {"content": [{"type": "text", "text": json.dumps(state)}]}
        raise ValueError("Unknown tool")
    raise NotImplementedError(method)


if __name__ == "__main__":
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
