#!/usr/bin/env bash
# Wrap dist/Tapestry.app into dist/Tapestry.dmg for sharing.
#
# Run after `./scripts/build-app.sh`. The .app must already exist.
#
# Heads-up on Gatekeeper: an UNSIGNED .app, shipped to someone else, will
# trigger macOS's "Apple could not verify..." warning. To open it the
# recipient must right-click the .app → Open → confirm. To avoid that
# warning entirely, sign + notarize the .app before running this script
# (see scripts/build-app.sh for the codesign/notarytool stubs). For a
# truly clean handoff the .dmg itself should also be signed/notarized.

set -euo pipefail

cd "$(dirname "$0")/.."

APP_PATH="dist/Tapestry.app"
DMG_PATH="dist/Tapestry.dmg"
VOL_NAME="Tapestry"

if [[ ! -d "$APP_PATH" ]]; then
  echo "→ no $APP_PATH yet — run ./scripts/build-app.sh first" >&2
  exit 1
fi

echo "→ removing any prior $DMG_PATH"
rm -f "$DMG_PATH"

# Stage the app + an Applications shortcut into a temp folder so the .dmg
# opens with the familiar drag-to-Applications layout.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# Install.command — one-click installer for users who don't want to drag +
# run `xattr -dr com.apple.quarantine` themselves. Copies the bundled
# Tapestry.app to /Applications, strips the quarantine flag macOS sets on
# downloaded DMG contents, then launches the app. The script itself is
# also quarantined on first run, so Terminal will show "is from the
# internet, are you sure?" — one click through, then it just works.
INSTALL_CMD="$STAGE/Install Tapestry.command"
cat > "$INSTALL_CMD" <<'COMMAND'
#!/usr/bin/env bash
# Tapestry one-click installer. Copies Tapestry.app to /Applications,
# strips the quarantine flag, and launches. Safe to re-run.
set -e

cd "$(dirname "$0")"

APP_SRC="./Tapestry.app"
APP_DST="/Applications/Tapestry.app"

if [[ ! -d "$APP_SRC" ]]; then
  echo "✗ Tapestry.app not found next to this script."
  echo "  Run this from the mounted Tapestry DMG."
  read -r -p "Press return to close." _
  exit 1
fi

echo "→ installing to $APP_DST"
if [[ -d "$APP_DST" ]]; then
  # Quit any running instance so we can overwrite cleanly.
  osascript -e 'tell application "Tapestry" to quit' 2>/dev/null || true
  sleep 1
  rm -rf "$APP_DST"
fi
ditto "$APP_SRC" "$APP_DST"

echo "→ clearing quarantine flag"
xattr -dr com.apple.quarantine "$APP_DST" || true

echo "→ launching"
open "$APP_DST"

echo "✓ Tapestry installed. You can close this window."
COMMAND
chmod +x "$INSTALL_CMD"

echo "→ creating compressed disk image"
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "✓ $DMG_PATH"
ls -lh "$DMG_PATH"

# --- code signing the dmg (uncomment once you have a Developer ID) ---
# DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
# codesign --force --sign "$DEVELOPER_ID" "$DMG_PATH"
# xcrun notarytool submit "$DMG_PATH" --keychain-profile "AC_NOTARY" --wait
# xcrun stapler staple "$DMG_PATH"
