# Firmware `main` 6a50929 review and diagnostic flash

Date: 2026-09-19

Reviewed source: firmware tree at `6a50929155b4fcb416d6317b5994634e75ea8297`

Comparison base: `6c1b857892cad887d410b4badc9ad32fad4428d5`
Scope: static source/resolved-dependency review plus the separately recorded build,
flash, serial and native-BLE measurements below. The preserved 0.1.2 stash is not part
of this image. Firmware source matches upstream exactly; no local fixes were reapplied.

## Current result: flash verified, BLE OPEN blocked

The exact upstream application was flashed to WAND-B602. It boots and passes its
own self-test, but the name-pinned native BLE test **failed OPEN acknowledgement**
after 1,500 ms. Do not treat this image as game-ready. The browser correctly requires
that result; bypassing it would weaken the unchanged contract. Sai's instruction to
discard local firmware fixes remains in force. A targeted upstream fix requires a
new explicit decision or a teammate update.

### Build and flash measurements

- Source: `6a50929155b4fcb416d6317b5994634e75ea8297`, archived into a fresh isolated
  build directory, not the prior working-tree image. Reported version is still 0.1.0.
- PlatformIO 6.2.0; pioarduino 55.3.312; Arduino-ESP32 3.3.12; ESP-IDF libraries
  5.5.5+sha.b774170ff46; RISC-V GCC 14.2.0+20260121; esptool 5.4.0.
- Libraries: NimBLE-Arduino 2.5.1, NeoPixel 1.15.5, GFX 1.12.6, BusIO 1.17.4,
  ST7735/ST7789 1.11.0; resolved transitive seesaw 1.7.9 and SD 1.3.0.
- Build succeeded: PlatformIO reports 25,800 bytes static RAM and 660,237 bytes
  flash usage; these are build statistics, not runtime resource qualification.
- Selected device base MAC `28:84:85:d6:b6:00`, ESP32-C3 revision 0.4, 4 MiB flash.
  Its private two-read stock backup was reverified; no backup contents enter Git.
- The live partition table was read and matched generated `partitions.bin` byte-for-byte:
  SHA-256 `11a228752e2be0b2ddb6dc70ba0f1744d591c1d781f0b489a2cb79c86dfe0724`.
- Wrote **only 690,272 application bytes at `0x10000`**; sector erase range
  `0x10000..0xB8FFF`. No bootloader, partition table, NVS, PHY, storage or eFuse writes.
- Full application readback matched the generated image byte-for-byte, SHA-256
  `a2c75d1724093c9e2f26d413876867cea8a94391cb2d7b8ef6a2674a65fac07c`.
- Bootloader/partition artifacts were generated but not flashed. Their hashes match
  the recorded prior build. The combined factory image was not used.
- The bundled esptool script first hit a host-side progress-logger exception during
  partition reading, before any write. Retrying with the installed esptool 5.4.0 CLI
  and `--no-progress` succeeded; no dependency or firmware patch was made.
- Watchdog reset booted the app. Serial reported `WAND-B602`, firmware 0.1.0,
  boot `B891A866`, sensor present, WHO_AM_I `0x11`, 50 Hz / +/-8 g reported profile.
  Idle status: free heap 156,992 bytes; axes `(-12,212,972)` mg in uncontrolled placement.
  All 37 built-in protocol checks passed, including the upstream nonconforming nonzero-OPEN
  fixture. This does not override the conformance finding below.

### Native BLE measurement

The corrected checker requested OPEN sequence zero. Advertising/service UUID,
connection, INFO decoding/profile/device identity, both subscriptions and no motion
before OPEN passed. OPEN then returned **no kind-1 result within 1,500 ms**. The checker
exited nonzero before SYNC, the planned 30-second stream and feedback checks.

This is an observed handshake failure, consistent with the STATUS overwrite mechanism
below. It is not a completed H2 run. Battery-only boot, physical display/cues, H1 sensor
truth, H3 loaded stability, H4 reconnect/battery and H5 two-player acceptance remain open.
The reported earlier battery boot loop has not been reproduced or diagnosed in this image.

## Verdict before hardware

An app-only diagnostic flash can proceed only under the existing backup, partition
comparison and recovery safeguards. No change in this commit expands the flash region or
alters the partition table. This review does **not** predict that the image will complete
the browser handshake: the new direct CONTROL callback has a concrete STATUS-notification
payload hazard that must be resolved by an actual OPEN/SYNC test immediately after boot.

The reported 0.1.2 battery-only boot loop has no established cause. Commit `6a50929` does
not change brownout/reset handling, boot power sequencing, LED brightness, accelerometer
setup or battery diagnostics, so a successful USB boot or app-only flash must not be
presented as a battery fix. Capture the reset reason and boot log on battery before drawing
that conclusion.

## Compatibility retained

- The commit changes only `ble.h`, `present.h`, `ble.cpp`, `display.cpp`, `main.cpp`,
  `present.cpp` and the laptop checker. It does not change the service/characteristic UUIDs,
  20-byte record layouts, little-endian codec, capabilities, 50 Hz / +/-8 g INFO profile,
  units, axes identifier, opcodes, result codes or feedback enums. The browser therefore
  remains wire-compatible (`firmware/include/config.h:8-23`,
  `firmware/src/proto.cpp:25-107`, `apps/web/src/wand/protocol.ts:4-10,253-256`).
- CONTROL is still Write-with-Response and STATUS remains Read + Notify
  (`firmware/src/ble.cpp:70-79`). The browser subscribes before sending OPEN and begins at
  sequence zero (`apps/web/src/wand/client.ts:147-177,272-285`).
- Motion acquisition remains a priority-4 FreeRTOS task, separate from the Arduino display
  loop (`firmware/src/wand.cpp:11-14,92-125`). The display optimization therefore does not
  directly move I2C sampling onto the drawing path.

The firmware still reports `0.1.0` in INFO and the console
(`firmware/include/config.h:3-6`), despite materially different behavior from the earlier
0.1.0 image. Record the commit and binary SHA-256; the reported semantic version cannot
distinguish the artifacts.

## Findings

### P1 functional gate — command-result notification can be overwritten by health

The direct `on_control` callback encodes a result and calls `ble::notify_status` on the
NimBLE host task (`firmware/src/main.cpp:57-74`). `notify_status` sets the STATUS
characteristic to that result, invokes zero-argument `notify()`, and immediately restores
the characteristic to the health record (`firmware/src/ble.cpp:110-117`).

The fresh build resolved NimBLE-Arduino 2.5.1. In that library, zero-argument `notify()`
does not copy the current value into a notification; it calls `ble_gatts_chr_updated`,
which marks the characteristic modified and queues notification work on the host parent
event queue. Because this code is already inside that host task, the queued send cannot be
assumed to run before the callback restores the health value. The command result can
therefore be coalesced away or emitted as a health record. This would make browser OPEN or
SYNC wait until timeout even though the ATT write itself succeeded.

This was a source-grounded risk before flashing. The subsequent native test recorded above
observed the predicted missing OPEN result, though it did not instrument the internal host
queue. Treat the image as diagnostic until the name-pinned checker receives the correct
kind-1 OPEN result, five SYNC results and loaded state/cue results. A STATUS health packet or
an ATT write response is not substitute evidence.

### P1 lifecycle — direct callbacks are not scoped to the physical connection generation

Connect/disconnect callbacks increment `g_gen`, but `ControlHandler` carries only bytes,
length and receipt time (`firmware/include/ble.h:5-20`, `firmware/src/ble.cpp:18-42`). The
Session reset remains deferred to the Arduino loop (`firmware/src/main.cpp:143-153`). A
CONTROL write that reaches the new connection before the loop observes the generation can
therefore be handled against the previous Session. The most visible outcome is a reconnect
OPEN rejected because the old Session is still open; the contract requires each physical
link to forget the old nonce/session (`BADGE-FIRMWARE-CONTRACT.md:132,172,176`).

The browser's own generation guards prevent old browser callbacks from becoming gameplay
input, but they cannot repair a badge-side OPEN rejection. This is an interleaving hazard,
not a claim that it happened in the prior short hardware run. Include rapid reconnects in
the immediate diagnostic and retain H4's 20-cycle test before relying on this image.

### P1 lifecycle — active screen/LED cues survive epoch change and state expiry

`Session::reset`, a new presentation epoch and lease expiry clear only cues still in the
Session queue (`firmware/src/proto.cpp:113-124,205,249-254`). Once main copies a cue out and
calls `present::play_cue`, the presentation and LED layers own independent timers
(`firmware/src/main.cpp:159-174`, `firmware/src/present.cpp:42-65`,
`firmware/src/leds.cpp:54-98`). No epoch/expiry path cancels those active timers.

`present::link_changed` clears the screen cue on a later loop iteration, but it does not
cancel the LED cue (`firmware/src/present.cpp:36-40`). Consequently an old cast/hit/result
can remain on screen after expiry/new epoch and on LEDs after expiry/new epoch/disconnect,
for up to the 1,000 ms cue duration. This contradicts the lifecycle requirements in
`BADGE-FIRMWARE-CONTRACT.md:141-143`. It does not change combat authority, but it is a visible
wrong-round effect and blocks the feedback/reconnect acceptance claim.

There is a second concurrency window: main copies due cues and the old DisplayState under
the mutex, releases it, and only then starts presentation. A host-task SET_STATE with a new
epoch or a disconnect can occur between those steps, after which main can still start the
copied old cue (`firmware/src/main.cpp:159-174`).

### P2 conformance — initial OPEN and the upstream checker disagree with v1

The contract requires OPEN sequence zero (`BADGE-FIRMWARE-CONTRACT.md:118-125`). The
firmware accepts any initial sequence (`firmware/src/proto.cpp:149-169`) and even retains a
self-test fixture that establishes a Session with sequence 65535
(`firmware/src/proto.cpp:389-400`). The copy of `tools/wand_ble_check.py` in commit 6a50929
randomized the initial sequence. The currently resolved working-tree checker has correctly
restored `seq = 65535` so `next_seq()` sends OPEN zero; use that corrected checker for the
post-flash measurement.

This mismatch does not block the current browser, which always sends OPEN zero, but an ALL
PASS from the uncorrected upstream checker would not prove exact v1 behavior.

### P2 timing/observability — missed IMU updates are not counted as drops

The acquisition task timestamps immediately before polling data-ready, reads one latest
register image, increments `seq`, and calls NimBLE notify (`firmware/src/wand.cpp:26-89,
92-110`). It increments `dropped` only when its own age check exceeds 100 ms or
`notify_motion` returns false. The driver checks ZYXDA but does not inspect/report the IMU
overrun indication (`firmware/src/accel.cpp:79-109`). If the task is delayed across sensor
updates, overwritten hardware samples are therefore not counted and the next read is given
a fresh sequence without a discontinuity marker.

NimBLE's characteristic-update notification path is bounded and naturally coalesces to a
newer value under backpressure, but zero-argument `notify()` reports scheduling success, not
eventual delivery. Firmware cannot use that return value to count a later coalesced/radio
loss. Capture timestamp gaps and browser sequence gaps remain useful independent evidence;
the STATUS dropped count alone is not a complete overrun/loss measure. This blocks a strong
H3 loss-accounting claim, not a short diagnostic attempt.

### P2 display/resource — the new canvas is buffered blocking SPI, not DMA

Each changed text field is rendered into one persistent 300 x 24 RGB565 canvas (14,400
bytes) and pushed via `drawRGBBitmap` (`firmware/src/display.cpp:18-22,31-46,112-118`). In
the resolved Adafruit/Arduino ESP32 path this sets one address window and performs blocking
row writes; no asynchronous DMA lifecycle is introduced. It should be substantially faster
than per-pixel direct text drawing, and allocation failure safely falls back to the old path,
but it still blocks the Arduino loop during each transfer and permanently reduces heap
headroom.

The higher-priority acquisition task is architecturally isolated from that loop, so source
review does not show the screen directly blocking I2C reads. Only a combined-load run can
establish that BLE notifications, task scheduling, heap and longest capture intervals remain
within target. Record free/minimum/largest heap, acquisition task stack headroom, reset
reason, command RTT and capture/arrival gaps; this upstream image lacks the richer 0.1.2
resource diagnostics.

### P2 reproducibility — source commit does not freeze its dependency graph

`platformio.ini` uses a moving `stable` platform URL and compatible-version (`^`) library
ranges (`firmware/platformio.ini:9,24-29`). The fresh build resolved NimBLE-Arduino 2.5.1;
that fact is not derivable from commit 6a50929 alone and can change on a later clean build.
Preserve the resolved package/version inventory and the built binary hash with the flash
record. This is especially important because the P1 notification behavior depends on the
resolved library implementation.

## Minimum evidence immediately after a diagnostic flash

1. Record the app binary hash, resolved PlatformIO/framework/library versions, app-only
   offsets, partition comparison and readback verification.
2. Capture serial boot identity, reset reason if available, sensor identity and on-device
   self-test. Do not infer the battery-loop cause from a USB boot.
3. Run the corrected name-pinned BLE checker. OPEN must be sequence zero and must receive a
   kind-1 result with matching nonce/sequence/opcode—not merely a health record. Require five
   valid SYNC results and loaded SET_STATE/CUE results before opening the web path.
4. If that passes, verify the actual browser connects, reaches streaming and receives fresh
   motion. Then do a rapid disconnect/reconnect check and visually verify that disconnect,
   lease expiry and a new epoch remove both screen and LED cues.
5. Separately reproduce battery-only boot with reset/serial evidence. H1 axes/scale, the
   10-minute H3 combined-load run and full H4/H5 remain open regardless of a short pass.

## Review boundary

Static review establishes unchanged bytes and the risks above. It does not establish that
the badge boots, that the notification hazard manifests on the controller/OS combination,
that display output is correct, or that battery power caused the prior reset. Those require
the explicitly recorded physical checks after the independently authorized flash.
