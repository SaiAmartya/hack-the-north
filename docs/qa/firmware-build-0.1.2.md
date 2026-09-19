# Firmware 0.1.2 build manifest

**Superseded diagnostic image.** Sai reported a battery-only boot loop and requested
discarding local firmware fixes. See [the upstream replacement](firmware-main-6a50929.md).
The reset cause was not measured; USB/BLE passes below do not establish battery stability.

Date: 2026-09-19
Status: isolated build and app-only flash verified; native BLE H2 passed. H1, H3 and
full H4 remain open.

## Source identity

The build used a fresh temporary copy of `firmware/` with `.pio/` and private backups
excluded. The build-input fingerprint covers `include/**`, `src/**`, `platformio.ini`,
and `partitions_badge.csv`, using sorted per-file SHA-256 lines followed by one final
SHA-256:

```text
3730065e289e748c45cc8e3ed16f3d1518067419ef04376c73f6a61432037961
```

The repository source and temporary build copy produced the same fingerprint. This is
an uncommitted working-tree snapshot, not a Git commit identity.

Host protocol verification for this source passed 41/41 checks under C++17 with
`-Wall -Wextra -Werror`. The isolated PlatformIO build succeeded with 25,792 bytes RAM
(7.9%) and 659,881 bytes flash (15.7%). These are build results, not badge measurements.

## Resolved build inputs

| Input | Resolved value |
| --- | --- |
| PlatformIO Core | 6.2.0 |
| pioarduino platform | 55.3.312 (`platform.json` 55.03.312) |
| Platform archive | `https://github.com/pioarduino/platform-espressif32/releases/download/55.03.312/platform-espressif32.zip` |
| Arduino-ESP32 | 3.3.12 |
| ESP-IDF libraries | 5.5.5+sha.b774170ff46 |
| RISC-V GCC | 14.2.0+20260121 |
| esptool | 5.4.0 |
| NimBLE-Arduino | 2.5.1 |
| Adafruit NeoPixel | 1.15.5 |
| Adafruit GFX Library | 1.12.6 |
| Adafruit BusIO | 1.17.4 |
| Adafruit ST7735/ST7789 | 1.11.0 |
| Transitive libraries | Adafruit seesaw 1.7.9; Arduino SD 1.3.0 |

The ESP32-C3 framework configuration contains both
`# CONFIG_BT_NIMBLE_HS_FLOW_CTRL is not set` and
`# CONFIG_NIMBLE_HS_FLOW_CTRL is not set`.

## Four-image manifest

| Flash offset | Image | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `0x0000` | `bootloader.bin` | 18,688 | `9da6c687836220a0b2c92544a5243d5af9bd1f0aff9298d48d4562e0e747989b` |
| `0x8000` | `partitions.bin` | 3,072 | `11a228752e2be0b2ddb6dc70ba0f1744d591c1d781f0b489a2cb79c86dfe0724` |
| `0xE000` | `boot_app0.bin` | 8,192 | `f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0` |
| `0x10000` | `firmware.bin` | 689,568 | `ea820aee40f47e43c309848fdc2b15fbea99a85713ed27a4233e4f465f068865` |

The combined `firmware.factory.bin` is 755,104 bytes with SHA-256
`364dd1748b2be039413072dc5d54b1fca96ffb895e906501b47580c8df95c94d`.
It is a build artifact only and is **not** the planned update payload.

## Comparison with the flashed 0.1.1 candidate

The recorded 0.1.1 application remains 688,864 bytes with SHA-256
`979dc92084f3e41ad0618dd36c6bbe3e38f1abb8dafd89de6fb1c210a5601bde`.
The isolated 0.1.2 build did not overwrite it.

The 0.1.1 and 0.1.2 combined images were sliced at the declared offsets and lengths.
Their bootloader, partition-table, and OTA-bootstrap regions match each other and the
standalone files byte for byte, with the three hashes shown above. Only the application
at `0x10000` differs. This comparison does not imply that those regions should be
rewritten.

## App-only update evidence

After the 0.1.1 reconnect baseline completed, the authorized operator wrote only the
0.1.2 application at `0x10000` and verified its readback against SHA-256
`ea820aee40f47e43c309848fdc2b15fbea99a85713ed27a4233e4f465f068865`.
The write did not target the bootloader, partition table, `boot_app0`, NVS, PHY, or
storage regions. The watchdog-reset path booted firmware 0.1.2 on `WAND-B602`; boot
diagnostics reported the sensor present with WHO_AM_I `0x11` and control-register
readback `0x47 / 0xA0`.

Idle 0.1.2 `status` reported:

- free heap 171,264 bytes;
- minimum free heap 171,076 bytes;
- largest allocatable heap block 114,676 bytes;
- acquisition-task minimum free stack 5,228 bytes.

These are one idle snapshot, not a trend or loaded-stability result.

## Native BLE evidence

A name-pinned native BLE checker ran against only `WAND-B602` for a 30-second stream:

- INFO reported firmware 0.1.2, 50 Hz, ±8 g and axis convention 1; both notification
  subscriptions, OPEN sequence zero and 5/5 SYNC replies passed;
- OPEN result RTT was 59 ms; SYNC RTT min/median/max was `59 / 89 / 91 ms`, with
  ±29 ms uncertainty from the best sample;
- 1,465 decodable MOTION frames arrived over 30.1 seconds: **48.7 Hz**, zero sequence
  gaps, discontinuity flags, saturation flags or malformed records;
- capture intervals were mean 20.5 ms, min 19 ms, max 22 ms; host arrival intervals
  were mean 20.5 ms and max 61 ms;
- mean axes during the uncontrolled placement were `(-273, -190, 776)` mg; this is
  recorded raw evidence, not a six-face axis/scale result;
- playing/won state and accepted-cast/result cues were accepted; wrong-epoch, expired
  and overlong cues were rejected with the expected result codes;
- 34 health notifications arrived; final health bits were `0xF` and device drops were zero.

The checker exited `ALL PASS`. This is one native-GATT H2 run on macOS, not Chrome,
Windows, H3, battery, second-central, or full H4 evidence.

## Required runtime follow-up

The resource path has only the idle snapshot above, and the new axis-control path remains
unmeasured. Before treating 0.1.2 as qualified:

- verify connected `axes ...` writes are rejected, disconnected writes report the saved and
  active maps separately, and the saved map becomes active only after an explicit reboot;
- rerun the on-device 41-check self-test; retain the native BLE H2 output above;
- run H3 for 10 minutes with sensor, connected BLE, state refreshes, SYNC, cues, display,
  and LEDs together; capture `status` at the start, during load, and at the end;
- record current/minimum free heap, largest allocatable block, acquisition-task minimum free
  stack in bytes, dropped/notified counters, longest motion gaps, resets, and any allocation
  or notification failures. Do not infer stability merely from a successful build or boot.
