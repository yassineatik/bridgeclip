#!/usr/bin/env bash
# Build this checkout into an unsigned BridgeClip.app and put it in
# /Applications, reusing the Python venv and FFmpeg of the app already
# installed there. For trying changes on your own Mac, never for release.
#
#   bash scripts/install-local-mac.sh
#
# The current /Applications/BridgeClip.app is zipped to ~/Downloads first.
# Auto-update stays off for the local build (it is not signed by the team);
# reinstall the release DMG, or unzip the backup, to go back.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
installed="/Applications/BridgeClip.app"
arch="$(uname -m)"
case "$arch" in
  arm64) builder_arch="arm64" ;;
  x86_64) builder_arch="x64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

for runtime in engine-venv engine-bin; do
  if [[ ! -d "$repo/$runtime" ]]; then
    [[ -d "$installed/Contents/Resources/$runtime" ]] || {
      echo "Missing $repo/$runtime and no installed app to copy it from. Run scripts/prepare-resources.sh $builder_arch." >&2
      exit 1
    }
    echo "Copying $runtime from the installed app"
    rsync -a "$installed/Contents/Resources/$runtime/" "$repo/$runtime/"
  fi
done

cd "$repo"
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac "--$builder_arch" --dir -c.mac.identity=null -c.mac.notarize=false
built="$repo/dist/mac-$builder_arch/BridgeClip.app"
[[ "$builder_arch" == x64 ]] && built="$repo/dist/mac/BridgeClip.app"

# codesign refuses bundles carrying Finder or iCloud attributes, which a
# checkout under Desktop or Documents gets, so sign a clean copy elsewhere.
stage="$(mktemp -d -t bridgeclip-local)"
trap 'rm -rf "$stage"' EXIT
ditto --norsrc --noextattr "$built" "$stage/BridgeClip.app"
codesign --force --deep --sign - "$stage/BridgeClip.app"
codesign --verify --deep --strict "$stage/BridgeClip.app"
bash "$repo/scripts/verify-packaged-mac.sh" "$stage/BridgeClip.app" "$builder_arch"

if pgrep -f "$installed/Contents/MacOS/BridgeClip" >/dev/null; then
  echo "Asking BridgeClip to quit"
  osascript -e 'tell application "BridgeClip" to quit' || true
  for _ in $(seq 1 60); do
    pgrep -f "$installed/Contents/MacOS/BridgeClip" >/dev/null || break
    sleep 1
  done
  pgrep -f "$installed/Contents/MacOS/BridgeClip" >/dev/null && {
    echo "BridgeClip is still running (unsaved edits?). Quit it and rerun." >&2
    exit 1
  }
fi

if [[ -d "$installed" ]]; then
  version="$(defaults read "$installed/Contents/Info.plist" CFBundleShortVersionString)"
  backup="$HOME/Downloads/BridgeClip-$version-backup-$(date +%Y%m%d-%H%M%S).zip"
  echo "Backing up the installed app to $backup"
  ditto -c -k --keepParent "$installed" "$backup"
  rm -rf "$installed"
fi
ditto "$stage/BridgeClip.app" "$installed"
codesign --verify --deep --strict "$installed"
open -a "$installed"
echo "Installed the local build at $installed"
