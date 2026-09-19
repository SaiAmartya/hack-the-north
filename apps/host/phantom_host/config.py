"""Host configuration. Secrets come from the environment only.

Everything is overridable so tests can disable the serial port, camera, and
Director without touching real hardware or the network.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# Espressif's USB vendor ID. The badge IDE asks for a "USB JTAG/serial debug
# unit (Espressif)", which is this VID.
ESPRESSIF_VID = 0x303A


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass
class Settings:
    # Leave serial_port empty to auto-detect. macOS renumbers /dev/cu.usbmodem*
    # on every replug, so a hard-coded port is a predictable demo failure.
    serial_port: str | None = None
    serial_baudrate: int = 115200
    serial_enabled: bool = True

    camera_index: int = 0
    camera_enabled: bool = True
    camera_fps: int = 10
    camera_max_width: int = 960

    director_enabled: bool = True
    director_first_request_ms: int = 6000
    director_interval_ms: int = 20000
    openai_model: str = "gpt-4o-mini"
    openai_api_key: str | None = None
    openai_timeout_s: float = 5.0

    # Bind to loopback only: this socket carries webcam frames and has no auth.
    bind_host: str = "127.0.0.1"
    bind_port: int = 8000
    tick_hz: int = 20

    marker_ids: dict[int, str] = field(
        default_factory=lambda: {17: "P1", 23: "P2"}
    )

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            serial_port=os.environ.get("PHANTOM_SERIAL_PORT") or None,
            serial_baudrate=_env_int("PHANTOM_SERIAL_BAUDRATE", 115200),
            serial_enabled=_env_bool("PHANTOM_SERIAL_ENABLED", True),
            camera_index=_env_int("PHANTOM_CAMERA_INDEX", 0),
            camera_enabled=_env_bool("PHANTOM_CAMERA_ENABLED", True),
            director_enabled=_env_bool("PHANTOM_DIRECTOR_ENABLED", True),
            openai_model=os.environ.get("PHANTOM_OPENAI_MODEL", "gpt-4o-mini"),
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
            bind_host=os.environ.get("PHANTOM_BIND_HOST", "127.0.0.1"),
            bind_port=_env_int("PHANTOM_BIND_PORT", 8000),
        )


def find_serial_port() -> str | None:
    """Best guess at the gateway badge's serial device.

    Prefers an Espressif VID, then a macOS usbmodem device, then nothing. Never
    raises: a missing port is a normal state the host retries out of.
    """
    try:
        from serial.tools import list_ports
    except ImportError:  # pragma: no cover - pyserial is a hard dependency
        return None

    ports = list(list_ports.comports())

    for port in ports:
        if getattr(port, "vid", None) == ESPRESSIF_VID:
            return port.device

    for port in ports:
        device = port.device or ""
        if "usbmodem" in device or "usbserial" in device:
            return device

    return None
