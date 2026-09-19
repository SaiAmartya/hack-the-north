# Hardware and Environment Verification

Date: 2026-09-19. Machine: macOS 26.6.2, arm64.

## Can we use the board?

Yes, for everything Phantom Arena needs — but with two caveats recorded at the bottom.

The authoritative source is `badge-app-guide.md` at the repo root. Public web search
returns nothing specific to the 2026 HTN Hacker Badge, so the guide is the only
reliable reference and every badge call in this repo was checked against it.

### Capabilities we depend on, and where they are documented

| Need | Badge API | Verified detail |
| --- | --- | --- |
| Badge-to-laptop path | `badge.radio.*` | Restricted Lua broadcast channel. `send()` takes a 1–44 byte payload and returns true on **queued**, not delivered. |
| Receive on gateway | `badge.radio.on_recv(fn)` | Handler signature is `(mac, rssi, payload)` — three arguments. Payload arrives without the firmware's `LUA1` prefix. |
| Serial bridge to host | `badge.sys.log(str)` | "one line to serial, tagged with the app slug", so lines always carry a prefix the host must tolerate. |
| Motion casting | `badge.sensor.accel()` | Returns x, y, z in **milligravity**, or `nil + err`. Reads are cached at 50 Hz. |
| Ultimate trigger | `badge.sensor.shake()` | True once per shake, firmware-provided refractory. `tap()` and `orientation()` also exist. |
| Buttons | `badge.input.BUTTON` | `A B HOME DOWN LEFT RIGHT UP AUX1 START`. |
| Feedback | `badge.led.*` | Six individually addressable RGB LEDs, 1-based Lua indices, stage then `show()`. |
| Side persistence | `badge.store.*` | 32 keys, per-app scope. |
| Timing | `badge.sys.ms()` | Monotonic milliseconds. There is no wall clock and no `sleep`. |

### Board identity

The guide never names the SoC, but the IDE's USB device picker asks for
**"USB JTAG/serial debug unit (Espressif)"**, which means an ESP32 with a native
USB-Serial/JTAG peripheral. Combined with BLE, LVGL on a 320x240 panel, littlefs, and
a 48 KB Lua heap, this is consistent with an ESP32-S3 class part. Nothing in this
project depends on the exact SoC, so the guide's API surface is sufficient.

### Constraints that shaped the implementation

1. **The radio is BLE, not ESP-NOW.** `badge.radio.mac()` returns a BLE address and
   `disable()` is deferred because "BLE teardown takes ~2 s". There is no channel,
   peer, or pairing API to configure — which also means nothing to get wrong.
2. **The channel is shared with every other badge app at the venue.** RX is an 8-slot
   ring drained at most 4 frames per tick, and overflow is counted by
   `badge.radio.dropped()`. Our `PA1|` prefix filter is load-bearing, and the gateway
   surfaces the dropped count so contention is visible instead of mysterious.
3. **No `sleep`, no `coroutine`, no busy waits.** The 40 ms spacing between the three
   copies of each packet is a queue drained across `on_tick` using `badge.sys.ms()`.
4. **Sandbox has no `pcall`/`xpcall`/`setmetatable`/`os`/`io`.** Badge code checks
   return values instead of wrapping calls defensively.
5. **Apps only run in the foreground.** "a timer or radio listener does not keep
   running after returning HOME". All three apps set `wake_lock=1` and must stay open
   for the whole demo.
6. **HOME is unusable as a game button.** Its Pressed is swallowed by the HOME
   intercept and its default action exits the app, so no spell is mapped to it.
7. **Firmware version changes the tick budget by 40x.** The 250 ms tick budget arrives
   with firmware dated 2026-09-16; earlier firmware allows **6 ms**, and `api=2` does
   not reveal which is installed. Each app logs `badge.sys.version()` on entry.

## Laptop environment

| Component | Status |
| --- | --- |
| Python | 3.12.3 at `/usr/local/bin/python3` |
| uv | present, used to create `apps/host/.venv` |
| Node / npm | v22.15.0 / 10.9.2 |
| git | 2.48.1 |
| fastapi / pydantic / pyserial | 0.115.6 / 2.10.4 / 3.5 — installed and importable |
| opencv-contrib-python | 4.10.0 — installed, and `cv2.aruco` dictionary construction succeeds |
| openai SDK | 1.59.6 |

## What could NOT be verified, and why

1. **No badge is connected.** `ls /dev/cu.*` lists only Bluetooth and debug consoles,
   no `usbmodem` device. Radio range, gesture thresholds, real end-to-end latency, and
   the gateway's serial output format in practice are therefore **unverified on
   hardware**. Everything else in this repo is verified by automated tests.
2. **Mitigation:** `tools/fake_gateway.py` replays realistic gateway serial lines over
   a PTY, so the entire host pipeline, web client, and a full 100-to-0 duel can be
   exercised and demoed with no badges present. `tools/replay_duel.py` drives a scripted
   match through the same code path used by real serial input.
3. **Camera not exercised in CI.** macOS requires Camera permission for the terminal
   process, and the first-run prompt can fail quietly. Vision code is unit-tested
   against synthesized ArUco frames; `tools/check_camera.py` is the pre-flight for the
   live webcam.

## Pre-flight checklist for demo day

- [ ] On each of the four badges, open an app and read the logged `badge.sys.version()`.
      Anything older than 2026-09-16 has a 6 ms tick budget.
- [ ] Confirm `badge.radio.enable()` succeeded on each badge (the apps show this on
      screen; a successful USB push does not prove radio started).
- [ ] Watch the gateway's dropped counter while standing in the venue crowd.
- [ ] Run `python tools/check_camera.py` once to trigger and accept the macOS camera
      permission prompt.
- [ ] Disconnect the Badge IDE before starting the host: only one process may own the
      gateway's serial port.
