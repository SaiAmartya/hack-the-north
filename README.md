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
cd apps/host && . .venv/bin/activate && uvicorn phantom_host.main:app --host 127.0.0.1 --port 8000
```

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
