# sim3d — Paperclip 3D visualizer

3D (three.js) visualization of a Paperclip company's agents and tasks.

```bash
python3 server.py                # http://localhost:8765
READONLY=1 python3 server.py     # block every write
DRYRUN=1   python3 server.py     # accept writes but don't forward
PAPERCLIP=http://127.0.0.1:3100 PORT=8765 python3 server.py
```

`server.py` serves the static files and proxies `/api/*` to the local Paperclip API (writes limited to whitelisted task-assignment operations, localhost-only).
