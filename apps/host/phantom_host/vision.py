"""Webcam marker tracking.

Two printed ArUco markers tell the host where each player is standing, so the
health plates can be drawn above them. This is presentation only: no hit
detection depends on it, and losing a marker degrades to a fixed corner HUD.

The one rule that matters: a marker that is not currently detected reports
``visible=False``. Reusing a stale position would eventually attribute a health
bar to the wrong person, which is worse than not anchoring it at all.
"""

from __future__ import annotations

import base64
import logging
import threading
import time
from typing import Any

import cv2
import numpy as np

from phantom_host.contracts import MarkerPose

logger = logging.getLogger(__name__)

# 4x4 markers stay readable on a lanyard at stage distance and the dictionary is
# small, which keeps false positives low.
MARKER_DICTIONARY = cv2.aruco.DICT_4X4_50
JPEG_QUALITY = 72


def generate_marker_image(marker_id: int, side_pixels: int) -> np.ndarray:
    dictionary = cv2.aruco.getPredefinedDictionary(MARKER_DICTIONARY)
    return cv2.aruco.generateImageMarker(dictionary, marker_id, side_pixels)


def encode_jpeg_base64(frame: np.ndarray | None, max_width: int) -> str | None:
    """JPEG encode a frame for the websocket, capped at ``max_width``."""
    if frame is None or getattr(frame, "size", 0) == 0:
        return None

    height, width = frame.shape[:2]
    if width > max_width:
        scale = max_width / width
        frame = cv2.resize(
            frame,
            (max_width, max(1, int(round(height * scale)))),
            interpolation=cv2.INTER_AREA,
        )

    ok, buffer = cv2.imencode(
        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
    )
    if not ok:
        return None
    return base64.b64encode(buffer.tobytes()).decode("ascii")


class MarkerTracker:
    def __init__(self, marker_ids: dict[int, str]) -> None:
        self.marker_ids = dict(marker_ids)
        self.player_ids = sorted(set(marker_ids.values()))
        self._detector = cv2.aruco.ArucoDetector(
            cv2.aruco.getPredefinedDictionary(MARKER_DICTIONARY),
            cv2.aruco.DetectorParameters(),
        )
        # Remembered only so an unanchored plate can appear near where the player
        # last was. Never reported as visible.
        self._last_seen: dict[str, tuple[float, float]] = {}

    def update(self, frame: np.ndarray | None) -> dict[str, MarkerPose]:
        found: dict[str, tuple[float, float]] = {}

        if frame is not None and getattr(frame, "size", 0) > 0:
            height, width = frame.shape[:2]
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            corners, ids, _rejected = self._detector.detectMarkers(gray)

            if ids is not None:
                for marker_corners, marker_id in zip(corners, ids.flatten().tolist()):
                    player_id = self.marker_ids.get(int(marker_id))
                    if player_id is None:
                        continue
                    points = marker_corners.reshape(-1, 2)
                    center_x = float(points[:, 0].mean()) / width
                    center_y = float(points[:, 1].mean()) / height
                    found[player_id] = (
                        min(1.0, max(0.0, center_x)),
                        min(1.0, max(0.0, center_y)),
                    )

        poses: dict[str, MarkerPose] = {}
        for player_id in self.player_ids:
            if player_id in found:
                x, y = found[player_id]
                self._last_seen[player_id] = (x, y)
                poses[player_id] = MarkerPose(
                    player_id=player_id,  # type: ignore[arg-type]
                    x=x,
                    y=y,
                    visible=True,
                )
            else:
                x, y = self._last_seen.get(player_id, (0.5, 0.5))
                poses[player_id] = MarkerPose(
                    player_id=player_id,  # type: ignore[arg-type]
                    x=x,
                    y=y,
                    visible=False,
                )
        return poses


class CameraWorker:
    """Reads the webcam on its own thread and publishes poses plus a JPEG.

    OpenCV capture is blocking, so it cannot live in the event loop. The frame
    cadence is independent of the state tick: a cast never waits for a frame.
    """

    def __init__(
        self,
        tracker: MarkerTracker,
        *,
        camera_index: int = 0,
        fps: int = 10,
        max_width: int = 960,
        capture_factory: Any = None,
        max_consecutive_failures: int = 30,
    ) -> None:
        self.tracker = tracker
        self.camera_index = camera_index
        self.fps = max(1, fps)
        self.max_width = max_width
        self._capture_factory = capture_factory or cv2.VideoCapture
        # A camera unplugged mid-demo otherwise spins at the frame interval
        # forever. 30 failures is about three seconds at 10 fps.
        self.max_consecutive_failures = max_consecutive_failures

        self.markers: dict[str, MarkerPose] = tracker.update(None)
        self.frame_jpeg_base64: str | None = None
        self.available = False
        self.frames_read = 0
        self.read_failures = 0

    def run(self, stop: threading.Event) -> None:
        interval = 1.0 / self.fps
        capture = None
        consecutive_failures = 0

        try:
            capture = self._capture_factory(self.camera_index)
            if not capture.isOpened():
                # On macOS this is usually a missing Camera permission for the
                # terminal, which fails quietly rather than raising.
                logger.warning(
                    "camera %s did not open; corner HUDs will be used",
                    self.camera_index,
                )
                self.available = False
                return

            self.available = True
            logger.info("camera %s open", self.camera_index)

            while not stop.is_set():
                started = time.monotonic()
                ok, frame = capture.read()

                if not ok:
                    consecutive_failures += 1
                    self.read_failures += 1
                    self.markers = self.tracker.update(None)
                    self.frame_jpeg_base64 = None
                    if consecutive_failures >= self.max_consecutive_failures:
                        logger.warning(
                            "camera %s stopped delivering frames after %d failures;"
                            " falling back to corner HUDs",
                            self.camera_index,
                            consecutive_failures,
                        )
                        return
                else:
                    consecutive_failures = 0
                    self.frames_read += 1
                    self.markers = self.tracker.update(frame)
                    self.frame_jpeg_base64 = encode_jpeg_base64(frame, self.max_width)

                elapsed = time.monotonic() - started
                stop.wait(max(0.0, interval - elapsed))
        except Exception as error:  # pragma: no cover - camera stacks vary wildly
            logger.warning("camera worker stopped: %s", error)
        finally:
            self.available = False
            if capture is not None:
                try:
                    capture.release()
                except Exception:
                    pass

    def start(self) -> tuple[threading.Thread, threading.Event]:
        stop = threading.Event()
        thread = threading.Thread(
            target=self.run, args=(stop,), name="camera", daemon=True
        )
        thread.start()
        return thread, stop
