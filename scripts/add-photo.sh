#!/bin/sh
# Resize a photo for the web, strip its metadata, and add it to public/photos.json.
#
#   scripts/add-photo.sh ~/Pictures/Export/IMG_1234.jpg "Title" "Place" "2026-09"
#
# Uses macOS's built-in `sips`: longest side at most 2000px (never enlarged), JPEG quality 82, plus a
# 600px thumbnail for the grid. scripts/strip_metadata.py then removes everything but the pixels, colour
# profile and orientation (no GPS, place names, camera serials). The photo is built in a temp file and
# only moved into public/ once it's clean, so an unstripped copy can never end up published.
set -eu
src="${1:-}"; title="${2:-}"; place="${3:-}"; date="${4:-}"
usage() { echo "usage: $0 <photo> \"Title\" \"Place\" \"YYYY-MM\"" >&2; exit 1; }
[ -f "$src" ] && [ -n "$title" ] || usage
echo "$date" | grep -Eq '^[0-9]{4}-(0[1-9]|1[0-2])$' || { echo "date must be YYYY-MM, got '$date'" >&2; usage; }
src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"   # absolute, before we cd

cd "$(dirname "$0")/.."
name=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')
[ -n "$name" ] || { echo "the title needs some letters or digits to make a filename" >&2; exit 1; }
name="$name.jpg"
[ ! -e "public/photos/$name" ] || { echo "public/photos/$name already exists; pick a different title" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Only shrink: sips -Z would also enlarge smaller photos, which just makes them blurry.
w=$(sips -g pixelWidth "$src" | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$src" | awk '/pixelHeight/{print $2}')
[ -n "$w" ] && [ -n "$h" ] || { echo "sips can't read $src as an image" >&2; exit 1; }
if [ "$w" -gt 2000 ] || [ "$h" -gt 2000 ]; then resize="-Z 2000"; else resize=""; fi
sips $resize -s format jpeg -s formatOptions 82 "$src" --out "$tmp/photo.jpg" >/dev/null
python3 scripts/strip_metadata.py "$tmp/photo.jpg"
sips -Z 600 -s format jpeg -s formatOptions 72 "$tmp/photo.jpg" --out "$tmp/thumb.jpg" >/dev/null
python3 scripts/strip_metadata.py "$tmp/thumb.jpg"

mkdir -p public/photos/thumbs
mv "$tmp/photo.jpg" "public/photos/$name"
mv "$tmp/thumb.jpg" "public/photos/thumbs/$name"

python3 - "$name" "$title" "$place" "$date" <<'PY'
import json, sys
name, title, place, date = sys.argv[1:5]
p = "public/photos.json"
d = json.load(open(p))
d["photos"].insert(0, {"file": name, "title": title, "place": place, "date": date, "camera": "", "alt": ""})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
echo "Added public/photos/$name ($(du -h "public/photos/$name" | cut -f1)) and its thumbnail"
