#!/usr/bin/env python3
"""Make a 42x42 launcher icon (icon.bin, LVGL v9 RGB565A8, 5,304 bytes) for a badge app.

    python tools/make_icon.py --draw --out badge/phantom_arena/icon.bin     # built-in phantom art
    python tools/make_icon.py --png my_art.png --out badge/phantom_arena/icon.bin

The badge IDE's "Choose image" button produces the same format; this script exists so
the icon can live in the repo and ride along with OTA Share. Format (little-endian):
    12-byte header: magic 0x19, cf 0x14 (RGB565A8), flags u16, w u16, h u16, stride u16 (w*2), reserved u16
    then w*h*2 bytes RGB565, then w*h bytes alpha.
Verified arithmetically against the IDE's 5,304-byte output (12 + 42*42*3); test it on
a badge before relying on it for a demo.
"""
from __future__ import annotations

import argparse
import struct
from pathlib import Path

SIZE = 42
LV_IMAGE_HEADER_MAGIC = 0x19
LV_COLOR_FORMAT_RGB565A8 = 0x14


def draw_phantom():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, 39, 39), fill=(24, 12, 48, 255))
    d.ellipse((4, 4, 37, 37), outline=(255, 204, 85, 255), width=2)
    # ghost body
    d.rounded_rectangle((11, 9, 31, 33), radius=10, fill=(235, 235, 255, 255))
    for x in (11, 18, 25):
        d.ellipse((x, 28, x + 6, 35), fill=(24, 12, 48, 255))
    d.ellipse((15, 15, 19, 20), fill=(60, 0, 120, 255))
    d.ellipse((23, 15, 27, 20), fill=(60, 0, 120, 255))
    # lightning bolt
    d.polygon([(30, 4), (24, 15), (29, 15), (25, 26), (34, 12), (29, 12)], fill=(80, 140, 255, 255))
    return img


def encode(img) -> bytes:
    img = img.convert("RGBA").resize((SIZE, SIZE))
    px = img.load()
    rgb, alpha = bytearray(), bytearray()
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, a = px[x, y]
            v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            rgb += struct.pack("<H", v)
            alpha.append(a)
    header = struct.pack("<BBHHHHH", LV_IMAGE_HEADER_MAGIC, LV_COLOR_FORMAT_RGB565A8, 0, SIZE, SIZE, SIZE * 2, 0)
    out = header + bytes(rgb) + bytes(alpha)
    assert len(out) == 5304, len(out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", help="source image (any size, resized to 42x42)")
    ap.add_argument("--draw", action="store_true", help="use the built-in phantom artwork")
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", help="also save a PNG preview of the icon")
    a = ap.parse_args()
    from PIL import Image
    img = draw_phantom() if a.draw or not a.png else Image.open(a.png)
    Path(a.out).write_bytes(encode(img))
    if a.preview:
        img.convert("RGBA").resize((SIZE, SIZE)).save(a.preview)
    print(f"wrote {a.out} (5304 bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
