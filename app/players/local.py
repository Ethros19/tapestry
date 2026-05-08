"""Local-device backend: playback happens in the page itself.

The server's role here is purely to advertise a synthetic "This Mac" player
in `/api/players`. All actual playback control lives in the frontend, which
drives an HTML5 `<audio>` element directly. Methods here exist so the
backend satisfies the `PlayerBackend` Protocol; they are no-ops the
frontend never calls.
"""
from __future__ import annotations

from typing import Any

import httpx


class LocalBackend:
    name = "local"

    async def list_players(self, client: httpx.AsyncClient) -> list[dict[str, Any]]:
        return [{
            "backend": self.name,
            "id": "this-device",
            "mac": "",
            "name": "This Mac",
            "model": "in-app playback",
            "power": True,
            "connected": True,
            "current_track": "",
        }]

    async def get_status(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        return {"mode": "stop", "current": None}

    async def _noop(self, *_: Any, **__: Any) -> dict[str, Any]:
        return {"ok": True, "note": "local playback is driven by the client"}

    play = _noop
    add = _noop
    insert = _noop
    play_show = _noop
    queue_show = _noop
    start = _noop
    pause = _noop
    stop = _noop
    next_track = _noop
    prev_track = _noop
    eject = _noop
    set_volume = _noop
    seek = _noop
