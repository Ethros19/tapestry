"""Desktop entry point: boots uvicorn on a free localhost port and opens
the FastAPI app inside a native window via pywebview.

Run from the repo:
    python -m app.desktop

When packaged with PyInstaller (see scripts/build-app.sh), this is the
binary the .app launches.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request

import uvicorn

from app.main import app, queue_pending_import, register_quit_hook

# Wire format identifier shared with the backend (`TAPE_FORMAT_NAME` in
# main.py). Replicated here so the open-file path can validate before
# queueing without importing the constant cycle.
_TAPE_FORMAT_NAME = "tapestry-tape"
_TAPE_MAX_BYTES = 12 * 1024 * 1024


def _try_queue_tape_file(path: str) -> bool:
    """Read a .tape file off disk and queue it for the frontend to import.

    Returns True on success so we can answer YES to macOS's
    `application:openFile:` selector — anything else makes Finder show
    the "cannot open files in the Tapestry Tape format" error.
    """
    try:
        if not os.path.isfile(path):
            return False
        if os.path.getsize(path) > _TAPE_MAX_BYTES:
            return False
        with open(path, "rb") as f:
            data = f.read()
        payload = json.loads(data)
        if not isinstance(payload, dict) or payload.get("_format") != _TAPE_FORMAT_NAME:
            return False
        queue_pending_import(payload)
        return True
    except (OSError, json.JSONDecodeError, ValueError):
        return False


def _install_cocoa_open_file_handler() -> None:
    """Inject `application:openFile:` into pywebview's NSApp delegate.

    pywebview's stock `BrowserView.AppDelegate` implements only
    `applicationShouldTerminate:` and `applicationSupportsSecureRestorableState:`,
    so double-clicking a .tape file in Finder triggers the system "cannot
    open files in this format" error. We subclass it, add the open-file
    methods, and set the shared delegate before `webview.start()` runs.
    """
    if sys.platform != "darwin":
        return
    try:
        import Foundation
        from webview.platforms.cocoa import BrowserView
    except Exception:
        return

    class TapestryAppDelegate(BrowserView.AppDelegate):
        def application_openFile_(self, app, filename):
            ok = _try_queue_tape_file(str(filename))
            return Foundation.YES if ok else Foundation.NO

        def application_openFiles_(self, app, filenames):
            for f in filenames:
                _try_queue_tape_file(str(f))
            # `openFiles:` is void — no return needed.

    BrowserView._shared_app_delegate = TapestryAppDelegate.alloc().init()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_ready(url: str, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.4).read()
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"server didn't come up at {url} within {timeout}s")


def main() -> int:
    try:
        import webview  # imported lazily so the headless `uvicorn app.main:app` path doesn't need it
    except ImportError:
        sys.stderr.write(
            "pywebview is not installed. Install dependencies first:\n"
            "  pip install -r requirements.txt\n"
        )
        return 1

    # WKWebView swallows download responses (Content-Disposition: attachment
    # / <a download>) unless ALLOW_DOWNLOADS is on. With it enabled,
    # pywebview pops the native macOS save panel defaulted to ~/Downloads —
    # which is what the .tape share-download flow expects.
    webview.settings["ALLOW_DOWNLOADS"] = True

    # `Tapestry path/to/foo.tape` — command-line style invocation, and the
    # path that PyInstaller forwards for some Apple-Event-style opens.
    # Finder double-click is handled by the Cocoa delegate installed below.
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".tape"):
            _try_queue_tape_file(arg)

    # Install the open-file delegate before pywebview claims NSApp's
    # delegate slot — see `_install_cocoa_open_file_handler` for why.
    _install_cocoa_open_file_handler()

    port = _free_port()
    url = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", access_log=False,
    )
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    _wait_ready(f"{url}/api/health")

    window = webview.create_window(
        "Tapestry",
        url,
        width=1280,
        height=900,
        min_size=(960, 640),
        easy_drag=False,
    )

    def _quit_for_update() -> None:
        # Called from a background thread once the update installer has
        # been detached. Tear down pywebview so the installer's PID-wait
        # completes promptly.
        try:
            window.destroy()
        except Exception:
            pass
        server.should_exit = True

    register_quit_hook(_quit_for_update)

    try:
        webview.start()
    finally:
        server.should_exit = True
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
