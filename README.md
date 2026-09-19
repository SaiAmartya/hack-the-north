# Wandduel — badge or iPhone + local voice

The player app is a minimal wand setup, calibration/practice and two-player duel.
Stupefy and Protego use real badge or iPhone acceleration plus speech recognized entirely on each
laptop. Python owns combat; video is peer-to-peer and video-only; Three.js draws the spells.
No player-facing simulated wand, diagnostic dashboard, casting buttons or cloud ASR.

Firmware source now matches teammate main `6a50929` exactly. Sai requested discarding
the local 0.1.1/0.1.2 firmware fixes; they are not part of the current firmware tree.
Matching protocol bytes are not proof that your badge is flashed or physically qualified.
See [the latest firmware review](docs/qa/firmware-main-6a50929.md) and
[current platform status](docs/qa/game-platform.md) for the measured/tested boundaries.

- [Approved implementation plan](IMPLEMENTATION-PLAN.md)
- [Current platform checkpoint and QA](docs/qa/game-platform.md)
- [MVP](MVP-OUTLINE.md) · [Firmware contract](BADGE-FIRMWARE-CONTRACT.md)
- [Design system — Wizarding Workshop](DESIGN_SYSTEMS.md)
- [Repository workflow skill](.agents/skills/wand-dev-workflow/SKILL.md)

## Run

After the Python 3.11 environment, web dependencies and local model exist,
run from the repository root (Node 26.5.0 on PATH):

```sh
python3 tools/run_game.py
```

The default launcher builds the web app into a temporary snapshot and serves that
snapshot with Vite preview, so source edits cannot change a running demo. Use
`python3 tools/run_game.py --dev` only when explicit HMR is useful. On Windows use
`py tools/run_game.py`. Open **http://127.0.0.1:5173** in Chrome.
Connect the correct `WAND-xxxx`, enable the microphone, follow calibration, cast each
spell once, enable the camera, then Ready. A second player joins the same referee.
Ctrl+C stops the stack. No legacy workers, API key or specialized badge IDE is used.
A phone is optional; badge play does not require it.

First-time dependencies (Windows Python executable: `.venv\Scripts\python.exe`):

```sh
cd apps/host
python3.11 -m venv .venv
.venv/bin/python -m pip install -e '.[dev,speech]'
cd ../web
npm ci
```

The one-time, explicitly approved model download is separate:

```sh
apps/host/.venv/bin/python tools/setup_speech.py --model-dir "$HOME/.cache/wand-speech/faster-whisper-base.en"
```

This Mac's local model is already provisioned. Runtime uses only local files and in-memory audio.
The launcher shares a fresh secret privately between the local proxy and speech helper; never
put it in `.env`, browser code, URLs or logs.

All services default to loopback. **After approval to expose the referee on the controlled LAN**:
Laptop A runs `python3 tools/run_game.py --referee-bind <A-private-IP>`;
laptop B runs `python3 tools/run_game.py --referee http://<A-private-IP>:8000`.
Both players still open their own `http://127.0.0.1:5173`, and each speech helper stays local.
No certificate installation is needed for this localhost badge workflow. Do not expose a public
port or make blanket firewall exceptions. Windows/Bluetooth/network performance needs real QA.

### iPhone control

The iPhone supplies motion only; its laptop still captures speech and video. The approved
hosted profile uses a dedicated phone-only HTTPS service, not a public game/dev server:

```sh
python3 tools/run_game.py --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file <private-enrollment-file>
```

Open `http://127.0.0.1:5173` on the laptop. Choose **Connect iPhone**, scan the QR with the
iPhone camera, tap **Connect wand**, allow motion, and approve the matching number on the
laptop. Keep Safari foregrounded, portrait and unlocked. No certificate installation is
needed for this profile; internet access is required. Never place the enrollment secret in
the repo, browser code, URLs or logs. Current deployment/QA evidence is in
[the platform checkpoint](docs/qa/game-platform.md); physical iPhone, microphone and
gameplay qualification remain pending.

**Optional private-LAN profile:** requires separate approval for LAN exposure and certificate
installation/trust. With an already trusted certificate for the selected laptop's private IP:

```sh
python3 tools/run_game.py --phone-host <laptop-private-IP> --cert <certificate-path> --key <private-key-path>
```

Open `https://<laptop-private-IP>:5173` on the laptop, choose **Connect iPhone**, then
open `/phone` at that same origin in iPhone Safari. Enter the displayed pairing code
and enable motion. Keep Safari foregrounded, portrait, and unlocked. No simulated
wand is offered in the player interface. Private keys stay outside the repository.
For two laptops, use the explicit referee profiles in [the QA guide](docs/qa/game-platform.md).

## Scripted QA

The game launcher announces **Game ready** only after the frontend, referee and
warmed local speech helper pass health checks. Occupied ports stop startup without
killing other processes; a partial stack is not reported ready.

Run `python3 tools/qa_game.py` from the root, or the individual checks below.
The browser suite starts isolated loopback servers on frontend port `15173` and referee
port `18000`, so the live game on `5173`/`8000` can remain running. Test-only replay/fault
routes are enabled only for that run; the normal player app and production bundle do not
expose them.

```sh
cd apps/web
npm run typecheck
npm test
npm run build
npm exec playwright install chromium
npm run test:e2e
```

First-time dependency/browser installation requires internet. Runtime replay does not.

```sh
cd apps/host
.venv/bin/python -m pytest -q
```

Tests include deterministic raw motion, fusion, real game sockets, combat timing, recovery,
local speech boundaries and legacy regressions. They cannot prove acoustic accuracy, real
badge axes/radio/feedback, Windows behavior or two-human defendability.
The latest full browser run passed 21 tests, including real-Chrome startup-loss
regressions and more than two seconds of production-path fake-microphone capture.
These are automated capture checks, not evidence from a physical microphone.

---

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
