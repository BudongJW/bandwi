#!/usr/bin/env bash
# Build a Chrome Web Store upload package (.zip)
# Usage: bash scripts/build-store-zip.sh
#
# Output: dist/bandwi-v{VERSION}.zip

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
VERSION=$(node -e "const p=require('path').resolve('$ROOT','extension','manifest.json');console.log(require(p).version)")
DIST="$ROOT/dist"
ZIP_NAME="bandwi-v${VERSION}.zip"

echo "Building Bandwi v${VERSION} for Chrome Web Store..."

# Clean
rm -rf "$DIST"
mkdir -p "$DIST"

# Validate manifest
node -e "
const m = require(require('path').resolve('$ROOT','extension','manifest.json'));
if (m.manifest_version !== 3) throw new Error('Must be Manifest V3');
if (!m.version) throw new Error('Missing version');
if (!m.description) throw new Error('Missing description');
if (m.description.length > 132) throw new Error('Description too long: ' + m.description.length + '/132');
console.log('  Manifest validated: MV' + m.manifest_version + ', v' + m.version);
"

# Check icons exist
for size in 16 48 128; do
  icon="$ROOT/extension/icons/icon${size}.png"
  if [ ! -f "$icon" ]; then
    echo "ERROR: Missing icon: $icon"
    exit 1
  fi
done
echo "  Icons validated: 16, 48, 128"

# Create zip (extension/ contents only, no parent dir)
cd "$ROOT/extension"
if command -v zip &> /dev/null; then
  zip -r "$DIST/$ZIP_NAME" . -x '*.DS_Store' '*__MACOSX*'
elif command -v 7z &> /dev/null; then
  7z a -tzip "$DIST/$ZIP_NAME" . -x'!*.DS_Store'
elif command -v powershell &> /dev/null; then
  powershell -Command "Compress-Archive -Path '$ROOT/extension/*' -DestinationPath '$DIST/$ZIP_NAME' -Force"
else
  echo "ERROR: No zip tool found (zip, 7z, or powershell)"
  exit 1
fi

ZIP_SIZE=$(wc -c < "$DIST/$ZIP_NAME" | tr -d ' ')
echo ""
echo "Store package ready:"
echo "  $DIST/$ZIP_NAME ($ZIP_SIZE bytes)"
echo ""
echo "Upload at: https://chrome.google.com/webstore/devconsole"
echo ""
echo "Checklist before submitting:"
echo "  [ ] Test 'Load unpacked' in chrome://extensions/"
echo "  [ ] Capture 1-5 screenshots (1280x800 or 640x400)"
echo "  [ ] Upload promo images from store/ folder"
echo "  [ ] Fill in privacy policy URL"
echo "  [ ] Set single purpose description"
echo "  [ ] Justify host_permissions and other permissions"
