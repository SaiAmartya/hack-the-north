# Sai's platform development and QA workflow

**Purpose:** build and exercise the game before the custom badge firmware is ready, then integrate the badge without rewriting the game. **Updated:** September 19, 2026. Sai prefers iPhone for all physical surrogate testing; the game computers still target Windows Chrome. Android is not required.

**Status: approved full workflow, current checkpoint after Slice 0–1 diagnostic implementation.** The badge contract/HAL was published at `04e315b`. The isolated shell, Device Lab/protocol/virtual-device foundation and fake-BLE path exist and their current foundation checks pass; keep changing commands/counts in the [current checkpoint](../../../../docs/qa/device-lab-stage-1.md). Its replay-only human card is pending. Local ASR and Stages 2–9 remain planned; no phone, microphone, Windows or real badge has been qualified.

This is the supporting operating procedure for [$wand-dev-workflow](../SKILL.md), not a standalone workflow or a replacement firmware specification. Read with [MVP-OUTLINE.md](../../../../MVP-OUTLINE.md) for gameplay decisions, [IMPLEMENTATION-PLAN.md](../../../../IMPLEMENTATION-PLAN.md) for approved slices and runtime architecture, and [BADGE-FIRMWARE-CONTRACT.md](../../../../BADGE-FIRMWARE-CONTRACT.md) for the authoritative badge interface.

**Your quick reading path:** Sections 1, 3, 6 and 8. Section 4 is the engineering checklist the agent should follow; you do not need to manage its packet/timing details manually.

## 1. The recommendation

Use **three complementary test sources**, not a phone as the only substitute for a badge:

| Source | Your use | What it establishes |
| --- | --- | --- |
| **Virtual wand + saved traces** | The agent replays the same inputs automatically after every change | Repeatable packet, timing, recognition, combat and UI behavior; injected failures |
| **iPhone Safari as a physical test wand** | You hold it, perform real movements and speak into the **laptop microphone/local ASR** | Human timing, coaching, false activations and playability with measured phone motion |
| **Real badge over BLE** | Replace the source when teammates deliver minimal streaming firmware | Actual badge acquisition, Windows Bluetooth, grip calibration, feedback and endurance |

**Best shortcut:** make a phone-powered instance of the same virtual device endpoint. It consumes real phone acceleration instead of a canned trace and exchanges the same INFO/MOTION/CONTROL/STATUS bytes with the laptop. All production decoding, stream guards, gesture classification, voice fusion, server rules and rendering remain downstream of that boundary.

**Selected phone connection: iPhone Safari → trusted private-LAN HTTPS/WSS → laptop.** Use a controlled Wi-Fi network and a development TLS certificate trusted on both devices. This is a wireless sensor surrogate, not a browser pretending to be a Bluetooth peripheral. No native phone app, cloud relay, USB debugging or Android support is required. The initial browser permission needs a direct user action. [Motion permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static)

**Does this reduce test quality?** Not inherently: the same raw-packet, timing, fusion, replay and failure assertions remain. However, Wi-Fi jitter and Safari sensor scheduling must pass the live qualification below; documentation cannot promise that this particular iPhone/network will pass. Replacing Android does not remove a needed production-platform test, because the shipped controller is the badge, not either phone. Neither phone can prove badge sampling, radio, grip accuracy or physical feedback. Keep those final real-badge gates open.

Start with one iPhone and a scripted opponent. A second iPhone/person can join later; no second phone is needed for deterministic two-player tests. "iPhone-only" means the physical stand-in, not moving the game, microphones, automated suite or eventual badge acceptance onto the phone.

## 2. What we should build before expanding the game

| Deliverable | Responsibility / boundary | Done when |
| --- | --- | --- |
| **Device Lab** | Our team: connect, inspect raw axes/age/loss, calibrate, inspect speech/fusion and preview feedback | You can distinguish missing motion, missing speech, mismatched evidence and server rejection |
| **Shared wand client + virtual endpoint** | Our team: one codec, handshake, clock mapping and feedback model; golden vectors from the firmware contract | Virtual data enters as exact bytes, not preclassified spells; command expiry/dedup work |
| **Laptop PCM + local ASR** | Our team: request/verify a mono 16 kHz AudioContext, AudioWorklet timebase/endpointing with no initial application resampler, and one warmed loopback `faster-whisper base.en` CPU-`int8` helper per laptop | Setup fails if actual mono 16 kHz input is unavailable; successful finals have bounded capture intervals/latency without Web Speech or cloud processing |
| **Thin phone page + development relay** | Our team: same virtual endpoint core, actual phone acceleration, bridge to the owning laptop | A jab reaches the production decoder/classifier and a returned cue reaches the phone preview |
| **Replay + scripted second player** | Our team: timed raw samples and speech-evidence fixtures through a second normal client | A complete Stupefy/Protego exchange passes through real sockets/referee and effects |
| **First real BLE adapter** | Our team: GATT only; teammates provide the peripheral | Swapping source requires setup/calibration, not edits to combat, fusion or Three.js |

Keep the existing React/TypeScript/Vite and Python/FastAPI foundations. Add the dev-only phone relay to the existing host, isolated from the referee's state writer; no separate phone backend. Reuse the **idea** of [fake_gateway.py](../../../../tools/fake_gateway.py), not its POSIX terminal or old button-cast packets. The existing [viewer socket](../../../../apps/host/phantom_host/main.py) does not accept player commands yet; merely running today's app does not provide this workflow.

**Stop rule:** after the virtual endpoint and local speech path work, give the iPhone extension one bounded 60–90-minute implementation attempt. If TLS, permissions, network or sensor delivery consume that budget, continue with replay + the real laptop microphone/local helper and report the missing live evidence. Do not silently switch Sai to Android. If usable firmware arrives first, integrate it instead of finishing a disposable controller.

## 3. Your first phone session

These are **future run steps**, once the harness above exists. The implementation handoff must supply exact Windows launch commands; no new command is claimed to work today.

1. **Ask for the setup check.** The agent confirms the feature branch, clean/known diff, versions, free ports, iPhone/iOS version and controlled network. The new mode must disable the legacy serial reader, host camera and AI director. Replay-only work stays loopback-only; live iPhone testing requires the explicitly approved LAN profile below.
2. **Approve one-time local HTTPS setup.** Use a dedicated development CA/certificate, preferably with `mkcert`, on the trusted development laptop. Generate the server certificate for the exact selected private LAN IP; keep all key material outside the repository and served directories. Explain that trusting this CA permits certificates signed by its key to be trusted, not just this page. Ask before installation or trust changes. Transfer only the public root certificate to your iPhone using a user-approved channel, verify its identity, install its profile and enable full trust in Settings → General → About → Certificate Trust Settings. Never transfer the CA private key or server private key. Managed phones may disallow this; do not bypass policy. [mkcert mobile guidance](https://github.com/FiloSottile/mkcert#mobile-devices), [Apple's trust instructions](https://support.apple.com/en-us/102390)
3. **Open the phone page.** Run one optional Vite phone-QA profile on the selected private interface, trusted HTTPS port `5173` with strict-port behavior. Both desktop Chrome and iPhone Safari use `https://<selected-laptop-LAN-IP>:5173`; the iPhone opens `/phone-wand`, a **proposed route**, not available today. Game routes point to laptop A; the owning laptop's speech helper remains fixed at `127.0.0.1:8001` behind the Vite proxy. The proxy must reject speech requests from the phone/LAN peer. Expose only the approved frontend port to the controlled network; no blanket firewall disable, public tunnel or router forwarding. Wi-Fi client isolation may prevent access even on the same SSID. If the IP changes, update the certificate/profile deliberately. [Vite TLS/proxy configuration](https://vite.dev/config/server-options)
4. **Pair in the Device Lab.** Create a development room/player session, select Phone/Test input, create a short-lived pairing code, enter it on the phone and confirm the displayed device alias on both screens. The phone is an input accessory for your player, **not a third player**. Tap Enable Motion: call `DeviceMotionEvent.requestPermission()` directly from that tap where supported, before asynchronous pairing/network work consumes user activation. Handle denial explicitly. No spell buttons are added.
5. **Check sensor and laptop-input health.** The phone page reports `isSecureContext`, permission status, non-null x/y/z, observed callback/output cadence, sync/age and connection health. Hold still face-up, then check the six gravity orientations. The laptop shows its microphone worklet, 2-second quiet calibration and warmed local helper generation. Run the qualification below. A loaded page or an API existing is not a passed test. The laptop may need microphone/camera permission again on this new HTTPS origin.
6. **Calibrate and practice.** Keep Safari foregrounded, the phone unlocked and held consistently in portrait with a safe grip. Calibrate in the laptop app, keep its microphone near you, then say Stupefy and perform a short jab. Confirm one exact local-ASR final plus one matching motion became one fused attempt, not merely a motion pulse. A minimal on-phone diagnostic panel must suffice without a Mac or Safari remote inspector.
7. **Stop cleanly.** End the room, disconnect the controller and stop the LAN-serving profile. Remove the development CA profile/trust when it is no longer needed; restore any user-approved temporary settings. Locking the phone, switching apps or losing Wi-Fi during a round must fail visibly and clear old evidence. Resume requires a fresh session/Ready, never catch-up delivery.

Why HTTPS matters: `localhost` on the iPhone means the iPhone, not the laptop. A plain `http://192.168…` page does not qualify like laptop loopback. Use a genuinely trusted certificate and WSS, not a certificate-warning click-through or browser security-disabling flag. The default laptop-only profile remains unchanged; the LAN/TLS profile is development-only, not a production requirement. [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)

**Only the laptop captures voice/video.** Its browser owns PCM timing/endpointing and its loopback helper transcribes; the phone requests motion access only and shows minimal feedback. Use small wrist/forearm movements; do not throw it or attach it precariously to a wand prop. No background/locked-screen sensing or Screen Wake Lock support is assumed.

### iPhone qualification before trusting a live session

First capture 60 seconds of stillness and comfortable movement, with laptop video/rendering active. Report real callback/output rate, longest gap, delivery ratio, observation-age upper-bound p95, sync RTT/uncertainty and command ACK p95. Distinguish intentional callback decimation from transport loss. Use the contract's current limits unchanged: initially a usable sync RTT ≤100 ms, no gesture spanning a gap >150 ms, reject age upper bounds >200 ms, and fail input at 500 ms without fresh valid data. Aim for ≥95% selected-sample delivery and observation-age/ACK p95 ≤150 ms. These are **surrogate observation/transport measurements**, not iPhone hardware-acquisition or BLE measurements.

Then prove motion-only/speech-only/mismatch rejection, one accepted cast per correct pair, phone lock/app switch/network loss clearing evidence, and safe fresh-session recovery. Repeat the smoke loop with the real laptop microphone and local helper; run a 10-minute stable rehearsal before treating the phone path as the routine interactive test source. Extend to two iPhones only when two human players need it.

If cadence is below the target 50 unique output samples/second, label the run **lower-cadence surrogate**; it can inform coaching but cannot qualify the intended 50 Hz recognition profile. If timing/freshness gates fail, stop live fusion and fix the setup or use the labelled replay fallback. Do not relax the profile, interpolate or repeat readings to make an iPhone appear qualified. Synthetic tests retain 50 Hz conformance coverage; physical phone and badge evidence remain separate.

## 4. Engineering guardrails that make the later badge swap easy

### Same endpoint behavior, different source

- Keep only two top-level adapters: `BleWandTransport` for real GATT and `VirtualWandTransport` for tests. The virtual adapter uses either an in-memory endpoint channel or a development-only relay channel to the same endpoint core running on the phone. A phone motion source replaces the trace generator underneath that core. **One shared `WandClient`, decoder and classifier; no phone branches in gameplay.** These names describe planned boundaries, not existing modules.
- The phone serves the contract's info, notification subscriptions, OPEN/SYNC, state/cue handling and STATUS results. The relay routes typed operations/requests and opaque 20-byte values; it does not recognize gestures, restamp samples or decide combat. Preserve record boundaries; do not invent serial framing.
- Return feedback goes through the normal game-event mapper → CONTROL encoder → phone endpoint. The phone draws a small screen and six LED dots from **decoded commands**, including expiry/duplicate behavior. It must not receive game state through a separate shortcut that hides a broken command path.
- The phone emulator answers SYNC on the **phone's clock**. Phone observation timestamps and SYNC timestamps share that clock; round-trip uncertainty includes the relay. Do not answer SYNC on the laptop while claiming phone timestamps have been aligned. All modes retain the contract's stale/gap/timeout rules.
- Give each test phone a distinct, persistent development-only device ID; a page reload creates a new boot ID. Use monotonic `performance.now()` relative to page startup for observation and command receipt times, not wall-clock time. Relay generations and game-connection generations are separate; old callbacks from either cannot revive a previous session.

### Keep speech on the owning laptop

- Follow [the implementation plan's local speech specification](../../../../IMPLEMENTATION-PLAN.md#32-local-speech-capture-and-transcription): browser `AudioWorklet` PCM/timebase and endpointing, then one warmed `faster-whisper base.en` CPU-`int8` helper bound to `127.0.0.1:8001` on that laptop.
- Request `new AudioContext({ sampleRate: 16000 })` with mono microphone input, verify the actual context rate and channel count, and fail setup visibly if either differs. Do not add an application resampler in the initial path.
- Use same-origin `/api/speech/health` and `/api/speech/transcribe` proxies. The proxy validates the raw peer and exact Origin, rejects the phone/LAN peer, caps bodies and adds a per-run helper secret outside browser code. Do not use forwarded-address headers as proof of locality.
- Keep one unresolved utterance and one inference worker with no queue. A second onset invalidates the attempt; final text arriving more than 1 second after the unpadded voice end is stale/unhealthy and cannot pair later.
- Accept exact canonical spell words only. Do not reintroduce Web Speech, cloud ASR, aliases, phoneme/fuzzy matching, phone audio or raw-audio trace export.

### Use only motion information the badge can eventually supply

Use `DeviceMotionEvent.accelerationIncludingGravity`, not gravity-removed acceleration. Convert each finite axis from m/s² to integer milligravity with `round(value × 1000 / 9.80665)`, then apply the contract's axis mapping and clipping rules. Ignore the phone's gyroscope, compass, camera, position and device-orientation shortcuts for classification. Otherwise the prototype may rely on capabilities the badge does not have. [Motion data and units](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/accelerationIncludingGravity)

Verify the six gravity directions; do not assume that browser/native axes, screen orientation and the user's grip are identical. Keep the phone in portrait; an orientation change invalidates calibration and ends a live test until recalibrated. Null/non-finite values mean unavailable input, not zero motion. Browser motion permission, cadence and background behavior depend on the device/browser; a click-triggered permission request is required where that API is present. [Motion specification](https://w3c.github.io/deviceorientation/), [permission API](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static)

**Do not fake 50 Hz:** the emulator advertises the *target* badge profile for codec conformance, while a separate test-source manifest records the phone's actual callback cadence, output cadence, timestamp method and unknown native sensor range. At each 20 ms output opportunity, use only the newest not-yet-consumed phone observation; if none exists, skip it. Never repeat a reading just to fill a slot, backfill after suspension or interpolate fresh-looking samples. Preserve the observation timestamp. Each selected observation is one emulated acquisition: count intentional decimation separately from delivery loss, and advance packet sequence for selected observations even when a send is dropped. Do not turn deliberately skipped >50 Hz callbacks into discontinuity flags; real stalls/overruns still invalidate evidence.

If the phone endpoint knowingly discards an already-selected sample, set the contract's discontinuity bit on its next emitted record. A drop later in the opaque relay cannot be known by that endpoint; the laptop observes it through sequence gaps/timing instead. Do not rewrite packet flags or timestamps in the relay to conceal either kind of loss.

A phone callback timestamp is a **browser observation-time estimate**, not a measured sensor-acquisition timestamp. Sync cannot expose hidden OS sensor buffering or prove end-to-end sensor latency. Reset on page/relay stalls and reject buffered data; record that limitation. Unknown phone saturation/noise cannot be certified away by clamping to the emulated ±8 g range. Lower-cadence phones can still help with interaction testing but cannot pass a 50 Hz badge gate; never weaken the real-device profile to admit them.

**Separate calibration:** key profiles by source kind + device alias + sensor profile + grip. Phone calibration must never be automatically reused for the badge. Retain the same classifier algorithm but expect real-badge threshold tuning. A phone's weight, geometry, filtering and sensor placement differ; a successful phone jab does not establish badge accuracy.

### Bound and label the development relay

The phone page uses same-origin WSS through the HTTPS Vite port; the laptop has a separate controller socket. Add a dev-only paired route such as `/ws/dev-wand` in FastAPI, using Vite's existing `/ws` proxy prefix. That host endpoint does not exist today. TLS terminates at Vite; the solo loopback proxy to FastAPI can remain WS. Select browser WS/WSS from the page's origin so the desktop game socket also works under the phone-QA HTTPS profile. Preserve the original Origin header and validate the exact approved origins in FastAPI, rather than enabling wildcard access. Its small typed envelope identifies the device operation/characteristic and request ID; any embedded contract value remains exactly 20 bytes. Do not reuse the viewer broadcaster for relay delivery. Keep controller traffic off the game socket and out of the referee's command queue. This is a **test-only carrier**, not a second production badge transport and not part of opponent WebRTC video.

Enable it only in an explicitly selected development mode. Pair one phone with one authenticated owning player; pairing grants must expire, be single-use/rate-limited and allow only device operations, never game/reset/admin actions. A phone connection consumes no player slot. Keep pairing grants and game tokens out of URLs/logs/traces; validate Origin and bounded message sizes. Disconnect either side to invalidate that pair/session and clear evidence. A new round/source requires fresh readiness; no source switching mid-round.

The data path uses bounded latest-sample queues, bounded command/result queues and non-blocking relay fan-out. WebSocket/TCP can still accumulate ordered data in transport buffers: observe buffered bytes/ages, drop unsent obsolete samples and **close/reconnect** a persistently backed-up link rather than drain it into gameplay. Never advance liveness because an old buffered sample has only just arrived. Motion and controller write failures must not stall the authoritative referee.

Register phone input as virtual with subtype `phone_motion`. Every screen/result export says `PHONE SURROGATE`, `REPLAY`, `MIXED` or `REAL BLE`, separately from `REAL LOCAL ASR` or `SCRIPTED SPEECH`. Real-duel mode refuses declared simulated/phone input. These safeguards prevent accidental claims, not malicious anti-cheat. Do not alter the firmware contract's packet bytes to add phone-only fields; test metadata lives outside those bytes.

## 5. The useful shortcuts

### Record once, replay every regression

After a good or bad attempt, optionally save a short trace: normalized notification bytes, source/receipt times, clock-sync evidence, lifecycle changes, calibration/profile version, expected gesture and canonical speech-evidence timing. Tag origin as phone, synthetic or real badge. Keep the original timing/gaps; do not silently smooth a failed trial into a successful one.

No raw microphone audio, camera video, transcripts, secrets or personal phone IDs by default. Capture/commit a diagnostic only with approval. Use an in-memory bounded trace until explicitly exported; a recording must not quietly upload itself. A trace manifest should include commit/build, device/browser type, observed cadence, source mode, seed when synthetic, intended action, expected outcome and actual rejection/acceptance.

Replays need two clocks: an explicit fixture clock for deterministic offline tests and the live clock for interactive rehearsal. In offline tests, replay the original sync/relative timing. In live replay, rebase the trace into a **new emulated boot/session**, preserve deltas/gaps and perform a fresh handshake—do not replay old boot IDs/timestamps into today's session. Never compare recorded timestamps directly with the current laptop clock.

This means you perform a gesture once; the agent can then reproduce its failure many times without asking you to repeat it. Separate tuning traces from held-out attempts/another grip so a green test does not just mean we overfit one recording.

### Give yourself a sparring partner

Open a second ordinary client controlled by the test runner. It generates known raw motion plus clearly scripted speech evidence, then uses the same fusion and real referee. It can send a predictable Stupefy so you repeatedly practice a **real spoken Protego + phone gesture**. No fake incoming damage, direct server cast injection or pre-decided block result in this full-path test.

The scripted client keeps its required input/lifecycle heartbeats alive and runs in a separate visible window or an automated browser context; an ordinary background tab would correctly trip our page-visibility protection. Use a labelled synthetic video source if no second camera is available. Mute it: a bot test is not a nearby-opponent-speech or real WebRTC-camera qualification test.

### Make failures reproducible

Device Lab offers presets for duplicate samples/results, lost motion, a 600 ms outage, old-connection callbacks, failed feedback ACK, reboot, expired cues and server loss during an incoming attack. Use the protocol decoder/stream boundary, not a bypass that disables safeguards. Each regression asserts no stale/duplicate cast, consistent health and no replayed hit/victory animation.

## 6. Your repeatable 10–15-minute QA loop

Run this after a meaningful input/network/game change, not after every CSS tweak. The agent supplies a short test card and a visible diagnostic panel; you supply real motion/speech and judgment.

| Step | What you do | What we check |
| --- | --- | --- |
| 1 — identify | Confirm commit/build, source mode, controller alias and microphone; calibrate | No wrong device, stale profile or hidden simulated input |
| 2 — negatives | Say the spell without moving; move silently; use the wrong gesture; fidget briefly | No fused cast; useful reason shown |
| 3 — positives | Five comfortable Stupefy attempts and five Protego attempts | One cast per valid pair; record misses/false accepts, not just success percentage |
| 4 — defend | Let the scripted opponent send five predictable attacks; guard by speaking and raising | Server accepts guard before impact; both views agree, no retroactive shield |
| 5 — break | Lock the iPhone, switch apps or disconnect Wi-Fi during a pending attempt; reconnect and Ready again | Clear abort, no old cast/cue on return, fresh handshake/calibration as needed |
| 6 — hand back | Describe which step failed; approve exporting only the useful short trace | Agent reproduces, makes one scoped fix, reruns automated checks, asks for only the affected retest |

This is a **smoke loop**, not the final acceptance sample size. Keep the MVP's 20-attempt/player/spell, nearby-opponent-speech trials, defendability and five-match gates for real hardware. Ask a teammate to speak while you gesture to test microphone cross-talk; a prerecorded bot transcript cannot test that risk.

The development loop remains: feature branch → approve one scoped plan → implement that slice → automated tests → fresh independent review from the other model family → your physical test → fixes → your diff review. Use the current `dev-build`, `dev-review` and `dev-verify` workflow stages; verify review claims and cap review/fix loops at two before surfacing disagreement. Commit/push/PR/deploy only when you explicitly request them. Keep `main` clean; do not install certificates, change firewall settings, publish a phone page or flash a badge as an implied QA step.

## 7. If the phone route is inconvenient

**Immediate fallback:** use the virtual wand with your real laptop microphone and loopback helper. Trigger a timestamped motion replay in practice and speak naturally; clearly label the movement as simulated. This still tests actual local transcription, pairing windows, effects and network behavior. It does not test your real hand movement.

**Optional iPhone-only offline fallback:** with Sai's approval to install/use phyphox, record acceleration **with gravity** and timestamps using its [Acceleration with g](https://phyphox.org/experiment/acceleration-with-g/), then explicitly export a small CSV and import it as a labelled replay trace. Verify the experiment, units, axes and timestamp columns before conversion. An offline CSV has no simultaneous laptop speech evidence: use scripted speech for deterministic fusion tests, or speak live against an explicitly rebased replay. Do not claim an offline recording tested real-time latency. No live phyphox HTTP/UDP integration or custom native app is part of the initial build.

**If certificate trust or LAN access is blocked:** stop that setup, preserve replay-based progress and state that live hand/speech timing is still untested. Ask Sai before choosing hosted HTTPS/tunnelling or a different network; those change exposure/ownership and are not automatic workarounds. Do not silently switch to Android or substitute untrusted HTTP.

The production badge path remains **one battery-powered badge → direct BLE → laptop**. Testing an iPhone over Wi-Fi does not qualify BLE or replace its acceptance gate.

## 8. When the firmware team hands over an image

Use the [HAL-grounded contract's H0–H5 gates and release checklist](../../../../BADGE-FIRMWARE-CONTRACT.md#8-acceptance-and-handoff-checklist). The [unchanged creator HAL](../../../../docs/hardware/custom-firmware-hal.md) is creator-supplied evidence, not measured qualification; its provenance/hash and qualifications live in the contract. Do not follow its generic NFC/button checklist as game requirements.

1. **Freeze the last known-good software/replay result and acknowledge the revised contract.** Preserve protocol bytes/UUIDs/golden vectors; incompatible implemented-interface changes require explicit versioning. Obtain image/source/hash, exact SDK/configuration including the NimBLE mitigation, actual profile/capabilities, and remaining qualification gaps. No test harness success proves connected BLE works on the badge.
2. **H0 — Check the recovery handoff before an approved flash.** Require board revision, exact partition CSV/summary, each artifact's hash/offset, erase/preservation policy, creator-confirmed USB/AA power state, stable-identity strategy, backup procedure and known-good recovery image. Stock restoration is conditional on a stock artifact or approved backup procedure. Confirm/document the planned USB-Serial-JTAG/Start-GPIO9 procedure now; H4 demonstrates it after approved bring-up. Never derive offsets from HAL prose. No unapproved flashing, blanket erase or eFuse changes.
3. **H1–H2 — Run Device Lab with one real badge, still outside combat.** Check sensor identification/configuration readback, native signed-conversion vectors (before remapping/encoding), six faces, scale, clipping and fresh-data timestamps/cadence. Verify INFO, both MOTION/STATUS subscriptions, OPEN/SYNC and real motion/commands against the contract. The creator's 100 Hz/±2 g recipe is a diagnostic starting point, not the requested 50 Hz/±8 g profile. Real INFO reports the actual profile; an incomplete/different-profile image stays visibly unsupported for casting, never practice fusion or real-duel Ready. The phone's target-profile emulation rule does not apply to firmware.
4. **H3–H4 — Qualify combined load and recovery before artwork or real casting.** Obtain the 10-minute streaming + feedback + display/LED run, resource headroom/error logs, separately measured sensor/read/output/delivery rates, 20 reconnects, second-central rejection, stale-state clearing and battery-only loaded evidence. Demonstrate the approved normal flash, Start/GPIO9 fallback and known-good recovery procedure. Prefer verified native 50 Hz; no implicit 100→50 decimation or loss/timestamp reinterpretation. Mac testing can start now, but record its OS/adapter and repeat H2–H4 on intended Windows Chrome setups before claiming Windows qualification. No sensor, BLE, display or LED test alone substitutes for combined load.
5. **Create a badge-specific calibration; keep the scripted opponent.** Once the complete capabilities and target profile pass, test one real badge + real microphone. Do not import phone thresholds blindly. With permission, export real-badge positive/negative traces for existing replay tests. Verify actual LEDs/screen, not only an ACK or phone preview. Fix measured handling without branching gameplay by device type.
6. **H5 — Add the second real badge/player.** Run the contract's simultaneous two-wand soak, physical feedback/recovery and 30-minute battery endurance, then the MVP's accuracy, false-cast, defense, outage and five-match gates. Test real cameras/media, microphone isolation and venue conditions.
7. **Disable development input for the real demo.** Remove simulated bindings, switch to a fresh real-only room and verify the source badges on both HUDs. Keep replay tools available separately for diagnosis, not selectable mid-match.

**Expected integration work:** selecting BLE, passing contract conformance, hardware-specific calibration and correcting measured device/driver behavior. **Unexpected and concerning:** rewriting spell rules, bypassing fusion, changing Three.js consumers, faking 50 Hz, or accepting phone-only gyro features to make the badge work. Stop and review the boundary if those become necessary.

## 9. What “ready without the badge” actually means

- [ ] The firmware team and platform team have acknowledged the HAL-grounded contract revision and unchanged interface/version, or the outstanding acknowledgement is explicitly recorded before either implementation freezes.
- [ ] Byte vectors, decoder/encoder, clock/liveness and BLE-adapter lifecycle tests pass.
- [ ] A replayed two-client duel exercises the real fusion, session validation, referee and effects.
- [ ] Real laptop PCM/endpointing, warmed local helper, camera permissions and the intended multiplayer network have been tested independently.
- [ ] Your iPhone qualification and smoke loop pass, **or their limitations remain explicitly open** while replay-based progress continues. Do not claim complete live surrogate coverage from the fallback alone.
- [ ] Failures can be reproduced from bounded, labelled traces; phone and badge profiles cannot collide.
- [ ] Test mode cannot accidentally appear as real-BLE evidence.
- [ ] The first real-firmware integration card requires the H0 release/recovery artifacts, H1 actual-profile/signed-sensor evidence and H2–H4 connected/loaded/reconnect/battery measurements; all unmeasured gates, including Windows qualification, remain visibly open.

**Current checkpoint:** the full implementation plan is approved and is being executed in gated order. Use the [replay-only Slice 1 card](../../../../docs/qa/device-lab-stage-1.md): inspect a jab, feedback expiry, a 600 ms outage/reconnect and source/stale-state indicators. Do not select the available BLE chooser or claim physical evidence. After that card passes, proceed to Stage 2 local ASR. Keep iPhone TLS setup, real BLE qualification, network exposure and later gameplay/render work behind their own listed gates.
