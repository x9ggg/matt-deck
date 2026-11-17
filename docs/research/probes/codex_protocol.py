#!/usr/bin/env python3
"""Probe a real local Codex app-server with two throwaway threads and a loopback Responses fixture."""
import argparse
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Fixture(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.split("?")[0] != "/v1/responses":
            return self.send_error(404)
        payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "zstd":
            import compression.zstd
            payload = compression.zstd.decompress(payload)
        self.server.skill_loaded.append(b"probe-token-inside-selected-skill" in payload)
        self.server.calls += 1
        index = self.server.calls
        self.server.received.set()
        self.server.release.wait(18)
        message = {"type": "message", "id": f"msg{index}", "role": "assistant",
                   "status": "completed", "content": [{"type": "output_text", "text": f"LOCAL-ACK-{index}", "annotations": []}]}
        events = [
            ("response.created", {"response": {"id": f"resp{index}", "object": "response", "status": "in_progress"}}),
            ("response.output_item.done", {"output_index": 0, "item": message}),
            ("response.completed", {"response": {"id": f"resp{index}", "object": "response", "status": "completed", "output": [message]}})
        ]
        body = b"".join((f"event: {event}\ndata: " + json.dumps({"type": event, **data}) + "\n\n").encode() for event, data in events)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class AppServer:
    def __init__(self, executable, base, port):
        self.inbox = queue.Queue()
        self.notifications = []
        self.seq = 0
        env = {k: os.environ[k] for k in ["PATH", "TMPDIR", "LANG"] if k in os.environ}
        env.update(HOME=str(base), CODEX_HOME=str(base / "codex"), HTTP_PROXY="http://127.0.0.1:1",
                   HTTPS_PROXY="http://127.0.0.1:1", ALL_PROXY="http://127.0.0.1:1", NO_PROXY="localhost,127.0.0.1")
        (base / "codex").mkdir(exist_ok=True)
        config = (f'model_provider="probe"\nmodel="probe"\n[model_providers.probe]\nname="Loopback"\n'
                  f'base_url="http://127.0.0.1:{port}/v1"\nwire_api="responses"\n'
                  'request_max_retries=0\nstream_max_retries=0\n[analytics]\nenabled=false\n')
        (base / "codex" / "config.toml").write_text(config)
        self.proc = subprocess.Popen([executable, "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, cwd=base, env=env)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.call("initialize", {"clientInfo": {"name": "matt_deck_probe", "version": "1"},
                                 "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def _read(self):
        for line in self.proc.stdout:
            self.inbox.put(json.loads(line))
        self.inbox.put({"eof": True})

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params):
        self.seq += 1
        self.send({"id": self.seq, "method": method, "params": params})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            entry = self.inbox.get(timeout=max(.1, deadline-time.monotonic()))
            if "eof" in entry:
                raise RuntimeError("app-server exited at " + method)
            if entry.get("id") == self.seq and ("result" in entry or "error" in entry):
                if "error" in entry:
                    raise ValueError(f"{method}: {entry['error']}")
                return entry["result"]
            self.notifications.append(entry)
        raise TimeoutError(method)

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=5)


def probe(executable):
    with tempfile.TemporaryDirectory(prefix="matt-deck-probe-") as folder:
        base = Path(folder).resolve()
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        fixture.calls = 0
        fixture.skill_loaded = []
        skill = base / "codex" / "skills" / "ask-matt" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: ask-matt\ndescription: Temporary routing probe.\n"
                         "disable-model-invocation: true\n---\nprobe-token-inside-selected-skill\n")
        fixture.received = threading.Event()
        fixture.release = threading.Event()
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        port = fixture.server_address[1]
        rpc = AppServer(executable, base, port)
        try:
            def new_thread(name):
                cwd = base / name
                cwd.mkdir()
                return rpc.call("thread/start", {"cwd": str(cwd), "modelProvider": "probe", "model": "probe",
                                                 "sandbox": "read-only", "approvalPolicy": "never"})["thread"]["id"]
            a, b = new_thread("a"), new_thread("b")
            msg = lambda value: [{"type": "text", "text": value}]
            active = rpc.call("turn/start", {"threadId": a, "input": msg("hold fixture response")})["turn"]["id"]
            assert fixture.received.wait(8), "local fixture did not receive turn/start"
            def queued():
                return rpc.call("thread/queue/list", {"threadId": a})["data"]
            def add(text, uid, with_skill=False):
                items = msg(text)
                if with_skill:
                    items.append({"type": "skill", "name": "ask-matt", "path": str(skill)})
                return rpc.call("thread/queue/add", {"threadId": a, "input": items,
                                                      "clientUserMessageId": uid})["queuedSubmission"]["id"]
            cancel_id = add("request-to-cancel", str(uuid.uuid4()))
            uid = str(uuid.uuid4())
            keep = add("recommend-request-" + uid, uid, with_skill=True)
            assert [x["id"] for x in queued()] == [cancel_id, keep]
            assert rpc.call("thread/queue/list", {"threadId": b})["data"] == []
            rpc.call("thread/queue/delete", {"threadId": a, "queuedSubmissionId": cancel_id})
            assert [x["id"] for x in queued()] == [keep]
            print("PASS distinct thread IDs, busy A queue isolation, B empty, selective cancel", flush=True)
            fixture.release.set()
            def await_completed(n, deadline=12, target=a):
                until = time.monotonic() + deadline
                while time.monotonic() < until:
                    rpc.call("thread/read", {"threadId": target})
                    completed = [e["params"] for e in rpc.notifications if e.get("method") == "turn/completed"
                                 and e["params"]["threadId"] == target and e["params"]["turn"]["status"] == "completed"]
                    if len(completed) >= n:
                        return completed
                    time.sleep(.1)
                return []
            assert await_completed(1), "first turn did not complete"
            if queued():
                time.sleep(1)
            automatic = not queued()
            if not automatic:
                rpc.call("thread/queue/start", {"threadId": a, "queuedSubmissionId": keep})
            finished = await_completed(2)
            assert len(finished) == 2 and finished[0]["turn"]["id"] == active
            second = finished[1]["turn"]["id"]
            items = [e["params"] for e in rpc.notifications if e.get("method") == "item/completed"
                     and e["params"].get("threadId") == a and e["params"].get("turnId") == second]
            assert any(x["item"].get("type") == "agentMessage" and x["item"].get("text") == "LOCAL-ACK-2" for x in items)
            assert any(uid in json.dumps(x["item"]) and x["item"].get("type") == "userMessage" for x in items)
            assert fixture.calls == 2 and not queued()
            assert fixture.skill_loaded == [False, True], fixture.skill_loaded
            print("PASS explicit skill input delivered selected fixture skill body only in recommendation turn")
            print("PASS distinct completed turns, correlated input and LOCAL-ACK-2, only 2 loopback requests. Auto-start:", automatic)
            for target, description, label in [
                (b, "$ask-matt recommend a task", "plain skill mention"),
                (new_thread("c"), f"[$ask-matt]({skill}) recommend a task", "explicit Markdown skill mention"),
            ]:
                rpc.call("turn/start", {"threadId": target, "input": msg(description)})
                assert await_completed(1, target=target)
                print(f"OBSERVED {label} inserted fixture skill body: {fixture.skill_loaded[-1]}")
            rpc.close()
            rpc = AppServer(executable, base, port)
            recovered = rpc.call("thread/read", {"threadId": a, "includeTurns": True})["thread"]
            assert Path(recovered["cwd"]) == base / "a" and any(t["id"] == second for t in recovered["turns"])
            print("PASS restart: recovered original A and recommendation turn. B remained separate.")
        finally:
            fixture.release.set()
            rpc.close()
            fixture.shutdown()
            fixture.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default=shutil.which("codex"))
    probe(parser.parse_args().binary)
