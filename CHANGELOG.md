# Changelog

All notable changes to Tapestry. The format follows [Keep a Changelog](https://keepachangelog.com); versions follow loose [SemVer](https://semver.org).

## [1.2.0] — 2026-05-12

### Added
- **Tape sharing** — new `.tape` file format (JSON, `application/x-tapestry-tape`). Cassette case view exposes a copy-paste share link (cover stripped to keep URLs short) and a `.tape` file download. Imports work via drawer-toolbar button, drag-drop onto the drawer modal, or `?import=<blob>` URL parameter — all funneled through a preview modal before filing. Mix-tape IDs are reminted on import (with `imported_from` breadcrumb); grabbed tapes keep their archive.org identifier. Custom document icon (cassette on a folded paper page) and a Cocoa `application:openFile:` delegate so Finder double-clicks on `.tape` files open in Tapestry.
- **In-app updates** — GitHub-releases poller in `app/updater.py` with loose-semver compare, DMG download, and a detached installer that mounts the disk image, ditto-swaps the `.app`, strips quarantine, and relaunches. Settings → Updates fieldset has a version line, auto-check toggle (default on, throttled to 6 h), manual "Check now", and a "Download & install" button (only enabled when the bundle is writable). Falls back to opening the release page in dev mode.
- **Per-output audio routing** (local "This Mac" backend) — frontend feature-detects `HTMLMediaElement.setSinkId` and expands the local entry into one entry per macOS audio output (built-in, BT speakers, AirPods, HDMI, USB DAC). "Reveal device names" requests transient mic permission so `enumerateDevices()` returns labels; "Refresh outputs" + a `devicechange` listener pick up newly paired devices. Settings hint covers the AirPlay route (Control Center first).
- **Docker support** — `Dockerfile` + `compose.yml` for running Tapestry headless (Linux / server use; the macOS desktop bundle remains the primary distribution).

### Changed
- Version is now sourced from `updater.__version__` everywhere — FastAPI title, User-Agent, colophon, settings panel — so it can't drift.
- Bigger gear icon in the deck chrome (22px, was 18).
- `webview.settings['ALLOW_DOWNLOADS'] = True` in `desktop.py` so the WKWebView native save panel handles `.tape` downloads (~/Downloads); previously they were silently swallowed.

### Fixed
- Local-backend "armed but never played" vs "user pressed play, then paused" now distinguished via `localCtx.started` — the deck no longer reads as paused on a fresh load, and PLAY+PAUSE piano-key behavior is preserved after a real pause. Status returns `mode=stop` for ended queues so a naturally-finished tape doesn't read as paused.

### Security
- `/api/updates/install` no longer trusts `download_url` from the request body. The updater keeps an allow-list populated by the most recent `check_latest()`; install refuses anything that doesn't match, guarded by a `threading.Lock` since both endpoints run on worker threads.

## [1.1.4] — 2026-05-10

### Reverted
- Rolled back the local-audio error-recovery change from 1.1.3. The added `error` listener / cap / `localPlay` helper introduced new playback issues in real use. 1.1.4 is identical to 1.1.2 functionally; the underlying "freeze on bad track" bug from 1.1.3's commit message is still open and will be re-fixed once we can reproduce it under devtools.

## [1.1.2] — 2026-05-09

### Fixed
- Search "SEARCHING · · ·" reel animation kept spinning after results came back. Same root cause as the 1.1.0 mix-tray fix — `.loading` had `display: flex` which beat the browser's default `[hidden] { display: none }`. Added an explicit `.loading[hidden]` rule.

## [1.1.1] — 2026-05-09

### Changed
- Search results increased from 40 to 100 rows per query.

### Fixed
- Empty-drawer blurb pointed to the wrong key (REC, which builds mix tapes); now points to ▤ Grab, which is what actually files a tape.

## [1.1.0] — 2026-05-08

### Added
- **Multi-backend playback** — pluggable `app/players/` package with a unified `/api/players/{backend}/{id}/{action}` API.
  - **Local "This Mac"** backend — in-app HTML5 `<audio>` playback.
  - **DLNA / UPnP** backend — SSDP discovery and AVTransport control.
  - Hand-off when switching players (eject from old → load on new, paused).
- **mDNS LMS discovery** — `↻ Find LMS` button in Settings finds Lyrion servers on the LAN automatically.
- **Search filters** — `LIVE` / `ALBUMS` / `RADIO` / `ALL` source segmentation; `Match artist only` checkbox to pin queries to the `creator` field.
- **Mix tapes** — build a custom playlist from any track (search results or open drawer cases), 90-min cap, save to drawer with optional uploaded cover image. REC key dubs the currently-playing track onto the in-progress mix.
- **Drawer "case open" view** — clicking a tape now reveals its track list with per-track actions instead of jumping straight to the deck.
- **Drawer sort** — Saved newest/oldest, Title A→Z, Artist A→Z, Year newest/oldest.
- **▤ Grab** — save tapes to the drawer from search results or via a button on the loaded cassette's J-card insert.
- **Album-art-driven cassette colors** — dominant color extraction from archive.org artwork (or uploaded mix-tape covers) drives the cassette's band/paper/ink palette. Deck cassette and drawer spine match.
- **Album-art deck backdrop** — blurred, warm-tinted album art behind the cassette in the bay.
- **FF/REW seek** — single-click skips track; double-click seeks ±30 s within the current track. REW restarts the current track if you're more than 3 s in.
- **Settings panel** — gear button opens a modal for LYRION URL, mDNS LMS discovery, DLNA rescan, and "Refresh artwork colors" backfill.
- **Standalone macOS app** — `python -m app.desktop` runs in a native window via pywebview. `./scripts/build-app.sh` produces `Tapestry.app` via PyInstaller. `./scripts/build-dmg.sh` wraps it for distribution. Custom cassette icon generated programmatically by `scripts/build-icon.py`.

### Changed
- Drawer + settings + mix-tape covers now live at `~/Library/Application Support/Tapestry/` (auto-migrated from `./data/` on first boot).
- Tape counter now ticks smoothly via the spool ticker (250 ms) instead of waiting on the 3-second status poll.
- Lyrion `LYRION_URL` is read at request time, so changes via Settings take effect without restarting.
- Drawer grid switched from `auto-fill` → `auto-fit` so a few tapes fill the row instead of being stranded on the left.

### Fixed
- `.tape` selector collision between the search-loading spinner and drawer cassettes (forced drawer tapes to 70px wide with a tape-roll animation).
- DLNA position no longer freezes — explicit `GetPositionInfo` SOAP call per status poll instead of relying on the cached attribute.
- DLNA backend self-heals after server restart instead of 502-ing until manual rescan.
- Lyrion REW from mid-track no longer 422s on the seek endpoint (delta is rounded to int).
- Mix-tape tray now actually hides on Save / Discard (the `display: flex` rule was overriding the `[hidden]` browser default).
- Counter seconds-padding bug (1:05 used to display malformed).

## [1.0.0] — initial release

- archive.org search → Lyrion bridge.
- Sony CHF90 cassette deck UI with persistent drawer of saved tapes.
