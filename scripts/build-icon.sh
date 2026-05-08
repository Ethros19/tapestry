#!/usr/bin/env bash
# Build dist/icon.icns from scratch:
#   1. Render a 1024×1024 master PNG via Pillow (build-icon.py)
#   2. Resize down to all the sizes macOS expects
#   3. Bundle with iconutil → dist/icon.icns
#
# Run before scripts/build-app.sh so PyInstaller can pick up the .icns.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

mkdir -p dist
MASTER="dist/icon-master.png"
ICONSET="dist/icon.iconset"
ICNS="dist/icon.icns"

echo "→ rendering master 1024×1024"
python scripts/build-icon.py "$MASTER"

echo "→ generating iconset sizes"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# macOS expects this exact set of files for `iconutil` to produce a .icns.
declare -a sizes=(16 32 64 128 256 512 1024)
for size in "${sizes[@]}"; do
  sips -z "$size" "$size" "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
# @2x variants — same pixels, different filenames.
sips -z 32   32   "$MASTER" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 64   64   "$MASTER" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 256  256  "$MASTER" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 512  512  "$MASTER" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 1024 1024 "$MASTER" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

# iconutil only takes the standard names — drop the 64 / 1024 standalone
# files (used as @2x sources above) so we don't get warnings.
rm -f "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"

echo "→ bundling iconset → $ICNS"
iconutil --convert icns "$ICONSET" --output "$ICNS"

echo "✓ $ICNS"
ls -lh "$ICNS"
