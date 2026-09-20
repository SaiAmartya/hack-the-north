# Harry Potter Battle Simulator — 0→1 Implementation Plan

**Product:** a two-player live-video duel in which every spell requires a spoken incantation on the player's laptop and a matching motion from that player's hacker badge or iPhone.

**Current direction (September 19, 2026):** the approved [input rebuild](docs/qa/input-rebuild.md) supersedes the older connection/calibration slices below: hosted HTTPS QR, direct data-only WebRTC first, explicit Internet relay, recoverable approved pairs, visible sensor/receipt indicators and explicit grip calibration. Both real BLE badge and physical iPhone remain player controls. Sai authorized publication of the reviewed rebuild after integrating teammate main `76b6388`; see [teammate setup](docs/TEAM-SETUP.md) for current installation/run steps. The current firmware source is 0.2.1 (0.2.0 was the first gameplay image); it is flashed on WAND-B602 with readback verification and its physical QA card is pending. Automated raw replay is test-only. Physical badge, iPhone, speech and Windows acceptance remain distinct from software tests and from one another.

This document is the durable end-to-end build order. [MVP-OUTLINE.md](MVP-OUTLINE.md) owns product/gameplay scope, [BADGE-FIRMWARE-CONTRACT.md](BADGE-FIRMWARE-CONTRACT.md) owns the unchanged badge interface, [DESIGN_SYSTEMS.md](DESIGN_SYSTEMS.md) owns visual and interaction presentation, and [$wand-dev-workflow](.agents/skills/wand-dev-workflow/SKILL.md) owns the development and human-QA procedure. If they conflict on badge bytes, the firmware contract wins; if they conflict on what game to ship, the MVP outline wins. The design system cannot change mechanics, runtime gates or evidence status.

## 1. Outcome and locked decisions

### 1.1 Finish line

The first complete playable checkpoint is one physical exchange with either supported controller:

> Player A says “Stupefy” and makes the coached jab with a selected badge or iPhone. Both clients receive one authoritative projectile with a future impact time. Player B says “Protego” and raises their selected controller before that deadline. The server resolves one block, both browsers show the same health/result, and each controller presents only decoded confirmed feedback.

Repeat the exchange with two qualified badges for the prize-track demo. Badge and iPhone evidence remain source-specific: one physical path never certifies the other.

The badge is the wand, not a controller. During combat there are no spell buttons, arming buttons, loadouts or mouse/keyboard shortcuts. Setup, calibration, Ready and Rematch remain laptop controls.

### 1.2 Locked product and platform choices

| Area | Decision |
| --- | --- |
| Players | One private-LAN room, exactly two players and one round at a time |
| Physical input choices | One custom-firmware BLE badge or one paired iPhone per player; source locks for the room |
| Automated QA | Deterministic replay and scripted speech only through test scripts or explicitly build-gated `/__qa/*` routes |
| Demo qualification | Windows x64 desktop Chrome on the intended laptops; qualify badge and iPhone paths independently and use badges for the prize-track demonstration |
| Wand | One custom-firmware BLE badge or one iPhone per player; spare badges are for recovery/development |
| Speech | Each laptop captures its own microphone and runs its own local `faster-whisper` helper; no cloud or browser-vendor ASR |
| Input contract | Exact canonical incantation plus compatible fresh motion; neither alone casts |
| Game | Stupefy, Protego, then Expelliarmus only after the two-spell core passes |
| Authority | One Python referee on laptop A owns health, cooldowns, projectile deadlines, impacts and results |
| Media | Browser-to-browser WebRTC video only; no peer audio and no TURN service in MVP |
| Rendering | Opponent HTML video plus one transparent plain-Three.js fixed-anchor effects canvas and a DOM HUD |
| State | In-memory room and browser-local calibration; no accounts, database or match recovery |

Out of scope: NFC, computer vision, camera hit detection, gyro features, position reconstruction, phoneme matching, an LLM, cloud ASR, a native phone app, a full 3D world, avatars, generated art dependencies, physics, public matchmaking, persistent profiles and anti-cheat.

### 1.3 Evidence boundaries

Never collapse these into one “working” claim:

1. deterministic replay proves packet, timing, fusion, referee and client behavior;
2. iPhone Safari plus a real laptop microphone proves measured human interaction for the iPhone physical-input path, not badge behavior;
3. Windows laptop tests prove the target browser, microphone, camera, WebRTC and performance setup;
4. contract H0–H5 proves real badge sensor, BLE, feedback, recovery and endurance behavior.

QA traces/results name their motion and speech sources. Player screens use only a small Badge/iPhone identity and actionable connection state; scripted input, fault injection and diagnostics are never player options.

## 2. Runtime architecture

### 2.1 Technology baseline

- Frontend: React 18, TypeScript 5.7, Vite 6.4.3, DOM/CSS HUD and plain Three.js.
- Browser checks: Vitest with fake clocks and Playwright/Chromium with isolated player contexts.
- Services: Python 3.12.3, FastAPI, Pydantic and pytest.
- Speech: `faster-whisper` `base.en`, English, CPU `int8`, one warmed inference worker per laptop.
- Production browser: qualified Windows x64 desktop Chrome build. “Chromium-compatible” is not accepted as a substitute for the tested Chrome build.

Keep the new duel behind an isolated entry path and runtime mode. That mode must not start the legacy serial gateway, host-camera/JPEG worker, AI director or old button/preclassified-cast flow. Those legacy files were removed from the tree on September 19, 2026 (commit `530a0ba`) and remain only in git history.

### 2.2 Ownership and data paths

| Runtime | Owns | Must not own |
| --- | --- | --- |
| Badge firmware ×2 | Fresh acceleration, contract-v1 GATT endpoint, device health, local activity and expiring confirmed feedback | Speech, gesture classification, cast validity, health or combat timing |
| Browser ×2 | BLE/virtual transport, packet validation, clock mapping, calibration, gesture evidence, PCM capture/endpointing, fusion, setup, video, HUD/effects and badge-event projection | Damage, cooldown decisions or retroactive shield outcomes |
| Local speech helper ×2 | One bounded PCM clip → one final English transcript/result | Microphone capture, VAD/endpointing, pairing, match state, non-loopback listening or stored audio |
| Referee ×1 | Sessions, room/round state, validated cast order, scheduled impacts, health/status, immutable events and signalling authorization | Raw badge samples, raw audio, rendering or client-proposed damage |
| iPhone controller page | Raw acceleration beneath the shared protocol endpoint and decoded command feedback | Speech, preclassified gestures, direct casts or game authority |

Motion path:

`badge or virtual endpoint → WandTransport → WandClient/contract decoder → calibrated segmenter/classifier → gesture evidence`

Speech path:

`laptop mic → AudioWorklet PCM/timebase → browser endpointing → same-origin speech proxy → local helper → final canonical speech evidence`

Combat path:

`one gesture + one speech evidence → fused attempt → authenticated game socket → referee → immutable action/projectile/effect event → independent render/audio/badge consumers`

### 2.3 Network topology and routes

Laptop A runs the referee. Each laptop runs its own Vite frontend and local speech helper.

| Surface | Binding and route | Notes |
| --- | --- | --- |
| Frontend | `http://127.0.0.1:5173` normally | Each laptop has its own instance; preserve this exact default origin |
| Game API | `/api/game/*` proxied to laptop A port `8000` | Setup/health only; mutations require authenticated player/session context |
| Game socket | `/ws/game` proxied to laptop A port `8000` | Authenticated first message; game events and WebRTC signalling |
| Phone wand relay | Internally named `/ws/dev-wand` on the game service | Explicit iPhone-input profile; never a badge transport or QA cast bypass |
| Speech health | `/api/speech/health` proxied to that laptop's `127.0.0.1:8001` | Must report loaded model, settings, warm state, worker availability and generation |
| Speech transcription | `/api/speech/transcribe` proxied to that laptop's `127.0.0.1:8001` | One bounded clip; no streaming microphone and no queue |

For the two-laptop room, Vite on each machine points game routes to laptop A's selected private IPv4. Speech routes always point to the **same laptop's** loopback helper. The helper binds only `127.0.0.1:8001`; it is never exposed on the LAN.

The Vite speech proxy enforces the raw TCP peer as loopback or that laptop's own selected interface, validates the exact expected Origin and never trusts a forwarded-address header. It rejects the phone/LAN peer before proxying, accepts only bounded 16-bit mono 16 kHz PCM/WAV, caps a 3-second request at 128 KiB, and adds a per-run helper secret server-side. The secret is not bundled into browser JavaScript, logged or committed. Raw audio never goes to the referee, opponent or internet.

For iPhone play, the approved hosted profile keeps the game frontend on laptop loopback and serves only dedicated phone assets/pairing/WSS through the personal Cloudflare account. QR rendezvous requires explicit matching-number laptop approval; the local-only `/api/phone/*` broker mints scoped relay capabilities with a server-side enrollment secret. No game token, audio, transcript or video enters that service. It is internet-dependent and must pass the same physical latency/freshness gates. The optional private-LAN profile still serves Vite over trusted HTTPS/WSS on the selected interface at port `5173`, with both devices on that origin and no phone access to speech. New deployment, trust, firewall and LAN exposure changes require explicit approval. Never publish or tunnel Vite/the referee/speech to implement phone onboarding.

### 2.4 Core interfaces

The badge contract remains unchanged: four GATT characteristics and exact 20-byte protocol records/commands defined in [BADGE-FIRMWARE-CONTRACT.md](BADGE-FIRMWARE-CONTRACT.md). Do not add phone or ASR fields to those bytes.

Only two top-level device adapters exist:

- `BleWandTransport`: Chrome Web Bluetooth/GATT.
- `VirtualWandTransport`: the identical endpoint behavior over in-memory replay or the development relay.

One shared `WandClient` handles INFO, subscriptions, OPEN/SYNC, boot/link generations, sequence/freshness validation and CONTROL/STATUS. Neither adapter emits a convenient spell name.

Internal evidence is interval-based and generation-scoped:

- `GestureEvidence`: ID, device/input generation, calibrated profile, candidate interval and spell-specific feature/evidence values.
- `SpeechEvidence`: ID, microphone/ASR generation, **unpadded voice interval**, exact final text/canonical spell and completion time.
- `CastAttempt`: session, round, attempt ID, spell, consumed gesture/speech IDs and browser receipt time. It contains no damage or requested impact result.

Referee events include round/state version, immutable action/projectile/effect IDs, server timestamps and deadlines. The same event ID fans out to rendering, sound and badge feedback; each consumer independently deduplicates it. Snapshots update durable state but never recreate historical one-shot effects.

Validate messages at runtime in both TypeScript and Pydantic, with shared cross-language fixtures for the game interface. Publish the active ruleset from the referee; the HUD must not keep its own cooldown/flight-duration copy. Use opaque player sessions, server-assigned slots, one active connection per player and session/round/input-generation deduplication. Lock the declared physical source during play. Player rooms accept Badge or iPhone and reject replay/scripted input as an accidental-misconfiguration safeguard, not an anti-cheat guarantee.

## 3. Detailed implementation specifications

### 3.1 Protocol core, QA diagnostics and physical endpoints

Keep the player UI game-only: Badge/iPhone choice, connection/pairing, actionable permission and calibration prompts, practice, Ready and duel state. Detailed Device Lab diagnostics live only in scripts or explicitly build-gated `/__qa/*` routes and never appear in production navigation. Those QA surfaces may expose:

- input source, device/boot/link identity and contract capabilities;
- raw and calibrated axes, sample sequence, capture/receipt age, gap/loss and clock uncertainty;
- setup/calibration state, classifier candidates and explicit rejection reason;
- microphone permission, RMS/noise floor, endpoint state, ASR health/generation/latency and final canonical word;
- the one pending fusion attempt and whether evidence was consumed or invalidated;
- outbound badge state/cue command and decoded status/ACK;
- video, game socket, render quality and source-evidence labels.

The virtual endpoint implements the real packet codec, subscriptions, OPEN/SYNC, status, command expiry/deduplication and disconnect/reboot behavior. Its QA-only controller preview is driven by decoding outbound command bytes, never by reading game state directly.

Phone motion uses `accelerationIncludingGravity` in fixed device coordinates and the contract's units/clipping mapping. Recommend a comfortable sideways/slightly diagonal grip; calibrate any consistent starting grip, independently for each source. Screen rotation does not remap axes or disconnect. Verify all six gravity faces. At each 20 ms output opportunity, select only the newest not-yet-used finite observation. Skip when none exists: never interpolate, repeat or backfill a sample to fake 50 Hz. Preserve a monotonic millisecond observation clock, sequence selected observations, guard old relay generations/callbacks and expose actual callback/output cadence.

Initial safety/freshness rules remain aligned with the firmware contract:

- no gesture spans a sample gap over `150 ms`;
- reject sample-age upper bounds over `200 ms`;
- reset evidence on a measured browser/relay stall over `200 ms`;
- declare input failed after `500 ms` without a fresh valid sample;
- bounded latest-sample and result queues only; never drain stale backlog into play.

The WSS relay carries typed endpoint operations and opaque 20-byte contract values. It does not restamp motion, recognize a gesture, forge a cast or bypass the return command path. Connection-generation changes clear evidence. Pair grants are short-lived, single-use and scoped to one phone and owning player.

MOTION timestamps and SYNC replies use the same phone clock. Track deliberate observation decimation separately from loss of selected samples. Pairing allows one owner and one accessory, has no game/admin authority, and ends when either side disconnects. Keep grants out of URLs/logs, bound messages, and close a persistently backlogged transport instead of delivering catch-up input.

### 3.2 Local speech capture and transcription

#### Browser-owned PCM and endpointing

Acquire a mono laptop-microphone track once for explicit practice/countdown/play and request `new AudioContext({ sampleRate: 16000 })`. Feed a dedicated `AudioWorklet`; do not drive audio blocks through React state. Verify that the actual `AudioContext.sampleRate` is exactly 16 kHz and that worklet input is mono before setup can pass. If the browser/device does not provide that actual format, fail setup visibly. The initial implementation has **no application resampler**. Report actual frame counts and test real block sizing, continuity and rate rather than assuming the request was honored.

Anchor `currentFrame / sampleRate` to a monotonic browser timebase. Derive voice onset/end from frame indices, not delayed main-thread message arrival. Carry an audio generation on every worklet message so callbacks from a stopped graph cannot revive a new session.

These are browser capture-time estimates, not a measurement of microphone/OS buffering. RMS endpointing is an initial algorithm to qualify early, not a venue-robustness claim. A failed gate calls for a measured change behind the same clip interface, not an undisclosed speech path.

Before practice/Ready, capture **2 seconds of quiet** to establish an RMS noise floor. Update it only while confidently idle and freeze it from speech onset until the utterance is resolved. Use hysteresis with:

- `60 ms` sustained start evidence;
- `150 ms` pre-roll retained in the clip;
- `200 ms` sustained end silence;
- at most `1.8 s` of active voice;
- an absolute `3.0 s` clip cap including padding.

The `SpeechEvidence` interval is the estimated voice onset/end and excludes pre-roll/end padding. Padding exists only to improve transcription. Non-finite PCM, dropped frames, a hidden page, device change or audio-generation change invalidates the clip.

#### Local helper

Each laptop starts its own fixed loopback helper before Ready. Provision the model before the demo, load it from local files only and fail visibly rather than downloading during Ready/play. Load and warm `faster-whisper` `base.en` once with CPU `int8`, language fixed to English, greedy decoding, temperature `0`, `condition_on_previous_text=False` and a fixed three-spell glossary prompt. Consume the library's lazy segment generator fully inside the single inference worker before completing a response.

Pin the model revision and helper dependency versions during explicit setup. Cancelling an HTTP request does not stop native inference; worker occupancy remains truthful until inference actually completes.

Use one inference worker with **no request queue**. One unresolved utterance may own it. A second speech onset while an utterance/inference is unresolved invalidates the pending attempt and must not enqueue a second transcription; the old result is ignored by generation, and the player must return to clean idle before retrying.

The helper returns the caller's utterance/generation IDs, final normalized text, model/settings identity and measured inference duration. Application acceptance uses only exact canonical `stupefy`, `protego` or `expelliarmus` after conservative punctuation/case normalization. There are no automatic aliases, phoneme/fuzzy matches, interim results or partial casts. The glossary guides decoding; it does not force acceptance.

The final result deadline is `voiceEnd + 1000 ms`, including the `200 ms` browser endpoint silence and helper inference. Delivery time never changes the capture interval. A late/stale result is discarded; a worker that misses the deadline becomes unhealthy and aborts an active round rather than silently pairing later text. `/api/speech/health` must be warm/idle before Ready. Helper loss, microphone loss, page suspension or repeated timing failure clears evidence and transitions input health immediately.

Privacy defaults:

- clips exist in bounded memory only and are released after the response;
- no raw audio, transcript, room token or helper secret is written to logs/traces;
- the helper performs no outbound network call and binds only loopback;
- stopping/leaving closes tracks and the worklet; there is no always-on background capture.

### 3.3 Motion classification and calibration

Calibrate each `source kind + device alias + sensor profile + grip` independently. Never reuse iPhone thresholds for a badge.

1. Record `3 s` of stillness for bias, gravity direction and noise.
2. Coach three safe examples of each enabled motion.
3. Check later held-out attempts rather than declaring success on calibration examples alone.
4. Invalidate calibration when source/profile or the deliberately selected grip changes. A screen-layout rotation alone changes neither the sensor coordinate frame nor calibration. Return to the learned neutral between gestures; use Reset grip for a different grip.

Start candidate segmentation with `200 ms` rest, `150–900 ms` movement and `150 ms` settling. Use filtered acceleration including gravity, dominant-axis energy, sign/order, impulse/settle behavior and orientation deltas. Do not integrate acceleration into position.

- Stupefy jab: compact dominant forward-axis impulse and settle, with the intended axis contributing at least `65%` of candidate energy.
- Expelliarmus sweep: dominant calibrated lateral energy at least `65%`, correct sign/order and settle.
- Protego guard: a fresh raise followed by a stable orientation at least `25°` from neutral; neutral begins within `20°` of the calibrated grip. Detect tilt, not absolute height. Holding a pose cannot repeatedly cast.

These are initial hypotheses to tune with held-out iPhone and real-badge traces. If the third motion remains confused, cut Expelliarmus; do not add ML or gyro dependence.

### 3.4 Speech–motion fusion

Maintain at most one unresolved utterance and one pending cast attempt per player.

1. Gesture and voice intervals may overlap or have a maximum gap of `350 ms`.
2. Their interval union may span no more than `2000 ms`.
3. The final canonical transcript must arrive within `1000 ms` of voice end in the same audio/ASR generation.
4. The canonical incantation selects the required gesture evidence; contradictory evidence rejects the attempt.
5. Ambiguous multiple gestures, a second speech onset, more than one plausible pairing or any generation/input-health change invalidates the attempt.
6. A successful pair consumes both evidence IDs exactly once and emits one session/round-bound cast attempt.
7. Rejection, timeout, disconnect, reconnect, page hide, round change or Ready loss clears both sides; evidence is never carried into a later attempt.

Local badge LEDs may show immediate motion activity. A spell-specific confirmed cue begins only after the referee accepts the fused attempt. No input outage grants a shield or pauses an impact.

### 3.5 Referee and deterministic combat

Build a new isolated duel engine inside the existing Python/FastAPI/Pydantic stack. Reuse infrastructure and deterministic testing patterns, but do not adapt or extend the legacy button/mana game rules. The duel engine is the single authority for this mode and runs at an initial `20 Hz` with an injected monotonic clock in tests.

The state machine is `LOBBY → COUNTDOWN → PLAYING → RESULT → LOBBY/REMATCH`, with an abort path that clears projectiles/evidence and awards no winner. Both players must register healthy input/device generations and Ready against the same room generation.

One state writer processes authenticated cast receipts and scheduled impacts chronologically:

- a cast received before an impact deadline may affect that impact even when both are processed on a later tick;
- a cast received after the deadline cannot be backdated;
- equal-time guard versus impact is impact-first;
- impacts due in the same simulation step resolve as a batch before choosing a winner, permitting a draw;
- disconnect, stale wand, unhealthy ASR, hidden page or lost game connection aborts under the MVP fairness rule.

Capture receipt time before enqueueing each command. Once lethal damage has occurred, reject new casts while still resolving already-launched impacts due in that simulation step before deciding the knockout result. At the 60-second deadline, resolve impacts due by that deadline and then determine the result. Protego remains available during offensive lockout; an existing projectile survives its caster becoming disarmed.

Keep the MVP numbers in [MVP-OUTLINE.md](MVP-OUTLINE.md): 60 seconds, 100 HP, Stupefy 20 damage/2 s cooldown/initially 2 s flight, Protego one block/1.2 s duration/3 s cooldown, 600 ms offensive recovery, and conditional Expelliarmus 10 damage plus 1 s offensive lock/6 s cooldown/initially 2.2 s flight.

Browsers send 500 ms heartbeats; the referee initially fails a client after 1.5 seconds. Socket writes sit outside the simulation lock. Per-client queues are bounded, snapshots coalesce, persistently slow clients disconnect, and no slow writer delays impacts.

Retain a bounded recent authoritative-event history for resynchronization: outcomes must not silently disappear, and snapshots must not replay completed effects. Reconnection always requires fresh Ready. Video-only or feedback-only loss warns without changing combat; input-health loss aborts with no winner and clears projectiles.

### 3.6 Setup, play and WebRTC

The player journey is explicit:

1. **Setup:** select source, bind the correct wand/phone, start the local ASR helper, grant laptop microphone/camera and connect to the game service.
2. **Calibrate:** stillness, gestures and 2-second microphone noise-floor capture.
3. **Practice:** require real positive and negative spell checks with visible reasons.
4. **Join/Ready:** reserve device identity, confirm source labels and all input-health generations, then ready.
5. **Countdown/Play:** microphone worklet, local helper and motion streams are already healthy before zero; no mid-round source switching.
6. **Result:** shared result/recap, stop one-shot effects, then explicit Rematch or Leave.

Use one video-only `RTCPeerConnection` per client with the perfect-negotiation pattern, authorized/generation-scoped signalling and queued ICE until a remote description exists. Start at 720p/30 fps; low quality uses 480p. Mute self-preview. No peer audio, public TURN, recording or reconnect-resume system. Stop every media track and clear signalling generations on Leave.

### 3.7 Visual and audio specification

Use the two related modes in [DESIGN_SYSTEMS.md](DESIGN_SYSTEMS.md): the warm, card-based **Wizarding Workshop** for player setup, calibration and practice, then the dark **Enchanted Mirror** for countdown, combat and results. Any build-gated QA diagnostic keeps the Workshop visual language but is not reachable from player navigation. The duel specification below is unchanged: opponent video remains the dominant surface, and bright Workshop cards never cover it.

Layer order:

1. HTML opponent video with `object-fit: cover`;
2. CSS near-black vignette and restrained brass portal corners;
3. one transparent, pointer-events-none Three.js canvas;
4. DOM HUD, status text and muted self-preview.

Fixed normalized anchors are local cast `(0.18, 0.76)`, opponent target `(0.50, 0.46)`, near impact `(0.50, 0.57)`, and shield center `(0.50, 0.55)` at roughly `0.62 × 0.68`. The attacker view travels local-to-target; the defender view travels target-to-camera with authored scale. No tracking, video texture or inferred body position.

HUD: opponent name/health above the portal, own health lower-left, three original line-art cooldown glyphs bottom-center, and a small `YOU` preview lower-right. Technical diagnostics stay in gated QA surfaces, not player setup or the duel. Use near-black `#05070D`, ivory `#F4E7C5`, brass `#C59B5A`; distinguish spells by silhouette and motion as well as color.

Renderer:

- one alpha `WebGLRenderer`, an orthographic camera and no lights, shadows, physics, bloom or post-processing;
- shader/basic materials, pooled `BufferGeometry`, ribbon quads instead of platform-dependent wide lines;
- mostly `depthTest:false` and `depthWrite:false`; additive blending only for bright cores/rims/sparks;
- precompile before Ready, keep the loop outside React, allocate nothing per frame, stop on hide/abort and dispose on teardown;
- preallocate 8 projectiles, 2 shields, 2 ripples and a shared pool of at most 96 points.

Spell treatments:

- **Stupefy:** radial-SDF quad head, white core/crimson corona, 12-node bent ribbon, `0–120 ms` launch flare and `0–240 ms` resolved burst. The flight duration is exactly the server launch/impact interval.
- **Protego:** low-poly elliptical cap near 24×8 segments, fill opacity at most `0.10`, bright rim and analytic bands; about `160 ms` reveal and `180 ms` fade. Only a confirmed block creates the impact ripple/shards.
- **Expelliarmus:** only after core gates; two opposing gold/scarlet twisted ribbons and a `400–500 ms` `OFFENSE LOCKED` DOM rune. No flying virtual wand.

For every active projectile:

`visualServerNow = performance.now() + smoothedServerOffset`

`progress = clamp((visualServerNow - launchAtServerMs) / (impactAtServerMs - launchAtServerMs), 0, 1)`

A late launch starts at the correct progress. An already-resolved launch is suppressed. If the outcome is delayed, hold or end the travel neutrally; never infer a hit. Stable IDs deduplicate render, audio and device consumers separately.

The shield stops looking protective at its authoritative expiry; any remaining dissolve is visibly inactive. Restore active flights from snapshots, never completed explosions. Stop tracks, sockets, worklets and renderer loops on Leave; React remounts/Strict Mode must not duplicate them.

Normal quality is capped at a 1920×1080 drawing buffer, 20 draw calls, 15k triangles, 96 points and 12 geometries. Low quality is capped at 1280×720, 10 calls, 32 points, 6-node trails and a rim/ripple-only shield; 480p video and no ambient portal animation. Select a preset during setup and lock it for the round.

Audio is last. Use only original/licensed nonverbal cues, start SFX after local speech evidence qualifies so speakers do not poison ASR, and rerun nearby-voice tests with sound enabled. Provide mute, visible equivalents, no strobe, and reduced motion that preserves server timing with simpler glyphs/outlines.

## 4. Delivery stages and gates

Every stage has three outputs: **Build**, **Automated gate**, and **Your card** for the smallest necessary human check. These headings define dependency and acceptance, not current implementation status. Keep current commands, test counts, completed software slices and open physical gates in [docs/qa/input-rebuild.md](docs/qa/input-rebuild.md); keep hardware-specific evidence in [docs/qa/firmware-0.2.0.md](docs/qa/firmware-0.2.0.md). A stage is not complete because files exist or tests were proposed.

### Slice 0 — Isolated runtime shell

**Build:** isolated duel entry/runtime inside the existing Python/FastAPI/Pydantic stack, without deleting or starting the legacy serial, host-camera or AI-director path. Keep new game contracts separate from legacy button/mana rules and expose only the minimal player entry plus build-gated QA seams.

**Automated gate:** service bootstrap, route/schema errors, lifecycle cleanup and an ordinary browser smoke flow pass without legacy capture/device prompts or hardware mutation.

**Your card:** identify build/branch, open the minimal player shell, confirm no legacy UI or diagnostic navigation appears, and stop on unplanned network exposure or hardware mutation.

### Slice 1 — Protocol core, virtual endpoint and fake BLE

**Build:** contract codec/golden vectors, `WandTransport`, `WandClient`, `VirtualWandTransport`, fake-Web-Bluetooth lifecycle coverage and gated QA diagnostics for identity, raw motion/timing/loss and decoded feedback.

**Automated gate:** deterministic jab replay, feedback expiry, 600 ms outage/reconnect, reboot/generation and stale/duplicate fault coverage pass through production boundaries. Replay entry exists only behind the QA build flag or scripts.

**Your card:** use the explicit QA card only when diagnosing the boundary; never count it as physical input evidence or expose it in player navigation.

### Stage 2 — Local real-speech risk gate

**Build:** mono 16 kHz AudioContext request/verification, AudioWorklet timebase/endpointing with no initial application resampler, loopback speech proxy/helper, model warmup/health, exact vocabulary and privacy/lifecycle controls.

**Automated gate:** PCM rate/block/timestamp fixtures; VAD boundary cases; one-worker/no-queue concurrency; generation/late-result rejection; helper loopback/origin/body-limit/secret tests; known quiet/noisy clips without retaining audio.

**Your card:** on each intended laptop, complete quiet calibration, then at least five clean attempts per core incantation plus silence/wrong-word/background negatives. Record final latency and failures. Stop expansion if canonical words or the 1-second deadline are unreliable.

### Stage 3 — Classifier and mandatory fusion

**Build:** per-source/grip calibration, segmentation/features for jab/guard, optional sweep behind a gate, one-attempt fusion and input-health transitions.

**Automated gate:** seeded raw traces and speech fixtures cover correct pair, motion-only, speech-only, mismatches, interval edges, second onset, multiple gestures, duplicate evidence, delayed final, page hide and source/round changes.

**Your card:** use replay motion plus the real laptop mic for five Stupefy and five Protego positives; then speech-only, motion-only and mismatched negatives. It is explicitly not real physical-motion evidence.

### Stage 4 — Complete Stupefy/Protego vertical slice

**Build:** authenticated two-player sessions, referee/state writer, QA-only scripted second client through raw virtual inputs, server-timed projectiles, basic DOM HUD and minimal deterministic visual placeholders.

**Automated gate:** fake-clock combat/cooldowns, ordering/equal-time rules, simultaneous knockout, duplicate attempts/events, slow clients, connection abort and rematch; two browser contexts exercise real sockets and fusion without direct cast injection.

**Your card:** one visible client uses real local speech plus replay motion against a muted scripted ordinary client. Complete an attack, a block, an abort during an incoming attack and a clean rematch.

### Stage 5 — iPhone physical input

**Build:** approved phone-only public HTTPS/WSS profile with QR rendezvous, explicit matching-number approval and short-lived pairing; retain the optional trusted private-LAN profile. Raw motion enters beneath `VirtualWandTransport`, with minimal phone connection/health and decoded feedback. The route name and transport reuse are implementation details; the player source is `phone`, not `replay`. No public microphone/referee/dev routes; private-LAN evidence does not qualify hosted timing.

**Automated gate:** relay generation/auth/origin/size limits, opaque 20-byte values, bounded queues, old callbacks, lock/disconnect, cadence/loss reporting and no access to speech/game-admin routes.

**Your card:** after separately approving certificate/network setup, capture 60 seconds of still/movement metrics, six faces, five Stupefy and five Protego positives, then lock/app-switch/network-loss recovery. If setup or cadence is not viable, report the iPhone path blocked without weakening gates or hiding it behind replay.

### Stage 6 — Two humans, two laptops and video

**Build:** authenticated WebRTC perfect negotiation, 720p/30 video-only portal, complete setup/practice/Ready/result flow, two local speech helpers and one locked physical Badge/iPhone source per player.

**Automated gate:** negotiation glare, ICE ordering, stale generation, media stop, game/video independence, heartbeat loss and no audio track. Synthetic media remains labelled.

**Your card:** two people complete the core exchange; test each opponent saying each spell while the local player makes the matching gesture. Run ten nearby-speaker trials per shipped spell/player with zero accepted casts before proceeding.

### Stage 7 — Core Three.js polish and performance

**Build:** final HUD/glyphs, Stupefy and Protego treatments, server-time effects, fixed quality presets and resource instrumentation.

**Automated gate:** event deduplication, late snapshots/launches, delayed outcomes, reduced motion, context failure and deterministic screenshots/event timelines; no renderer resource growth over 100 effect cycles.

**Your card:** land at least 8 of 10 intentional defenses before impact. On the actual laptop/video setup, run ten minutes at at least 30 fps with p95 frame interval at most 33.3 ms, p99 at most 50 ms, no warmed frame at least 100 ms and no first-cast shader hitch.

### Stage 8 — Conditional Expelliarmus, portal and sound

**Build:** add sweep/disarm only if classification and core reliability pass; then restrained portal treatment and original/licensed SFX.

**Automated gate:** disarm/shield/cooldown and in-flight projectile rules, grayscale/readability check, resource caps and once-per-effect sound.

**Your card:** qualify the third gesture independently. Rerun microphone latency, speech-only, nearby-speaker and five-match checks with SFX enabled. Cut the spell before weakening input rules.

### Stage 9 — Windows physical-input qualification and demo freeze

**Build:** run the complete candidate on two intended Windows x64 Chrome laptops with each laptop's local ASR, real cameras/WebRTC and the frozen mechanics/quality preset/runbook. Exercise iPhone and badge paths independently; select qualified badges for the prize-track demo.

**Automated gate:** all previous QA replay/regression suites, Windows build/startup checks and held-out phone/badge trace regressions pass without source-specific gameplay/render branches.

**Your card:** two people complete five uninterrupted matches, recovery cases, nearby-speaker checks, performance gates and the judge rehearsal with the selected physical controllers. Record source-specific evidence; iPhone results never certify badge hardware, and badge claims require H0–H5.

### Parallel badge hardware qualification

Badge integration runs alongside platform delivery. Preserve the shared platform boundary and select `BleWandTransport` without rewriting fusion, combat or rendering.

- Execute contract H0–H4 with the first image: recovery artifacts, signed sensor truth, actual profile, Windows connected GATT, combined load, reconnect and battery evidence.
- Tune a separate badge/grip calibration from real traces; never import the phone profile.
- Execute H5 with two battery-powered badges: simultaneous traffic, physical feedback/recovery, 30-minute endurance and the full voice/gesture/false-cast/defense/five-match gates.
- Any need to rewrite spell rules, fusion, referee or render consumers is a boundary failure to review, not normal badge integration.

## 5. Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Recognition | At least 18/20 correct fused casts per player per shipped spell, with misses/confusions recorded |
| False casts | Zero accepts across speech-only, motion-only, mismatch, fidget, repeated transcript/packet, two minutes idle/conversation and explicit stale-generation cases |
| Cross-talk | Ten opponent-spoken trials per shipped spell/player while the local player performs the matching motion: zero accepts |
| Speech timing | Canonical final by `voiceEnd + 1000 ms`; missed deadlines are visible/unhealthy, never paired late |
| Cast responsiveness | From completion of the raw paired capture, `max(voiceEnd, motionEnd)`, to authoritative server acknowledgement aims at p95 ≤ `750 ms`; this includes browser endpointing, ASR, fusion and network time |
| Defense | At least 8/10 deliberate Protego attempts accepted before impact; flight time may be lengthened only with an explicit retest, never by backdating |
| iPhone input | Actual cadence/age/sync/ACK reported, 60-second qualification plus lock fault and positives, then a stable 10-minute human rehearsal before routine use |
| Combat | Deterministic cooldown, shield/disarm, equal-time and simultaneous-impact tests; both clients agree on state |
| Rendering | At least 30 fps on each demo laptop; p95 ≤33.3 ms, p99 ≤50 ms, no warmed ≥100 ms frame, stable resources across 100 cycles |
| Recovery | Wand/phone loss, ASR/helper loss, page hide, server loss and old callbacks abort/clear cleanly; no stale cast/effect/cue after Ready returns |
| Privacy | No raw audio/video, transcripts, credentials or personal IDs in default logs/traces; speech helper loopback-only and offline |
| Sustained demo | Five uninterrupted matches and clean rematches with no service restart; source/build versions and known limits recorded |
| Hardware | Contract H0–H5 evidence remains independent: recovery, sensor truth, Windows GATT, combined load, two-wand soak, feedback and endurance |

Do not infer current pass/fail status from this durable matrix. Use [current input evidence](docs/qa/input-rebuild.md) and the [firmware 0.2.x change record](docs/qa/firmware-0.2.0.md), and distinguish automated, iPhone, badge, microphone, Windows and two-human evidence.

## 6. Feedback and trace discipline

After each runnable stage, return one short card:

```text
Stage/build:
Laptop/browser/OS:
Motion source and device alias:
Speech source/model:
Failed step:
Expected:
Actual:
Visible counters/latencies/errors:
Did reconnect/Ready clear it?:
Optional trace export approved?: yes/no
```

Trace export is bounded and opt-in. Include build/protocol/profile/source labels, raw wand bytes or normalized motion samples, relative times, clock evidence, lifecycle transitions, evidence/event IDs, expected outcome and actual rejection/result. Omit raw microphone audio, transcripts, camera video, room/player tokens, helper secrets and personal phone IDs by default. Preserve failed timing/gaps; never smooth a bad trace into a pass.

## 7. Scope cuts and stop rules

- If Stupefy/Protego speech fails the first-hour real-laptop gate, stop effects expansion and fix/replace only the approved local ASR implementation. Do not add buttons, cloud ASR, fuzzy phonemes or motion-only casts.
- If built-in microphones fail cross-talk, change seating/separation or use close-talk microphones. Do not claim voice separation from software echo cancellation.
- If the iPhone path fails cadence/freshness or trusted-LAN setup, keep the badge path and independent work moving while reporting iPhone play blocked. Replay may diagnose software only; it is not a user-facing fallback. Do not weaken timing gates or switch platforms silently.
- If Expelliarmus is weak, cut it. The complete two-spell counter loop is the shippable core.
- If graphics miss budget, lock low quality: 480p video, 1280×720 buffer, fewer particles/trail nodes and no ambient portal. Do not change combat timing or hide feedback.
- If Protego is not defendable because the measured speech path is slower, explicitly lengthen projectile travel and rerun defense/performance tests. Never backdate a shield.
- If direct BLE fails, return contract measurements and jointly revise the interface. Do not add a second production transport opportunistically.
- Do not polish the portal, badge artwork or third spell while a prior stage's reliability gate is red.

## 8. Current checkpoint

The full plan is approved and is being executed procedurally across non-firmware work and physical-input integration. [docs/qa/input-rebuild.md](docs/qa/input-rebuild.md) is the single current checkpoint for implemented surfaces, exact checks and the next unmet gate; [docs/qa/firmware-0.2.0.md](docs/qa/firmware-0.2.0.md) owns badge-specific evidence. Continue from those reports rather than obsolete slice-order claims. Replay/fault tools remain scripts or build-gated QA only; the player experience remains the minimal Badge/iPhone setup, practice and duel. Preserve separate approval for certificate trust/network exposure, firmware flashing, commits and remote writes.
