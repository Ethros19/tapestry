"""Desktop entry point: boots uvicorn on a free localhost port and opens
the FastAPI app inside a native window via pywebview.

Run from the repo:
    python -m app.desktop

When packaged with PyInstaller (see scripts/build-app.sh), this is the
binary the .app launches.
"""
from __future__ import annotations

import socket
import sys
import threading
import time
import urllib.request

import uvicorn

from app.main import app


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

    port = _free_port()
    url = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", access_log=False,
    )
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    _wait_ready(f"{url}/api/health")

    webview.create_window(
        "Tapestry",
        url,
        width=1280,
        height=900,
        min_size=(960, 640),
        easy_drag=False,
    )
    try:
        webview.start()
    finally:
        server.should_exit = True
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
