# Tapestry

A vintage cassette deck for [archive.org](https://archive.org) → [Lyrion Music Server](https://lyrion.org).

Browse the Live Music Archive (and adjacent collections), load a "tape," and stream it straight to whatever player Lyrion is driving.

> **Tape · stry** — *woven from the live music archive.*

---

## Why

The archive.org plugin bundled with Lyrion is a favorites browser, not a search tool. You have to find shows in a separate browser window, add them to your archive.org favorites, and only *then* browse them inside Lyrion. Tapestry skips that loop:

1. Type a query (`pink floyd 1973 rainbow`).
2. Hit **Load tape** on a result.
3. Press **PLAY** on the cassette deck.
4. Audio streams directly from archive.org to your selected Lyrion player.

## What you get

- **archive.org search** with year and format (FLAC) filters
- **Sony CHF90-styled cassette deck** — three-section paper label (handwritten J-card insert with real track titles parsed from the item description), recessed bay with reels that grow/shrink with album playback, brushed-champagne chassis, piano-key transports
- **Tape Drawer** — REC saves the loaded tape, Drawer opens a rack of saved tapes laid out as cassette spines, each with a deterministic random vintage color and handwritten font
- **Audio feedback** — clunk on key press, cassette-load whoosh, eject spring (synthesized via Web Audio, no asset files)
- **Persistent across browsers** — the drawer is stored server-side at `data/drawer.json`
- **Keyboard shortcuts** — `/` search · `t` drawer · `r` rec · `e` eject · `Esc` close

## Stack

- **Backend** — FastAPI + httpx (async). One Python module per concern (`archive.py`, `lyrion.py`, `main.py`)
- **Frontend** — vanilla ES module + hand-rolled CSS. No build step, no framework.
- **Storage** — JSON file for the drawer

~150 LOC of Python for the bridge + ~1k LOC of frontend.

## Quick start

```bash
git clone https://github.com/Ethros19/tapestry.git
cd tapestry
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
LYRION_URL=http://your-lms-host:9000/jsonrpc.js \
  uvicorn app.main:app --reload --port 8080
# → http://localhost:8080
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LYRION_URL` | `http://localhost:9000/jsonrpc.js` | JSON-RPC endpoint of your LMS |

Players are auto-discovered from LMS at startup — pick one from the dropdown in the top bar.

## Architecture

```
                    Tapestry (this app)
                    ┌─────────────────────┐
   archive.org ───→ │ FastAPI on :8080    │ ───→ Lyrion JSON-RPC :9000 ───→ Player
                    │ + static frontend   │       (LMS routes audio to)
                    └─────────────────────┘
```

The audio stream itself usually goes **archive.org → Lyrion player** directly (LMS just tells the player which URL to fetch). Tapestry orchestrates control, not bytes.

## API

The frontend calls these endpoints (same origin):

- `GET  /api/search?q=...&year=...&fmt=flac`
- `GET  /api/item/<identifier>`
- `GET  /api/lyrion/players`
- `GET  /api/lyrion/status?player_mac=<mac>`
- `POST /api/lyrion/play|add|insert|play_show|load_show|start|pause|stop|next|prev|eject`
- `GET|POST /api/drawer` · `DELETE /api/drawer/<identifier>`

OpenAPI docs at `/docs` while the server is running.

## Run as a background service (macOS)

A launchd plist at `~/Library/LaunchAgents/com.ethros.tapestry.plist` with `RunAtLoad=true` and `KeepAlive=true` works fine. Point its `WorkingDirectory` at the cloned repo and its `ProgramArguments` at the venv's `uvicorn`.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [archive.org Live Music Archive](https://archive.org/details/etree) — the corpus
- [Lyrion Music Server](https://lyrion.org) — the player network
- The Sony CHF90 — the visual reference
- The bootleg-trader culture that built etree.org and the tape-tree distribution method this app's branding nods to
