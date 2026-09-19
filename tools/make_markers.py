#!/usr/bin/env python3
"""Generate the printable ArUco markers for P1 and P2.

    python tools/make_markers.py

Writes assets/markers/p1-marker.png, p2-marker.png, and print-sheet.png.

Print the sheet at 100% scale (no "fit to page") and tape one marker to each
player. Keep the white border: ArUco detection needs that quiet zone. The IDs
must match Settings.marker_ids, which is 17 -> P1 and 23 -> P2.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST_DIR = REPO_ROOT / "apps" / "host"
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

from phantom_host.vision import generate_marker_image  # noqa: E402

OUTPUT_DIR = REPO_ROOT / "assets" / "markers"

# 300 DPI. A 100 mm marker is readable across a stage from a laptop webcam.
DPI = 300
MARKER_MM = 100
QUIET_MM = 12
MARKERS = [(17, "P1", "p1-marker.png"), (23, "P2", "p2-marker.png")]


def mm_to_px(mm: float) -> int:
    return int(round(mm / 25.4 * DPI))


def build_marker(marker_id: int, label: str) -> np.ndarray:
    side = mm_to_px(MARKER_MM)
    quiet = mm_to_px(QUIET_MM)

    marker = generate_marker_image(marker_id, side)
    padded = cv2.copyMakeBorder(
        marker, quiet, quiet, quiet, quiet, cv2.BORDER_CONSTANT, value=255
    )
    canvas = cv2.cvtColor(padded, cv2.COLOR_GRAY2BGR)

    caption_height = mm_to_px(14)
    caption = np.full((caption_height, canvas.shape[1], 3), 255, dtype=np.uint8)
    cv2.putText(
        caption,
        f"{label}   ArUco 4x4_50 id {marker_id}",
        (quiet // 2, int(caption_height * 0.68)),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.6,
        (40, 40, 40),
        3,
        cv2.LINE_AA,
    )
    return np.vstack([canvas, caption])


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tiles = []

    for marker_id, label, filename in MARKERS:
        tile = build_marker(marker_id, label)
        path = OUTPUT_DIR / filename
        cv2.imwrite(str(path), tile)
        print(f"wrote {path.relative_to(REPO_ROOT)}  ({tile.shape[1]}x{tile.shape[0]} px)")
        tiles.append(tile)

    gap = np.full((tiles[0].shape[0], mm_to_px(10), 3), 255, dtype=np.uint8)
    sheet = np.hstack([tiles[0], gap, tiles[1]])
    margin = mm_to_px(10)
    sheet = cv2.copyMakeBorder(
        sheet, margin, margin, margin, margin, cv2.BORDER_CONSTANT, value=(255, 255, 255)
    )

    sheet_path = OUTPUT_DIR / "print-sheet.png"
    cv2.imwrite(str(sheet_path), sheet)
    print(f"wrote {sheet_path.relative_to(REPO_ROOT)}  ({sheet.shape[1]}x{sheet.shape[0]} px)")
    print()
    print(f"Print at 100% scale. Each marker is {MARKER_MM} mm square at {DPI} DPI.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
