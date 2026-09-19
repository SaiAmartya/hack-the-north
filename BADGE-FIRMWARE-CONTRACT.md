# Badge firmware ↔ game platform contract

**Status:** proposed v1 team handoff, HAL-grounded revision, September 19, 2026. Not yet accepted by the firmware team or validated on custom firmware. Packet layouts, UUIDs and golden vectors are unchanged; both teams must acknowledge this revised draft before freezing it. Companion: [MVP-OUTLINE.md](MVP-OUTLINE.md).

**In plain English:** deliver a battery-powered wand that connects directly to Chrome, streams trustworthy motion, reports when something is wrong, and displays small feedback messages from the game. We will build all spell recognition, speech handling, multiplayer, combat, camera/video and Three.js graphics.

This specifies **observable behavior and the shared interface**, not a firmware implementation. The firmware owner (currently the two firmware teammates) owns language/SDK, board support, drivers, scheduling, memory and flashing. The same handoff applies if our team later takes that role. They may choose any implementation that passes this contract and its hardware constraints. The UUIDs/bytes below are proposed project constants, not existing badge APIs; agree changes here before either side forks its implementation.

## 1. Deliverables and ownership

| Firmware team delivers | Platform team delivers |
| --- | --- |
| A dedicated image that boots into the wand, without the Lua launcher | Windows Chrome companion and explicit device-selection/setup flow |
| One BLE peripheral connection; fresh acceleration notifications with identity/timing/validity | GATT adapter, binary validation, timing/liveness and simulator |
| Screen/LED connection status, local activity, and a small host-controlled feedback vocabulary | Calibration, gesture segmentation/classification, microphone recognition and voice/motion fusion |
| Device health, command acknowledgements, safe link-loss behavior | Authoritative Python referee, sessions, rules, video, HUD and Three.js |
| Versioned binary + build identifier, flash/recovery instructions and measurement log | Shared golden vectors, replay traces, conformance runner and integration test cards |

**Required for the completed MVP:** one untethered badge per player; no combat buttons; motion + speech required; no device-side combat authority. Two other badges are spares for development/recovery. No receiver badge, serial gameplay bridge, badge Wi-Fi, onboard speech, camera processing, extra peripherals, over-the-air updates or raw image/audio downloads in v1.

**Early integration image:** prioritize the H0–H4 gates in Section 8: safe recovery, sensor truth, connected GATT and loaded stability before artwork. Simple text and dim LED pulses are sufficient. Device Lab can inspect an incomplete image; real-duel Ready requires the complete mandatory capabilities and qualified target profile. Diagnostic access is not permission to cast.

## 2. Hardware facts versus requested behavior

| Evidence category | Meaning in this contract |
| --- | --- |
| Creator-documented | Board wiring, component identities, example initialization and cautions supplied by the badge creators; not measurements by our team |
| Manufacturer-documented | Chip/SDK capabilities supported by primary documentation; not proof of this complete badge application |
| Project requirement | Requested behavior or acceptance target, including 50 Hz/±8 g output and connected GATT |
| Hardware-verified | A recorded result tied to an actual image, board, computer and test procedure; none of this revision's custom-firmware gates has been measured |

**Creator source provenance:** Sai confirmed on September 19, 2026 that `custom-firmware-hal.md` came directly from the badge creators. [The repository reference copy](docs/hardware/custom-firmware-hal.md) is byte-for-byte unchanged from the supplied file; its SHA-256 is `c7c88fc8e1ad9da9d775997b7a1c19da6528e14cb65ed1c407f5715dd0909db9`. The file has no internal revision/date identifier; the date here records receipt/provenance, not authorship. Preserve that copy unchanged and put qualifications in this contract. Its setup commands and generic HAL checklist are source material, not authorization to install, flash, add buttons or enable NFC.

- **Board evidence:** the creator guide identifies ESP32-C3-MINI-1-N4, 4 MB flash, ST7789 display and SC7A20HTR accelerometer. The earlier stock-image boot log independently identified ESP32-C3 and SC7A20H over I²C, but does not validate custom firmware. [Hardware report](docs/hardware-verification.md)
- **Chip capability:** ESP32-C3 supports Bluetooth LE and Wi-Fi, with 400 KB total internal RAM; free heap depends on the complete image. Old Lua heap/tick/44-byte-radio limits do not define this interface. [Espressif](https://www.espressif.com/en/products/socs/esp32-c3)
- **Sensor capability versus profile:** the manufacturer lists three-axis, 12-bit output and selectable ±2/4/8/16 g ranges. The creator recipe is **100 Hz/±2 g**; our requested **50 Hz output/±8 g** configuration, scale and performance remain unverified. No gyro/yaw/position reconstruction is required. Appendix A defines the profile-validation gate; do not infer an ±8 g register recipe or sensitivity from the ±2 g example. [Silan manufacturer specification](https://www.silan.com.cn/en/index.php/product/details/3235.html)
- **Presentation/power:** creator guidance specifies a 320×240 RGB565 SPI display, six WS2812 LEDs and AA power. No assumed vibration motor, microphone or speaker. Use its pin table, then confirm the actual board revision and safe flashing-power state, including whether AA batteries must be removed for USB. [Creator HAL](docs/hardware/custom-firmware-hal.md#2-pin-map), [badge manual](https://badge.hackthenorth.com/manual)

Keep streaming responsive while the screen and LEDs update; Appendix A captures the resource, SDK and recovery constraints. We require measured behavior, not a particular RTOS, task layout, graphics library or CPU clock. Mac bring-up is useful early evidence; it cannot satisfy Windows Chrome qualification.

## 3. Wireless connection and GATT surface

**Selected path:** badge BLE peripheral ↔ laptop Bluetooth adapter ↔ Chrome Web Bluetooth. No specialized IDE or local native bridge during gameplay. Chrome supports GATT reads, writes and notifications on Windows; discovery requires a user click and secure context. Qualify the exact Windows/Chrome/adapter combination. [Chrome documentation](https://developer.chrome.com/docs/capabilities/bluetooth)

**Feasibility status: SDK-supported, badge-unvalidated.** The creator HAL reports a proven extended-advertising/passive-scan pattern and warns about NimBLE heap exhaustion. That is not evidence for our connected GATT workload. Espressif's ESP32-C3-compatible peripheral example establishes SDK support for the required operations, not our board's memory, timing or battery performance. [ESP-IDF v5.5.3 peripheral example](https://github.com/espressif/esp-idf/blob/v5.5.3/examples/bluetooth/nimble/bleprph/README.md)

**Recommended minimal feasibility build:**

- Retain peripheral, broadcaster and GATT-server functionality with ordinary legacy connectable advertising on 1M PHY and one central. No central/observer/GATT-client role, scanning, Wi-Fi, extended or periodic advertising is needed.
- Support the baseline ATT MTU and both MOTION/STATUS subscriptions, plus any enabled standard-service subscription requirements. Do not copy an example with capacity for only one notification subscription.
- Initialize NimBLE once per boot; disconnect resets the link/protocol state and resumes advertising without normal stack teardown/reinitialization.
- Measure buffers instead of copying the HAL's **connectionless** pool sizes. Record free-heap low-water mark, largest free block, task-stack headroom and allocation/notification failures after initialization, connection, both subscriptions, streaming and concurrent feedback. Record actual negotiated connection parameters; a requested interval is not a measured Windows result.

Pass H2–H4 before treating connected BLE as qualified or prioritizing firmware artwork. If safe unused-feature trimming cannot make the minimal build pass, return measurements and revise the decision jointly. Do not silently replace it with advertising-only packets, a receiver badge, USB bridge or reduced-rate profile; platform work can continue on labelled virtual/iPhone input.

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

### Early hardware gates — before firmware artwork

| Gate | Required work and evidence |
| --- | --- |
| **H0 — Safe recovery** | Confirm board revision, exact partition/flash artifacts, preservation and recovery plan/image, and creator-confirmed power instructions before any separately approved device flash |
| **H1 — Sensor truth** | Identify sensor; validate signed conversion and six faces; record actual configuration, fresh-read cadence, timestamp semantics and clipping. The creator's 100 Hz/±2 g baseline is diagnostic only; the requested 50 Hz/±8 g profile needs its own evidence |
| **H2 — Connected GATT** | On one badge, discover/read INFO, subscribe to MOTION/STATUS, complete OPEN/SYNC and exchange actual motion plus commands. Incomplete capabilities/profile remain diagnostic-only; do not claim the target stream passed from a synthetic source |
| **H3 — Loaded stability** | Run 10 minutes with the target stream, state refreshes, SYNC, cues, simple display and dim LEDs together. Meet the full-acceptance cadence/loss/latency limits below; record memory/stack headroom, allocation/notification errors, longest gaps and any reset/backlog |
| **H4 — Reconnect and battery** | Run 20 disconnect/reconnect cycles: advertising resumes, old link/evidence/feedback is cleared, second central cannot take the link, no OOM/reset or downward resource trend. Repeat the 10-minute loaded run on battery only if H3 used USB; demonstrate approved known-good recovery and Start/GPIO9 fallback |
| **H5 — Full acceptance** | Complete the two-badge soak, actual display/LED feedback, recovery, 30-minute endurance and MVP voice/gesture/gameplay gates; earlier diagnostic passes do not replace them |

Record OS/Chrome/adapter with every result. Mac evidence can advance bring-up, but H2–H4 must also pass on the intended Windows setup before Windows qualification is claimed. H0 establishes recovery readiness before flashing; H4 demonstrates the supported procedure after bring-up. These gates do not authorize flashing or block independent simulator/platform work.

### Full acceptance

| Gate | Required evidence |
| --- | --- |
| Build/recovery | Exact image/version/hash, board revision, SDK/configuration and the partition/flash/preservation manifest in Appendix A; demonstrated known-good recovery. Stock restoration only with an available stock image or approved backup procedure. Approved device-specific flashing only |
| Discovery/identity | Both intended Windows laptops select the correct on-screen ID; wrong version/capabilities produce explicit setup failure; second central cannot steal an active link |
| Sensor | Configuration readback, native signed-conversion tests and six-face axis/scale check (initial ±100 mg tolerance around the expected 1 g axis/zero others); verified 50 Hz/±8 g target; real jabs/sweeps checked for clipping; sensor fault does not emit fake valid zeros |
| Protocol | Both teams pass golden valid/invalid/signed/wrap/session vectors; exact 20-byte notifications and commands; duplicate cue executes once; old nonce/epoch and expired command have no effect |
| Timing | Report native sensor ODR, fresh reads/s, output/delivered records/s, acquisition-to-read bound, capture/arrival jitter, loss, longest gap, sync RTT and uncertainty separately. Target ≥95% of acquired samples delivered, mapped sample-age upper bound p95 ≤150 ms, command ACK p95 ≤150 ms; no sustained backlog or unagreed decimation |
| Two-wand soak | 10 minutes, both battery wands and actual laptops at intended 1–3 m spacing, cameras/video active, simultaneous motion and state/cues. No resets, unplanned disconnects or ≥500 ms fresh-input outages; test measured gaps against gesture gates |
| Feedback | Local motion cue aims <100 ms; accepted command visibly updates within 150 ms of device receipt; state expiry/disconnect removes stale HP/result; screen/LED activity does not starve acquisition |
| Recovery | Power cycle, disable laptop Bluetooth, close/suspend page and simulate sensor loss. Browser aborts/flushes; badge becomes neutral; user reconnects and completes a new handshake/Ready within a target 15 seconds, excluding permission troubleshooting |
| Endurance | At least 30 minutes battery-powered with expected display/LED use, no brownout/abnormal heating or loss of sampling. Record batteries/brightness; no unsupported battery-life promise |

For physical latency use a measured method (timestamp logs for capture/ACK, observer/video for visible effects); state the clock uncertainty. A STATUS ACK alone does not measure visual latency. Ten-minute transport success does not replace the MVP's real voice+gesture accuracy and defendability trials.

### Share with us at each firmware drop

1. Image, source/build reference, protocol version, board revision, exact SDK/configuration and release notes, including the SDK mitigation below; no credentials.
2. Device ID/short name and its preservation strategy; actual capabilities, sensor configuration/readback, axes/sign evidence and timestamp semantics.
3. A short raw-notification capture + decoded expectation, native conversion vectors, command/result examples, separate sensor/read/output rates and timing/drop/resource measurements under combined load.
4. Exact partition CSV/summary and generated flash manifest; artifact hashes/offsets, preservation policy, approved power state, backup and known-good recovery instructions. State stock-restore availability separately; include any Windows GATT-cache workaround actually tested.
5. H0–H5 and full-acceptance results with image/board/OS/browser/adapter and remaining gaps. No custom-firmware result is implied by this document or a creator example.
6. Acknowledgement by firmware and platform owners before freezing this revision. Notify us before changing bytes, UUIDs, units, axes, sample profile, sequence semantics or feedback enums. Do not silently reinterpret v1 for existing implementations; incompatible interface changes require a protocol version bump and updates to both fixtures/adapters.

**Agreement needed now:** acknowledge the HAL-grounded draft; confirm the selected but unvalidated connected-GATT path and requested 50 Hz/±8 g profile; agree H0–H4 delivery/evidence checkpoints. One wand/player, four-characteristic v1 bytes and expiring semantic feedback remain unchanged. The firmware owner retains implementation responsibility within these constraints.

## Appendix A. Creator HAL constraints and qualifications

### Board reference and sensor bring-up

Use [the unchanged creator pin table and driver guidance](docs/hardware/custom-firmware-hal.md#2-pin-map), checking applicability to the actual board revision. It identifies the ST7789 320×240 RGB565 display on SPI2; SC7A20HTR at I²C `0x19` sharing the bus with MFRC522 at `0x26`; six WS2812B LEDs; Start/GPIO9 download strap; and USB-Serial-JTAG rather than UART0. The generic eight-button driver, button injection and NFC examples are **not** required project features.

The creator's sensor baseline uses `WHO_AM_I` at `0x0F` expecting `0x11`, `CTRL_REG1 = 0x57` (100 Hz), `CTRL_REG4 = 0x80` (BDU, little-endian, ±2 g), data-ready polling and a six-byte burst read. Treat these as creator-documented values, not this project's measurements. Combine little-endian native bytes and sign-extend the 12-bit left-justified value correctly before scaling/remapping:

| Native bytes, little-endian | Signed counts | mg under the creator's ±2 g example |
| --- | --- | --- |
| `80 3e` | +1000 | +1000 |
| `80 c1` | −1000 | −1000 |

These driver vectors supplement, not replace, Section 7's normalized wire vectors. Confirm ±8 g register settings/sensitivity with creator or primary register documentation, then add its ±1 g and rail tests; do not guess from a similar sensor. Before accepting the final profile, require register readback, six-face raw/mg captures, fresh data-ready/read cadence and deliberate-gesture clipping evidence.

**Profile boundary:** INFO must report the actual output rate/range; never label a 100 Hz/±2 g image as 50 Hz/±8 g. Device Lab may inspect its INFO/raw diagnostics with an **unsupported for casting** label. These different-profile values are explicitly nonconforming diagnostic INFO, not an extension of the v1 duel profile. In addition to Section 6's health/freshness checks, v1 duel Ready requires `capabilities == 0x0F`, `sample_hz == 50`, `range_g == 8` and `axis_convention == 1`. Unsupported images cannot enter practice fusion or real-duel Ready. Changing the sensor profile requires a new boot/INFO and fresh calibration as in Section 4.

Prefer a verified native 50 Hz configuration. If 100→50 Hz selection becomes necessary, obtain joint agreement on acquisition/read timestamps, `seq`, intentional decimation, actual drops and the acceptance denominator **before** implementation; this revision does not change those semantics. BDU prevents torn reads, not stale acquisition timestamps. Do not merely poll BDU registers at half the native rate and stamp each read as a newly acquired sample. Any proposed selection path must promptly service fresh native readings, preserve selected-sample timing, bound acquisition-to-read delay and report overruns rather than fabricate timer-aligned history. The phone emulator's selected-observation model is not evidence for a firmware sampling design.

### Combined-load resources and power

- Start with simple text/partial redraws and bounded stripe buffers. Avoid full-frame DMA allocation and blocking full-screen work on the acquisition path. One 320×240 RGB565 framebuffer is **153,600 bytes**; two 320×30 RGB565 stripe buffers total **38,400 bytes**. These calculations explain the creator's recommendation, not a mandatory task/buffer implementation. LVGL is optional, not required for the early image.
- Limit LED brightness and test the worst shipped cues on AA power; the creator warns that six full-white LEDs can brown out the board. Do not invent a universal safe brightness or battery percentage.
- Do **not initialize or scan NFC** in v1. Its chip remains physically attached to the shared bus: bounded I²C timeouts and bounded recovery are still required. On acquisition failure, report sensor unhealthy, record the gap/discontinuity and never fabricate valid zeros. Do not suspend acquisition for unused NFC work.
- Keep USB diagnostics small, bounded, low-rate and outside sampling; no per-sample logging during acceptance. USB console writes can stall, so console output is not a harmless timing probe. A stalled acquisition or bus must fail visibly rather than block indefinitely. [Espressif console buffering](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-guides/usb-serial-jtag-console.html#data-buffering)
- Qualify sensor + connected BLE + display + LEDs together, including battery-only operation. Reduce decoration first; do not lower stream freshness or hide resets to fit the resource budget.

### SDK and safe recovery manifest

**SDK baseline:** the creators pin ESP-IDF **5.5.3** for bring-up, not an unconditional production guarantee. Espressif documents NimBLE stalls/connection loss in that release when `CONFIG_BT_NIMBLE_HS_FLOW_CTRL` is enabled; it is disabled by default on ESP32-C3. For that baseline, explicitly retain `CONFIG_BT_NIMBLE_HS_FLOW_CTRL=n` and record the configuration. Espressif reports the fix in **5.5.4**; adopting a patched SDK is a deliberate firmware-owner change followed by the same regression gates, not an implicit upgrade. [Issue and published resolution](https://github.com/espressif/esp-idf/issues/18323)

Every flash/recovery handoff must include the exact SDK/build reference and relevant configuration; board/flash size/mode/frequency; partition CSV with names/types/subtypes/offsets/sizes/flags; generated partition summary; every flashed artifact's hash and offset; erase/preservation policy; and how stable device identity survives the supported update/recovery operations. The HAL's `0x10000 (0x2A0000)` and storage `(0x140000)` shorthand is **not** a flash manifest: do not infer that `0x140000` is an offset or generate commands from that prose. [ESP-IDF partition definitions](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-guides/partition-tables.html)

Confirm the safe USB/AA power state with the creators, establish an approved backup/preservation procedure and obtain a known-good recovery image before flashing. Keep private backups outside the repository and uploads. Recovery to our known-good image and restoration of the stock event firmware are different claims; promise stock restoration only when the stock artifact or approved backup procedure exists. Do not copy sample blanket NVS erasure, erase all flash, alter eFuses or flash automatically. Each device operation needs separate explicit approval.

Preserve Start/GPIO9 as the documented download/recovery path, never a combat input, and keep USB-Serial-JTAG available for bounded diagnostics. The creator's blanket “no auto-reset” sentence is board guidance to qualify, not a chip-wide fact: Espressif documents automatic USB-Serial-JTAG download entry and manual GPIO9-low recovery when necessary. Demonstrate and record the actual badge procedure for normal flashing, fallback entry and known-good recovery; a blank screen in download mode alone is not evidence of a failed board. [Espressif USB behavior](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-guides/usb-serial-jtag-console.html)
