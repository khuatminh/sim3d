#!/usr/bin/env python3
"""Static server + guarded proxy to the local Paperclip API.

    python3 sim3d/server.py                # http://localhost:8765
    READONLY=1 python3 sim3d/server.py     # block every write
    DRYRUN=1   python3 sim3d/server.py     # accept writes but do NOT forward them
    PAPERCLIP=http://127.0.0.1:3100 PORT=8765 python3 sim3d/server.py

Reads: any GET /api/*.
Writes: only the four task-assignment operations below, with whitelisted body
fields, a required `X-Sim3D-Confirm` header (forces a CORS preflight, so other
websites cannot trigger writes), and a localhost Host/Origin check.
Every write is logged to stdout.
"""
import json
import os
import re
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PAPERCLIP = os.environ.get("PAPERCLIP", "http://127.0.0.1:3100").rstrip("/")
PORT = int(os.environ.get("PORT", "8765"))
READONLY = os.environ.get("READONLY") == "1"
DRYRUN = os.environ.get("DRYRUN") == "1"
MAX_BODY = 64 * 1024

U = r"[0-9a-fA-F-]{36}"
WRITES = [  # (method, path regex, allowed body keys)
    ("POST",  re.compile(rf"^/api/companies/{U}/issues$"),
     {"title", "description", "projectId", "assigneeAgentId", "priority", "status", "parentId"}),
    ("PATCH", re.compile(rf"^/api/issues/{U}$"),
     {"title", "description", "status", "priority", "assigneeAgentId", "projectId", "comment", "reopen", "resume"}),
    ("POST",  re.compile(rf"^/api/issues/{U}/comments$"), {"body"}),
    ("POST",  re.compile(rf"^/api/agents/{U}/wakeup$"),
     {"source", "triggerDetail", "reason", "forceFreshSession"}),
]
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self, method, body=None):
        req = urllib.request.Request(PAPERCLIP + self.path, data=body, method=method,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
                code, ctype = r.status, r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:      # pass Paperclip's own error through
            data, code, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception:
            return self._json(502, {"error": "paperclip unreachable"})
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()
        self._forward("GET")

    def _write(self):
        method, path = self.command, self.path.split("?")[0]
        if not path.startswith("/api/"):
            return self._json(405, {"error": "method not allowed"})
        if READONLY:
            return self._json(403, {"error": "server started read-only"})
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        origin = self.headers.get("Origin")
        if host not in LOCAL_HOSTS or (origin and (re.sub(r"^https?://", "", origin).rsplit(":", 1)[0] not in LOCAL_HOSTS)):
            return self._json(403, {"error": "forbidden origin"})
        if self.headers.get("X-Sim3D-Confirm") != "1":
            return self._json(403, {"error": "missing confirmation header"})
        rule = next((r for r in WRITES if r[0] == method and r[1].match(path)), None)
        if not rule:
            return self._json(405, {"error": "operation not allowed"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            assert isinstance(body, dict)
        except Exception:
            return self._json(400, {"error": "invalid json"})
        extra = set(body) - rule[2]
        if extra:
            return self._json(400, {"error": "fields not allowed: " + ", ".join(sorted(extra))})
        print(f"[write] {method} {path} {json.dumps(body, ensure_ascii=False)[:300]}{'  (DRYRUN, not forwarded)' if DRYRUN else ''}", flush=True)
        if DRYRUN:
            return self._json(200, {"dryRun": True, "method": method, "path": path, "body": body})
        self._forward(method, json.dumps(body).encode())

    do_POST = do_PATCH = _write
    do_PUT = do_DELETE = lambda self: self._json(405, {"error": "method not allowed"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    mode = "READ-ONLY" if READONLY else ("DRY-RUN writes" if DRYRUN else "read + task assignment")
    print(f"3D office → http://localhost:{PORT}  (proxy → {PAPERCLIP}, {mode})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
