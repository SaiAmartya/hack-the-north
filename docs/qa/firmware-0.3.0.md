# Firmware 0.3.0 — five-spell final sprint

September 20, 2026. This records local source/build checks and the subsequently authorized app-only flash and live verification of the USB-connected WAND-B602. No other badge was flashed.

## Changes and assumptions

- The existing v1 20-byte protocol is sufficient. Spell IDs 1–3 are preserved; Incendio is 4 and Episkey is 8. Historical seven-spell IDs 5–7 are reserved and rejected. TypeScript, C++ and Python share explicit byte vectors for the active moves and rejection checks for 5, 6, 7 and unknown 9.
- Both new accepted-cast cues show their name and a matching LED sweep: Incendio orange, Episkey mint. Healing uses the existing HP state. Cooldowns, HP calculation and effects remain in the referee; raw motion, sensor profile, power policy and streaming are unchanged.
- Badge pairing/game instructions fit its 300-pixel text area. The paired pre-room state displays `WAND READY`; there is no practice gate. Removed the clipped three-spell instructions and technical footer; USB `id`, `status` and `trace` still provide diagnostics. Preserved the teammate's heart icon and green/amber/red HP bar, without seven cooldown rings or button hints.
- The existing `tools/wand_ble_check.py` now checks all five cue IDs and cycles them during its loaded stream test. Its 60-second run on the flashed WAND-B602 passed; measured results are below.
- Firmware before 0.3.0 rejects Episkey ID 8 rather than showing Sectumsempra. Historical STATUS kind 2 is reserved and unsupported; the game has no button-only casting path. The final flash is the migration step; there is no fallback that mislabels one spell as another.

## Reconciled teammate history

The fetched `origin/main` commits `28c2770` and `652c5eb` introduced seven-spell firmware 0.2.2 and a 0.2.3 button/cooldown HUD. Their existing IDs 5 Sectumsempra, 6 Petrificus Totalus and 7 Expecto Patronum are kept reserved. The active game remains five moves with no global cooldown. Retained page/GATT sessions, rejection of clipped motion, sensor acquisition and battery startup are unchanged by this reconciliation.

**Teammate-reported physical evidence, not rerun here:** `28c2770`'s firmware README reports 0.2.2 flashed to WAND-46BA, app size 688,032 bytes, SHA-256 `59ca598da2f4a3d8143e6d8f08a0465ced3c9d235ef4f6659798aa208150d630`, with matching readback and an on-device selftest pass. Its five-second BLE check reportedly delivered 259 frames at 49.5 Hz, no gaps/discontinuities and median command RTT 47 ms. `652c5eb` reports 0.2.3 built but not flashed. These historical results do not qualify the 0.3.0 image below.

## Autonomous evidence

| Check | Result |
| --- | --- |
| Five native C++ programs, `-std=c++17 -Wall -Wextra -Werror` | Protocol selftest (48 checks), profile/RTC/brownout, stream continuity, axis mapping/clipping and console defaults pass |
| Existing wand protocol/endpoint/client Vitest suites | 64 tests pass, including all five cues expiring without replay and the existing ten-minute software soak |
| Python `test_wand_protocol.py` | 4 tests pass, including matching Incendio/Episkey byte vectors |
| Existing badge flash/matrix tool tests | 16 tests pass |
| `py_compile tools/wand_ble_check.py` | Pass |
| PlatformIO badge compile/link | Pass, pinned Espressif platform 55.3.312 / Arduino 3.3.12 / NimBLE 2.5.1 |

Build command from `firmware/`: `uv run --offline --python 3.12 --with 'platformio>=6.2.0' pio run -e badge`.

The reconciled build reports static RAM 26,320 bytes and flash program usage 659,033 bytes. These are linker figures, not runtime heap or timing measurements.

| Local artifact | Bytes | SHA-256 | Installation role |
| --- | ---: | --- | --- |
| `firmware/.pio/build/badge/firmware.bin` | 689,248 | `1de90ca4f5df48b3d8ba4b8ebf7e09f4f63adf7986f9a4120512e44b27b6f446` | App only, offset `0x10000`, inside existing `0x2a0000` factory slot |
| `firmware/.pio/build/badge/partitions.bin` | 3,072 | `11a228752e2be0b2ddb6dc70ba0f1744d591c1d781f0b489a2cb79c86dfe0724` | Compare against device/backup; do not write it |

Generated binaries remain local and ignored by Git. Rebuilding can change the binary hash; check the artifact used for the actual flash. The preservation/recovery procedure remains in [firmware/README.md](../../firmware/README.md#3-guarded-app-only-installation).

## Authorized WAND-B602 flash and live checks

The user explicitly authorized flashing the single USB-connected badge after the software checks. The target was `/dev/cu.usbmodem1101`, WAND-B602, ESP32-C3 revision 0.4 with 4 MB flash. The ROM base MAC was `28:84:85:d6:b6:00`; BLE INFO reported device ID `288485d6b602`. It initially ran 0.2.1.

The build was rerun immediately before installation and retained the artifact hash above. The existing private device-specific stock backup passed its verified-backup guard. The generated partition table matched the backup, and the helper freshly read the device's first `0x9000` bytes and confirmed its bootloader and partition table still matched that backup. The helper wrote only the 689,248-byte application at `0x10000`, then read the entire application back and confirmed byte-for-byte identity with SHA-256 `1de90ca4f5df48b3d8ba4b8ebf7e09f4f63adf7986f9a4120512e44b27b6f446`. Bootloader, partition table, NVS, PHY storage and eFuses were not written.

Commands run from the repository root:

```sh
uv run --offline --with pyserial --with esptool python tools/badge_flash.py --port /dev/cu.usbmodem1101 flash
apps/host/.venv/bin/python tools/badge_flash.py --port /dev/cu.usbmodem1101 cmd id status selftest
uv run --offline --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-B602 --scan 15 --seconds 60
```

| Fresh device check | Observed result |
| --- | --- |
| Post-flash console identity | `fw=0.3.0 profile=range ble=on caps=0F`, configured 50 Hz / ±8 g; sensor present and register readback correct |
| On-device protocol selftest | All 48 checks pass; `selftest failures=0`, including Episkey 8 and rejected IDs 5–7/9 |
| USB status after console-induced reset | Advertising, no client; zero I²C recoveries, dropped samples, gaps, lost samples, brownouts or notification failures; free heap 159,328 bytes |
| BLE discovery and setup | Name, advertised service and INFO match; no motion before OPEN; OPEN and all five SYNC replies pass |
| Five spell feedback commands | Stupefy, Protego, Expelliarmus, Incendio and Episkey accepted; reserved/unknown IDs 5, 6, 7 and 9 rejected |
| Command validity | Wrong epoch, expired cue and overlong cue rejected; playing/won state and result cue accepted |
| Loaded state/cue/SYNC commands | 171 commands, zero failures; RTT min/median/p95/max 23/58/61/90 ms |
| Loaded motion stream | 2,957 frames in 60.7 s, 48.7 Hz; zero sequence gaps, discontinuity flags, malformed frames or saturated frames; all valid with unchanged boot ID |
| Sensor capture intervals | Mean 20.5 ms, min 19 ms, max 22 ms; host arrival maximum 62 ms |
| Lease/health reporting | 67 health notifications; sensor + stream + presentation/stale bits observed after state lease elapsed, zero drops |
| Test completion | `ALL PASS`, exit 0; checker unsubscribed and disconnected |

These are fresh measurements of this exact 0.3.0 image on WAND-B602 while USB-powered and stationary. They establish the flash/readback, sensor/radio cadence and accepted feedback protocol. They do not establish how the physical panel/LEDs looked, real speech and hand-motion casting in the browser, battery startup/endurance or another badge's behavior. Opening the USB console deliberately reset the badge; the BLE run then completed with a stable boot ID.

## Final device QA contract

1. **Install any other intended badge.** WAND-B602 is complete with matching app readback. For another badge, use its own existing verified backup and exact port with [the guarded app-only installation](../../firmware/README.md#3-guarded-app-only-installation), when that installation is authorized. Require matching app readback before normal boot.
2. **Verify battery boot.** WAND-B602's USB `id status selftest` checks passed. Unplug USB and boot from the intended AA supply; the same badge should become discoverable, with no repeated reset/boot screen. Repeat `id status selftest` for each newly flashed badge: expect `fw=0.3.0`, `profile=range ble=on caps=0F`, 50 Hz / ±8 g and `selftest failures=0`.
3. **Observe feedback under sustained radio load.** The 60-second USB-powered run passed. With Chrome disconnected, run `uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-XXXX --scan 15 --seconds 600`, substituting the badge name. All five cue checks and loaded commands should pass; observe distinct spell text/colors, no resets and readable text. This checks the real badge separately from the browser.
4. **Complete one browser duel on each badge.** Pair the actual badge in Chrome, hold it still briefly, and enter the lobby without a calibration step. Cast Stupefy, Protego, Expelliarmus, Incendio and Episkey with real speech/motion. Expect one accepted cast and matching badge cue per move, HP following the laptop, cyan shield while active, disarmed indication after Expelliarmus, mint healing and victory/defeat at the round end. Inspect the long `EXPELLIARMUS!` label for clipping.
5. **Interrupt and reconnect.** Disconnect the badge during play. Its HP/cue should clear promptly; a stalled host must clear it within the existing 1.5-second lease. Reconnect and start a fresh round: no old hit, heal or victory cue should replay. Power-cycle again and confirm the same device identity and fresh boot/session.
6. **Finish on battery with both players.** Run both badges together on the intended laptops/network for a 30-minute battery session with active spell feedback, then one fresh match. Record resets, motion interruptions, visible LED/screen errors or disagreement with either HUD immediately. Existing six-face scale and intended Windows-adapter qualification remain physical evidence requirements if those have not already been recorded for these exact devices.

Panel/LED appearance, real speech and hand-motion casting, battery behavior, sustained two-device operation and any other badge's installation remain outside this autonomous firmware evidence. No missing software dependency blocks the build or the completed WAND-B602 flash.
