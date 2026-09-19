# Firmware integration review

**Historical report.** Sai subsequently requested discarding all local firmware fixes.
The current tree matches teammate main `6a50929`; use the [new review and flash
record](firmware-main-6a50929.md). The remediation descriptions and measurements below
apply only to the earlier images and do not qualify the current firmware.

Date: 2026-09-19
Reviewed: the `firmware/` 0.1.0 baseline at `14db1b3` as merged by `6c1b857`, the
working-tree 0.1.1/0.1.2 remediation, `BADGE-FIRMWARE-CONTRACT.md`, and the active
`apps/web/src/wand/` adapter.
Scope: source review and host tests, plus the separately reported 0.1.1 build/flash/serial,
native-BLE/on-device/visual evidence and 0.1.2 app-only flash, idle resources and native-BLE
evidence below. Claims are limited to the reported observations; no browser, axes/scale,
loaded-stability, battery, or second-central result is inferred.

## Verdict

The active web adapter is byte- and GATT-surface compatible with this firmware:
the UUIDs, 20-byte little-endian records, characteristic properties, subscription
order, write-with-response behavior, OPEN/SYNC flow, deadlines, and enums match.
It is appropriate for a controlled browser-on-badge integration attempt.

It is **not yet qualified for duel Ready or a prize-demo claim**. The 0.1.0 baseline
had two source-level lifecycle defects that could leak prior-link/prior-round state;
0.1.1 repairs them and passed build/flash/serial boot, native-BLE H2 and 20 native
disconnect/reconnect cycles. Firmware 0.1.2 was subsequently flashed app-only with a verified
readback and passed a 30-second native-BLE H2 run. The required sensor axes/scale, 0.1.2 axis
guard, loaded-stability, battery, second-central and Windows Chrome evidence remain incomplete.

### Working-tree remediation after review

The flashed firmware `0.1.1` remediation addresses the two lifecycle defects and
the OPEN-zero mismatch found below. The `0.1.2` working-tree follow-up adds
the reboot-gated axis configuration, resource diagnostics, and exact build pins:

- CONTROL writes carry a connection generation, the queue is purged at both link
  transitions, and main drops a record if its captured/current generation differs
  (`firmware/src/ble.cpp:12-16, 27-54, 131-138`;
  `firmware/src/main.cpp:109-140`).
- disconnect, state expiry and a changed nonzero presentation epoch cancel both the
  screen and LED active cue (`firmware/src/main.cpp:109-149`;
  `firmware/src/present.cpp:36-44`; `firmware/src/leds.cpp:54-71`).
- initial OPEN now requires sequence zero, with a legal forward-gap wrap fixture
  and explicit rejection check (`firmware/src/proto.cpp:149-169, 389-406, 423-440`).
- firmware 0.1.1 added exact control-register readback while 0.1.0 remains the
  teammate-tested BLE baseline. The working tree is versioned 0.1.2 to distinguish it
  from the recorded 0.1.1 flashed image. Control-register values are reported in boot/console diagnostics
  (`firmware/src/accel.cpp:46-54`; `firmware/src/main.cpp:42-50`).
- the boot diagnostic no longer scans the unused NFC device on the shared I2C bus;
  it uses the targeted accelerometer identity/configuration reads instead, matching
  `BADGE-FIRMWARE-CONTRACT.md:270-275`.
- 0.1.2 rejects connected axis writes and persists disconnected changes for the next
  boot only; its `status` output includes heap low-water/largest-block and acquisition
  stack high-water metrics, and its PlatformIO/direct-library inputs are exact.

The pure C++ protocol self-test passes 41 checks on the host with warnings treated
as errors, and the complete 0.1.1 Arduino/NimBLE image built successfully. Four intended
artifacts were flashed while stock-data regions were excluded. The badge booted through
the watchdog-reset fallback after RTS hard reset left it in download mode, then serial
reported `HPDIAG|accel=1|who=11|ctrl1=47|ctrl4=A0` and
`HPHELLO|fw=0.1.1|name=WAND-B602|boot=6A321685|sensor=1`. These facts establish the
flashed version and sensor-register readback at boot. A subsequent 15-second native-BLE
H2 run passed at 48.7 Hz with zero sequence gaps, the on-device protocol self-test passed
41 checks, and Sai visually confirmed that the display and LEDs operate. The evidence does
not establish six-face axes/scale, the browser path, reconnect behavior, or H3/H4 stability.

The 0.1.1 image then completed 20 name-pinned native-BLE disconnect/reconnect cycles;
all passed at 48.0-49.5 Hz with zero sequence gaps. This exercises reconnect on that
image, but is not full H4 because battery, second-central and resource-trend evidence
remain absent.

The authorized 0.1.2 update wrote only the application at `0x10000` and verified the
readback SHA-256 from the build manifest. It booted as firmware 0.1.2 on `WAND-B602`
with sensor present and control-register readback `0x47 / 0xA0`. Idle status reported
171,264 bytes free heap, 171,076 bytes minimum free heap, a 114,676-byte largest
allocatable block, and 5,228 bytes acquisition-task minimum free stack.

A subsequent name-pinned 30-second native-BLE run passed: 1,465 decodable frames in
30.1 seconds (48.7 Hz), zero sequence gaps, malformed frames, discontinuities,
saturation flags or device drops. Capture intervals were mean/min/max `20.5 / 19 / 22 ms`;
host arrival mean/max was `20.5 / 61 ms`. OPEN RTT was 59 ms and SYNC RTT
min/median/max was `59 / 89 / 91 ms`; state/cue acceptance and rejection checks passed,
34 health notifications arrived, and final health bits were `0xF`. Mean uncontrolled-placement
axes were `(-273, -190, 776)` mg, which does not qualify axes or scale. This is native
macOS GATT evidence, not browser, H3 or full H4 evidence.

## Findings

### P1 — An active cue survived lifecycle events (remediated in 0.1.1 source)

At the reviewed `14db1b3` baseline, `Session::reset`, state expiry, and a new
presentation epoch cleared only the four pending protocol cues
(`firmware/src/proto.cpp@14db1b3:113-124,205,249-254`). Once main dequeued a cue
into the presentation layer, the screen and LED layer owned separate timers.
`present::link_changed()` cleared the screen cue only and never cleared the LED
cue; state expiry and epoch changes did not call even that function. The LED
renderer continued giving an active cue priority until its duration ended, and the
screen cue could likewise remain until its own timer expired.

This violates the contract requirement that disconnect clear feedback immediately
and cue duration never override state expiry or a new epoch
(`BADGE-FIRMWARE-CONTRACT.md:141-143, 171-176`). A hit/victory/cast from the old
round can therefore remain visible for up to 1,000 ms in a new/expired context.

### P1 — CONTROL queue entries lacked physical-link scope (remediated in 0.1.1 source)

At `14db1b3`, the queued record contained bytes, length, and receipt time, but no
BLE connection generation. Connect/disconnect incremented a global generation but
did not purge the queue; writes were enqueued and popped without generation
validation. Main reset the session on a generation change and then drained every
queued write (`firmware/src/ble.cpp@14db1b3:12-51,127-133`;
`firmware/src/main.cpp@14db1b3:107-129`).

A write queued immediately before link loss can therefore be applied after the
session reset. In the worst reconnect interleaving, an old OPEN establishes the old
nonce in the new link generation, causing the real new OPEN to fail. This is a
source-derived race; it was not claimed as observed on hardware. It contradicts
OPEN clearing prior queues and disconnect forgetting the prior physical link
(`BADGE-FIRMWARE-CONTRACT.md:132, 172, 176`) and blocks a trustworthy H4 reconnect
claim.

The 20-cycle 0.1.1 reconnect run above provides useful evidence for the repaired queue/link
lifecycle, but it does not close H4 for 0.1.2 or cover battery and second-central behavior.

### P1 gate — 50 Hz / ±8 g sensor truth and contract axes remain unqualified

The driver writes inferred 50 Hz and ±8 g values and assumes 4 mg/count
(`firmware/src/accel.cpp:11-16, 107-114`). Firmware 0.1.1 now fails sensor setup
unless both control registers read back exactly as written
(`firmware/src/accel.cpp:46-54`), but the creator reference only establishes
100 Hz / ±2 g and 1 mg/count; the contract explicitly requires primary confirmation,
register readback, signed vectors, all six faces, and rail/clipping evidence before
accepting ±8 g (`BADGE-FIRMWARE-CONTRACT.md:257-266`). The firmware README itself
says the X/Y mapping and six-face check remain open (`firmware/README.md:15-20`).

This is a qualification blocker, not evidence that the selected register value is
wrong. Until H1 is recorded, INFO claiming the completed `50 Hz / ±8 g / axes 1`
profile cannot be treated as sufficient proof for real casting.

### P2 — Firmware and the hardware checker accepted an invalid initial OPEN sequence

The contract says OPEN starts at command sequence zero
(`BADGE-FIRMWARE-CONTRACT.md:124, 172`). Firmware 0.1.0 accepted any sequence for
the first OPEN (`firmware/src/proto.cpp@14db1b3:149-169`), and its self-test
deliberately opened at `65535` (`firmware/src/proto.cpp@14db1b3:389-396`). The laptop checker used
for that 0.1.0 report randomized its initial sequence and incremented it before OPEN
(`tools/wand_ble_check.py@6c1b857:47-48, 75-84, 146`),
so the reported hardware session almost certainly did not exercise a conforming
OPEN-zero handshake.

The active web client is correct here: it starts at zero and its encoder rejects a
nonzero OPEN (`apps/web/src/wand/client.ts:191-204, 272-285` and
`apps/web/src/wand/protocol.ts:376-381`). Firmware 0.1.1 now rejects nonzero OPEN.
The Python checker now starts at zero before testing the patched image. The 0.1.0 README hardware report therefore establishes useful BLE bring-up,
not a strictly conforming initial handshake.

### P2 — Axis remapping could change live without a reboot or discontinuity (remediated in 0.1.2 source)

The baseline USB `axes` command mutated three map/sign fields one by one, immediately and
persistently (`firmware/src/console.cpp@14db1b3:79-96`), while the acquisition task read
them without synchronization (`firmware/src/wand.cpp@14db1b3:26-40, 131-145`). The change
does not stop streaming, change boot/INFO, or set the discontinuity flag. One sample
can observe a partially updated mapping, and subsequent samples silently switch
coordinate interpretation within the same stream.

Firmware 0.1.2 source rejects axis changes while any BLE central is connected, persists
the requested map without applying it to acquisition, and reports that an explicit reboot
is required (`firmware/src/console.cpp:82-107`; `firmware/src/main.cpp:74-75`). The acquisition
map is therefore fixed for the entire boot. This follow-up is
present in the flashed 0.1.2 image, but the connected rejection and reboot-only activation
paths have not yet been exercised on hardware.

### P2 gate — Reproducibility and H3/H4 evidence are incomplete

Firmware 0.1.2 source pins pioarduino `55.03.312`, NimBLE-Arduino `2.5.1`, NeoPixel
`1.15.5`, GFX `1.12.6`, BusIO `1.17.4`, and ST7735/ST7789 `1.11.0`, matching the
resolved successful 0.1.1 build (`firmware/platformio.ini:9,24-29`). Its `status` path adds
minimum free heap, largest allocatable heap block, and acquisition-task stack high-water
mark in bytes (`firmware/src/console.cpp:67-78`; `firmware/src/wand.cpp:143-145`). The idle
0.1.2 readings are recorded above, but no loaded trend exists. The repository now has a
captured native-BLE H2 result and an 0.1.1 20-cycle reconnect result, but still lacks
connection parameters, a distinct allocation-failure counter, a 10-minute combined-load
run, battery run, second-central test, and intended Windows/Chrome/adapter result.

The README's badge report is useful bring-up evidence, but it is a prose report:
WAND-46BA advertised, completed a laptop INFO/OPEN/SYNC/state/cue session, and
reported 50 Hz with zero observed sequence gaps and 16-31 ms SYNC RTT
(`firmware/README.md:15-20`). It explicitly leaves visual feedback, six-face axes,
and Windows Chrome open. Treat that as teammate-reported hardware evidence, not as
an independently reproduced H2-H4 qualification.

### P3 — The stated ~1 ms acquisition timestamp bound is not established by source

The acquisition timestamp is taken before the fresh-data status transaction and
six-byte data transaction (`firmware/src/wand.cpp:92-101`), while I2C operations use
a 10 ms timeout (`firmware/src/accel.cpp:16, 30-41, 86-99`). This is a reasonable
“prompt read” timestamp design, but the source alone does not prove README's
“within ~1 ms” claim (`firmware/README.md:157-160`). Record the actual
data-ready-to-read bound under combined load as required by H1/H3.

## Direct browser interoperability

Source-level result: **yes, with the lifecycle caveats above**.

- Firmware and web use the same service and four characteristic UUIDs
  (`firmware/include/config.h:8-14`, `apps/web/src/wand/protocol.ts:4-10`).
- Firmware exposes INFO read, MOTION notify, CONTROL write, and STATUS read/notify
  (`firmware/src/ble.cpp:78-87`); the browser reads those values, subscribes STATUS
  then MOTION, and uses `writeValueWithResponse`
  (`apps/web/src/wand/transport.ts:91-149`, `apps/web/src/wand/client.ts:147-177`).
- Both codec suites pin the same contract golden bytes. The firmware pure-C++
  self-test passed 41 checks with zero failures after remediation. The active web
  protocol/transport/client suite passed 32 tests.
- The web client's OPEN sequence is zero, five SYNCs match the contract, state/cue
  leads fit the firmware limits, and ACK matching checks nonce, sequence, opcode,
  and browser connection generation.

This establishes deterministic source compatibility; it does **not** establish a
Chrome-to-WAND-B602 run. The hardware reports used the Python/Bleak checker, and the
README explicitly says the Windows Chrome picker remains unverified.

## Minimum integration exit criteria

1. Exercise 0.1.2's connected axis-write rejection and reboot-only activation; repeat the
   reconnect/resource-trend gate on the actual 0.1.2 image.
2. Run H3 for 10 minutes and retain heap minimum/largest-block, acquisition stack,
   notification/drop, timing-gap and reset evidence.
3. Complete and record H1: exact config readback, signed vectors, six faces, clipping,
   fresh cadence, and timestamp bound.
4. Retain the existing image/hash/offset/config manifest with the qualified-image evidence.
5. Run the active `apps/web/src/wand/` path against WAND-46BA in intended Windows
   Chrome, then H3 combined-load and H4 reconnect/battery/second-central gates with
   the required resource and timing measurements.
