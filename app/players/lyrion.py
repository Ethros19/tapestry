"""Lyrion Music Server JSON-RPC backend.

All commands go through `slim.request` with the shape:
    {"id":1,"method":"slim.request","params":["<player_mac>", [<cmd>, <args>...]]}

Also exports `discover_servers()` — a small async helper that uses mDNS
(LMS advertises `_slimproto._tcp` on port 3483) to find LMS instances on
the LAN so the user doesn't have to type the JSON-RPC URL by hand.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .. import settings
from .base import BackendError


# LMS announces a Squeezebox-protocol service over mDNS. We use only the
# host from that record and assume the conventional 9000 JSON-RPC port on
# the same machine — this is what every Squeezebox / Squeezelite client
# does too, so it's a safe assumption.
_LMS_SERVICE_TYPE = "_slimproto._tcp.local."
_LMS_DEFAULT_PORT = 9000


async def discover_servers(timeout: float = 3.0) -> list[dict[str, Any]]:
    """Browse mDNS for LMS instances.

    Returns a list of `{name, hostname, host, port, jsonrpc_url}` dicts.
    Empty list on failure or no responses (no exception — discovery is
    best-effort and the user can always type a URL by hand).
    """
    try:
        from zeroconf import IPVersion
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf
    except ImportError:
        return []

    found: dict[str, dict[str, Any]] = {}

    async def resolve(aiozc, service_type: str, name: str) -> None:
        info = AsyncServiceInfo(service_type, name)
        try:
            ok = await info.async_request(aiozc.zeroconf, 2000)
        except Exception:
            return
        if not ok:
            return
        try:
            addrs = info.parsed_addresses(IPVersion.V4Only)
        except Exception:
            addrs = []
        host = addrs[0] if addrs else ""
        hostname = (info.server or host).rstrip(".") if (info.server or host) else host
        if not (host or hostname):
            return
        # Prefer the human-readable hostname for the URL — works on the
        # same LAN via mDNS, so http://AntiVort.local:9000/jsonrpc.js
        # rather than the raw IP.
        target = hostname or host
        instance_name = name.split(f".{service_type}")[0] if name.endswith(service_type) else name
        found[name] = {
            "name": instance_name,
            "hostname": hostname,
            "host": host,
            "port": _LMS_DEFAULT_PORT,
            "jsonrpc_url": f"http://{target}:{_LMS_DEFAULT_PORT}/jsonrpc.js",
        }

    aiozc = AsyncZeroconf()
    pending: list[asyncio.Task] = []

    def on_change(_zc, service_type: str, name: str, state_change) -> None:
        # `state_change` is a ServiceStateChange enum; .name is "Added" etc.
        if getattr(state_change, "name", "") != "Added":
            return
        pending.append(asyncio.ensure_future(resolve(aiozc, service_type, name)))

    browser = AsyncServiceBrowser(aiozc.zeroconf, [_LMS_SERVICE_TYPE], handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        await browser.async_cancel()
        await aiozc.async_close()

    return list(found.values())


async def _rpc(client: httpx.AsyncClient, player: str, command: list[Any]) -> Any:
    url = settings.lyrion_url()
    payload = {"id": 1, "method": "slim.request", "params": [player, command]}
    try:
        r = await client.post(url, json=payload, timeout=8.0)
    except httpx.HTTPError as e:
        raise BackendError(f"Lyrion unreachable at {url}: {e}") from e
    if r.status_code != 200:
        raise BackendError(f"Lyrion returned {r.status_code}: {r.text[:200]}")
    body = r.json()
    if "error" in body and body["error"]:
        raise BackendError(f"Lyrion error: {body['error']}")
    return body.get("result", {})


class LyrionBackend:
    name = "lyrion"

    async def list_players(self, client: httpx.AsyncClient) -> list[dict[str, Any]]:
        result = await _rpc(client, "", ["players", "0", "100"])
        players = result.get("players_loop", []) if isinstance(result, dict) else []
        out: list[dict[str, Any]] = []
        for p in players:
            mac = p.get("playerid") or p.get("playerindex") or ""
            name = p.get("name") or mac
            current = ""
            try:
                status = await _rpc(client, mac, ["status", "-", "1"])
                loop = status.get("playlist_loop", []) if isinstance(status, dict) else []
                if loop:
                    track = loop[0]
                    bits = [b for b in (track.get("artist"), track.get("title")) if b]
                    current = " — ".join(bits)
            except BackendError:
                current = ""
            out.append({
                "backend": self.name,
                "id": mac,
                "mac": mac,  # legacy alias for current frontend
                "name": name,
                "model": p.get("modelname") or p.get("model", ""),
                "power": bool(p.get("power", 0)),
                "connected": bool(p.get("connected", 1)),
                "current_track": current,
            })
        return out

    async def get_status(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        result = await _rpc(client, player_id, ["status", "-", "1", "tags:adKl"])
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

    async def play(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["playlist", "play", url])

    async def add(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["playlist", "add", url])

    async def insert(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["playlist", "insert", url])

    async def play_show(self, client: httpx.AsyncClient, player_id: str, urls: list[str]) -> dict[str, Any]:
        if not urls:
            return {}
        await self.play(client, player_id, urls[0])
        for u in urls[1:]:
            await self.add(client, player_id, u)
        return {"queued": len(urls)}

    async def queue_show(self, client: httpx.AsyncClient, player_id: str, urls: list[str]) -> dict[str, Any]:
        if not urls:
            return {}
        await _rpc(client, player_id, ["stop"])
        await _rpc(client, player_id, ["playlist", "clear"])
        for u in urls:
            await _rpc(client, player_id, ["playlist", "add", u])
        return {"queued": len(urls), "playing": False}

    async def start(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["play"])

    async def pause(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["pause"])

    async def stop(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["stop"])

    async def next_track(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["playlist", "jump", "+1"])

    async def prev_track(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return await _rpc(client, player_id, ["playlist", "jump", "-1"])

    async def eject(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        await _rpc(client, player_id, ["stop"])
        await _rpc(client, player_id, ["playlist", "clear"])
        return {"ejected": True}

    async def set_volume(self, client: httpx.AsyncClient, player_id: str, volume: int) -> dict[str, Any]:
        volume = max(0, min(100, int(volume)))
        return await _rpc(client, player_id, ["mixer", "volume", str(volume)])

    async def seek(self, client: httpx.AsyncClient, player_id: str, delta_seconds: int) -> dict[str, Any]:
        # Lyrion `time` accepts a relative seek with explicit sign.
        sign = "+" if delta_seconds >= 0 else ""
        return await _rpc(client, player_id, ["time", f"{sign}{int(delta_seconds)}"])
