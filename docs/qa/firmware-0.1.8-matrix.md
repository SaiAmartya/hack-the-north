# Firmware 0.1.8 — controlled diagnostic comparison

September 19, 2026, WAND-B602 on the development Mac. **Diagnostic evidence, not a gameplay release.**

## Image and preservation

- Application: 684,864 bytes, SHA-256 `aca81d8ed33d747388dbc2cd3ca90e7b97c3e4f6e1745c2abd299089f674d7ea`.
- Explicitly approved app-only write at `0x10000`; independent readback matched the full application hash.
- Two previously verified 4 MiB stock backups remain outside Git. Their matching SHA-256 is `fc5d6fe32a3ad29dc66241d6d0ef35e76e4959687706b901e1525b6a6e4cbb8a`.
- Live partition region at `0x8000` matched the stock backup before flashing: 4,096-byte region hash `5cc6ed9fb7498d7741d0737edb12d9c610f7306b8e021e2e75f9e9f04822a9f9`. The manifest's 3,072-byte partition artifact has a different length/hash (`11a228752e2be0b2ddb6dc70ba0f1744d591c1d781f0b489a2cb79c86dfe0724`); comparing equal lengths confirmed preservation.
- No bootloader, partition, NVS, stock-storage or identity-region writes; no eFuse or blanket erase. Existing pinned Arduino3.3.12/ESP-IDF5.5.5/NimBLE2.5.1 toolchain retained.
- PlatformIO build and three independent portable C++ protocol/diagnostic/default tests passed. A separate read-only review found no remaining source defect. Those are not hardware acceptance.

After these measurements, the feature branch fast-forwarded to teammate main `76b6388`.
That change adds a pure axis-mapping/clipping helper and test plus a reliability checklist;
it does not change the sensor configuration or overwrite interpretation. Its merged callsite
declared `v` twice and also read mutable mapping globals directly. Integration now calls the
helper once with the existing locked mapping snapshot and boot-selected range, removing the
duplicate loop. Mapping tests (including ±2g) and the full PlatformIO build pass. **This later
source integration was compiled, not re-flashed; the device evidence below belongs to the
exact pre-merge application hash above.**

## Procedure and measurements

`tools/badge_matrix.py` runs four profiles with BLE off/on in the **same image**. Profile changes are explicit software reboots, retained only in validated RTC memory. The runner now waits for firmware's disconnected state and exact profile-command acceptance/readback; an initial run exposed a host-disconnect/firmware-callback race in the runner, not evidence that a rejected profile was measured.

Each off row includes a ten-second acquisition interval. Each on row includes both subscriptions, OPEN, five SYNC probes, and approximately ten seconds of motion with repeated state/cast-cue/SYNC load. USB remained connected; no controlled orientation/movement procedure was performed. Rates below are counter deltas across MCU-observed fresh-read timestamps, not timestamps supplied by the sensor.

| Profile | Configured Hz/range | Fresh-read Hz, BLE off/on | Flagged reads, BLE off/on | BLE received Hz | Command RTT p95 |
| --- | --- | --- | --- | --- | --- |
| Creator baseline | 100 / ±2g | 97.25 / 97.25 | 1032/1043 · 1091/1104 | 97.42 | 61.5 ms |
| Rate-only | 50 / ±2g | 48.74 / 48.74 | 516/523 · 542/548 | 48.75 | 63.0 ms |
| Range-only | 50 / ±8g | 48.74 / 48.74 | 519/523 · 541/547 | 48.85 | 66.9 ms |
| High-performance | 50 / ±8g | 50.79 / 50.81 | 541/545 · 559/566 | 50.76 | 60.2 ms |

All eight rows verified their selected register/profile readbacks and post-reset `00/07/00` defaults. All **128 captured bursts** showed STATUS `FF → 00`. BLE runs had no malformed motion, failed load commands, notification failures or reported I²C recoveries. Minimum reported free heap was 158,992 bytes, largest free block 114,676 bytes, acquisition-task stack high-water headroom at least 4,988 bytes. These short intervals do not establish endurance, worst-case memory or timing.

Raw bounded local measurement files: `/tmp/wand018-matrix-complete.json` (eight-row comparison) and `/tmp/wand018-matrix.json` (initial partial run). They are transient diagnostics, not committed firmware artifacts or backups.

## Decision

The overwrite anomaly appears even at the **creator baseline with BLE disabled**. Changing only rate, range or high-performance mode did not remove it. That argues against blaming BLE load alone, but does **not** prove either actual near-every-sample loss or harmless STATUS semantics. Capability bits remain zero; no production profile is promoted and no further speculative configuration/FIFO rewrite is made.

Creator clarification requested: for revision `0x28`, does STATUS bit7 specifically mean unread-data loss under BDU, and what exact read sequence do their working drivers use? Provide the already observed `00 → FF → 00` transition trace with that question.

The final software-selected row was `creator on`. **A cold/watchdog reset intentionally defaults to `creator off`**, which does not advertise BLE. This diagnostic behavior must not be mistaken for a repaired battery-play release. Battery cold boots, unplug behavior, six faces, clipping/movement, ten-minute combined load,20 reconnects,30-minute battery operation, Windows and two-badge acceptance remain outstanding.
