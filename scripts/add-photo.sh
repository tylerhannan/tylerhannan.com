#!/bin/sh
# Resize a photo for the web and add it to public/photos.json.
#
#   scripts/add-photo.sh ~/Pictures/IMG_1234.jpg "Title" "Place" "2026-09"
#
# Uses macOS's built-in `sips`: longest side at most 2000px (never enlarged), JPEG quality 82.
# Remove the "example": true entries from public/photos.json once you have real ones.
set -e
src="$1"; title="$2"; place="$3"; date="$4"
[ -f "$src" ] && [ -n "$title" ] || { echo "usage: $0 <photo> \"Title\" [\"Place\"] [\"YYYY-MM\"]"; exit 1; }

cd "$(dirname "$0")/.."
name=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//').jpg
# Only shrink: sips -Z would also enlarge smaller photos, which just makes them blurry.
w=$(sips -g pixelWidth "$src" | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$src" | awk '/pixelHeight/{print $2}')
if [ "$w" -gt 2000 ] || [ "$h" -gt 2000 ]; then resize="-Z 2000"; else resize=""; fi
sips $resize -s format jpeg -s formatOptions 82 "$src" --out "public/photos/$name" >/dev/null

python3 - "$name" "$title" "$place" "$date" <<'PY'
import json, struct, sys
name, title, place, date = sys.argv[1:5]

# Strip location data. sips keeps EXIF, so GPS coordinates would otherwise go public.
# Empties the EXIF GPS block and drops XMP (Lightroom also writes GPS there). Other EXIF stays.
f = "public/photos/" + name
b = bytearray(open(f, "rb").read())
out, i = bytearray(b[:2]), 2
while i + 4 <= len(b) and b[i] == 0xFF and b[i + 1] not in (0xDA, 0xD9):
    n = struct.unpack(">H", b[i + 2:i + 4])[0]
    seg = b[i:i + 2 + n]
    body = seg[4:]
    if seg[1] == 0xE1 and body.startswith(b"http://ns.adobe.com/xap/1.0/"):
        i += 2 + n
        continue
    if seg[1] == 0xE1 and body.startswith(b"Exif\0\0"):
        t = 10  # TIFF header offset inside seg
        e = "<" if seg[t:t + 2] == b"II" else ">"
        ifd = t + struct.unpack(e + "I", seg[t + 4:t + 8])[0]
        for k in range(struct.unpack(e + "H", seg[ifd:ifd + 2])[0]):
            ent = ifd + 2 + 12 * k
            if struct.unpack(e + "H", seg[ent:ent + 2])[0] == 0x8825:
                gps = t + struct.unpack(e + "I", seg[ent + 8:ent + 12])[0]
                seg[gps:gps + 2] = struct.pack(e + "H", 0)
    out += seg
    i += 2 + n
out += b[i:]
open(f, "wb").write(out)

p = "public/photos.json"
d = json.load(open(p))
d["photos"].insert(0, {"file": name, "title": title, "place": place, "date": date, "camera": "", "alt": ""})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
# grid thumbnail, made from the location-stripped copy above
mkdir -p public/photos/thumbs
sips -Z 600 -s format jpeg -s formatOptions 72 "public/photos/$name" --out "public/photos/thumbs/$name" >/dev/null
echo "Added public/photos/$name ($(du -h "public/photos/$name" | cut -f1))"
