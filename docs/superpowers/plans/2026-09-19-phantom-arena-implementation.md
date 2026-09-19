# Phantom Arena Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependable 1v1 mixed-reality spell duel in which two HTN badges send motion-triggered spell events to a laptop, the laptop renders a webcam-anchored arena, and an OpenAI-powered Arena Director adds safe, validated twists.

**Architecture:** Player and judge badges broadcast short packets over the badge's restricted Lua BLE channel. A dedicated gateway badge prints every received packet over USB serial. A Python host parses and de-duplicates packets, owns all game rules, reads webcam marker positions, and publishes a single authoritative state stream to a React canvas client. The OpenAI Director proposes only enum-constrained arena modifiers; the deterministic host validates every proposal and remains authoritative for health and victory.

**Tech Stack:** HTN Badge Lua (`api=2`), `badge.radio` BLE broadcast channel, Python 3.11, FastAPI, Pydantic, pyserial, OpenCV-contrib, OpenAI Python SDK, pytest, React, Vite, TypeScript, Canvas 2D.

**Spec:** [../specs/2026-09-19-phantom-arena-mvp-design.md](../specs/2026-09-19-phantom-arena-mvp-design.md) — this link resolves only once this plan lives at `docs/superpowers/plans/`. Create the spec file or drop the link before starting Task 1.

**Badge API reference:** `badge-app-guide.md` at the repo root is the authoritative badge API brief. Every badge fact in this plan was checked against it. Do not invent badge APIs; if something is not in that guide, it does not exist.

## Verified Badge Constraints (read before Tasks 4-5)

These are quoted or derived from `badge-app-guide.md`. They are not negotiable and several of them killed an earlier draft of this plan.

- **The radio is BLE, not ESP-NOW.** `badge.radio` is a "restricted Lua channel"; firmware prepends a `LUA1` prefix and filters RX to it. There is no channel, peer, or pairing API. `badge.radio.mac()` is a BLE address and `disable()` is deferred because "BLE teardown takes ~2 s".
- **API surface:** `badge.radio.enable() -> bool`, `badge.radio.send(payload) -> bool` (1–44 bytes, true means *queued*, not delivered), `badge.radio.on_recv(function(mac, rssi, payload) end)`, `badge.radio.mac()`, `badge.radio.dropped()`. Note `on_recv` takes **three** arguments.
- **Shared channel.** Every Lua app on every nearby badge uses the same channel. The `PA1|` prefix filter is load-bearing, not cosmetic. RX is an 8-slot ring drained at most 4 frames per tick; overflow is counted by `dropped()`.
- **No sleeping.** There is no `sleep`, busy waits are forbidden, and `coroutine` is absent. Any delay between repeated sends must be a queue drained across `on_tick` using `badge.sys.ms()`.
- **Sandbox omissions:** no `pcall`, `xpcall`, `setmetatable`, `load`, `require` (for our single-file apps), `os`, `io`, `debug`, `coroutine`. Check return values; you cannot wrap a call defensively.
- **Foreground only.** "Apps run only while in the foreground; a timer or radio listener does not keep running after returning HOME." Every badge app here sets `wake_lock=1` and must stay open for the whole demo.
- **HOME is not a usable game button.** Its Pressed is swallowed by the HOME-button intercept and its default action exits the app. Usable buttons: `A B DOWN LEFT RIGHT UP AUX1 START`.
- **Firmware matters.** The 250 ms tick / 3,000 ms `on_enter` budgets arrive with firmware dated 2026-09-16. Earlier firmware allows **6 ms** ticks, and `api=2` does not reveal which is installed. Check `badge.sys.version()` on all four badges first.
- **`badge.sys.log` is tagged with the app slug**, so serial lines always carry a prefix. `badge.sensor.accel()` returns milligravity or `nil + err`. `badge.sensor.shake()` and `badge.sensor.tap()` have firmware-provided refractory periods.
- **Badge apps are installed through the browser IDE only** (Import app → Replace editor files → Connect → Push over WebSerial in Chrome/Edge). There is no CLI flashing path. Store each app in the single-file format with its `--[==[badge-app ... ]==]` manifest header. `main.lua` must stay under 64 KiB; heap is 48 KB by default.

## Global Constraints

- Treat the laptop host as the only authority for health, damage, match phase, and winner. The badge radio path is one-way into the laptop.
- Never depend on badge-to-badge display synchronization. Badges show local cast, mana, and cooldown feedback only. Because `send` reports *queued*, badge feedback means "cast sent", never "hit landed".
- All actionable packets use ASCII `PA1|sender|kind|value|sequence`, remain at or below 44 bytes, and are transmitted three times spaced roughly 40 ms apart by a tick-driven queue. The host de-duplicates `(sender, sequence)` for two seconds.
- The gateway logs `badge.sys.log(mac .. " " .. payload)` — **MAC first**. Appending the MAC after the payload would corrupt the sequence field. The host extracts from `PA1|` to end of line and may optionally capture the leading MAC.
- CV uses unique physical AprilTag/ArUco markers on the players to anchor status overlays. It is visual presentation, not the sole source of hit detection in the MVP.
- The Director receives compact, non-identifying game state only. Its JSON is validated against a closed enum; invalid, late, or unavailable responses use a deterministic fallback.
- The host binds to `127.0.0.1` only. The websocket streams webcam frames and has no authentication; binding `0.0.0.0` on venue Wi-Fi would expose the camera feed to the LAN.
- No database, blockchain transaction, account creation, Wi-Fi, HTTP-from-badge, or arbitrary Bluetooth protocol is part of the MVP.

## Review Focus

- Malformed or duplicate radio packets must never apply a spell twice.
- USB serial disconnects must retry without crashing the web client.
- Game rules must reject casts during cooldown, at zero mana, or after the match ends.
- Marker loss or marker-ID swaps must degrade to a neutral on-screen HUD rather than incorrect player attribution.
- An OpenAI timeout, malformed JSON, or unsupported modifier must leave the match playable.
- A badge that sleeps, exits to HOME, or fails `radio.enable()` must be visibly diagnosable rather than silently dead.
- Only one process may own the gateway's serial port. Pushing from the IDE and running the host simultaneously will fail.

---

## File Structure

```text
phantom-arena/
├── apps/
│   ├── host/
│   │   ├── pyproject.toml
│   │   ├── .env.example
│   │   ├── phantom_host/
│   │   │   ├── config.py
│   │   │   ├── contracts.py
│   │   │   ├── protocol.py
│   │   │   ├── dedup.py
│   │   │   ├── game.py
│   │   │   ├── serial_gateway.py
│   │   │   ├── vision.py
│   │   │   ├── arena_director.py
│   │   │   ├── broadcaster.py
│   │   │   └── main.py
│   │   └── tests/
│   │       ├── test_contracts.py
│   │       ├── test_protocol.py
│   │       ├── test_dedup.py
│   │       ├── test_game.py
│   │       ├── test_serial.py
│   │       ├── test_vision.py
│   │       ├── test_director.py
│   │       └── test_api.py
│   └── web/
│       ├── package.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── types.ts
│           ├── hooks/useArenaSocket.ts
│           ├── components/ArenaStage.tsx
│           ├── components/Hud.tsx
│           ├── components/EventBanner.tsx
│           └── lib/drawArena.ts
├── badges/                      # single-file IDE format, manifest header included
│   ├── phantom_player.lua       # one app, side selected on device
│   ├── phantom_gateway.lua
│   └── phantom_chaos.lua
├── assets/markers/
│   ├── p1-marker.png
│   ├── p2-marker.png
│   └── print-sheet.pdf
├── docs/
│   └── superpowers/
│       ├── specs/2026-09-19-phantom-arena-mvp-design.md
│       └── plans/2026-09-19-phantom-arena-implementation.md
├── badge-app-guide.md
└── README.md
```

## Core Interfaces

```python
# apps/host/phantom_host/contracts.py
class RadioEvent(BaseModel):
    sender: Literal["P1", "P2", "J"]
    kind: Literal["CAST", "EVT", "READY"]
    value: str
    sequence: int = Field(ge=0, le=255)
    received_at_ms: int
    mac: str | None = None          # from the gateway log, for optional pinning

class PlayerState(BaseModel):
    id: Literal["P1", "P2"]
    health: int = Field(ge=0, le=100)
    mana: int = Field(ge=0, le=100)         # floor() of the internal float
    cooldown_until_ms: dict[str, int] = Field(default_factory=dict)
    shield_until_ms: int = 0
    ready: bool = False

class Effect(BaseModel):
    type: Literal["cast", "damage", "shield_absorb", "modifier", "reject",
                  "phase", "win"]
    player: Literal["P1", "P2"] | None = None
    spell: str | None = None
    amount: int | None = None
    note: str | None = None

class ArenaState(BaseModel):
    phase: Literal["lobby", "countdown", "playing", "finished"]
    players: dict[str, PlayerState]
    modifier: Literal["none", "meteor", "mana_rain", "double_damage"] = "none"
    modifier_until_ms: int = 0
    countdown_ends_ms: int = 0
    started_at_ms: int = 0
    winner: Literal["P1", "P2"] | None = None

class MarkerPose(BaseModel):
    player_id: Literal["P1", "P2"]
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    visible: bool
```

Mana is stored internally as a float accumulator and exposed as `floor()`. At 8 mana/second on a 10 Hz tick, integer arithmetic would add 0 every tick and regeneration would never happen.

```typescript
// apps/web/src/types.ts
export type ArenaEnvelope = {
  type: "state";
  state: ArenaState;
  markers: Record<"P1" | "P2", MarkerPose>;
  effects: Effect[];            // emitted since the last envelope; drives animation
  directorCommentary?: string;
  frameJpegBase64?: string;     // present only on frame-carrying envelopes
};
```

## Packet Vocabulary

| Sender | Kind | Value | Meaning |
| --- | --- | --- | --- |
| `P1`/`P2` | `READY` | `1` | Player is ready in lobby |
| `P1`/`P2` | `CAST` | `F` `S` `A` `U` | Fireball, Shield, Arc Slash, Ultimate |
| `J` | `EVT` | `MET` | Meteor: 12 damage to both players once, shields apply |
| `J` | `EVT` | `MANA` | Mana Rain: +40 mana to both players once, clamped to 100 |
| `J` | `EVT` | `DBL` | Double Damage: all spell damage x2 while active |
| `J` | `EVT` | `RST` | Reset the match back to lobby |

`PA1|P1|CAST|F|17` is 17 bytes, well inside the 44-byte cap.

## Task 1: Establish the Repository and Shared Contracts

**Files:** `README.md`, `apps/host/pyproject.toml`, `apps/host/phantom_host/contracts.py`, `apps/host/tests/test_contracts.py`, `apps/web/package.json`, `apps/web/src/types.ts`, `.gitignore`

- [ ] Initialize the project and Python environment: `git init`, `cd apps/host`, then use `uv` or `python -m venv .venv` to install `fastapi`, `uvicorn`, `pydantic`, `pyserial`, `opencv-contrib-python`, `openai`, and `pytest`.
- [ ] Write `.gitignore` covering `.env`, `.venv/`, `__pycache__/`, `node_modules/`, `dist/`, and `*.jpg` capture dumps. Confirm `.env` is ignored before any key exists.
- [ ] Write the failing contract test first: construct `RadioEvent(sender="P1", kind="CAST", value="F", sequence=17, received_at_ms=0)`, assert `sequence=256` raises `ValidationError`, and assert `PlayerState(id="P1", health=100, mana=100)` works with no explicit `cooldown_until_ms`.
- [ ] Run `cd apps/host && pytest -q tests/test_contracts.py`; confirm it fails because `contracts.py` does not exist.
- [ ] Add the Pydantic contracts above, including `Effect`, and the matching TypeScript `ArenaState`/`MarkerPose`/`Effect`/`ArenaEnvelope` definitions. Run the same command until green.
- [ ] Add a root README with one command each for host and web, and a pointer to the badge IDE flow for badge apps (there is no badge CLI).
- [ ] Commit: `git add . && git commit -m "chore: scaffold Phantom Arena contracts"`.

## Task 2: Make Radio Packets Safe and Testable

**Files:** `apps/host/phantom_host/protocol.py`, `apps/host/phantom_host/dedup.py`, `apps/host/tests/test_protocol.py`, `apps/host/tests/test_dedup.py`

- [ ] Define `parse_radio_line(line: str, received_at_ms: int) -> RadioEvent | None`. It must find `PA1|` anywhere in a serial line, take everything from there to end of line, strip trailing `\r`/whitespace, require exactly five fields, accept only known senders/kinds, **catch `ValidationError` and return `None`** rather than propagate, and capture a leading `AA:BB:..` MAC into `mac` when present.
- [ ] Define `PacketDeduper.accept(event: RadioEvent) -> bool`, initialized with `window_ms: int = 2000`; it returns false for a duplicate `(sender, sequence)` inside the window and true after expiry. Evict expired keys so the dict cannot grow without bound.
- [ ] Write failing tests for all required cases:

```python
assert parse_radio_line("[phantom_gateway] AA:BB:CC:DD:EE:FF PA1|P1|CAST|F|17\r\n", 10).value == "F"
assert parse_radio_line("[phantom_gateway] PA1|P1|CAST|F|17", 10).mac is None
assert parse_radio_line("PA1|P1|CAST|F|999", 10) is None   # sequence out of range
assert parse_radio_line("PA1|P1|CAST|F", 10) is None       # too few fields
assert parse_radio_line("PA1|XX|CAST|F|1", 10) is None     # unknown sender
assert parse_radio_line("no packet here", 10) is None
```

- [ ] Add a dedupe test that accepts the first `P1/17`, rejects its immediate retry, and accepts it again at `received_at_ms + 2001`.
- [ ] Note in a code comment that a badge reboot mid-match resets its sequence to 0 and can theoretically collide inside the 2 s window. Accepted risk for the MVP; do not add a boot nonce unless it is observed.
- [ ] Run `pytest -q tests/test_protocol.py tests/test_dedup.py`; confirm red, implement the parser/deduper, then confirm green.
- [ ] Commit: `git commit -am "feat: parse and dedupe badge radio events"`.

## Task 3: Build the Deterministic Game Engine

**Files:** `apps/host/phantom_host/game.py`, `apps/host/tests/test_game.py`

- [ ] Define `new_match(now_ms: int) -> ArenaState`, `apply_event(state, event, now_ms) -> list[Effect]`, and `tick(state, now_ms) -> list[Effect]`. `new_match` returns `phase="lobby"`.
- [ ] Implement the full phase machine, because nothing else in the plan starts a match: `READY` from both players in `lobby` starts a 3,000 ms `countdown`; `tick` promotes `countdown` to `playing` when `countdown_ends_ms` passes; health reaching 0 sets `phase="finished"` and `winner`; `EVT/RST` returns to `lobby` from any phase. Emit `phase` and `win` effects on every transition.
- [ ] Use these exact initial values: 100 health, 100 mana, mana regeneration of 8 per second held in a float accumulator, and no active modifier. Spell rules: `F` costs 20/does 18 damage/900 ms cooldown; `S` costs 15/sets a 1,200 ms shield/1,400 ms cooldown; `A` costs 10/does 10 damage/500 ms cooldown; `U` costs 60/does 35 damage/5,000 ms cooldown. A live shield negates one incoming spell, then clears `shield_until_ms` to 0 so it cannot absorb twice.
- [ ] Implement `EVT` handling per the Packet Vocabulary table. `MET` and `MANA` apply once immediately but still set `modifier`/`modifier_until_ms` so the banner has something to show. `DBL` doubles both players' outgoing spell damage while active. `tick` clears an expired modifier back to `none`.
- [ ] Define `apply_directive(state, directive, now_ms) -> list[Effect]` as the single validated entry point the Director must pass through. It re-checks the modifier enum and the 3,000–8,000 ms duration and ignores anything else.
- [ ] Write failing tests for: a valid Fireball; a shield-negated Fireball followed by a second Fireball that lands; insufficient mana; cooldown rejection; a finished match rejecting subsequent casts; both-ready starting a countdown; a single READY not starting one; `RST` returning to lobby; mana regeneration actually increasing mana across ten 100 ms ticks; and `DBL` doubling Fireball damage to 36.
- [ ] Implement only enough deterministic logic for those tests. Effects are JSON-friendly, e.g. `{"type":"cast","player":"P1","spell":"F"}`.
- [ ] Run `pytest -q tests/test_game.py`; confirm green.
- [ ] Commit: `git commit -am "feat: add authoritative duel rules"`.

## Task 4: Flash the Gateway and Chaos Badges First

**Files:** `badges/phantom_gateway.lua`, `badges/phantom_chaos.lua`, `README.md`

- [ ] **Before writing Lua:** open each of the four badges and record `badge.sys.version()`. If any badge predates the 2026-09-16 firmware it has a 6 ms tick budget, not 250 ms; note it and keep that badge's per-tick work minimal or update it.
- [ ] Write both apps in the single-file format with `api=2`, `heap_kb=48`, **`wake_lock=1`**, and unique non-built-in slugs (`phantom_gateway`, `phantom_chaos`).
- [ ] Implement the gateway as a deliberately boring bridge: call `badge.radio.enable()` in `on_enter` and show "Radio unavailable" on screen if it returns false. Register `badge.radio.on_recv(function(mac, rssi, payload) ... end)` — three arguments — and emit `badge.sys.log(mac .. " " .. payload)` only when `payload:sub(1, 4) == "PA1|"`. MAC first; appending it would corrupt the sequence field.
- [ ] Have the gateway display a received counter and log `badge.radio.dropped()` every few seconds. The channel is shared with every other team's Lua app, so ring overflow is a real venue failure mode and must be visible.
- [ ] Do not call `badge.radio.on_recv(nil)` from inside the handler; tear down in `on_exit` with `on_recv(nil)` then `badge.radio.disable()`.
- [ ] Implement the chaos badge menu: `A` sends Meteor (`PA1|J|EVT|MET|seq`), `B` sends Mana Rain (`...|MANA|...`), `START` sends Double Damage (`...|DBL|...`), and `UP` sends Reset (`...|RST|...`). Increment the 0–255 sequence with wraparound after each action.
- [ ] Write the shared send helper as a **tick-driven queue**, not a delay loop: `queue_send(payload)` stores the payload with `repeats_left = 3` and `next_at = badge.sys.ms()`, and `on_tick` sends at most one copy per pass, advancing `next_at` by 40 ms. There is no `sleep`, no busy waiting, and no `coroutine`. Skip missed slots using current time instead of replaying them.
- [ ] Install both apps through the IDE (Import app → check slug → Replace editor files → Connect → Push), then open the IDE serial console and verify one logged gateway line after pressing `A` on Chaos.
- [ ] Record in README: the badge IDE flow, the tested `/dev/cu.usbmodem*` device for the gateway, and the warning that the IDE must be disconnected before the Python host can open that port. Do not hard-code a port in Lua.
- [ ] Commit: `git add badges README.md && git commit -m "feat: add gateway and chaos badge apps"`.

## Task 5: Implement the Player Badge App

**Files:** `badges/phantom_player.lua`, `README.md`

- [ ] Ship **one** app (`slug=phantom_player`, `wake_lock=1`) rather than two near-identical files. On first run show a side-select screen; persist the choice with `badge.store.set_str("side", "P1")` and allow changing it with `LEFT`/`RIGHT` before the duel. This halves flashing work and stops two copies drifting apart.
- [ ] Maintain `mana`, per-spell cooldown timestamps, `sequence`, and an accelerometer baseline. Reuse the Task 4 tick-driven send queue verbatim.
- [ ] Sample `badge.sensor.accel()` on a timestamped interval inside `on_tick` (readings are already cached at 50 Hz; do not busy-sample). It returns milligravity and `nil + err` — when it returns nil, hide the gesture UI and show "Accelerometer unavailable" as the tilt-level example does, while leaving buttons working.
- [ ] Gesture mapping: forward acceleration for Fireball `F`, upward impulse for Shield `S`, lateral impulse for Arc Slash `A`, and `badge.sensor.shake()` with at least 60 mana for Ultimate `U`.
- [ ] Check `shake()` **first** and apply a single **global** refractory period across all four gestures. A shake energetic enough to trip `shake()` will also cross the forward/upward/lateral thresholds, so per-gesture refractory alone will double-fire.
- [ ] Button fallback, phase-dependent and avoiding HOME entirely: in lobby `A` sends `READY`; in play `A=F`, `B=S`, `START=A`, `UP=U`. **Do not map HOME** — its Pressed is swallowed by the HOME intercept and its default action exits the app mid-duel. Buttons and gestures both call the same `cast(spell)` function.
- [ ] Make `cast(spell)` enforce local mana/cooldown, queue the triple packet, update the screen, and play its colour effect on the six LEDs: orange chase, cyan shield, purple sweep, and a white/full-colour Ultimate burst. Label the feedback as "sent" — `radio.send` reports queued, never delivered, so the badge must not imply a landed hit. Clear LEDs in `on_exit`.
- [ ] Test with both player badges next to the gateway: verify the serial log shows two distinct senders with increasing sequences, then tune thresholds in the same physical orientation used on stage.
- [ ] Commit: `git add badges && git commit -m "feat: add player spell controller"`.

## Task 6: Connect USB Serial to a Minimal Authoritative API

**Files:** `apps/host/phantom_host/config.py`, `apps/host/phantom_host/serial_gateway.py`, `apps/host/phantom_host/broadcaster.py`, `apps/host/phantom_host/main.py`, `apps/host/tests/test_serial.py`, `apps/host/tests/test_api.py`, `apps/host/.env.example`

- [ ] Add `Settings` with `serial_port`, `serial_baudrate`, `camera_index`, `openai_model`, and `openai_api_key`. Read secrets only from environment variables; `.env.example` contains names but no values.
- [ ] Make `serial_port` optional and auto-detect through `serial.tools.list_ports` by VID/PID, preferring `/dev/cu.usbmodem*`. macOS renumbers the device on replug, and a hard-coded port is a predictable demo failure.
- [ ] Define `SerialGateway.run(on_line: Callable[[str], None]) -> None`; it reconnects with capped exponential backoff when `serial.SerialException` occurs, and treats a port held by the badge IDE as the same recoverable condition.
- [ ] Define `ArenaBroadcaster.publish(envelope: dict) -> None` and a FastAPI `GET /health`, `POST /match/reset`, plus `WebSocket /ws/arena`. `/health` returns phase and gateway-connected status. `POST /match/reset` is the operator path that does not depend on the chaos badge being alive.
- [ ] Expose `host.handle_line(line: str)` as the test seam so the pipeline can be driven without hardware.
- [ ] Bind uvicorn to `127.0.0.1` explicitly. The socket is unauthenticated and will carry webcam frames.
- [ ] Write failing tests: `test_serial.py` covers backoff and reconnect-after-`SerialException` with a fake serial object; `test_api.py` uses FastAPI `TestClient` to assert `/health` returns 200 with `gateway_connected`, then feeds `handle_line("PA1|P1|CAST|F|1")` and asserts the next websocket envelope shows the changed health and a `cast` effect.
- [ ] Implement the in-memory host loop: serial line → parser → deduper → `apply_event` → broadcaster. Accumulate effects and flush them with each envelope. Publish state on change rather than waiting for a camera frame.
- [ ] Run `pytest -q tests/test_serial.py tests/test_api.py`, then manually `curl http://localhost:8000/health` with the gateway connected and disconnected.
- [ ] Commit: `git commit -am "feat: stream authoritative arena state"`.

## Task 7: Render the Laptop Arena

**Files:** `apps/web/src/App.tsx`, `apps/web/src/hooks/useArenaSocket.ts`, `apps/web/src/components/ArenaStage.tsx`, `apps/web/src/components/Hud.tsx`, `apps/web/src/components/EventBanner.tsx`, `apps/web/src/lib/drawArena.ts`

Renderer comes before computer vision so there is something visible to debug against. It runs against fixed corner HUDs, which is also the documented camera-failure fallback, making Task 8 purely additive.

- [ ] Create `useArenaSocket(url: string)` returning the most recent `ArenaEnvelope`, connection state, and reconnect with bounded exponential backoff.
- [ ] Render the full arena against fixed corner HUD positions first, ignoring marker coordinates. Verify a cast seen on serial changes the correct HUD.
- [ ] Write a small component test or manual fixture that renders two players at fixed coordinates and verifies P1 is red, P2 is blue, and health text is visible.
- [ ] Place a compact nameplate, health bar, mana bar, shield icon, and last-cast label per player. Add the lobby/countdown/finished panels, including a large laptop-only winner screen and a visible "waiting for P1/P2 ready" lobby state.
- [ ] Animate from the envelope's `effects` array, but never calculate game rules in TypeScript. The web client only renders the host's state.
- [ ] Run `npm run dev` and verify a badge cast reaches the correct HUD within one second.
- [ ] Commit: `git add apps/web && git commit -m "feat: render duel HUD"`.

## Task 8: Add Camera Tracking and a Safe Fallback HUD

**Files:** `apps/host/phantom_host/vision.py`, `apps/host/tests/test_vision.py`, `assets/markers/`, `apps/web/src/components/ArenaStage.tsx`

- [ ] Generate and print two distinct ArUco markers with fixed IDs `17 → P1` and `23 → P2`. Put each on the corresponding player's lanyard, shirt, or controller so it is visible to the laptop camera.
- [ ] Define `MarkerTracker.update(frame: np.ndarray) -> dict[str, MarkerPose]`; normalize marker centers to 0–1 and report `visible=False` when a player's marker is absent. Always return both keys.
- [ ] Write a failing unit test using an image containing marker 17; assert P1 is visible and P2 is not. Add a test with no marker that returns two invisible, neutral poses.
- [ ] Implement OpenCV ArUco detection and publish one JPEG frame plus marker poses at 10 fps, on a cadence independent of state updates. Cap image width at 960 px before base64 encoding.
- [ ] Ensure the host retains `visible=False` for a missing marker instead of reusing a stale position.
- [ ] Extend `ArenaStage` to anchor each HUD above its visible marker and fall back to the Task 7 fixed corner position when `visible=false`.
- [ ] Pre-flight the macOS camera permission: OpenCV capture from a terminal needs Camera access granted to Terminal/iTerm, and the first-run prompt can fail quietly. Confirm a frame arrives before demo day.
- [ ] Run `pytest -q tests/test_vision.py`, then verify a live webcam shows neutral corner HUDs when both markers are out of frame.
- [ ] Commit: `git add apps/host assets/markers apps/web && git commit -m "feat: track player markers for arena overlay"`.

## Task 9: Add a Validated OpenAI Arena Director

**Files:** `apps/host/phantom_host/arena_director.py`, `apps/host/tests/test_director.py`, `apps/host/phantom_host/game.py`

- [ ] Define `ArenaDirective` as a Pydantic model: `modifier` is exactly one of `meteor`, `mana_rain`, or `double_damage`; `duration_ms` is 3,000–8,000; `commentary` is at most 120 characters.
- [ ] Define `request_directive(state, markers) -> ArenaDirective`. Give the model compact game data (health, mana, last spells, current modifier, elapsed round time), request JSON only, and apply a five-second timeout.
- [ ] Request the **first** directive 6 seconds after `playing` begins, then every 20 seconds. A duel is mana-limited to roughly one Fireball every 2.5 s, so 100 health can fall in about 15 seconds — a 20 s first request can mean the Director never fires at all, which would fail the MVP checklist.
- [ ] Route every directive through `game.apply_directive` before it can change `ArenaState`. The Director never mutates state directly.
- [ ] Write failing tests with a fake OpenAI client for: valid Meteor JSON, invalid modifier, malformed JSON, and timeout. The last three must return the deterministic fallback `mana_rain` for 3,000 ms with local commentary.
- [ ] Render the commentary in `EventBanner` via `directorCommentary`. Label it "Arena Director", not an authoritative referee.
- [ ] Run `pytest -q tests/test_director.py` without a real API key, then test one live request with a key before the demo.
- [ ] Commit: `git commit -am "feat: add safe OpenAI arena director"`.

## Task 10: Rehearse the Demo and Harden the Failure Paths

**Files:** `README.md`, `apps/host/tests/*`

- [ ] Write the judge-run sequence in README, in this order, because the serial port has a single owner: push all badge apps from the IDE → **disconnect the IDE / close the tab** → start the host → start the web client → confirm the camera → plug in the gateway badge and open its app → open both player apps and pick sides → both players press `A` to ready → run one round → show the winner screen → press `UP` on Chaos to reset and run it again.
- [ ] Verify the whole flow twice back to back. `EVT/RST` and `POST /match/reset` both have to return a finished match to lobby with no code edit or restart.
- [ ] Add tests for a late duplicate packet, serial reconnect state, cast after match finish, marker disappearance, Director fallback, and reset-from-finished. Run everything with `cd apps/host && pytest -q`.
- [ ] Stage-test end-to-end latency with real hardware. Target badge action to laptop HUD update under one second, with no double damage after a three-send burst. Watch the gateway's `dropped()` readout during a busy moment on the venue floor.
- [ ] Prepare the 30-second resilience fallbacks: camera fails → fixed corner HUDs (already the Task 7 default); OpenAI fails → deterministic Mana Rain; gesture unreliable → its mapped button; badge screen blank or exited → reopen the app, since a backgrounded app stops receiving and sending.
- [ ] Run `npm run build` in `apps/web` and the full pytest suite one final time. Fix every failing check before the demo.
- [ ] Commit: `git commit -am "docs: add demo runbook and reliability checks"`.

## MVP Completion Checklist

- [ ] All four badges run current firmware, or known-older badges have been verified against the 6 ms tick budget.
- [ ] P1 and P2 can each produce a distinct cast packet that reaches the gateway serial log.
- [ ] A duplicate retry cannot deduct health twice.
- [ ] Both players readying starts a countdown and then a match, with no manual host intervention.
- [ ] The host can run a full 100-to-0 duel and declare one laptop-only winner.
- [ ] A finished match can be reset and replayed from the chaos badge without touching code.
- [ ] The webcam HUD tracks both player markers and degrades safely when either is absent.
- [ ] The Chaos badge visibly changes the arena.
- [ ] The Director's valid response appears as commentary within the length of a real duel; its failure fallback is demonstrable with networking off.
- [ ] The live judge flow completes in two minutes without a manual code edit.
