# Wandduel — badge or iPhone + local voice

A solo or two-player, motion-and-voice duel with an original pixel arena: your wizard faces a rival,
five spells have independent cooldowns, and a Python referee owns health, effects and results.
Speech stays on each laptop. Solo and multiplayer share the same combat rules.
**Tutorial duel** teaches all five spells with animated gesture guides and a paced opponent.
The homepage's optional **Dev mode** enables click casting and local raw wand/transcription logs.
See the [tutorial, telemetry and speech QA record](docs/qa/tutorial-dev-release.md) for the latest changes and trace collection steps.

**The launcher uses the shared Render referee.** Each laptop still runs its own frontend
and speech helper, so pull the latest `main` and restart after updates. Use `--local-referee`
for solo play without the hosted service; two local laptops can share a referee using the
[LAN instructions](docs/TEAM-SETUP.md#4-optional-local-and-lan-referee).
The [solo release record and QA contract](docs/qa/solo-release.md) tracks the exact hosted
revision and connected-badge flash. Earlier evidence is in the [final-sprint report](docs/qa/final-sprint.md).

- **[Start here: teammate setup](docs/TEAM-SETUP.md)** — fresh-clone macOS/Windows install,
  local speech, wand-first connection, shared-referee multiplayer, checks and troubleshooting.
- **[Badge build, backup and flash instructions](firmware/README.md)** — 0.3.0 adds five-spell feedback. WAND-B602 is flashed and checked; teammates flash their own badges.
- [MVP](MVP-OUTLINE.md) · [Implementation plan](IMPLEMENTATION-PLAN.md) · [Firmware contract](BADGE-FIRMWARE-CONTRACT.md)
- [Design system](DESIGN_SYSTEMS.md) · [Repository workflow skill](.agents/skills/wand-dev-workflow/SKILL.md)

## Run an already installed checkout

From the repository root, with Node **26.5.0** on PATH and the Python **3.11** environment
installed, start the frontend and local speech helper using the hosted referee:

```sh
python3 tools/run_game.py
```

Windows PowerShell:

```powershell
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py
```

The launcher uses the installed Python environment and provisions the pinned speech model
on first use if needed. The hosted referee also brokers iPhone pairing; no personal enrollment
secret is needed on each laptop. See [phone setup](docs/TEAM-SETUP.md#3-connect-an-iphone).
A previous stack started by the launcher is stopped automatically before the new one comes up.

Wait for **Game ready: http://127.0.0.1:5173**, then open that exact URL in desktop Chrome;
a tab typed as `localhost:5173` is redirected there. **Pair a badge or iPhone first.** Only
after the wand connects, choose **Duel a bot** for a solo match, or create a duel and share its
six-character code with another player. Both human players must use the same referee;
separate loopback referees cannot share a room.
Allow the laptop microphone, hold the wand comfortably still briefly, and give the microphone
two seconds of quiet while its automatic setup completes. The shared gesture profile
re-anchors from stillness; Ready requires healthy wand and microphone input.

Say the exact spell name while making the movement. There are no spell buttons and no shared
cooldown between different moves. Every spell looks, moves and lands differently:

| Spell | Movement | Result | Flight | Cooldown |
| --- | --- | --- | --- | --- |
| Stupefy | Firm jab | 14 damage; 25% chance to stun for 1.2 s (no casting) | 0.8 s bolt | 2.5 s |
| Protego | Raise and hold | Block one hit within 1.5 s; raised ≤ 0.35 s before impact it **reflects** the spell back | — | 4 s |
| Expelliarmus | Firm jab | 8 damage, disarms for 2.5 s (no attacks) and **shatters** a raised shield | 1.1 s hook | 6 s |
| Incendio | Firm jab | 22 damage, then burning: 3 damage per second for 4 s | 1.8 s fireball | 9 s |
| Episkey | Raise and hold | Restore up to 22 HP and cure burning | — | 12 s |

Every damaging hit has a 12% chance to be a **critical hit** (×1.5). Healing is capped at 100 HP;
attempting it at full health with no burn spends no cooldown. A disarmed wizard can still shield or
heal; a stunned wizard cannot cast at all until the stun ends. Reaching 0 HP ends the duel; at
90 seconds, higher HP wins and equal HP draws. Simultaneous knockouts can also draw.

**Relics** appear mid-court a few times per round (first at 8–14 s, then every 12–20 s, each
lasting 10 s). The next accepted cast by either wizard claims the relic: the Phoenix Feather resets
every cooldown, the Bezoar restores 20 HP and cures burning, Felix Felicis makes the next hit a
guaranteed critical, the Mirror Charm reflects the next incoming spell within 8 s, and the
Time-Turner halves remaining cooldowns and runs new ones at double speed for 8 s. All rolls come
from one seed per room, so a recorded match replays identically.

**Duel a bot** uses those exact rules against Practice Wizard, an adaptive opponent that
**matches your tempo**: it waits three seconds before acting, then casts at a pace scaled from
your own recent casting rate (Apprentice 1.5x slower than you, Duelist about even, Master 0.85x),
so a player who lands a spell every six seconds faces a rival on a similar clock. It blocks
visible fireballs and hooks on reaction, but a Stupefy bolt is too quick for Apprentice and
Duelist to answer; only the Master sometimes blocks late and reflects it. It shatters a raised
shield with Expelliarmus, heals when hurt and races for relics after a short notice delay. Solo
starts at Duelist, studies harder after you win a round and eases off after it wins. Ready and
Rematch need only you. There is no second device, invitation code or camera step. Your own wand
and microphone still work exactly as they do in multiplayer.

The battle narrates every authoritative event in a creature-battle style log with floating damage
numbers, status chips (SHIELD, MIRROR, DISARMED, STUNNED, BURNING, LUCKY, HASTE), a wand that is
yanked away on a disarm, embers on a burning wizard and screen shake on heavy hits. Motion
preferences are respected: reduced motion keeps the text callouts and drops the animation.

**Story mode** is a 24-level ladder of named bot rivals (`STORY_NAMES` in
`apps/host/phantom_host/duel_bot.py`, portraits and blurbs in `apps/web/src/game/campaign.ts`).
Level 1 is the gentle practice rival; each rung attacks sooner and more often, later rungs add
Incendio and Expelliarmus, raise Protego against incoming bolts, and heal when hurt. Beating a
level unlocks the next one (progress lives in the browser's `localStorage`; Dev mode opens every
level for demos). A win offers **Next** straight into the following rival's room.

Switching laptop tabs aborts an active round while retaining the wand where available;
returning validates fresh input before a new Ready. The stable build does not hot-reload;
restart after source changes. **Ctrl+C** stops the stack.

## Scripted QA

Install the Playwright browser once as described in the setup guide, then run:

```sh
apps/host/.venv/bin/python tools/qa_game.py
```

Windows: `.\apps\host\.venv\Scripts\python.exe .\tools\qa_game.py`.
The suite uses isolated loopback ports `15173`/`18000`, so the live game on
`5173`/`8000` can remain running. Synthetic controls stay in the test harness.
Tests do not certify physical microphones, iPhones, badges, batteries, Windows performance
or two-human play. The [final-sprint report](docs/qa/final-sprint.md) records current results
and open gates; [older platform results](docs/qa/game-platform.md) are historical.

---

## History

Wandduel replaced an earlier prototype, Phantom Arena (stock-firmware Lua badge apps, a serial
gateway badge, webcam markers and a cloud vision call). That code, its tests and its documents
were removed from the tree on September 19, 2026 (commit `530a0ba`); they remain in git history
up to commit `8f49b12` (`git log --all -- badges apps/host/phantom_host/main.py`). Nothing in the current
platform depends on it.
