# Wandduel — badge or iPhone + local voice

A two-player, motion-and-voice duel: React/Three.js presentation, a Python referee,
video-only WebRTC and local speech recognition on each laptop. No button casting,
cloud ASR, serial gameplay gateway or badge IDE dependency.

**This is an incomplete development checkpoint, not a qualified demo release.**
The iPhone path has direct-first Wi-Fi, explicit Internet fallback, visible sensing and
player-started grip calibration. The gesture detector is now **v3**: a Wii-remote style segmenter
(a movement starts on a sharp change and ends when the wand is still again, in whatever pose it
ended up) with per-player jab/guard templates; it calibrates and recognizes the recorded iPhone jabs
that v2 rejected. Badge firmware **0.2.0** is the first gameplay image: 50 Hz/±8 g by default, radio
on after every reset, and the sensor overwrite flag no longer marks every sample discontinuous.
It is flashed on WAND-B602 (readback verified) and awaiting the physical QA card; see [the 0.2.0 change record](docs/qa/firmware-0.2.0.md).
The browser reconnects a dropped badge link automatically (bounded) and no longer drops the wand on a
short page stall. An intermittent Internet-relay freshness failure remains open.
See [current implementation and measured evidence](docs/qa/input-rebuild.md).

- **[Start here: teammate setup](docs/TEAM-SETUP.md)** — fresh-clone macOS/Windows install,
  local speech, iPhone connection, two laptops, checks and troubleshooting.
- **[Badge build, backup and flash instructions](firmware/README.md)** — 0.2.0 gameplay image, flashed, physical QA pending.
- [MVP](MVP-OUTLINE.md) · [Implementation plan](IMPLEMENTATION-PLAN.md) · [Firmware contract](BADGE-FIRMWARE-CONTRACT.md)
- [Design system](DESIGN_SYSTEMS.md) · [Repository workflow skill](.agents/skills/wand-dev-workflow/SKILL.md)

## Run an already installed checkout

From the repository root, with Node **26.5.0** on PATH and the Python **3.11** environment
installed:

```sh
apps/host/.venv/bin/python tools/run_game.py
```

Windows PowerShell:

```powershell
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py
```

That one command starts everything: the referee, the local speech helper (the pinned
transcription model is downloaded on first use if it is missing) and the game frontend, plus
iPhone pairing once the phone defaults have been saved with
`tools/run_game.py --save-defaults --phone-service <origin> --phone-secret-file <file>`
(`--no-phone` skips them for a run). A previous stack started by the launcher is stopped
automatically before the new one comes up; a port held by anything else still blocks startup.

Open **http://127.0.0.1:5173** (or `localhost:5173`) in desktop Chrome. Wait for **Game ready**
in the terminal; this verifies the frontend, referee and warmed local speech helper, not physical
gameplay. The default stable build does not hot-reload; restart after changing source. **Ctrl+C**
stops this stack. First-time phone setup is in [the setup guide](docs/TEAM-SETUP.md#3-connect-an-iphone).

Badge firmware 0.2.1 is flashed on WAND-B602 and awaiting its physical QA card; the iPhone
path is the parallel physical option. Neither physical path is qualified for a demo yet.

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

## History

Wandduel replaced an earlier prototype, Phantom Arena (stock-firmware Lua badge apps, a serial
gateway badge, webcam markers and a cloud vision call). That code, its tests and its documents
were removed from the tree on September 19, 2026; they remain in git history before commit
`8f49b12` (`git log --all -- badges apps/host/phantom_host/main.py`). Nothing in the current
platform depends on it.

