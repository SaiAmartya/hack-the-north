# Wand firmware

Native firmware for the Hack the North 2026 Hacker Badge (ESP32-C3), implementing
[BADGE-FIRMWARE-CONTRACT.md](../BADGE-FIRMWARE-CONTRACT.md) v1 for the Harry Potter Battle
Simulator: the badge is a BLE GATT peripheral that streams 50 Hz raw acceleration straight to
Chrome (Web Bluetooth) and shows the game's feedback (phase, HP, shield, cast/block/hit/result
cues) on its screen and LEDs. No Lua launcher, no receiver badge, no serial bridge in play.

Why native: the stock Lua sandbox shares one 75 KB heap between the Lua state and Bluetooth, so a
Lua radio app has a few hundred bytes to work with. The badge's designer confirmed the custom
firmware route, and the organizers now publish an official
[custom-flash guide](https://badge.hackthenorth.com/custom-flash); this firmware follows it
(checklist below). Image: 0.66 MB flash, 26 KB static RAM.

**Status:** running on hardware (badge `WAND-46BA`, 2026-09-19). Verified on the badge: console,
golden-vector self-test, accelerometer at 50 Hz (every interval 20–21 ms), HC165 buttons, BLE
advertising, and the full contract session from a laptop (`tools/wand_ble_check.py`: INFO, OPEN,
SYNC with 16–31 ms round trips, SET_STATE, cues incl. rejections, 50 Hz MOTION stream with zero
sequence gaps, health). Still to confirm by eye: display orientation, LED effects, X/Y axis
mapping (six-face check), and Chrome's Web Bluetooth picker on Windows.

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
Backups land in `firmware/backups/` (git-ignored). The organizers do not provide a stock image, so
this backup is the only way back.

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
| Accel WHO_AM_I 0x11; CTRL_REG1 0x57; CTRL_REG4 0x80; ZYXDA poll; OUT_X_L auto-increment; raw>>4 | WHO_AM_I checked (0x11 or 0x33); CTRL_REG1 **0x47** (50 Hz ODR, the contract's rate; 0x57 = 100 Hz); CTRL_REG4 **0xA0** = guide's 0x80 + FS=±8 g (contract range; 4 mg/count); new-data flag polled; auto-increment reads |
| Bounded I2C timeouts + retry (NFC can wedge the bus) | 10 ms bus timeout; after 5 consecutive failures the bus is re-initialised and the sensor reconfigured; count in `status` (`i2c_recover`) |
| HC165 DATA 7 / LOAD 20 / CLK 21; order A,B,Home,Down,Left,Right,Up,Aux1; active-low; latch then 8× sample+clock | `buttons.cpp`: same protocol; bits 7..0 = A,B,Home,Down,Left,Right,Up,Aux1, inverted so 1 = pressed |
| Start on GPIO9, active-low, strapping pin | read with pull-up; only used to re-seed the activity baseline |
| Poll ~10 ms + debounce; Aux1 is a maintained switch | polled every 10 ms, 12 ms debounce; Aux1 treated as a level |
| WS2812B ×6 on GPIO3, GRB, RMT; order UL, UR, MR, BR, BL, ML; keep it dim | Adafruit NeoPixel (RMT on ESP32), `NEO_GRB`; brightness 48/255; cast cue sweeps indices 0→5, which is clockwise around the board per the guide's order |
| BLE: init once, never deinit; trim buffers | NimBLE initialised once at boot, advertising restarted on disconnect; legacy advertising with one connection (Windows Chrome does not see extended advertising). Heap is not the constraint without the Lua runtime (`status` prints `heap=`) |
| Console: bare `\r` line ending; <256-byte USB writes; keep a button-inject/print path | `\r`, `\n` and `\r\n` all end a line; replies are short; `btn` prints the HC165 byte and held buttons |
| Checklist: Start read, HC165 read, 10 ms debounce, ST7789 fill-screen, accel WHO_AM_I + mg, WS2812 chase (dim) | boot screen fills black and prints diagnostics; LED chase during boot; `HPDIAG` line reports the I2C scan and WHO_AM_I |

## Bring-up checklist (first time on hardware)

1. Flash, open the monitor. Expect `HPHELLO|fw=0.1.0|name=WAND-xxxx|...|sensor=1`. The screen
   shows boot diagnostics (I2C scan should list `19 26`, accelerometer id 11) then the wand screen;
   LEDs breathe blue. Fresh badges default to `rot 3`; use `rot 0`, `rot 1`, or `rot 2` if the panel differs. The selected rotation is saved in NVS.
2. `selftest` runs the contract's golden vectors on the badge. Expect `selftest failures=0`.
3. Axis check: lay the badge face up on a table and type `axes`. The contract wants about
   `0, 0, +1000` mg. If not, remap without reflashing, e.g. `axes -y +x +z` means contract X = −chip Y,
   contract Y = +chip X, contract Z = +chip Z. Check all six faces; ±100 mg tolerance.
4. `btn` while holding buttons confirms the shift-register order.
5. `uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-xxxx` from the
   laptop walks the whole contract over real BLE (scan, INFO, OPEN, SYNC, SET_STATE, cues, motion
   stream, health) and prints PASS/FAIL per step with rate and interval statistics. Use `--scan 15`
   in a crowded venue. Chrome must be disconnected from the badge while it runs.
6. In the web app (`apps/web`, Chrome on Windows with Bluetooth on) open the **Wand** panel and press
   **Connect wand (Bluetooth)**. Pick `WAND-xxxx`. The panel reads INFO, subscribes, sends OPEN and
   five SYNCs and shows the sync uncertainty, sample rate and live axes. The feedback buttons send
   SET_STATE and CUE and should change the badge screen and LEDs within ~150 ms.
7. `status` prints counters (acquired/notified/dropped/i2c_recover/heap) for the transport gate;
   `echo on` prints every sample on the console for a raw capture.

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
* Motion: the SC7A20 runs at 50 Hz ODR, ±8 g; a sample is emitted only when the sensor's new-data
  flag is set, timestamped within ~1 ms of that read. Samples older than 100 ms or refused by the
  stack count as dropped and set the discontinuity bit on the next one. Sequence numbers advance
  per acquired sample.
* Device id = the chip's BLE MAC (stable across reflash). `boot_id` is random per boot.
* Acquisition and MOTION notifications run on their own FreeRTOS task (priority 4, above the
  Arduino loop). Presentation stays in the loop with field-level screen redraws (no framebuffer)
  and 25 Hz LED frames. With everything in one loop the 150 ms display refresh overran 1–3 samples
  each time (measured 40–42 Hz); with the task every interval is 20–21 ms.

## Console commands (USB serial, diagnostics only)

`help`, `status`, `id`, `selftest`, `axes [+x -y +z]`, `btn`, `rot <0-3>`, `leds on|off`,
`echo on|off`, `recal`, `reboot`, `flashmode` (reboot into the ROM download mode for reflashing).
Settings persist in NVS. Lines may end in `\r`, `\n` or both.

## Source layout

```
include/pins.h      pin map (matches the official guide; button order verified on hardware)
include/config.h    UUIDs, stream profile, timing limits
src/proto.cpp       codec + Session rules + golden-vector self-test (pure C++, no Arduino)
src/ble.cpp         NimBLE GATT server, advertising, control write queue
src/accel.cpp       SC7A20 over I2C, 50 Hz fresh-data reads, ±8 g, bounded timeouts + bus recovery
src/wand.cpp        acquisition task: axis remap, saturation, MOTION notifications, activity level
src/present.cpp     state/cue presentation glue; display.cpp (ST7789) and leds.cpp (WS2812B)
src/console.cpp     serial commands and NVS settings
src/main.cpp        boot diagnostics, session/connection lifecycle, main loop
```

Mirrors of the codec: `apps/host/phantom_host/wand_protocol.py` and
`apps/web/src/lib/wandProtocol.ts`, both pinned to the same golden vectors.
