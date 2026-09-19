"""Marker tracking tests.

No webcam is available to the test suite, so frames are synthesized: real ArUco
markers rendered by OpenCV and pasted at known positions.
"""

from __future__ import annotations

import base64
import threading

import cv2
import numpy as np
import pytest

from phantom_host.vision import (
    MARKER_DICTIONARY,
    CameraWorker,
    MarkerTracker,
    encode_jpeg_base64,
    generate_marker_image,
)

FRAME_WIDTH = 960
FRAME_HEIGHT = 540
MARKER_PIXELS = 120
QUIET_ZONE = 20


def blank_frame() -> np.ndarray:
    return np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 255, dtype=np.uint8)


def paste_marker(frame: np.ndarray, marker_id: int, left: int, top: int) -> tuple[float, float]:
    """Draw a marker with its required quiet zone. Returns its expected center."""
    marker = generate_marker_image(marker_id, MARKER_PIXELS)
    padded = cv2.copyMakeBorder(
        marker,
        QUIET_ZONE,
        QUIET_ZONE,
        QUIET_ZONE,
        QUIET_ZONE,
        cv2.BORDER_CONSTANT,
        value=255,
    )
    size = padded.shape[0]
    frame[top : top + size, left : left + size] = cv2.cvtColor(
        padded, cv2.COLOR_GRAY2BGR
    )

    center_x = (left + size / 2) / FRAME_WIDTH
    center_y = (top + size / 2) / FRAME_HEIGHT
    return center_x, center_y


@pytest.fixture()
def tracker() -> MarkerTracker:
    return MarkerTracker(marker_ids={17: "P1", 23: "P2"})


def test_a_frame_with_marker_seventeen_locates_p1_only(tracker: MarkerTracker) -> None:
    frame = blank_frame()
    expected_x, expected_y = paste_marker(frame, 17, left=120, top=140)

    poses = tracker.update(frame)

    assert poses["P1"].visible is True
    assert poses["P1"].x == pytest.approx(expected_x, abs=0.02)
    assert poses["P1"].y == pytest.approx(expected_y, abs=0.02)
    assert poses["P2"].visible is False


def test_an_empty_frame_returns_two_neutral_invisible_poses(
    tracker: MarkerTracker,
) -> None:
    poses = tracker.update(blank_frame())

    assert set(poses) == {"P1", "P2"}
    for pose in poses.values():
        assert pose.visible is False
        assert 0.0 <= pose.x <= 1.0
        assert 0.0 <= pose.y <= 1.0


def test_both_markers_are_tracked_independently(tracker: MarkerTracker) -> None:
    frame = blank_frame()
    p1_x, _ = paste_marker(frame, 17, left=80, top=200)
    p2_x, _ = paste_marker(frame, 23, left=640, top=200)

    poses = tracker.update(frame)

    assert poses["P1"].visible is True
    assert poses["P2"].visible is True
    assert poses["P1"].x == pytest.approx(p1_x, abs=0.02)
    assert poses["P2"].x == pytest.approx(p2_x, abs=0.02)
    assert poses["P1"].x < poses["P2"].x


def test_a_marker_that_is_not_ours_is_ignored(tracker: MarkerTracker) -> None:
    frame = blank_frame()
    paste_marker(frame, 42, left=300, top=200)

    poses = tracker.update(frame)
    assert poses["P1"].visible is False
    assert poses["P2"].visible is False


def test_losing_a_marker_reports_invisible_rather_than_a_stale_position(
    tracker: MarkerTracker,
) -> None:
    """Misattributing a health bar is worse than not anchoring it."""
    frame = blank_frame()
    paste_marker(frame, 17, left=120, top=140)
    first = tracker.update(frame)
    assert first["P1"].visible is True
    located_at = first["P1"].x

    second = tracker.update(blank_frame())
    assert second["P1"].visible is False
    # The remembered position may be reported, but never as if it were current.
    assert second["P1"].x != located_at or second["P1"].visible is False


def test_swapped_marker_ids_swap_the_players() -> None:
    """A mis-taped marker must produce obviously wrong sides, not silent garbage."""
    frame = blank_frame()
    paste_marker(frame, 17, left=80, top=200)

    swapped = MarkerTracker(marker_ids={17: "P2", 23: "P1"})
    poses = swapped.update(frame)
    assert poses["P2"].visible is True
    assert poses["P1"].visible is False


def test_a_none_frame_is_handled_as_a_dropped_capture(tracker: MarkerTracker) -> None:
    poses = tracker.update(None)
    assert poses["P1"].visible is False
    assert poses["P2"].visible is False


def test_normalized_coordinates_stay_inside_the_unit_square(
    tracker: MarkerTracker,
) -> None:
    frame = blank_frame()
    paste_marker(frame, 17, left=FRAME_WIDTH - MARKER_PIXELS - 2 * QUIET_ZONE, top=0)

    poses = tracker.update(frame)
    assert poses["P1"].visible is True
    assert 0.0 <= poses["P1"].x <= 1.0
    assert 0.0 <= poses["P1"].y <= 1.0


# ---------------------------------------------------------------------------
# frame encoding
# ---------------------------------------------------------------------------


def test_jpeg_encoding_returns_decodable_base64() -> None:
    encoded = encode_jpeg_base64(blank_frame(), max_width=960)
    assert encoded is not None

    raw = base64.b64decode(encoded)
    assert raw[:2] == b"\xff\xd8", "JPEG start of image marker"

    decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None
    assert decoded.shape[1] == FRAME_WIDTH


def test_jpeg_encoding_caps_the_width() -> None:
    wide = np.full((1080, 1920, 3), 128, dtype=np.uint8)
    encoded = encode_jpeg_base64(wide, max_width=960)
    assert encoded is not None

    decoded = cv2.imdecode(
        np.frombuffer(base64.b64decode(encoded), dtype=np.uint8), cv2.IMREAD_COLOR
    )
    assert decoded is not None
    assert decoded.shape[1] == 960
    assert decoded.shape[0] == 540, "aspect ratio preserved"


def test_jpeg_encoding_does_not_upscale_a_small_frame() -> None:
    small = np.full((120, 160, 3), 64, dtype=np.uint8)
    encoded = encode_jpeg_base64(small, max_width=960)
    decoded = cv2.imdecode(
        np.frombuffer(base64.b64decode(encoded or ""), dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    assert decoded is not None
    assert decoded.shape[1] == 160


def test_encoding_none_returns_none() -> None:
    assert encode_jpeg_base64(None, max_width=960) is None


def test_generated_markers_are_detectable_round_trip() -> None:
    """Guards the printable asset: what we generate must be what we detect."""
    detector = cv2.aruco.ArucoDetector(
        cv2.aruco.getPredefinedDictionary(MARKER_DICTIONARY),
        cv2.aruco.DetectorParameters(),
    )
    for marker_id in (17, 23):
        frame = blank_frame()
        paste_marker(frame, marker_id, left=300, top=150)
        _corners, ids, _rejected = detector.detectMarkers(frame)
        assert ids is not None
        assert marker_id in ids.flatten().tolist()


# ---------------------------------------------------------------------------
# camera worker
# ---------------------------------------------------------------------------


class FakeCapture:
    def __init__(
        self,
        frames: list[np.ndarray | None],
        *,
        opens: bool = True,
        stop_when_done: threading.Event | None = None,
    ) -> None:
        self._frames = list(frames)
        self._opens = opens
        # Lets a test model a clean shutdown rather than a camera failure.
        self._stop_when_done = stop_when_done
        self.released = False

    def isOpened(self) -> bool:  # noqa: N802 - matches the cv2 API
        return self._opens

    def read(self) -> tuple[bool, np.ndarray | None]:
        if not self._frames:
            if self._stop_when_done is not None:
                self._stop_when_done.set()
            return False, None
        frame = self._frames.pop(0)
        if not self._frames and self._stop_when_done is not None:
            self._stop_when_done.set()
        return (frame is not None), frame

    def release(self) -> None:
        self.released = True


def test_camera_worker_publishes_poses_and_a_frame(tracker: MarkerTracker) -> None:
    frame = blank_frame()
    paste_marker(frame, 17, left=120, top=140)

    stop = threading.Event()
    capture = FakeCapture([frame, frame], stop_when_done=stop)
    worker = CameraWorker(
        tracker,
        fps=1000,
        max_width=640,
        capture_factory=lambda _index: capture,
    )

    # Daemon, so a bug here can never wedge the test run the way it once did.
    thread = threading.Thread(target=worker.run, args=(stop,), daemon=True)
    thread.start()
    thread.join(timeout=5)

    assert thread.is_alive() is False, "worker must exit once told to stop"
    assert worker.frames_read == 2
    assert capture.released is True
    assert worker.frame_jpeg_base64 is not None
    assert worker.markers["P1"].visible is True
    assert worker.markers["P2"].visible is False


def test_camera_worker_survives_a_camera_that_never_opens(
    tracker: MarkerTracker,
) -> None:
    """On macOS a missing Camera permission fails quietly rather than raising."""
    capture = FakeCapture([], opens=False)
    worker = CameraWorker(tracker, capture_factory=lambda _index: capture)

    worker.run(threading.Event())

    assert worker.available is False
    assert worker.frame_jpeg_base64 is None
    assert worker.markers["P1"].visible is False
    assert worker.markers["P2"].visible is False


def test_camera_worker_reports_invisible_markers_on_a_dropped_capture(
    tracker: MarkerTracker,
) -> None:
    good = blank_frame()
    paste_marker(good, 17, left=120, top=140)

    capture = FakeCapture([good, None])
    worker = CameraWorker(
        tracker,
        fps=1000,
        capture_factory=lambda _index: capture,
        max_consecutive_failures=2,
    )
    worker.run(threading.Event())

    assert worker.frames_read == 1
    assert worker.markers["P1"].visible is False
    assert worker.frame_jpeg_base64 is None


def test_camera_worker_gives_up_on_a_camera_that_stops_delivering(
    tracker: MarkerTracker,
) -> None:
    """A camera unplugged mid-demo must not spin forever; it must release and
    let the arena fall back to corner HUDs."""
    capture = FakeCapture([])
    worker = CameraWorker(
        tracker,
        fps=1000,
        capture_factory=lambda _index: capture,
        max_consecutive_failures=4,
    )

    worker.run(threading.Event())

    assert worker.read_failures == 4
    assert worker.available is False
    assert capture.released is True


def test_camera_worker_recovers_from_an_isolated_dropped_frame(
    tracker: MarkerTracker,
) -> None:
    """One bad read must not count towards the give-up limit forever."""
    good = blank_frame()
    paste_marker(good, 17, left=120, top=140)

    capture = FakeCapture([good, None, good, None, good])
    worker = CameraWorker(
        tracker,
        fps=1000,
        capture_factory=lambda _index: capture,
        max_consecutive_failures=2,
    )
    worker.run(threading.Event())

    assert worker.frames_read == 3, "intermittent failures did not stop the worker"


def test_camera_worker_stops_promptly_when_asked(tracker: MarkerTracker) -> None:
    stop = threading.Event()
    stop.set()
    capture = FakeCapture([blank_frame()])
    worker = CameraWorker(tracker, capture_factory=lambda _index: capture)

    worker.run(stop)

    assert worker.frames_read == 0
    assert capture.released is True
