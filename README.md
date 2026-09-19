# Phantom Arena

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

Badge apps: there is no CLI flashing path. Paste each file in `badges/` into the
[Badge IDE](https://badge.hackthenorth.com/ide/) via **Import app**, then
**Connect → Push**. See [Badge apps](#badge-apps) below.

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

## Badge apps

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

Gesture thresholds live in one clearly marked block at the top of
`phantom_player.lua`. Tune them against the live readout at the bottom of the duel
screen, holding the badge the way you will hold it on stage.

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
