# Hybrid Motion DTW Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace strongest-lobe signed-direction matching for Stupefy and Expelliarmus with a conservative per-player multivariate DTW matcher while retaining the current automatic segmenter, Protego tilt/hold recognition, input-health gates, and speech fusion.

**Architecture:** Add a dependency-free pure DTW module that preprocesses bounded rest-relative three-axis traces and returns normalized distances. `MotionRecognizer` retains complete impulse traces in calibration templates, compares an unknown impulse against each spell's three templates, and accepts only when the best score passes both an absolute per-spell threshold and a best-vs-second margin. Protego remains the existing gravity-relative guard classifier.

**Tech Stack:** TypeScript 5.7, Vitest 3, existing `MotionRecognizer` and raw trace fixtures; no new runtime dependencies.

**Spec:** `docs/qa/motion-recognition-debugging.md`

## Global Constraints

- Keep raw badge/iPhone acceleration including gravity and original timestamps; do not add gyro, position reconstruction, repeated samples, or transport interpolation.
- Keep the current freshness, age, gap, saturation, discontinuity, generation, rest/onset/settling, and voice-fusion rules unchanged.
- Keep Protego as a gravity-relative raise/hold classifier.
- Unknown or ambiguous motion emits no `GestureEvidence`; wrong-spell acceptance is worse than a retry.
- Keep player UI free of classifier toggles, traces, DTW scores, and engineering terminology.
- Deterministic tests do not qualify iPhone or badge hardware.
- Do not modify firmware, flash hardware, publish, push, or commit. Sai reviews the uncommitted diff first.

## Review Focus

- A braking lobe stronger than the launch must not reverse a forward Stupefy, while a genuinely reversed impulse must remain rejected.
- Stupefy and Expelliarmus with close scores must return unknown rather than selecting the numerically smaller score.
- A small normalized tremor must fail the existing magnitude/energy gates before DTW.
- A Protego raise that contains a brisk impulse must still resolve through the guard path when it finishes in a held pose.
- Missing/stale/discontinuous samples must clear the candidate before DTW and must never be resampled into a match.

---

### Task 1: Pure multivariate DTW matcher

**Files:**
- Create: `apps/web/src/input/dtw.ts`
- Create: `apps/web/src/input/dtw.test.ts`

**Interfaces:**
- Consumes: finite rest-relative samples as `readonly [number, number, number][]`.
- Produces: `prepareImpulseTrace(samples: readonly Vector3[]): PreparedImpulseTrace` and `dtwDistance(left: PreparedImpulseTrace, right: PreparedImpulseTrace): number`.
- `PreparedImpulseTrace` is immutable and contains normalized three-axis points plus the raw peak and energy retained for gating/diagnostics.

- [ ] **Step 1: Write failing preparation tests**

Add tests proving that preparation:

```ts
it("normalizes one trace by a scalar peak while preserving axis ratios", () => {
  const trace = prepareImpulseTrace([[0, 0, 0], [800, 200, 0], [-400, -100, 0]]);
  expect(trace.points).toEqual([[0, 0, 0], [1, 0.25, 0], [-0.5, -0.125, 0]]);
  expect(trace.peakMg).toBeCloseTo(Math.hypot(800, 200));
});

it("rejects non-finite, empty, and zero-energy traces", () => {
  expect(() => prepareImpulseTrace([])).toThrow();
  expect(() => prepareImpulseTrace([[0, 0, 0], [0, 0, 0]])).toThrow();
  expect(() => prepareImpulseTrace([[Number.NaN, 0, 0]])).toThrow();
});
```

- [ ] **Step 2: Run preparation tests and verify RED**

Run: `zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test -- src/input/dtw.test.ts'` from `apps/web`.

Expected: FAIL because `./dtw` does not exist.

- [ ] **Step 3: Implement minimal trace preparation**

Create these exact exports:

```ts
export type Vector3 = readonly [number, number, number];

export type PreparedImpulseTrace = Readonly<{
  points: readonly Vector3[];
  peakMg: number;
  energyMg2: number;
}>;

export function prepareImpulseTrace(samples: readonly Vector3[]): PreparedImpulseTrace;
```

Validate every component, calculate vector-magnitude peak and summed squared energy, reject zero peak, and divide all three axes by the single peak scalar. Do not normalize each axis independently.

- [ ] **Step 4: Run preparation tests and verify GREEN**

Run the Task 1 test command. Expected: preparation tests PASS.

- [ ] **Step 5: Write failing DTW tests**

Add tests proving:

```ts
it("gives identical shapes near-zero distance across different speeds", () => {
  const short = prepareImpulseTrace([[0,0,0], [800,0,0], [-400,0,0], [0,0,0]]);
  const long = prepareImpulseTrace([[0,0,0], [400,0,0], [800,0,0], [200,0,0], [-400,0,0], [-200,0,0], [0,0,0]]);
  expect(dtwDistance(short, long)).toBeLessThan(0.2);
});

it("keeps reversed and orthogonal impulses far from the forward template", () => {
  const forward = prepareImpulseTrace([[0,0,0], [800,0,0], [-400,0,0], [0,0,0]]);
  const reverse = prepareImpulseTrace([[0,0,0], [-800,0,0], [400,0,0], [0,0,0]]);
  const lateral = prepareImpulseTrace([[0,0,0], [0,800,0], [0,-400,0], [0,0,0]]);
  expect(dtwDistance(forward, reverse)).toBeGreaterThan(0.5);
  expect(dtwDistance(forward, lateral)).toBeGreaterThan(0.5);
});
```

- [ ] **Step 6: Run DTW tests and verify RED**

Run the Task 1 test command. Expected: FAIL because `dtwDistance` is not exported.

- [ ] **Step 7: Implement constrained normalized DTW**

Export:

```ts
export function dtwDistance(
  left: PreparedImpulseTrace,
  right: PreparedImpulseTrace,
): number;
```

Use Euclidean distance between three-axis normalized points, a Sakoe-Chiba band of `max(abs(n - m), ceil(max(n, m) * 0.25))`, two rolling rows for bounded memory, and normalize the final accumulated cost by the recovered/maintained path length. Reject malformed prepared traces. Do not add an npm dependency.

- [ ] **Step 8: Run Task 1 tests and typecheck**

Run:

```sh
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test -- src/input/dtw.test.ts'
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm run typecheck'
```

Expected: both exit 0.

---

### Task 2: Hybrid integration in MotionRecognizer

**Files:**
- Modify: `apps/web/src/input/motion.ts`
- Modify: `apps/web/src/input/motion.test.ts`

**Interfaces:**
- Consumes: Task 1's `prepareImpulseTrace()` and `dtwDistance()`.
- Produces: impulse templates containing full prepared waveforms and `classify()` behavior that combines DTW impulse matching with the unchanged guard path.
- Existing public interfaces remain unchanged: `MotionRecognizer`, `GestureEvidence`, and `MotionRecognizerState` require no callers to change.

- [ ] **Step 1: Correct the disconnected resting-hold assertion**

Change the existing test to assert `h.evidence` and remove its unused local `evidence` array.

- [ ] **Step 2: Run the resting-hold test before classifier changes**

Run: `zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test -- src/input/motion.test.ts -t "stays silent on the recorded resting hold"'`.

Expected: PASS. This correction validates existing behavior; it is not the RED step for DTW.

- [ ] **Step 3: Write failing strong-braking and reverse tests**

Add separate tests:

```ts
it("recognizes a calibrated forward jab when braking is stronger than launch", () => {
  const h = new MotionHarness();
  h.ready();
  h.feed(h.builder.jab(900, 0, undefined, 2.5));
  expect(h.spells()).toEqual(["stupefy"]);
});

it("rejects a true reverse jab after forward calibration", () => {
  const h = new MotionHarness();
  h.ready();
  h.feed(h.builder.jab(900, 0, [-1, 0, 0], 0.8));
  expect(h.evidence).toHaveLength(0);
  expect(h.recognizer.getState().reason).toBe("no-match");
});
```

- [ ] **Step 4: Run the two tests and verify RED/characterization**

Run the two named tests. Expected: strong-braking test FAILS with no Stupefy; reverse test PASSES as characterization. Do not change thresholds to make RED pass.

- [ ] **Step 5: Retain complete impulse traces in features/templates**

Import Task 1 helpers. Extend private types:

```ts
type Features = {
  // existing fields unchanged
  impulseTrace: PreparedImpulseTrace;
};

type ImpulseTemplate = {
  kind: "impulse";
  traces: readonly PreparedImpulseTrace[];
  peak: number;
  acceptanceDistance: number;
};
```

Build `impulseTrace` from the complete `linear` movement sequence already calculated in `features()`. Retain existing peak/duration/lobe/dominance gates before template comparison. Keep all three accepted calibration traces rather than averaging their direction vectors.

Derive each spell's conservative threshold from calibration cohesion:

```ts
acceptanceDistance = Math.min(
  0.55,
  Math.max(0.18, median(pairwiseCalibrationDistances) * 2.5),
);
```

These values are initial deterministic candidates, not physical accuracy claims. Store them only in browser-local calibration.

- [ ] **Step 6: Classify impulses by median DTW score and margin**

For each enabled impulse spell:

```ts
score = median(template.traces.map(trace => dtwDistance(features.impulseTrace, trace)));
```

Sort ascending and accept only when:

```ts
best.score <= best.template.acceptanceDistance
&& (!second || second.score - best.score >= 0.12)
```

Otherwise return `no-match` or `ambiguous`. Preserve the existing guard/lowering/reorientation logic and guard preference. Remove signed-angle impulse matching from play classification only; calibration coaching may continue using direction separation to prevent Stupefy and Expelliarmus examples from being nearly identical.

- [ ] **Step 7: Run focused motion tests and verify GREEN**

Run: `zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test -- src/input/motion.test.ts'`.

Expected: all motion tests PASS, including strong braking, reverse, wrong axis, ambiguity, Protego, rotated grip, gaps, saturation, real iPhone jabs, and resting hold.

- [ ] **Step 8: Add a failing ambiguity-margin test if existing coverage does not exercise DTW margin**

Construct a held-out impulse halfway between calibrated Stupefy and Expelliarmus templates and assert no evidence plus reason `ambiguous`. Run it and verify it FAILS if the new path selects the nearest class; then apply the margin rule from Step 6 and verify it passes. If the existing ambiguity test already fails before Step 6 and passes afterward specifically through DTW scores, document that evidence and do not duplicate it.

- [ ] **Step 9: Run the focused integration suite**

Run:

```sh
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test -- src/input/dtw.test.ts src/input/motion.test.ts src/input/fusion.test.ts src/game/controller.test.ts src/qa/harness.test.ts'
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm run typecheck'
```

Expected: exit 0. If `src/qa/harness.test.ts` is not an existing test target, remove only that path and record the ruling; do not invent a passing file.

---

### Task 3: Deterministic comparison and investigation record

**Files:**
- Modify: `docs/qa/motion-recognition-debugging.md`
- Modify: `docs/qa/input-rebuild.md`
- Test: existing web suite

**Interfaces:**
- Consumes: Task 2's actual test outputs and DTW thresholds.
- Produces: an evidence record that distinguishes deterministic results from pending physical validation.

- [ ] **Step 1: Run the complete frontend suite before documenting results**

Run:

```sh
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm test'
zsh -lc 'nvm use --delete-prefix 26.5.0 >/dev/null && npm run build'
```

Expected: exit 0. Record exact test counts from output; do not copy older counts.

- [ ] **Step 2: Update the active debugging README**

Append an experiment-log row with:

- branch/build identity;
- `DETERMINISTIC` evidence label;
- exact strong-braking, reverse, wrong-axis, ambiguity, Protego, and recorded-iPhone results;
- exact suite counts;
- thresholds used;
- explicit statement that physical iPhone and badge gates remain open.

Move the hybrid architecture from candidate to implemented experiment only if Task 2 is present and verified. Do not call it more accurate without held-out physical evidence.

- [ ] **Step 3: Update the current input evidence checkpoint**

Add a short dated section to `docs/qa/input-rebuild.md` linking the debugging README and stating that the branch contains an unqualified DTW impulse experiment. Preserve all earlier failed physical evidence and current firmware gates.

- [ ] **Step 4: Verify documentation and final diff**

Run:

```sh
git diff --check
rg -n "DTW|strong braking|REAL BLE|IPHONE PHYSICAL|not yet|not qualified" docs/qa/motion-recognition-debugging.md docs/qa/input-rebuild.md
git status --short
```

Expected: no whitespace errors; only planned files plus the already approved QA README/plan changes are modified or untracked.

- [ ] **Step 5: Run final verification without committing**

Run the complete frontend tests and build again after documentation changes. Expected: both exit 0. Leave all work uncommitted for Sai's diff review.
