"""DLNA / UPnP MediaRenderer backend.

Discovers AVTransport renderers on the local network via SSDP and drives
them through the standard UPnP control points. DLNA itself has no native
queue, so Tapestry holds the queue server-side per device and advances on
track-end (detected by the frontend's status poll).

Heavy SSDP / aiohttp imports are deferred to first use so the app still
boots if `async-upnp-client` isn't installed yet.
"""
from __future__ import annotations

import asyncio
import time
from datetime import timedelta
from typing import Any

import httpx

from .base import BackendError

DISCOVERY_TIMEOUT = 4
CACHE_TTL = 30.0


def _parse_hms(s: str) -> int:
    """Parse a UPnP duration string ('HH:MM:SS' or 'H:MM:SS') to seconds.
    Returns 0 for empty / NOT_IMPLEMENTED / unparseable values."""
    if not s:
        return 0
    s = s.strip()
    if not s or "NOT_IMPL" in s.upper():
        return 0
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(float(parts[1]))
        return int(float(parts[0]))
    except (ValueError, TypeError):
        return 0


class DlnaBackend:
    name = "dlna"

    def __init__(self) -> None:
        self._devices: dict[str, Any] = {}            # udn -> DmrDevice
        self._meta: dict[str, dict[str, Any]] = {}     # udn -> {name, model}
        self._queues: dict[str, dict[str, Any]] = {}   # udn -> {urls, idx, was_playing}
        self._last_discovery = 0.0
        self._lock = asyncio.Lock()
        self._lib_error: str | None = None

    def _load_lib(self):
        from async_upnp_client.aiohttp import AiohttpRequester
        from async_upnp_client.client_factory import UpnpFactory
        from async_upnp_client.profiles.dlna import DmrDevice
        from async_upnp_client.search import async_search
        return AiohttpRequester, UpnpFactory, DmrDevice, async_search

    async def _discover(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now - self._last_discovery < CACHE_TTL and self._devices:
                return
            try:
                AiohttpRequester, UpnpFactory, DmrDevice, async_search = self._load_lib()
            except ImportError as e:
                self._lib_error = (
                    f"async-upnp-client is not installed ({e}); "
                    "run `pip install -r requirements.txt`"
                )
                return

            requester = AiohttpRequester()
            factory = UpnpFactory(requester)
            new_devices: dict[str, Any] = {}
            new_meta: dict[str, dict[str, Any]] = {}

            async def cb(headers):
                try:
                    location = headers.get("LOCATION") or headers.get("location")
                    if not location:
                        return
                    upnp_dev = await factory.async_create_device(location)
                    if "MediaRenderer" not in upnp_dev.device_type:
                        return
                    udn = upnp_dev.udn
                    if udn in new_devices:
                        return
                    new_devices[udn] = DmrDevice(upnp_dev, event_handler=None)
                    new_meta[udn] = {
                        "name": upnp_dev.friendly_name or udn,
                        "model": upnp_dev.model_name or "",
                    }
                except Exception:
                    # Ignore any single-device discovery hiccup; don't poison the run.
                    pass

            try:
                await async_search(
                    search_target="urn:schemas-upnp-org:device:MediaRenderer:1",
                    timeout=DISCOVERY_TIMEOUT,
                    async_callback=cb,
                )
            except Exception as e:
                self._lib_error = f"DLNA discovery failed: {e}"

            # Preserve previously-known queues across rediscovery.
            self._devices = new_devices
            self._meta = new_meta
            self._last_discovery = now

    async def list_players(self, client: httpx.AsyncClient) -> list[dict[str, Any]]:
        await self._discover()
        if self._lib_error:
            # Surface library/discovery problems so the frontend banner can show
            # them instead of silently hiding the DLNA backend.
            raise BackendError(self._lib_error)
        out = []
        for udn, _dev in self._devices.items():
            meta = self._meta.get(udn, {})
            out.append({
                "backend": self.name,
                "id": udn,
                "mac": "",
                "name": meta.get("name") or udn,
                "model": meta.get("model") or "",
                "power": True,
                "connected": True,
                "current_track": "",
            })
        return out

    async def _device(self, udn: str):
        """Return the cached DmrDevice for `udn`, kicking off a fresh
        discovery if it's missing — typically the case right after a server
        restart, when the in-memory cache has been wiped but the frontend
        keeps using the same selected player."""
        dev = self._devices.get(udn)
        if dev:
            return dev
        # Force-bypass the cache TTL so we don't return immediately.
        self._last_discovery = 0.0
        await self._discover()
        dev = self._devices.get(udn)
        if not dev:
            raise BackendError(f"DLNA device not found: {udn} (try a rescan)")
        return dev

    def _queue(self, udn: str) -> dict[str, Any]:
        return self._queues.setdefault(udn, {"urls": [], "idx": 0, "was_playing": False})

    @staticmethod
    def _state_to_mode(state: str | None) -> str:
        return {
            "PLAYING": "play",
            "TRANSITIONING": "play",
            "PAUSED_PLAYBACK": "pause",
            "PAUSED_RECORDING": "pause",
        }.get(state or "", "stop")

    async def _set_and_play(self, dev, url: str) -> None:
        await dev.async_set_transport_uri(url, "Tapestry", None)
        await dev.async_play()

    async def get_status(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        try:
            await dev.async_update()
        except Exception as e:
            raise BackendError(f"DLNA status: {e}") from e

        mode = self._state_to_mode(getattr(dev, "transport_state", None))
        q = self._queue(player_id)

        # Auto-advance when a track ends, using the polling status loop as a
        # heartbeat. We treat PLAYING -> STOPPED with more queue items as the
        # signal; user-initiated stop sets `was_playing` False so we don't
        # trigger here.
        if q["was_playing"] and mode == "stop" and q["idx"] + 1 < len(q["urls"]):
            q["idx"] += 1
            try:
                await self._set_and_play(dev, q["urls"][q["idx"]])
                mode = "play"
            except Exception:
                pass
        q["was_playing"] = (mode == "play")

        # Position needs an explicit GetPositionInfo SOAP call on most
        # renderers; async_update() only refreshes transport state, leaving
        # media_position_in_seconds frozen at whatever the last event
        # delivered (often "2 seconds in" right after Play). Without this
        # the deck counter just sticks.
        position, duration = 0, 0
        try:
            avt = getattr(dev, "av_transport", None)
            if avt is None and hasattr(dev, "profile_device"):
                avt = dev.profile_device.service("urn:upnp-org:serviceId:AVTransport")
            if avt is not None:
                action = avt.action("GetPositionInfo")
                result = await action.async_call(InstanceID=0)
                position = _parse_hms(str(result.get("RelTime", "")))
                duration = _parse_hms(str(result.get("TrackDuration", "")))
        except Exception:
            try:
                duration = int(getattr(dev, "media_duration_in_seconds", 0) or 0)
            except Exception:
                duration = 0
            try:
                position = int(getattr(dev, "media_position_in_seconds", 0) or 0)
            except Exception:
                position = 0

        cur_url = q["urls"][q["idx"]] if q["urls"] else ""
        return {
            "mode": mode,
            "power": True,
            "volume": 100,
            "time": position,
            "duration": duration,
            "playlist_index": q["idx"] if q["urls"] else None,
            "playlist_tracks": len(q["urls"]),
            "current": ({
                "title": getattr(dev, "media_title", "") or "",
                "artist": getattr(dev, "media_artist", "") or "",
                "album": "",
                "url": cur_url,
                "duration": duration,
            } if cur_url else None),
        }

    async def play(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        q = self._queue(player_id)
        q["urls"] = [url]
        q["idx"] = 0
        q["was_playing"] = True
        try:
            await self._set_and_play(dev, url)
        except Exception as e:
            raise BackendError(f"DLNA play: {e}") from e
        return {}

    async def add(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        q = self._queue(player_id)
        q["urls"].append(url)
        if len(q["urls"]) == 1:
            return await self.play(client, player_id, url)
        return {}

    async def insert(self, client: httpx.AsyncClient, player_id: str, url: str) -> dict[str, Any]:
        q = self._queue(player_id)
        q["urls"].insert(min(q["idx"] + 1, len(q["urls"])), url)
        return {}

    async def play_show(self, client: httpx.AsyncClient, player_id: str, urls: list[str]) -> dict[str, Any]:
        if not urls:
            return {}
        dev = await self._device(player_id)
        q = self._queue(player_id)
        q["urls"] = list(urls)
        q["idx"] = 0
        q["was_playing"] = True
        try:
            await self._set_and_play(dev, urls[0])
        except Exception as e:
            raise BackendError(f"DLNA play_show: {e}") from e
        return {"queued": len(urls)}

    async def queue_show(self, client: httpx.AsyncClient, player_id: str, urls: list[str]) -> dict[str, Any]:
        if not urls:
            return {}
        dev = await self._device(player_id)
        q = self._queue(player_id)
        q["urls"] = list(urls)
        q["idx"] = 0
        q["was_playing"] = False
        try:
            try:
                await dev.async_stop()
            except Exception:
                pass
            await dev.async_set_transport_uri(urls[0], "Tapestry", None)
        except Exception as e:
            raise BackendError(f"DLNA load_show: {e}") from e
        return {"queued": len(urls), "playing": False}

    async def start(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        self._queue(player_id)["was_playing"] = True
        try:
            await dev.async_play()
        except Exception as e:
            raise BackendError(f"DLNA start: {e}") from e
        return {}

    async def pause(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        self._queue(player_id)["was_playing"] = False
        try:
            await dev.async_pause()
        except Exception as e:
            raise BackendError(f"DLNA pause: {e}") from e
        return {}

    async def stop(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        self._queue(player_id)["was_playing"] = False
        try:
            await dev.async_stop()
        except Exception as e:
            raise BackendError(f"DLNA stop: {e}") from e
        return {}

    async def next_track(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        q = self._queue(player_id)
        if q["idx"] + 1 >= len(q["urls"]):
            return {}
        q["idx"] += 1
        try:
            await self._set_and_play(dev, q["urls"][q["idx"]])
            q["was_playing"] = True
        except Exception as e:
            raise BackendError(f"DLNA next: {e}") from e
        return {}

    async def prev_track(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        q = self._queue(player_id)
        if q["idx"] <= 0:
            return {}
        q["idx"] -= 1
        try:
            await self._set_and_play(dev, q["urls"][q["idx"]])
            q["was_playing"] = True
        except Exception as e:
            raise BackendError(f"DLNA prev: {e}") from e
        return {}

    async def eject(self, client: httpx.AsyncClient, player_id: str) -> dict[str, Any]:
        dev = await self._device(player_id)
        q = self._queue(player_id)
        q["urls"] = []
        q["idx"] = 0
        q["was_playing"] = False
        try:
            await dev.async_stop()
        except Exception:
            pass
        return {"ejected": True}

    async def set_volume(self, client: httpx.AsyncClient, player_id: str, volume: int) -> dict[str, Any]:
        dev = await self._device(player_id)
        try:
            await dev.async_set_volume_level(max(0, min(100, int(volume))) / 100.0)
        except Exception as e:
            raise BackendError(f"DLNA volume: {e}") from e
        return {}

    async def seek(self, client: httpx.AsyncClient, player_id: str, delta_seconds: int) -> dict[str, Any]:
        dev = await self._device(player_id)
        try:
            # Try relative seek; fall back to absolute (read-then-add) for renderers
            # that only implement REL_TIME at non-relative offsets.
            try:
                await dev.async_seek_rel_time(timedelta(seconds=int(delta_seconds)))
                return {}
            except Exception:
                pass
            await dev.async_update()
            pos = int(getattr(dev, "media_position_in_seconds", 0) or 0)
            await dev.async_seek_abs_time(timedelta(seconds=max(0, pos + int(delta_seconds))))
        except Exception as e:
            raise BackendError(f"DLNA seek: {e}") from e
        return {}
