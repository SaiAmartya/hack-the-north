# Wandduel platform checkpoint

Updated September 19, 2026. Software checkpoint; physical end-to-end acceptance is pending.

## Latest setup fixes and current blocker

- The QR was real but a generic setup SVG stroke thickened every module into a solid
  block. Glyph styling now excludes `.phone-qr`. Desktop and narrow screenshots decode
  to the expected URL with an independent barcode decoder; browser tests check the style.
- Motion calibration now keeps microphone capture/noise/continuity checks active but
  suppresses spell transcription. Recognition resumes only after the existing 200 ms
  quiet boundary, preventing calibration conversation from becoming a practice cast.
  Genuine capture/helper failures still surface. Human gesture accuracy is not established.
- Exact upstream firmware `6a50929` replaced the local firmware fixes at Sai's request.
  The application-only flash and readback passed; it boots, sees the sensor and passes
  its built-in self-test. **Real BLE OPEN acknowledgement times out**, so badge play is
  currently blocked. See [the firmware review/measurement](firmware-main-6a50929.md).
  Do not bypass the handshake or assume earlier 0.1.1/0.1.2 passes apply.
- The iPhone path remains independent and uses the public HTTPS QR service without
  installing a certificate. Physical phone, speech accuracy and multiplayer QA remain required.

Latest reported automated evidence: 253 host tests passed with four
legacy/environment skips, 16 tool tests passed (seven backup and nine launcher), 109 frontend unit tests
passed, and all 21 full Playwright tests passed. The browser run includes real-Chrome
startup-loss checks and more than two seconds of production-path fake-microphone
capture, with verified track/context cleanup. The final frontend typecheck and stable
production build passed. The phone Worker separately passed 23 tests and typecheck.
The calibration recognition gate received an independent read-only review with no
remaining defects found. These software checks do not qualify physical inputs.

The final stable stack was restarted with the approved hosted-phone profile. The
actual frontend speech proxy reported `ready/warm/workerAvailable=true` with the
pinned local `base.en` model; the referee reported `multiplayerReady=true` and
`allowReplay=false`. The served asset is `index-tiw-GQSK.js` (no HMR). Physical
microphone/phone retries remain distinct from these health checks.

After restart, `node tools/qa_public_phone.mjs
https://wandduel-phone.saiamartya19.workers.dev` passed public-route isolation, pairing,
matching-number approval, byte-protocol handshake, 10 seconds at 50.0 Hz with 100%
delivery, and disconnect teardown. This used injected browser motion over the real
HTTPS/WSS service, not a physical iPhone or real speech. No public redeployment was needed.

## Implemented

- Minimal game UI: choose Badge or iPhone, connect, calibrate, practise, Ready,
  countdown, duel, result and rematch. No player-facing replay or cast buttons.
- Shared raw-data protocol, clock synchronization, stale-input rejection,
  accelerometer-only gesture calibration and single-use motion/voice fusion.
- Local microphone capture and warmed `faster-whisper base.en` CPU INT8 helper.
  No cloud speech, peer audio, saved microphone clips or default transcript logs.
- One authoritative two-player Python referee: Stupefy, Protego, health,
  cooldowns, shield/impact ordering, timeout/draw, disconnect abort and fresh rematch.
- Video-only peer connection; original Three.js projectile/shield/ripple effects,
  fixed geometry pools, minimal DOM HUD and low/reduced-motion presentation.
- iPhone Safari motion endpoint and short-lived pairing, through the same byte-level
  interface as BLE. Foreground loss clears input; outbound decoded commands drive feedback.
- Script-only deterministic input, real-socket duel regressions, phone-relay
  regressions and renderer/video checks. These are **not** physical-input qualification.

Expelliarmus is implemented in the referee behind a disabled feature flag; the
shipped interaction remains the two-spell core until its physical tests pass.
Nonverbal audio polish, third-spell coaching/graphics and target-device qualification
are not represented as complete.

## Run and stop

From the repository root, with the documented Python 3.11 environment, web dependencies
and local speech model installed:

```sh
python3 tools/run_game.py
```

By default the launcher creates a temporary production-build snapshot and serves it
with Vite preview. A running demo therefore does not change when the source tree does.
Use `python3 tools/run_game.py --dev` only for an explicit HMR development session.
The launcher refuses occupied ports without stopping their owners and prints
`Game ready` only after the frontend, selected referee and warmed local speech
helper pass bounded health checks. Failure stops only this launcher's children.
Authenticated health probes use direct connections, never environment proxies or
redirects, so the per-launch speech secret cannot be forwarded elsewhere.
Open `http://127.0.0.1:5173` in **Chrome**, not Safari or an embedded preview for BLE.
The default stack stays on loopback. Ctrl+C stops only the processes it started.
The local speech model is provisioned on this Mac; the Windows model/dependencies
must be installed separately. No runtime download is used.

The badge needs no specialized IDE or USB bridge during play. Keep the badge IDE
and Bluetooth test scripts disconnected before clicking **Connect badge**.

### Two laptops: badge input

Requires separate approval to expose laptop A's referee on the chosen private LAN:

```sh
# Laptop A
python3 tools/run_game.py --referee-bind <A-private-IP>
# Laptop B
python3 tools/run_game.py --referee http://<A-private-IP>:8000
```

Both players open their own localhost frontend. Speech always goes to that player's
local helper. `--badge-only` rejects phone/replay input for hardware qualification.
No public tunnel, wildcard CORS or blanket firewall exception is needed or authorized.

### Optional iPhone input

Certificate creation/installation/trust and LAN exposure require separate approval.
Given a trusted certificate for each selected frontend's exact private IP:

```sh
# One laptop and phone (local referee)
python3 tools/run_game.py --phone-host <A-private-IP> --cert <cert> --key <key>
# Two laptops with phones: laptop A
python3 tools/run_game.py --phone-host <A-private-IP> --cert <A-cert> --key <A-key> --serve-referee --allow-origin https://<B-private-IP>:5173
# Laptop B
python3 tools/run_game.py --phone-host <B-private-IP> --cert <B-cert> --key <B-key> --referee http://<A-private-IP>:8000
```

Each laptop opens its own `https://<its-private-IP>:5173`. Choose **Connect iPhone**;
on that player's phone open `/phone` at the same origin, enter the pairing code and
tap to allow motion. Keep Safari unlocked, foregrounded and portrait. No phone
microphone is requested. CA/server private keys stay outside Git and are never
transferred to the phone. Do not bypass certificate warnings or browser security.

### Historical private-LAN phone setup

This is retained as prior evidence, not the currently running profile. Sai approved
local HTTPS setup and separately approved trusting the dedicated CA
in the Mac user's login keychain. `mkcert` 1.4.4 was installed; certificate and
private keys are outside Git in `~/.local/share/wandduel/https/`. Mac certificate
verification succeeded for **10.37.104.90**. The frontend bound only that private
address on port 5173 in this historical setup; referee and speech remained on
`127.0.0.1:8000/8001`.

- Laptop: `https://10.37.104.90:5173/`.
- Phone: `https://10.37.104.90:5173/phone` (same Wi-Fi/network).
- Public iPhone-install certificate: `~/.local/share/wandduel/https/wandduel-ca.cer`.
- Public CA SHA-256 fingerprint:
  `81:F4:4D:77:A2:4B:28:DA:FB:D2:D0:D9:97:77:4D:E7:F6:36:59:CB:34:0C:93:E3:9F:3E:EC:B8:33:11:2F:09`.

The real HTTPS browser UI on the Mac loaded without a certificate interstitial; clicking
Connect iPhone created a pairing code, Leave cleaned up, and `/phone` displayed its
code/Connect form. The HTTPS speech proxy reported the local model warm and ready.
Sai's physical iPhone reached that historical address but reported a
certificate/security warning:
network reachability exists, but iPhone trust is not established. Do not bypass it.
This did not qualify physical Safari sensor access, cadence or timing.
The scripted HTTPS rerun covers delayed first motion, exactly one connection despite
repeat submission, three-second no-motion timeout, denied permission and pagehide
during a pending permission prompt. It also completes the real relay's INFO,
OPEN/five SYNCs, both subscriptions, raw samples and decoded feedback. Motion in
these browser tests is injected, not measured from a physical phone.
Those private-IP URLs are not the current live frontend. The live laptop game is back
on `http://127.0.0.1:5173`, which never refers to this Mac when opened on a phone.
The public hosted profile below does not require installing or manually trusting a CA.

Only the public `.cer` may be transferred. Trusting the root permits certificates
signed by that CA until trust is removed. Remove the Wandduel profile/trust from
iPhone Settings and the matching CA from the Mac login keychain when no longer
needed; do not delete unrelated authorities. Keep recovery backups separate.

### Hosted phone onboarding: deployed, qualification in progress

The phone-only service is deployed at
`https://wandduel-phone.saiamartya19.workers.dev` in Sai's personal Cloudflare
account. The unrelated `at` account was not altered. Credentials and the enrollment
secret remain outside Git. The deployed health check passed. Its 23 Worker tests
include a 500-frame stream with 60 ms acknowledgements and verify zero per-frame
storage writes.

```sh
python3 tools/run_game.py --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file <private-enrollment-file>
```

The first hosted smoke attempt timed out after 15 seconds before **Enable microphone**,
without capturing a cause. Two subsequent real HTTPS/WSS runs completed the actual
QR/approval UI, INFO, OPEN, five SYNCs, both subscriptions, 10 seconds of motion at
50.0 Hz and 49.9 Hz with 100% delivery, and Leave/disconnect. Motion was injected in
the browser; neither a physical iPhone nor its sensors or microphone were exercised.
Treat the first timeout as an unresolved latency/stability qualification item, not as
evidence that physical phone, speech or end-to-end gameplay has passed.

The selected no-certificate-install experience hosts a small phone controller
at an ordinary publicly trusted HTTPS origin, with QR rendezvous plus explicit
laptop approval and an authenticated, short-lived, rate-limited phone relay.
Both devices connect outbound; no inbound laptop port or local CA trust is needed.
Keep the existing raw 20-byte boundary, deadlines and calibration. This is a new
public service whose deployment was approved; measured venue latency remains required.
Safari still requires a user tap to allow motion; normal HTTPS removes certificate
setup, not sensor permission. [Motion permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static).

Start with WSS to reuse the tested channel. If strictly peer-to-peer motion is
required, a WebRTC data channel is an alternative, but still needs authenticated
signalling and a deliberate connectivity/TURN policy; it is not a no-server
Bluetooth replacement. [WebRTC connection setup](https://webrtc.org/getting-started/peer-connections).

**Never tunnel the whole Vite server.** That would expose development/source routes
and could defeat the speech proxy's raw-peer locality assumption when a tunnel
forwards public traffic from loopback. A public deployment must isolate only the
controller and its narrowly authorized pairing/device channel; microphone, game
administration and QA routes remain private. A quick tunnel is a development aid,
not a production deployment. [Cloudflare's guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Repeatable software checks

### Fundamentals review after microphone QA failure

Keep the existing boundaries: device bytes → shared motion/fusion; laptop PCM →
local speech helper; fused attempts → authoritative referee; referee events →
graphics/feedback. Neither phone hosting nor speech should acquire combat authority.
The observed blockers were lifecycle/bootstrap defects, not evidence that these
boundaries need replacement. Do not add cloud ASR, direct phone casts or another
production transport as a workaround.

Audio startup is an explicit sequence: acquire the stream, suspend the context,
assemble the capture graph, resume, establish one immutable audio-to-browser clock
mapping, then deliver qualified frames. The capture format is verified at the
actual Worklet PCM boundary (mono, 16 kHz); hardware track metadata is not a claim
about those frames. This uses the Web Audio graph's explicit channel conversion
and frame clock, not application resampling or relabelled samples. See the
[Web Audio specification](https://www.w3.org/TR/webaudio/).

Human QA uses a frozen frontend build and all three owned local services. Automated
tests use separate ports and must not replace that frontend or referee. Service
readiness is distinct from physical microphone, sensor, transcription-latency and
two-player qualification; those measurements remain required before demo readiness.

The automated browser harness uses an isolated frontend on `127.0.0.1:15173` and
referee on `127.0.0.1:18000`; the live game on `5173`/`8000` does not need to stop:

```sh
python3 tools/qa_game.py
```

This runs host tests, firmware backup-tool tests, frontend typechecking, unit tests,
production build and Playwright. Test-only routes are gated by QA configuration;
the normal app never offers simulated input. The command does not flash devices,
capture real microphones, change trust settings or expose the LAN.

The first microphone fix ignored empty startup AudioWorklet blocks, but Sai's
physical retry still failed with `Audio frame continuity was lost`. A new Chromium
test of the **production zero-output capture graph** reproduced a valid block at
frame 0 followed by frame 256, skipping the intervening 128-frame quantum.
Capture now requires two consecutive valid startup blocks before delivering PCM;
isolated startup blocks are discarded, never filled in or retimestamped. The
existing two-second first-delivery watchdog bounds startup. Once established,
empty input or nonempty frame gaps still fault. Independent exact-reproduction
tests verify original frame numbers and PCM survive this qualification.
Separate unit tests cover resource cleanup after worklet loading and context-resume
failures. The stable stack's speech proxy reports the local model warmed and
available. Physical microphone/calibration retry remains pending; these checks do
not qualify acoustic recognition or complete gameplay.

## Hardware evidence collected on this Mac

**Historical evidence below:** the current replacement is upstream `6a50929`, not
0.1.1/0.1.2. Its current OPEN failure and measured flash are recorded above and in the
[new firmware report](firmware-main-6a50929.md). Do not read these older passes as a
qualification of the installed image.

The attached ESP32-C3 badge's original 4 MiB flash was read twice independently.
The two reads were byte-identical, with SHA-256
`fc5d6fe32a3ad29dc66241d6d0ef35e76e4959687706b901e1525b6a6e4cbb8a`.
Both backups and a verified identity-bound manifest are private, outside Git, under
`~/.local/share/wandduel/badge-backups/288485d6b600-20260919/`.
Stock restoration has **not** been physically exercised.

With Sai's explicit permission, the four discrete firmware 0.1.1 artifacts were
flashed and esptool verified each write. The erased ranges excluded NVS at `0x9000`,
PHY data at `0xD000`, and LittleFS at `0x2B0000`. No blanket erase or eFuse operation
was used. See [the frozen build manifest](firmware-build-0.1.1.md).
Esptool updates the bootloader header/digest for the explicit DIO/80 MHz/4 MiB flash
parameters; the manifest records source-artifact hashes, not a claim that a header-
adjusted on-chip bootloader is byte-identical to the source file.

The normal RTS reset left this badge in download mode. An esptool watchdog reset
successfully booted the application. The console reported:

- `WAND-B602`, firmware `0.1.1`, sensor present, WHO_AM_I `0x11`.
- Control-register readback `0x47 / 0xA0` (requested 50 Hz / ±8 g configuration).
- All **41 on-device protocol self-tests passed**.
- Stationary readings approximately `(-12, 189, 987)` mg; the badge was not manually
  positioned in all six faces, so this does not qualify axes or scale.
- Sai confirmed that the display and motion-responsive LEDs work on this image.

Native Bleak connected-GATT test, 15-second streaming window:

- INFO and both subscriptions, OPEN sequence zero and five SYNC replies passed.
- SYNC RTT min/median/max `29 / 61 / 89 ms`.
- 733 samples, approximately **48.7 Hz**, zero sequence gaps, malformed samples,
  discontinuities or saturation flags; acquisition intervals 20–21 ms.
- State/cast/result commands accepted; wrong-epoch, expired and overlong cues rejected.
- Health reported sensor, stream and presentation available; device drops zero.

The same 0.1.1 image then completed 20 name-pinned native-BLE disconnect/reconnect
cycles. All passed at 48.0-49.5 Hz with zero sequence gaps. This exercises reconnect,
but it does not cover battery, second-central behavior or resource trends and therefore
does not close full H4.

After that baseline, the authorized update wrote only firmware 0.1.2's application at
`0x10000`; readback matched the manifest SHA-256. It booted as `WAND-B602`, firmware
0.1.2, with sensor present and control-register readback `0x47 / 0xA0`. Idle status was:

- free heap 171,264 bytes; minimum free heap 171,076 bytes;
- largest allocatable block 114,676 bytes;
- acquisition-task minimum free stack 5,228 bytes.

A 30-second native-BLE checker run pinned to `WAND-B602` then passed:

- INFO, both subscriptions, OPEN sequence zero, 5/5 SYNC replies and all state/cue
  acceptance/rejection checks passed;
- OPEN RTT 59 ms; SYNC RTT min/median/max `59 / 89 / 91 ms`;
- 1,465 decodable samples in 30.1 seconds, **48.7 Hz**, with zero malformed frames,
  sequence gaps, discontinuity flags, saturation flags or device drops;
- capture interval mean/min/max `20.5 / 19 / 22 ms`; host-arrival mean/max
  `20.5 / 61 ms`;
- 34 health notifications, final health bits `0xF`;
- uncontrolled-placement mean axes `(-273, -190, 776)` mg, recorded without treating
  them as a six-face or scale result.

This is native macOS GATT evidence, not Chrome, complete command-specific visual feedback,
battery-only, six-face sensor, ten-minute loaded, second-central, Windows or two-badge
acceptance. The 0.1.2 axis guard still needs direct exercise, and one idle resource snapshot
is not H3. The firmware's nominal 50 Hz report does not erase the observed 48.7 Hz measurement.
Follow the contract's H0–H5 for the remaining evidence.

## Next physical QA cards

### 1. Badge + local voice (one laptop)

**Blocked on the current upstream image's OPEN acknowledgement.** Resume this card
only after a firmware correction passes H2. The iPhone card can proceed independently.

1. Confirm the badge displays `WAND-B602`; gently tilt it and check the LEDs.
2. Open Chrome at the local game URL. Connect **WAND-B602** and enable the microphone.
3. Follow stillness, three small jabs and three raised/tilted guards. Do not swing hard.
4. Practise **Stupefy** with a jab, then **Protego** with a raised/tilted guard.
5. Try motion without speech and speech without motion; neither should count.
6. Leave/reconnect; old casts or feedback must not replay.

Report only: **build/device · failed step · expected → observed · visible message**.
Do not send raw microphone recordings or tokens. If recognition fails, we inspect
bounded timing/motion evidence with permission rather than weakening the input rule.

### 2. Two physical players

After each player passes calibration/practice and the approved network profile works:
enable both cameras, Ready, attack/defend, finish and rematch. Both screens must show
identical health/results. Disconnect a wand during a flight: the match aborts with
no winner and old projectiles disappear. A fresh connection/Ready is required.

The full acceptance matrix in [IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md)
still requires accuracy/negative/nearby-voice trials, defendability, latency, loaded
performance, five matches and target Windows Chrome testing. **The platform is not
physically E2E-qualified until these measurements exist.**
