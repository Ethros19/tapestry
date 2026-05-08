"""Persisted user settings + on-disk paths.

In dev mode (running uvicorn from the repo) we keep `data/` in-tree so it's
easy to inspect; in app mode (packaged `.app` or any time
`TAPESTRY_DATA_DIR` is set) we use the macOS-standard Application Support
location so user data survives reinstalls.

`LYRION_URL` may be set via env var (highest priority — convenient for
dev), via the on-disk settings file (set through the in-app gear panel),
or it falls back to the localhost default.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

DEFAULT_LYRION_URL = "http://localhost:9000/jsonrpc.js"
SETTINGS_FILENAME = "settings.json"
DRAWER_FILENAME = "drawer.json"

_lock = Lock()


def data_dir() -> Path:
    """Resolve the directory holding settings.json + drawer.json.

    Precedence: `TAPESTRY_DATA_DIR` env var > Application Support (mac) >
    `./data/` (dev fallback).
    """
    env = os.environ.get("TAPESTRY_DATA_DIR")
    if env:
        return Path(env).expanduser()
    home = Path.home()
    if (home / "Library" / "Application Support").exists():
        return home / "Library" / "Application Support" / "Tapestry"
    return Path(__file__).resolve().parent.parent / "data"


def settings_path() -> Path:
    return data_dir() / SETTINGS_FILENAME


def drawer_path() -> Path:
    return data_dir() / DRAWER_FILENAME


def _load() -> dict[str, Any]:
    p = settings_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")) or {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save(data: dict[str, Any]) -> None:
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def get_all() -> dict[str, Any]:
    with _lock:
        data = _load()
        # Always expose the resolved (effective) values, not just stored ones.
        return {
            "lyrion_url": data.get("lyrion_url") or DEFAULT_LYRION_URL,
            "lyrion_url_source": _lyrion_url_source(data),
        }


def update(patch: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = _load()
        for k, v in patch.items():
            if v is None or v == "":
                data.pop(k, None)
            else:
                data[k] = v
        _save(data)
    return get_all()


def lyrion_url() -> str:
    """Effective LYRION_URL — env wins, then settings.json, then default."""
    env = os.environ.get("LYRION_URL")
    if env:
        return env
    return _load().get("lyrion_url") or DEFAULT_LYRION_URL


def _lyrion_url_source(stored: dict[str, Any]) -> str:
    if os.environ.get("LYRION_URL"):
        return "env"
    if stored.get("lyrion_url"):
        return "settings"
    return "default"


def migrate_legacy_drawer() -> None:
    """One-time migration of ./data/drawer.json → ~/Library/.../drawer.json."""
    new = drawer_path()
    if new.exists():
        return
    legacy = Path(__file__).resolve().parent.parent / "data" / DRAWER_FILENAME
    if legacy.exists() and legacy.resolve() != new.resolve():
        new.parent.mkdir(parents=True, exist_ok=True)
        new.write_bytes(legacy.read_bytes())
