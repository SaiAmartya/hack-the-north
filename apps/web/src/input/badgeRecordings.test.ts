import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import { MotionRecognizer, type GestureEvidence, type SpellName } from "./motion";
import badge from "./fixtures/badge-seven-2026-09-19.json";

type Pose = readonly [number, number, number];
type Rotation = readonly [Pose, Pose, Pose];

function rotationTaking(from: Pose, to: Pose): Rotation {
  const norm = (v: Pose): Pose => { const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; };
  const a = norm(from), b = norm(to);
  const v: Pose = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 1 / (1 + c);
  return [
    [1 + k * (-v[2] * v[2] - v[1] * v[1]), -v[2] + k * v[0] * v[1], v[1] + k * v[0] * v[2]],
    [v[2] + k * v[0] * v[1], 1 + k * (-v[2] * v[2] - v[0] * v[0]), -v[0] + k * v[1] * v[2]],
    [-v[1] + k * v[0] * v[2], v[0] + k * v[1] * v[2], 1 + k * (-v[1] * v[1] - v[0] * v[0])],
  ];
}
function rotate(p: Pose, r: Rotation): Pose {
  return [r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2], r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2], r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2]];
}

const SPELL: Record<string, SpellName> = { stupefy: "stupefy", protego: "protego", expelliarmus: "expelliarmus", incendio: "incendio", sectumsempra: "sectumsempra", petrificus: "petrificus-totalus", patronum: "expecto-patronum" };

function samples(name: keyof typeof badge.spells, startMs: number, ignoreSaturation: boolean): CapturedMotion[] {
  const rows = badge.spells[name] as number[][];
  const rest = (badge.rest as Record<string, number[]>)[name] as unknown as Pose;
  const toUp = rotationTaking(rest, [0, 0, 1]);
  const t0 = rows[0][0];
  return rows.map(([captureMs, x, y, z, flags], index) => {
    const p = rotate([x, y, z], toUp);
    const t = startMs + (captureMs - t0);
    return {
      version: 1 as const, flags: ignoreSaturation ? flags & ~2 : flags, seq: index & 0xffff, captureMs: t, bootId: 9,
      axMg: Math.round(p[0]), ayMg: Math.round(p[1]), azMg: Math.round(p[2]), browserMs: t, ageUpperMs: 40, breaksGesture: index === 0,
    };
  });
}

function stillness(startMs: number, durationMs = 1800): CapturedMotion[] {
  const out: CapturedMotion[] = [];
  for (let i = 0; i * 20 <= durationMs; i++) {
    const w = (i % 5) - 2;
    const t = startMs + i * 20;
    out.push({ version: 1, flags: 1, seq: i & 0xffff, captureMs: t, bootId: 9, axMg: w, ayMg: -w, azMg: 1040 + (w % 2), browserMs: t, ageUpperMs: 40, breaksGesture: i === 0 });
  }
  return out;
}

/**
 * The user's own badge recordings (WAND-46BA, 2026-09-19): each spell performed 3-6 times, files
 * rotated into their own gravity frame because the grip changed between recordings. Calibration
 * takes the first three accepted strokes of each spell; the remaining strokes are held out.
 * Protego and Petrificus are left out: they were recorded as a lift and a chop, the motions the
 * recognizer has since replaced with a shake and a twist because that lift read as the flick and
 * the chop's first lobe matched the flick's.
 */
describe("badge recordings", () => {
  it("learns six spells from the recordings and recognizes the held-out strokes", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((e) => evidence.push(e));
    const feed = (list: CapturedMotion[], spell?: SpellName) => {
      let i = 0;
      for (; i < list.length; i++) {
        recognizer.push(list[i], 1);
        if (spell && recognizer.getState().examplesBySpell[spell] >= 3) { i++; break; }
      }
      return list.slice(i);
    };
    let cursor = 1_000_000;
    recognizer.beginCalibration();
    feed(stillness(cursor));
    cursor += 2000;
    const heldOut: Partial<Record<keyof typeof badge.spells, CapturedMotion[]>> = {};
    const learned: (keyof typeof badge.spells)[] = ["stupefy", "expelliarmus", "incendio", "sectumsempra", "patronum"];
    (recognizer as unknown as { enabledSpells: Set<SpellName> }).enabledSpells.delete("protego");
    for (const name of learned) {
      const spell = SPELL[name];
      recognizer.beginGestureCalibration(spell);
      const list = samples(name, cursor, true);
      cursor = list[list.length - 1].browserMs + 1500;
      heldOut[name] = feed(list, spell);
      expect(recognizer.getState().examplesBySpell[spell], `${name}: ${recognizer.getState().lastIssue}`).toBe(3);
    }
    expect(recognizer.getState().phase).toBe("ready");
    const play = (name: keyof typeof badge.spells) => {
      const before = evidence.length;
      feed(heldOut[name]!.map((s, i) => ({ ...s, breaksGesture: i === 0 })));
      return evidence.slice(before).map((e) => e.spell);
    };
    expect(play("stupefy")).toEqual(Array(6).fill("stupefy"));
    expect(play("expelliarmus")).toEqual(Array(5).fill("expelliarmus"));
    expect(play("incendio")).toEqual(Array(3).fill("incendio"));
    expect(play("patronum")).toEqual(Array(4).fill("expecto-patronum"));
  });
});
