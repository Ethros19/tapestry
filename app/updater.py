"""App update checks + (best-effort) self-install.

Checks GitHub Releases for the latest tagged release and, when running as a
packaged Tapestry.app on macOS, can download the release DMG and replace
the installed app in /Applications. In dev mode (no PyInstaller `frozen`
marker, or running outside /Applications) the install path is disabled —
the UI falls back to opening the release page in the browser.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from . import settings

# Authoritative version — also surfaced to FastAPI / the User-Agent header.
__version__ = "1.1.4"

# The repo to poll. Keep in sync with the source-of-truth GitHub repo
# (README + AI-HANDOFF both point at Ethros19/tapestry).
GITHUB_REPO = "Ethros19/tapestry"
RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
RELEASES_HTML = f"https://github.com/{GITHUB_REPO}/releases/latest"

# Don't auto-check more often than this — even when several windows /
# clients ping at once. The settings file holds the last check time.
AUTO_CHECK_INTERVAL_SECONDS = 6 * 60 * 60  # 6 hours

# Allow-list of download URLs vetted by a recent `check_latest()`. The
# install endpoint refuses anything not in here — a localhost-only API
# is still attackable by any in-page script that can POST, so we treat
# `download_url` as untrusted user input even though only our own UI
# normally sets it.
_known_url_lock = threading.Lock()
_known_download_url: str | None = None


def _record_download_url(url: str | None) -> None:
    global _known_download_url
    with _known_url_lock:
        _known_download_url = url or None


def _is_known_download_url(url: str) -> bool:
    with _known_url_lock:
        return bool(_known_download_url) and url == _known_download_url


# ---------- version compare ----------

_VER_RE = re.compile(r"(\d+)")


def _ver_tuple(v: str) -> tuple[int, ...]:
    """Loose semver tuple: '1.1.4' -> (1,1,4), 'v1.10.0-beta' -> (1,10,0)."""
    if not v:
        return ()
    return tuple(int(m.group(1)) for m in _VER_RE.finditer(v))


def is_newer(latest: str, current: str) -> bool:
    a, b = _ver_tuple(latest), _ver_tuple(current)
    # Pad shorter tuple with zeros so 1.1 vs 1.1.0 compares correctly.
    n = max(len(a), len(b))
    a = a + (0,) * (n - len(a))
    b = b + (0,) * (n - len(b))
    return a > b


# ---------- install-mode detection ----------

def _bundle_app_path() -> Path | None:
    """Return the .app bundle path if we're running from inside one.

    PyInstaller's --windowed build on macOS produces `<bundle>/Contents/
    MacOS/<binary>`. We walk up from sys.executable to find the .app root.
    Returns None when running from `python -m app.desktop` (dev mode) so
    the install path can be safely refused.
    """
    if not getattr(sys, "frozen", False):
        return None
    exe = Path(sys.executable).resolve()
    for p in [exe] + list(exe.parents):
        if p.suffix == ".app":
            return p
    return None


def can_install() -> bool:
    """True when we can replace the running bundle in-place.

    Requires: running on macOS, inside a .app bundle, writable parent dir
    (typically /Applications). Otherwise the UI surfaces a "Download from
    GitHub" link instead of trying a half-broken install.
    """
    if sys.platform != "darwin":
        return False
    bundle = _bundle_app_path()
    if not bundle:
        return False
    return os.access(str(bundle.parent), os.W_OK)


# ---------- release polling ----------

def _pick_dmg_asset(release: dict[str, Any]) -> dict[str, Any] | None:
    for a in release.get("assets") or []:
        name = (a.get("name") or "").lower()
        if name.endswith(".dmg"):
            return a
    return None


def check_latest(client: httpx.Client | None = None) -> dict[str, Any]:
    """Hit the GitHub releases API and summarize the latest release.

    Mutates the on-disk settings to record the timestamp + last seen
    version so the auto-check throttle works across restarts.
    """
    own_client = client is None
    client = client or httpx.Client(headers={"User-Agent": f"tapestry/{__version__}"}, timeout=8.0)
    try:
        r = client.get(RELEASES_API)
    finally:
        if own_client:
            client.close()
    if r.status_code == 404:
        # Repo has no releases yet — treat as "you're up to date" rather
        # than an error, so the UI doesn't shout at fresh installs.
        result = {
            "current": __version__,
            "latest": __version__,
            "available": False,
            "name": "",
            "tag": "",
            "html_url": RELEASES_HTML,
            "download_url": "",
            "body": "",
            "published_at": "",
            "checked_at": int(time.time() * 1000),
            "can_install": can_install(),
            "reason": "no releases published yet",
        }
    elif r.status_code != 200:
        raise RuntimeError(f"GitHub returned {r.status_code}: {r.text[:200]}")
    else:
        rel = r.json()
        tag = (rel.get("tag_name") or "").lstrip("v")
        dmg = _pick_dmg_asset(rel) or {}
        latest = tag or __version__
        result = {
            "current": __version__,
            "latest": latest,
            "available": bool(tag) and is_newer(latest, __version__),
            "name": rel.get("name") or tag,
            "tag": rel.get("tag_name") or "",
            "html_url": rel.get("html_url") or RELEASES_HTML,
            "download_url": dmg.get("browser_download_url") or "",
            "body": rel.get("body") or "",
            "published_at": rel.get("published_at") or "",
            "checked_at": int(time.time() * 1000),
            "can_install": can_install() and bool(dmg.get("browser_download_url")),
        }
    settings.update({
        "last_update_check_at": result["checked_at"],
        "last_known_latest": result["latest"],
    })
    # Cache the asset URL so `install_update()` can verify any later
    # POSTed download_url came from this same check, not an attacker.
    _record_download_url(result.get("download_url"))
    return result


def should_auto_check() -> bool:
    s = settings.get_all()
    if not s.get("auto_check_updates", True):
        return False
    last = int(s.get("last_update_check_at") or 0)
    return (time.time() * 1000 - last) > AUTO_CHECK_INTERVAL_SECONDS * 1000


# ---------- install ----------

# The shell installer mounts the DMG, swaps the .app in place, then relaunches
# Tapestry. It waits on the old PID to exit before touching the bundle so we
# don't try to overwrite a running binary. Designed to survive the parent
# process quitting mid-script (nohup + disown via setsid).
_INSTALLER = textwrap.dedent(
    """\
    #!/bin/bash
    set -u
    DMG="$1"
    OLD_PID="$2"
    APP_PATH="$3"
    LOG="$4"

    exec >>"$LOG" 2>&1
    echo "[$(date)] installer starting; old pid=$OLD_PID app=$APP_PATH dmg=$DMG"

    # Wait up to 30s for the old process to exit so we don't clobber a
    # running .app and produce a half-replaced bundle.
    for _ in $(seq 1 60); do
      if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
      sleep 0.5
    done

    MOUNT=$(mktemp -d -t tapestry-update)
    hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -quiet || {
      echo "hdiutil attach failed"; exit 1;
    }
    SRC=$(find "$MOUNT" -maxdepth 2 -name 'Tapestry.app' -print -quit)
    if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
      echo "no Tapestry.app inside DMG"
      hdiutil detach "$MOUNT" -quiet || true
      exit 1
    fi

    # Replace atomically-ish: stage next to the existing bundle, swap, clean up.
    STAGE="${APP_PATH%/*}/.tapestry-update.$$"
    rm -rf "$STAGE"
    /usr/bin/ditto "$SRC" "$STAGE" || { echo "ditto failed"; hdiutil detach "$MOUNT" -quiet || true; exit 1; }
    rm -rf "$APP_PATH.bak" 2>/dev/null
    if [ -d "$APP_PATH" ]; then mv "$APP_PATH" "$APP_PATH.bak" || true; fi
    mv "$STAGE" "$APP_PATH" || { echo "swap failed"; mv "$APP_PATH.bak" "$APP_PATH" 2>/dev/null; exit 1; }
    rm -rf "$APP_PATH.bak" 2>/dev/null

    hdiutil detach "$MOUNT" -quiet || true
    rm -f "$DMG" 2>/dev/null
    rm -rf "$MOUNT" 2>/dev/null

    # Strip quarantine so the user doesn't get re-warned on every update.
    xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

    /usr/bin/open "$APP_PATH"
    echo "[$(date)] installer done"
    """
)


def _download(url: str, dest: Path, client: httpx.Client) -> None:
    with client.stream("GET", url, follow_redirects=True, timeout=None) as r:
        if r.status_code != 200:
            raise RuntimeError(f"download failed: HTTP {r.status_code}")
        with dest.open("wb") as f:
            for chunk in r.iter_bytes(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)


def install_update(download_url: str, on_done: callable = None) -> dict[str, Any]:
    """Download the DMG, hand off to a detached shell installer, signal exit.

    `on_done` is called (in a background thread) once the installer has
    been spawned — the desktop entry point uses this to tear down the
    pywebview window so the installer's `kill -0` wait completes quickly.
    """
    if not download_url:
        raise RuntimeError("no DMG asset on the latest release")
    # The URL must match the one we just vended from `check_latest()`.
    # Without this, anything that can POST to localhost (in-page script,
    # future XSS via untrusted text) could swap in its own malicious DMG.
    if not _is_known_download_url(download_url):
        raise RuntimeError(
            "download_url doesn't match the latest release check — "
            "open Settings and Check for updates again",
        )
    bundle = _bundle_app_path()
    if not bundle:
        raise RuntimeError("self-install only works inside a packaged Tapestry.app")
    if not os.access(str(bundle.parent), os.W_OK):
        raise RuntimeError(f"can't write to {bundle.parent} — move Tapestry to /Applications first")

    tmp_dir = Path(tempfile.mkdtemp(prefix="tapestry-update-"))
    dmg_path = tmp_dir / "Tapestry.dmg"
    script_path = tmp_dir / "install.sh"
    log_path = tmp_dir / "install.log"

    with httpx.Client(headers={"User-Agent": f"tapestry/{__version__}"}) as c:
        _download(download_url, dmg_path, c)

    script_path.write_text(_INSTALLER, encoding="utf-8")
    script_path.chmod(0o755)

    # setsid detaches the installer from this process group so SIGINT-on-quit
    # doesn't take it down with us.
    proc = subprocess.Popen(  # noqa: S603 — args are program-built, not user-controlled
        [
            "/bin/bash",
            str(script_path),
            str(dmg_path),
            str(os.getpid()),
            str(bundle),
            str(log_path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )

    if on_done is not None:
        # Give the script a half-second to actually unblock and start
        # waiting on our PID, then trigger app exit.
        threading.Timer(0.5, on_done).start()

    return {
        "ok": True,
        "installer_pid": proc.pid,
        "log": str(log_path),
        "dmg": str(dmg_path),
    }
