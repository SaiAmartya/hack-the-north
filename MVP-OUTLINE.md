# Harry Potter Battle Simulator — Hackathon MVP

**Experience:** hold your hacker badge like a wand, say a spell, and perform its movement to duel a real opponent through a live-video portal.

**Target:** Hack the North 2026 — Best Badge Hack. **Revised:** September 19, 2026. **Repository baseline:** `6f712e6`. This is an implementation plan, not a claim that the proposed voice-and-motion multiplayer experience has been validated.

## 1. The product decision

The badge is the wand, not a gamepad. **Every spell requires both a spoken incantation and a deliberate badge movement.** The spoken name identifies the spell; the motion verifies that the player performed it. No spell selection, button arming, button release, or instant shield button.

Each player runs our Lua wand app on their badge, connects it by USB to their laptop, and opens the companion web app. The badge senses movement and gives immediate screen/LED feedback. The laptop hears the incantation, combines it with the badge signal, shows the opponent, and renders magic. One match server decides combat results.

This is a **badge app plus a computer companion**, not a browser game running inside the badge. Stock badge Lua does not expose a microphone, camera, or browser runtime; spoken-spell recognition runs on the computer. [Official Lua guide](badge-app-guide.md)

### What we ship

| Required | Scope |
| --- | --- |
| Physical wand input | Two badges, one connected to each laptop; automatic motion capture with no gameplay buttons |
| Incantation recognition | A tiny spell vocabulary through each player's computer/headset microphone; required for all casts |
| Combat | Stupefy, Protego, then Expelliarmus; health, cooldowns, scheduled impacts, win/draw and rematch |
| Multiplayer | One two-player room at a time; shared authoritative state; opponent live video |
| Presentation | Three.js projectile, shield and disruption effects over a video portal; readable health/cooldown HUD |
| Badge experience | Motion-sensitive LEDs, a concise gesture guide, movement-capture feedback |
| Setup | Browser-led connection, short calibration, practice and Ready/Rematch controls |

**First playable milestone:** Stupefy versus Protego with real speech and real badge motion on two laptops. **Target completed MVP:** add Expelliarmus and polish those three spells. If only two spells pass the tests, present an explicitly scoped two-spell duel rather than weakening the input contract.

**Only optional polish:** camera-based wrist/wand anchoring after the complete duel works. Fixed effect anchors are sufficient for the MVP. Camera analysis must not replace either required input.

Remove mana, extra spells, ultimate attacks, beam clashes, perfect-parry rules, loadouts, radio/referee gameplay, progression, custom firmware, and badge-side match-result messaging from this hackathon plan. Focus on one convincing loop: **say it, move the wand, see the magic, counter the opponent**.

## 2. Player journey: no gamepad controls

1. **Connect.** Launch the wand app on the badge. Open the companion in desktop Chrome/Edge, connect the serial device, and grant microphone/camera access. Show separate device, microphone, video and server status.
2. **Calibrate.** The browser asks for a still grip, then a few gentle examples of the jab, raised guard and sweep. Rehearse each incantation. Calibration and coaching happen on the laptop; no badge menu navigation is required during play.
3. **Join.** Create/join the two-player room and click Ready on the laptop. Both ready starts a shared countdown. Start listening before the countdown completes so the recognizer is actually available at round start.
4. **Duel.** Say “Stupefy!” while making a short jab. Say “Protego!” while raising the badge into a guard. Say “Expelliarmus!” while sweeping sideways. Nothing needs to be equipped first.
5. **Recover.** Let the badge settle briefly between movements. That natural reset separates casts; there is no press-to-arm action.
6. **Finish.** Both screens show the same result and a simple landed-spells/blocks recap. Click Rematch on the laptop.

**Badge buttons:** do not assign A/B, directions or Start any combat behavior. Preserve Home's normal exit and whatever stock launcher controls are needed to open the app. Ready, recalibration and rematch belong to browser setup, not physical spell casting. A development-only event simulator may exist, visibly labelled and disabled in the real duel; it is not an alternate player input mode.

Use a secure grip, a data cable with slack, and small wrist/forearm movements. No throwing the badge, striking objects, or swinging it by the lanyard. Follow the official power/USB instructions. [Badge manual](https://badge.hackthenorth.com/manual), [badge safety rules](https://badge.hackthenorth.com/rules)

## 3. Three spells and a small combat engine

All numbers below are starting proposals to tune on physical devices. The game effects are adaptations, not claims of exact fictional canon. [Official spell background](https://www.harrypotter.com/features/the-most-important-spells-harry-taught-da)

| Build priority | Spell and required input | Initial effect | Visual |
| --- | --- | --- | --- |
| **1 — attack** | **Stupefy:** say the name + short jab and settle | 20 damage; 2-second cooldown; initially 2-second projectile travel | Crimson bolt with a spark trail |
| **2 — defense** | **Protego:** say the name + raise badge into a brief held guard | Shield lasts 1.2 seconds, blocks one Stupefy, then breaks; 3-second cooldown | Cyan curved shield with an impact ripple |
| **3 — disruption** | **Expelliarmus:** say the name + lateral sweep and settle | 10 damage and 1-second offensive lockout if unshielded; shield breaks and prevents both effects; 6-second cooldown; initially 2.2-second travel | Red-gold ribbon and a broken-wand status rune |

### Shared rules

- One 60-second round; 100 health each. Zero health loses. At timeout, higher health wins; equal health is a draw. Use the same rules for practice matches and judging.
- No mana system. Cooldowns supply the resource constraint. The HUD shows which spells are available.
- Offense shares a short 600 ms global recovery as well as spell cooldowns. Protego is not blocked by offensive recovery or disarm, but still requires its own voice, movement and cooldown checks.
- All attacks target the opponent. The camera is for presence and effects, not physical hit detection. Leaning out of frame is not a dodge.
- An accepted attack creates a projectile with a future impact time. Damage is resolved at impact against the current shield/status, not immediately on recognition.
- Protego becomes active only when the server accepts the complete voice-and-motion cast. Do not secretly grant a button shield, pre-activate from an unfinished word, or backdate it after an impact.
- Initial 2–2.2-second flight times deliberately accommodate hearing the warning, speaking, gesturing, recognition and network delay. Measure this entire path and lengthen travel if necessary. A visibly defendable duel matters more than artificially fast projectiles.
- Failed recognition or server rejection causes no damage and starts no spell cooldown. Explain the reason briefly on the laptop.
- Disarm blocks new offensive casts only. Already launched projectiles remain. Resolve impacts due in the same server step as a batch; simultaneous knockouts are a draw.
- Losing badge input, speech availability or a player's game connection aborts the round, clears pending inputs/projectiles and awards no winner. Reconnect and ready for a fresh round. Video-only loss is reported separately; stop and restart the live demo if it cannot be restored.

## 4. Recognizing spells without buttons

**Recognition contract: fresh incantation + compatible deliberate motion = one cast.** Neither input alone is sufficient. No LLM or trained gesture model is needed in the critical path.

### Motion: continuous sensing, bounded gestures

The documented accelerometer is cached at 50 Hz and returns three-axis acceleration, not 3D position. There is no documented gyro. Rotation changes gravity's contribution, so arbitrary wand-rune reconstruction is out of scope. [Sensor API](badge-app-guide.md)

Use the Lua app to read at a measured cadence, initially around 25 Hz, with a tiny bounded buffer. Automatically segment movement using a still baseline, activity threshold, short capture window and settling hysteresis. A first candidate configuration is 200 ms of rest, a 150–900 ms movement, then 150 ms of settling; guard recognition can complete after a short stable raised pose. These are hypotheses, not device-proven thresholds. Require a fresh rest-to-motion transition for the next candidate.

Emit compact movement candidates with an increasing ID, device start/end timestamps, duration, coarse jab/sweep/guard evidence and quality flags. Include a lightweight heartbeat with device uptime so the browser can reject a stalled stream. Keep feature evidence even when the local label is uncertain; the spoken word tells the browser which expected motion to verify. Send raw samples only in a bounded calibration/diagnostic mode if needed.

Calibrate idle noise, grip orientation and safe amplitudes per player in the browser. The badge's broad segmentation can be fixed initially; player-specific acceptance thresholds live on the computer, avoiding a new host-to-badge configuration protocol. Use `badge.sys.ms()` and periodic device timestamps to estimate stream timing; do not directly compare unsynchronized badge and browser clocks. Reject buffered/stale data after a stall.

The three motions should be deliberately broad. A jab needs an impulse and settling, not accurate forward distance. A sweep needs a lateral burst, not a reconstructed arc. A guard needs a new raising movement followed by a held orientation; holding the same pose cannot repeatedly recast it. If separation is weak, tune those patterns and cut the third spell before adding a machine-learning project.

### Speech: available throughout a live duel, narrowly interpreted

The laptop recognizer listens during explicit practice/countdown/play only, after permission and a browser interaction. It does not wait for a badge button. Restrict application acceptance to the shipped incantations and a small tested list of transcription aliases. Do not accept unrelated partial words or infer spells from shouting volume.

Start with browser `SpeechRecognition` behind a small adapter. It has limited browser support, may depend on an external service, and its historical grammar setting does not enforce a vocabulary. Test the actual laptop/browser/network immediately; filter recognized results ourselves. Identify any service receiving audio. Never promise offline operation or assume setting `continuous` guarantees uninterrupted listening. [SpeechRecognition documentation](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

Final recognition is the safe initial acceptance point; interim text may preview a rune but must not independently fire a spell. Track recognizer termination/errors and expose a visible listening state. If the first spike fails, test one available low-latency local recognizer with the same interface, time-boxed. If neither works, voice-and-motion casting remains blocked—not silently replaced by button or gesture-only gameplay.

### Pair evidence once, then expire it

The browser owns fusion. Keep one pending attempt per player, using a short rolling gesture buffer and recognizer capture IDs/timing. Accept voice before, during or just after the movement so the interaction feels natural; do not require the recognizer's result to arrive before motion begins.

1. Associate speech with its capture interval, not merely the time its text result arrives. Use speech-activity events or a small local voice-activity detector for capture timing, with recognizer session/result IDs. Repeated partial/final callbacks cannot become new utterances. If the API cannot identify a capture reliably, allow only one outstanding utterance and reject ambiguous associations.
2. Initially require speech and movement to belong to the same roughly 2-second attempt, with their end times within about 900 ms. Permit at most 1 second of delayed transcription after the attempt's capture window ends. Tune these bounds from timestamps; discard older evidence rather than pairing it with a later gesture.
3. The recognized spell chooses which movement evidence must pass. “Stupefy” with guard-only evidence is rejected; a spoken name does not merely select a spell for a later unrelated movement.
4. When both inputs pass, consume both IDs and send exactly one session/round-bound cast request. Clear evidence on rejection, timeout, recognizer restart, round change, disconnect or page suspension. Require fresh input on return.
5. The server validates spell, player, round, cooldown and duplicates before accepting. Local motion lights can respond immediately, but damage and the full launched spell wait for acceptance.

| What happens | Result |
| --- | --- |
| Correct incantation and matching fresh gesture | One cast request |
| Movement without an incantation | No cast |
| Speech without a deliberate movement | No cast |
| Wrong motion, ambiguous speech or expired evidence | No cast; short coaching cue |
| Repeated transcript or serial packet | No second cast |
| Camera tracking missing | Casting still works; effects use fixed anchors |
| Microphone/recognizer unavailable | Do not ready; abort an active round and recover |

**Venue noise is a first-hour risk.** Use close microphones/headsets; headphones prevent opponent audio and game sounds feeding the recognizer. Default opponent media to video-only for the co-located demo. Avoid spoken spell names in game sound effects. Neither echo cancellation nor this fusion rule proves speaker identity: explicitly test an opponent saying a spell while the local player moves. If nearby voices still trigger casts, change mic placement/separation before claiming reliability.

## 5. Badge integration and direct computer access

The official platform provides the useful core already: accelerometer, 320×240 display, six RGB LEDs, stock Lua lifecycle, monotonic timestamps and tagged serial logs. Use these well; leave unrelated peripherals disabled. Foreground Lua has a nominal 20 ms tick, a default 48 KiB heap, and firmware-dependent callback budgets. Reuse widgets and avoid blocking work or verbose per-tick logging. `wake_lock=1` prevents ordinary sleep while open, not Home exit. [Official hardware](https://badge.hackthenorth.com/), [developer guide](badge-app-guide.md)

### Installation versus gameplay

- Install our Lua wand app with the official IDE first. This uploads an application, not replacement firmware. [Official IDE](https://badge.hackthenorth.com/ide/)
- Disconnect the IDE's serial session. The game browser then opens the same device through Web Serial. Only one application may own the serial port at a time; a person selects the device in the permission picker. [Web Serial](https://developer.chrome.com/docs/capabilities/serial)
- The public IDE uses 115200 baud and a console file-transfer protocol. A CLI uploader is possible, but building one is unnecessary for this MVP. The IDE does **not** need to stay open or proxy gameplay. [Public serial/upload implementation](https://badge.hackthenorth.com/ide/app.js?v=single-file-app-20260916)
- The Lua app writes movement/heartbeat lines with `badge.sys.log()`. The companion parses only our app's versioned message prefix, validates fields and handles partial serial lines.
- Read-only local device enumeration and serial diagnostics can help an agent investigate a plugged-in badge. A person still connects/powers it, selects the device, launches the app and performs test gestures. Physical operation is not established by source inspection.

**Important boundary:** stock Lua has no documented serial receive callback. The badge cannot hear the laptop's recognized word or know server health/cooldowns in this design. Do not build a flash-file mailbox or custom firmware to work around that during the hackathon. The laptop owns confirmed spell identity and match feedback; the badge owns immediate movement feedback.

### What appears on the badge

| Local state | Screen | LEDs |
| --- | --- | --- |
| Idle | Three small spell/movement cues; “Say the spell and move” | Subtle neutral glow |
| Movement begins | Motion activity indicator | Brighten with a bounded activity level |
| Candidate captured | Brief gesture silhouette or “Movement captured” | Short pulse, optionally coloured by local gesture hypothesis |
| Too noisy/continuous | “Settle, then try again” | Soft amber cue |

The display is an always-available wand guide, not an equipped-spell menu. A locally coloured pulse means a movement hypothesis, **not** a spoken spell or server-confirmed cast. Stage all six LEDs then call `show()` at a measured bounded cadence, initially no more than about 20 Hz. No false hit/health/victory claims on the badge. Show those on the laptop.

## 6. Visual experience and assets, in build order

Keep the opponent large inside an enchanted mirror, with a small self-preview. Opponent health sits above the portal, own health below, and three cooldown indicators remain readable. During training, show “heard spell” and “detected movement”; hide diagnostics during the duel.

| Priority | Asset | Minimal approach |
| --- | --- | --- |
| 1 | Three spell glyphs, gesture cues, health/cooldown/result UI | Original line art reused on badge and browser; DOM/CSS HUD |
| 2 | Stupefy | Emissive bolt, short trail, pooled impact sparks |
| 3 | Protego | Transparent curved surface, glowing rim, impact ripple |
| 4 | Expelliarmus | Reuse projectile plumbing; twisting gold/red ribbon and brief status rune |
| 5 | Portal and sound | Procedural frame; restrained glow; original/licensed incoming, cast, block, hit and result sounds |

Use one transparent Three.js canvas over the opponent's video element. Start with fixed spell origins. On the attacker screen, the bolt travels toward the opponent; on the defender screen, it approaches the camera and strikes the foreground shield. Both animations refer to the same server projectile and impact time. A video-textured mesh and hand tracking are optional polish, not architectural requirements. [Three.js video-texture option](https://threejs.org/docs/pages/VideoTexture.html)

The showcase is a spoken Protego plus raised badge producing a shield that visibly catches a real opponent's Stupefy. Build that moment before decorative environments. Cap particles and pixel ratio, preload audio, and preserve at least 30 fps on both demo laptops; aim for 60 only after input is stable.

## 7. High-level architecture

```text
Badge A -- USB movement --> Browser A <-- local microphone/camera
                            | voice + movement -> cast request
                            |
                      Python match server
                      players, cooldowns, health,
                      projectiles, results
                            |
Badge B -- USB movement --> Browser B <-- local microphone/camera

Browsers: React/TypeScript + Three.js
Game inputs/state/signalling: WebSocket
Opponent video: WebRTC, separate from game messages
```

| Layer | Decision |
| --- | --- |
| Badge | One stock-Lua wand app on both badges; automatic segmentation and USB events |
| Frontend | Existing React + TypeScript + Vite; Web Serial; microphone adapter; local fusion; Three.js |
| Referee | Existing Python + FastAPI + Pydantic patterns; one two-player room; deterministic rules |
| Game transport | Session-bound WebSocket inputs/events/snapshots, around 20 Hz server updates |
| Media | Browser camera capture and WebRTC opponent video; audio chat omitted from the demo |
| Storage | In-memory match state and browser-local calibration; no accounts or database |

The server assigns player slots and opaque session tokens; it must not trust the badge's old self-declared P1/P2 labels or client-proposed damage. Input IDs are bound to connection/session and round. Local recognition is still a prototype trust boundary, not an anti-cheat system.

Use server time for impact/cooldown deadlines. Clients estimate clock offset for animation but cannot backdate cast requests. Bounded per-client outbound queues prevent one slow browser stalling combat. Reconnect starts a fresh round; no persistence/resumption system is required.

**First demo network:** both laptops on a controlled hotspot/LAN, each serving its frontend on localhost; a session-protected Python server on laptop A's private interface, with explicit allowed origins; tested direct WebRTC connectivity. Verify the browser's game-socket/private-network permissions early and use trusted TLS if required. Do not simply expose the existing unauthenticated host. General internet hosting and a TURN relay are outside the minimum demo and need separate deployment approval.

Camera/microphone and Web Serial need appropriate secure contexts. A frontend served over another machine's plain HTTP address is not equivalent to localhost. WebRTC still needs signalling; STUN is not a guaranteed relay. [Camera requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)

No recording by default. Show when the microphone is listening, disclose external speech processing, and stop media tracks/recognition on leave. Limit diagnostics to short opt-in captures; do not retain raw voice/video for match history.

## 8. Refactor the current project around this interaction

The existing Phantom Arena uses local radio badges, a gateway, a Python referee and a passive browser viewer. Reuse useful infrastructure, not its control model.

| Existing source | Revision |
| --- | --- |
| [badges/phantom_player.lua](badges/phantom_player.lua) | Replace spell-selection/button mappings and local mana/cooldown authority with automatic motion capture, gesture feedback and direct serial events; remove dependency on successful radio startup |
| [game.py](apps/host/phantom_host/game.py) and [contracts.py](apps/host/phantom_host/contracts.py) | Retain deterministic/testable patterns; implement the three-spell rules, scheduled impacts, per-player cooldowns and round-bound inputs |
| [main.py](apps/host/phantom_host/main.py) and [broadcaster.py](apps/host/phantom_host/broadcaster.py) | Add real player input/session handling and bounded state delivery; current sockets only serve viewers |
| [App.tsx](apps/web/src/App.tsx) and [ArenaStage.tsx](apps/web/src/components/ArenaStage.tsx) | Retain useful connection/HUD structure; add USB, mandatory speech fusion, setup/practice and the Three.js stage |
| [vision.py](apps/host/phantom_host/vision.py) | Remove host-camera/base64-JPEG snapshots from the new mode; browsers own camera capture and WebRTC |
| [badge_monitor.py](tools/badge_monitor.py) | Reuse for serial bring-up/raw inspection; its existing gateway-protocol diagnostics need adaptation for the new movement protocol |
| [apps/host/tests](apps/host/tests/) and [fake_gateway.py](tools/fake_gateway.py) | Reuse test patterns; add explicit fusion fixtures and deterministic combat cases; keep simulation clearly labelled |

Leave unrelated legacy files intact while the new path is built, but do not add gateway/chaos compatibility work to the MVP. The monitor is not a per-laptop serial-to-WebSocket bridge, and the old radio game does not demonstrate the new voice-and-motion experience.

The latest [hardware report](docs/hardware-verification.md) records real ESP32-C3/accelerometer identification, USB enumeration, installed firmware, and BLE memory failures that prompted the radio-startup fixes. Reuse those observations; leaving radio disabled in our direct-USB mode also avoids that additional memory demand. They do not yet establish the proposed voice-and-motion duel.

The current repo does not yet implement browser speech fusion, WebRTC player video or Three.js. This revision changes only the plan, not executable code. Existing bring-up results, synthetic tests and source inspection are not evidence that the new end-to-end experience works.

## 9. Build order and hard scope gates

Recalculate remaining hackathon time when work starts; do not treat the estimates below as a fresh full-day budget. Owners can work in parallel against a small shared contract: movement candidate, speech evidence, cast request, accepted/rejected action, projectile, snapshot and result.

| Order | Milestone | Gate before expanding |
| --- | --- | --- |
| **First 60–90 minutes** | Real badge movement reaches browser; recognizer hears spell names; test two-laptop network/video | Jab + “Stupefy” emits exactly one fused event; no cast from either alone. Confirm voice latency and nearby-speaker interference |
| **Next 2–3 hours** | Two-spell vertical slice | Two physical players attack and defend using voice + movement; both screens agree on health; round and rematch work |
| **Next 1–2 hours** | Expelliarmus and reliable lifecycle | Third gesture passes; disruption, cooldown rejection, abort and fresh-round recovery work |
| **Next 2–3 hours** | Badge/portal polish | Clear movement LEDs, concise badge guide, three visual effects, sound and stable video |
| **All remaining time** | Physical testing, repairs and demo | Five clean matches; freeze mechanics; finish submission and rehearse |

Suggested ownership: **badge/serial**, **speech/fusion**, **server/network/video**, **UI/Three.js**. Combine roles if necessary. Do not let effects work delay the recognition gate.

If speech latency is high, lengthen projectile warning/travel and simplify recognizer behavior; do not make speech optional. If the third gesture is weak, ship two spells. If camera tracking is weak, use fixed anchors. If core badge/speech input remains unreliable, state that limitation and demonstrate labelled training evidence—do not claim the specified MVP is complete.

## 10. Acceptance tests that define a working demo

These are proposed gates, not results already obtained.

| Test | Target |
| --- | --- |
| End-to-end recognition | Each player performs 20 attempts per shipped spell; initially at least 18/20 correct fused casts, with confusion/rejection counts recorded |
| False casts | Zero accepted casts in explicit speech-only, movement-only, mismatched, idle/fidget and nearby-opponent-speech trials; include at least two minutes of idle/conversation |
| Temporal safety | Duplicate transcripts/packets, delayed final results, back-to-back attempts, a held guard, reconnect and old-round input never cause a second or stale cast |
| Responsiveness | Local motion cue aims below 100 ms; complete voice+motion capture to server acknowledgement aims below 750 ms p95. Measure actual values and the full incoming-warning-to-accepted-Protego path |
| Defendability | At least 8/10 deliberate defenses land before impact in a rehearsed attack/guard test; tune warning/travel time without accepting shields retroactively |
| Combat | Server rejects cooldown violations; shield/disarm rules and simultaneous impacts are deterministic; both views agree on health |
| Recovery | Unplug badge, stop recognizer, close browser or lose server; abort clearly, clear all evidence, and restart cleanly |
| Sustained demo | Two people finish five matches with clean rematches; no service restart; at least 30 fps on each laptop |

Checks still required for the demo devices: confirm each badge's installed firmware, USB logging while the new app is foreground, accelerometer axes/noise for the chosen grip, serial overhead, microphone quality and recognizer behavior under venue noise. Passing mocked events cannot substitute for these measurements.

## 11. Judging and delivery

### A 90-second demonstration

1. **0–15 s:** show the badge and both live-video portals: “This is our wand. No combat buttons—every spell needs the word and the movement.”
2. **15–30 s:** demonstrate Stupefy. Briefly show that saying it without moving does not cast.
3. **30–45 s:** opponent says Protego and raises their badge; the incoming bolt hits the shield.
4. **45–70 s:** use Expelliarmus if shipped, exchange spells, and let the 60-second round end by knockout or timeout.
5. **70–90 s:** show the shared result, rematch control, and the two evidence indicators; explain what runs on the badge versus the laptop.

The published event rules separate initial prize selection from final project editing: initial submission, team/badge IDs and selected sponsor prizes by **September 19, 2:00 PM EDT**; final editing by **September 20, 8:00 AM EDT**. Verify the saved Best Badge Hack selection immediately. If the earlier cutoff has passed, confirm eligibility with organizers rather than assuming final editing restores it. This plan does not submit anything for the team. [Event rules](https://hackthenorth2026.devpost.com/rules), [prize listing](https://hackthenorth2026.devpost.com/)

Keep the story focused on the badge's meaningful contribution: it senses the wand motion, gives physical feedback and teaches the gestures. The laptop supplies hearing, connection and spectacle. Success is a reliable spoken-and-gestured duel, not using every peripheral.

## 12. First implementation checkpoint

**A player says “Stupefy” and jabs their real badge; a remote player sees the incoming spell, says “Protego” and raises their real badge; the shield blocks before impact, and both computers show the same health. No gameplay button is pressed.**

Everything in the build should either prove that interaction, make it reliable, or make it look and feel magical.
