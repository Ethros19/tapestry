#!/usr/bin/env bash
# Build a REAL universal2 (arm64 + x86_64) Tapestry.app from Apple Silicon.
#
# PyInstaller can't build universal2 directly for this project because some
# deps (uvloop, httptools, watchfiles, zeroconf) don't ship universal2 wheels.
# So we build each arch as a thin app, then lipo-merge them:
#
#   1. arm64 slice  — native, in .venv-arm64  (zeroconf forced pure-Python*)
#   2. x86_64 slice — under Rosetta, in .venv-x86 (see build-app-x86.sh notes)
#   3. merge        — scripts/merge-universal.py fattens every Mach-O + re-signs
#
#   * zeroconf's Cython extensions can't cross-compile to x86_64 under Rosetta,
#     so the x86 build falls back to pure-Python zeroconf. We force the arm64
#     build to match (SKIP_CYTHON) so the two bundles have identical layouts,
#     which the merge requires. The Cython bits are only an mDNS perf optimization.
#
# Output:  dist/Tapestry.app  (universal2).  Then run ./scripts/build-dmg.sh.
#
# Prereqs: Rosetta 2 + a universal2 python3 (see build-app-x86.sh).

set -euo pipefail
cd "$(dirname "$0")/.."

PY_UNIVERSAL="${PYTHON_UNIVERSAL:-/usr/local/bin/python3}"
ZEROCONF_PIN="zeroconf==0.150.0"

PYI_ARGS=(
  --noconfirm --windowed --name "Tapestry"
  --icon "dist/icon.icns" --add-data "static:static"
  --hidden-import "uvicorn.logging" --hidden-import "uvicorn.loops.auto"
  --hidden-import "uvicorn.loops.asyncio" --hidden-import "uvicorn.protocols.http.auto"
  --hidden-import "uvicorn.protocols.http.h11_impl" --hidden-import "uvicorn.protocols.websockets.auto"
  --hidden-import "uvicorn.lifespan.on" --hidden-import "async_upnp_client"
  --collect-all "async_upnp_client" --hidden-import "zeroconf"
  --collect-submodules "zeroconf" --collect-submodules "fastapi"
  --collect-submodules "uvicorn" --osx-bundle-identifier "com.ethros.tapestry"
  app/desktop.py
)

# --- sanity -------------------------------------------------------------------
arch -x86_64 /usr/bin/true 2>/dev/null || {
  echo "✗ Rosetta 2 missing: softwareupdate --install-rosetta --agree-to-license" >&2; exit 1; }
lipo -archs "$PY_UNIVERSAL" 2>/dev/null | grep -q x86_64 || {
  echo "✗ $PY_UNIVERSAL is not universal2 (set PYTHON_UNIVERSAL)" >&2; exit 1; }

mkdir -p dist

# --- arm64 tool shims (needed so xcrun tools work under Rosetta) --------------
SHIM="$(mktemp -d)"; trap 'rm -rf "$SHIM"' EXIT
for t in lipo strip codesign install_name_tool otool xcrun nmedit; do
  printf '#!/bin/bash\nexec arch -arm64 /usr/bin/%s "$@"\n' "$t" > "$SHIM/$t"; chmod +x "$SHIM/$t"
done

# --- arm64 slice --------------------------------------------------------------
echo "→ [arm64] venv + deps (zeroconf pure-Python)"
[[ -x .venv-arm64/bin/python3 ]] || arch -arm64 "$PY_UNIVERSAL" -m venv .venv-arm64
arch -arm64 .venv-arm64/bin/python3 -m pip install --quiet --upgrade pip
arch -arm64 .venv-arm64/bin/python3 -m pip install --quiet -r requirements-dev.txt
SKIP_CYTHON=1 arch -arm64 .venv-arm64/bin/python3 -m pip install --quiet \
  --force-reinstall --no-binary zeroconf "$ZEROCONF_PIN"
# Icons (app + .tape document) — needs Pillow, which the arm64 venv now has.
if [[ ! -f dist/icon.icns || ! -f dist/tape.icns ]]; then
  echo "→ generating app + .tape icons"
  VIRTUAL_ENV="$PWD/.venv-arm64" PATH="$PWD/.venv-arm64/bin:$PATH" ./scripts/build-icon.sh
fi
echo "→ [arm64] building"
rm -rf build-arm64 dist-arm64
arch -arm64 .venv-arm64/bin/pyinstaller --target-arch arm64 \
  --distpath dist-arm64 --workpath build-arm64 "${PYI_ARGS[@]}" >/dev/null

# --- x86_64 slice -------------------------------------------------------------
echo "→ [x86_64] venv + deps (under Rosetta)"
[[ -x .venv-x86/bin/python3 ]] || arch -x86_64 "$PY_UNIVERSAL" -m venv .venv-x86
arch -x86_64 .venv-x86/bin/python3 -m pip install --quiet --upgrade pip
arch -x86_64 .venv-x86/bin/python3 -m pip install --quiet -r requirements-dev.txt
echo "→ [x86_64] building"
rm -rf build-x86 dist-x86
PATH="$SHIM:$PATH" arch -x86_64 .venv-x86/bin/pyinstaller --target-arch x86_64 \
  --distpath dist-x86 --workpath build-x86 "${PYI_ARGS[@]}" >/dev/null

# --- merge --------------------------------------------------------------------
echo "→ merging into universal2 bundle"
rm -rf dist/Tapestry.app
arch -arm64 .venv-arm64/bin/python3 scripts/merge-universal.py \
  dist-arm64/Tapestry.app dist-x86/Tapestry.app dist/Tapestry.app

# --- .tape document type + re-sign -------------------------------------------
# The merge signs the bundle, but adding tape.icns + patching Info.plist
# invalidates that signature, so we re-sign afterward.
echo "→ applying .tape document type"
./scripts/_apply-tape-doctype.sh dist/Tapestry.app
codesign --force --deep --sign - dist/Tapestry.app

# --- verify -------------------------------------------------------------------
MAIN="dist/Tapestry.app/Contents/MacOS/Tapestry"
echo "→ built: dist/Tapestry.app ($(lipo -archs "$MAIN"))"
lipo -archs "$MAIN" | grep -q arm64 && lipo -archs "$MAIN" | grep -q x86_64 || {
  echo "✗ main executable is not universal" >&2; exit 1; }
codesign --verify --deep --strict dist/Tapestry.app || { echo "✗ signature invalid" >&2; exit 1; }
echo "✓ universal2 build verified. Wrap it with: ./scripts/build-dmg.sh"
