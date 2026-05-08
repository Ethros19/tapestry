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
