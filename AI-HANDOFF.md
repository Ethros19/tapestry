# Tapestry — AI Handoff

A primer for AI assistants (Claude Code, Cursor, Aider, ChatGPT with code execution, etc.) helping a user install, run, modify, or debug Tapestry. Drop this into the agent's context up front and it should be able to handle most reasonable requests without further onboarding.

> **For users**: paste this file (or a link to it) into your AI assistant, then say *"I'd like to install / run / extend Tapestry — read this first."* The agent will know what to do.

---

## What Tapestry is

A FastAPI + vanilla-JS web app shaped like a Sony CHF90 cassette deck. It bridges [archive.org](https://archive.org) search to a pluggable set of audio playback backends. Users find concert recordings, load them as "tapes," and stream them to the player they've chosen.

Three backends are implemented today:

| Backend | What it talks to | Discovery |
|---|---|---|
| `lyrion` | Lyrion / Logitech Media Server JSON-RPC at `:9000/jsonrpc.js` | mDNS (`_slimproto._tcp`) or manual URL |
| `dlna`   | UPnP MediaRenderer devices (Sonos, ultraRendu MPD/DLNA, smart TVs, AVRs) | SSDP via `async-upnp-client` |
| `local`  | An HTML5 `<audio>` element in the page itself | Always present |

A fourth, `airplay` (`pyatv`-based), is planned but not implemented.

The app ships two ways:
1. **Headless server**: `uvicorn app.main:app --reload --port 8080`, browse to `http://localhost:8080`.
2. **Native macOS app**: `python -m app.desktop` (boots uvicorn on a free localhost port, opens a pywebview window). PyInstaller-bundles to `Tapestry.app`.

---

## Repo map

```
.
├── app/
│   ├── __init__.py
│   ├── archive.py          # archive.org search + item metadata. SOURCE_FILTERS, build_query, get_item.
│   ├── desktop.py          # pywebview entry point — `python -m app.desktop`
│   ├── main.py             # FastAPI app: routes + lifespan + drawer/settings/cover endpoints
│   ├── settings.py         # data dir resolution + LYRION_URL precedence (env > file > default)
│   └── players/
│       ├── __init__.py     # BACKENDS registry — register new backends here
│       ├── base.py         # PlayerBackend Protocol + BackendError
│       ├── lyrion.py       # JSON-RPC client + mDNS discover_servers()
│       ├── dlna.py         # SSDP discovery + AVTransport control + per-device queue
│       └── local.py        # No-op backend; frontend drives the <audio> element
├── static/
│   ├── index.html          # Single-page UI shell + modals + templates
│   ├── app.js              # ~2 KLOC; drivers, drawer, mix tape, search, settings — see "Frontend layout"
│   └── style.css           # Token-driven cassette deck CSS; --tape-* vars apply to deck + drawer spines
├── scripts/
│   ├── build-icon.py       # Pillow-drawn 1024×1024 cassette icon master
│   ├── build-icon.sh       # → dist/icon.icns (sips + iconutil)
│   ├── build-app.sh        # → dist/Tapestry.app (PyInstaller)
│   └── build-dmg.sh        # → dist/Tapestry.dmg (hdiutil)
├── docs/                   # Optimized README screenshots (committed)
├── README.md               # Public-facing docs
├── CHANGELOG.md            # Keep-a-Changelog
├── CONTRIBUTING.md         # PR/style guide
├── LICENSE                 # MIT
├── requirements.txt        # Runtime deps (fastapi, httpx, async-upnp-client, pywebview, zeroconf, ...)
└── requirements-dev.txt    # + pyinstaller, Pillow
```

User data lives **outside the repo** at `~/Library/Application Support/Tapestry/` (or `./data/` in dev fallback): `drawer.json`, `settings.json`, `mix-covers/`. Auto-migrated from `./data/` on first boot.

---

## Quick install / run

Requires **Python 3.11+**. macOS ships 3.9 by default; install via Homebrew (`brew install python@3.13`).

```bash
git clone https://github.com/Ethros19/tapestry.git
cd tapestry
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Option A — dev server (auto-reload on .py edits, hard-refresh for css/js)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
# → http://localhost:8080

# Option B — native window (no browser)
python -m app.desktop

# Option C — package as Mac app
pip install -r requirements-dev.txt
./scripts/build-icon.sh         # only needed once (or after editing the icon)
./scripts/build-app.sh          # → dist/Tapestry.app
./scripts/build-dmg.sh          # → dist/Tapestry.dmg
open dist/Tapestry.app
```

First run: open Settings (⚙ in the topbar) → click **↻ Find LMS** to mDNS-discover Lyrion servers, or paste the JSON-RPC URL manually.

---

## Architecture cheat sheet

### The unified player API

All backend control flows through one URL shape:

```
POST /api/players/{backend}/{player_id}/{action}
GET  /api/players/{backend}/{player_id}/status
```

Where `{action}` ∈ `play | add | insert | play_show | load_show | start | pause | stop | next | prev | eject | seek_by | volume`. Bodies vary per action (`{url}` for play/add/insert, `{urls}` for play_show/load_show, `{delta}` for seek_by, `{volume}` for volume, none for the rest).

Listing players: `GET /api/players` returns an aggregated list across every registered backend, with per-backend `errors` so a Lyrion outage doesn't hide DLNA discoveries.

### Adding a new backend

1. Create `app/players/<name>.py` with a class implementing `PlayerBackend` (see `base.py`). Smallest example: `local.py`. Most involved: `dlna.py`.
2. Register an instance in `app/players/__init__.py`'s `BACKENDS` dict.
3. Add a label for the dropdown in `static/app.js`'s `backendLabel` map (search for `backendLabel`).
4. The unified API picks it up automatically; no new routes needed.
5. Smoke-test: list players, status, play/pause/eject, switching to and from this backend mid-tape.

### Frontend layout

`static/app.js` is ~2 KLOC, single-file ES module, no build step. Major sections, in order:

1. **Sound** (lines ~9-100) — Web Audio synthesizer for cassette key clunks, tape-load whoosh, eject spring. No asset files.
2. **State** (~110-150) — `state.player`, `state.currentItem`, `state.spoolCtx`, `state.mix`, etc.
3. **API + drivers** (~165-330) — `apiDriver` (Lyrion + DLNA via unified API), `localDriver` (in-page `<audio>`), `driver()` factory selects one.
4. **Spool/counter ticker** (~480-510) — 250 ms loop predicting playback time between status polls.
5. **Insert (J-card)** (~530-620) — track list rendering on the deck + per-tape style application.
6. **Drawer + case-open view** (~870-1180) — saved cassettes, sort, click-to-open-case, in-case track actions.
7. **Mix tape** (~1180-1300) — tray, add-to-mix, save modal, cover upload.
8. **Search + results** (~1270-1500) — modal, source filters, expanded card → tracks.
9. **Player select + transport** (~1640-1900) — dropdown population, hand-off, FF/REW with double-click seek.
10. **Init + wiring** (~2030 onwards) — DOM event hookup.

Per-tape style tokens: `--tape-band`, `--tape-band-2`, `--tape-band-hi`, `--tape-paper`, `--tape-paper-2`, `--tape-ink`, `--tape-font`. Both `.cassette` (deck) and `.tape` (drawer spine) read from these so the same item looks like the same tape everywhere. Defaults preserve the original Sony CHF90 amber look.

### Color extraction

When a tape loads, `extractPaletteFromImage(identifier, url)` (in `app.js`) draws the artwork to a 48×48 canvas, buckets pixels by hue (12 buckets × 30°), and picks the most-populous saturated bucket as the band color. Paper is the band tinted toward cream; ink is a desaturated complement. archive.org images are CORS-blocked → routed through the server-side `/api/artwork/{identifier}` proxy. Uploaded mix covers (`/covers/<id>.<ext>`) are same-origin so direct.

---

## Common tasks

### Add a search filter

`SOURCE_FILTERS` in `app/archive.py` maps a frontend value → a Lucene fragment. Add a key, then add a corresponding radio button in `static/index.html` inside `<fieldset class="field field--src">`. The frontend reads the checked radio's value and passes it as the `source` query param.

### Tweak the cassette icon

Edit `scripts/build-icon.py` (Pillow drawing code). Re-run `./scripts/build-icon.sh` then `./scripts/build-app.sh`. Preview by opening `dist/icon-master.png` directly.

### Change the deck's default palette

`static/style.css` — search for `.cassette {` and edit the `--tape-*` defaults. These only show when no item is loaded; once a tape loads, JS overwrites them via `applyDeckStyle()`.

### Inspect drawer state

`cat ~/Library/Application\ Support/Tapestry/drawer.json | python -m json.tool`

### Reset everything

```bash
rm -rf ~/Library/Application\ Support/Tapestry/
```

### Run with verbose Lyrion debug

`LYRION_URL=http://your-lms:9000/jsonrpc.js` overrides Settings; useful for testing alternative servers without touching the in-app config.

---

## Common gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| **DLNA player doesn't appear after switching ultraRendu mode** | 30 s discovery cache | Settings → ↻ Rescan players |
| **Counter freezes mid-track on DLNA** | Some renderers don't push `media_position` events | Already mitigated by explicit `GetPositionInfo` SOAP call per poll; if it regresses, verify in `app/players/dlna.py:_set_and_play` neighborhood |
| **502 on first DLNA call after server restart** | In-memory device cache is empty; frontend keeps the selected player | `_device()` self-heals on cache miss; if not, hit Settings → Rescan |
| **Mix tray won't hide on Discard** | CSS `display: flex` overriding `[hidden]` attribute | Already fixed — `.mix-tray[hidden] { display: none !important; }` |
| **Search returns nothing on `LIVE`** | Band's recordings aren't in `etree`; the title-heuristic OR-clause should still match | If not: try `ALL` source. The `live` filter unions etree with `title:(live OR concert OR fillmore OR …)` |
| **archive.org CORS error during palette extraction** | Direct artwork URL hits archive.org without CORS headers | Should be routed through `/api/artwork/<id>` proxy automatically; verify `paletteFetchUrl()` in app.js |
| **macOS Gatekeeper blocks the .app** | Build is unsigned | Right-click → Open → confirm in dialog. To eliminate the warning permanently, see code-signing stubs in `scripts/build-app.sh` and `scripts/build-dmg.sh` |
| **PyInstaller `ImportError: attempted relative import`** | Already fixed by using absolute imports in `app/desktop.py`; if you add new entry-point scripts, use `from app.x import y`, not `from .x import y` |
| **`pip install` fails on `python-multipart`** | Required for FastAPI's `UploadFile`; in `requirements.txt` already |

---

## Code style

- **Python**: 4-space, type hints on new code, no `from x import *`. Wrap async I/O in try/except + raise `BackendError` for backend-layer issues so `app/main.py` can surface them as 502s.
- **JS**: vanilla ES module. No build step. Functions over classes. `.textContent` over `.innerHTML` for any user-controlled string. `escapeHTML()` exists in `app.js` if you must template HTML.
- **CSS**: per-component classes. `var(--tape-*)` tokens for anything tape-colored. Use `!important` only to override the universal `.field input` rules (e.g. `[type="checkbox"]`).
- **Comments**: only when the *why* is non-obvious. Don't restate what code does. Refactors that delete redundant comments are welcome.

---

## Constraints / non-goals

- **No build step** for the frontend. Don't propose adding webpack/vite/tsc unless the user explicitly asks.
- **No framework** for the frontend (React/Vue/Svelte). Vanilla ES modules forever.
- **Single-user assumption**. The API has no auth; designed for `127.0.0.1` binding. If a feature would only make sense in a multi-user world, propose adding auth first.
- **Local network only** for playback. We don't proxy audio; the player fetches archive.org URLs directly. Don't add a transcoding step unless the user asks.

---

## Where to look first when…

- **A new endpoint is failing**: `app/main.py` (route definitions are linear, top to bottom).
- **A backend command is broken**: the relevant `app/players/<name>.py`. All implement the same Protocol; comparing against `local.py` (simplest) often reveals what's missing.
- **A UI element looks wrong**: in `static/app.js`, search for the element's id. The renderer function will be near the wiring.
- **A CSS class isn't styling correctly**: there are two ".tape" rule blocks in `static/style.css` — one scoped `.reels .tape` (loading spinner), one `.tape` (drawer cassette). The collision was a real bug during development; keep the scoping.
- **Discovery isn't finding something**: `app/players/dlna.py:_discover()` for SSDP; `app/players/lyrion.py:discover_servers()` for mDNS. Both lazy-import their library, both return [] silently on failure (raised back to the user via `BackendError` in `list_players`).

---

## When you (the agent) are unsure

- **Prefer reading the code** to guessing API surface — the codebase is small enough to grep through.
- **Ask the user** before destructive operations: removing files, force-pushing, changing the LMS URL globally, deleting drawer entries.
- **Default to the existing patterns**: if you're adding a player action, mirror the existing ones; if you're adding a frontend feature, follow the section structure in `app.js`.
- **The README is the public-facing source of truth**. If you change behavior, update README.md and CHANGELOG.md in the same PR.
