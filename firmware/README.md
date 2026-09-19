# Wand firmware

Native firmware for the Hack the North 2026 Hacker Badge (ESP32-C3), targeting
[BADGE-FIRMWARE-CONTRACT.md](../BADGE-FIRMWARE-CONTRACT.md) v1 for the Harry Potter Battle
Simulator: the target is a BLE GATT peripheral streaming 50 Hz raw acceleration straight to
Chrome (Web Bluetooth), with game feedback (phase, HP, shield, cast/block/hit/result
cues) on its screen and LEDs. No Lua launcher, no receiver badge, no serial bridge in play.

Why native: the stock Lua sandbox shares one 75 KB heap between the Lua state and Bluetooth, so a
Lua radio app has a few hundred bytes to work with. The badge's designer confirmed the custom
firmware route, and the organizers now publish an official
[custom-flash guide](https://badge.hackthenorth.com/custom-flash); this firmware follows it
(checklist below). Build size is not evidence of hardware qualification.

**Teammate starting point:** build/backup/install instructions are in [Safe teammate setup](#safe-teammate-setup).
For the laptop game and iPhone setup, start at the [repository README](../README.md).
The checked-in firmware is currently a **diagnostic image, not a playable badge release**.
It can advertise and exchange diagnostic BLE records, but the app deliberately refuses casting.
Installing it does not unblock badge gameplay; use the iPhone path for independent platform QA.
Real physical phone qualification remains separate and incomplete.

**Current source: 0.1.9 diagnostic-discoverability candidate, not flashed or gameplay-qualified.**
It changes only the diagnostic cold/watchdog default from `creator` BLE `off` to `creator` BLE
`on`, bumps the firmware version and RTC selection magic, and preserves capability bits at zero.
The explicit `profile creator off` row remains available for controlled no-radio matrix runs.
The 0.1.8 eight profile/BLE combinations below completed a short controlled comparison on
WAND-B602; all still show the overwrite anomaly. [Image/readback and matrix evidence](../docs/qa/firmware-0.1.8-matrix.md)
does not qualify gameplay. They preserve the conservative overwrite flag and never advertise casting capabilities.
The 0.1.3 live test passed OPEN/SYNC and streamed 48.7 Hz but marked nearly every sample
discontinuous because hardware STATUS bit 7 remained set; it is not a gameplay-qualified image.
0.1.4 measured `CTRL0/2/3/5/6/FIFO_CTRL=00`, revision `28`, and STATUS `FF → 00`
across each burst. The overrun clears, so it was not simply one latched startup error; FIFO was
disabled. The reason it reappears at the measured 20–21 ms cadence is not yet established.
0.1.5 explicitly selected the manufacturer's high-performance mode: power down, set CTRL0 HR=1
with OSR=000/DLPF1=0 (preserving reserved bits), then CTRL4=A0, CTRL1=47, delay/readback.
It still produced near-every-read overrun on the connected badge. This did not fix the defect.
0.1.6 keeps that exact configuration and removes the 16 ms post-read sleep: acquisition polls
once per RTOS tick, reports native ready-observation intervals and a histogram, no-data polls,
and elapsed time from the previous completed read to the next observed DRDY. `status` identifies
the tick rate and register-configured ODR separately from measured acquisition. Compute the
observed rate as `(fresh_reads - 1) * 1e6 / ready_span_us` between reconfigurations; it is a host
observation, not the sensor's physical acquisition timestamp. Measure disconnected first, then
with BLE/feedback active. All overrun/discontinuity flags remain enabled; there is no decimation.
INFO capabilities are deliberately **0**, so casting is blocked even though the configured-rate
field remains 50 (the codec does not allow a zero/unknown rate). This explicitly unsupported
diagnostic INFO is not a new valid v1 game profile or a claim that output cadence has passed.
The 0.1.6 measurement found ~50.8 Hz fresh reads with 1 kHz polling and 23,931 no-data polls
between 1,282 readings, yet 1,275 overwrite flags. Removing the sleep did not fix the anomaly.
0.1.7 makes one additional, manufacturer-documented change: after checking WHO=11/VERSION=28,
write `SOFT_RESET(68h)=A5` once at boot, wait a bounded 10 ms, recheck identity/read reset defaults,
then run the same configuration. This is not repeated during I²C recovery. The settling delay is
an implementation margin, not a documented reset-completion guarantee. `status` reports the
post-reset defaults; `trace` prints the first 16 fresh-read transitions captured in bounded RAM:
last no-data observation, first ready observation, six-byte burst start/end and post-burst STATUS.
Acquisition never prints the trace. All times are MCU observations in microseconds, not physical
sample timestamps. Capability zero and strict flags remain.

**0.1.7 hardware result: still blocked.** The 682,544-byte application was flashed and fully
read back with SHA-256 `c57d27d1e2c9a312e2d2de123b10ed25282e7b34b261d0c90851077a301690b1`.
Post-reset CTRL0/1/4 were `00/07/00`, confirming the observed reset defaults. All first 16
captured fresh-read bursts still showed `FF → 00`; preceding no-data observations were `00`
about 1 ms before the ready observation. The six-byte burst took about 272 µs, followed by
about 156 µs for the post-burst status read. Reset did **not** fix the anomaly. This image remains
diagnostic-only; creator/manufacturer clarification is required before reinterpreting the flag.
These MCU observations do not prove that the sensor never lost an internal measurement.

### 0.1.8 controlled matrix (one image, eight boot modes)

Cold boot, watchdog reset, invalid retained words, or selection from a different image defaults
to **`creator` with BLE `off`**. Each row starts with the existing boot-only documented sensor
reset and checked `CTRL0/1/4=00/07/00` defaults. The normal rows leave CTRL0 at zero; `high`
alone writes HR=1. All rows verify the exact final registers and retain bounded I²C recovery,
which reapplies only the same boot-selected row. No profile is automatically changed to fix an
error. Register-configured Hz is not a measured cadence claim.

| Profile | Configured Hz / range | CTRL0 / CTRL1 / CTRL4 | Scale | Acquisition without radio | Radio + feedback comparison |
| --- | --- | --- | --- | --- | --- |
| Creator baseline | 100 Hz / ±2g | `00 / 57 / 80` | 1 mg/count | `profile creator off` | `profile creator on` |
| Rate-only change from creator | 50 Hz / ±2g | `00 / 47 / 80` | 1 mg/count | `profile rate off` | `profile rate on` |
| Range-only change from rate row | 50 Hz / ±8g | `00 / 47 / A0` | 4 mg/count | `profile range off` | `profile range on` |
| High-performance change from range row | 50 Hz / ±8g | `01 / 47 / A0` | 4 mg/count | `profile high off` | `profile high on` |

Run these commands only on the explicitly authorized diagnostic device. Disconnect BLE before
selecting a row. `profile <name> off|on` stores a magic/version/complement-validated selection in
**RTC no-init RAM only** and immediately software-reboots; no NVS/flash setting is written.
The live selection is immutable. In 0.1.8, ordinary console `reboot` retains it; cold and unexpected resets
return to `creator off`. USB power removal counts as a cold boot only if battery power is also
absent. Verify `id`/`status` after every reset, including the new boot ID, selected row, BLE mode,
expected registers and actual readbacks. Existing display rotation/axes/LED preferences are
unchanged; fresh display rotation remains **3**.

BLE `off` does not initialize NimBLE, advertise or notify. Local screen/LED feedback still runs,
so both modes retain the same local workload. BLE `on` advertises and permits the existing
diagnostic OPEN/SYNC/SET_STATE/CUE session for combined-load measurement. INFO always reports
**capabilities `0`**, with the selected row's configured sample rate/range; browser casting stays
blocked, including for the 50 Hz/±8g rows. This is explicitly unsupported diagnostic INFO, not a
new v1 gameplay profile. A radio-enabled boot alone is not evidence of connected feedback load.

For each row, record the image hash/boot ID and `status`; collect a quiet interval without
console output, then another `status` for counter deltas. For the `on` comparison, establish the
diagnostic BLE session and actual feedback load before collecting that interval. `trace reset`
re-arms a bounded 16-burst capture without changing the sensor, counters or fault handling;
after enough real readings, `trace` prints native signed 12-bit counts and converted mg alongside
the same burst's no-data/ready/read timestamps and before/after STATUS. These values precede
axis remap and wire clamping. Use it for stationary six-face checks as well as combined load.
USB output occurs only on the console task; timing remains MCU observation, not sensor sample
time. Keep `echo off` and avoid printing while measuring quiet intervals. Overwrite flags,
native saturation, >40 ms gaps and >100 ms unhealthy behavior remain conservative in every row.
No row is released for gameplay by these tests.

### 0.1.9 diagnostic discoverability candidate

Cold boot, watchdog reset, invalid retained words, or selection from a different diagnostic image
now defaults to **`creator` with BLE `on`** so Chrome can list the badge after a power cycle. This
only starts diagnostic advertising; INFO still reports **capabilities `0`** and the browser must keep
the badge out of gameplay. The matrix controls are unchanged: use `profile creator off` for a no-radio
creator row and `profile <name> on` for radio/load rows. The retained RTC magic changed, so a stale
0.1.8 `creator off` software selection is intentionally ignored by this source.

FIFO is a possible **future acquisition design**, not an implemented workaround. The same
datasheet documents a separate FIFO count/overflow register (`2Fh`, printed page 20), but its
count-unit/read-width wording needs confirmation against the `69h` data-port description
(page 27). A future qualification must prove count/pop behavior, overflow detection, complete
XYZ records and sample-age bounds. FIFO evidence cannot retroactively make the current `27h`
overwrite flag harmless. No FIFO configuration or additional sensor change has been made.

Earlier teammate measurements on `WAND-46BA`
do not qualify this build. The exact upstream 0.1.0 image from `6a50929` failed OPEN on
`WAND-B602`; [that diagnostic record](../docs/qa/firmware-main-6a50929.md) is historical.
Portable protocol tests pass; record the new image hash, flash/readback and live BLE results
separately before calling this hardware game-ready. Battery-only boot, six-face axes, combined
load, 20 reconnects, endurance and Windows remain hardware gates.

### 0.1.3 fixes and evidence boundary

- STATUS and MOTION use explicit copied notification payloads targeted at one connection.
  STATUS reads remain health, so deferred characteristic updates cannot overwrite OPEN/SYNC ACKs.
- Connect/disconnect resets the session on the NimBLE callback before new CONTROL is processed;
  generation-tagged sends cannot cross a reconnect. Only one central is configured/accepted.
- Lock order is session mutex → send mutex → NimBLE host internals. Link callbacks release
  the send mutex before entering the session handler. Pinned NimBLE's `ble_gap_call_event_cb`
  asserts that GAP callbacks run without its host lock. No SPI/I2C/USB output runs under these locks.
- Epoch change, lease expiry and reconnect cancel screen/LED cues on the next presentation turn.
  Cue activation is serialized with session changes; an in-progress display transfer may finish,
  but no old cue is reactivated afterward. Expiry uses `>=`, including wrap-safe exact deadlines.
- The sensor is checked as SC7A20 (`0x11`), with configuration readback `47/A0`. Native signed
  conversion has independent tests. `STATUS[7]` records the sensor's overwrite report,
  not an independently measured lost-sample count. A >40 ms acquisition gap also marks
  discontinuity; >100 ms with no fresh reading reports unhealthy. No zero sample is invented.
- Acquisition owns its counters and publishes a short locked snapshot; no USB printing runs
  on that task. `echo` is now at most 5 Hz snapshots in the console loop. USB is never awaited
  at boot, disconnected writes are skipped, and `status` reports reset reason/resource headroom.
- LEDs are capped at 24/255, BLE TX at +3 dBm. These lower power peaks but **do not prove** the
  reported battery reset is fixed. Do not disable the brownout detector or guess a battery voltage.
- SDK/platform and direct libraries are pinned. The bundled NimBLE host is built peripheral-only,
  one connection, standard MTU support and both subscriptions; host flow control stays disabled.
  Unused seesaw/SD libraries are excluded. No source files in the toolchain are patched.

Run the portable checks from the repository root (no hardware access):

```sh
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/protocol_test.cpp firmware/src/proto.cpp -o /tmp/wand-firmware-protocol-test
/tmp/wand-firmware-protocol-test
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/tests/stubs -Ifirmware/include firmware/tests/diagnostic_test.cpp firmware/src/diagnostic.cpp firmware/src/proto.cpp -o /tmp/wand-firmware-diagnostic-test
/tmp/wand-firmware-diagnostic-test
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/console_defaults_test.cpp -o /tmp/wand-firmware-console-defaults-test
/tmp/wand-firmware-console-defaults-test
```

Register reference: manufacturer-authored [Silan SC7A20H datasheet v1.1](https://www.unikeyic.com/media/datasheet/202511/59f66cd3197e2534279e18eca6a9f806.pdf),
mirrored by a component distributor. Printed pages 14–15 specify CTRL0 HR and the 50 Hz ODR;
page 17 lists 24.9 Hz bandwidth for high-performance at 50 Hz versus 399.9 Hz for normal mode;
page 19 defines STATUS overrun bits. Physical cadence/overrun/scale validation is still required.
Printed page 27 specifies `SOFT_RESET(68h)=A5` and VERSION(70h)=28. Printed page 2 gives
1 mg/count at ±2g and 4 mg/count at ±8g; pages 16–17 define BDU, endian and full-scale bits.
The creator's 100 Hz/±2g baseline is also recorded in
[the creator HAL extract](../docs/hardware/custom-firmware-hal.md).

## Safe teammate setup

### 1. Build without touching a badge

Run from the repository root. Use a separate firmware environment, not the game's Python 3.11
environment. The measured Mac tool environment is Python **3.13.5**, PlatformIO **6.2.0**,
esptool **5.4.0**, pyserial **3.5** and Bleak **2.0.0**. The commands below reproduce those direct
tool pins; Windows installation/build and hardware behavior still need their own qualification.
Install Python 3.13 first if it is not available. On Windows use **PowerShell**, not Git Bash/MSYS.

macOS:

```sh
python3.13 -m venv firmware/.venv
source firmware/.venv/bin/activate
python -m pip install platformio==6.2.0 esptool==5.4.0 pyserial==3.5 bleak==2.0.0
pio run -d firmware -e badge
```

Windows PowerShell, without changing script-execution policy:

```powershell
py -3.13 -m venv firmware/.venv
$wandTools = (Resolve-Path firmware/.venv/Scripts).Path
$env:PATH = "$wandTools;$env:PATH"
python -m pip install platformio==6.2.0 esptool==5.4.0 pyserial==3.5 bleak==2.0.0
pio run -d firmware -e badge
```

First build downloads the pinned toolchain and libraries from their normal upstream sources.
[`platformio.ini`](platformio.ini) pins pioarduino **55.03.312**, Arduino-ESP32 **3.3.12** /
ESP-IDF **5.5.5**, NimBLE-Arduino **2.5.1**, NeoPixel **1.15.5**, GFX **1.12.6**, BusIO **1.17.4**
and ST7735/ST7789 **1.11.0**. No stock Lua IDE is needed. Generated `.pio/` and `.venv/` files
are ignored, not release artifacts to commit. The application is
`firmware/.pio/build/badge/firmware.bin`; the generated table is `partitions.bin` beside it.

**Do not use `badge_flash.py flash` or `pio run -t upload` for the app-only procedure below.**
The existing helper's `flash` subcommand verifies a prior device-bound backup, but then invokes
PlatformIO's multi-artifact uploader. It does **not** check the live partition table against the
build or independently read back the whole application. Its `restore` command writes the entire
4 MiB image at offset zero. Neither belongs in the normal installation path.

### 2. Identify and preserve one explicitly approved badge

Flashing requires separate approval **for this device and image**. A repository push or software
test is not flash approval. Before connecting: confirm board revision, correct AA/USB power
configuration with the creators, and the device-specific recovery/reset procedure. Use a data
cable, close the badge IDE, serial monitor and Chrome/Bleak connection, and attach only one badge.

```sh
python tools/badge_flash.py list
python tools/badge_flash.py --help
```

Use the exact listed port below (`/dev/cu.usbmodem…` on macOS, `COM…` on Windows). Enter the ROM
download mode using the demonstrated procedure for that badge. Start/GPIO9 held during reset is
the manual recovery route; unplug/replug USB is **not** a guaranteed reset while AA power remains
connected. USB-Serial-JTAG may support automatic entry, but it is not assumed here. A blank
display in confirmed download mode is expected. If unsure, stop and ask the firmware maintainer.

```sh
python tools/badge_flash.py --port PORT_FROM_LIST backup
```

Replace `PORT_FROM_LIST` before running. The helper reads **all 4 MiB twice**, compares hashes and
device base-MAC identities, then retains one image plus a JSON verification manifest. Backup roots:

- macOS: `$XDG_DATA_HOME/wandduel/badge-backups`, or `~/.local/share/wandduel/badge-backups`.
- Windows: `%LOCALAPPDATA%\wandduel\badge-backups`.

Keep the image and manifest private, outside Git, with an additional protected copy. The backup
captures what is installed **now**; it is a stock recovery image only if stock was still installed.
Do not use another badge's backup or claim stock restoration without a verified stock artifact.
The helper leaves the badge in download mode. Opening the USB console can reset this Mac's badge;
do not run `monitor`/`cmd` between the identity checks and application readback.

### 3. Guarded app-only installation

This is a maintainer-supervised procedure, **not a one-click installer**. After approval, record the
commit, board, power state, exact base MAC from `read-mac`, full backup/manifest paths, generated
partition table and application hashes. Do not substitute the advertised BLE MAC for the base MAC.
`partitions_badge.csv` matches the measured WAND-B602 layout, not every possible badge revision.

The only written artifact below is `firmware.bin` at **`0x10000`**, bounded by the factory slot size
**`0x2a0000`**. Reads compare the generated table, live table and that badge's backup table over
the same 3,072 bytes at **`0x8000`**. Any mismatch stops the operation: do not "fix" it by uploading
a new partition table. Application sectors are erased as part of writing, but no bootloader,
partition table, NVS, PHY, littlefs storage or eFuse is written. Current firmware may later persist
its own explicit settings in the existing `hpwand` NVS namespace; ordinary installation preserves it.

First read the selected badge's identity (replace the port):

```sh
esptool --chip esp32c3 --port PORT_FROM_LIST --before no-reset --after no-reset read-mac
```

macOS: replace **all three** `REPLACE_…` values (the base MAC is 12 lowercase hexadecimal digits,
without colons). The subshell stops at the first failed check; its
unique temporary directory contains the partition/readback evidence, not a replacement backup.

```sh
(
  set -eu
  wandPort='REPLACE_WITH_EXACT_PORT'
  wandMac='REPLACE_WITH_12_HEX_BASE_MAC'
  wandBackup='REPLACE_WITH_ABSOLUTE_VERIFIED_BACKUP_BIN_PATH'
  wandRun="$(mktemp -d "${TMPDIR:-/tmp}/wandduel-flash.XXXXXX")"
  wandImage='firmware/.pio/build/badge/firmware.bin'
  wandTable='firmware/.pio/build/badge/partitions.bin'
  python -I -c 'import sys; sys.path.insert(0,"tools"); from badge_flash import verify_backup; from pathlib import Path; verify_backup(Path(sys.argv[1]),sys.argv[2])' "$wandBackup" "$wandMac"
  test "$(stat -f %z "$wandTable")" -eq 3072
  wandBytes="$(stat -f %z "$wandImage")"
  test "$wandBytes" -gt 0
  test "$wandBytes" -le 2752512
  esptool --chip esp32c3 --port "$wandPort" --before no-reset --after no-reset read-mac > "$wandRun/identity.txt"
  python -I -c 'import sys; sys.path.insert(0,"tools"); from badge_flash import parse_mac; assert parse_mac(open(sys.argv[1]).read()) == sys.argv[2], "Device identity changed"' "$wandRun/identity.txt" "$wandMac"
  esptool --chip esp32c3 --port "$wandPort" --before no-reset --after no-reset read-flash 0x8000 0xc00 "$wandRun/partitions-live.bin"
  cmp "$wandTable" "$wandRun/partitions-live.bin"
  python -I -c 'import sys; sys.path.insert(0,"tools"); from badge_flash import sha256_file,sha256_region; from pathlib import Path; assert sha256_file(Path(sys.argv[1])) == sha256_region(Path(sys.argv[2]),0x8000,0xc00), "Backup partition table differs"' "$wandTable" "$wandBackup"
  shasum -a 256 "$wandImage" "$wandTable"
  esptool --chip esp32c3 --port "$wandPort" --before no-reset --after no-reset write-flash 0x10000 "$wandImage"
  esptool --chip esp32c3 --port "$wandPort" --before no-reset --after no-reset read-flash 0x10000 "$wandBytes" "$wandRun/application-readback.bin"
  cmp "$wandImage" "$wandRun/application-readback.bin"
  shasum -a 256 "$wandRun/application-readback.bin"
  printf 'Verified app-only readback. Preserve evidence from %s\n' "$wandRun"
)
```

Windows **PowerShell 7.3+**: use the same selected port/lowercase MAC/private backup. This block
requires modern native argument passing so the Python checks are not reinterpreted by Windows
PowerShell 5.1. It stops on a failed command/check without changing machine-wide execution policy.
If PowerShell 7.3+ is unavailable, ask a maintainer rather than simplifying these checks.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use PowerShell 7.3 or newer' }
  $PSNativeCommandArgumentPassing = 'Standard'
  $wandPort = 'REPLACE_WITH_EXACT_COM_PORT'
  $wandMac = 'REPLACE_WITH_12_HEX_BASE_MAC'
  $wandBackup = 'REPLACE_WITH_ABSOLUTE_VERIFIED_BACKUP_BIN_PATH'
  $wandRun = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('wandduel-flash-' + [guid]::NewGuid()))).FullName
  $wandImage = 'firmware/.pio/build/badge/firmware.bin'
  $wandTable = 'firmware/.pio/build/badge/partitions.bin'
  function Run-WandTool { param([string]$Tool, [string[]]$ToolArgs) & $Tool @ToolArgs; if ($LASTEXITCODE -ne 0) { throw "$Tool failed" } }
  Run-WandTool python @('-I', '-c', 'import sys; sys.path.insert(0,"tools"); from badge_flash import verify_backup; from pathlib import Path; verify_backup(Path(sys.argv[1]),sys.argv[2])', $wandBackup, $wandMac)
  if ((Get-Item $wandTable).Length -ne 3072) { throw 'Unexpected partition artifact size' }
  $wandBytes = (Get-Item $wandImage).Length
  if ($wandBytes -le 0 -or $wandBytes -gt 2752512) { throw 'Application exceeds factory slot' }
  $wandIdentity = Join-Path $wandRun 'identity.txt'
  Run-WandTool esptool @('--chip','esp32c3','--port',$wandPort,'--before','no-reset','--after','no-reset','read-mac') | Set-Content -Encoding ascii $wandIdentity
  Run-WandTool python @('-I', '-c', 'import sys; sys.path.insert(0,"tools"); from badge_flash import parse_mac; assert parse_mac(open(sys.argv[1]).read()) == sys.argv[2], "Device identity changed"', $wandIdentity, $wandMac)
  $wandLiveTable = Join-Path $wandRun 'partitions-live.bin'
  Run-WandTool esptool @('--chip','esp32c3','--port',$wandPort,'--before','no-reset','--after','no-reset','read-flash','0x8000','0xc00',$wandLiveTable)
  if ((Get-FileHash $wandTable).Hash -ne (Get-FileHash $wandLiveTable).Hash) { throw 'Live partition table differs' }
  Run-WandTool python @('-I', '-c', 'import sys; sys.path.insert(0,"tools"); from badge_flash import sha256_file,sha256_region; from pathlib import Path; assert sha256_file(Path(sys.argv[1])) == sha256_region(Path(sys.argv[2]),0x8000,0xc00), "Backup partition table differs"', $wandTable, $wandBackup)
  Get-FileHash $wandImage,$wandTable
  Run-WandTool esptool @('--chip','esp32c3','--port',$wandPort,'--before','no-reset','--after','no-reset','write-flash','0x10000',$wandImage)
  $wandReadback = Join-Path $wandRun 'application-readback.bin'
  Run-WandTool esptool @('--chip','esp32c3','--port',$wandPort,'--before','no-reset','--after','no-reset','read-flash','0x10000',"$wandBytes",$wandReadback)
  if ((Get-FileHash $wandImage).Hash -ne (Get-FileHash $wandReadback).Hash) { throw 'Application readback differs' }
  Get-FileHash $wandReadback
  Write-Output "Verified app-only readback. Preserve evidence from $wandRun"
}
```

These procedures leave the badge in download mode for preservation checks. Return to application
boot using its approved reset/power procedure **without holding Start**; port names may change.
Do not repeatedly flash if the application fails to boot. Preserve the evidence and use the
device-specific recovery procedure. Full-image restore is a separate approved operation that
overwrites all flash settings/storage; `badge_flash.py restore` alone does not perform an independent
post-write full readback. A backup cannot recover damaged hardware or changed eFuses.

### 4. Verify diagnostics, then qualify before gameplay

After normal boot, use the same activated firmware tool environment and exact newly listed port:

```sh
python tools/badge_flash.py --port PORT_FROM_LIST cmd id status selftest
python tools/badge_flash.py --port PORT_FROM_LIST monitor --seconds 10
python tools/wand_ble_check.py --name WAND-XXXX --scan 15 --seconds 5
```

Replace placeholders; close the monitor before another console command and disconnect Chrome
before Bleak. Console opening can reset the badge; do not open it halfway through a timing run.
`id` must identify the built image and selected diagnostic profile; cold 0.1.9 defaults to
`creator`, BLE `on`, capabilities **0**. The game-ready BLE check is expected to fail its INFO
gate on this diagnostic build. That is truthful rejection, not a reason to remove the gate.

For separately approved profile experiments, `python tools/badge_matrix.py --help` describes the
0.1.9-only runner. It **reboots through eight profiles and sends real display/LED feedback**;
it is not passive monitoring. Leave it off the ordinary player startup path. Its short comparisons
cannot replace six faces, clipping tests, combined-load endurance, battery operation, reconnects
and Windows/two-badge acceptance. See [the contract's H0–H5 gates](../BADGE-FIRMWARE-CONTRACT.md#8-acceptance-and-handoff-checklist).

**Port busy/access denied:** close the actual IDE/monitor owning the port, then re-list ports. Do
not kill unrelated processes or disable security software. **Not in the pairing list:** verify
normal app boot, Bluetooth permission, no other central, and the actual `id`/`status` version.
Installed 0.1.8 cold boots intentionally use BLE `off`; 0.1.9 changes that default but remains
diagnostic. A new source build is not proof that a connected badge has been flashed.

## Checked against the official custom-flash guide

| Guide item | This firmware |
| --- | --- |
| ESP32-C3-MINI-1-N4, 4 MB, USB-Serial-JTAG console | `esp32-c3-devkitm-1` board, USB CDC on boot (`ARDUINO_USB_MODE=1`), Arduino-ESP32 (guide: "also works, same GPIOs") |
| Flash DIO, 80 MHz, app at 0x10000 | `board_build.flash_mode = dio`, `f_flash = 80 MHz`; app at 0x10000 in the factory slot of `partitions_badge.csv` (same table as stock) |
| LCD MOSI 10 / CLK 1 / CS 2 / DC 0 / RST 4, 40 MHz, mode 0, RGB565 | `pins.h`; Adafruit ST7789 at 40 MHz, mode 0, 16-bit colour |
| Init: invert_color(true), swap_xy(true), mirror(true,false) | Adafruit init sends INVON; the tested panel's current fresh rotation is **3**. Verify the actual panel; `rot <0-3>` persists an explicitly selected orientation |
| I2C SDA 5 / SCL 6, 400 kHz; accel 0x19, NFC 0x26 | `Wire.begin(5, 6, 400000)`; only the accelerometer is initialised, NFC untouched (guide: don't init it if unused) |
| Accel WHO_AM_I 0x11; CTRL_REG1 0x57; CTRL_REG4 0x80; ZYXDA poll; OUT_X_L auto-increment; raw>>4 | WHO_AM_I must be 0x11; boot-selected matrix starts at the creator's **0x57/0x80**, 100 Hz/±2g, 1 mg/count; all rows verify readbacks and check new-data/overrun flags |
| Bounded I2C timeouts + retry (NFC can wedge the bus) | 10 ms bus timeout; after 5 consecutive failures the bus is re-initialised and the sensor reconfigured; count in `status` (`i2c_recover`) |
| HC165 DATA 7 / LOAD 20 / CLK 21; order A,B,Home,Down,Left,Right,Up,Aux1; active-low; latch then 8× sample+clock | `buttons.cpp`: same protocol; bits 7..0 = A,B,Home,Down,Left,Right,Up,Aux1, inverted so 1 = pressed |
| Start on GPIO9, active-low, strapping pin | read with pull-up; only used to re-seed the activity baseline |
| Poll ~10 ms + debounce; Aux1 is a maintained switch | polled every 10 ms, 12 ms debounce; Aux1 treated as a level |
| WS2812B ×6 on GPIO3, GRB, RMT; order UL, UR, MR, BR, BL, ML; keep it dim | Adafruit NeoPixel (RMT on ESP32), `NEO_GRB`; brightness 24/255; battery-loaded validation pending |
| BLE: init once, never deinit; trim buffers | BLE-on boots initialize NimBLE once; BLE-off boots never initialize it. Legacy advertising resumes on disconnect; peripheral-only with one central. `status` reports heap/stack/notification failures; measure under load |
| Console: bare `\r` line ending; <256-byte USB writes; keep a button-inject/print path | `\r`, `\n` and `\r\n` all end a line; replies are short; `btn` prints the HC165 byte and held buttons |
| Checklist: Start read, HC165 read, 10 ms debounce, ST7789 fill-screen, accel WHO_AM_I + mg, WS2812 chase (dim) | boot shows reset reason and sensor identity; no NFC initialization or shared-bus scan |

## Bring-up checklist (first time on hardware)

1. After separately approved flash, open the monitor. Expect `HPHELLO|fw=0.1.9|name=WAND-xxxx|...|sensor=1`. Verify `profile=creator|ble=on` after a cold boot. The screen
   shows boot diagnostics (accelerometer id 11, reset reason) then the wand screen;
   LEDs breathe blue. Fresh badges default to `rot 3`; use `rot 0`, `rot 1`, or `rot 2` if the panel differs. The selected rotation is saved in NVS.
2. `selftest` runs the contract's golden vectors on the badge. Expect `selftest failures=0`.
3. Axis check: lay the badge face up on a table and type `axes`. The contract wants about
   `0, 0, +1000` mg. If not, remap without reflashing, e.g. `axes -y +x +z` means contract X = −chip Y,
   contract Y = +chip X, contract Z = +chip Z. This saves the map for the next reboot so a live
   boot's axes never silently change. Reboot and check all six faces; ±100 mg tolerance.
4. `btn` while holding buttons confirms the shift-register order.
5. `python tools/wand_ble_check.py --name WAND-xxxx` from the activated firmware tool environment on the
   laptop walks the whole contract over real BLE (scan, INFO, OPEN, SYNC, SET_STATE, cues, motion
   stream, health) and prints PASS/FAIL per step with rate and interval statistics. Use `--scan 15`
   in a crowded venue. Chrome must be disconnected from the badge while it runs.
6. The 0.1.9 diagnostic image deliberately fails the game-ready INFO gate. Do not enter gameplay
   until an accurately profiled, measured image restores the required capabilities. Collect
   technical counters through scripts, not a debug dashboard.
7. `status` prints counters (acquired/notified/dropped/i2c_recover/heap) for the transport gate;
   `echo on` prints low-rate snapshots, not a raw capture; use BLE for full-rate evidence.

## What the badge does

| Situation | Screen | LEDs |
| --- | --- | --- |
| Advertising | `WAND xxxx`, "SAY THE SPELL, MOVE", gesture hints | slow blue breath |
| Connected, no state yet | "WAITING FOR GAME" | violet glow that brightens with movement (amber tint while state is stale) |
| SET_STATE practice/countdown/playing | phase text, HP bar with SHIELD / DISARMED flags | violet glow; steady cyan while shield bit set |
| CUE accepted cast | `STUPEFY!` etc. in the spell colour | colour sweeps around the ring |
| CUE blocked / damage | `BLOCKED` / `HIT by ...` | cyan ripple / red strobe |
| SET_STATE won/lost/draw + result CUE | `VICTORY` / `DEFEATED` / `DRAW`, `YOU WIN` ... | gold chase / red fade / white |
| State lease expired or disconnect | back to neutral within the lease (≤1.5 s) | glow with amber tint |

The activity bar and the LED brightness are local motion feedback only; they never claim a
recognised spell. Buttons do nothing in play except START, which re-seeds the local activity
baseline.

## Contract implementation notes

* Records are encoded field by field (no padded structs). `decode_motion` is strict for the
  self-test; the browser is the real consumer.
* Sequence rule after OPEN: `0 < (new − last) mod 65536 < 32768`; a well-formed in-order command
  consumes its sequence even when rejected; exact duplicate bytes re-ACK the cached result with the
  original receipt time; same sequence with different bytes is `6 stale`.
* A second OPEN on the same connection (different bytes) is rejected with `2 wrong session`.
  SET_STATE too far ahead (>1500 ms) and CUE too far ahead (>500 ms) are `3 invalid argument`;
  already-due deadlines (`lead <= 0`) are `4 expired`. A CUE whose epoch does not match the live
  state is `3`.
* Frames that are not 20 bytes get no STATUS result. NimBLE-Arduino cannot return an ATT error from
  a write callback, so the ATT write itself is acknowledged; the contract's "reject the ATT write"
  for unidentifiable frames is met only in the sense that no result is fabricated.
* STATUS read returns current health; results are one-off notifications. Health is notified at 1 Hz
  and immediately when its bits change (sensor, stream, stale).
* Motion timestamps are taken immediately after a fresh register burst, not at notification.
  Sensor acquisition-to-read latency depends on scheduling/I2C and must be measured under load.
  Local dropped/overrun count is not radio-delivery proof; compare receiver sequence/capture gaps.
* Device id = the chip's BLE MAC (stable across reflash). `boot_id` is random per boot.
* Acquisition and MOTION notifications run on their own FreeRTOS task (priority 4, above the
  Arduino loop). Presentation uses a 14.4 KB text canvas and 25 Hz LED frames. Separate tasks do
  not prove timing isolation; combined-load acquisition/ACK/resource checks remain mandatory.

## Console commands (USB serial, diagnostics only)

`help`, `status`, `trace [reset]`, `profile creator|rate|range|high off|on`, `id`, `selftest`, `axes [+x -y +z]`, `btn`, `rot <0-3>`, `leds on|off`,
`echo on|off`, `recal`, `reboot`, `flashmode` (reboot into the ROM download mode for reflashing).
Rotation/axes/LED settings persist in NVS; the diagnostic profile/BLE selection uses RTC RAM
only and takes effect after software reboot. Lines may end in `\r`, `\n` or both.

## Source layout

```
include/pins.h      pin map (matches the official guide; button order verified on hardware)
include/config.h    UUIDs, contract codec bounds, timing limits
include/diagnostic.h pure profile/RTC validation/scale/INFO definitions for portable tests
src/diagnostic.cpp  immutable boot selection, RTC-only next-boot configuration
src/proto.cpp       codec + Session rules + golden-vector self-test (pure C++, no Arduino)
src/ble.cpp         NimBLE GATT server, link generation, direct CONTROL callbacks/payload notifications
src/accel.cpp       SC7A20 I2C, selected profile, native count/timing trace, bounded bus recovery
src/wand.cpp        acquisition task: axis remap, saturation, MOTION notifications, activity level
src/present.cpp     state/cue presentation glue; display.cpp (ST7789) and leds.cpp (WS2812B)
src/console.cpp     serial commands and NVS settings
src/main.cpp        boot diagnostics, session/connection lifecycle, main loop
```

Mirrors of the codec: `apps/host/phantom_host/wand_protocol.py` and
`apps/web/src/lib/wandProtocol.ts`, both pinned to the same golden vectors.
