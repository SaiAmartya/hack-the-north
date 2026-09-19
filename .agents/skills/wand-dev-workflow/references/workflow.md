# Sai's platform development and QA workflow

**Purpose:** build and exercise the game with two supported physical inputs—custom BLE badge or iPhone motion—without branching gesture, fusion, combat or presentation. **Updated:** September 19, 2026. The game computers still target Windows Chrome. Android is not required.

**Current direction:** firmware arrived on main `6c1b857`, and Sai requested real-badge integration, physical iPhone play, implementation across non-firmware segments, script-driven QA and a minimal game-only UI. Use [current platform evidence](../../../../docs/qa/game-platform.md) and [firmware review](../../../../docs/qa/firmware-integration-review.md) for status. Do not equate automated passes, iPhone measurements or teammate-reported BLE tests with local badge acceptance. This procedure authorizes no flashing, certificate trust or network changes.

This is the supporting operating procedure for [$wand-dev-workflow](../SKILL.md), not a standalone workflow or a replacement firmware specification. Read with [MVP-OUTLINE.md](../../../../MVP-OUTLINE.md) for gameplay decisions, [IMPLEMENTATION-PLAN.md](../../../../IMPLEMENTATION-PLAN.md) for approved slices and runtime architecture, and [BADGE-FIRMWARE-CONTRACT.md](../../../../BADGE-FIRMWARE-CONTRACT.md) for the authoritative badge interface.

**Your quick reading path:** Sections 1, 3, 6 and 8. Section 4 is the engineering checklist the agent should follow; you do not need to manage its packet/timing details manually.

## 1. The recommendation

Use **three complementary sources** and keep their evidence separate:

| Source | Your use | What it establishes |
| --- | --- | --- |
| **Virtual wand + saved traces** | The agent replays the same inputs automatically after every change | Repeatable packet, timing, recognition, combat and UI behavior; injected failures |
| **iPhone Safari physical wand** | A player holds it, performs real movements and speaks into the **laptop microphone/local ASR** | Human timing, coaching, false activations and playability for the iPhone path |
| **Real badge over BLE** | A player selects it as the room's physical source | Badge acquisition, Windows Bluetooth, badge/grip calibration, physical feedback and endurance |

The iPhone reuses the same protocol-faithful endpoint core as deterministic QA, but its source kind is `phone`, not `replay`. It consumes real phone acceleration and exchanges the same INFO/MOTION/CONTROL/STATUS bytes with the laptop. All production decoding, stream guards, gesture classification, voice fusion, server rules and rendering remain downstream of that boundary.

**Selected phone onboarding:** the explicitly approved phone-only public HTTPS/WSS service uses a QR rendezvous and explicit matching-number approval on the laptop. Both devices connect outbound; the phone does not need a laptop certificate. This is an internet-dependent relay, not direct peer-to-peer Bluetooth. The earlier **private-LAN trusted HTTPS/WSS** profile remains available for controlled-network testing. No native phone app, USB debugging or Android support is required. The initial browser permission needs a direct user action. [Motion permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static)

### Hosted-phone boundary

- Run the game, referee and local speech on the laptop. Deploy only the dedicated phone asset build and motion/pairing Worker, never the full Vite tree or a tunnel to it. The laptop may remain on `http://127.0.0.1:5173`.
- The launcher takes an explicitly selected service origin and a private enrollment-secret file outside the repo. Only the local Vite broker receives that secret; it checks exact Origin and raw laptop peer before creating a pair. The public relay never receives a game token, microphone clip, transcript, camera feed or cast authority.
- QR URLs contain a public rendezvous ID, not a bearer capability. The phone requests motion after a tap, waits for a fresh sample, and displays a challenge; the laptop must approve that same challenge. The owner capability travels only in the first WSS frame. Pair expiry, disconnect and source changes require a new pair.
- Preserve opaque 20-byte records, phone-clock SYNC and all freshness limits. Bound relay delivery, including the Worker-to-laptop path; never treat a WebSocket `send()` as evidence of receipt. Hosted timing needs fresh physical qualification and cannot inherit LAN results.
- The personal hosting account was selected explicitly; the unrelated `at` account is out of scope. Account/deployment approval in one task is not blanket authority for later remote changes. See current platform evidence for actual deployment status.

Wi-Fi jitter and Safari sensor scheduling must pass the live qualification below; documentation cannot promise that a particular iPhone/network will pass. iPhone evidence cannot prove badge sampling, radio, badge grip accuracy or physical feedback. Badge evidence cannot prove Safari permissions, cadence or relay recovery. Keep both source-specific gates open until measured.

For focused physical QA, start with one selected controller and a QA-only scripted opponent, then repeat with two humans. No second phone or badge is needed for deterministic two-player tests. Voice, video, recognition and combat stay on the laptops regardless of the motion source.

## 2. What we should build before expanding the game

| Deliverable | Responsibility / boundary | Done when |
| --- | --- | --- |
| **Minimal player flow + gated diagnostics** | Our team: simple Badge/iPhone setup, calibration, practice and duel; detailed axes/age/loss/speech/fusion only in scripts or `/__qa/*` builds | Players see actionable steps while engineers can still distinguish missing motion, speech, mismatched evidence and server rejection |
| **Shared wand client + virtual endpoint** | Our team: one codec, handshake, clock mapping and feedback model; golden vectors from the firmware contract | Virtual data enters as exact bytes, not preclassified spells; command expiry/dedup work |
| **Laptop PCM + local ASR** | Our team: request/verify a mono 16 kHz AudioContext, AudioWorklet timebase/endpointing with no initial application resampler, and one warmed loopback `faster-whisper base.en` CPU-`int8` helper per laptop | Setup fails if actual mono 16 kHz input is unavailable; successful finals have bounded capture intervals/latency without Web Speech or cloud processing |
| **Thin phone page + paired relay** | Our team: same endpoint core, actual phone acceleration, bridge to the owning laptop | A jab reaches the production decoder/classifier and a returned cue reaches the phone preview |
| **Replay + scripted second player** | Our team: timed raw samples and speech-evidence fixtures through a second normal client | A complete Stupefy/Protego exchange passes through real sockets/referee and effects |
| **First real BLE adapter** | Our team: GATT only; teammates provide the peripheral | Swapping source requires setup/calibration, not edits to combat, fusion or Three.js |

Keep the existing React/TypeScript/Vite and Python/FastAPI foundations. The internally named `/ws/dev-wand` relay remains the private-LAN carrier; the hosted phone-only Worker carries the same endpoint operations over public WSS. Both stay isolated from the referee's state writer. Reuse only the deterministic-testing ideas from [fake_gateway.py](../../../../tools/fake_gateway.py), never its POSIX terminal or old button-cast packets. Use [current platform evidence](../../../../docs/qa/game-platform.md) rather than historical source assumptions to determine what is implemented.

**Stop rule:** diagnose badge and iPhone paths independently. If TLS, permissions, network or sensor delivery block iPhone play, keep unrelated badge/platform work moving and report the iPhone gate blocked; if BLE/firmware blocks badge play, keep unrelated phone/platform work moving and report the badge gate blocked. Replay may reproduce software failures but is never a player fallback. Do not weaken timing gates or silently switch Sai to Android.

## 3. Optional private-LAN phone session

These are durable run steps. Use [current platform evidence](../../../../docs/qa/game-platform.md) for the exact launch commands, implemented controls and known gaps rather than copying stale commands from this procedure.

1. **Ask for the setup check.** The agent confirms the feature branch, clean/known diff, versions, free ports, iPhone/iOS version and controlled network. The new mode must disable the legacy serial reader, host camera and AI director. Replay-only work stays loopback-only; live iPhone testing requires the explicitly approved LAN profile below.
2. **Approve one-time local HTTPS setup.** Use a dedicated development CA/certificate, preferably with `mkcert`, on the trusted development laptop. Generate the server certificate for the exact selected private LAN IP; keep all key material outside the repository and served directories. Explain that trusting this CA permits certificates signed by its key to be trusted, not just this page. Ask before installation or trust changes. Transfer only the public root certificate to your iPhone using a user-approved channel, verify its identity, install its profile and enable full trust in Settings → General → About → Certificate Trust Settings. Never transfer the CA private key or server private key. Managed phones may disallow this; do not bypass policy. [mkcert mobile guidance](https://github.com/FiloSottile/mkcert#mobile-devices), [Apple's trust instructions](https://support.apple.com/en-us/102390)
3. **Open the phone page.** Run the explicit phone-enabled Vite profile on the selected private interface, trusted HTTPS port `5173` with strict-port behavior. Both desktop Chrome and iPhone Safari use `https://<selected-laptop-LAN-IP>:5173`; the iPhone opens `/phone`. Game routes point to laptop A; the owning laptop's speech helper remains fixed at `127.0.0.1:8001` behind the Vite proxy. The proxy must reject speech requests from the phone/LAN peer. Expose only the approved frontend port to the controlled network; no blanket firewall disable, public tunnel or router forwarding. Wi-Fi client isolation may prevent access even on the same SSID. If the IP changes, update the certificate/profile deliberately. [Vite TLS/proxy configuration](https://vite.dev/config/server-options)
4. **Pair in player setup.** Select iPhone input, create a short-lived pairing code, enter it on `/phone` and confirm the displayed controller identity on both screens. The phone is an input accessory for one player, **not a third player**. Tap Enable Motion: call `DeviceMotionEvent.requestPermission()` directly from that tap where supported, before asynchronous pairing/network work consumes user activation. Handle denial explicitly. No spell buttons or diagnostic navigation are added.
5. **Check sensor and laptop-input health.** The phone page reports `isSecureContext`, permission status, non-null x/y/z, observed callback/output cadence, sync/age and connection health. Hold still face-up, then check the six gravity orientations. The laptop shows its microphone worklet, 2-second quiet calibration and warmed local helper generation. Run the qualification below. A loaded page or an API existing is not a passed test. The laptop may need microphone/camera permission again on this new HTTPS origin.
6. **Calibrate and practice.** Keep Safari foregrounded, the phone unlocked and held consistently in portrait with a safe grip. Calibrate in the laptop app, keep its microphone near you, then say Stupefy and perform a short jab. Confirm one exact local-ASR final plus one matching motion became one fused attempt, not merely a motion pulse. The phone shows only minimal connection/motion health and decoded feedback; deeper diagnostics stay in scripts or a gated QA build.
7. **Stop cleanly.** End the room, disconnect the controller and stop the LAN-serving profile. Remove the development CA profile/trust when it is no longer needed; restore any user-approved temporary settings. Locking the phone, switching apps or losing Wi-Fi during a round must fail visibly and clear old evidence. Resume requires a fresh session/Ready, never catch-up delivery.

Why HTTPS matters: `localhost` on the iPhone means the iPhone, not the laptop. A plain `http://192.168…` page does not qualify like laptop loopback. Use a genuinely trusted certificate and WSS, not a certificate-warning click-through or browser security-disabling flag. Hosted phone onboarding supplies public trusted TLS; only this optional LAN profile requires manual certificate trust. [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)

**Only the laptop captures voice/video.** Its browser owns PCM timing/endpointing and its loopback helper transcribes; the phone requests motion access only and shows minimal feedback. Use small wrist/forearm movements; do not throw it or attach it precariously to a wand prop. No background/locked-screen sensing or Screen Wake Lock support is assumed.

### iPhone qualification before trusting a live session

First capture 60 seconds of stillness and comfortable movement, with laptop video/rendering active. Report real callback/output rate, longest gap, delivery ratio, observation-age upper-bound p95, sync RTT/uncertainty and command ACK p95. Distinguish intentional callback decimation from transport loss. Use the contract's current limits unchanged: initially a usable sync RTT ≤100 ms, no gesture spanning a gap >150 ms, reject age upper bounds >200 ms, and fail input at 500 ms without fresh valid data. Aim for ≥95% selected-sample delivery and observation-age/ACK p95 ≤150 ms. These are **iPhone observation/transport measurements**, not hidden sensor-acquisition latency or BLE measurements.

Then prove motion-only/speech-only/mismatch rejection, one accepted cast per correct pair, phone lock/app switch/network loss clearing evidence, and safe fresh-session recovery. Repeat the smoke loop with the real laptop microphone and local helper; run a 10-minute stable rehearsal before treating the phone path as the routine interactive test source. Extend to two iPhones only when two human players need it.

If cadence is below the target 50 unique output samples/second, label the iPhone path **lower cadence** and keep that limitation visible. If timing/freshness gates fail, stop iPhone live fusion and fix the setup; replay may reproduce software behavior but is not a player fallback. Do not relax the profile, interpolate or repeat readings to make an iPhone appear qualified. Synthetic tests retain 50 Hz conformance coverage; physical phone and badge evidence remain separate.

## 4. Engineering guardrails that make the later badge swap easy

### Same endpoint behavior, different source

- Keep only two top-level adapters: `BleWandTransport` for real GATT and `VirtualWandTransport` for the shared endpoint core. The latter uses either an in-memory QA channel or the paired relay to the phone. A physical phone motion source replaces the QA trace generator underneath that core and registers as `phone`, not `replay`. **One shared `WandClient`, decoder and classifier; no phone branches in gameplay.**
- The phone serves the contract's info, notification subscriptions, OPEN/SYNC, state/cue handling and STATUS results. The relay routes typed operations/requests and opaque 20-byte values; it does not recognize gestures, restamp samples or decide combat. Preserve record boundaries; do not invent serial framing.
- Return feedback goes through the normal game-event mapper → CONTROL encoder → phone endpoint. The phone draws a small screen and six LED dots from **decoded commands**, including expiry/duplicate behavior. It must not receive game state through a separate shortcut that hides a broken command path.
- The phone emulator answers SYNC on the **phone's clock**. Phone observation timestamps and SYNC timestamps share that clock; round-trip uncertainty includes the relay. Do not answer SYNC on the laptop while claiming phone timestamps have been aligned. All modes retain the contract's stale/gap/timeout rules.
- Give each phone a distinct, persistent controller ID; a page reload creates a new boot ID. Use monotonic `performance.now()` relative to page startup for observation and command receipt times, not wall-clock time. Relay generations and game-connection generations are separate; old callbacks from either cannot revive a previous session.

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

### Bound and label the phone relay

In the private-LAN profile, the phone page uses same-origin WSS through the HTTPS Vite port and the internally named `/ws/dev-wand` route; laptop-to-FastAPI proxying may remain WS. In the hosted profile, both controller sockets connect outbound to the approved public origin. Preserve exact Origin checks in either case, never wildcard access. The typed envelope identifies the device operation/characteristic and request ID; any embedded contract value remains exactly 20 bytes. Do not reuse the viewer broadcaster for relay delivery. Keep controller traffic off the game socket and out of the referee's command queue. This is the physical iPhone carrier, not a second badge transport, game-command shortcut or part of opponent WebRTC video.

Enable it only when the room explicitly selects iPhone input and the selected secure phone profile is configured. Pair one phone with one authenticated owning player; pairing grants must expire, be single-use/rate-limited and allow only device operations, never game/reset/admin actions. A phone connection consumes no extra player slot. Keep bearer capabilities and game tokens out of URLs/logs/traces; the hosted QR's public room locator alone grants no control. Validate Origin and bounded message sizes. Disconnect either side to invalidate that pair/session and clear evidence. A new round/source requires fresh readiness; no source switching mid-round.

The data path uses bounded latest-sample queues, bounded command/result queues and non-blocking relay fan-out. WebSocket/TCP can still accumulate ordered data in transport buffers: observe buffered bytes/ages, drop unsent obsolete samples and **close/reconnect** a persistently backed-up link rather than drain it into gameplay. Never advance liveness because an old buffered sample has only just arrived. Motion and controller write failures must not stall the authoritative referee.

Register the player source as `phone` even though it reuses the virtual endpoint implementation. Evidence exports distinguish `PHONE`, `REAL BLE` and `REPLAY QA`, separately from `REAL LOCAL ASR` or `SCRIPTED SPEECH`. Player rooms accept physical iPhone or badge sources and refuse replay/scripted input. These safeguards prevent accidental claims, not malicious anti-cheat. Do not alter the firmware contract's packet bytes to add phone-only fields; source metadata lives outside those bytes.

## 5. The useful shortcuts

### Record once, replay every regression

After a good or bad attempt, optionally save a short trace: normalized notification bytes, source/receipt times, clock-sync evidence, lifecycle changes, calibration/profile version, expected gesture and canonical speech-evidence timing. Tag origin as phone, synthetic or real badge. Keep the original timing/gaps; do not silently smooth a failed trial into a successful one.

No raw microphone audio, camera video, transcripts, secrets or personal phone IDs by default. Capture/commit a diagnostic only with approval. Use an in-memory bounded trace until explicitly exported; a recording must not quietly upload itself. A trace manifest should include commit/build, device/browser type, observed cadence, source mode, seed when synthetic, intended action, expected outcome and actual rejection/acceptance.

Replays need two clocks: an explicit fixture clock for deterministic offline tests and the live clock for interactive rehearsal. In offline tests, replay the original sync/relative timing. In live replay, rebase the trace into a **new emulated boot/session**, preserve deltas/gaps and perform a fresh handshake—do not replay old boot IDs/timestamps into today's session. Never compare recorded timestamps directly with the current laptop clock.

This means you perform a gesture once; the agent can then reproduce its failure many times without asking you to repeat it. Separate tuning traces from held-out attempts/another grip so a green test does not just mean we overfit one recording.

### Give yourself a sparring partner

Open a second ordinary client controlled by the test runner, reachable only through the QA harness. It generates known raw motion plus clearly scripted speech evidence, then uses the same fusion and real referee. It can send a predictable Stupefy so a player repeatedly practices a **real spoken Protego + selected physical gesture**. No fake incoming damage, direct server cast injection or pre-decided block result in this full-path test.

The scripted client keeps its required input/lifecycle heartbeats alive and runs in a separate visible window or an automated browser context; an ordinary background tab would correctly trip our page-visibility protection. Use a labelled synthetic video source if no second camera is available. Mute it: a bot test is not a nearby-opponent-speech or real WebRTC-camera qualification test.

### Make failures reproducible

Scripts and build-gated QA routes offer presets for duplicate samples/results, lost motion, a 600 ms outage, old-connection callbacks, failed feedback ACK, reboot, expired cues and server loss during an incoming attack. Never expose these controls in player navigation. Use the protocol decoder/stream boundary, not a bypass that disables safeguards. Each regression asserts no stale/duplicate cast, consistent health and no replayed hit/victory animation.

## 6. Your repeatable 10–15-minute QA loop

Run this after a meaningful input/network/game change, not after every CSS tweak. The agent supplies a short test card, the minimal player-visible health state and any separate script output; you supply real motion/speech and judgment.

| Step | What you do | What we check |
| --- | --- | --- |
| 1 — identify | Confirm commit/build, source mode, controller alias and microphone; calibrate | No wrong device, stale profile or hidden simulated input |
| 2 — negatives | Say the spell without moving; move silently; use the wrong gesture; fidget briefly | No fused cast; useful reason shown |
| 3 — positives | Five comfortable Stupefy attempts and five Protego attempts | One cast per valid pair; record misses/false accepts, not just success percentage |
| 4 — defend | Let the scripted opponent send five predictable attacks; guard by speaking and raising | Server accepts guard before impact; both views agree, no retroactive shield |
| 5 — break | iPhone: lock/switch apps/lose Wi-Fi. Badge: power off/drop BLE. Reconnect and Ready again | Clear abort, no old cast/cue on return, fresh handshake/calibration as needed |
| 6 — hand back | Describe which step failed; approve exporting only the useful short trace | Agent reproduces, makes one scoped fix, reruns automated checks, asks for only the affected retest |

This is a **smoke loop**, not the final acceptance sample size. Keep the MVP's 20-attempt/player/spell, nearby-opponent-speech trials, defendability and five-match gates for each claimed physical source. Ask a teammate to speak while you gesture to test microphone cross-talk; a prerecorded bot transcript cannot test that risk.

The development loop remains: feature branch → approve one scoped plan → implement that slice → automated tests → fresh independent review from the other model family → your physical test → fixes → your diff review. Use the current `dev-build`, `dev-review` and `dev-verify` workflow stages; verify review claims and cap review/fix loops at two before surfacing disagreement. Commit/push/PR/deploy only when you explicitly request them. Keep `main` clean; do not install certificates, change firewall settings, publish a phone page or flash a badge as an implied QA step.

## 7. If a physical input route is blocked

Use the other qualified physical source for play if available, and report the blocked Badge/iPhone path honestly. For diagnosis only, use a virtual wand with the real laptop microphone and loopback helper behind the QA gate. A timestamped motion replay plus live speech can test local transcription, pairing windows, effects and network behavior; it does not test physical motion and must never appear as a player fallback.

**Optional iPhone-only offline fallback:** with Sai's approval to install/use phyphox, record acceleration **with gravity** and timestamps using its [Acceleration with g](https://phyphox.org/experiment/acceleration-with-g/), then explicitly export a small CSV and import it as a labelled replay trace. Verify the experiment, units, axes and timestamp columns before conversion. An offline CSV has no simultaneous laptop speech evidence: use scripted speech for deterministic fusion tests, or speak live against an explicitly rebased replay. Do not claim an offline recording tested real-time latency. No live phyphox HTTP/UDP integration or custom native app is part of the initial build.

**If certificate trust or LAN access is blocked:** stop iPhone setup, preserve independent badge/software progress and state that iPhone hand/speech timing is untested. Ask Sai before choosing hosted HTTPS/tunnelling or a different network; those change exposure/ownership and are not automatic workarounds. Do not silently switch to Android or substitute untrusted HTTP.

The badge path remains **one battery-powered badge → direct BLE → laptop**. The iPhone path remains **one foreground Safari controller → trusted WSS → laptop**. Each is a supported physical player choice with its own acceptance evidence; testing one does not qualify the other.

## 8. Badge hardware qualification and firmware updates

Use the [HAL-grounded contract's H0–H5 gates and release checklist](../../../../BADGE-FIRMWARE-CONTRACT.md#8-acceptance-and-handoff-checklist). The [unchanged creator HAL](../../../../docs/hardware/custom-firmware-hal.md) is creator-supplied evidence, not measured qualification; its provenance/hash and qualifications live in the contract. Do not follow its generic NFC/button checklist as game requirements.

1. **Freeze the last known-good software/replay result and acknowledge the revised contract.** Preserve protocol bytes/UUIDs/golden vectors; incompatible implemented-interface changes require explicit versioning. Obtain image/source/hash, exact SDK/configuration including the NimBLE mitigation, actual profile/capabilities, and remaining qualification gaps. No test harness success proves connected BLE works on the badge.
2. **H0 — Check the recovery handoff before an approved flash.** Require board revision, exact partition CSV/summary, each artifact's hash/offset, erase/preservation policy, creator-confirmed USB/AA power state, stable-identity strategy, backup procedure and known-good recovery image. Stock restoration is conditional on a stock artifact or approved backup procedure. Confirm/document the planned USB-Serial-JTAG/Start-GPIO9 procedure now; H4 demonstrates it after approved bring-up. Never derive offsets from HAL prose. No unapproved flashing, blanket erase or eFuse changes.
3. **H1–H2 — Run gated input diagnostics with one real badge, still outside combat.** Check sensor identification/configuration readback, native signed-conversion vectors (before remapping/encoding), six faces, scale, clipping and fresh-data timestamps/cadence. Verify INFO, both MOTION/STATUS subscriptions, OPEN/SYNC and real motion/commands against the contract. The creator's 100 Hz/±2 g recipe is a diagnostic starting point, not the requested 50 Hz/±8 g profile. Real INFO reports the actual profile; an incomplete/different-profile image stays visibly unsupported for casting, never practice fusion or player Ready. The phone's target-profile emulation rule does not apply to firmware.
4. **H3–H4 — Qualify combined load and recovery before artwork or real casting.** Obtain the 10-minute streaming + feedback + display/LED run, resource headroom/error logs, separately measured sensor/read/output/delivery rates, 20 reconnects, second-central rejection, stale-state clearing and battery-only loaded evidence. Demonstrate the approved normal flash, Start/GPIO9 fallback and known-good recovery procedure. Prefer verified native 50 Hz; no implicit 100→50 decimation or loss/timestamp reinterpretation. Mac testing can start now, but record its OS/adapter and repeat H2–H4 on intended Windows Chrome setups before claiming Windows qualification. No sensor, BLE, display or LED test alone substitutes for combined load.
5. **Create a badge-specific calibration; keep the scripted opponent.** Once the complete capabilities and target profile pass, test one real badge + real microphone. Do not import phone thresholds blindly. With permission, export real-badge positive/negative traces for existing replay tests. Verify actual LEDs/screen, not only an ACK or phone preview. Fix measured handling without branching gameplay by device type.
6. **H5 — Add the second real badge/player.** Run the contract's simultaneous two-wand soak, physical feedback/recovery and 30-minute battery endurance, then the MVP's accuracy, false-cast, defense, outage and five-match gates. Test real cameras/media, microphone isolation and venue conditions.
7. **Use a fresh physical room for the demo.** Player navigation exposes only Badge or iPhone; choose and verify badges on both HUDs for the prize-track demo. Keep replay/fault tools available only in scripts or a separate gated QA build, never selectable mid-match.

**Expected integration work:** selecting BLE, passing contract conformance, hardware-specific calibration and correcting measured device/driver behavior. **Unexpected and concerning:** rewriting spell rules, bypassing fusion, changing Three.js consumers, faking 50 Hz, or accepting phone-only gyro features to make the badge work. Stop and review the boundary if those become necessary.

## 9. Evidence required for readiness claims

- [ ] The firmware team and platform team have acknowledged the HAL-grounded contract revision and unchanged interface/version, or the outstanding acknowledgement is explicitly recorded before either implementation freezes.
- [ ] Byte vectors, decoder/encoder, clock/liveness and BLE-adapter lifecycle tests pass.
- [ ] A replayed two-client duel exercises the real fusion, session validation, referee and effects.
- [ ] Real laptop PCM/endpointing, warmed local helper, camera permissions and the intended multiplayer network have been tested independently.
- [ ] Your iPhone qualification and smoke loop pass for iPhone claims, or their limitations remain explicitly open. Replay coverage is not physical iPhone evidence.
- [ ] Failures can be reproduced from bounded, labelled traces; phone and badge profiles cannot collide.
- [ ] Test mode cannot accidentally appear as real-BLE evidence.
- [ ] The first real-firmware integration card requires the H0 release/recovery artifacts, H1 actual-profile/signed-sensor evidence and H2–H4 connected/loaded/reconnect/battery measurements; all unmeasured gates, including Windows qualification, remain visibly open.

**Current checkpoint:** the full implementation plan is approved and is being executed across the platform and both physical-input paths. Read [current platform evidence](../../../../docs/qa/game-platform.md) for implemented surfaces, exact checks and the next unmet gate; read the [firmware review](../../../../docs/qa/firmware-integration-review.md) for badge-specific evidence. Do not repeat obsolete slice cards or turn automated replay into player UI. Certificate trust/network exposure, firmware flashing, commits and remote writes retain their separate approval boundaries.
