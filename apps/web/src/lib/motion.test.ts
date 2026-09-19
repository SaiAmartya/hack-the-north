import { describe, expect, it } from "vitest";
import { addExample, classify, emptyCalibration, Segmenter, type Calibration, type GestureKind, type Segment } from "./motion";
import { VirtualWand, type SimGesture } from "./wandSim";

/** Drive the dev simulator deterministically and collect the segments the segmenter emits. */
function run(sim: VirtualWand, seg: Segmenter, samples: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < samples; i++) {
    const s = seg.push(sim.next());
    if (s) out.push(s);
  }
  return out;
}

function perform(sim: VirtualWand, seg: Segmenter, kind: SimGesture): Segment[] {
  run(sim, seg, 40); // rest
  sim.perform(kind);
  return run(sim, seg, 90); // movement, settle, hold check, rest
}

function calibrated(): { cal: Calibration; sim: VirtualWand; seg: Segmenter } {
  const sim = new VirtualWand();
  const seg = new Segmenter();
  let cal = emptyCalibration();
  run(sim, seg, 60);
  for (const kind of ["jab", "sweep", "guard", "jab", "sweep", "guard"] as GestureKind[]) {
    const segs = perform(sim, seg, kind).filter((s) => !s.rejected);
    expect(segs.length, `calibration ${kind} produced a segment`).toBeGreaterThan(0);
    cal = addExample(cal, kind, segs[0]);
    if (kind === "guard") run(sim, seg, 200); // let the simulated arm come back down
  }
  return { cal, sim, seg };
}

describe("Segmenter", () => {
  it("stays silent while the wand rests", () => {
    const sim = new VirtualWand();
    const seg = new Segmenter();
    expect(run(sim, seg, 300)).toEqual([]);
    expect(seg.atRest).toBe(true);
  });

  it("emits one bounded segment per jab with the grip unchanged", () => {
    const sim = new VirtualWand();
    const seg = new Segmenter();
    run(sim, seg, 60);
    const segs = perform(sim, seg, "jab");
    expect(segs).toHaveLength(1);
    const s = segs[0];
    expect(s.rejected).toBeUndefined();
    expect(s.durationMs).toBeGreaterThanOrEqual(120);
    expect(s.durationMs).toBeLessThanOrEqual(900);
    expect(s.tiltDeg).toBeLessThan(15);
    expect(Math.abs(s.dir[0])).toBeGreaterThan(0.8); // the simulator jabs along X
  });

  it("marks a raise-and-hold as held and never recasts a held pose", () => {
    const sim = new VirtualWand();
    const seg = new Segmenter();
    run(sim, seg, 60);
    const segs = perform(sim, seg, "guard");
    expect(segs).toHaveLength(1);
    expect(segs[0].held).toBe(true);
    expect(segs[0].tiltDeg).toBeGreaterThan(25);
    expect(run(sim, seg, 10)).toEqual([]); // still holding the pose: nothing new until the arm moves again
  });
});

describe("classify", () => {
  it("needs calibration", () => {
    const sim = new VirtualWand();
    const seg = new Segmenter();
    run(sim, seg, 60);
    const [s] = perform(sim, seg, "jab");
    expect(classify(s, emptyCalibration()).kind).toBeNull();
  });

  it("separates the three calibrated gestures", () => {
    const { cal, sim, seg } = calibrated();
    for (const kind of ["jab", "sweep", "guard"] as GestureKind[]) {
      const [s] = perform(sim, seg, kind).filter((x) => !x.rejected);
      const v = classify(s, cal);
      expect(v.kind, `${kind}: ${v.reason}`).toBe(kind);
      expect(v.confidence).toBeGreaterThan(0.3);
      if (kind === "guard") run(sim, seg, 200);
    }
  });

  it("refuses a guard that was not held and a jab that ends tilted", () => {
    const { cal, sim, seg } = calibrated();
    const [g] = perform(sim, seg, "guard").filter((x) => !x.rejected);
    expect(classify({ ...g, held: false }, cal).kind).toBeNull();
    run(sim, seg, 200);
    const [j] = perform(sim, seg, "jab").filter((x) => !x.rejected);
    expect(classify({ ...j, tiltDeg: 60 }, cal).kind).toBeNull();
  });
});
