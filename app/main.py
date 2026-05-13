"""FastAPI app: archive.org search → multi-backend playback bridge."""
from __future__ import annotations

import base64
import binascii
import json
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import httpx
import secrets
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import archive, players, settings, updater
from .players import BackendError

# Wire format for `.tape` files + share-link blobs. Bumped whenever the
# schema changes incompatibly so older clients can refuse imports they
# can't represent.
TAPE_FORMAT_NAME = "tapestry-tape"
TAPE_FORMAT_VERSION = 1
_TAPE_EXPORT_FIELDS = frozenset({
    "identifier", "title", "creator", "date", "track_count",
    "band_color", "label_color", "ink_color", "font",
    "is_mix", "tracks", "image_url",
})
_COVER_MIME_BY_EXT = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
}
_COVER_EXT_BY_MIME = {v: k for k, v in _COVER_MIME_BY_EXT.items() if k != ".jpeg"}

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
_drawer_lock = Lock()

# Mix-tape cover storage. Hoisted to the top so the tape export/import
# functions farther down can reference these directly — Python would
# resolve them at call time either way, but having a constant referenced
# before its definition is the kind of foot-gun that bites during
# refactors.
_COVERS_DIR = settings.data_dir() / "mix-covers"
_COVERS_DIR.mkdir(parents=True, exist_ok=True)
_COVER_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
_COVER_MAX_BYTES = 6 * 1024 * 1024  # 6 MB

# Cross-thread queue for .tape files opened via Finder double-click. The
# desktop entry point's Cocoa delegate appends here; the frontend drains
# via `/api/tape/pending-open` on boot + on window focus. Drained items
# show the import-preview modal so the user can confirm before filing.
_pending_imports: list[dict[str, Any]] = []
_pending_imports_lock = Lock()


def queue_pending_import(payload: dict[str, Any]) -> None:
    with _pending_imports_lock:
        _pending_imports.append(payload)

# Migrate ./data/drawer.json into Application Support on first boot.
settings.migrate_legacy_drawer()


def _load_drawer() -> list[dict[str, Any]]:
    p = settings.drawer_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_drawer(tapes: list[dict[str, Any]]) -> None:
    p = settings.drawer_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(tapes, indent=2), encoding="utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(headers={"User-Agent": f"tapestry/{updater.__version__}"})
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="Tapestry", version=updater.__version__, lifespan=lifespan)


# Set by the desktop entry point so the updater can tear down the
# pywebview window before swapping the .app bundle on disk.
_quit_hook: Any = None


def register_quit_hook(fn) -> None:
    global _quit_hook
    _quit_hook = fn


class PlayBody(BaseModel):
    player_mac: str = Field(..., min_length=1)
    url: str = Field(..., min_length=1)


class PlayShowBody(BaseModel):
    player_mac: str = Field(..., min_length=1)
    urls: list[str]


class PlayerBody(BaseModel):
    player_mac: str = Field(..., min_length=1)


class VolumeBody(BaseModel):
    player_mac: str = Field(..., min_length=1)
    volume: int = Field(..., ge=0, le=100)


class SeekBody(BaseModel):
    player_mac: str = Field(..., min_length=1)
    delta: int = Field(..., ge=-3600, le=3600)


# Single backend for now. The /api/lyrion/* endpoints are kept stable for the
# current frontend; they will be superseded by /api/players/* once additional
# backends land.
_lyrion = players.get("lyrion")

# archive.org has frequent multi-hour outages (DDoS, infra incidents).
# When the upstream is down we surface a single actionable message
# instead of leaking raw httpx errors to the toast.
ARCHIVE_UNAVAILABLE_MSG = (
    "The Internet Archive is temporarily unavailable. Try again in a few minutes."
)


def _archive_http_error(e: httpx.HTTPError) -> HTTPException:
    """Map an archive.org failure to a user-friendly HTTPException.

    Upstream 5xx responses and connection-level errors collapse to 503
    with one consistent message; other httpx errors keep their raw text
    behind a 502 so genuine bugs stay diagnosable.
    """
    if isinstance(e, httpx.HTTPStatusError) and 500 <= e.response.status_code < 600:
        return HTTPException(status_code=503, detail=ARCHIVE_UNAVAILABLE_MSG)
    if isinstance(e, (httpx.ConnectError, httpx.TimeoutException)):
        return HTTPException(status_code=503, detail=ARCHIVE_UNAVAILABLE_MSG)
    return HTTPException(status_code=502, detail=f"archive.org error: {e}")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "version": updater.__version__}


# ---------- settings ----------

class SettingsBody(BaseModel):
    lyrion_url: str | None = None
    auto_check_updates: bool | None = None


@app.get("/api/settings")
async def get_settings():
    return settings.get_all()


@app.post("/api/settings")
async def update_settings(body: SettingsBody):
    return settings.update(body.model_dump(exclude_unset=True))


# ---------- self-update ----------

@app.get("/api/updates/check")
async def updates_check():
    """Poll GitHub Releases for the latest Tapestry build.

    The check is throttled by `auto_check_updates` + `last_update_check_at`
    in settings, but this endpoint always re-checks — it's the explicit
    "Check now" action. The auto-check path uses `/api/updates/auto`.
    """
    import anyio
    try:
        return await anyio.to_thread.run_sync(updater.check_latest)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"update check failed: {e}")


@app.get("/api/updates/auto")
async def updates_auto():
    """Throttled auto-check used on app boot. Skips when disabled or too recent."""
    import anyio
    if not updater.should_auto_check():
        s = settings.get_all()
        return {"skipped": True, "current": updater.__version__, "latest": s.get("last_known_latest") or ""}
    try:
        return await anyio.to_thread.run_sync(updater.check_latest)
    except Exception as e:
        # Auto-check failures shouldn't surface as toasts on startup.
        return {"skipped": True, "error": str(e), "current": updater.__version__}


class InstallUpdateBody(BaseModel):
    download_url: str = Field(..., min_length=1)


@app.post("/api/updates/install")
async def updates_install(body: InstallUpdateBody):
    """Download the DMG and hand off to a detached installer.

    Refuses in dev mode (where there's no .app bundle to swap). The
    installer waits for our PID to exit before touching disk, and we
    fire `_quit_hook` shortly after spawning it so the window goes away
    cleanly.
    """
    import anyio
    if not updater.can_install():
        raise HTTPException(
            status_code=400,
            detail="self-install is only available in the packaged Tapestry.app — download manually",
        )
    try:
        return await anyio.to_thread.run_sync(
            updater.install_update, body.download_url, _quit_hook,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"install failed: {e}")


@app.post("/api/players/rescan")
async def rescan_players():
    """Force backends with caching (e.g. DLNA) to redo discovery."""
    dlna = players.BACKENDS.get("dlna")
    if dlna and hasattr(dlna, "_last_discovery"):
        dlna._last_discovery = 0.0  # noqa: SLF001 — simple debug hook
    return {"ok": True}


@app.get("/api/lyrion/discover")
async def lyrion_discover(timeout: float = 3.0):
    """mDNS-discover Lyrion / Logitech Media Server instances on the LAN.

    Returns up to ~10 found servers; the frontend picks one (or auto-picks
    if there's exactly one) and writes it to settings.
    """
    from .players.lyrion import discover_servers
    servers = await discover_servers(timeout=max(0.5, min(8.0, timeout)))
    return {"servers": servers}


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1),
    year: str | None = None,
    fmt: str = "flac",
    source: str = "live",
    creator_only: bool = False,
    rows: int = 50,
    start: int = 0,
):
    try:
        results = await archive.search(
            app.state.http, q=q, year=year, fmt=fmt,
            source=source, creator_only=creator_only,
            rows=rows, start=start,
        )
    except httpx.HTTPError as e:
        raise _archive_http_error(e)
    return {"results": results, "count": len(results)}


@app.get("/api/artwork/{identifier}")
async def artwork_proxy(identifier: str):
    """Proxy archive.org artwork so the frontend can extract dominant colors
    via a canvas without CORS issues. Restricted to archive.org by URL
    construction (no user-controlled host).
    """
    url = f"https://archive.org/services/img/{identifier}"
    try:
        r = await app.state.http.get(url, timeout=10.0, follow_redirects=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"artwork fetch failed: {e}")
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail="artwork unavailable")
    media_type = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    return Response(
        content=r.content,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/item/{identifier}")
async def item(identifier: str):
    try:
        return await archive.get_item(app.state.http, identifier)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(status_code=404, detail="item not found")
        raise _archive_http_error(e)
    except httpx.HTTPError as e:
        raise _archive_http_error(e)


@app.get("/api/players")
async def all_players():
    """Aggregate players across every registered backend.

    Per-backend errors are surfaced in `errors` rather than failing the whole
    request — a Lyrion outage shouldn't hide the local player.
    """
    out: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    for name, backend in players.BACKENDS.items():
        try:
            out.extend(await backend.list_players(app.state.http))
        except BackendError as e:
            errors[name] = str(e)
    return {"players": out, "errors": errors}


# ---------- unified per-backend control surface ----------
# Replaces the per-backend /api/lyrion/* surface for new backends. The
# legacy /api/lyrion/* routes below remain intact for now.

class UrlBody(BaseModel):
    url: str = Field(..., min_length=1)


class UrlsBody(BaseModel):
    urls: list[str]


class DeltaBody(BaseModel):
    delta: int = Field(..., ge=-3600, le=3600)


class VolumeOnlyBody(BaseModel):
    volume: int = Field(..., ge=0, le=100)


def _backend_or_404(name: str):
    backend = players.BACKENDS.get(name)
    if not backend:
        raise HTTPException(status_code=404, detail=f"unknown backend: {name}")
    return backend


@app.get("/api/players/{backend}/{player_id}/status")
async def player_status(backend: str, player_id: str):
    b = _backend_or_404(backend)
    try:
        return await b.get_status(app.state.http, player_id)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/players/{backend}/{player_id}/play")
async def player_play(backend: str, player_id: str, body: UrlBody):
    b = _backend_or_404(backend)
    try:
        await b.play(app.state.http, player_id, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/players/{backend}/{player_id}/add")
async def player_add(backend: str, player_id: str, body: UrlBody):
    b = _backend_or_404(backend)
    try:
        await b.add(app.state.http, player_id, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/players/{backend}/{player_id}/insert")
async def player_insert(backend: str, player_id: str, body: UrlBody):
    b = _backend_or_404(backend)
    try:
        await b.insert(app.state.http, player_id, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/players/{backend}/{player_id}/play_show")
async def player_play_show(backend: str, player_id: str, body: UrlsBody):
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    b = _backend_or_404(backend)
    try:
        result = await b.play_show(app.state.http, player_id, body.urls)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/players/{backend}/{player_id}/load_show")
async def player_load_show(backend: str, player_id: str, body: UrlsBody):
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    b = _backend_or_404(backend)
    try:
        result = await b.queue_show(app.state.http, player_id, body.urls)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/players/{backend}/{player_id}/seek_by")
async def player_seek(backend: str, player_id: str, body: DeltaBody):
    b = _backend_or_404(backend)
    try:
        await b.seek(app.state.http, player_id, body.delta)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/players/{backend}/{player_id}/volume")
async def player_volume(backend: str, player_id: str, body: VolumeOnlyBody):
    b = _backend_or_404(backend)
    try:
        await b.set_volume(app.state.http, player_id, body.volume)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


# Catch-all for parameter-less actions (start/pause/stop/next/prev/eject).
# Must be declared LAST so the specific routes above win.
@app.post("/api/players/{backend}/{player_id}/{action}")
async def player_action(backend: str, player_id: str, action: str):
    b = _backend_or_404(backend)
    method = {
        "start": "start", "pause": "pause", "stop": "stop",
        "next": "next_track", "prev": "prev_track", "eject": "eject",
    }.get(action)
    if not method:
        raise HTTPException(status_code=404, detail=f"unknown action: {action}")
    try:
        await getattr(b, method)(app.state.http, player_id)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.get("/api/lyrion/players")
async def lyrion_players():
    try:
        items = await _lyrion.list_players(app.state.http)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"players": items}


@app.get("/api/lyrion/status")
async def lyrion_status(player_mac: str):
    try:
        return await _lyrion.get_status(app.state.http, player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/lyrion/play")
async def lyrion_play(body: PlayBody):
    try:
        await _lyrion.play(app.state.http, body.player_mac, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/add")
async def lyrion_add(body: PlayBody):
    try:
        await _lyrion.add(app.state.http, body.player_mac, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/insert")
async def lyrion_insert(body: PlayBody):
    try:
        await _lyrion.insert(app.state.http, body.player_mac, body.url)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/play_show")
async def lyrion_play_show(body: PlayShowBody):
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    try:
        result = await _lyrion.play_show(app.state.http, body.player_mac, body.urls)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/lyrion/load_show")
async def lyrion_load_show(body: PlayShowBody):
    """Replace the queue but do NOT start playback (user must press PLAY)."""
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    try:
        result = await _lyrion.queue_show(app.state.http, body.player_mac, body.urls)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/lyrion/start")
async def lyrion_start(body: PlayerBody):
    try:
        await _lyrion.start(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/eject")
async def lyrion_eject(body: PlayerBody):
    try:
        await _lyrion.eject(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/pause")
async def lyrion_pause(body: PlayerBody):
    try:
        await _lyrion.pause(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/stop")
async def lyrion_stop(body: PlayerBody):
    try:
        await _lyrion.stop(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/next")
async def lyrion_next(body: PlayerBody):
    try:
        await _lyrion.next_track(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/prev")
async def lyrion_prev(body: PlayerBody):
    try:
        await _lyrion.prev_track(app.state.http, body.player_mac)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/seek")
async def lyrion_seek(body: SeekBody):
    try:
        await _lyrion.seek(app.state.http, body.player_mac, body.delta)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/volume")
async def lyrion_volume(body: VolumeBody):
    try:
        await _lyrion.set_volume(app.state.http, body.player_mac, body.volume)
    except BackendError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


# ---------- tape drawer (saved cassettes) ----------

class TapeBody(BaseModel):
    identifier: str = Field(..., min_length=1)
    title: str = ""
    creator: str = ""
    date: str = ""
    track_count: int = 0
    band_color: str = ""
    label_color: str = ""
    ink_color: str = ""
    font: str = ""
    # Mix-tape mode: a user-curated playlist saved as a tape. Tracks are
    # embedded so loading doesn't need to refetch from archive.org.
    is_mix: bool = False
    tracks: list[dict[str, Any]] = Field(default_factory=list)
    image_url: str = ""


@app.get("/api/drawer")
async def drawer_list():
    return {"tapes": _load_drawer()}


@app.post("/api/drawer")
async def drawer_save(body: TapeBody):
    with _drawer_lock:
        tapes = [t for t in _load_drawer() if t.get("identifier") != body.identifier]
        entry = body.model_dump()
        entry["saved_at"] = int(time.time() * 1000)
        tapes.insert(0, entry)
        _save_drawer(tapes)
    return {"ok": True, "tape": entry}


@app.delete("/api/drawer/{identifier}")
async def drawer_delete(identifier: str):
    with _drawer_lock:
        tapes = [t for t in _load_drawer() if t.get("identifier") != identifier]
        _save_drawer(tapes)
    return {"ok": True}


# ---------- tape sharing (.tape files + share-link blobs) ----------
# A "tape" is small enough to serialize whole: ~200 bytes for a grabbed
# archive.org tape (metadata only — tracks resolve from the identifier),
# ~2-4 KB for a mix tape with 10-20 inline tracks. Sharable two ways:
#
#   1. URL blob (.../?import=<base64-utf8(json)>) — fits in a copy/paste
#      link for grabbed tapes and small mixes. Cover bytes excluded so the
#      URL stays manageable.
#   2. `.tape` file (`application/x-tapestry-tape`) — same JSON, but with
#      the mix-tape cover image embedded as base64 so it travels with the
#      tape. Imported via the drawer "Import tape" button or drag-drop
#      onto the drawer modal.

def _slugify_for_filename(s: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", s or "").strip("-")
    return cleaned or "tape"


def _embed_cover(image_url: str) -> dict[str, str] | None:
    """Read the mix-tape cover off disk and base64-encode it for embedding.

    Only handles in-app covers (`/covers/<filename>`); external URLs travel
    by reference and don't need embedding. Returns None on any IO or
    extension problem — covers are nice-to-have, not load-bearing.
    """
    if not image_url or not image_url.startswith("/covers/"):
        return None
    name = image_url[len("/covers/"):]
    if "/" in name or ".." in name:  # path traversal guard — names are random tokens
        return None
    path = _COVERS_DIR / name
    if not path.is_file():
        return None
    mime = _COVER_MIME_BY_EXT.get(path.suffix.lower())
    if not mime:
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    return {"mime": mime, "data_b64": base64.b64encode(data).decode("ascii")}


def _tape_export_dict(tape: dict[str, Any], embed_cover: bool = True) -> dict[str, Any]:
    body = {k: tape.get(k) for k in _TAPE_EXPORT_FIELDS if k in tape}
    cover = _embed_cover(tape.get("image_url", "")) if embed_cover else None
    return {
        "_format": TAPE_FORMAT_NAME,
        "_version": TAPE_FORMAT_VERSION,
        "_exported_at": int(time.time() * 1000),
        "_exporter": f"tapestry/{updater.__version__}",
        "tape": body,
        "cover": cover,
    }


@app.get("/api/tape/{identifier}/export")
async def tape_export(identifier: str, mode: str = "json", cover: str = "embed"):
    """Export a tape as JSON.

    `mode=file` adds a `Content-Disposition: attachment` header so the
    browser saves it as `<title>.tape`. `cover=skip` omits the embedded
    base64 cover (used for URL shares to keep the link short).
    """
    with _drawer_lock:
        tapes = _load_drawer()
        match = next((t for t in tapes if t.get("identifier") == identifier), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"no tape with identifier {identifier}")
    payload = _tape_export_dict(match, embed_cover=(cover != "skip"))
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    if mode == "file":
        filename = f"{_slugify_for_filename(match.get('title') or identifier)}.tape"
        return Response(
            content=body,
            media_type="application/x-tapestry-tape",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )
    return JSONResponse(content=payload)


class ImportTapeBody(BaseModel):
    payload: dict[str, Any]


@app.get("/api/tape/pending-open")
async def tape_pending_open() -> dict[str, Any]:
    """Pop one queued open-file payload (or None) for the frontend to show.

    Returns at most one item per call so the import-preview modal handles
    them sequentially — if the user double-clicked several .tape files,
    the frontend polls again after each confirm/cancel.
    """
    with _pending_imports_lock:
        if not _pending_imports:
            return {"item": None}
        item = _pending_imports.pop(0)
    return {"item": item}


@app.post("/api/tape/import")
async def tape_import(body: ImportTapeBody):
    p = body.payload or {}
    if p.get("_format") != TAPE_FORMAT_NAME:
        raise HTTPException(status_code=400, detail="not a tapestry-tape document")
    if int(p.get("_version") or 0) > TAPE_FORMAT_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"tape format v{p.get('_version')} is newer than this Tapestry can read — upgrade?",
        )
    tape = p.get("tape") or {}
    src_id = tape.get("identifier")
    if not src_id:
        raise HTTPException(status_code=400, detail="tape missing identifier")

    is_mix = bool(tape.get("is_mix"))
    # Mix tape identifiers are local-random; collisions between friends are
    # astronomically unlikely but conceptually possible. Always remint on
    # import and record the source for breadcrumbs. Grabbed tapes keep
    # their archive.org identifier so loading still resolves.
    new_id = f"mix:{secrets.token_urlsafe(6)}" if is_mix else src_id

    # Re-house embedded cover (if any) under our own /covers/ tree.
    image_url = (tape.get("image_url") or "") if not is_mix else ""
    cover = p.get("cover")
    if cover and isinstance(cover, dict) and cover.get("data_b64"):
        ext = _COVER_EXT_BY_MIME.get(cover.get("mime") or "", ".jpg")
        try:
            data = base64.b64decode(cover["data_b64"], validate=True)
        except (binascii.Error, ValueError):
            data = None
        if data and len(data) <= _COVER_MAX_BYTES:
            name = f"{secrets.token_urlsafe(10)}{ext}"
            try:
                (_COVERS_DIR / name).write_bytes(data)
                image_url = f"/covers/{name}"
            except OSError:
                pass

    # Validate inline track URLs at the structural level — we trust the
    # archive.org host but refuse anything obviously not an http(s) URL.
    raw_tracks = tape.get("tracks") or []
    tracks: list[dict[str, Any]] = []
    if is_mix and isinstance(raw_tracks, list):
        for t in raw_tracks:
            if not isinstance(t, dict):
                continue
            url = (t.get("url") or "").strip()
            if not url or not url.lower().startswith(("http://", "https://")):
                continue
            tracks.append({
                "url": url,
                "title": t.get("title") or "",
                "name": t.get("name") or "",
                "length": t.get("length") or "",
                "lengthSec": int(t.get("lengthSec") or 0),
                "format": t.get("format") or "",
                "source_id": t.get("source_id") or "",
                "source_title": t.get("source_title") or "",
                "source_creator": t.get("source_creator") or "",
            })

    entry: dict[str, Any] = {
        "identifier": new_id,
        "title": str(tape.get("title") or ""),
        "creator": str(tape.get("creator") or ""),
        "date": str(tape.get("date") or ""),
        "track_count": int(tape.get("track_count") or (len(tracks) if is_mix else 0)),
        "band_color": str(tape.get("band_color") or ""),
        "label_color": str(tape.get("label_color") or ""),
        "ink_color": str(tape.get("ink_color") or ""),
        "font": str(tape.get("font") or ""),
        "is_mix": is_mix,
        "tracks": tracks,
        "image_url": image_url,
        "saved_at": int(time.time() * 1000),
    }
    if is_mix:
        entry["imported_from"] = src_id

    with _drawer_lock:
        tapes = [t for t in _load_drawer() if t.get("identifier") != entry["identifier"]]
        tapes.insert(0, entry)
        _save_drawer(tapes)
    return {"ok": True, "tape": entry}


# ---------- mix tape covers ----------
# Constants live at the top of the file; this section just hosts the
# upload endpoint and the /covers static mount.

@app.post("/api/mix-cover")
async def upload_cover(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _COVER_EXTS:
        raise HTTPException(status_code=400, detail=f"unsupported image format ({ext or 'none'})")
    contents = await file.read()
    if len(contents) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="cover too large (max 6 MB)")
    name = f"{secrets.token_urlsafe(10)}{ext}"
    (_COVERS_DIR / name).write_bytes(contents)
    return {"url": f"/covers/{name}", "size": len(contents)}


app.mount("/covers", StaticFiles(directory=str(_COVERS_DIR)), name="covers")


# Serve frontend last so /api/* routes still match first.
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
