# Physical iPhone gesture report — September 19, 2026

## Actual evidence

Sai supplied `wandduel-phone-trace.json` after natural jabs failed calibration. It contains
2,892 raw acceleration observations,625 laptop-acceptance reports and483 coaching records,
all in one link generation. The original user file stays outside Git.

- Observed span:48.237s; source cadence59.94Hz; observation gap p95=18ms,max=38ms.
- Reported accepted-sample age p95=50.08ms,max=62.08ms. Accepted counter increased by2,003,
  approximately41.64/s. These are reported receipts, not a complete selected-sample ledger;
  **do not call this 50Hz qualification or infer exact packet loss**.
- Training counters stayed at zero. Coaching changed between return-to-neutral,
  duration, stopping-movement and too-small rejection messages.
- The export begins with the phone flat and later includes upright motion. Original
  neutral calibration is absent, so reconstructing it would be an inference.
- Later bursts reach roughly4–5.7g total acceleration. This is not evidence that the
  user should move harder; nor can an arbitrary burst be labelled a valid spell.

The old4,000-entry trace cap retained only48s at the combined event rate. The revised
export keeps a10,000-entry/60s bound (including selected records with original timestamps,
sequence numbers and validity flags) and explicit allowlisted calibration context, even
when the original calibration event falls outside the observation window. It identifies
raw-observation units and separates phone and laptop monotonic timestamps. No audio,
transcripts, credentials, network addresses or persistent device identity are added.

## Confirmed source defects and bounded remedy

The recognizer began a candidate whenever an armed stream was no longer `stable()` or
neutral. That was **not** the approved sustained movement-onset threshold. Small drift
could therefore start the duration clock before a deliberate impulse. The same strict
window predicate governed rest and completion; opposite-projection braking was mandatory
even when a movement clearly released into a stationary hold.

The selected correction separates sustained onset, active movement, release/settling and
return-to-neutral. Retain accelerometer-only input, original timestamps, continuity/age
gates, direction confidence, independent speech fusion and negative tests. Do not lower
the150–900ms envelope merely to remove a message: this trace's large bursts span hundreds
of milliseconds, and spurious segmentation must be addressed first. New candidate
diagnostics record actual onset/end, magnitude, direction concentration, stopping evidence,
final angle and reason instead of asking the player to satisfy unexplained numeric rules.

## External comparison, not a dependency substitution

The open-source [Gesture Recognition Toolkit reference](https://github.com/nickgillian/grt/wiki/reference)
separates movement features, classifiers and post-processing. Its
[DTW documentation](https://nickgillian.com/grt/api/0.2.3/class_d_t_w.html) describes constrained
time-series matching and explicit null rejection. These are useful architectural ideas,
not evidence that its defaults recognize our spells.

We are **not importing a classifier or copying source code** in this revision. DTW could
later compare correctly segmented, labelled examples at varying speeds; it cannot recover
the correct beginning from an incorrectly delimited example. Three labelled successful
attempts and independent negative/held-out data are still needed before adopting a
template-distance threshold. A new ML model/Swift app is not justified by this trace.

## Verification boundary

Sai subsequently selected a sideways/slightly diagonal recommended grip. The detector
learns neutral and gesture direction in device coordinates, with no upright/portrait
assumption. Screen-layout changes do not rotate those coordinates, per the
[motion specification](https://www.w3.org/TR/orientation-event/#deviceorientation).
Remove portrait connection gates and screen-rotation disconnects; retain foreground
requirements. A different intentional grip needs Reset grip, not new pairing. An
accelerometer cannot distinguish re-gripping from a physically identical guard.

The physical recording establishes sensing and rejection symptoms, not positive spell
labels or a complete E2E pass. New automated cases must cover pre-jab drift, wrong-grip
stillness, one-sample spikes, coherent movement/release, braking variation and existing
wrong-axis/gap negatives. Only a fresh comfortable physical attempt can establish that
the correction improves Sai's actual calibration.
