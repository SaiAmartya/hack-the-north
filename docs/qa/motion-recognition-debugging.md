# Motion recognition debugging README

**Status:** active investigation

**Opened:** September 19, 2026

**Scope:** accelerometer ingestion, gesture segmentation/classification, and badge/iPhone delivery into the shared browser recognizer

Use this page as the durable record for the current problem: intended spells, especially Stupefy, are not always detected accurately. Update it when a reproduction, trace, code change, or physical result changes what is known. Do not turn a hypothesis into a confirmed defect without evidence.

The authoritative product and wire constraints remain [the MVP outline](../../MVP-OUTLINE.md), [implementation plan](../../IMPLEMENTATION-PLAN.md), and [badge firmware contract](../../BADGE-FIRMWARE-CONTRACT.md). This report records the narrower investigation; it does not replace those contracts.

## Current symptom

A player calibrates a gesture and later repeats what feels like the same movement, but the recognizer may return `no-match`, fail to finish a candidate, or emit no gesture evidence. The player-visible symptom can have at least two different causes:

1. The browser received a complete, valid movement and the classifier rejected its features.
2. The stream became invalid, stale, discontinuous, or incomplete before classification.

Do not tune classifier thresholds until the failing attempt has been assigned to one of those paths.

## Data path and ownership

```text
badge accelerometer or iPhone DeviceMotion
  -> 20-byte MOTION records (ax/ay/az, capture time, sequence, flags)
  -> WandClient validation and clock/continuity checks
  -> MotionRecognizer segmentation and feature extraction
  -> calibrated spell-template comparison
  -> GestureEvidence
  -> CastFusion with the matching spoken incantation
  -> referee cast request
```

- Firmware and the phone endpoint send raw acceleration including gravity. They do not send a spell direction or spell label.
- `MotionRecognizer` derives stroke direction, peak, duration, tilt, and settling evidence from a bounded sample window.
- A recognized gesture alone is not a cast. `CastFusion` requires matching fresh speech evidence within the configured timing window.

Primary code:

- `apps/web/src/wand/protocol.ts`: MOTION packet decoding.
- `apps/web/src/wand/client.ts`: range, sequence, age, flags, loss, and continuity checks.
- `apps/web/src/input/motion.ts`: calibration, segmentation, feature extraction, and spell classification.
- `apps/web/src/input/fusion.ts`: speech/gesture agreement and timing.
- `firmware/src/accel.cpp`, `firmware/src/wand.cpp`, `firmware/src/ble.cpp`: badge acquisition and notification.

## Evidence levels

Keep these results separate in every update:

| Label | What it can establish | What it cannot establish |
| --- | --- | --- |
| `DETERMINISTIC` | Reproducible classifier, timing, decoder, and fusion behavior | Real hand movement, phone sensor behavior, BLE radio, or badge sampling |
| `IPHONE PHYSICAL` | Real Safari callback cadence and a person's acceleration/movement timing | Badge sensor/radio/display/battery behavior |
| `REAL BLE BADGE` | Actual badge acquisition, BLE delivery, flags, and physical gesture behavior | A second badge, Windows adapters, or full hardware acceptance unless those were tested |

Record source, build/commit, calibration identity, grip, expected spell, actual outcome, and all relevant counters. A script result must never be reported as physical qualification.

## Confirmed findings

### C1 — Strong braking can choose the opposite signed direction

`MotionRecognizer.features()` finds the largest acceleration excursion relative to the burst's resting pose. It selects the strongest lobe around that peak, then uses a cubic-weighted average of the same lobe as the signed gesture direction. The classifier compares this direction directly with the calibrated template using an angular tolerance.

For a forward jab, the deceleration/braking lobe may be stronger than the launch lobe. In that case the chosen vector points opposite the intended thrust and can be nearly 180 degrees from the calibrated direction.

A deterministic probe against the current implementation produced:

| Synthetic braking scale | Result |
| ---: | --- |
| 0.5 | Stupefy accepted |
| 1.0 | Stupefy accepted |
| 1.5 | Stupefy accepted |
| 2.0 | Stupefy accepted in the current fixture |
| 2.5 | `no-match` |

The exact boundary is waveform-dependent. The confirmed defect is sensitivity to whether launch or braking happens to be the strongest signed lobe, not a universal failure at one braking ratio.

**Implemented experiment:** impulse play classification now compares the complete rest-relative waveform with the three calibration traces using constrained multivariate DTW. The strongest lobe remains an intentional-movement gate and calibration coaching signal, but no longer chooses the spell's signed direction during play. This is deterministic evidence only; physical validation is still open.

Required regression coverage before accepting a remedy:

- strong-braking forward jab remains Stupefy;
- a genuinely reversed jab remains rejected;
- wrong-axis impulses remain rejected;
- Protego raises are not converted into impulses;
- Stupefy and Expelliarmus remain separated and ambiguous movements remain rejected.

### C2 — Impulse lobe duration includes a hard-coded 20 ms sample width

The current feature extractor calculates:

```ts
movement[to].t - movement[from].t + 20
```

This assumes one sample represents 20 ms. That matches the target native 50 Hz badge profile and deterministic fixture generator, but it is not an accurate duration estimate for lower cadence or jittered physical input.

The defect is confirmed by code inspection. A general claim that every 33 ms stream fails is **not** confirmed: a simple retiming probe completed the current Stupefy fixture at 15, 20, 25, 33, and 40 ms. A particular resampled waveform may still cross the 60 ms lobe boundary and fail.

**Candidate remedy, not yet implemented:** estimate the represented sample width from valid local timestamp intervals around the selected lobe. Preserve the existing maximum-gap and freshness rules; do not interpolate or manufacture samples.

Before changing this calculation, commit a deterministic failing trace that demonstrates the cadence/jitter boundary being fixed.

### C3 — The recorded-resting-hold test had a disconnected assertion

The test creates a local `evidence` array, drives `h.recognizer`, and then asserts against the unused local array. The recognizer actually writes to `h.evidence`, so the current assertion cannot detect a false positive.

The assertion now targets `h.evidence` and passes. This corrected a test defect; it does not independently qualify physical resting behavior.

### C4 — The grip-orientation test covers consistent grips only

The current rotation test applies the same rotation to calibration and held-out play traces. It correctly establishes that the recognizer can learn different consistent device orientations. It does not establish that a player can calibrate in one grip and substantially rotate or re-grip the controller during play.

Until separately measured, physical QA should use one comfortable, consistent grip. Screen-layout rotation is not a grip change. An intentional grip change uses Reset grip and fresh calibration.

## Candidate architecture: hybrid waveform matching

The Wii/uWave proposal is directionally sound. A first bounded implementation now replaces signed-angle play matching for impulse spells with constrained multivariate DTW, while leaving the Protego tilt/hold branch and all continuity/segmentation gates intact. It remains an experiment pending held-out physical comparison; deterministic tests are not evidence that production should ship it unchanged.

The important reframing is:

> A dynamic spell is a bounded acceleration time series, not one acceleration vector.

The current recognizer already segments a complete movement before classification; it is not literally a one-frame dominant-axis classifier. Its limitation is narrower: it compresses that movement into hand-authored features such as strongest-lobe direction, peak, lobe duration, dominant ratio, tilt, and settling state. The confirmed braking defect shows how this compression can discard meaningful temporal order.

### Why the reference is relevant

- The original Wii Remote used a three-axis accelerometer for force/movement and gravity-relative tilt. Gravity can estimate tilt only while the controller is reasonably still; it cannot supply reliable yaw or arbitrary rotational tracking. Wii MotionPlus added gyroscopes specifically to detect rotation more directly. See [WiiBrew's accelerometer description](https://wiibrew.org/wiki/Wiimote#Accelerometer) and Nintendo's [Wii MotionPlus developer interview](https://iwataasks.nintendo.com/interviews/wii/wiimotionplus/0/1/).
- [uWave](https://doi.org/10.1016/j.pmcj.2009.07.007) matched three-axis acceleration time series with Dynamic Time Warping (DTW) and evaluated personalized gesture templates on Wii Remote hardware. Its reported user-dependent results were 93.5% without template adaptation and 98.6% with adaptation on its own eight-gesture dataset. Those figures describe that study, not this game's expected accuracy.
- uWave reduced noise and computation through temporal averaging and nonlinear acceleration quantization. It did not establish that peak-normalizing every trace is universally optimal.

The most important applicability limitation is segmentation: the evaluated Wii prototype used the remote's A-button press/release to mark gesture start and end. Wandduel has no gameplay button and must segment automatically from rest, onset, motion, and settling. DTW can improve classification after a correct boundary; it does not repair an incorrectly delimited, discontinuous, or stale gesture.

### Recommended hybrid boundary

```text
validated raw acceleration and timestamps
  -> automatic rest/onset/settling segmentation
  -> one bounded gesture with original timing
  -> intentional-movement gates
       continuity, peak, energy, duration, sample support
  -> branch by completed motion shape
       dynamic impulse -> constrained multivariate DTW candidate
       stable raise/hold -> gravity-relative tilt/hold classifier
  -> absolute acceptance threshold + best-vs-second margin
  -> GestureEvidence or unknown
```

This maps naturally to the current spell vocabulary:

- **Stupefy:** short thrust/brake waveform.
- **Expelliarmus:** broader lateral sweep waveform, deliberately distinct from the thrust.
- **Protego:** raise followed by a quiet held pose; keep a gravity-relative tilt/hold classifier rather than forcing it into the impulse matcher.

Do not design spell distinctions around wrist twist/yaw. Without a gyroscope, accelerometer-only input cannot reliably recover that rotation during dynamic movement.

### Preprocessing cautions

Subtracting the frozen rest vector is useful for making a candidate relative to the learned grip:

```text
relative[t] = sample[t] - rest
```

Call this **rest-relative acceleration**, not true linear acceleration. If the controller rotates during the gesture, the gravity vector rotates too; with no gyro/orientation estimate, simple subtraction cannot perfectly separate gravity from hand acceleration.

A DTW experiment should compare at least these representations rather than selecting one by intuition:

1. Rest-relative three-axis vectors with light timestamp-aware smoothing.
2. The same vectors scaled by one scalar peak/energy value, preserving cross-axis ratios while retaining raw peak/energy as separate gates.
3. uWave-style temporal compression/quantization adapted to the measured 50 Hz badge and actual iPhone cadence.

Never repeat/interpolate observations to manufacture 50 Hz. If a uniform grid is evaluated for classification, distinguish mathematical resampling inside an already bounded valid gesture from transport evidence: preserve the original timestamps/gaps and reject invalid continuity before resampling.

Amplitude normalization must not make tremor look like a spell. Peak, energy, duration, quiet-before/after, continuity, and minimum sample support remain independent gates. Similarly, nearest-template alone is insufficient: require both an absolute distance threshold and a margin from the second-best spell; otherwise emit `unknown` and do not cast.

### Calibration and validation requirements

Three existing calibration examples can seed per-player templates, for example by retaining all three distances and using a robust aggregate such as median. They are not enough to set rejection thresholds honestly. Thresholds and margins need held-out positives plus realistic negatives:

- comfortable fast/slow Stupefy and Expelliarmus attempts;
- strong braking and slightly off-axis positives;
- reverse, wrong-axis, fidget, re-grip, lowering, and partial gestures;
- Protego raise/hold versus brisk impulse confusion cases;
- nearby non-spell movement during speech;
- separate iPhone and badge calibration/evaluation sets.

Do not adapt production templates automatically from accepted casts until false accepts can be reviewed. Self-training can reinforce an early misclassification.

### Decision gate before replacing the current classifier

Build DTW only as a deterministic offline/QA experiment first. Replay the same labelled traces through:

1. the current v3 feature classifier;
2. the candidate hybrid DTW classifier;
3. identical segmentation and continuity gates.

Compare per source and per player:

- true acceptance for held-out intended gestures;
- wrong-spell rate, which is more harmful than an unknown rejection;
- false accepts on negative/non-gesture movement;
- unknown/retry rate;
- classification latency and bounded memory/CPU;
- sensitivity to cadence, jitter, braking, grip drift, and template choice.

Adopt the hybrid only if it improves held-out physical results without weakening continuity, speech fusion, or wrong-spell rejection. The desired order is: correct spell, then unknown, and wrong spell last.

### Implemented DTW experiment

The feature branch `codex/motion-recognition-debug-readme` currently:

- freezes the gesture's rest vector and feeds the complete rest-relative three-axis sequence to the impulse matcher;
- divides every vector by one trace-wide vector-magnitude peak, preserving cross-axis ratios while retaining raw peak and energy metadata;
- uses Euclidean point cost, a 25% Sakoe-Chiba window, rolling rows, and path-length-normalized distance;
- retains all three calibration traces and scores a candidate by their median DTW distance;
- derives each spell's acceptance distance as `clamp(2.5 × median calibration-pair distance, 0.30, 0.55)`;
- requires a best-versus-second score margin of `0.12`, otherwise returning `ambiguous`;
- retains the existing peak, lobe duration, reorientation, continuity, segmentation, and guard-preference gates.

These constants are initial deterministic thresholds, not measured physical operating points. Do not tune them from one successful hand attempt. Collect labelled held-out positives and realistic negatives for iPhone and badge separately, then compare score distributions and wrong-spell rates.

## Transport behavior: facts and interpretation

`WandClient` rejects malformed, out-of-range, stale/future, invalid, saturated, or discontinuous samples. A capture-time gap over 150 ms also marks the stream broken. The next accepted sample carries `breaksGesture`, and `MotionRecognizer` clears its current burst/window before starting fresh.

A sequence gap alone increments `lost`; it does not necessarily break a gesture when the capture-time gap remains within 150 ms and no discontinuity/invalid condition is present. Therefore `lost > 0` is not sufficient by itself to explain a disappeared gesture.

For each failed physical attempt, capture deltas for:

| Field | Interpretation |
| --- | --- |
| `observedHz` | Browser-observed accepted sample rate; not hidden sensor acquisition latency |
| `accepted` | Valid samples accepted by `WandClient` |
| `rejected` | Samples rejected by browser validation |
| `lost` | Sequence loss observed by the browser, plus the client's tracked loss semantics |
| `deviceDropped` | Firmware-reported dropped count from STATUS |
| `maxGapMs` | Largest observed capture-time gap |
| `issue` | Latest browser validation/lifecycle issue |
| firmware `gaps` | Measured fresh-acquisition gaps |
| firmware `dropped` | Firmware-side stale/refused/discarded samples |
| firmware `notify_failures` | Failed calls to enqueue/send a BLE notification |

Device Lab already exposes accepted, rejected/lost, observed rate/max gap, device-dropped count, and the current issue. Keep engineering details there or in scripts/reports; do not add them to normal player navigation.

### Classifier-side signature

Typical evidence:

```text
accepted rate remains near the source's normal rate
rejected/lost/deviceDropped do not increase
maxGapMs remains normal
MotionRecognizer candidate exists with reason no-match/ambiguous/too-small
```

Investigate segmentation, computed features, templates, or thresholds. Preserve the raw failing trace before changing logic.

### Input/transport-side signature

Typical evidence:

```text
rejected, firmware gaps/dropped, or notify_failures increase
sample issue reports stale/invalid/saturated/discontinuous input
breaksGesture occurs during the intended movement
candidate disappears or restarts rather than reaching classification
```

Investigate acquisition and delivery before tuning classifier tolerances.

## Open firmware hypothesis

The current badge acquisition task performs `accel::poll()`, packet construction, and `ble::notify_motion()` serially. `notify_motion()` also takes the shared send mutex with an unbounded wait. It is possible that notification enqueue or lock contention delays the next sensor poll.

This is **not yet a confirmed root cause**. NimBLE notification may return after copying/enqueueing rather than waiting for over-air transmission, and existing USB-side evidence measured approximately 49 Hz without the complete connected-radio qualification.

Do not split the firmware pipeline based on suspicion alone. First compare connected and disconnected acquisition intervals and check whether movement correlates with `gaps`, `dropped`, or `notify_failures`. If separation becomes necessary, use a bounded latest-sample/ring policy with explicit age/drop/discontinuity semantics; never introduce an accumulating FIFO that drains stale motion into gameplay.

## Revision consistency

The current working-tree firmware interfaces are internally consistent: `accel::Sample`, `accel::poll(Sample&, bool&)`, and `accel::period_ms()` are declared and used together. Reports describing the older multi-reference `poll(x, y, z, ...)` signature refer to an earlier revision.

For every badge experiment, still record all three identities:

```text
Git commit/source tree
compiled firmware version and SHA-256
flashed badge-reported version/readback hash
```

Code similarity is not proof that the connected badge is running the current image. Flashing remains a separately approved operation.

## Investigation sequence

1. Reproduce one failed Stupefy without changing thresholds.
2. Record source/build, grip, expected outcome, classifier reason, candidate diagnostics, and before/after transport counters.
3. Export a bounded sanitized motion trace only with approval; do not include audio, transcripts, credentials, or persistent personal identifiers.
4. Replay the original timestamps and gaps through the production decoder/recognizer.
5. Classify the failure as segmentation, feature direction, template/classifier, continuity/transport, or speech/gesture fusion.
6. Add the smallest failing automated test for that root cause.
7. Change one variable or implementation rule at a time.
8. Run the focused test, full motion/fusion suite, and relevant transport/firmware checks.
9. Repeat only the affected physical QA step. Deterministic green tests do not close physical gates.

Do not raise `DIRECTION_TOLERANCE_DEG` merely to conceal a sign flip. Wider tolerances can increase Stupefy/Expelliarmus confusion and false accepts.

## Experiment log

Append new results; do not rewrite failed evidence out of the history.

| Date/time | Evidence | Build/source | Controller and grip | Expected | Actual | Stream counters | Recognizer reason/features | Trace ID | Conclusion/next test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19 | DETERMINISTIC | current `main` before this document | RawMotionTraceBuilder, calibrated +X jab | Stupefy across braking variation | accepted through 2.0; `no-match` at 2.5 | synthetic contiguous 50 Hz | strongest signed lobe becomes braking-sensitive | temporary probe; not retained | add permanent strong-braking and reverse-jab tests before changing direction logic |
| 2026-09-19 | DETERMINISTIC | current `main` before this document | retimed current fixture | identify cadence boundary | Stupefy calibration completed at 15/20/25/33/40 ms in this probe | no physical transport | did not reproduce a universal 33 ms failure | temporary probe; not retained | retain the specific failing resampled waveform before changing lobe duration |
| 2026-09-19 | DETERMINISTIC | `codex/motion-recognition-debug-readme`, uncommitted | RawMotionTraceBuilder plus recorded iPhone fixture | strong-braking forward jab accepted; reverse/wrong-axis/ambiguous rejected; Protego and recorded held-out jabs preserved | all targeted cases passed; full frontend suite 160/160 and production build passed | synthetic/recorded replay only; no new physical counters | DTW impulse thresholds 0.30–0.55, cohesion scale 2.5, margin 0.12 | committed fixtures only | run labelled iPhone physical comparison, then real badge qualification; no accuracy claim yet |

## Physical QA card for the next failed attempt

Use either one iPhone or one badge; label which. This card diagnoses the failure and does not qualify the other source.

1. Record the Git/build identifier, controller source, browser/device, and grip.
2. Open the gated Device Lab/connection details and note starting accepted, rejected, lost, deviceDropped, observedHz, maxGapMs, and issue.
3. Perform one comfortable calibrated Stupefy. Do not exaggerate the movement to satisfy the detector.
4. Note the visible result and `MotionRecognizer` reason/candidate diagnostics.
5. Record the same counters immediately after the attempt. For a badge, also collect `gaps`, `dropped`, and `notify_failures` from the approved diagnostic command.
6. If approved, export only the bounded sanitized trace for this attempt and attach a private identifier in the experiment log; do not commit the original user trace by default.

Report:

```text
build · source · browser/device · grip · expected -> actual
before counters -> after counters
recognizer reason/candidate
firmware counters when applicable
trace identifier or "not exported"
```

## Open gates

- Permanent jitter/lower-cadence regression derived from an actually failing trace.
- Fresh physical Stupefy/Protego calibration and held-out attempts on iPhone.
- Fresh physical Expelliarmus calibration, held-out attempts, realistic negatives, and wrong-spell-rate comparison on iPhone.
- Fresh physical Stupefy/Protego calibration and held-out attempts on WAND-B602.
- Fresh physical Expelliarmus calibration, held-out attempts, realistic negatives, and wrong-spell-rate comparison on WAND-B602.
- Connected-radio badge cadence/gap/notify measurements under movement and presentation load.
- Badge six-face, clipping, reconnect, battery, Windows, second-badge, and full-match qualification defined by the firmware contract.
