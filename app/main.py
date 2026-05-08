"""FastAPI app: archive.org search → Lyrion playback bridge."""
from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import archive, lyrion

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DRAWER_FILE = DATA_DIR / "drawer.json"
_drawer_lock = Lock()


def _load_drawer() -> list[dict[str, Any]]:
    if not DRAWER_FILE.exists():
        return []
    try:
        return json.loads(DRAWER_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_drawer(tapes: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DRAWER_FILE.write_text(json.dumps(tapes, indent=2), encoding="utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(headers={"User-Agent": "lyrion-archive-bridge/0.1"})
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="Tapestry", version="1.0.0", lifespan=lifespan)


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


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True}


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1),
    year: str | None = None,
    fmt: str = "flac",
    rows: int = 50,
    start: int = 0,
):
    try:
        results = await archive.search(app.state.http, q=q, year=year, fmt=fmt, rows=rows, start=start)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"archive.org error: {e}")
    return {"results": results, "count": len(results)}


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


def _wrap_lyrion(coro):
    """Run a Lyrion coroutine and translate connection errors to 502."""
    async def _run():
        try:
            return await coro
        except lyrion.LyrionError as e:
            return JSONResponse(status_code=502, content={"detail": str(e)})
    return _run()


@app.get("/api/lyrion/players")
async def players():
    try:
        items = await lyrion.list_players(app.state.http)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"players": items}


@app.get("/api/lyrion/status")
async def status(player_mac: str):
    try:
        return await lyrion.get_status(app.state.http, player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/lyrion/play")
async def play(body: PlayBody):
    try:
        await lyrion.play(app.state.http, body.player_mac, body.url)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/add")
async def add(body: PlayBody):
    try:
        await lyrion.add(app.state.http, body.player_mac, body.url)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/insert")
async def insert(body: PlayBody):
    try:
        await lyrion.insert(app.state.http, body.player_mac, body.url)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/play_show")
async def play_show(body: PlayShowBody):
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    try:
        result = await lyrion.play_show(app.state.http, body.player_mac, body.urls)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/lyrion/load_show")
async def load_show(body: PlayShowBody):
    """Replace the queue but do NOT start playback (user must press PLAY)."""
    if not body.urls:
        raise HTTPException(status_code=400, detail="urls is empty")
    try:
        result = await lyrion.queue_show(app.state.http, body.player_mac, body.urls)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, **result}


@app.post("/api/lyrion/start")
async def start(body: PlayerBody):
    """Resume / start playback of the current queue."""
    try:
        await lyrion.start(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/eject")
async def eject(body: PlayerBody):
    """Stop and clear the queue (eject the tape)."""
    try:
        await lyrion.eject(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
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


@app.post("/api/lyrion/pause")
async def pause(body: PlayerBody):
    try:
        await lyrion.pause(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/stop")
async def stop(body: PlayerBody):
    try:
        await lyrion.stop(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/next")
async def next_track(body: PlayerBody):
    try:
        await lyrion.next_track(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/prev")
async def prev_track(body: PlayerBody):
    try:
        await lyrion.prev_track(app.state.http, body.player_mac)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


@app.post("/api/lyrion/volume")
async def set_volume(body: VolumeBody):
    try:
        await lyrion.set_volume(app.state.http, body.player_mac, body.volume)
    except lyrion.LyrionError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}


# Serve frontend last so /api/* routes still match first.
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
