# Firmware 0.1.1 build manifest

Status: frozen software candidate built on 2026-09-19. This records the exact
working-tree input and build output selected for the first hardware check. It is
not a hardware acceptance record, and no flash or serial operation is claimed
here.

## Candidate identity

- Branch: `codex/harry-potter-battle-mvp-outline`
- Base commit: `6c1b857892cad887d410b4badc9ad32fad4428d5`
- Firmware-reported version: `0.1.1`
- Source state: dirty working-tree candidate; the firmware changes were not
  committed when built.
- Build-input fingerprint: `b8f91063ca23060bff0d35f48d26a8247fae6d73b1c3e55a255544bdc8967453`

The build-input fingerprint is SHA-256 over the ordered `shasum -a 256`
records for `firmware/platformio.ini`, `firmware/partitions_badge.csv`, and all
`*.h`, `*.c`, and `*.cpp` files below `firmware/include` and `firmware/src`.
It identifies this candidate even though the surrounding worktree is dirty.

## Resolved build environment

| Component | Resolved version |
| --- | --- |
| Python | 3.13.5 |
| PlatformIO Core | 6.2.0 |
| pioarduino `espressif32` platform | 55.3.312 (`platform.json` 55.03.312) |
| Arduino-ESP32 | 3.3.12 |
| ESP-IDF libraries | 5.5.5, commit `b774170ff46` |
| RISC-V GCC toolchain | 14.2.0+20260121 |
| esptoolpy | 5.4.0 |
| NimBLE-Arduino | 2.5.1 |
| Adafruit NeoPixel | 1.15.5 |
| Adafruit GFX Library | 1.12.6 |
| Adafruit BusIO | 1.17.4 |
| Adafruit ST7735/ST7789 Library | 1.11.0 |

Transitive libraries resolved to Adafruit seesaw 1.7.9 and SD 1.3.0. The
ESP32-C3 SDK configuration contains
`# CONFIG_BT_NIMBLE_HS_FLOW_CTRL is not set`; host flow control is disabled in
this build.

The isolated tools used for this candidate live under
`/tmp/wand-fw-tools.rjR9ym`. The build command was:

```sh
PLATFORMIO_CORE_DIR=/tmp/wand-fw-tools.rjR9ym/platformio \
  /tmp/wand-fw-tools.rjR9ym/venv/bin/pio run -d firmware
```

PlatformIO completed successfully. It reported 25,792 bytes of RAM use and
659,255 bytes of flash use for its board-size check; the generated application
image is 688,864 bytes.

## Preservation-safe upload set

Only these four discrete images form the preservation-safe candidate upload:

| Offset | Image | Size | SHA-256 |
| --- | --- | ---: | --- |
| `0x0000` | `firmware/.pio/build/badge/bootloader.bin` | 18,688 B | `9da6c687836220a0b2c92544a5243d5af9bd1f0aff9298d48d4562e0e747989b` |
| `0x8000` | `firmware/.pio/build/badge/partitions.bin` | 3,072 B | `11a228752e2be0b2ddb6dc70ba0f1744d591c1d781f0b489a2cb79c86dfe0724` |
| `0xE000` | `boot_app0.bin` from the resolved framework | 8,192 B | `f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0` |
| `0x10000` | `firmware/.pio/build/badge/firmware.bin` | 688,864 B | `979dc92084f3e41ad0618dd36c6bbe3e38f1abb8dafd89de6fb1c210a5601bde` |

The exact resolved `boot_app0.bin` path is:

```text
/tmp/wand-fw-tools.rjR9ym/platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin
```

The exact resolved uploader is:

```text
/tmp/wand-fw-tools.rjR9ym/platformio/packages/tool-esptoolpy/esptool.py
```

PlatformIO generated this argument shape:

```text
--chip esp32c3 --port <selected-port> --baud 921600
--before default-reset --after hard-reset write-flash -z
--flash-mode dio --flash-freq 80m --flash-size detect
0x0000 <bootloader.bin>
0x8000 <partitions.bin>
0xE000 <boot_app0.bin>
0x10000 <firmware.bin>
```

For a badge already placed in ROM download mode, the controlled hardware run
uses `--before no-reset` and the same four image/offset pairs. Device selection,
the verified recovery-backup gate, and post-write boot checks remain separate
hardware steps.

## Partition preservation boundary

The generated partition table was parsed back from `partitions.bin`:

| Partition | Offset | Size |
| --- | ---: | ---: |
| `nvs` | `0x9000` | 16 KiB |
| `phy_init` | `0xD000` | 4 KiB |
| `factory` | `0x10000` | 2,688 KiB |
| `storage` | `0x2B0000` | 1,280 KiB |

The four discrete writes do not target the organizer NVS, PHY calibration, or
storage partitions.

### Do not flash the combined image

`firmware/.pio/build/badge/firmware.factory.bin` exists only as build/archive
evidence: 754,400 bytes, SHA-256
`5c8754c88f09e00a596de69238b3001d160cd8e139cfd0e1122dd456d3c2a2f6`.
It was verified to contain the four component images at the offsets above.

It must **not** be written contiguously at offset zero. Its padding spans the
gaps holding the stock NVS and PHY data and would erase them. Keep it out of the
preservation upload path.

## Reproduction and qualification notes

- `firmware/platformio.ini` still used the mutable pioarduino `stable` URL and
  caret library ranges for this frozen candidate. The resolved versions above
  are therefore authoritative for reproduction.
- Exact source pins are intentionally deferred until after the frozen candidate
  hardware check. The verified platform asset for that follow-up is
  `https://github.com/pioarduino/platform-espressif32/releases/download/55.03.312/platform-espressif32.zip`;
  the five direct libraries should use the exact versions in the table above.
  The pin-only rebuild must start from a clean dependency cache and reproduce
  all four hashes before it replaces this candidate.
- `esptool image-info` validated the application checksum and SHA-256 footer,
  ESP32-C3 target, 4 MB flash size, DIO mode, 80 MHz flash frequency, and
  ESP-IDF 5.5.5 metadata.
- A clean cached PlatformIO rebuild succeeded, the generated partition binary
  parsed successfully, and each component was byte-compared with its location
  inside the archive image.
- No connected badge was read, written, reset, or monitored while producing
  this document. Hardware H0-H5 evidence remains pending.
