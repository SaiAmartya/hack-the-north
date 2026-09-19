# Phantom Arena Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependable 1v1 mixed-reality spell duel in which two HTN badges send motion-triggered spell events to a laptop, the laptop renders a webcam-anchored arena, and an OpenAI-powered Arena Director adds safe, validated twists.

**Architecture:** Player and judge badges send short ESP-NOW radio packets. A dedicated gateway badge prints every received packet over USB serial. A Python host parses and de-duplicates packets, owns all game rules, reads webcam marker positions, and publishes a single authoritative state stream to a React canvas client. The OpenAI Director proposes only enum-constrained arena modifiers; the deterministic host validates every proposal and remains authoritative for health and victory.

**Tech Stack:** HTN Badge Lua (`api=2`), ESP-NOW radio, Python 3.11, FastAPI, Pydantic, pyserial, OpenCV-contrib, OpenAI Python SDK, pytest, React, Vite, TypeScript, Canvas 2D.

**Spec:** [../specs/2026-09-19-phantom-arena-mvp-design.md](../specs/2026-09-19-phantom-arena-mvp-design.md)

## Global Constraints

- Treat the laptop host as the only authority for health, damage, match phase, and winner. The badge radio path is one-way into the laptop.
- Never depend on badge-to-badge display synchronization. Badges show local cast, mana, and cooldown feedback only.
- All actionable packets use ASCII `PA1|sender|kind|value|sequence`, remain at or below 44 bytes, and are transmitted three times over roughly 120 ms. The host de-duplicates `(sender, sequence)` for two seconds.
- The gateway badge logs the raw packet with `badge.sys.log`; the Python host extracts the `PA1|` substring because serial output may contain additional badge log prefixes.
- CV uses unique physical AprilTag/ArUco markers on the players to anchor status overlays. It is visual presentation, not the sole source of hit detection in the MVP.
- The Director receives compact, non-identifying game state only. Its JSON is validated against a closed enum; invalid, late, or unavailable responses use a deterministic fallback.
- No database, blockchain transaction, account creation, Wi-Fi, or arbitrary Bluetooth protocol is part of the MVP.

## Review Focus

- Malformed or duplicate radio packets must never apply a spell twice.
- USB serial disconnects must retry without crashing the web client.
- Game rules must reject casts during cooldown, at zero mana, or after the match ends.
- Marker loss or marker-ID swaps must degrade to a neutral on-screen HUD rather than incorrect player attribution.
- An OpenAI timeout, malformed JSON, or unsupported modifier must leave the match playable.

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
│   │       ├── test_protocol.py
│   │       ├── test_dedup.py
│   │       ├── test_game.py
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
├── badges/
│   ├── player-p1/main.lua
│   ├── player-p2/main.lua
│   ├── gateway/main.lua
│   └── chaos/main.lua
├── assets/markers/
│   ├── p1-marker.png
│   ├── p2-marker.png
│   └── print-sheet.pdf
├── docs/
│   └── superpowers/
│       ├── specs/2026-09-19-phantom-arena-mvp-design.md
│       └── plans/2026-09-19-phantom-arena-implementation.md
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

class PlayerState(BaseModel):
    id: Literal["P1", "P2"]
    health: int = Field(ge=0, le=100)
    mana: int = Field(ge=0, le=100)
    cooldown_until_ms: dict[str, int]
    shield_until_ms: int = 0

class ArenaState(BaseModel):
    phase: Literal["lobby", "countdown", "playing", "finished"]
    players: dict[str, PlayerState]
    modifier: Literal["none", "meteor", "mana_rain", "double_damage"] = "none"
    modifier_until_ms: int = 0
    winner: Literal["P1", "P2"] | None = None

class MarkerPose(BaseModel):
    player_id: Literal["P1", "P2"]
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    visible: bool
```

```typescript
// apps/web/src/types.ts
export type ArenaEnvelope = {
  type: "state";
  state: ArenaState;
  markers: Record<"P1" | "P2", MarkerPose>;
  frameJpegBase64?: string;
};
```

## Task 1: Establish the Repository and Shared Contracts

**Files:** `README.md`, `apps/host/pyproject.toml`, `apps/host/phantom_host/contracts.py`, `apps/host/tests/test_contracts.py`, `apps/web/package.json`, `apps/web/src/types.ts`, `.gitignore`

- [ ] Initialize the project and Python environment: `git init`, `cd apps/host`, then use `uv` or `python -m venv .venv` to install `fastapi`, `uvicorn`, `pydantic`, `pyserial`, `opencv-contrib-python`, `openai`, and `pytest`.
- [ ] Add the Pydantic contracts above and a matching TypeScript `ArenaState`/`MarkerPose` definition. Add a root README with one command each for host, web, and badge flashing.
- [ ] Write the failing contract test: construct `RadioEvent(sender="P1", kind="CAST", value="F", sequence=17, received_at_ms=0)` and assert a sequence of `256` raises validation.
- [ ] Run `cd apps/host && pytest -q tests/test_contracts.py`; confirm it fails before contracts exist.
- [ ] Implement contracts and run the same command until green.
- [ ] Commit: `git add . && git commit -m "chore: scaffold Phantom Arena contracts"`.

## Task 2: Make Radio Packets Safe and Testable

**Files:** `apps/host/phantom_host/protocol.py`, `apps/host/phantom_host/dedup.py`, `apps/host/tests/test_protocol.py`, `apps/host/tests/test_dedup.py`

- [ ] Define `parse_radio_line(line: str, received_at_ms: int) -> RadioEvent | None`. It must find `PA1|` anywhere in a serial line, require exactly five fields, accept only known senders/kinds, and return `None` rather than throw for malformed input.
- [ ] Define `PacketDeduper.accept(event: RadioEvent) -> bool`, initialized with `window_ms: int = 2000`; it returns false for a duplicate `(sender, sequence)` inside the window and true after expiry.
- [ ] Write failing tests for all required cases:

```python
assert parse_radio_line("[badge] PA1|P1|CAST|F|17", 10).value == "F"
assert parse_radio_line("PA1|P1|CAST|F|999", 10) is None
assert parse_radio_line("PA1|P1|CAST|F", 10) is None
```

- [ ] Add a dedupe test that accepts the first `P1/17`, rejects its immediate retry, and accepts it again at `received_at_ms + 2001`.
- [ ] Run `pytest -q tests/test_protocol.py tests/test_dedup.py`; confirm red, implement the parser/deduper, then confirm green.
- [ ] Commit: `git commit -am "feat: parse and dedupe badge radio events"`.

## Task 3: Build the Deterministic Game Engine

**Files:** `apps/host/phantom_host/game.py`, `apps/host/tests/test_game.py`

- [ ] Define `new_match(now_ms: int) -> ArenaState`, `apply_event(state: ArenaState, event: RadioEvent, now_ms: int) -> list[dict]`, and `tick(state: ArenaState, now_ms: int) -> list[dict]`.
- [ ] Use these exact initial values: 100 health, 100 mana, mana regeneration of 8 per second, and no active modifier. Spell rules: `F` costs 20/does 18 damage/900 ms cooldown; `S` costs 15/sets a 1,200 ms shield/1,400 ms cooldown; `A` costs 10/does 10 damage/500 ms cooldown; `U` costs 60/does 35 damage/5,000 ms cooldown. A live shield negates one incoming spell and then expires.
- [ ] Write failing tests for a valid Fireball, a shield-negated Fireball, insufficient mana, cooldown rejection, and a finished match rejecting subsequent casts.
- [ ] Implement only enough deterministic logic for those tests. The `effects` return value should be simple JSON-friendly dictionaries, e.g. `{"type":"cast","player":"P1","spell":"F"}`.
- [ ] Run `pytest -q tests/test_game.py`; confirm green.
- [ ] Commit: `git commit -am "feat: add authoritative duel rules"`.

## Task 4: Flash the Gateway and Chaos Badges First

**Files:** `badges/gateway/main.lua`, `badges/chaos/main.lua`, `README.md`

- [ ] Implement the gateway as a deliberately boring bridge: call `badge.radio.enable()`, register `badge.radio.on_recv`, and emit exactly `badge.sys.log(payload)` when `payload:sub(1, 4) == "PA1|"`.
- [ ] Implement the chaos badge with a menu on screen: `A` sends Meteor (`PA1|J|EVT|MET|seq`), `B` sends Mana Rain (`...|MANA|...`), and `START` sends Double Damage (`...|DBL|...`). Increment the 0–255 sequence number after each action.
- [ ] Use one helper in both senders: transmit the identical payload three times, spaced by 40 ms, staying below the 44-byte radio payload limit.
- [ ] On the laptop, open the HTN IDE serial console and manually verify one logged gateway line after pressing `A` on Chaos.
- [ ] Record the tested COM/tty device and badge upload steps in README; do not hard-code a machine-specific port in Lua.
- [ ] Commit: `git add badges README.md && git commit -m "feat: add gateway and chaos badge apps"`.

## Task 5: Implement the Two Motion-Controller Badge Apps

**Files:** `badges/player-p1/main.lua`, `badges/player-p2/main.lua`

- [ ] Keep each app self-contained for the Badge IDE. Configure `api=2`, enable radio, and maintain `mana`, per-spell cooldown timestamps, `sequence`, and an accelerometer baseline.
- [ ] Sample `badge.sensor.accel()` at the available 50 Hz cadence. Use threshold-and-refractory detection: forward acceleration for Fireball `F`, upward impulse for Shield `S`, lateral impulse for Arc Slash `A`, and `badge.sensor.shake()` with at least 60 mana for Ultimate `U`.
- [ ] Map buttons as the reliable demo fallback: `A=F`, `B=S`, `START=A`, `HOME=U`. Buttons and gestures must call the same `cast(spell)` function.
- [ ] Make `cast(spell)` enforce local mana/cooldown, send the triple packet, update the screen, and play its color effect: orange chase, cyan shield, purple sweep, and white/full-color Ultimate burst.
- [ ] Test with both player badges next to the gateway: verify the serial log contains a unique sender and increasing sequences, then tune thresholds in the same physical orientation used on stage.
- [ ] Commit: `git add badges && git commit -m "feat: add player spell controllers"`.

## Task 6: Connect USB Serial to a Minimal Authoritative API

**Files:** `apps/host/phantom_host/config.py`, `apps/host/phantom_host/serial_gateway.py`, `apps/host/phantom_host/broadcaster.py`, `apps/host/phantom_host/main.py`, `apps/host/tests/test_api.py`, `apps/host/.env.example`

- [ ] Add `Settings` with `serial_port`, `serial_baudrate`, `camera_index`, `openai_model`, and `openai_api_key`. Read secrets only from environment variables; `.env.example` contains names but no values.
- [ ] Define `SerialGateway.run(on_line: Callable[[str], None]) -> None`; it should reconnect with capped backoff when `serial.SerialException` occurs.
- [ ] Define `ArenaBroadcaster.publish(envelope: dict) -> None` and a FastAPI `GET /health` plus `WebSocket /ws/arena`. `/health` returns phase and gateway-connected status.
- [ ] Write a failing API test using FastAPI `TestClient`: `/health` returns 200 and has `gateway_connected`; inject a parsed Fireball into the host and assert the next websocket message has the changed health.
- [ ] Implement the in-memory host loop: serial line → parser → deduper → `apply_event` → broadcaster. Start it with `uvicorn phantom_host.main:app --reload`.
- [ ] Run `pytest -q tests/test_api.py` and manually test `curl http://localhost:8000/health` with the gateway connected and disconnected.
- [ ] Commit: `git commit -am "feat: stream authoritative arena state"`.

## Task 7: Add Camera Tracking and a Safe Fallback HUD

**Files:** `apps/host/phantom_host/vision.py`, `apps/host/tests/test_vision.py`, `assets/markers/`

- [ ] Generate and print two distinct ArUco markers, with fixed IDs `17 → P1` and `23 → P2`. Put each marker on the corresponding player’s lanyard, shirt, or controller so it is visible to the laptop camera.
- [ ] Define `MarkerTracker.update(frame: np.ndarray) -> dict[str, MarkerPose]`; normalize marker centers to 0–1 and report `visible=False` when a player’s marker is absent.
- [ ] Write a failing unit test using an image containing marker 17; assert P1 is visible and P2 is not. Add a test with no marker that returns two invisible, neutral poses.
- [ ] Implement OpenCV ArUco detection and publish one JPEG frame plus marker poses at 10 fps. Cap image width at 960 px before base64 encoding.
- [ ] Ensure the host retains `visible=False` for a missing marker instead of reusing a stale position.
- [ ] Run `pytest -q tests/test_vision.py`, then verify a live webcam shows neutral bottom HUDs when both markers are out of frame.
- [ ] Commit: `git add apps/host assets/markers && git commit -m "feat: track player markers for arena overlay"`.

## Task 8: Render the Laptop Arena

**Files:** `apps/web/src/App.tsx`, `apps/web/src/hooks/useArenaSocket.ts`, `apps/web/src/components/ArenaStage.tsx`, `apps/web/src/components/Hud.tsx`, `apps/web/src/components/EventBanner.tsx`, `apps/web/src/lib/drawArena.ts`

- [ ] Create `useArenaSocket(url: string)` that returns the most recent `ArenaEnvelope`, connection state, and reconnects with bounded exponential backoff.
- [ ] Write a small component test or manual fixture that renders two players at fixed marker coordinates and verifies P1 is red, P2 is blue, and health text is visible.
- [ ] Draw the JPEG as the canvas background. Place a compact nameplate, health bar, mana bar, shield icon, and last-cast label above each visible marker. When `visible=false`, show that player’s information in a fixed lower corner.
- [ ] Animate from server `effects`, but never calculate game rules in TypeScript. The web client simply renders the host’s state.
- [ ] Add a lobby/countdown/finished panel, including a large laptop-only winner screen.
- [ ] Run `npm run dev`, open the page beside the camera, and verify a cast seen on serial changes the correct colored HUD within one second.
- [ ] Commit: `git add apps/web && git commit -m "feat: render mixed-reality duel HUD"`.

## Task 9: Add a Validated OpenAI Arena Director

**Files:** `apps/host/phantom_host/arena_director.py`, `apps/host/tests/test_director.py`, `apps/host/phantom_host/game.py`

- [ ] Define `ArenaDirective` as a Pydantic model: `modifier` is exactly one of `meteor`, `mana_rain`, or `double_damage`; `duration_ms` is 3,000–8,000; `commentary` is at most 120 characters.
- [ ] Define `request_directive(state: ArenaState, markers: dict[str, MarkerPose]) -> ArenaDirective`. Give the model compact game data (health, mana, last spells, current modifier, elapsed round time), request JSON only, and apply a five-second timeout.
- [ ] Write failing tests with a fake OpenAI client for: valid Meteor JSON, invalid modifier, malformed JSON, and timeout. The last three must return the deterministic fallback `mana_rain` for 3,000 ms with local commentary.
- [ ] Allow the host to request a directive only every 20 seconds while phase is `playing`; pass every returned directive through game-engine validation before changing `ArenaState`.
- [ ] Render the returned commentary as the EventBanner. Clearly label it “Arena Director,” rather than presenting it as an authoritative referee.
- [ ] Run `pytest -q tests/test_director.py` without a real API key, then test one live request with an API key before the demo.
- [ ] Commit: `git commit -am "feat: add safe OpenAI arena director"`.

## Task 10: Rehearse the Demo and Harden the Failure Paths

**Files:** `README.md`, `apps/host/tests/test_game.py`, `apps/host/tests/test_api.py`

- [ ] Add the judge-run sequence to README: start host, start web, select camera, plug in gateway, show player badges, have judge press Chaos `A`, run one round, show winner laptop screen.
- [ ] Add tests for a late duplicate packet, serial reconnect state, cast after match finish, marker disappearance, and Director fallback. Run all tests with `cd apps/host && pytest -q`.
- [ ] Stage-test the end-to-end latency with real hardware. The acceptance target is badge action to laptop HUD update in under one second and no double damage after a three-send packet retry.
- [ ] Prepare a 30-second resilience fallback: if the camera fails, run fixed corner HUDs; if OpenAI fails, announce the deterministic Mana Rain event; if a gesture is unreliable, use its mapped button.
- [ ] Run `npm run build` in `apps/web` and the full pytest suite one final time. Fix every failing check before the demo.
- [ ] Commit: `git commit -am "docs: add demo runbook and reliability checks"`.

## MVP Completion Checklist

- [ ] P1 and P2 can each produce a distinct cast packet that reaches the gateway serial log.
- [ ] A duplicate retry cannot deduct health twice.
- [ ] The host can run a full 100-to-0 duel and declare one laptop-only winner.
- [ ] The webcam HUD tracks both player markers and degrades safely when either is absent.
- [ ] The Chaos badge visibly changes the arena.
- [ ] The Director’s valid response appears as commentary; its failure fallback is demonstrable without network access.
- [ ] The live judge flow completes in two minutes without a manual code edit.
