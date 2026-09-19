#!/usr/bin/env python3
"""Camera pre-flight. Run this once before the demo.

    python tools/check_camera.py

On macOS, OpenCV capture needs Camera permission for whatever terminal you are
running in, and the first-run prompt can fail quietly. This script triggers the
prompt, confirms frames actually arrive, and reports whether the P1 and P2
markers are currently detectable.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HOST_DIR = Path(__file__).resolve().parents[1] / "apps" / "host"
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

import cv2  # noqa: E402

from phantom_host.config import Settings  # noqa: E402
from phantom_host.vision import MarkerTracker, encode_jpeg_base64  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=int, default=0, help="camera index")
    parser.add_argument("--seconds", type=float, default=6.0, help="how long to sample")
    args = parser.parse_args()

    settings = Settings()
    tracker = MarkerTracker(settings.marker_ids)

    print(f"opening camera {args.index} ...")
    capture = cv2.VideoCapture(args.index)
    if not capture.isOpened():
        print()
        print("FAILED to open the camera.")
        print("On macOS grant Camera access to your terminal:")
        print("  System Settings > Privacy & Security > Camera")
        print("Then run this again. Without a camera the demo still works:")
        print("  the arena falls back to fixed corner HUDs.")
        return 1

    frames = 0
    best: dict[str, bool] = {"P1": False, "P2": False}
    deadline = time.monotonic() + args.seconds

    try:
        while time.monotonic() < deadline:
            ok, frame = capture.read()
            if not ok:
                continue
            frames += 1
            poses = tracker.update(frame)
            for player_id, pose in poses.items():
                if pose.visible:
                    best[player_id] = True

            if frames == 1:
                height, width = frame.shape[:2]
                encoded = encode_jpeg_base64(frame, settings.camera_max_width)
                size_kb = len(encoded or "") / 1024
                print(f"  first frame {width}x{height}, {size_kb:.0f} KB base64 JPEG")

            visible = ", ".join(
                f"{player_id}={'yes' if pose.visible else 'no'}"
                for player_id, pose in sorted(poses.items())
            )
            print(f"  frame {frames:3d}  markers {visible}", end="\r", flush=True)
    finally:
        capture.release()

    print()
    print()
    if frames == 0:
        print("Camera opened but produced no frames. Try a different --index.")
        return 1

    print(f"OK: {frames} frames in {args.seconds:.0f}s")
    for player_id, seen in sorted(best.items()):
        marker_id = next(
            (mid for mid, pid in settings.marker_ids.items() if pid == player_id), "?"
        )
        state = "detected" if seen else "NOT detected"
        print(f"  {player_id} (ArUco id {marker_id}): {state}")

    if not all(best.values()):
        print()
        print("Undetected markers are fine: those players get a fixed corner HUD.")
        print("To print markers: python tools/make_markers.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
