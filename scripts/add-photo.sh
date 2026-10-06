#!/bin/sh
# Resize a photo for the web and add it to public/photos.json.
#
#   scripts/add-photo.sh ~/Pictures/IMG_1234.jpg "Title" "Place" "2026-09"
#
# Uses macOS's built-in `sips`: longest side 2000px, JPEG quality 82.
# Remove the "example": true entries from public/photos.json once you have real ones.
set -e
src="$1"; title="$2"; place="$3"; date="$4"
[ -f "$src" ] && [ -n "$title" ] || { echo "usage: $0 <photo> \"Title\" [\"Place\"] [\"YYYY-MM\"]"; exit 1; }

cd "$(dirname "$0")/.."
name=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//').jpg
sips -Z 2000 -s format jpeg -s formatOptions 82 "$src" --out "public/photos/$name" >/dev/null

python3 - "$name" "$title" "$place" "$date" <<'PY'
import json, sys
name, title, place, date = sys.argv[1:5]
p = "public/photos.json"
d = json.load(open(p))
d["photos"].insert(0, {"file": name, "title": title, "place": place, "date": date, "camera": "", "alt": ""})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
echo "Added public/photos/$name ($(du -h "public/photos/$name" | cut -f1))"
