"""Playback backends registry.

Each backend implements the `PlayerBackend` Protocol from `.base`. Backends
are registered here at import time; the FastAPI layer routes commands by
backend name.
"""
from __future__ import annotations

from .base import BackendError, PlayerBackend
from .dlna import DlnaBackend
from .local import LocalBackend
from .lyrion import LyrionBackend

BACKENDS: dict[str, PlayerBackend] = {
    "lyrion": LyrionBackend(),
    "local": LocalBackend(),
    "dlna": DlnaBackend(),
}


def get(name: str) -> PlayerBackend:
    try:
        return BACKENDS[name]
    except KeyError as e:
        raise BackendError(f"unknown backend: {name}") from e


__all__ = ["BACKENDS", "BackendError", "PlayerBackend", "get"]
