# Changelog

All notable changes to Tapestry. The format follows [Keep a Changelog](https://keepachangelog.com); versions follow loose [SemVer](https://semver.org).

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
