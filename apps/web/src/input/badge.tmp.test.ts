import { it } from "vitest";
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

const ORDER: (keyof typeof badge.spells)[] = ["stupefy", "protego", "expelliarmus", "incendio", "sectumsempra", "petrificus", "patronum"];
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

it("replays the badge recordings", () => {
  const ignoreSaturation = (globalThis as any).__ignoreSat ?? true;
  const evidence: GestureEvidence[] = [];
  const recognizer = new MotionRecognizer((e) => evidence.push(e));
  const r = recognizer as any;
  let lastKey = "";
  const log: string[] = [];
  const feed = (list: CapturedMotion[], tag: string, stopAtExamples?: number, spell?: SpellName) => {
    let i = 0;
    for (; i < list.length; i++) {
      const before = evidence.length;
      recognizer.push(list[i], 1);
      const d = recognizer.getDiagnostics().candidate;
      const key = JSON.stringify(d);
      if (d && key !== lastKey) {
        lastKey = key;
        log.push(`${tag} t=${((d.startMs) / 1000).toFixed(2)} dur=${d.durationMs} peak=${Math.round(d.peakMg)} dom=${d.dominantRatio.toFixed(2)} tilt=${Math.round(d.finalAngleDeg)} stop=${d.stopEvidence} -> ${d.reason} | ${recognizer.getState().lastIssue}`);
      }
      if (evidence.length > before) log.push(`${tag} t=${(evidence[before].startMs / 1000).toFixed(2)} EVIDENCE ${evidence.slice(before).map((e) => e.spell).join(",")}`);
      if (stopAtExamples !== undefined && spell && recognizer.getState().examplesBySpell[spell] >= stopAtExamples) { i++; break; }
    }
    return list.slice(i);
  };
  let cursor = 1_000_000;
  recognizer.beginCalibration();
  feed(stillness(cursor), "still");
  cursor += 2000;
  const heldOut: Record<string, CapturedMotion[]> = {};
  for (const name of ORDER) {
    const spell = SPELL[name];
    recognizer.beginGestureCalibration(spell);
    const list = samples(name, cursor, ignoreSaturation);
    cursor = list[list.length - 1].browserMs + 1500;
    heldOut[name] = feed(list, `calib:${name}`, 3, spell);
    log.push(`## ${name}: examples=${recognizer.getState().examplesBySpell[spell]} phase=${recognizer.getState().phase} issue=${recognizer.getState().lastIssue} heldOutSamples=${heldOut[name].length}`);
    if (recognizer.getState().examplesBySpell[spell] < 3) {
      // Not learned: forget it and move on so the rest can still be judged.
      r.calibratingSpell = undefined; r.examples.delete(spell); r.updateReadyPhase();
    }
  }
  log.push(`## state ${recognizer.getState().phase} enabled=${recognizer.getState().enabledSpells.join(",")} templates=${[...r.templates.keys()].join(",")}`);
  for (const name of ORDER) {
    const list = heldOut[name];
    if (!list.length) continue;
    const shifted = list.map((s, i) => ({ ...s, breaksGesture: i === 0 }));
    const before = evidence.length;
    feed(shifted, `play:${name}`);
    log.push(`## play ${name}: ${evidence.slice(before).map((e) => e.spell).join(",") || "(nothing)"}`);
  }
  console.log("\n" + log.join("\n"));
});
