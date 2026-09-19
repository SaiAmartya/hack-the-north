# Badge firmware ↔ game platform contract

**Status:** proposed v1 team handoff, September 19, 2026. Not yet accepted by the firmware team or validated on custom firmware. Companion: [MVP-OUTLINE.md](MVP-OUTLINE.md).

**In plain English:** deliver a battery-powered wand that connects directly to Chrome, streams trustworthy motion, reports when something is wrong, and displays small feedback messages from the game. We will build all spell recognition, speech handling, multiplayer, combat, camera/video and Three.js graphics.

This specifies **observable behavior and the shared interface**, not how to implement firmware. The two firmware teammates own language/SDK, board support, drivers, scheduling, memory and flashing. They may choose any implementation that passes this contract. The UUIDs/bytes below are proposed project constants, not existing badge APIs; agree changes here before either side forks its implementation.

## 1. Deliverables and ownership

| Firmware team delivers | Platform team delivers |
| --- | --- |
| A dedicated image that boots into the wand, without the Lua launcher | Windows Chrome companion and explicit device-selection/setup flow |
| One BLE peripheral connection; fresh acceleration notifications with identity/timing/validity | GATT adapter, binary validation, timing/liveness and simulator |
| Screen/LED connection status, local activity, and a small host-controlled feedback vocabulary | Calibration, gesture segmentation/classification, microphone recognition and voice/motion fusion |
| Device health, command acknowledgements, safe link-loss behavior | Authoritative Python referee, sessions, rules, video, HUD and Three.js |
| Versioned binary + build identifier, flash/recovery instructions and measurement log | Shared golden vectors, replay traces, conformance runner and integration test cards |

**Required for the completed MVP:** one untethered badge per player; no combat buttons; motion + speech required; no device-side combat authority. Two other badges are spares for development/recovery. No receiver badge, serial gameplay bridge, badge Wi-Fi, onboard speech, camera processing, extra peripherals, over-the-air updates or raw image/audio downloads in v1.

**Early integration image:** prioritize identity → BLE connect → fresh motion → OPEN/SYNC/status. Simple text and LED pulses are sufficient. Device Lab can inspect an incomplete image; real-duel Ready requires the complete mandatory capabilities. Do not wait for polished artwork to hand us a stream.

## 2. Hardware facts versus requested behavior

- **Board evidence:** the prior stock-image boot log identifies ESP32-C3, 4 MB flash and SC7A20H over I²C. It does not validate this new firmware. [Hardware report](docs/hardware-verification.md)
- **Chip capability:** ESP32-C3 supports Bluetooth LE and Wi-Fi, with 400 KB total internal RAM; free heap depends on the complete image. Old Lua heap/tick/44-byte-radio limits do not define this interface. [Espressif](https://www.espressif.com/en/products/socs/esp32-c3)
- **Sensor capability:** the SC7A20H provides three-axis, 12-bit acceleration and selectable ±2/4/8/16 g ranges. We request a 50 Hz stream, initially ±8 g, to be validated for noise/clipping. This is not six-axis tracking: no gyro/yaw/position reconstruction is required. [Silan manufacturer specification](https://www.silan.com.cn/en/index.php/product/details/3235.html)
- **Presentation/power:** use the existing 320×240 screen, six RGB LEDs and supported two-AA battery power. No assumed vibration motor, microphone or speaker. The team must confirm board revision, pin mapping, actual drivers and safe power/USB behavior with the creators. [Badge site](https://badge.hackthenorth.com/), [manual](https://badge.hackthenorth.com/manual)

Keep streaming responsive while the screen and LEDs update. Firmware may reduce decorative refresh/brightness to preserve memory, timing and battery. We require measured behavior, not a particular RTOS, task layout, graphics library or CPU clock.

## 3. Wireless connection and GATT surface

**Selected path:** badge BLE peripheral ↔ laptop Bluetooth adapter ↔ Chrome Web Bluetooth. No specialized IDE or local native bridge during gameplay. Chrome supports GATT reads, writes and notifications on Windows; discovery requires a user click and secure context. Qualify the exact Windows/Chrome/adapter combination. [Chrome documentation](https://developer.chrome.com/docs/capabilities/bluetooth)

Use one custom service and four characteristics. Each value below is **exactly 20 bytes**, fitting the baseline ATT MTU of 23 without application fragmentation. No JSON, text parsing, bulk transfer, negotiated large-MTU requirement or per-sample application ACK. Motion uses notifications, not confirmed indications. The stack may handle link-layer retransmissions; the application must not replay old motion. [ESP32-C3 GATT model](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/ble/get-started/ble-data-exchange.html)

| Attribute | Proposed UUID | Properties / purpose |
| --- | --- | --- |
| WAND service | `7f510000-1b15-4f0d-8f3c-8db47a812000` | Advertised custom service |
| INFO | `7f510001-1b15-4f0d-8f3c-8db47a812000` | Read; identity, firmware and fixed stream profile |
| MOTION | `7f510002-1b15-4f0d-8f3c-8db47a812000` | Notify; one fresh sample per notification |
| CONTROL | `7f510003-1b15-4f0d-8f3c-8db47a812000` | Write with response; session, sync, state and cue commands |
| STATUS | `7f510004-1b15-4f0d-8f3c-8db47a812000` | Read + Notify; current health and command results |

- Advertise the service UUID and an identifiable name such as `WAND-7A3C`; the name may live in the scan response to fit advertising limits. Screen shows the same short ID and full device ID in diagnostics. Short IDs must be distinct across our demo badges.
- Support **one central at a time**, stop connectable advertising while connected, resume on disconnect. No Windows Bluetooth Classic/SPP or OS COM-port assumption.
- A stable six-byte `device_id` is public device identity, unique across our badges and stable across reboot/reflash. Use bytes explicitly, not an assumed browser-visible MAC. No user's name, organizer account ID or secret in advertising.
- The browser serializes GATT reads/writes/subscription operations; subscriptions remain active while commands run. Duplicate notifications or callbacks must not produce duplicate input.
- No bonding/encryption/authenticated pairing guarantee in v1. User selection, visible ID and movement confirmation prevent accidental misbinding, not malicious interference. The nonce below prevents stale-session application commands, not hostile clients. No sensitive data crosses BLE.

## 4. Shared binary rules and uplink

All offsets are zero-based bytes. All multi-byte integers are **little-endian**; signed values are two's complement. Protocol version is `1`. Reserved bytes/bits are zero. Encode fields individually; never send a compiler's padded struct. Reject unsupported version, wrong length, nonzero reserved bits or out-of-range fields without a side effect. No extra application checksum: exact-length/version/field validation supplements BLE's link integrity.

### INFO — 20 bytes

| Offset | Type | Field / v1 meaning |
| --- | --- | --- |
| 0 | u8 | `version = 1` |
| 1 | u8 | `capabilities`: bit 0 raw motion, bit 1 state feedback, bit 2 cue feedback, bit 3 clock sync; completed MVP requires `0x0F` |
| 2 | u8 | `sample_hz = 50` |
| 3 | u8 | `range_g = 8` initially; profile changes require joint agreement and fresh calibration |
| 4–9 | 6 bytes | Stable `device_id`, displayed as 12 hex digits in byte order |
| 10–13 | u32 | Nonzero random `boot_id`, new on each firmware boot |
| 14, 15, 16 | u8 each | Firmware major, minor, patch; release manifest maps these to the exact build/hash |
| 17 | u8 | `axis_convention = 1` as defined below |
| 18–19 | 2 bytes | Reserved zero |

INFO is constant for a boot. A sensor configuration change requires a reboot/new INFO, not an invisible mid-round profile change. Version and capabilities are checked on every connection. The app rejects unsupported profiles with a useful explanation rather than guessing a scale.

### MOTION — 20 bytes

| Offset | Type | Field / meaning |
| --- | --- | --- |
| 0 | u8 | `version = 1` |
| 1 | u8 | Flags: bit 0 valid reading; bit 1 saturated/clipped; bit 2 acquisition/queue discontinuity since previous emitted sample |
| 2–3 | u16 | `seq`, advances for each fresh acquired sample while streaming, including samples subsequently dropped before delivery |
| 4–7 | u32 | `capture_ms`, monotonic milliseconds since boot at acquisition/read, **not** notification enqueue time |
| 8–11 | u32 | `boot_id`, matching INFO |
| 12–13 | i16 | `ax_mg` |
| 14–15 | i16 | `ay_mg` |
| 16–17 | i16 | `az_mg` |
| 18–19 | 2 bytes | Reserved zero |

**Units and axes:** `1000 mg = 1 g`; retain gravity, with no player-specific calibration, gravity subtraction or gesture filtering in firmware. +X is screen-right, +Y screen-top, +Z outward from the screen, viewed from the badge front. This is a contract coordinate convention, not an assertion of the chip's native mounting. Firmware remaps chip axes/signs; platform handles the user's grip. With the front facing upward on a level table, expect approximately `(0, 0, +1000)` mg. Verify all six static faces and signed conversion against gravity before interpreting gestures.

For the ±8 g profile, round normalized values to integer mg and clamp to `[-8000, +8000]`. Mark saturated if any native sensor axis rails or any normalized value requires clamping; valid may remain set for a fresh but clipped sample, which the browser excludes from gestures. Values outside that domain are malformed, not silently clamped by the browser. Endpoints −8000 and +8000 encode as `c0 e0` and `40 1f`; +8001 (`41 1f`) and −32768 (`00 80`) are invalid for this profile. Native quantization may reach its rail before exactly 8000 mg; that still requires saturated.

**Freshness:** 50 fresh samples/s, normally 20 ms apart. Use sensor new-data semantics; rereading one old register image must not masquerade as new acquisitions. If exact sensor timestamps are unavailable, timestamp the prompt read of fresh data and document/bound that acquisition-to-read delay. Do not fabricate valid zero vectors on I²C failure. Report a sensor fault through STATUS; if an invalid sample is emitted, clear valid and set unused axes to zero. Invalid, clipped or discontinuous data breaks the current gesture; it is not interpolated into evidence.

Use a bounded latest-sample policy under backpressure; no growing history or catch-up delivery. Drop samples older than 100 ms before enqueue, count local discards/overruns, and mark the next emitted sample's discontinuity bit. Controller/OS buffering remains possible: the browser independently checks capture age. A constant sensor value can be a valid stationary acquisition; equality of values alone is not a stale-data test.

The platform handles modular `seq16` and `capture_ms32` wraps; boot ID distinguishes restart. Accept sequence progress only when `0 < (new - old) mod 65536 < 32768`; gaps are observable. Clock wrap uses the same half-range principle at 32 bits. Ignore duplicate/out-of-order records; a boot change or unexplained backward timestamp requires a new handshake. At 50 Hz, seq wraps in about 21.8 minutes, so test wrap even in a short demo.

## 5. Downlink: four commands, small semantic feedback

### CONTROL — 20 bytes

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | u8 | `version = 1` |
| 1 | u8 | Opcode below |
| 2–3 | u16 | `command_seq`, increasing within the link; OPEN starts at 0 |
| 4–7 | u32 | Nonzero random `link_nonce` chosen by the browser for each new GATT connection |
| 8–11 | u32 | `arg0` |
| 12–15 | u32 | `arg1` |
| 16–19 | u32 | `arg2` |

| Opcode | Name | Arguments and observable behavior |
| --- | --- | --- |
| 1 | OPEN | All args zero. Establish nonce for this physical connection, clear prior presentation/queues, ACK and permit motion if subscribed. Initial handshake, not a cast |
| 2 | SYNC | All args zero. ACK echoes command ID and device command-receipt time; enables browser clock mapping |
| 3 | SET_STATE | `arg0` packs phase/HP/maxHP/status into four bytes (least significant first); `arg1 = presentation_epoch`; `arg2 = valid_until_ms` in device time. Replace displayed state, not combat rules |
| 4 | CUE | `arg0` packs effect:u8, spell:u8, duration_ms:u16; `arg1 = presentation_epoch`; `arg2 = start_before_ms` in device time. Brief one-shot presentation only |

`phase`: 0 connected/idle, 1 practice, 2 countdown, 3 playing, 4 won, 5 lost, 6 draw, 7 aborted. `HP` is 0–100 and `maxHP = 100`; display HP only in play/result phases. `status` bits: 0 shield active, 1 offense locked; others zero. These reflect the server snapshot; firmware never calculates their expiry or gameplay effect.

`effect`: 1 accepted cast, 2 blocked incoming hit, 3 took damage, 4 round result. `spell`: 0 none, 1 Stupefy, 2 Protego, 3 Expelliarmus. Accepted cast requires spell 1–3; result requires spell 0 and current phase won/lost/draw. Block/damage may include the responsible spell. Duration is 1–1000 ms. The state phase determines the outcome; cues cannot change it. Even within the same epoch, the browser waits for OK on the matching result SET_STATE before sending a result CUE; firmware rejects a result cue while phase is not a result.

`presentation_epoch` is a nonzero browser-generated value changed on every round/setup reset; it is presentation scope, not a server credential. SET_STATE with a new epoch clears pending/active cues. CUE must match the current unexpired state epoch. Before sending a new-epoch cue, the browser must receive OK for its SET_STATE. On leaving a round, clear unsent cues and send fresh idle/aborted state; old cues cannot spill into rematch.

**Expiry:** browser refreshes SET_STATE approximately every 500 ms, choosing `valid_until_ms` about 1200 ms ahead of estimated device time; firmware permits at most 1500 ms remaining. Choose CUE's start deadline about 300 ms ahead; firmware permits at most 500 ms remaining. The browser accounts for clock uncertainty and never constructs deadlines right at these caps. Firmware rejects already-expired or excessively distant deadlines using wrap-safe differences. When state expires, clear HP/result/cues to neutral link-stale status. Disconnect clears immediately; a frozen host therefore cannot leave a permanent victory/hit display. Cue duration never overrides state expiry or a new epoch.

**Ordering and backpressure:** one outstanding browser command at a time, one coalesced latest state and at most four fresh unsent cues. Do not queue screen frames. OPEN may be retried once with identical bytes/sequence if its application ACK is missing. SET_STATE, SYNC and CUE are not retried: a later state refresh or sync probe uses a new sequence. Command timeout is 1 second; setup commands failing block Ready, presentation-only failures mark degraded feedback without blocking damage/motion. Drop expired cues rather than draining a backlog. The next state refresh reflects current referee health; do not keep renewing a live/won state after losing the game connection.

After OPEN, validate nonce and command sequence: new commands require `0 < (new - last) mod 65536 < 32768`; **forward gaps are allowed**. The browser consumes a sequence when issuing a write even if it fails/times out, so the next command can recover from uncertain delivery. Cache the last processed command bytes and result: an identical duplicate re-ACKs the original result/receipt timestamp without repeating its effect or extending its expiry; the same sequence with different bytes is rejected. Older/ambiguous half-range sequences are rejected. A well-formed in-order command consumes its sequence even when rejected for bad arguments/expiry. Only the first OPEN establishes the session; an exact duplicate is idempotent, and any other OPEN on that connection is rejected. Changing nonce requires disconnect/reconnect. This is freshness protection, not authentication.

### STATUS — 20 bytes

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | u8 | `version = 1` |
| 1 | u8 | `kind`: 0 current health, 1 command result |
| 2–3 | u16 | Echoed `command_seq` for result; zero for health |
| 4–7 | u32 | Active `link_nonce`, or zero before OPEN |
| 8–11 | u32 | `device_ms`: command receipt for result; snapshot time for health |
| 12–15 | u32 | `detail0`: echoed opcode for result; cumulative local dropped/overrun count since boot for health |
| 16–19 | u32 | `detail1`: result code for result; health bits for health |

Result codes: 0 OK; 1 malformed/unsupported version; 2 wrong session; 3 invalid argument; 4 expired; 5 unsupported command/capability; 6 stale/conflicting sequence. If the frame is too malformed to identify safely, reject the ATT write and do not fabricate a correlatable result. Invalid commands never reset state, nonce or health. STATUS read returns **current health**, not whichever ACK happened last; notify health at 1 Hz and immediately on sensor/fault changes, plus a result for each identifiable command.

Health bits: 0 sensor healthy, 1 stream enabled, 2 presentation healthy, 3 host state stale; others zero. Stream enabled means OPEN succeeded and MOTION notifications are subscribed, not that the sensor is necessarily producing good readings. No invented battery percentage; voltage/percentage reporting is outside v1 until hardware measurement/support is established.

Host-state-stale is set at boot/OPEN, disconnect and state expiry; only accepting a fresh, unexpired SET_STATE clears it. SYNC/CUE, rejected state or a duplicate ACK cannot clear it or extend a state lease. Emit current health on these transitions. Clearing stale does not imply the screen is healthy; presentation health is a separate bit.

An ATT write response means the write was received. A STATUS OK means the command was validated and its state/cue accepted by the presentation subsystem (or sync/session operation completed), **not physical proof that photons appeared**. Report presentation failure in health; humans verify LEDs/display. Browser ignores ACKs with wrong nonce, command sequence, opcode or connection generation.

## 6. Connection, timing and failure lifecycle

1. **Boot:** choose new boot ID, show firmware/short device ID and advertising state; neutral LEDs. No stock launcher or gameplay buttons. Maintain a documented maintenance/recovery path.
2. **Connect:** user selects device; platform reads INFO and validates profile. Subscribe STATUS then MOTION, send OPEN and wait for OK. No valid motion before successful OPEN; firmware does not retain a stream across physical connections.
3. **Synchronize:** perform five sequential SYNC exchanges with distinct command sequences; use the lowest-RTT valid response. For browser send/receive times `t0,t1` and returned device receipt `d`, offset `browser - device` lies within `[t0 - d, t1 - d]`. Record `t0` when actually issuing the write, not when enqueuing it. Use the midpoint and at least half-RTT uncertainty, with a documented drift margin. Do not use late/duplicate/timed-out ACKs as new measurements. This bounds rather than proves one-way delay.
4. **Ready:** require supported capabilities, valid baseline, sensor healthy, sync RTT ≤100 ms (initial uncertainty ≤50 ms), fresh stream and usable microphone/server. Send practice/idle state, register device/boot/input generation with referee and complete grip calibration. No network room token is sent to firmware.
5. **Run:** resync about every 5 seconds; use a conservative 5 ms/second uncertainty growth budget until measured. If uncertainty exceeds 100 ms or the last good sync is older than 10 seconds, stop accepting casts and report input unavailable. Repeated failed sync must not silently leave a drifting clock active. Suspend/reset fusion if a mapping change exceeds its previous uncertainty.
6. **Fault/reconnect:** disconnect, boot change, page hide/suspension or input outage invalidates all pending gesture/speech evidence and aborts a live round. Detach old listeners; scope **all** motion/status callbacks to their captured browser connection generation, not just ACKs. Reset sequence/timestamp/buffer state before accepting a new stream; MOTION has no link nonce and can otherwise be confused with a queued callback from the previous connection. Reacquire characteristics/listeners, fresh nonce, sync, baseline and Ready; no old input replay or automatic round resumption. Firmware returns to advertising on disconnect.

Use acquisition time mapped into the browser's monotonic clock, never wall-clock/`Date.now()` or notification receipt alone. Reject samples whose age upper bound exceeds 200 ms (estimated age + uncertainty) or whose timestamp is implausibly in the future beyond uncertainty. A gesture cannot span a gap >150 ms; 500 ms without a fresh **valid** sample makes the wand unavailable. An event-loop stall >200 ms clears pending evidence and requires fresh baseline; page suspension aborts. These initial bounds may be jointly tuned from traces, not silently changed on one side.

Keep up to two seconds of raw samples in the browser for recognition; no unbounded device or host queue. The referee still uses **server receipt time** for combat, never device capture time to backdate a shield.

**Feedback-only outage:** if fresh motion remains healthy but the presentation path fails, show a clear badge-feedback warning and continue computer-authoritative combat. That run fails the final badge-feedback acceptance test. A sensor, motion, sync or game-input outage is a gameplay fault, not merely a visual warning.

## 7. Golden vectors and hardware-free conformance

These are hand-specified contract examples, not code generated by the future encoder. Both teams test their implementation against the same bytes. Hex spaces are for readability, not transmitted characters.

| Record | Exact 20 bytes | Expected interpretation |
| --- | --- | --- |
| INFO | `01 0f 32 08 a1 b2 c3 d4 e5 f6 44 33 22 11 00 01 00 01 00 00` | v1, all capabilities, 50 Hz, ±8 g, device A1B2C3D4E5F6, boot `0x11223344`, firmware 0.1.0, axes 1 |
| MOTION | `01 01 2a 00 e8 03 00 00 44 33 22 11 9c ff c8 00 e8 03 00 00` | Valid seq 42, capture 1000 ms, boot `0x11223344`, x = −100 mg, y = 200 mg, z = 1000 mg |
| OPEN | `01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00` | Command 0, nonce `0xAABBCCDD`, zero arguments |
| OPEN result | `01 01 00 00 dd cc bb aa f2 03 00 00 01 00 00 00 00 00 00 00` | OK for OPEN 0, same nonce, device receipt 1010 ms |
| SET_STATE | `01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00` | Command 1, playing, HP 100/100, no statuses, epoch `0x01020304`, valid until 2200 ms |
| CUE | `01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00` | Command 2, Stupefy accepted-cast cue for 300 ms, same epoch, must start before 1400 ms |

For a fresh OPEN session, SET_STATE arriving at device time 1100 ms then CUE at 1150 ms must succeed. Repeating that CUE byte-for-byte must re-ACK without replaying the effect. In an independent fixture where it first arrives at 1400 ms, it must be rejected as expired. Changing its epoch must reject without an effect. Also pin malformed lengths/reserved flags, signed out-of-range data, sequence `65535 → 0`, timestamp wrap and reboot vectors before freezing v1.

CONTROL wrap fixture: with an established nonce `0xAABBCCDD` and last processed sequence `65535`, `01 02 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00` is a valid next SYNC (not OPEN). At receipt 2000 ms its result is `01 01 00 00 dd cc bb aa d0 07 00 00 02 00 00 00 00 00 00 00`. Replaying sequence `65535` after that is stale; jumping from `0` to `32768` is ambiguous and rejected.

CONTROL gap fixture: after processed sequence 2, allow SYNC sequence 4 (`01 02 04 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00`) when sequence 3 was lost. At receipt 2100 ms return `01 01 04 00 dd cc bb aa 34 08 00 00 02 00 00 00 00 00 00 00`. A later sequence 3 is stale. These examples are independent sessions from the earlier expiry fixture.

The platform's virtual wand implements this same service behavior and raw records; both transports use the same byte decoder, freshness guard, classifier and feedback encoder. Virtual command handling drives a screen/LED preview. Timed traces carry notification bytes plus receipt times and can inject drops, duplicate delivery, stalled bursts, reboot and ACK loss.

Simulation can verify bytes, lifecycle logic, fusion, combat and rendering; it **cannot** verify actual sensor scale/axes/noise, Windows Bluetooth behavior, radio latency, physical feedback, battery life or firmware recovery. Real device captures become regression traces when available. Never substitute preclassified `CAST` packets and call that a tested motion pipeline.

## 8. Acceptance and handoff checklist

All numbers are **requested acceptance targets**, not claimed measurements. If a target is infeasible, bring the measurement to both teams before changing the contract; do not quietly lower the rate or replace raw data with gesture labels.

| Gate | Required evidence |
| --- | --- |
| Build/recovery | Exact image/version/hash, board revision, SDK/build instructions, flash command/power precautions and demonstrated recovery to a known image. Approved device-specific flashing only; do not erase user badge data without agreement |
| Discovery/identity | Both intended Windows laptops select the correct on-screen ID; wrong version/capabilities produce explicit setup failure; second central cannot steal an active link |
| Sensor | Six-face axis/scale check (initial ±100 mg tolerance around the expected 1 g axis/zero others); steady 50 Hz fresh acquisition; real jabs/sweeps checked for clipping; sensor fault does not emit fake valid zeros |
| Protocol | Both teams pass golden valid/invalid/signed/wrap/session vectors; exact 20-byte notifications and commands; duplicate cue executes once; old nonce/epoch and expired command have no effect |
| Timing | Report effective unique sample rate, capture/arrival jitter, loss, longest gap, sync RTT and uncertainty. Target ≥95% of acquired samples delivered, mapped sample-age upper bound p95 ≤150 ms, command ACK p95 ≤150 ms; no sustained backlog |
| Two-wand soak | 10 minutes, both battery wands and actual laptops at intended 1–3 m spacing, cameras/video active, simultaneous motion and state/cues. No resets, unplanned disconnects or ≥500 ms fresh-input outages; test measured gaps against gesture gates |
| Feedback | Local motion cue aims <100 ms; accepted command visibly updates within 150 ms of device receipt; state expiry/disconnect removes stale HP/result; screen/LED activity does not starve acquisition |
| Recovery | Power cycle, disable laptop Bluetooth, close/suspend page and simulate sensor loss. Browser aborts/flushes; badge becomes neutral; user reconnects and completes a new handshake/Ready within a target 15 seconds, excluding permission troubleshooting |
| Endurance | At least 30 minutes battery-powered with expected display/LED use, no brownout/abnormal heating or loss of sampling. Record batteries/brightness; no unsupported battery-life promise |

For physical latency use a measured method (timestamp logs for capture/ACK, observer/video for visible effects); state the clock uncertainty. A STATUS ACK alone does not measure visual latency. Ten-minute transport success does not replace the MVP's real voice+gesture accuracy and defendability trials.

### Share with us at each firmware drop

1. Image, source/build reference, protocol version, board revision and release notes; no credentials.
2. Device ID/short name, known capabilities and sensor configuration, axes/sign verification, timestamp semantics.
3. A short raw-notification capture + decoded expectation, command/result examples and measured timing/drop counters.
4. How to flash, disconnect, recover and restore; known unsupported behavior and any Windows GATT-cache workaround actually tested.
5. Which gates passed, on what hardware, and which remain open. Notify us before changing bytes, UUIDs, units, axes, sample profile or feedback enums. Incompatible wire changes require a protocol version bump and updates to both fixtures/adapters.

**Agreement needed now:** direct GATT; one wand/player; 50 Hz raw acceleration with gravity and canonical axes; the four-characteristic v1 layout; expiring semantic feedback; earliest date/time for a minimal streaming image. Everything behind that interface remains the firmware team's engineering choice.
