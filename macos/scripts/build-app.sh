#!/bin/sh
# Builds macos/dist/RemoteCC.app. Needs Xcode command line tools, Node.js, and `npm ci` at the repo root.
set -eu
cd "$(dirname "$0")/.."
node scripts/prepare-server.cjs Resources/server
swift build -c release --product RemoteCC
APP=dist/RemoteCC.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/RemoteCC" "$APP/Contents/MacOS/RemoteCC"
cp -R Resources/server "$APP/Contents/Resources/server"
cp Resources/Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
echo "Built $APP"
