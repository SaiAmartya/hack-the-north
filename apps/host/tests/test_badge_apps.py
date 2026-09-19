"""Static verification of the badge Lua apps.

No badge is available to this test suite, so these checks stand in for hardware
testing. Every rule below comes from badge-app-guide.md, and each one encodes a
failure that would only otherwise appear when the app is opened on a badge.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

BADGES_DIR = Path(__file__).resolve().parents[3] / "badges"
GUIDE = Path(__file__).resolve().parents[3] / "badge-app-guide.md"

MAX_MAIN_LUA_BYTES = 64 * 1024
MAX_RADIO_PAYLOAD_BYTES = 44

# badge.<namespace>.<name> calls documented in badge-app-guide.md. Anything
# outside this set is an invented API and will fail on the badge.
ALLOWED_BADGE_CALLS: set[str] = {
    "ui.label", "ui.box", "ui.bar", "ui.arc", "ui.slider", "ui.image", "ui.line",
    "ui.button", "ui.switch", "ui.checkbox", "ui.roller", "ui.textarea",
    "ui.screen_width", "ui.screen_height", "ui.theme",
    "led.set", "led.set_all", "led.clear", "led.show", "led.count",
    "sensor.accel", "sensor.shake", "sensor.tap", "sensor.orientation",
    "input.BUTTON", "input.KIND", "input.is_down", "input.held",
    "sys.ms", "sys.uptime", "sys.log", "sys.random", "sys.heap", "sys.gc_step",
    "sys.version", "sys.wake_lock", "sys.stats",
    "store.set", "store.get", "store.set_int", "store.get_int",
    "store.set_str", "store.get_str",
    "me.name", "me.role", "me.role_name", "me.color", "me.badge_id",
    "me.provisioned",
    "contacts.count", "contacts.get",
    "app.slug", "app.name", "app.exit",
    "fs.write", "fs.append", "fs.read", "fs.exists", "fs.remove", "fs.list",
    "fs.mkdir",
    "nfc.enable", "nfc.disable", "nfc.card", "nfc.read_text", "nfc.clear",
    "radio.enable", "radio.disable", "radio.send", "radio.on_recv", "radio.mac",
    "radio.dropped",
}

# Absent from the sandbox: base without these, and no os/io/package/debug/coroutine.
# Patterns are word-anchored so that a label like "Starting radio..." does not
# read as a use of the io library.
FORBIDDEN_PATTERNS: dict[str, str] = {
    r"\bpcall\b": "pcall is not in the sandbox; check return values instead",
    r"\bxpcall\b": "xpcall is not in the sandbox",
    r"\bsetmetatable\b": "setmetatable is not in the sandbox",
    r"\bdofile\b": "dofile is not in the sandbox",
    r"\bloadfile\b": "loadfile is not in the sandbox",
    r"\bcoroutine\b": "coroutine is absent; use a tick-driven queue",
    r"\bos\.": "the os library is absent; use badge.sys.ms()",
    r"\bio\.": "the io library is absent; use badge.fs",
    r"\brequire\b": "these apps must be self-contained single files",
    r"\bsleep\b": "there is no sleep API and busy waiting is forbidden",
    r"\bdebug\.": "the debug library is absent",
    r"\bpackage\.": "the package library is absent",
}

BUILTIN_SLUGS = {"dice", "reaction", "share", "sync", "launcher", "settings",
                 "diagnostics", "level", "counter", "light"}

LONG_COMMENT = re.compile(r"--\[(=*)\[.*?\]\1\]", re.DOTALL)
LINE_COMMENT = re.compile(r"--[^\n]*")
BADGE_CALL = re.compile(r"\bbadge\.([A-Za-z_]+)\.([A-Za-z_]+)")


def badge_apps() -> list[Path]:
    return sorted(BADGES_DIR.glob("*.lua"))


def split_app(text: str) -> tuple[dict[str, str], str]:
    """Split the single-file format into manifest keys and the Lua body."""
    match = re.match(r"--\[==\[badge-app\n(.*?)\n\]==\]\n(.*)", text, re.DOTALL)
    assert match, "app must start with a --[==[badge-app ... ]==] manifest header"

    manifest: dict[str, str] = {}
    for line in match.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        assert key not in manifest, f"duplicate manifest key {key}"
        manifest[key.strip()] = value.strip()
    return manifest, match.group(2)


def strip_comments(body: str) -> str:
    return LINE_COMMENT.sub("", LONG_COMMENT.sub("", body))


def test_the_badges_directory_has_all_three_apps() -> None:
    names = {path.name for path in badge_apps()}
    assert names == {
        "phantom_gateway.lua",
        "phantom_chaos.lua",
        "phantom_player.lua",
    }


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_manifest_is_valid(path: Path) -> None:
    manifest, _ = split_app(path.read_text())

    assert manifest["slug"] == path.stem, "slug must match the file name"
    assert re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", manifest["slug"])
    assert manifest["slug"] not in BUILTIN_SLUGS, "cannot shadow a built-in app"
    assert 1 <= len(manifest["name"].encode()) <= 48
    assert 1 <= len(manifest.get("icon", "?").encode()) <= 12
    assert manifest["api"] == "2", "the plan mandates api=2"
    assert manifest.get("heap_kb", "48") in {"48", "96"}

    # Apps only run in the foreground and the badge will otherwise sleep mid-demo,
    # taking the radio listener with it.
    assert manifest["wake_lock"] == "1", "every Phantom app must hold the wake lock"

    assert "home_button" not in manifest, "default HOME exit is intended"
    assert "confirm_home" not in manifest


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_main_lua_fits_the_upload_cap(path: Path) -> None:
    _, body = split_app(path.read_text())
    assert len(body.encode()) < MAX_MAIN_LUA_BYTES


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_uses_no_forbidden_sandbox_features(path: Path) -> None:
    _, body = split_app(path.read_text())
    code = strip_comments(body)
    for pattern, reason in FORBIDDEN_PATTERNS.items():
        match = re.search(pattern, code)
        assert match is None, f"{path.name} uses {match.group(0)!r}: {reason}"


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_only_calls_documented_badge_apis(path: Path) -> None:
    _, body = split_app(path.read_text())
    code = strip_comments(body)
    used = {f"{ns}.{name}" for ns, name in BADGE_CALL.findall(code)}
    unknown = used - ALLOWED_BADGE_CALLS
    assert not unknown, f"{path.name} calls undocumented badge APIs: {sorted(unknown)}"


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_the_radio_is_enabled_before_any_widget_is_created(path: Path) -> None:
    """Hardware-confirmed ordering bug, do not regress.

    On the ESP32-C3 badge the BLE stack needs about 47 KB and only ~78 KB is free
    when an app opens. Building the UI first consumed 30 KB and enable() then
    failed with "hal_radio: host sync timeout" at 576 bytes free; an earlier
    attempt crashed the badge in ble_hs_init. The radio must be claimed before
    any widget allocation.
    """
    _, body = split_app(path.read_text())
    enter = body.split("function on_enter(", 1)[1].split("\nend\n", 1)[0]

    enable_at = enter.find("badge.radio.enable()")
    assert enable_at >= 0, "on_enter must claim the radio"

    first_ui = re.search(r"badge\.ui\.\w+|build_\w*_ui\s*\(", enter)
    if first_ui is not None:
        assert enable_at < first_ui.start(), (
            f"{path.name}: radio.enable() must come before {first_ui.group(0)!r}"
        )


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_widget_count_stays_modest(path: Path) -> None:
    """Every widget is memory the BLE stack cannot have."""
    _, body = split_app(path.read_text())
    widgets = len(re.findall(r"badge\.ui\.\w+\(", strip_comments(body)))
    assert widgets <= 10, f"{path.name} creates {widgets} widgets"


def test_the_player_app_does_not_duplicate_host_game_rules() -> None:
    """The badge must not simulate rules it can never have corrected.

    The radio is one way, so a local mana counter never learns about Mana Rain.
    It used to refuse to send when its private counter said no, which silently
    swallowed a legal Ultimate at the exact moment the projector said MANA RAIN.
    A flat send-rate cap is fine: that is radio hygiene, not a game rule.
    """
    body = (BADGES_DIR / "phantom_player.lua").read_text()
    code = strip_comments(body)

    for banned in ("cooldown_until", "MANA_MAX", "MANA_REGEN", "spell.cost"):
        assert banned not in code, f"badge must not model {banned}"

    assert "SEND_RATE_LIMIT_MS" in code, "keep a flat rate cap for radio hygiene"
    assert "next_send_allowed" in code


def test_gesture_peaks_are_logged_for_tuning() -> None:
    """Thresholds are unmeasured, so the badge must report real magnitudes."""
    body = (BADGES_DIR / "phantom_player.lua").read_text()
    assert "log_gesture" in body
    assert "peak=" in body
    assert "threshold=" in body


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_never_maps_the_home_button(path: Path) -> None:
    """HOME's press is swallowed by the launcher intercept and it exits the app."""
    _, body = split_app(path.read_text())
    code = strip_comments(body)
    assert "BUTTON.HOME" not in code
    assert "B.HOME" not in code


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_defines_the_required_lifecycle_globals(path: Path) -> None:
    _, body = split_app(path.read_text())
    for callback in ("on_enter", "on_tick", "on_button", "on_exit"):
        assert re.search(rf"^function {callback}\(", body, re.MULTILINE), (
            f"{path.name} must define {callback} as a global function"
        )
        assert f"local function {callback}" not in body


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_checks_the_radio_enable_result(path: Path) -> None:
    """A successful USB push does not prove the radio started."""
    _, body = split_app(path.read_text())
    code = strip_comments(body)
    assert "badge.radio.enable()" in code
    assert re.search(r"=\s*badge\.radio\.enable\(\)", code), (
        "the return value of radio.enable() must be captured and checked"
    )
    assert "radio_enable_failed" in body, "failure must be visible on serial"


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_releases_the_radio_and_leds_on_exit(path: Path) -> None:
    _, body = split_app(path.read_text())
    exit_block = body.split("function on_exit()", 1)[1]
    assert "badge.radio.disable()" in exit_block
    assert "badge.led.clear()" in exit_block
    assert "badge.led.show()" in exit_block


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_logs_the_firmware_version(path: Path) -> None:
    """Pre-2026-09-16 firmware allows 6 ms ticks, not 250 ms, and api=2 does not
    reveal which is installed."""
    _, body = split_app(path.read_text())
    assert "badge.sys.version()" in body


@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_spaces_repeated_sends_across_ticks_instead_of_sleeping(path: Path) -> None:
    _, body = split_app(path.read_text())
    code = strip_comments(body)
    if "badge.radio.send" not in code:
        pytest.skip("receiver-only app")

    # The 40 ms spacing has to come from timestamps compared in on_tick.
    assert "next_at" in code, "repeated sends must be queued with a due time"
    tick_block = body.split("function on_tick()", 1)[1]
    assert "pump_queue" in tick_block, "the send queue must be drained from on_tick"


def test_the_gateway_logs_the_mac_before_the_payload() -> None:
    """Appending the MAC would land inside the packet's sequence field."""
    body = (BADGES_DIR / "phantom_gateway.lua").read_text()
    code = strip_comments(body)
    assert "badge.sys.log(mac .. \" \" .. payload)" in code
    assert "payload .. \" \" .. mac" not in code


def test_the_gateway_receive_handler_takes_three_arguments() -> None:
    body = (BADGES_DIR / "phantom_gateway.lua").read_text()
    assert "badge.radio.on_recv(function(mac, rssi, payload)" in body


def test_the_gateway_filters_on_the_packet_prefix() -> None:
    """The Lua radio channel is shared with every other app at the venue."""
    body = (BADGES_DIR / "phantom_gateway.lua").read_text()
    code = strip_comments(body)
    assert 'string.sub(payload, 1, PREFIX_LEN) ~= PREFIX' in code
    assert 'PREFIX = "PA1|"' in code


def test_the_gateway_surfaces_the_dropped_frame_counter() -> None:
    body = (BADGES_DIR / "phantom_gateway.lua").read_text()
    code = strip_comments(body)
    assert "badge.radio.dropped()" in code


def test_the_gateway_does_not_unregister_inside_its_own_handler() -> None:
    """Frames may already be queued for this tick; tear down in on_exit."""
    body = (BADGES_DIR / "phantom_gateway.lua").read_text()
    handler = body.split("badge.radio.on_recv(function", 1)[1].split("end)", 1)[0]
    assert "on_recv(nil)" not in handler


@pytest.mark.parametrize(
    "payload",
    [
        "PA1|J|EVT|MET|255",
        "PA1|J|EVT|MANA|255",
        "PA1|J|EVT|DBL|255",
        "PA1|J|EVT|RST|255",
        "PA1|P1|CAST|F|255",
        "PA1|P2|CAST|U|255",
        "PA1|P1|READY|1|255",
    ],
)
def test_every_packet_the_badges_can_emit_fits_the_radio_cap(payload: str) -> None:
    assert len(payload.encode()) <= MAX_RADIO_PAYLOAD_BYTES


@pytest.mark.skipif(shutil.which("luac") is None, reason="luac not installed")
@pytest.mark.parametrize("path", badge_apps(), ids=lambda p: p.name)
def test_lua_syntax_compiles(path: Path) -> None:
    """A syntax error would otherwise only surface when opened on the badge."""
    result = subprocess.run(
        ["luac", "-p", str(path)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_the_guide_is_present_so_these_rules_can_be_re_derived() -> None:
    assert GUIDE.exists(), "badge-app-guide.md is the authority for every rule here"
