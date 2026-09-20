# Input rebuild — implementation and evidence

September 19, 2026. This report separates implemented behavior from hardware/physical qualification.

## Evening rebuild: recognizer v3, badge auto-reconnect, firmware 0.2.0

Sai's second recorded attempt (`wandduel-phone-trace 2.json`, three deliberate jabs) showed six clear
strokes of 3.7–4.8 g with a device-frame direction consistent to within ~15°, separated by 12–18° of
hand drift and slow returns. Recognizer v2 rejected all of them (`too-long`, `too-short`,
`missing-stop`) because it segmented on drift from a frozen neutral and demanded a return to that
pose. **v3** replaces the segmenter and classifier:

- A movement starts on a sharp sample-to-sample change (jerk ≥ 180 mg/20 ms on two samples, a single
  ≥ 450, a linear excursion ≥ 450 mg, or a 15° orientation change) and ends when the trailing 200 ms
  is still again (jerk < 140, spread < 150 mg) — in whatever pose the hand ended up. The resting
  reference re-anchors at each still run; nothing requires returning to the calibrated grip.
- Strong strokes (≥ 800 mg) resolve as soon as sharp acceleration stops (~250 ms after the peak),
  before the hand settles; a rapid succession of strokes is one spell; the next needs 250 ms of stillness.
- Features: peak-weighted stroke direction in device axes, peak magnitude, stroke length, and the
  orientation change from the starting pose to the held end pose. Templates per spell come from three
  examples: jab/sweep = direction + typical peak; guard = tilt direction + typical tilt/peak.
- Calibration coaching is one sentence and actionable (`Jab a little harder`, `Raise higher, then hold`,
  `That looked like a jab`); pre-jab twitches and slow drift are ignored silently; lowering a guard is
  recognized as the opposite of the raise and ignored.

The recorded trace now calibrates on its first three jabs and recognizes the remaining two as
held-out Stupefy (test `calibrates and recognizes Sai's recorded iPhone jabs`). Synthetic fixtures were
reshaped to match the recording (wind-up, thrust, brake, slow drifting return). This is still not a
physical pass: the next iPhone and badge sessions must confirm it with real hands.

Badge firmware **0.2.0** and the browser's badge auto-reconnect are described in
[the 0.2.x change record](firmware-0.2.0.md), together with the 0.2.1 battery brownout soft start
(the current source, flashed on WAND-B602 with readback verification) and the physical QA card.

## Checkpoint and boundaries

The previous incomplete/diagnostic checkpoint was published to `main` at **3c0ed45**, incorporating teammate display-rotation defaults. The rebuild integrates teammate main **76b6388**; a fresh fetch before publication found no newer main commits. Sai authorized publishing this reviewed checkpoint from `codex/wand-input-rebuild` to `main`. This is a software/diagnostic checkpoint, not a qualified physical release. Backups, secrets, local model weights and build outputs are excluded. See [teammate setup](../TEAM-SETUP.md) for clean-install/run instructions and [firmware installation](../../firmware/README.md#safe-teammate-setup) for the separately gated hardware procedure.

## Implemented direction

- Hosted phone-only envelope v2, unchanged BLE UUIDs/20-byte records. One `PhoneSession` shares direct WebRTC and explicitly selected Internet relay. Direct uses no STUN/TURN and no media tracks; signalling loss must not destroy healthy direct motion.
- Approved pairing is distinct from carrier connection, input generation and calibration. Bounded recovery performs endpoint reset, subscriptions, OPEN and SYNC; client waits for fresh motion, classifier rechecks a completed matching grip. No round resumes automatically.
- Relay batching/receipts and queue limits keep obsolete motion from becoming catch-up input. Direct and relay preserve source timestamps. Existing freshness guards remain.
- Explicit calibration after microphone/grip, visible progress/rejection reasons, reset grip, timestamp-weighted direction/settling classifier, and phone sensor/receipt/coaching indicators with opt-in sanitized trace. Recognizer v2 separates sustained onset from release and accepts a calibrated sideways/diagonal grip; fixed device axes are never remapped by screen rotation.
- Client understands native50Hz ±8g or explicitly qualified ±2g. Diagnostic capabilities do not permit play. A controlled firmware matrix remains a separate qualification stream.

## Physical feedback received

Sai reached jab training but reported repeated rejections. The supplied real Safari trace
shows healthy observation cadence and low sample age, but zero accepted examples. See
[the physical gesture analysis](physical-gesture-analysis.md). This is a failed physical
calibration gate, not evidence of a usable detector; the implemented classifier revision explicitly
separates onset/release from minor instability and adds calibration context to trace exports.

The [0.1.8 firmware matrix](firmware-0.1.8-matrix.md) completed all eight short comparisons,
including the creator baseline without BLE. Every profile retains the STATUS anomaly;
capabilities remain zero. No badge gameplay or battery qualification is claimed.

The later missing-badge report has a separate source-level explanation: installed 0.1.8
defaults to **BLE off** on cold/watchdog reset. An eight-second read-only scan found no
WAND-B602 advertisement; this does not by itself prove the live reset reason or radio health.
Source candidate **0.1.9** defaults to creator-profile **BLE on**, invalidates old RTC
selections and retains literal-zero capabilities. Its build and portable tests pass;
it has **not been flashed**. The candidate application SHA-256 is
`a876134408bf60a82620ff9508eb7d8ac7e4203ec5f738899dbd46a205f18e5f`.
This is a discoverability correction, not a sensor fix or a playable-badge release. The 0.1.9
candidate was superseded the same evening by 0.2.0 and then 0.2.1 (see above); 0.2.1 is the image
now on WAND-B602.

## Repeatable software checks

### Unqualified hybrid DTW impulse experiment — September 19, 2026

The feature branch `codex/motion-recognition-debug-readme` now evaluates Stupefy and Expelliarmus as complete rest-relative three-axis waveforms using constrained DTW and keeps Protego on the existing gravity-relative raise/hold path. The deterministic regression covers a strong-braking forward jab, true reverse and wrong-axis rejection, ambiguity rejection, recorded iPhone-jab replay, Protego, continuity, fusion, and controller behavior. The full frontend result is **21 files / 160 tests passed**, and the production typecheck/build passed.

This is an uncommitted software experiment, not an iPhone or badge qualification. Its initial absolute score limits and ambiguity margin must be evaluated with held-out human positives and realistic negatives before adoption. See [the motion-recognition debugging record](motion-recognition-debugging.md) for the implementation boundary, exact thresholds, evidence log, and next physical card.

Publication verification reran the full local suite: **253 host tests passed, 4 skipped; 25 tooling tests;
158 frontend tests; 27 Playwright browser tests; frontend typecheck/build.** The Worker
separately passed **33 tests and typecheck**. The browser tests include landscape startup,
layout rotation without a new link, pause/resume, route change with a fresh handshake,
and calibration/combat regressions. Initial sandbox-only runs could not open loopback
test servers; the same suite passed with scoped local-server permission.
The tooling suite includes the diagnostic-version regression. These test counts are software evidence, not a fresh physical run.

Deployed phone-service version: `9f3fb321-3b8e-4f46-abc8-f15d9174a637`, phone asset
`phone-CvajZhUh.js`. The final restarted stable laptop snapshot serves `index-ckckPrxx.js`;
the route measurements below used `index-C-JJRKhO.js`, whose only later game-code change
is neutral-grip coaching copy. The 38 motion/controller/fusion tests and typecheck passed
again after that copy change. The launcher verified the referee and warmed local speech
helper before printing Game ready.
The public **direct** test completed stillness, six examples, two fused practice spells,
then 60 seconds at **50.0 Hz / 100% selected-record delivery**. Maximum arrival gap across
the whole run was 176 ms; this is not a no-gap physical qualification. The matching
Internet-relay run failed with `No fresh valid motion for 500 ms` before calibration.
A bounded diagnostic repeat passed 10 seconds, then a separate 60-second repeat passed
at **50.0 Hz / 100% delivery**, after the same six examples and two fused practice spells.
That full setup/rehearsal sent and received 3,976 records with zero sequence gaps or endpoint
drops, and only the expected initial discontinuity. Maximum accepted age was **176 ms**,
SYNC RTT **46–69 ms**, and maximum arrival gap **179 ms**. No product thresholds were
changed to obtain the repeat passes. The earlier intermittent failure remains open;
these short successes do not qualify the Internet route or erase that failure. The QA
script now retains bounded scalar delivery/clock/failure counters, never raw envelopes,
credentials, SDP or speech content. Prefer direct Wi-Fi for the next physical test.

`python3 tools/qa_game.py` exercises the private platform. `npm test` in `apps/phone-relay` covers Worker pairing, role/expiry/generation and congestion boundaries. WebRTC browser regressions use real peer connections with mocked signalling; they do not measure a venue route.

After an approved deployment and local-stack restart:

```sh
node tools/qa_input_rebuild.mjs https://wandduel-phone.saiamartya19.workers.dev 60 direct
node tools/qa_input_rebuild.mjs https://wandduel-phone.saiamartya19.workers.dev 60 relay
```

This script uses real public pairing/carriers and injected movement/audio+ASR fixtures. It must complete explicit stillness, six training examples and two fused practice spells. It is not real Safari, a human voice or badge evidence.

## Next physical QA card

Build/source: the next explicitly reported deployed revision; Safari on an unlocked iPhone, held comfortably sideways/slightly diagonal (other consistent grips are valid), same venue Wi-Fi. Do not start this card against an old page.

1. Refresh laptop, connect iPhone, scan and approve the matching number; allow motion in Safari. If offered, select Internet explicitly and report which route was used.
2. Move gently: **Sensor active** and **Reaching laptop** should both respond/expire truthfully. Open Connection details if either is missing.
3. Enable laptop microphone. Nothing should calibrate until **Start calibration**.
4. Hold the illustrated grip, start, watch three-second stillness; movement should restart progress.
5. Practice three forward jabs: see individual accepted examples or one actionable retry hint. Reset grip if needed, without pairing again.

Reply: **build · route/devices · failed step · expected → observed · visible reason/rates**. Use the explicit trace-export button only if you want to share the last minute; no audio/video or credentials are included.

## Not yet claimed

Real Safari ten-minute loaded stability,10 recovery cycles,95% delivery with timing gates,18/20 fused attempts/player/spell, negatives/nearby voices,8/10 defenses and five two-player matches remain physical gates. A Swift rewrite would not qualify them automatically. Badge sensor interpretation, six faces/clipping, load/reconnect, battery cold boots/unplug/30-minute operation and Windows/two-badge checks are separate. Do not remove diagnostic capability restrictions without that evidence.
