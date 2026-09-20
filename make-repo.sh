#!/usr/bin/env bash
# Build the plugin, package it, and (re)generate the repository manifest.
#
# Usage:  ./make-repo.sh <version> <base-url>
#   e.g.  ./make-repo.sh 1.0.0.0 http://192.168.1.50:8080
#
# The base URL is where you will SERVE the repo/ directory from. It must be
# reachable from the Jellyfin server, not just from your browser.
set -euo pipefail

VERSION="${1:-1.0.0.0}"
BASE_URL="${2:-}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <version> <base-url>" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

GUID="95254fa2-e04d-4718-a529-e32c5ef4a170"
NAME="Clip Export"
ABI="12.1.0.0"
PROJ="Jellyfin.Plugin.ClipExport"
ZIP="clipexport_${VERSION}.zip"

echo "==> building"
dotnet build "$PROJ/$PROJ.csproj" -c Release -p:Version="$VERSION" \
  -p:AssemblyVersion="$VERSION" -p:FileVersion="$VERSION" \
  | grep -E "error|Build succeeded"

mkdir -p repo
rm -f "repo/$ZIP"
( cd "$PROJ/bin/Release/net10.0" && zip -j "../../../../repo/$ZIP" "$PROJ.dll" >/dev/null )

# Jellyfin verifies this MD5 before installing; a stale value fails the install.
CHECKSUM=$(md5 -q "repo/$ZIP" 2>/dev/null || md5sum "repo/$ZIP" | cut -d' ' -f1)
TIMESTAMP=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]+'Z')")

echo "==> manifest"
python3 - "$VERSION" "$CHECKSUM" "$TIMESTAMP" "$BASE_URL/$ZIP" "$ABI" <<'PY'
import json, os, sys
version, checksum, timestamp, url, abi = sys.argv[1:6]
path = 'repo/manifest.json'

entry = {
    "version": version,
    "changelog": "See README.",
    "targetAbi": abi,
    "sourceUrl": url,
    "checksum": checksum,
    "timestamp": timestamp,
}

# Keep older versions so existing installs can still resolve them.
manifest = []
if os.path.exists(path):
    with open(path) as fh:
        manifest = json.load(fh)

if manifest:
    plugin = manifest[0]
    plugin["versions"] = [v for v in plugin.get("versions", []) if v["version"] != version]
    plugin["versions"].insert(0, entry)
else:
    manifest = [{
        "guid": "95254fa2-e04d-4718-a529-e32c5ef4a170",
        "name": "Clip Export",
        "description": "Adds Set In / Set Out / Export buttons to the video player OSD. The server cuts the selected range out of the original file with its own ffmpeg and sends it to the browser as a download.",
        "overview": "Export clips from movies and episodes to your Downloads folder",
        "owner": "circle3451",
        "category": "General",
        "imageUrl": "",
        "versions": [entry],
    }]

with open(path, 'w') as fh:
    json.dump(manifest, fh, indent=4)
print(f"   {path}: {version} ({checksum})")
PY

echo
echo "Repository ready. Serve the repo/ directory, then add this URL in"
echo "Jellyfin under Dashboard > Plugins > Repositories:"
echo
echo "    $BASE_URL/manifest.json"
