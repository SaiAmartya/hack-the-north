# Input rebuild — implementation and evidence

September 19, 2026. This report separates implemented behavior from hardware/physical qualification.

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
This is a discoverability correction, not a sensor fix or a playable-badge release.

## Repeatable software checks

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

This script uses real public pairing/carriers and injected movement/audio+ASR fixtures. It must complete explicit stillness, six training examples and two fused practice spells. It is not real Safari, a human voice or badge evidence. The older `qa_public_phone.mjs` targets protocol v1 and is historical; use the new script for v2.

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
