# Battle overhaul: distinct spells, statuses, relics and an adaptive rival — September 20, 2026

## Scope and decisions

- Dhairya asked for a creature-battle feel: every spell should look and move differently,
  Expelliarmus should visibly pull the wand away, battles should stop being two-spell blowouts,
  and a little randomness should keep judges busy. The overhaul originated on
  `feat/battle-overhaul`; the main integration record below supersedes the branch QA record.
- The referee stays the only authority. Every new effect below is an authoritative event or
  snapshot field; the browser only draws what the referee already ruled. Nothing previews a hit.
- Five spells, one wand, local speech: unchanged. Firmware needs no change (HP stays 0–100; a
  stunned wizard reuses the existing offense-locked badge flag).

## Rules v2 (`apps/host/phantom_host/duel_engine.py`)

| Spell | Damage / effect | Flight | Cooldown |
| --- | --- | --- | --- |
| Stupefy | 14, 25% chance to stun 1.2 s (no casting at all) | 800 ms | 2.5 s |
| Protego | blocks one hit for 1.5 s; raised ≤ 350 ms before impact it **reflects** the spell (900 ms return flight, no burn/stun on the reflected hit) | — | 4 s |
| Expelliarmus | 8, disarms 2.5 s, **shatters** a raised shield (no damage, still disarms) | 1.1 s | 6 s |
| Incendio | 22, then burning 3/s for 4 s (cured by Episkey or a Bezoar) | 1.8 s | 9 s |
| Episkey | +22, cures burning (allowed at full HP only to cure) | — | 12 s |

- Critical hits: 12% per damaging impact, ×1.5 (Felix Felicis guarantees the next one).
- Round: 90 s (was 60). Tutorial free duel: 45 s (was 30).
- Relics: first at 8–14 s after the round starts, then 12–20 s after each claim/expiry, each
  visible 10 s mid-court. Any accepted cast by either wizard claims it. Phoenix Feather resets all
  cooldowns; Bezoar +20 HP and cures burning; Felix Felicis next hit critical; Mirror Charm
  reflects the next incoming spell within 8 s; Time-Turner halves remaining cooldowns and runs new
  ones at half length for 8 s.
- Variance (crits, stun rolls, relic timing and kind) comes from one seeded generator per room
  and round, so a recorded timeline replays identically. `DuelEngine(variance=False)` and the
  referee env `WAND_VARIANCE=false` remove every roll; tutorial lessons always run without it,
  the tutorial free duel and ordinary duels with it.
- Wire additions (`duel_models.py`, `contracts.ts`): per-spell `stunMs`, `stunChancePercent`,
  `burnDamage`, `burnMs`, `breaksShield`; ruleset `critChancePercent`, `critMultiplierPercent`,
  `perfectBlockMs`, `powerupLifetimeMs`; player `stunnedUntilMs`, `burnUntilMs`, `hasteUntilMs`,
  `mirrorUntilMs`, `lucky`; projectile `reflected`; snapshot `powerup`; events `impactReflected`,
  `shieldBroken`, `burning`, `burned`, `stunned`, `powerupAppeared/Claimed/Expired` and the
  `critical`/`powerup` fields. Recent-event buffer grew from 64 to 96.

## Practice Wizard (`duel_bot.py`)

Three levels (Apprentice, Duelist, Master). Solo starts at Duelist; a human win raises the level,
a loss lowers it (never below Apprentice); the tutorial free duel is a fixed Apprentice.

- **Tempo matching.** The bot's decision interval is the human's recent accepted-cast gap
  (last five casts; 4.5 s before any cast; never faster than the human's current silence),
  scaled per level (1.5 / 1.05 / 0.85) and clamped (3.5–8 s / 2.4–6 s / 1.9–5 s). A player who
  can only land a spell every six seconds faces a rival on a similar clock. This replaced a
  fixed 1.6–2.2 s Duelist cadence that a simulated 4.5 s voice-and-wand caster lost 12 of 12
  against, often dealing zero damage, which matched Dhairya's "impossible to defeat" report.
- **Defense.** Per-tick reflex with one roll per incoming spell (35/55/60% for fireballs and
  hooks). A Stupefy bolt lands before Apprentice and Duelist can react (reaction 700/500 ms; an
  ordinary block needs ≥ 450 ms of flight left); only the Master rolls a 20% late block that
  reflects it. Nobody below Master reflects by accident.
- It shatters a raised shield with Expelliarmus instead of wasting bolts, punishes a disarmed or
  stunned rival with Incendio, heals when hurt or burning, and notices a relic only after a
  level-based delay (2.6/1.7/1.0 s) so a quick human can win the race.
- Simulation (`scratch sim_human.py`, 16 seeds per cell, human cycling Stupefy/Incendio/
  Stupefy/Expelliarmus, healing under 45 HP, blocking fireballs 30% with 1.1 s latency):
  Apprentice loses to every tempo tried; Duelist loses 16/16 to a 3 s caster, 14/16 to 4.5 s,
  9/16 to 6.5 s; Master loses 4/16 to a 3 s caster. No zero-damage games below Master.
- Sai's earlier "substantially gentler" one-Stupefy-per-12 s bot (c4c35c4) is replaced;
  Apprentice is the gentle setting now.

## Presentation (`effects.ts`, `GameApp.tsx`, `battle.css`)

- Per-spell projectiles: Stupefy is a thin crackling bolt with jittered trail and sparks;
  Expelliarmus a golden spiralling hook; Incendio a large flickering fireball shedding embers.
  Reflected spells are tinted cyan. On a disarm the victim's wand is yanked along an arc toward
  the caster (pooled Three.js mesh) while the sprite stumbles.
- Particle system (420 particles, 160 in the low-quality renderer) with per-particle colour and
  size drives impacts, crit bursts, block/reflect rings, heal sparkles, embers on a burning
  wizard, relic glitter and claim bursts. All pooled; reduced motion disables it.
- Sprite reactions: cast lunge, white hit flash, crit shake, stumble, wobble with orbiting stun
  stars, CSS flames while burning, glow for lucky/haste/mirror, faint.
- Creature-battle log: the dialogue narrates each authoritative event ("Practice Wizard used
  Incendio!", "A critical hit!", "PERFECT BLOCK! You reflected Incendio!") with a fading four-line
  history, floating damage/heal/status callouts that fan out when they coincide, status chips on
  the HP panels, banded HP colour, screen shake and flash on heavy hits, an urgent clock, a mid-
  court relic card with timer, a claim fly-out, and spell cards that flash READY and show LOCKED
  while disarmed or stunned.
- Tutorial copy updated; the Protego lesson now fires a slow Incendio first and, after a miss,
  waits for the learner's raised shield before firing a Stupefy into it.

## Verification record

- Host: `apps/host/.venv/Scripts/python.exe -m pytest -q` — 137 passed (new `test_duel_bot.py`;
  engine tests cover reflect, shatter, burn ticks and cure, stun, crit and Felix, every relic,
  paused timelines, determinism per seed; room tests cover the shared two-player state, the
  adaptive solo bot and the tutorial flow with the new numbers).
- Web: `npm run typecheck` clean, `npm test` 273 passed, `npm run build` OK.
- Battle showcase (`apps/web/e2e/showcase`, excluded from the QA suite): one dev-mode solo duel
  with the scripted badge, 18 screenshots covering every spell in flight and on impact, the
  disarm, a relic appearing/claimed, a heal, a real reflection and the result screen; inspected.
- Playwright QA suite (`npm run test:e2e`): see the results section below.

## Original branch results

- Playwright QA suite (`npm run test:e2e`): 29 of 30 passed. The one failure, "hosted phone uses
  real RTC, resumes, and re-handshakes an explicit route change" in `phone.spec.ts`, fails
  identically on the untouched base commit c94e64b in a clean worktree; it is pre-existing and
  unrelated to this change.
- Scripted scenarios were updated for the faster bolt (a raw guard replay takes about a second,
  so the defender now starts raising 300 ms after the attacker's jab begins) and the new health
  numbers; the two-human multiplayer scenario runs with `WAND_VARIANCE=false`.
- Live-play follow-up (not addressed here): Sai's [live Stupefy diagnosis](live-stupefy-diagnosis.md)
  shows real casts being dropped before the referee by the motion recognizer's stale guard
  veto and a speech arbitration race. Those proposed input fixes remain open and are the other
  half of "my spells do nothing".
- Physical wand, microphone, iPhone and badge behaviour were not re-qualified by this change;
  the input pipeline is untouched.

## Main integration — September 20, 2026

- Merged PR #5 (`2b9b831`) with main's `93c2014`, retaining the speech-first pairing,
  armed-word persistence, brief wand-gap handling and microphone recovery fixes. No textual
  conflicts. The lowering-motion veto remains bounded to two seconds.
- Independent server and browser reviews found no blocking gameplay defects. Corrected the
  Bezoar documentation: it cures burning, not an active stun (claiming requires an accepted
  cast). Updated the teammate tutorial duration to 45 seconds.
- Reconciled input regression assertions with the new rules: Stupefy deals 14, three hits
  leave 58 HP, Episkey heals 22 capped at 100, and Protego lasts 1.5 seconds. Production input
  behavior was not loosened to make tests pass.
- Input-only timing and simple-motion scenarios now use an idle real second player: the
  adaptive bot could legitimately disarm the test caster or damage them after a heal. The
  dedicated full-match solo test continues to exercise the actual bot without this isolation.
- Local server suite: 137 passed. Web suite: 379 passed in 23 files; typecheck and production
  build passed. The build retains its existing large-bundle advisory.
- Browser suite: 32 passed on the complete run; after reconciling and isolating the two input
  tests above, both targeted reruns passed (all 34 scenarios passed). The changed E2E files
  also pass TypeScript checking. The branch's earlier RTC failure did not recur on merged main.
- Browser verification includes separate player contexts, all five spells, synchronized
  damage/burning/disarm/shield/heal, independent cooldowns, knockout, rematch/reconnect,
  real audio-worklet timing with raw BLE replay, microphone interruption recovery and phone
  RTC/relay lifecycle. Browser speech decoding and physical sensors are scripted boundaries.
- Inspected desktop and narrow-screen battle/HUD, spell effects and knockout screenshots.
- Release order matters: the new required snapshot fields need the new referee. Deploy this
  merge to Render first, then pull and restart the launcher on every demo laptop. Render does
  not replace local frontend or speech code. No firmware change or reflash is required by PR #5.
- Final physical qualification remains two people using their actual microphones and wands:
  each makes a solo cast, then create/join one code, both ready, trade Stupefy and Protego,
  verify both screens agree, play to a result and rematch.
