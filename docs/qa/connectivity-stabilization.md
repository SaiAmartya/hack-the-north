# Connectivity stabilization — September 19, 2026

Scope: fresh firmware review/repair and approved app-only flashing of WAND-B602;
shared wand lifecycle, phone onboarding and the existing approved public controller.
This working-tree report supersedes the exact-upstream failure as the active investigation.
Neither source review nor a synthetic phone test establishes physical gameplay acceptance.

Current checkpoint: **phone software ready for physical QA; badge firmware NO-SHIP
for gameplay** because sensor quality is unresolved. The local game stack is running
at `http://127.0.0.1:5173/` with a warm local speech model. Changes remain uncommitted
on the feature branch; only the separately approved phone service was deployed.

## Confirmed causes and repairs

- One slow/lost clock refresh formerly deferred the next attempt until the ten-second
  mapping expired. Retry failed probes after 500 ms; successful refreshes remain five
  seconds apart. Preserve the 100 ms RTT, 200 ms sample-age, 200 ms browser-stall and
  500 ms fresh-input limits. Packet arrival also checks timing before fusion.
- The old script-only duel test jumped and rewound its clock while its real timers
  stood still. Replace that harness behavior with paced raw replay and monotonic time;
  do not weaken the production watchdog to satisfy an unrealistic test.
- Protocol timestamps have integer-millisecond precision. Include that quantization
  in clock uncertainty; it is not permission to accept older input.
- A failed iPhone setup formerly stayed on “Preparing.” Offer an explicit fresh
  reconnect and clear old session evidence. The phone requests an optional screen
  wake lock; unsupported/denied requests remain usable with an awake-screen reminder.
- A full eight-notification delivery window formerly disconnected immediately when
  a STATUS arrived, even during transient congestion. Allow four pending STATUS records
  for at most 100 ms, draining them before coalesced motion. Keep the eight delivery
  credits and 200 ms receipt deadline. Judge received ACK/RPC deadlines by arrival time,
  not their later serial-queue processing time; expiry/overflow still fails closed.
- Firmware's deferred characteristic-value notification could lose OPEN/SYNC results
  when health replaced the value. Explicit per-connection payload notifications fix
  that path. Synchronous session reset/generation fences, cue cancellation, bounded
  acquisition diagnostics and pinned dependencies address related lifecycle defects.

## Transport decision

| Approach | Benefit | Constraint / decision |
| --- | --- | --- |
| Current HTTPS page + hosted WSS | QR onboarding, no installed certificates/app; same byte boundary as badge | Internet and relay jitter remain in the motion path. Retain while qualifying actual timing; never call it local/direct |
| Trusted private-LAN HTTPS/WSS | Direct LAN path, no public motion relay | Already supported controlled-network option, but iPhone certificate trust and Wi-Fi client isolation caused onboarding friction |
| QR signalling + WebRTC data channel | Best browser-based candidate for direct, low-latency local motion without installing a certificate | Requires a new signalling/channel lifecycle, bounded packet handling, selected-path diagnostics and real iPhone/LAN tests. ICE can fail or select a relay; do not promise LAN connectivity merely because both devices share an SSID |
| Native Swift/Core Motion controller | Native sample timestamps and requested sensor cadence | Signing/install/distribution work; still needs a transport and local-network permission. Does not fix the shared clock scheduler or venue-network isolation. Consider only when measured browser sensor limitations justify it |

No automatic transport switch during a round, no phone microphone, no controller-owned
combat, and no relaxed evidence deadlines. If the hosted physical path fails qualification,
the next bounded connectivity implementation should be WebRTC behind the existing wand
interface, not a parallel game engine or an unreviewed native rewrite.

Primary sources: [W3C Device Motion](https://www.w3.org/TR/orientation-event/),
[Apple Core Motion timing](https://developer.apple.com/documentation/coremotion/cmmotionmanager/accelerometerupdateinterval),
[WebRTC transport specification](https://www.w3.org/TR/webrtc/), and
[Cloudflare high-frequency WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#batch-messages-to-reduce-overhead).
Browser observation timestamps do not measure hidden native sensor buffering. Cloudflare's
batching guidance is a potential optimization, not evidence that an unmeasured queue is the fault.

## Measurements and open gates

Evidence is updated below as each run completes. Keep failed runs rather than reporting only passes.

- Firmware 0.1.3 app-only flash/readback matched SHA-256
  `226f41bc23d21b53d622516a8d2b986868bb17516cb3044c536695217e363056` (679,744 bytes).
  Partition table, bootloader, NVS and storage were not written; the two-read private
  stock backup was verified against device MAC `288485d6b600` before flashing.
- Native BLE 0.1.3: OPEN 60 ms, SYNC minimum/median/maximum 30/57/59 ms;
  87 loaded commands, zero rejected/missing results, ACK p95 61 ms.
  1,503 frames in 30.9 s, 48.7 Hz, zero sequence gaps, but **1,484 discontinuities**.
  This is a failed sensor-quality gate, not a passed wand. STATUS overrun interpretation
  and latch clearing require investigation. On-device protocol self-test: 42 checks passed.
- Sensor diagnostics retained the failed evidence instead of removing the discontinuity
  flag. Version 0.1.4 showed STATUS `FF` before a six-byte read and `00` afterward,
  with 1,482 discontinuities in 1,500 frames. Version 0.1.5 explicitly selected the
  manufacturer-documented high-performance mode (`CTRL0=01`, `CTRL1=47`, `CTRL4=A0`);
  it still produced 1,559 discontinuities in 1,576 frames. Neither image qualifies input.
- Version 0.1.6 removed the acquisition sleep and polled once per 1 ms RTOS tick.
  In one continuous serial session it observed 25,213 status polls, 23,931 not-ready
  polls and 1,282 fresh reads over approximately 25.2 seconds (50.8 Hz). Of 1,281
  ready intervals, 1,280 were in the 17–23 ms band; nevertheless 1,275 reads reported
  overwrite. This rules out the earlier 16 ms polling delay as the simple explanation,
  but does **not** establish loss-free sensor output. Diagnostics advertise capability
  bits zero so the game cannot mistake this image for a qualified wand.
- The manufacturer-authored SC7A20H v1.1 document identifies revision `28`, matching
  this badge, and defines STATUS bit 7 as overwrite. No verified erratum permitting
  that bit to be ignored was found. A documented sensor software reset is the final
  bounded diagnostic; further register guesses are not an acceptance strategy.
- Version 0.1.7 performed the documented boot-only reset (`68=A5`) and verified reset
  defaults `CTRL0/1/4=00/07/00`, then restored the same profile. It did **not** fix the
  flag: in each captured post-startup transition, STATUS was `00` one millisecond
  before `FF`; the six-byte burst took approximately 272 microseconds and the next
  STATUS read was `00`. A 23.1-second observed span contained 1,175 fresh reads and
  1,164 cleared-overwrite flags. Zero I²C recoveries; free-heap low-water mark 159,424
  bytes; acquisition stack headroom 5,132 bytes. Leave this image diagnostic-only.
- Loaded BLE on the final 0.1.7 diagnostic: OPEN 58 ms, all five SYNC replies,
  84 loaded state/cue/SYNC commands with zero failures and ACK p95 60 ms. Motion:
  1,527 frames in 30 seconds (50.8 Hz), zero sequence gaps or malformed records,
  **1,510 discontinuity flags**. The checker correctly fails diagnostic capabilities
  and sensor continuity; passing Bluetooth transport is not passing gameplay input.
- Opening the diagnostic USB console caused a new boot with reset reason 11 on this Mac.
  It interrupted that first BLE test at teardown; keep one serial session open before
  future combined-load measurements, or avoid console access during the run.
- First extended hosted-phone run: failed after 182 s with no fresh motion for 500 ms;
  the relay sent an error whose code the first script did not retain. Added sanitized
  error-code diagnostics. That run used injected motion and concurrent local regression
  work, not a physical iPhone. A ten-second earlier pass did not establish stability.
- Approved phone asset update deployed to the existing personal `wandduel-phone` service:
  version `2830e403-1276-4302-a1a9-c764a2b776ed`, controller asset `phone-C1YCuJMM.js`.
  No speech, referee or development route was published.
- Second extended hosted run failed after 363 s with the captured `delivery_backlog`
  code (not clock expiry). At 360 s it had received 18,047 motion samples with one missing.
  This directly motivated the bounded status-queue repair above. The independently
  reviewed relay repair subsequently deployed as version
  `0a9d61ba-7543-40f3-a75a-a228039dd026`; static controller assets were unchanged.
- Third extended hosted run **passed all 600 seconds** with the repaired Worker and
  restarted client: 30,019 samples received, five missing (99.98% delivery), 50.0 Hz,
  123 synchronization replies, SYNC RTT p95 64 ms and maximum observed arrival gap
  198 ms. Route isolation, QR, explicit pairing approval, protocol handshake and leave
  disconnect passed. A 198 ms gap can still invalidate an individual gesture under
  the unchanged 150 ms rule; this is not a loss-free or physical-iPhone claim.
- Complete game QA passed after paced-replay correction: 253 host tests (four skips),
  16 tool tests, 118 frontend unit tests, 25 browser tests, typecheck and production build.
  Worker: 28 tests, typecheck, independent review and deployment dry-run passed.
  The raw-motion duel also passed three consecutive isolated browser runs.
- Final independent read-only reviews found no concrete blocker in the non-firmware
  diff or the narrow 0.1.7 diagnostic additions. The latter review agrees with the
  hardware **NO-SHIP** outcome; it does not promote the sensor image to gameplay-ready.
- Full local stack restarted with stable asset `index-BUvtGpFM.js`, no HMR.
  Actual frontend-proxied speech health reports ready/warm/available with the pinned
  local model. Referee is multiplayer-ready and rejects player replay sources.

Still separate: battery cold boot/endurance, six-face sensor scale/axes, real iPhone
cadence and physical gesture/speech, browser BLE, Windows, second central, two-human
multiplayer and the complete contract H0–H5 acceptance.

### Diagnostic image audit

Each entry below was written only to the application at `0x10000` and read back in
full with matching SHA-256. No full-device erase, partition, bootloader, NVS or
stock-storage write was performed. Recovery backups remain private, outside Git.

| Version | Bytes | Application SHA-256 | Purpose |
| --- | ---: | --- | --- |
| 0.1.3 | 679744 | `226f41bc23d21b53d622516a8d2b986868bb17516cb3044c536695217e363056` | BLE/session repair; sensor-quality failure exposed |
| 0.1.4 | 680352 | `2d0ee8a05efe4297d62a89402202ea9a41e28275bad774401148eccb634765bc` | Register and status readback |
| 0.1.5 | 680432 | `575913fb520a47a9db3d0a8bb43d3ab82e2d94f0fe3d807ced23da111b19346e` | Documented high-performance sensor profile |
| 0.1.6 | 681104 | `39e3242d1d20da5bd08bbb5eb24bb086a4a8ae7b0d55aae1eda8e6c9be2721b4` | One-tick polling, timing histogram; diagnostic-only capabilities |
| 0.1.7 | 682544 | `c57d27d1e2c9a312e2d2de123b10ed25282e7b34b261d0c90851077a301690b1` | Documented sensor reset and first-16 transition trace; still diagnostic-only |

### Firmware-team / creator question

Source: manufacturer-authored [SC7A20H v1.1 datasheet, mirrored copy](https://www.unikeyic.com/media/datasheet/202511/59f66cd3197e2534279e18eca6a9f806.pdf),
printed pages 19 (STATUS) and 27 (reset and revision). This is distinct from a
creator-confirmed explanation of the actual badge's behavior.

> On WAND-B602, WHO=`11`, VERSION=`28`; CTRL0=`01`, CTRL1=`47`, CTRL4=`A0`,
> FIFO disabled. Polling at 1 kHz observes fresh readings at approximately 50.8 Hz.
> STATUS is `00` immediately before becoming `FF`, and a six-byte auto-increment
> I²C read (`A8`, 400 kHz) clears it to `00`. Almost every fresh sample reports
> overwrite, despite approximately 19 no-data polls between reads. The documented
> soft reset reproduces it. Is there a BDU/read-sequence erratum or required
> initialization for this revision? Can a second badge reproduce this sequence?

Do not certify native loss-free sampling, six-face calibration, battery behavior or
game readiness from this diagnostic. No protocol flag was suppressed to manufacture
a pass. A sensor-driver resolution must be followed by the loaded BLE and battery gates.

## Next physical QA card

1. Refresh the local game page. Select iPhone and scan a **new** QR with iPhone Safari.
2. Approve the matching pairing code and motion permission. Keep Safari visible and
   the phone unlocked; a denied wake lock is not a connection failure.
3. Enable the laptop microphone, stay quiet for two seconds, then follow gesture
   calibration. Calibration gestures do not require incantations.
4. Report the first failed step and exact message, or that calibration completed.

This card qualifies onboarding only. Next test actual speech-plus-motion practice,
then two-human play; neither is replaced by the passing scripted duel. Do not attempt
badge calibration while its image advertises diagnostic-only capabilities.
