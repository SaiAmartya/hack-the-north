# Wandduel — badge or iPhone + local voice

A two-player, motion-and-voice duel: React/Three.js presentation, a Python referee,
video-only WebRTC and local speech recognition on each laptop. No button casting,
cloud ASR, serial gameplay gateway or badge IDE dependency.

**This is an incomplete development checkpoint, not a qualified demo release.**
The iPhone path now has direct-first Wi-Fi, explicit Internet fallback, visible sensing
and player-started grip calibration. The rebuilt physical gesture detector needs held-out
iPhone testing; an intermittent Internet-relay freshness failure remains open.
Badge source **0.1.9 is diagnostic-only**: it is not gameplay firmware and has not been
flashed or hardware-qualified. Teammate main through `76b6388` is incorporated.
See [current implementation and measured evidence](docs/qa/input-rebuild.md).

- **[Start here: teammate setup](docs/TEAM-SETUP.md)** — fresh-clone macOS/Windows install,
  local speech, iPhone connection, two laptops, checks and troubleshooting.
- **[Badge build, backup and flash instructions](firmware/README.md)** — diagnostic only at this checkpoint.
- [MVP](MVP-OUTLINE.md) · [Implementation plan](IMPLEMENTATION-PLAN.md) · [Firmware contract](BADGE-FIRMWARE-CONTRACT.md)
- [Design system](DESIGN_SYSTEMS.md) · [Repository workflow skill](.agents/skills/wand-dev-workflow/SKILL.md)

## Run an already installed checkout

From the repository root, with Node **26.5.0** on PATH and the Python **3.11** environment
and pinned speech model installed:

```sh
apps/host/.venv/bin/python tools/run_game.py
```

Windows PowerShell:

```powershell
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py
```

Open **http://127.0.0.1:5173** in desktop Chrome. Wait for **Game ready** in the terminal;
this verifies the frontend, referee and warmed local speech helper, not physical gameplay.
The default stable build does not hot-reload; restart after changing source. **Ctrl+C** stops
this stack. Phone onboarding additionally needs the hosted-service flags and approved private
enrollment file in [the setup guide](docs/TEAM-SETUP.md#3-connect-an-iphone).

The current diagnostic badge image is intentionally blocked from casting. Use the iPhone
path for the next physical calibration test; neither physical path is qualified for a demo yet.

## Scripted QA

Install the Playwright browser once as described in the setup guide, then run:

```sh
apps/host/.venv/bin/python tools/qa_game.py
```

Windows: `.\apps\host\.venv\Scripts\python.exe .\tools\qa_game.py`.
The suite uses isolated loopback ports `15173`/`18000`, so the live game on
`5173`/`8000` can remain running. Synthetic controls stay in the test harness.
Tests do not certify physical microphones, iPhones, badges, batteries, Windows performance
or two-human play. The [current evidence report](docs/qa/input-rebuild.md) records exact
results and open gates; [older platform results](docs/qa/game-platform.md) are historical.

---

<details>
<summary>Historical Phantom Arena documentation — not current run instructions</summary>

# Legacy Phantom Arena reference (superseded)

**Historical only:** the following describes the old entry point and architecture.
The default web entry point now opens Wandduel, so these instructions are not
a runnable end-to-end workflow for the new game. Preserve for source archaeology;
follow the implementation plan and current checkpoint above.

A 1v1 mixed-reality spell duel. Two HTN badges are wands, a third badge bridges their
radio traffic to a laptop over USB serial, and the laptop is the single authority for
the match and the only display the audience watches.

```
P1 badge ─┐
P2 badge ─┼─ BLE broadcast ─> gateway badge ─ USB serial ─> Python host ─ ws ─> browser
Chaos    ─┘                                                     │
                                                          webcam + OpenAI
```

## Quick start

Host (authoritative game rules, serial, vision, Director):

```bash
cd apps/host && . .venv/bin/activate && python -m phantom_host.main
```

That entrypoint binds to `127.0.0.1:8000` from `Settings`, which matters because the
websocket carries webcam frames and has no authentication. `uvicorn
phantom_host.main:app --host 127.0.0.1 --port 8000` is equivalent if you prefer the
uvicorn CLI — just never bind it to `0.0.0.0` on venue Wi-Fi.

Web arena (open this on the projector):

```bash
cd apps/web && npm install && npm run dev
```

Badge firmware (the wand): `firmware/` is a native image implementing
[BADGE-FIRMWARE-CONTRACT.md](BADGE-FIRMWARE-CONTRACT.md). Back up, flash and bring up a badge
with `tools/badge_flash.py`; see [firmware/README.md](firmware/README.md). The Lua apps in
`badges/` are the earlier stock-firmware prototype and are no longer the play path.

No badges handy? Run the whole thing against a simulated gateway:

```bash
cd apps/host && . .venv/bin/activate && python ../../tools/fake_gateway.py
```

## Docs

- [Hardware and environment verification](docs/hardware-verification.md) — what was
  checked on the board, and what could not be.
- [MVP design](docs/superpowers/specs/2026-09-19-phantom-arena-mvp-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-19-phantom-arena-implementation.md)
- `badge-app-guide.md` — the authoritative badge API reference. Every badge call in
  this repo was checked against it.

## Demo runbook

Run these in order. The ordering is not cosmetic: **only one process can own the
gateway badge's serial port**, so the IDE has to let go before the host can read.

1. **Push all three badge apps** from the Badge IDE (see below). While doing this,
   note the firmware version each badge prints on screen.
2. **Disconnect the IDE** — click Disconnect or close the tab. Skipping this is the
   single most common reason the host sees nothing.
3. **Start the host:**
   ```bash
   cd apps/host && . .venv/bin/activate
   uvicorn phantom_host.main:app --host 127.0.0.1 --port 8000
   ```
   Confirm `curl http://127.0.0.1:8000/health` shows `"gatewayConnected": true`.
4. **Start the web arena** and put it on the projector:
   ```bash
   cd apps/web && npm run dev
   ```
   The top bar should read `host open`, `gateway up`, `camera live`.
5. **Open the gateway app** on the bridge badge and leave it plugged in and on
   screen for the whole demo.
6. **Open the player app** on both badges, pick a side with `LEFT`/`RIGHT`, confirm
   with `A`.
7. **Both players press `DOWN`** to ready up. The lobby panel fills in, a 3 second
   countdown runs, then the match starts.
8. **Duel.** Gestures or buttons both work. The judge can press `A`/`B`/`START` on
   the chaos badge at any time to change the arena.
9. **Winner screen** appears on the laptop. Press `UP` on the chaos badge to reset
   and run it again.

### If something breaks in the last 30 seconds

| Breaks | What happens | What you do |
| --- | --- | --- |
| Camera | Health plates move to fixed lower corners automatically | Nothing. Say the overlay is marker-anchored when available |
| OpenAI | Deterministic Mana Rain plus local commentary | Nothing. It is the same code path as a timeout |
| A gesture | Nothing visible | Use the mapped button: `A` `B` `START` `UP` |
| Gateway cable | `gateway down` in the top bar, match state preserved | Replug. The host reconnects with backoff and auto-detects the new port |
| A badge sleeps or exits | That badge stops sending | Reopen the app. Apps only run in the foreground |
| Match needs restarting | - | `UP` on the chaos badge, or `curl -X POST localhost:8000/match/reset` |

### No badges? Run the whole thing simulated

```bash
# terminal 1
cd apps/host && . .venv/bin/activate && python ../../tools/fake_gateway.py
# terminal 2 - use the device path it printed
cd apps/host && . .venv/bin/activate
PHANTOM_SERIAL_PORT=/dev/ttys003 uvicorn phantom_host.main:app --host 127.0.0.1 --port 8000
# terminal 3
cd apps/web && npm run dev
```

The simulator plays a full duel on a loop, reset included.

## Badge firmware

The wand is custom firmware, not a Lua app: the stock sandbox cannot run a radio game (Bluetooth
takes the whole shared heap), which the badge's designer confirmed. `firmware/` holds the
PlatformIO project (ESP32-C3, Arduino core 3.x, NimBLE). It implements the GATT service, records,
session rules and feedback defined in [BADGE-FIRMWARE-CONTRACT.md](BADGE-FIRMWARE-CONTRACT.md),
carries an on-badge self-test against the contract's golden vectors (`selftest` on the serial
console), and is flashed and restored with `tools/badge_flash.py`. It runs on hardware: the
first badge was flashed on 2026-09-19 and `tools/wand_ble_check.py` (laptop + `bleak`) walks the
full contract session over real BLE and passes. The browser side lives in
`apps/web/src/lib/wandProtocol.ts` (codec), `wandBle.ts` (Web Bluetooth session client),
`wandSim.ts` (labelled virtual wand) and `motion.ts` (segmentation and calibrated gesture
classification); the **Wand** panel at the top of the web app connects, syncs and exercises
feedback. Full details and the bring-up checklist: [firmware/README.md](firmware/README.md).

## Badge apps (legacy Lua prototype)

There is no CLI flashing path for the badge. Each file in `badges/` is a complete
app in the IDE's single-file format, manifest header included.

1. Open the [Badge IDE](https://badge.hackthenorth.com/ide/) in desktop Chrome or
   Edge, using a USB **data** cable.
2. Click **Import app**, paste the whole contents of one `badges/*.lua` file, check
   the slug in the preview, then **Replace editor files**.
3. Turn the badge off, plug in USB, turn it on normally. **Do not hold Start.**
4. **Connect** → pick **USB JTAG/serial debug unit** (Espressif) → **Push**.
5. Open the app from the launcher with **A**.

| App | Badge | Controls |
| --- | --- | --- |
| `phantom_gateway.lua` | the bridge, stays plugged into the laptop | `A` resets counters |
| `phantom_player.lua` | both player badges | `LEFT`/`RIGHT` pick side, `A` confirm; then `A` fire, `B` shield, `START` slash, `UP` ultimate, `DOWN` ready |

The player badge models **no game rules at all** — no mana, no cooldowns, no phase.
It reads input, rate-limits the radio, sends, and blinks. The laptop decides
everything, so the two can never disagree. Its LEDs mean "cast sent", never "hit".
| `phantom_chaos.lua` | the judge | `A` Meteor, `B` Mana Rain, `START` Double Damage, `UP` reset match |

Four things that will bite you:

- **Leave each app open.** Apps only run in the foreground, so returning to the
  launcher kills the radio listener. All three apps hold `wake_lock=1` so the badge
  will not sleep on its own.
- **Only one process can own the gateway's serial port.** Disconnect the IDE (or
  close the tab) before starting the Python host, or the host cannot read anything.
- **Check the firmware version** shown on each badge's screen. Builds older than
  2026-09-16 allow only 6 ms per tick instead of 250 ms.
- **`radio.enable()` can fail even after a successful push.** Each app says so on
  screen; if it does, reboot the badge.

### Tuning gestures

Thresholds live in one marked block at the top of `phantom_player.lua`. To set them,
plug the **player** badge into the laptop, open the app, and run:

```bash
python tools/badge_monitor.py
```

Every gesture logs its peak magnitude. Swing the badge the way you will on stage,
then read the summary: it reports min/max per gesture and suggests a threshold from
your weakest deliberate motion. Reading real numbers off serial beats squinting at a
320x240 screen mid-swing.

## Tests

```bash
cd apps/host && . .venv/bin/activate && pytest -q
cd apps/web && npm run build
```

200 host tests cover the packet parser, the deduper, every game rule, serial
reconnect, marker loss, the Director's fallbacks, and the resilience paths in the
table above. `tests/test_badge_apps.py` additionally validates the three Lua apps
against `badge-app-guide.md`: manifest keys, the sandbox's missing built-ins, the
documented `badge.*` API surface, payload sizes, and `luac -p` syntax.

Marker sheets and camera pre-flight:

```bash
python tools/make_markers.py     # writes assets/markers/
python tools/check_camera.py     # triggers the macOS camera permission prompt
```

## What is not verified on hardware

No badge was attached while this was built, so radio range, gesture thresholds,
and real end-to-end latency are **unverified on a physical badge**. Everything
else is covered by the automated suite plus a simulated gateway over a pty. See
[docs/hardware-verification.md](docs/hardware-verification.md) for the full list
and the pre-flight checklist.

</details>
