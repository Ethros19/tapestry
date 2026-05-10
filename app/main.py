"""FastAPI app: archive.org search → multi-backend playback bridge."""
from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import httpx
import secrets
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import archive, players, settings
from .players import BackendError

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
_drawer_lock = Lock()

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
    app.state.http = httpx.AsyncClient(headers={"User-Agent": "tapestry/1.0"})
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="Tapestry", version="1.1.4", lifespan=lifespan)


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


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True}


# ---------- settings ----------

class SettingsBody(BaseModel):
    lyrion_url: str | None = None


@app.get("/api/settings")
async def get_settings():
    return settings.get_all()


@app.post("/api/settings")
async def update_settings(body: SettingsBody):
    return settings.update(body.model_dump(exclude_unset=True))


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
        raise HTTPException(status_code=502, detail=f"archive.org error: {e}")
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
        raise HTTPException(status_code=502, detail=f"archive.org error: {e}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"archive.org error: {e}")


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


# ---------- mix tape covers ----------

_COVERS_DIR = settings.data_dir() / "mix-covers"
_COVERS_DIR.mkdir(parents=True, exist_ok=True)
_COVER_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
_COVER_MAX_BYTES = 6 * 1024 * 1024  # 6 MB


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
