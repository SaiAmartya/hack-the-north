# Wand firmware

Native firmware for the Hack the North 2026 Hacker Badge (ESP32-C3), implementing
[BADGE-FIRMWARE-CONTRACT.md](../BADGE-FIRMWARE-CONTRACT.md) v1 for the Harry Potter Battle
Simulator: the target is a BLE GATT peripheral streaming 50 Hz raw acceleration straight to
Chrome (Web Bluetooth), with game feedback (phase, HP, shield, cast/block/hit/result
cues) on its screen and LEDs. No Lua launcher, no receiver badge, no serial bridge in play.

Why native: the stock Lua sandbox shares one 75 KB heap between the Lua state and Bluetooth, so a
Lua radio app has a few hundred bytes to work with. The badge's designer confirmed the custom
firmware route, and the organizers now publish an official
[custom-flash guide](https://badge.hackthenorth.com/custom-flash); this firmware follows it
(checklist below). Image: 0.66 MB flash, 26 KB static RAM.

**Current source: 0.1.7 sensor-reset diagnostic image, not for gameplay.**
The 0.1.3 live test passed OPEN/SYNC and streamed 48.7 Hz but marked nearly every sample
discontinuous because hardware STATUS bit 7 remained set; it is not a gameplay-qualified image.
0.1.4 measured `CTRL0/2/3/5/6/FIFO_CTRL=00`, revision `28`, and STATUS `FF → 00`
across each burst. The overrun clears, so it was not simply one latched startup error; FIFO was
disabled. The reason it reappears at the measured 20–21 ms cadence is not yet established.
0.1.5 explicitly selected the manufacturer's high-performance mode: power down, set CTRL0 HR=1
with OSR=000/DLPF1=0 (preserving reserved bits), then CTRL4=A0, CTRL1=47, delay/readback.
It still produced near-every-read overrun on the connected badge. This did not fix the defect.
0.1.6 keeps that exact configuration and removes the 16 ms post-read sleep: acquisition polls
once per RTOS tick, reports native ready-observation intervals and a histogram, no-data polls,
and elapsed time from the previous completed read to the next observed DRDY. `status` identifies
the tick rate and register-configured ODR separately from measured acquisition. Compute the
observed rate as `(fresh_reads - 1) * 1e6 / ready_span_us` between reconfigurations; it is a host
observation, not the sensor's physical acquisition timestamp. Measure disconnected first, then
with BLE/feedback active. All overrun/discontinuity flags remain enabled; there is no decimation.
INFO capabilities are deliberately **0**, so casting is blocked even though the configured-rate
field remains 50 (the codec does not allow a zero/unknown rate). This explicitly unsupported
diagnostic INFO is not a new valid v1 game profile or a claim that output cadence has passed.
The 0.1.6 measurement found ~50.8 Hz fresh reads with 1 kHz polling and 23,931 no-data polls
between 1,282 readings, yet 1,275 overwrite flags. Removing the sleep did not fix the anomaly.
0.1.7 makes one additional, manufacturer-documented change: after checking WHO=11/VERSION=28,
write `SOFT_RESET(68h)=A5` once at boot, wait a bounded 10 ms, recheck identity/read reset defaults,
then run the same configuration. This is not repeated during I²C recovery. The settling delay is
an implementation margin, not a documented reset-completion guarantee. `status` reports the
post-reset defaults; `trace` prints the first 16 fresh-read transitions captured in bounded RAM:
last no-data observation, first ready observation, six-byte burst start/end and post-burst STATUS.
Acquisition never prints the trace. All times are MCU observations in microseconds, not physical
sample timestamps. Capability zero and strict flags remain.

**0.1.7 hardware result: still blocked.** The 682,544-byte application was flashed and fully
read back with SHA-256 `c57d27d1e2c9a312e2d2de123b10ed25282e7b34b261d0c90851077a301690b1`.
Post-reset CTRL0/1/4 were `00/07/00`, confirming the observed reset defaults. All first 16
captured fresh-read bursts still showed `FF → 00`; preceding no-data observations were `00`
about 1 ms before the ready observation. The six-byte burst took about 272 µs, followed by
about 156 µs for the post-burst status read. Reset did **not** fix the anomaly. This image remains
diagnostic-only; creator/manufacturer clarification is required before reinterpreting the flag.
These MCU observations do not prove that the sensor never lost an internal measurement.

FIFO is a possible **future acquisition design**, not an implemented workaround. The same
datasheet documents a separate FIFO count/overflow register (`2Fh`, printed page 20), but its
count-unit/read-width wording needs confirmation against the `69h` data-port description
(page 27). A future qualification must prove count/pop behavior, overflow detection, complete
XYZ records and sample-age bounds. FIFO evidence cannot retroactively make the current `27h`
overwrite flag harmless. No FIFO configuration or additional sensor change has been made.

Earlier teammate measurements on `WAND-46BA`
do not qualify this build. The exact upstream 0.1.0 image from `6a50929` failed OPEN on
`WAND-B602`; [that diagnostic record](../docs/qa/firmware-main-6a50929.md) is historical.
Portable protocol tests pass; record the new image hash, flash/readback and live BLE results
separately before calling this hardware game-ready. Battery-only boot, six-face axes, combined
load, 20 reconnects, endurance and Windows remain hardware gates.

### 0.1.3 fixes and evidence boundary

- STATUS and MOTION use explicit copied notification payloads targeted at one connection.
  STATUS reads remain health, so deferred characteristic updates cannot overwrite OPEN/SYNC ACKs.
- Connect/disconnect resets the session on the NimBLE callback before new CONTROL is processed;
  generation-tagged sends cannot cross a reconnect. Only one central is configured/accepted.
- Lock order is session mutex → send mutex → NimBLE host internals. Link callbacks release
  the send mutex before entering the session handler. Pinned NimBLE's `ble_gap_call_event_cb`
  asserts that GAP callbacks run without its host lock. No SPI/I2C/USB output runs under these locks.
- Epoch change, lease expiry and reconnect cancel screen/LED cues on the next presentation turn.
  Cue activation is serialized with session changes; an in-progress display transfer may finish,
  but no old cue is reactivated afterward. Expiry uses `>=`, including wrap-safe exact deadlines.
- The sensor is checked as SC7A20 (`0x11`), with configuration readback `47/A0`. Native signed
  conversion has independent tests. `STATUS[7]` records the sensor's overwrite report,
  not an independently measured lost-sample count. A >40 ms acquisition gap also marks
  discontinuity; >100 ms with no fresh reading reports unhealthy. No zero sample is invented.
- Acquisition owns its counters and publishes a short locked snapshot; no USB printing runs
  on that task. `echo` is now at most 5 Hz snapshots in the console loop. USB is never awaited
  at boot, disconnected writes are skipped, and `status` reports reset reason/resource headroom.
- LEDs are capped at 24/255, BLE TX at +3 dBm. These lower power peaks but **do not prove** the
  reported battery reset is fixed. Do not disable the brownout detector or guess a battery voltage.
- SDK/platform and direct libraries are pinned. The bundled NimBLE host is built peripheral-only,
  one connection, standard MTU support and both subscriptions; host flow control stays disabled.
  Unused seesaw/SD libraries are excluded. No source files in the toolchain are patched.

Run the portable checks from the repository root (no hardware access):

```sh
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/protocol_test.cpp firmware/src/proto.cpp -o /tmp/wand-firmware-protocol-test
/tmp/wand-firmware-protocol-test
```

Register reference: manufacturer-authored [Silan SC7A20H datasheet v1.1](https://www.unikeyic.com/media/datasheet/202511/59f66cd3197e2534279e18eca6a9f806.pdf),
mirrored by a component distributor. Printed pages 14–15 specify CTRL0 HR and the 50 Hz ODR;
page 17 lists 24.9 Hz bandwidth for high-performance at 50 Hz versus 399.9 Hz for normal mode;
page 19 defines STATUS overrun bits. Physical cadence/overrun/scale validation is still required.
Printed page 27 specifies `SOFT_RESET(68h)=A5` and VERSION(70h)=28.

## Flashing

Once per laptop: `uv tool install platformio esptool` (done on the dev machine). Use a USB **data**
cable and close the badge IDE tab; only one program can own the port.

```bash
uv run --with pyserial python tools/badge_flash.py list          # find the badge (Espressif USB JTAG/serial)
uv run --with pyserial python tools/badge_flash.py backup        # 4 MB dump of the stock firmware, ~40 s
uv run --with pyserial python tools/badge_flash.py flash         # build + upload + confirm the app answers
uv run --with pyserial python tools/badge_flash.py monitor       # serial console at 115200 (--seconds N to auto-stop)
uv run --with pyserial python tools/badge_flash.py cmd selftest axes btn   # send console commands, print replies
uv run --python 3.12 --with bleak python tools/wand_ble_check.py # full BLE contract session from the laptop
```

`backup` must run once per badge before the first `flash`: the dump holds the stock firmware,
partition table, apps and the badge's identity, and `restore <file>` writes it back byte for byte.
Backups belong outside Git, with two matching full reads and a device-MAC manifest verified by
the current flashing helper. Inspect its help and the per-device recovery record. Do not use
blanket erase or overwrite storage/identity regions. Approved testing normally writes only the
application at `0x10000` after comparing the device's partition table to the build.

**Download mode.** The console is the native USB-Serial-JTAG port. From the *stock* firmware the
RTS/DTR reset emulation does nothing, so the very first backup/flash needs the manual route: unplug
USB, hold **START** (the play button, GPIO9, the strapping pin) while plugging USB back in, release.
A blank screen in that state is download mode, not a brick. `backup` leaves the chip in the
bootloader (`--after no-reset`) so backup + first flash need that dance only once. Once this
firmware runs, `flash` asks it to reboot into download mode itself (console `flashmode`), and
esptool's own reset sequence also works from the running app. After writing, the tool checks that
the app answers `id`; if the emulated hard reset left the chip in the bootloader (it does after a
START-button entry) it forces a watchdog reset out of it. Only if that fails: unplug and replug.

**"Port is busy" / "Access is denied"**: another program owns the COM port: a badge IDE tab (Web
Serial), a serial monitor, or occasionally a Windows service that probes new serial ports. Close it,
or replug the badge, which drops the stale handle.

Building by hand: `pio run` inside `firmware/` from **PowerShell** (the toolchain installer refuses
Git Bash/MSYS shells). Output: `.pio/build/badge/firmware.bin`. Flash mode is pinned to DIO at
80 MHz in `platformio.ini`, matching the guide and the stock boot log; the PlatformIO board default
(QIO) is not used.

Storage: `partitions_badge.csv` mirrors the stock partition table exactly (read back from a full
dump: `nvs` 0x9000/16 KB, `phy_init` 0xd000, `factory` app 0x10000/2.6 MB, littlefs `storage`
0x2b0000/1.25 MB), so our app sits in the factory slot, never mounts or formats the littlefs
region, and keeps its settings in an `hpwand` namespace of the same NVS partition the stock
firmware uses: the organizers' identity record and the RF calibration data are left alone. A full
`restore` brings everything back regardless.

## Checked against the official custom-flash guide

| Guide item | This firmware |
| --- | --- |
| ESP32-C3-MINI-1-N4, 4 MB, USB-Serial-JTAG console | `esp32-c3-devkitm-1` board, USB CDC on boot (`ARDUINO_USB_MODE=1`), Arduino-ESP32 (guide: "also works, same GPIOs") |
| Flash DIO, 80 MHz, app at 0x10000 | `board_build.flash_mode = dio`, `f_flash = 80 MHz`; app at 0x10000 in the factory slot of `partitions_badge.csv` (same table as stock) |
| LCD MOSI 10 / CLK 1 / CS 2 / DC 0 / RST 4, 40 MHz, mode 0, RGB565 | `pins.h`; Adafruit ST7789 at 40 MHz, mode 0, 16-bit colour |
| Init: invert_color(true), swap_xy(true), mirror(true,false) | Adafruit init sends INVON; `setRotation(1)` = swap XY + mirror X. `rot <0-3>` fixes it live if the panel disagrees |
| I2C SDA 5 / SCL 6, 400 kHz; accel 0x19, NFC 0x26 | `Wire.begin(5, 6, 400000)`; only the accelerometer is initialised, NFC untouched (guide: don't init it if unused) |
| Accel WHO_AM_I 0x11; CTRL_REG1 0x57; CTRL_REG4 0x80; ZYXDA poll; OUT_X_L auto-increment; raw>>4 | WHO_AM_I must be 0x11; CTRL_REG1 **0x47** and CTRL_REG4 **0xA0** are written and read back; 50 Hz / ±8 g requested profile, 4 mg/count; new-data/overrun flags checked |
| Bounded I2C timeouts + retry (NFC can wedge the bus) | 10 ms bus timeout; after 5 consecutive failures the bus is re-initialised and the sensor reconfigured; count in `status` (`i2c_recover`) |
| HC165 DATA 7 / LOAD 20 / CLK 21; order A,B,Home,Down,Left,Right,Up,Aux1; active-low; latch then 8× sample+clock | `buttons.cpp`: same protocol; bits 7..0 = A,B,Home,Down,Left,Right,Up,Aux1, inverted so 1 = pressed |
| Start on GPIO9, active-low, strapping pin | read with pull-up; only used to re-seed the activity baseline |
| Poll ~10 ms + debounce; Aux1 is a maintained switch | polled every 10 ms, 12 ms debounce; Aux1 treated as a level |
| WS2812B ×6 on GPIO3, GRB, RMT; order UL, UR, MR, BR, BL, ML; keep it dim | Adafruit NeoPixel (RMT on ESP32), `NEO_GRB`; brightness 24/255; battery-loaded validation pending |
| BLE: init once, never deinit; trim buffers | NimBLE initialized once; legacy advertising resumes on disconnect; peripheral-only with one central. `status` reports heap/stack/notification failures; measure under load |
| Console: bare `\r` line ending; <256-byte USB writes; keep a button-inject/print path | `\r`, `\n` and `\r\n` all end a line; replies are short; `btn` prints the HC165 byte and held buttons |
| Checklist: Start read, HC165 read, 10 ms debounce, ST7789 fill-screen, accel WHO_AM_I + mg, WS2812 chase (dim) | boot shows reset reason and sensor identity; no NFC initialization or shared-bus scan |

## Bring-up checklist (first time on hardware)

1. After separately approved flash, open the monitor. Expect `HPHELLO|fw=0.1.7|name=WAND-xxxx|...|sensor=1`. The screen
   shows boot diagnostics (accelerometer id 11, reset reason) then the wand screen;
   LEDs breathe blue. If the screen is upside down or sideways: `rot 3` (or 0/2), saved in NVS.
2. `selftest` runs the contract's golden vectors on the badge. Expect `selftest failures=0`.
3. Axis check: lay the badge face up on a table and type `axes`. The contract wants about
   `0, 0, +1000` mg. If not, remap without reflashing, e.g. `axes -y +x +z` means contract X = −chip Y,
   contract Y = +chip X, contract Z = +chip Z. This saves the map for the next reboot so a live
   boot's axes never silently change. Reboot and check all six faces; ±100 mg tolerance.
4. `btn` while holding buttons confirms the shift-register order.
5. `uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-xxxx` from the
   laptop walks the whole contract over real BLE (scan, INFO, OPEN, SYNC, SET_STATE, cues, motion
   stream, health) and prints PASS/FAIL per step with rate and interval statistics. Use `--scan 15`
   in a crowded venue. Chrome must be disconnected from the badge while it runs.
6. The 0.1.7 diagnostic image deliberately fails the game-ready INFO gate. Do not enter gameplay
   until an accurately profiled, measured image restores the required capabilities. Collect
   technical counters through scripts, not a debug dashboard.
7. `status` prints counters (acquired/notified/dropped/i2c_recover/heap) for the transport gate;
   `echo on` prints low-rate snapshots, not a raw capture; use BLE for full-rate evidence.

## What the badge does

| Situation | Screen | LEDs |
| --- | --- | --- |
| Advertising | `WAND xxxx`, "SAY THE SPELL, MOVE", gesture hints | slow blue breath |
| Connected, no state yet | "WAITING FOR GAME" | violet glow that brightens with movement (amber tint while state is stale) |
| SET_STATE practice/countdown/playing | phase text, HP bar with SHIELD / DISARMED flags | violet glow; steady cyan while shield bit set |
| CUE accepted cast | `STUPEFY!` etc. in the spell colour | colour sweeps around the ring |
| CUE blocked / damage | `BLOCKED` / `HIT by ...` | cyan ripple / red strobe |
| SET_STATE won/lost/draw + result CUE | `VICTORY` / `DEFEATED` / `DRAW`, `YOU WIN` ... | gold chase / red fade / white |
| State lease expired or disconnect | back to neutral within the lease (≤1.5 s) | glow with amber tint |

The activity bar and the LED brightness are local motion feedback only; they never claim a
recognised spell. Buttons do nothing in play except START, which re-seeds the local activity
baseline.

## Contract implementation notes

* Records are encoded field by field (no padded structs). `decode_motion` is strict for the
  self-test; the browser is the real consumer.
* Sequence rule after OPEN: `0 < (new − last) mod 65536 < 32768`; a well-formed in-order command
  consumes its sequence even when rejected; exact duplicate bytes re-ACK the cached result with the
  original receipt time; same sequence with different bytes is `6 stale`.
* A second OPEN on the same connection (different bytes) is rejected with `2 wrong session`.
  SET_STATE too far ahead (>1500 ms) and CUE too far ahead (>500 ms) are `3 invalid argument`;
  already-due deadlines (`lead <= 0`) are `4 expired`. A CUE whose epoch does not match the live
  state is `3`.
* Frames that are not 20 bytes get no STATUS result. NimBLE-Arduino cannot return an ATT error from
  a write callback, so the ATT write itself is acknowledged; the contract's "reject the ATT write"
  for unidentifiable frames is met only in the sense that no result is fabricated.
* STATUS read returns current health; results are one-off notifications. Health is notified at 1 Hz
  and immediately when its bits change (sensor, stream, stale).
* Motion timestamps are taken immediately after a fresh register burst, not at notification.
  Sensor acquisition-to-read latency depends on scheduling/I2C and must be measured under load.
  Local dropped/overrun count is not radio-delivery proof; compare receiver sequence/capture gaps.
* Device id = the chip's BLE MAC (stable across reflash). `boot_id` is random per boot.
* Acquisition and MOTION notifications run on their own FreeRTOS task (priority 4, above the
  Arduino loop). Presentation uses a 14.4 KB text canvas and 25 Hz LED frames. Separate tasks do
  not prove timing isolation; combined-load acquisition/ACK/resource checks remain mandatory.

## Console commands (USB serial, diagnostics only)

`help`, `status`, `trace`, `id`, `selftest`, `axes [+x -y +z]`, `btn`, `rot <0-3>`, `leds on|off`,
`echo on|off`, `recal`, `reboot`, `flashmode` (reboot into the ROM download mode for reflashing).
Settings persist in NVS. Lines may end in `\r`, `\n` or both.

## Source layout

```
include/pins.h      pin map (matches the official guide; button order verified on hardware)
include/config.h    UUIDs, stream profile, timing limits
src/proto.cpp       codec + Session rules + golden-vector self-test (pure C++, no Arduino)
src/ble.cpp         NimBLE GATT server, link generation, direct CONTROL callbacks/payload notifications
src/accel.cpp       SC7A20 over I2C, 50 Hz fresh-data reads, ±8 g, bounded timeouts + bus recovery
src/wand.cpp        acquisition task: axis remap, saturation, MOTION notifications, activity level
src/present.cpp     state/cue presentation glue; display.cpp (ST7789) and leds.cpp (WS2812B)
src/console.cpp     serial commands and NVS settings
src/main.cpp        boot diagnostics, session/connection lifecycle, main loop
```

Mirrors of the codec: `apps/host/phantom_host/wand_protocol.py` and
`apps/web/src/lib/wandProtocol.ts`, both pinned to the same golden vectors.
