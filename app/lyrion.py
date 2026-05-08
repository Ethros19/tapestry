"""Lyrion Music Server JSON-RPC client.

All commands go through `slim.request` with the shape:
    {"id":1,"method":"slim.request","params":["<player_mac>", [<cmd>, <args>...]]}
"""
from __future__ import annotations

import os
from typing import Any

import httpx

LYRION_URL = os.environ.get("LYRION_URL", "http://localhost:9000/jsonrpc.js")


class LyrionError(RuntimeError):
    """Raised when the Lyrion server is unreachable or returns an error."""


async def _rpc(client: httpx.AsyncClient, player: str, command: list[Any]) -> Any:
    payload = {"id": 1, "method": "slim.request", "params": [player, command]}
    try:
        r = await client.post(LYRION_URL, json=payload, timeout=8.0)
    except httpx.HTTPError as e:
        raise LyrionError(f"Lyrion unreachable at {LYRION_URL}: {e}") from e
    if r.status_code != 200:
        raise LyrionError(f"Lyrion returned {r.status_code}: {r.text[:200]}")
    body = r.json()
    if "error" in body and body["error"]:
        raise LyrionError(f"Lyrion error: {body['error']}")
    return body.get("result", {})


async def list_players(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Return [{mac, name, model, power, current_track}, ...]."""
    result = await _rpc(client, "", ["players", "0", "100"])
    players = result.get("players_loop", []) if isinstance(result, dict) else []
    out: list[dict[str, Any]] = []
    for p in players:
        mac = p.get("playerid") or p.get("playerindex") or ""
        name = p.get("name") or mac
        # Best-effort current track lookup.
        current = ""
        try:
            status = await _rpc(client, mac, ["status", "-", "1"])
            loop = status.get("playlist_loop", []) if isinstance(status, dict) else []
            if loop:
                track = loop[0]
                bits = [b for b in (track.get("artist"), track.get("title")) if b]
                current = " — ".join(bits)
        except LyrionError:
            current = ""
        out.append({
            "mac": mac,
            "name": name,
            "model": p.get("modelname") or p.get("model", ""),
            "power": bool(p.get("power", 0)),
            "connected": bool(p.get("connected", 1)),
            "current_track": current,
        })
    return out


async def get_status(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    """Return a compact playback status for the given player."""
    result = await _rpc(client, player_mac, ["status", "-", "1", "tags:adKl"])
    if not isinstance(result, dict):
        return {}
    loop = result.get("playlist_loop", [])
    track = loop[0] if loop else {}
    return {
        "mode": result.get("mode", ""),
        "power": bool(result.get("power", 0)),
        "volume": result.get("mixer volume", 0),
        "time": result.get("time", 0),
        "duration": result.get("duration", 0),
        "playlist_index": result.get("playlist_cur_index"),
        "playlist_tracks": result.get("playlist_tracks", 0),
        "current": {
            "title": track.get("title", ""),
            "artist": track.get("artist", ""),
            "album": track.get("album", ""),
            "url": track.get("url", ""),
            "duration": track.get("duration"),
        } if track else None,
    }


async def play(client: httpx.AsyncClient, player_mac: str, url: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["playlist", "play", url])


async def add(client: httpx.AsyncClient, player_mac: str, url: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["playlist", "add", url])


async def insert(client: httpx.AsyncClient, player_mac: str, url: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["playlist", "insert", url])


async def play_show(client: httpx.AsyncClient, player_mac: str, urls: list[str]) -> dict[str, Any]:
    """Play first URL, then queue the rest in order."""
    if not urls:
        return {}
    await play(client, player_mac, urls[0])
    for u in urls[1:]:
        await add(client, player_mac, u)
    return {"queued": len(urls)}


async def pause(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["pause"])


async def stop(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["stop"])


async def start(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    """Start/resume playback of the currently loaded queue."""
    return await _rpc(client, player_mac, ["play"])


async def next_track(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["playlist", "jump", "+1"])


async def prev_track(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    return await _rpc(client, player_mac, ["playlist", "jump", "-1"])


async def queue_show(
    client: httpx.AsyncClient, player_mac: str, urls: list[str]
) -> dict[str, Any]:
    """Replace the queue with these URLs but do NOT start playback."""
    if not urls:
        return {}
    await _rpc(client, player_mac, ["stop"])
    await _rpc(client, player_mac, ["playlist", "clear"])
    for u in urls:
        await _rpc(client, player_mac, ["playlist", "add", u])
    return {"queued": len(urls), "playing": False}


async def eject(client: httpx.AsyncClient, player_mac: str) -> dict[str, Any]:
    """Stop playback and clear the queue."""
    await _rpc(client, player_mac, ["stop"])
    await _rpc(client, player_mac, ["playlist", "clear"])
    return {"ejected": True}


async def set_volume(client: httpx.AsyncClient, player_mac: str, volume: int) -> dict[str, Any]:
    volume = max(0, min(100, int(volume)))
    return await _rpc(client, player_mac, ["mixer", "volume", str(volume)])
