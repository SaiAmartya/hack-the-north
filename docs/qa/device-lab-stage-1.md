# Device Lab — first implementation checkpoint

**Build label:** `device-lab-01`, September 19, 2026. Developed on
`codex/harry-potter-battle-mvp-outline` from contract commit `04e315b`; use
`git rev-parse --short HEAD` to report the exact checkpoint revision.

**Historical checkpoint.** The legacy arena, `App.tsx` and gateway code that this record
preserved were removed from the tree on September 19, 2026 (commit `530a0ba`); they remain only
in git history.

The approved [0→1 plan](../../IMPLEMENTATION-PLAN.md) is being implemented one
testable checkpoint at a time. This checkpoint establishes the Stage 0–1 device
foundation. **Your replay QA is next; speech, classification, iPhone pairing,
multiplayer and Three.js combat are not implemented yet.**

## What exists

- New React Device Lab entry point, separate from the preserved legacy arena.
- Original Wizarding Workshop UI: warm parchment, purple tactile controls,
  hand-authored star-wizard SVG, numbered sections, keyboard navigation and
  responsive layouts. [DESIGN_SYSTEMS.md](../../DESIGN_SYSTEMS.md) governs future UI.
- Isolated Python host with typed health/rules endpoints; no serial, camera or AI
  workers. The rules are configuration only; no combat engine is claimed.
- The unchanged 20-byte badge codec, golden-vector tests and timer-independent
  virtual endpoint. INFO/MOTION/CONTROL/STATUS, OPEN/SYNC, session identity,
  command acknowledgements, deadlines, epochs and duplicate handling are real
  protocol paths, not direct spell injection.
- Shared wand lifecycle: clock mapping, wrap handling, fresh/gap checks,
  health faults, bounded sample history, serialized/expiring feedback and cleanup.
- Raw synthetic rest/jab/guard/sweep fixtures. These illustrate signals; they are
  neither measured human movements nor proof of a gesture classifier.
- Decoded display/six-LED preview, replay fault controls and source labels.
- BLE adapter tested with a fake browser API. The explicit real-device chooser
  is present but **not exercised or hardware-qualified**. Use replay for this card.

Calibration, gesture/speech/fusion panels become functional in Stages 2–3.
Game-message cross-language fixtures arrive with the Stage 4 referee; no game
messages or game sockets exist in this checkpoint. iPhone traffic is not enabled.

## Your five-minute QA card

**Setup:** Mac + desktop Chrome, no phone or badge required. Follow the current
[README launch commands](../../README.md#run-the-current-checkpoint), then open
`http://127.0.0.1:5173`. The optional isolated host is not needed for replay.

| Step | Action | Expected |
| --- | --- | --- |
| 1 | Leave **Virtual wand · raw replay** selected; click **Connect wand** | `STREAMING`, `REPLAY`, increasing accepted samples; rest near X=0/Y=0/Z=1000 mg. No microphone/camera permission prompt |
| 2 | Click **jab trace**, then **guard trace** | The raw axes/trace change, return to rest; no spell or damage is claimed |
| 3 | Click **Refresh practice state**, then **Test cue (not a cast)**; finally **Stop refresh** | Decoded `PRACTICE`, one brief LED/cue preview, then neutral/stale within about 1.5 s. These buttons are diagnostics, not gameplay controls |
| 4 | Click **Inject 600 ms outage**; then **Connect wand** | A visible 500 ms input fault, cleared trace, then a fresh session. No old cue plays on reconnect |
| 5 | Switch to a different browser tab for a second, then return | A page-hidden fault; input stays stopped until you explicitly reconnect |

If the host is running, **Check isolated host** should say it is online and
multiplayer is not built. An offline host must not break replay.

**Stop and report:** any permission prompt, real-device interaction, old cue after
reconnect, frozen UI, unexpected fault or discrepancy with the table. Please do
not select a real badge, change browser security settings or expose the server
to the LAN to complete this card.

Reply with only:

> device-lab-01 · Mac/Chrome/replay · failed step (or all passed) · expected → observed · visible reason/counters

No raw audio/video or diagnostic export is needed. This card qualifies the
diagnostic workflow, not physical input or gameplay. After it passes, the next
checkpoint is the real local-speech latency/accuracy spike.

## Automated evidence and reproducibility

Tested runtime: Node `26.5.0`, Python `3.11.11`, React `18.3.1`, TypeScript `5.7.2`,
Vite `6.4.3`, Vitest `3.2.7`, Playwright `1.63.0` with its installed Chromium.
Dependencies are pinned in the existing manifests/lockfile. First-time dependency
and browser installation needs internet; replay runtime does not.

Run from `apps/web`:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Run from `apps/host`:

```sh
.venv/bin/python -m pytest -q -rs
```

The browser tests own a loopback Vite server; stop a manually started server first.
They cover connection, raw samples, decoded state/cue, lease expiry, outage and
fresh reconnect, plus permission-free startup, keyboard/same-page navigation,
reduced motion and 1440/390/320 px layouts. Screenshots are ignored local artifacts
at `apps/web/test-results/device-lab-desktop.png` and `device-lab-mobile.png`.
Responsive browser checks are not physical iPhone qualification.

Python result: **207 passed, 4 skipped**. One legacy receiver-only test is skipped;
three legacy Lua syntax checks are skipped because `luac` is absent. A dependency
deprecation warning remains in Starlette's test client. Only the isolated-host
bootstrap tests concern the new server; the rest protect the retained baseline.

TypeScript, **44 web unit tests**, production build and the browser suite
passed before publication. No lint script is configured, so no lint pass is claimed. The skill validator and
`git diff --check` also passed.

A separate same-model source review found lifecycle issues, which were fixed and
covered where practical by regressions. **Claude review was waived; no
cross-family review is claimed.** Visual inspection of the browser screenshot
checked readability; it is not game-art or human interaction acceptance.

## Scope and reuse ledger

| Boundary | Existing candidate inspected | Decision |
| --- | --- | --- |
| Browser shell | Existing React/Vite/TypeScript application | Reuse stack and build; select Device Lab in `main.tsx`, preserve legacy `App.tsx` |
| Host | Existing FastAPI/Pydantic stack and pytest patterns | Reuse stack; isolated `duel_app.py` avoids starting legacy serial/camera/AI workers |
| Device wire | Legacy gateway JSON/events and fake gateway | Do not reuse preclassified event or serial/PTY transport; new exact badge-byte boundary is required |
| Replay/feedback | Published firmware contract and golden vectors | One codec and virtual endpoint; UI preview reads decoded device commands, not a separate game-state copy |
| GATT | No existing connected-browser adapter | Small transport seam with fake-browser lifecycle tests; no extra production transport |
| Tooling | Existing npm lockfile, Python manifest | Focused Vite update and pinned test tools; no framework migration |
| Redesign | Existing Device Lab handlers, controls, CSS and replay test | Preserve behavior; replace the visual treatment and extend the browser checks. Inline original SVG avoids another asset dependency |

Deletion/simplification pass removed the old generic frontend proxy and avoided
a second UUID table. Legacy files were deliberately preserved; no broad engine
deletion, firmware edit or unrelated refactor was made.

## Explicitly still unverified

- Human QA above, local speech and nearby-voice rejection.
- Any physical iPhone movement, cadence, permissions, TLS or LAN pairing.
- Multiplayer, video, recognition, combat, renderer performance or Windows.
- Badge sensor profile, connected BLE, physical LEDs/display, battery and H0–H5.
- Firmware-team acknowledgement of the contract.

No certificate trust, firewall, LAN hosting, microphone/camera permission or device
settings were changed. No badge was selected or flashed. The approved firmware
contract and unchanged HAL copy were committed/pushed as `04e315b` to the feature
branch. Sai approved publishing this tested software checkpoint to the feature
branch and fast-forwarding `main`; publication does not close any human QA gate.
