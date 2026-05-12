#!/usr/bin/env bash
# Build Tapestry.app via PyInstaller.
#
# Prereqs (one-time):
#   python3.13 -m venv .venv && source .venv/bin/activate
#   pip install -r requirements-dev.txt
#
# Output:
#   dist/Tapestry.app
#
# To share the app with other people without scary "unidentified developer"
# warnings, code-sign + notarize. The hooks for that are commented near the
# bottom of this script — fill in DEVELOPER_ID once you have an Apple
# Developer account, then uncomment.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  echo "→ no venv active; activating .venv"
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

echo "→ cleaning previous build/"
# Preserve any pre-built icons (app + .tape doc) so we don't have to
# regenerate them every run — Pillow rendering takes a few seconds.
if [[ -f dist/icon.icns ]]; then
  cp dist/icon.icns /tmp/tapestry-icon-keep.icns
fi
if [[ -f dist/tape.icns ]]; then
  cp dist/tape.icns /tmp/tapestry-tape-icon-keep.icns
fi
rm -rf build dist
mkdir -p dist
if [[ -f /tmp/tapestry-icon-keep.icns ]]; then
  mv /tmp/tapestry-icon-keep.icns dist/icon.icns
fi
if [[ -f /tmp/tapestry-tape-icon-keep.icns ]]; then
  mv /tmp/tapestry-tape-icon-keep.icns dist/tape.icns
fi

# Build the .icns files the first time; subsequent runs reuse them. To
# regenerate after editing build-icon.py, delete the .icns files first.
if [[ ! -f dist/icon.icns || ! -f dist/tape.icns ]]; then
  echo "→ generating app + .tape document icons"
  ./scripts/build-icon.sh
fi

echo "→ running pyinstaller"
pyinstaller \
  --noconfirm \
  --windowed \
  --name "Tapestry" \
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

echo "→ built: dist/Tapestry.app"

# Drop the .tape document icon into the bundle and patch Info.plist with
# a UTI + CFBundleDocumentTypes entry. Effects in Finder:
#   * .tape files show our cassette-on-paper icon
#   * macOS knows Tapestry "owns" the .tape type (LSHandlerRank: Owner)
#   * mime-type application/x-tapestry-tape is recognized for downloads
cp dist/tape.icns "dist/Tapestry.app/Contents/Resources/tape.icns"
python - <<'PY'
import plistlib
from pathlib import Path

p = Path("dist/Tapestry.app/Contents/Info.plist")
data = plistlib.loads(p.read_bytes())
data["CFBundleDocumentTypes"] = [{
    "CFBundleTypeName": "Tapestry Tape",
    "CFBundleTypeExtensions": ["tape"],
    "CFBundleTypeMIMETypes": ["application/x-tapestry-tape"],
    "CFBundleTypeIconFile": "tape.icns",
    "CFBundleTypeRole": "Editor",
    "LSItemContentTypes": ["com.ethros.tapestry.tape"],
    "LSHandlerRank": "Owner",
}]
data["UTExportedTypeDeclarations"] = [{
    "UTTypeIdentifier": "com.ethros.tapestry.tape",
    "UTTypeDescription": "Tapestry Tape",
    "UTTypeConformsTo": ["public.json", "public.data"],
    "UTTypeIconFile": "tape.icns",
    "UTTypeTagSpecification": {
        "public.filename-extension": ["tape"],
        "public.mime-type": ["application/x-tapestry-tape"],
    },
}]
p.write_bytes(plistlib.dumps(data))
print("✓ patched Info.plist with .tape UTI + document type")
PY

# --- code signing (uncomment once you have a Developer ID) ---
# DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
# codesign --force --deep --options runtime --sign "$DEVELOPER_ID" dist/Tapestry.app
# xcrun notarytool submit dist/Tapestry.app --keychain-profile "AC_NOTARY" --wait
# xcrun stapler staple dist/Tapestry.app

echo "✓ done. Open it with: open dist/Tapestry.app"
