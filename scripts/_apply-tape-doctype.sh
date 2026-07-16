#!/usr/bin/env bash
# Apply Tapestry's .tape document-type integration to a built .app bundle.
#
# Drops the .tape document icon into the bundle and patches Info.plist with a
# UTI + CFBundleDocumentTypes entry so Finder shows the cassette icon for
# .tape files and macOS knows Tapestry owns the type. This step is
# arch-independent, so the universal/x86 build scripts call it on the final
# bundle. Kept in sync with the inline block in scripts/build-app.sh.
#
# Usage:  _apply-tape-doctype.sh <path/to/Tapestry.app>

set -euo pipefail

APP="${1:?usage: _apply-tape-doctype.sh <Tapestry.app>}"
cd "$(dirname "$0")/.."

if [[ ! -f dist/tape.icns ]]; then
  echo "✗ dist/tape.icns missing — run ./scripts/build-icon.sh first" >&2
  exit 1
fi

cp dist/tape.icns "$APP/Contents/Resources/tape.icns"

PLIST="$APP/Contents/Info.plist" python3 - <<'PY'
import os
import plistlib
from pathlib import Path

p = Path(os.environ["PLIST"])
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
