# Hardware and Environment Verification

> Historical record from the stock-firmware (Lua) prototype. The board identification below still
> applies; the Lua apps, serial gateway and tools it names (`badge_monitor.py`, `fake_gateway.py`,
> `check_camera.py`, `badge-app-guide.md`) were removed on September 19, 2026 and live in git history.

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

### Board identity — CONFIRMED ON HARDWARE 2026-09-19

The badge is an **ESP32-C3**, single core, RISC-V. Straight from its boot log:

```
ESP-ROM:esp32c3-api1-20210207
boot.esp32c3: SPI Flash Size : 4MB
cpu_start: Unicore app
cpu_start: cpu freq: 80000000 Hz
hal_accel: SC7A20H detected (0x11)
```

RAM is the binding constraint, and it is tight:

```
heap_init: At 3FCB6440 len 00009BC0 (38 KiB): RAM
heap_init: At 3FCC0000 len 0001C710 (113 KiB): Retention RAM
```

An app sees roughly **78 KB free** on entry (`app_reg: heap after enter Launcher:
free=77768`). This matters enormously and is documented below.

Accelerometer is an **SC7A20H** over I2C. Serial device enumerates as
`/dev/cu.usbmodem1101`, USB VID `0x303A` (Espressif), PID `0x1001`,
`USB JTAG/serial debug unit` — which `find_serial_port()` selects correctly on the
first attempt, verified on hardware.

Firmware on the tested badge: `v0.1.2-392-gd3089c4`, `Compile time: Sep 17 2026`.
That is **newer** than the 2026-09-16 cutoff, so the 250 ms tick budget applies.

### The BLE out-of-memory trap — FOUND ON HARDWARE, FIXED

Enabling the radio is the single most memory-hungry thing an app does, and the
first hardware test failed on it. Two different symptoms, one cause:

```
# attempt 1: hard crash and reboot
assert failed: ble_hs_init ble_hs.c:967 (rc == 0)
Core 0 register dump: ...  Rebooting...

# attempt 2: clean failure
app_reg: heap after enter Launcher: free=77768   <- 78 KB free
hal_radio: init_once: free heap 47756            <- our UI already took 30 KB
hal_radio: waiting for host sync (free heap 576) <- BLE took nearly all the rest
E hal_radio: host sync timeout
lua: [phantom_gateway] phantom_gateway radio_enable_failed
```

BLE needs roughly **47 KB**. The original apps built their whole UI in `on_enter`
before calling `badge.radio.enable()`, which consumed 30 KB and left BLE only
47.7 KB — it scraped in with 576 bytes spare and the host sync then had nothing.

**The fix, now enforced by a test:** claim the radio *before* creating any widget.
`tests/test_badge_apps.py::test_the_radio_is_enabled_before_any_widget_is_created`
parses `on_enter` in each app and fails if a `badge.ui.*` call or a `build_*_ui()`
helper appears before `badge.radio.enable()`. `phantom_player` additionally builds
its duel screen lazily and deletes the side-select widgets first, so peak use
never holds both screens.

If the radio still fails to start:

1. Power cycle the badge. A fresh boot gives the least fragmented heap.
2. From the launcher go **straight** into the Phantom app. Bouncing through other
   apps first leaves memory fragmented.
3. `tools/badge_monitor.py` detects `host sync timeout` / `ble_hs_init` and prints
   this checklist, along with the lowest free-heap value it observed.

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

1. **Verified on hardware since 2026-09-19:** serial enumeration and auto-detect,
   port ownership conflict with the IDE, app push, firmware version reporting,
   the accelerometer part number, and the BLE memory ceiling.
   **Still unverified:** radio range, radio round trip between two badges, gesture
   thresholds, and real end-to-end latency, because only one badge has been
   attached so far.
2. **Mitigation:** `tools/fake_gateway.py` replays realistic gateway serial lines over
   a PTY, so the entire host pipeline, web client, and a full 100-to-0 duel can be
   exercised and demoed with no badges present. `tools/replay_duel.py` drives a scripted
   match through the same code path used by real serial input.
3. **Camera not exercised in CI.** macOS requires Camera permission for the terminal
   process, and the first-run prompt can fail quietly. Vision code is unit-tested
   against synthesized ArUco frames; `tools/check_camera.py` is the pre-flight for the
   live webcam.

### The badge models no game rules

Originally the player badge kept its own mana and cooldown counters and refused to
send when they said no. Because the radio is one way those counters can never be
corrected, so after the judge fired Mana Rain the host granted +40 mana, the badge
never heard, and a legal Ultimate was silently swallowed at the exact moment the
projector read MANA RAIN. It always failed closed, so it was not exploitable, only
embarrassing.

The badge now models nothing: no mana, no cooldowns, no phase, no damage. What
remains is a flat `SEND_RATE_LIMIT_MS` cap, which is radio hygiene rather than a
rule and therefore cannot disagree with the laptop. Enforced by
`tests/test_badge_apps.py::test_the_player_app_does_not_duplicate_host_game_rules`.

Side selection deliberately stayed on the badge rather than moving to a host-side
MAC map: a MAC map needs a config edit the moment a badge is swapped or its battery
dies, which would break the "no manual code edit" requirement mid-event.

## Pre-flight checklist for demo day

- [ ] Power cycle each badge, then go straight into its Phantom app from the
      launcher. This is the reliable way to get BLE the heap it needs.
- [ ] On each of the four badges, read the logged `badge.sys.version()`. Anything
      built before 2026-09-16 has a 6 ms tick budget.
- [ ] Confirm `badge.radio.enable()` succeeded on each badge. The screen says
      "Listening for PA1 packets" / "Ready" on success and "Radio unavailable -
      reboot badge" on failure. A successful USB push does not prove radio started.
- [ ] Run `python tools/badge_monitor.py` with the IDE disconnected. It reports
      firmware date, radio state, lowest free heap, and dedup behaviour.
- [ ] Watch the gateway's dropped counter while standing in the venue crowd.
- [ ] Run `python tools/check_camera.py` once to trigger and accept the macOS camera
      permission prompt.
- [ ] Disconnect the Badge IDE before starting the host: only one process may own the
      gateway's serial port.
