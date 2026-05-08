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

**Requires Python 3.11 or newer.** macOS ships 3.9 by default — install via
[Homebrew](https://brew.sh) (`brew install python@3.13`) if needed.

```bash
git clone https://github.com/Ethros19/tapestry.git
cd tapestry
python3.13 -m venv .venv && source .venv/bin/activate   # or python3.11/3.12
pip install -r requirements.txt

LYRION_URL=http://your-lms-host:9000/jsonrpc.js \
  uvicorn app.main:app --reload --port 8080
# → http://localhost:8080
```

If everything's wired up correctly you'll see your players in the dropdown
in the top bar. If the offline banner shows up, `LYRION_URL` is wrong or
your LMS isn't reachable from this machine.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `LYRION_URL` | `http://localhost:9000/jsonrpc.js` | JSON-RPC endpoint of your LMS |

Players are auto-discovered from LMS at startup — pick one from the dropdown in the top bar.

## Working from another machine

Picking up the project on a second machine? After cloning + setting up the
venv, two extra things to know:

### Bring your drawer with you

The tape drawer (saved cassettes) lives at `data/drawer.json` and is
**gitignored on purpose** — it's user data, not source. To carry your
collection over once:

```bash
scp source-machine:path/to/tapestry/data/drawer.json data/
```

For ongoing sync, point a Syncthing / iCloud / Dropbox folder at `data/` so
new entries flow between machines automatically.

### Network reachability

Lyrion typically advertises itself as an mDNS hostname (e.g.
`SomeHost.local`) which only resolves on the **same local network**. If you
want to use Tapestry from outside that LAN:

- **VPN/tunnel back to home** — Tailscale, WireGuard, or your router's VPN
  works fine; once on the VPN, `LYRION_URL=http://lms-host.local:9000/jsonrpc.js`
  resolves as usual.
- **Public endpoint** — point `LYRION_URL` at a forwarded port or reverse
  proxy (consider auth — LMS has no built-in auth).
- **Local-only LMS** — run a second LMS instance on the laptop itself,
  pointed at a separate music library, and use `LYRION_URL=http://localhost:9000/jsonrpc.js`.

### First-run checklist

1. ✅ Python 3.11+ active in your venv (`python --version`)
2. ✅ `pip install -r requirements.txt` finished without errors
3. ✅ LMS is reachable from this machine — `curl $LYRION_URL` should return `{"error":"...invalid method..."}` (a 200 response from the JSON-RPC handler counts as reachable)
4. ✅ At least one player is registered with that LMS instance and shows up in the topbar dropdown
5. ✅ Hard-refresh the browser (Cmd+Shift+R) on first load to ensure CSS/JS aren't cached from any previous Tapestry instance

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
