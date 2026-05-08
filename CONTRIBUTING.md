# Contributing

Pull requests welcome. A few ground rules so this stays a project I'd want to maintain in a year.

## Process

- All changes — even one-liners — go through a pull request. `main` is protected; nothing lands without review and approval.
- One topic per PR. Don't bundle unrelated cleanup into a feature branch.
- If you're adding a new playback backend, drop a module in `app/players/` that satisfies the `PlayerBackend` Protocol in `app/players/base.py`, register it in `app/players/__init__.py`, and the unified `/api/players/*` API will pick it up automatically.
- If you're touching the cassette UI: every visual element should fall back gracefully when the tape is empty / paused / stopped. The deck shouldn't look broken when nothing is loaded.

## Local dev

```bash
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8080
```

For the native window:

```bash
python -m app.desktop
```

## Style

- **Python**: 4-space indents, type hints on new code, no `from x import *`.
- **JS**: vanilla ES modules, no framework, no build step. If you want to add a build step, talk first.
- **CSS**: per-component classes, custom properties for tokenized colors. Keep the `var(--tape-*)` family intact — the cassette and drawer-tape spine read from the same tokens.
- **Comments**: only when the *why* is non-obvious. Don't restate what the code does.

## Adding a backend

1. Create `app/players/<name>.py` with a class that implements the `PlayerBackend` Protocol (see `local.py` for the smallest example, `dlna.py` for the most involved).
2. Register the instance in `app/players/__init__.py`'s `BACKENDS` dict.
3. The frontend's player dropdown picks it up via `/api/players` — add a label for it in `app.js`'s `backendLabel` map.
4. Update the README's "What you get" / Architecture sections.
5. Test the basics: list players, status, play, pause, eject, seek, switching to and from the new backend mid-tape.

## Reporting bugs

Include:
- Backend in use (Lyrion / DLNA / Local).
- Browser if relevant (Tapestry is tested on Chrome/Safari/Firefox; the packaged `.app` runs WebKit via pywebview).
- The uvicorn terminal output around the failure if it's a 4xx/5xx.

## Licence

Contributions are accepted under the project's [MIT license](LICENSE).
