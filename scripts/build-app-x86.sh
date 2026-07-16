#!/usr/bin/env bash
# Build a native Intel (x86_64) Tapestry.app from an Apple Silicon Mac.
#
# Why this exists:
#   The default ./scripts/build-app.sh builds for the host arch (arm64 on
#   Apple Silicon). To ship to Intel Macs we build a dedicated x86_64 app.
#   It runs natively on Intel and on Apple Silicon via Rosetta.
#
#   A true universal2 (fat) binary is NOT built here because several deps
#   (uvloop, httptools, watchfiles, zeroconf) don't publish universal2
#   wheels, which makes PyInstaller's universal2 build fail. A native
#   x86_64 build sidesteps that entirely.
#
# Prereqs (one-time):
#   - Rosetta 2:            softwareupdate --install-rosetta --agree-to-license
#   - A universal2 python3: e.g. the python.org installer (has both slices).
#
# Output:
#   dist/Tapestry.app   (x86_64)
#
# Run ./scripts/build-dmg.sh afterward to wrap it into dist/Tapestry.dmg.

set -euo pipefail

cd "$(dirname "$0")/.."

VENV=".venv-x86"
PY_UNIVERSAL="${PYTHON_UNIVERSAL:-/usr/local/bin/python3}"

# --- sanity: need Rosetta and a universal2 python -----------------------------
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "✗ Rosetta 2 not available. Install with:" >&2
  echo "    softwareupdate --install-rosetta --agree-to-license" >&2
  exit 1
fi
if ! lipo -archs "$PY_UNIVERSAL" 2>/dev/null | grep -q x86_64; then
  echo "✗ $PY_UNIVERSAL has no x86_64 slice. Point PYTHON_UNIVERSAL at a" >&2
  echo "  universal2 python (e.g. the python.org installer)." >&2
  exit 1
fi

# --- x86_64 venv --------------------------------------------------------------
if [[ ! -x "$VENV/bin/python3" ]]; then
  echo "→ creating x86_64 venv ($VENV)"
  arch -x86_64 "$PY_UNIVERSAL" -m venv "$VENV"
fi
echo "→ installing deps as x86_64"
arch -x86_64 "$VENV/bin/python3" -m pip install --quiet --upgrade pip
arch -x86_64 "$VENV/bin/python3" -m pip install --quiet -r requirements-dev.txt

# --- arm64 tool shims ---------------------------------------------------------
# Under `arch -x86_64`, xcrun-backed tools (lipo, codesign, ...) fail to load
# because Command Line Tools only ship arm64 slices of libxcrun. These shims
# bounce each tool back to native arm64; lipo can still thin an x86_64 binary
# regardless of the arch it runs as.
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
for tool in lipo strip codesign install_name_tool otool xcrun nmedit; do
  printf '#!/bin/bash\nexec arch -arm64 /usr/bin/%s "$@"\n' "$tool" > "$SHIM/$tool"
  chmod +x "$SHIM/$tool"
done

# --- icons (app + .tape document) ---------------------------------------------
# Rendered via the x86 venv's Pillow, so run under Rosetta.
mkdir -p dist
if [[ ! -f dist/icon.icns || ! -f dist/tape.icns ]]; then
  echo "→ generating app + .tape icons"
  VIRTUAL_ENV="$PWD/$VENV" PATH="$PWD/$VENV/bin:$PATH" arch -x86_64 ./scripts/build-icon.sh
fi

# --- build --------------------------------------------------------------------
echo "→ running pyinstaller (target-arch x86_64)"
rm -rf build dist/Tapestry dist/Tapestry.app
PATH="$SHIM:$PATH" arch -x86_64 "$VENV/bin/pyinstaller" \
  --noconfirm \
  --windowed \
  --name "Tapestry" \
  --target-arch x86_64 \
  --icon "dist/icon.icns" \
  --add-data "static:static" \
  --hidden-import "uvicorn.logging" \
  --hidden-import "uvicorn.loops.auto" \
  --hidden-import "uvicorn.loops.asyncio" \
  --hidden-import "uvicorn.protocols.http.auto" \
  --hidden-import "uvicorn.protocols.http.h11_impl" \
  --hidden-import "uvicorn.protocols.websockets.auto" \
  --hidden-import "uvicorn.lifespan.on" \
  --hidden-import "async_upnp_client" \
  --collect-all "async_upnp_client" \
  --hidden-import "zeroconf" \
  --collect-submodules "zeroconf" \
  --collect-submodules "fastapi" \
  --collect-submodules "uvicorn" \
  --osx-bundle-identifier "com.ethros.tapestry" \
  app/desktop.py

# --- .tape document type + re-sign -------------------------------------------
echo "→ applying .tape document type"
./scripts/_apply-tape-doctype.sh dist/Tapestry.app
codesign --force --deep --sign - dist/Tapestry.app

# --- verify -------------------------------------------------------------------
MAIN="dist/Tapestry.app/Contents/MacOS/Tapestry"
echo "→ built: dist/Tapestry.app ($(lipo -archs "$MAIN"))"
if lipo -archs "$MAIN" | grep -q arm64; then
  echo "✗ unexpected arm64 slice in main executable" >&2
  exit 1
fi

echo "✓ done. Wrap it for sharing with: ./scripts/build-dmg.sh"
