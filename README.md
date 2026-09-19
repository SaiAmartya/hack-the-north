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

## Tests

```bash
cd apps/host && . .venv/bin/activate && pytest -q
cd apps/web && npm run build
```
