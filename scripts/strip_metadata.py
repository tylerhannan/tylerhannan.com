#!/usr/bin/env python3
"""Strip a JPEG down to what it needs to display: pixels, colour profile, orientation.

    python3 scripts/strip_metadata.py photo.jpg [more.jpg ...]   (rewrites in place)

Keeps APP0 (JFIF), APP2 (ICC colour profile) and Adobe APP14 (colour transform), and replaces EXIF
with a minimal block holding only the Orientation tag. Everything else goes: EXIF (GPS, camera and lens
serial numbers, owner), XMP (Lightroom location, keywords), IPTC/APP13 (city, sublocation, country),
comments and any other application segments. Allow-listing means new kinds of metadata are dropped too.

Stdlib only. Exits non-zero, leaving the file untouched, if the file isn't a JPEG it can parse.
"""
import struct
import sys

KEEP = {0xE0, 0xE2, 0xEE}  # APP0 JFIF, APP2 ICC profile, APP14 Adobe


def orientation(exif):
    """Read the Orientation tag (0x0112) from an EXIF APP1 body, or None."""
    if not exif.startswith(b"Exif\0\0") or len(exif) < 14:
        return None
    t = exif[6:]
    e = {b"II": "<", b"MM": ">"}.get(t[:2])
    if not e:
        return None
    ifd = struct.unpack(e + "I", t[4:8])[0]
    if ifd + 2 > len(t):
        return None
    for k in range(struct.unpack(e + "H", t[ifd:ifd + 2])[0]):
        ent = ifd + 2 + 12 * k
        if ent + 12 > len(t):
            return None
        tag, typ = struct.unpack(e + "HH", t[ent:ent + 4])
        if tag == 0x0112 and typ == 3:
            return struct.unpack(e + "H", t[ent + 8:ent + 10])[0]
    return None


def orientation_app1(value):
    """A minimal big-endian EXIF block: IFD0 with a single Orientation entry."""
    tiff = b"MM\0*" + struct.pack(">I", 8) + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, value, 0) + struct.pack(">I", 0)
    body = b"Exif\0\0" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body


def strip(data):
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    out, i, orient = [b"\xff\xd8"], 2, None
    while True:
        if i + 4 > len(data) or data[i] != 0xFF:
            raise ValueError("unexpected data at byte %d" % i)
        marker = data[i + 1]
        if marker == 0xDA:  # start of scan: the rest is image data
            break
        n = struct.unpack(">H", data[i + 2:i + 4])[0]
        seg = data[i:i + 2 + n]
        if len(seg) != 2 + n:
            raise ValueError("truncated segment at byte %d" % i)
        if marker == 0xE1 and orient is None:
            orient = orientation(seg[4:])
        if marker in KEEP or not (0xE0 <= marker <= 0xEF or marker == 0xFE):
            out.append(seg)  # keep wanted APPn and all non-metadata segments (tables, frame header)
        i += 2 + n
    if orient and orient != 1:
        out.insert(1, orientation_app1(orient))
    out.append(data[i:])
    return b"".join(out)


def main(paths):
    for p in paths:
        with open(p, "rb") as f:
            data = f.read()
        cleaned = strip(data)
        with open(p, "wb") as f:
            f.write(cleaned)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
