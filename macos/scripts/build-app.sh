#!/bin/sh
# Builds macos/dist/RemoteCC.app. Needs Xcode command line tools, Node.js, and `npm ci` at the repo root.
set -eu
cd "$(dirname "$0")/.."
node scripts/prepare-server.cjs Resources/server
swift build -c release --product RemoteCC
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/remotecc-build.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT HUP INT TERM
APP="$STAGING/RemoteCC.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/RemoteCC" "$APP/Contents/MacOS/RemoteCC"
cp -R Resources/server "$APP/Contents/Resources/server"
cp -R Resources/ThirdParty "$APP/Contents/Resources/ThirdParty"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# Sign outside synced workspaces, whose file provider can reintroduce FinderInfo.
xattr -dr com.apple.FinderInfo "$APP" 2>/dev/null || true
xattr -dr com.apple.ResourceFork "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p dist
rm -rf dist/RemoteCC.app
ditto --noextattr "$APP" dist/RemoteCC.app
# A synced destination may attach Finder metadata shortly after the copy.
# Only remove the two attributes prohibited by codesign; never bypass verification.
for attempt in 1 2 3; do
  xattr -dr com.apple.FinderInfo dist/RemoteCC.app 2>/dev/null || true
  xattr -dr com.apple.ResourceFork dist/RemoteCC.app 2>/dev/null || true
  if codesign --verify --deep --strict dist/RemoteCC.app; then
    echo "Built dist/RemoteCC.app"
    exit 0
  fi
  sleep 1
done
codesign --verify --deep --strict dist/RemoteCC.app
echo "Built dist/RemoteCC.app"
