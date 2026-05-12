#!/usr/bin/env bash
# Build dist/icon.icns (app icon) + dist/tape.icns (.tape document icon).
#
# Each .icns is assembled the same way:
#   1. Render a 1024×1024 master PNG via Pillow (build-icon.py)
#   2. Resize down to all the sizes macOS expects
#   3. Bundle with iconutil → dist/<name>.icns
#
# Run before scripts/build-app.sh so PyInstaller can pick up the .icns files.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

mkdir -p dist

# render_icns <master.png> <iconset-dir> <out.icns>
render_icns() {
  local master="$1"
  local iconset="$2"
  local out="$3"

  rm -rf "$iconset"
  mkdir -p "$iconset"

  # macOS expects this exact set of files for `iconutil` to produce a .icns.
  declare -a sizes=(16 32 64 128 256 512 1024)
  for size in "${sizes[@]}"; do
    sips -z "$size" "$size" "$master" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  done
  # @2x variants — same pixels, different filenames.
  sips -z 32   32   "$master" --out "$iconset/icon_16x16@2x.png"   >/dev/null
  sips -z 64   64   "$master" --out "$iconset/icon_32x32@2x.png"   >/dev/null
  sips -z 256  256  "$master" --out "$iconset/icon_128x128@2x.png" >/dev/null
  sips -z 512  512  "$master" --out "$iconset/icon_256x256@2x.png" >/dev/null
  sips -z 1024 1024 "$master" --out "$iconset/icon_512x512@2x.png" >/dev/null
  # iconutil only takes the standard names — drop the 64 / 1024 standalone
  # files (used as @2x sources above) so we don't get warnings.
  rm -f "$iconset/icon_64x64.png" "$iconset/icon_1024x1024.png"

  iconutil --convert icns "$iconset" --output "$out"
}

echo "→ rendering app icon"
python scripts/build-icon.py "dist/icon-master.png"
render_icns "dist/icon-master.png" "dist/icon.iconset" "dist/icon.icns"
echo "✓ dist/icon.icns"

echo "→ rendering .tape document icon"
python scripts/build-icon.py --doc "dist/tape-doc-master.png"
render_icns "dist/tape-doc-master.png" "dist/tape.iconset" "dist/tape.icns"
echo "✓ dist/tape.icns"

ls -lh dist/icon.icns dist/tape.icns
