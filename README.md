# Phantom Arena

A multiplayer spell duel that runs on the Hack the North 2026 Hacker Badge itself. Hold A and
draw a spell in the air; the badge recognizes it on-device, the radio carries it to every badge
in range, an elected host badge resolves the battle, screens and LEDs react, and loot is hidden
in NFC shrines around the venue. Install it on a judge's badge over the air in about 20 seconds
and duel them. A laptop shows the arena and an OpenAI game master narrates and mutates the rules.

```
 badge (Lua, 320x240, 6 LEDs, accel, NFC, BLE broadcast)        laptop (Python, browser)
 ┌──────────────────────────────┐   44-byte frames   ┌──────────┐  USB serial  ┌────────────────────┐
 │ phantom_arena                │ ◄────────────────► │ pa_base  │ ───────────► │ phantom-host       │
 │  gestures ─ cast ─ host ─ UI │   H C S E L        │ relay    │  PARX|...    │  arena web view    │
 │  NFC shrine ─ teach ─ deck   │ ◄───── OTA Share ──┤          │              │  OpenAI commentator│
 └──────────────────────────────┘                    └──────────┘              │  ElevenLabs voice  │
                    ▲ NFC tap                                                  │  deck generator ───┼──► deck.txt
                    │                                                          └─────────┬──────────┘
        ┌───────────┴───────────┐                                                        │ decree
        │ shrine stickers       │ ◄──────────────────────── Oracle Altar (Arduino+PN532) ◄┘
        └───────────────────────┘
```

## Repository

| Path | What |
|---|---|
| `badge/phantom_arena/` | the game: `main.lua`, `manifest.cfg`, `deck.txt` (encounter deck), `icon.bin` |
| `badge/pa_base/` | base-station app: relays every frame to USB serial |
| `dist/` | ready-to-paste IDE bundles (`*.lua`, `*.min.lua`), shrine tag plan, icon preview |
| `laptop/phantom_host/` | serial reader, protocol decoder, arena model, web server, commentator, deck generator, altar bridge |
| `laptop/badge_sim/` | a badge simulator: real Lua 5.4 in a sandbox that mirrors the firmware limits |
| `laptop/web/index.html` | the spectator arena (canvas, no build step) |
| `laptop/tests/` | 65 tests: the badge app end to end in the simulator, plus every laptop module |
| `altar/altar.ino` | Oracle Altar: Arduino + PN532 tag writer (compiles with `arduino-cli`) |
| `tools/` | `pack.py` (bundle + limit checks), `nfc_tags.py` (100 sticker payloads), `make_icon.py` |
| `docs/` | protocol, gestures, game master, shrines, demo runbook, Devpost draft, AI build log |
| `solana/` | optional: mint match results as compressed NFTs on devnet |

## Quick start

### 1. Put the game on a badge (2 minutes)

1. Open the [Badge IDE](https://badge.hackthenorth.com/ide/) in desktop Chrome or Edge.
2. **Import app**, paste the whole of `dist/phantom_arena.min.lua` (the readable
   `dist/phantom_arena.lua` also works but leaves no room under the 48 KiB Share cap once a
   bigger deck is installed), **Replace editor files**.
3. Optional: **+** > new file `deck.txt` > paste `badge/phantom_arena/deck.txt`. Optional: **Choose image** > `dist/icon_preview.png`.
4. Badge off, USB data cable in, badge on (do not hold Start). **Connect** > pick *USB JTAG/serial debug unit* > **Push**.
5. Launcher > Phantom Arena > A. First screen: your name and HP, the spell wheel with cooldown arcs,
   and `host YOU`.

### 2. Play

* **Hold A, draw, release A.** Flick up = Lightning, push forward = Fireball, flick down = Ward,
  circle = Vortex, flick left = Heal, flick right = Phase. While holding A you can also press
  UP/B/DOWN/START/LEFT/RIGHT to pick that spell directly (works with no accelerometer).
* **Tap** the badge = Jab (melee, you must be within arm's reach). **Shake** = Burst (area).
  **Screen face-down** = raise a Ward.
* LEFT/RIGHT choose a target (shows live RSSI), UP/DOWN pick an item, B uses it, START opens the
  menu: start a Duel / Team battle / Raid, become the Phantom, switch team, **Teach a spell**,
  **Shrine** (NFC loot), reset. HOME asks before leaving.
* LEDs: charge meter while channeling, red flash on damage, team colour idle, heartbeat under
  25% HP, rainbow on a kill, blue breathing while warded, purple while hidden, gold on decrees.

### 3. Put it on a judge's badge over the air

Sender: **Share > Send an app > Phantom Arena > A: offer app**. Receiver: **Share > Receive an
app > A: accept**. Keep the badges close and still. The whole app directory travels, including
the deck. Bundle: 46 KB minified with icon and deck (cap 48 KiB, 16 files).

### 4. The laptop arena and the game master

```bash
cd laptop
uv sync --extra dev            # Python 3.11+; uv creates .venv
cp .env.example .env           # add OPENAI_API_KEY / ELEVENLABS_API_KEY if you have them (optional)
uv run phantom-host --sim      # no hardware: the real badge Lua plays itself, http://127.0.0.1:8000
uv run phantom-host --port auto   # base-station badge (dist/pa_base.lua) on USB
uv run phantom-deck --theme "haunted library"   # writes badge/phantom_arena/deck.txt (offline: --offline)
```

Open the page, click **enable sound**. The commentator speaks every ~7 s about the events it
actually heard (OpenAI when a key is set, templated lines otherwise; ElevenLabs voice when a key
is set, browser speech otherwise). `--no-ai` makes no network calls at all.

Optional Tier 2: `uv run phantom-host --port auto --altar-port COM7` writes each decree to the
tag on the Oracle Altar (`altar/altar.ino`); tapping it applies the decree on a badge.

## How it works

* **Gesture recognition** (`docs/GESTURES.md`): gravity-subtracted accelerometer peaks become a
  symbol string (`+Y -Y`), matched by edit distance against per-spell templates. Players
  calibrate their own gestures in *Teach a spell* (3 attempts, medoid stored in `badge.store`).
* **Multiplayer on a 44-byte broadcast radio** (`docs/PROTOCOL.md`): five frame kinds, host =
  lowest MAC heard in 3 s, authoritative host with 4 Hz paged snapshots, casts re-sent and
  deduplicated, RSSI-based melee reach / fireball falloff / hidden mages, team and raid modes
  (any badge can become the Phantom with scaled HP and an enrage phase).
* **Game master** (`docs/GAME_MASTER.md`): OpenAI writes an encounter deck into a closed schema;
  the host badge draws cards on low HP, stalemates, a timer and the boss's half-health. The
  laptop narrates live. The altar delivers decrees physically.
* **NFC shrines** (`docs/SHRINES.md`): `pa:loot:e:2` stickers, one pickup per sticker per badge,
  inventory persisted, pickups announced to every badge and counted on the arena page.

## Testing without hardware

`laptop/badge_sim` runs the actual `main.lua` in a Lua 5.4 VM behind the documented badge API:
no `pcall`/`setmetatable`/`os`/`io`/`coroutine`, integer-only coordinates and LED channels,
512 widgets, 1024-byte texts, 32 store keys, 64 KiB fs, 44-byte frames, an 8-slot receive ring
drained 4 per tick, and per-callback time budgets. A `World` gives many badges a shared clock,
a lossy broadcast radio with per-pair RSSI, synthetic gestures, taps, shakes and NFC tags.

```bash
cd laptop && uv run pytest -q     # 65 tests in a few seconds
```

The badge suite covers host election and fail-over, cast dedupe under 35% frame loss, wards,
hiding, melee reach, fireball falloff, area spells, matches with a winner and respawns, team
mode without friendly fire, an 8-badge arena with paged snapshots, a raid with an enraged boss,
decrees from the deck and from an altar tag, shrine loot once per sticker with persistence, and
teaching a gesture that survives a reopen. `tools/pack.py` checks every size cap and scans for
APIs the sandbox lacks.

## Size and memory budget (read before the demo)

| | bytes |
|---|---|
| `main.lua` readable / minified | 43,196 / 40,060 (cap 65,536) |
| Share bundle with deck and icon, readable / minified | 49,104 / 45,968 (cap 49,152) |
| Lua 5.4 bytecode with debug info, 64-bit laptop measurement | 53,225 (smaller on the 32-bit badge) |

The manifest asks for `heap_kb=96`. The badge guide is explicit that the quota is not a
promise of physical RAM: if a launch ever reports `Lua memory limit exceeded`, reboot the badge
and open Phantom Arena first (the firmware releases Bluetooth memory on reboot), and type `heap`
in the IDE console to see the free heap. Everything else about the app degrades gracefully:
radio unavailable becomes practice mode, no accelerometer becomes button casting, NFC is only on
inside the Shrine screen.

## What has and has not been verified

* Verified on this machine: the whole test suite, the arena page running from the simulator, the
  bundle sizes, the deck and tag tools, the Arduino sketch compiling for an Uno.
* Not yet run on a physical badge: everything in `badge/`. The simulator mirrors the documented
  API and limits, not ESP32 timing, LVGL allocation or real BLE. First hour on site: install on
  two badges, cast, Share, then tune `NEAR`/`REVEAL` (RSSI) and `ENTER_MG`/`EXIT_MG` (gesture
  thresholds) at the top of `main.lua` with real hands. `docs/DEMO_RUNBOOK.md` has the checklist.
* `icon.bin` is produced by `tools/make_icon.py` in the LVGL v9 RGB565A8 layout the IDE emits
  (5,304 bytes); if the launcher shows a broken icon, delete it and use the IDE's Choose image.

## Prize map

* **Solana Best Badge Hack**: on-device gesture recognition, host election and RSSI mechanics on a
  44-byte broadcast radio, OTA distribution, NFC loot. All of it is in `badge/`.
* **OpenAI API prizes**: the encounter deck (`phantom-deck`), the live commentator, and the agent
  workflow in `docs/AI_BUILD_LOG.md`.
* **MLH ElevenLabs**: the commentator's voice.
* **Titan Haptics / Solana main prize**: hooks exist (`Hub.hooks` for a wristband bridge,
  `solana/` for cNFT minting) but are not part of the core demo.
