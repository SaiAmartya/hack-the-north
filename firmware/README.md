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

## 0.2.x — gameplay image (current source: 0.2.3)

**What changed from the 0.1.x diagnostic images.** The badge boots straight into the contract's
gameplay profile and advertises after **every** kind of reset:

- **Boot profile:** native **50 Hz / ±8 g** (`CTRL1=0x47`, `CTRL4=0xA0`, normal mode) is the default row.
  INFO reports `capabilities 0x0F`, `sample_hz 50`, `range_g 8`, `axis_convention 1`, so the browser's
  duel gate passes. The creator 100 Hz/±2 g row and the 50 Hz/±2 g row remain reachable from the console
  and stay **capabilities 0** (diagnostic). The high-performance ±8 g row is also gameplay-capable.
- **Radio always on:** 0.1.8 booted with BLE **off** on any cold, USB, brownout or watchdog reset and only
  kept the radio on across a software reboot, which is why a badge "disappeared" from the Chrome chooser
  after a power cycle. 0.2.0 defaults to BLE on; only an explicit `profile <row> off` console command
  turns it off for the *next* software reboot, and the RTC magic changed so 0.1.x selections are ignored.
- **Advertising watchdog:** the loop re-arms connectable advertising every 500 ms whenever the badge is
  idle and the stack reports it stopped; `status` counts `adv_restarts` and `connections`.
- **Connection parameters:** on connect the badge requests a **15–30 ms** interval, no slave latency
  and a 3 s supervision timeout, and publishes the same preferred range in its scan response. `status`
  reports the negotiated `conn_interval_us`. Advertising ran at 20–40 ms in 0.2.0 (40–80 ms since 0.2.1, below).
- **Overwrite flag no longer poisons the stream.** Every 0.1.x image counted the sensor's STATUS bit 7
  as a lost sample and flagged nearly every MOTION record discontinuous, which the browser rightly
  rejected — so the badge could never feed a gesture. Measured fresh-read cadence on this sensor equals
  the configured output rate (97 Hz at 100 Hz, 48.7 Hz at 50 Hz, 1 kHz polling, thousands of no-data polls
  in between), which is impossible if a sample were overwritten before every read. 0.2.0 therefore treats
  the flag as a diagnostic counter (`overrun_flags`) and derives discontinuity from **measured** evidence:
  a fresh-read gap over 1.5 output periods (30 ms at 50 Hz, so a single lost native sample is always
  caught), a sample older than 100 ms at notification time, a refused notification, a bus error, or a
  stream (re)start. `gaps` in `status` is the real cadence-loss counter and `lost = dropped + gaps` is
  what STATUS health reports as `detail0`.
- **Capture time:** `capture_ms` is the MCU clock at the moment new-data was observed, before the burst read.
- **Paced acquisition:** after each fresh read the task sleeps until 4 ms before the next expected
  sample (anchored to the capture time, so processing and notify time never eat the margin), then
  polls once per tick; no 1 kHz busy-polling of the shared I²C bus between samples.
- **Bounded I²C recovery back-off:** a wedged bus is re-initialised at most every 250 ms.
- **0.2.1 battery soft start:** radio 1.2 s after boot, LEDs 2 s after the radio, 0 dBm default TX power
  (`txpower` persists another), 40–80 ms advertising, and an RTC-retained brownout count that delays
  the radio and lowers power after each brownout reset (reason 9). See
  [the change record](../docs/qa/firmware-0.2.0.md#021--battery-brownout-fix-flashed).
- **0.2.3 HUD and button casts (built September 20, not yet flashed):** the screen is a duel HUD:
  heart + HP number + coloured HP bar, seven cooldown rings (one per spell, in spell-code order) whose
  inner disc drains clockwise with the seconds left printed inside and the casting button shown while
  ready, three-letter spell labels, the cue line, the movement bar and a hint. Rings start on an
  accepted-cast cue during `playing` from the referee's cooldown table (2/3/6/6/9/10/15 s) plus a 500 ms
  recovery dim, and clear with the lease/epoch/phase. Buttons A/B/RIGHT/UP/LEFT/DOWN/HOME send a
  STATUS kind-2 button cast request (Stupefy/Protego/Expelliarmus/Incendio/Sectumsempra/Petrificus
  Totalus/Expecto Patronum) that the browser turns into a full cast; START still recalibrates. Rings are
  drawn through a 40×40 RGB565 canvas with a precomputed angle table, so a full redraw of all seven
  costs a few milliseconds. Build: 662,833 bytes flash, 28,008 bytes static RAM (`pio run -e badge` from
  PowerShell with the PATH `pio`; the `uv run --with platformio` route currently trips over the penv's
  `littlefs` import on this Windows machine).
- **0.2.2 seven-spell cue codes:** CUE `spell` accepts codes 4–7 (Incendio, Sectumsempra, Petrificus
  Totalus, Expecto Patronum) with their own display names, TFT colours and LED colours; the display
  hint no longer lists three moves. Contract section 5 documents the codes; the browser folds them
  onto 1/3/2 for older firmware. The portable self-test pins "spell 7 accepted, spell 8 invalid".
  **Flashed to WAND-46BA on September 19 (late evening)** with `badge_flash.py restore-boot` (that badge
  still carried the PlatformIO bootloader from its earlier full-image 0.1.8 flash; the partition table
  was already byte-identical to stock) followed by `badge_flash.py flash`: app image 688,032 bytes at
  `0x10000`, SHA-256 `59ca598da2f4a3d8143e6d8f08a0465ced3c9d235ef4f6659798aa208150d630`, readback
  identical; 658,009 bytes flash / 26,384 bytes static RAM. On-device `selftest`: 0 failures including
  the new cue-code checks. `tools/wand_ble_check.py --name WAND-46BA --seconds 5`: all pass (INFO
  0.2.2/caps 0x0F/50 Hz/±8 g, spell 7 cue accepted, spell 8 rejected, 259 frames at 49.5 Hz with zero
  gaps or discontinuities, command RTT median 47 ms under load, rest reading x=−31 y=155 z=1042 mg).
  Note: a BLE client that dies without disconnecting leaves `connections=1` on the badge and it drops
  out of scans until a console `reboot` (or a replug).

**Evidence so far (source-level, this Mac):** portable protocol golden vectors, the new continuity-policy
test, the boot-profile/RTC test, axis-mapping and console-default tests all pass. The 0.2.0 PlatformIO build
was 655,961 bytes flash, 26,304 bytes static RAM, image `.pio/build/badge/firmware.bin` SHA-256
`3cce4f3c3658e526413387ecf17f0d4491698a34e725ecd44eae4571e54cbc1e`; the 0.2.1 image is SHA-256
`492bf8e42f423ee8bdbdc12338b810e71470fefdc7441c55b9fd911381f9d577`.
**Flashed to WAND-B602:** 0.2.0 (app slot only, readback verified; the stock bootloader region was restored
from the verified backup after a failed PlatformIO upload attempt), then 0.2.1 (app slot only, readback
verified); both in [the 0.2.0 change record](../docs/qa/firmware-0.2.0.md). The source since the 0.2.1 image
has only had dead code removed (no version bump), so a fresh build is not byte-identical to the flashed image.
Hardware results (Chrome chooser after a power cycle, stream rate, discontinuity count, reconnects)
belong in that record once the QA card has been run; it has not yet been run on 0.2.1.
Battery-only boot, six faces, 20 reconnects, endurance and Windows remain H-gates.

**Build.** The pinned pioarduino platform needs PlatformIO Core **6.2.0 or newer**; an older core (the
`~/.platformio/penv` core was 6.1.19 when this bit on September 19) *uninstalls* the pinned platform instead
of building. Build with `uv`, which fetches a current core; the command is the same in macOS shells and
Windows PowerShell and runs from the `firmware` directory:

```sh
cd firmware
uv run --python 3.12 --with "platformio>=6.2.0" pio run -e badge
```

Never `pio run -t upload` on a badge; install with `badge_flash.py flash`
([section 3](#3-guarded-app-only-installation)).

## 0.1.x history (diagnostic images)

The 0.1.3 live test passed OPEN/SYNC and streamed 48.7 Hz but marked nearly every sample
discontinuous because hardware STATUS bit 7 remained set. 0.1.4 measured
`CTRL0/2/3/5/6/FIFO_CTRL=00`, revision `28`, and STATUS `FF → 00` across each burst. 0.1.5 tried the
manufacturer's high-performance mode; 0.1.6 removed the post-read sleep and measured ~50.8 Hz fresh
reads with 23,931 no-data polls between 1,282 readings yet 1,275 overwrite flags; 0.1.7 added the
boot-only `SOFT_RESET(68h)=A5` and still saw `FF → 00` on all 16 traced bursts (six-byte burst ≈ 272 µs).
0.1.8 ran an eight-row profile/BLE matrix; 0.1.9 (never flashed) only changed the cold-boot default to
BLE on. None of those images advertised duel capabilities. 0.2.0 keeps the `trace` and `status`
instrumentation, the bounded recovery and the console matrix; it changes the *interpretation* above.

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

Needs `uv` on PATH; it fetches the pinned Python and a current PlatformIO Core into its own cache,
separate from the game's Python 3.11 environment. The pinned pioarduino platform requires PlatformIO
Core **6.2.0 or newer**: an older core (the `~/.platformio/penv` core was 6.1.19 when this bit on
September 19) removes the pinned platform instead of building, so do not build with a stray `pio`.
On Windows use **PowerShell**, not Git Bash/MSYS. The build command is the same on both and runs
from the `firmware` directory:

```sh
cd firmware
uv run --python 3.12 --with "platformio>=6.2.0" pio run -e badge
```

The `tools/` scripts run the same way from the repository root, with their dependencies named per
call: `uv run --with pyserial --with esptool python tools/badge_flash.py …` and
`uv run --python 3.12 --with bleak python tools/wand_ble_check.py …` (exact commands below). Direct
tool versions measured on this Mac on September 19 were PlatformIO 6.2.0, esptool 5.4.0, pyserial 3.5
and Bleak 2.0.0 (Python 3.13.5); `uv run --with` resolves current releases unless you pin them.
Windows installation/build and hardware behavior still need their own qualification.

First build downloads the pinned toolchain and libraries from their normal upstream sources.
[`platformio.ini`](platformio.ini) pins pioarduino **55.03.312**, Arduino-ESP32 **3.3.12** /
ESP-IDF **5.5.5**, NimBLE-Arduino **2.5.1**, NeoPixel **1.15.5**, GFX **1.12.6**, BusIO **1.17.4**
and ST7735/ST7789 **1.11.0**. No stock Lua IDE is needed. Generated `.pio/` and `.venv/` files
are ignored, not release artifacts to commit. The application is
`firmware/.pio/build/badge/firmware.bin`; the generated table is `partitions.bin` beside it.

**Never use `pio run -t upload` or `python tools/badge_flash.py flash` on a badge.** Both are
multi-artifact upload paths that can write the bootloader and partition table as well as the app.
PlatformIO's bundled esptool crashed mid-write on this Mac on September 19, leaving a partially
written bootloader that had to be restored from the stock backup. The guarded app-only procedure in
[section 3](#3-guarded-app-only-installation) is the only installation path: it verifies the
device-bound stock backup, refuses to write if the bootloader/partition region no longer matches that
backup (`restore-boot` fixes it), writes only the app slot with a consistent `esptool`, and reads the
whole application back before rebooting. `badge_flash.py restore` writes the entire 4 MiB stock image
at offset zero and is for separately approved full recovery only.

### macOS recovery and successful flash sequence

Run these commands from the **repository root**, not from `firmware/`. They document the successful
September 19 workflow without embedding a badge MAC, backup path, or hash in Git.

1. If the linker reports duplicate definitions from paths ending in names such as
   `Adafruit_SPITFT 2.cpp`, the generated dependency cache was copied or otherwise corrupted. Confirm
   the symptom, remove only the generated environment cache, then rebuild:

   ```sh
   find firmware/.pio/libdeps/badge -name '* 2.*'
   rm -rf firmware/.pio/libdeps/badge firmware/.pio/build/badge
   source firmware/.venv/bin/activate
   pio run -d firmware -e badge
   find firmware/.pio/libdeps/badge -name '* 2.*'
   ```

   The first `find` may print duplicate files; the final one must print nothing. Do not let Finder,
   sync software, or a manual copy operation modify `firmware/.pio/` while PlatformIO is building.

2. Confirm the build ends in `SUCCESS`, then connect one badge with a data-capable USB cable. Close
   the badge IDE, serial monitor, Chrome, and BLE test tools. List the port:

   ```sh
   python tools/badge_flash.py list
   ```

3. Enter ROM download mode: unplug USB, hold **START** (the play button/GPIO9), reconnect USB, then
   release START. A blank display is expected. Re-run `list` because the port can change, then take the
   two-read verified backup from section 2. A failed `no-reset` connection means the badge is not in
   download mode; repeat this step rather than trying a write.

4. Keep the badge in download mode and run the macOS guarded app-only block in section 3 with the
   exact newly listed port, the base MAC returned by `read-mac`, and that badge's verified private
   backup image. The block must complete its live identity check, partition comparisons, write at
   `0x10000`, and byte-for-byte application readback before it is considered flashed.

5. Boot normally using the badge's approved reset/power procedure **without holding START**. Re-list
   the port and run the diagnostics in section 4. A verified flash/readback is not firmware or BLE
   qualification; preserve the command output and complete the remaining hardware gates separately.

### 2. Identify and preserve one explicitly approved badge

Flashing requires separate approval **for this device and image**. A repository push or software
test is not flash approval. Before connecting: confirm board revision, correct AA/USB power
configuration with the creators, and the device-specific recovery/reset procedure. Use a data
cable, close the badge IDE, serial monitor and Chrome/Bleak connection, and attach only one badge.

```sh
uv run --with pyserial python tools/badge_flash.py list
uv run --with pyserial python tools/badge_flash.py --help
```

Use the exact listed port below (`/dev/cu.usbmodem…` on macOS, `COM…` on Windows). Enter the ROM
download mode using the demonstrated procedure for that badge: `backup` does not enter it for you
(a badge already running this firmware can be sent there with `… cmd flashmode`; `flash` and
`restore-boot` do that themselves). Start/GPIO9 held during reset is
the manual recovery route; unplug/replug USB is **not** a guaranteed reset while AA power remains
connected. USB-Serial-JTAG may support automatic entry, but it is not assumed here. A blank
display in confirmed download mode is expected. If unsure, stop and ask the firmware maintainer.

```sh
uv run --with pyserial --with esptool python tools/badge_flash.py --port PORT_FROM_LIST backup
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

The only written artifact is `firmware.bin` at **`0x10000`**, bounded by the factory slot size
**`0x2a0000`**. Application sectors are erased as part of writing, but no bootloader,
partition table, NVS, PHY, littlefs storage or eFuse is written. Current firmware may later persist
its own explicit settings in the existing `hpwand` NVS namespace; ordinary installation preserves it.

**The helper is the installation path.** From the repository root, with the badge on USB and no other
program on the port:

```sh
uv run --with pyserial --with esptool python tools/badge_flash.py flash
```

It refuses an image larger than the app partition, asks a running wand firmware to reboot into
download mode (`flashmode`; a badge that does not answer must already be in download mode via
Start/GPIO9), reads the base MAC, requires the verified two-read backup for that exact device
(section 2), reads `0x0`–`0x9000` and refuses to write unless the bootloader and partition table are
byte-identical to that backup (`restore-boot` rewrites `0x0`–`0x8000` from the backup if they are
not), writes only `0x10000` with `--no-progress`, reads the application back and compares its
SHA-256, then leaves the bootloader with a watchdog reset and checks that the application answers
`id`. Every failed pre-write check stops before the write; a readback mismatch says so and asks for
another flash without powering off. Never "fix" a mismatch by uploading a new partition table or
bootloader.

**Manual reference** (the same guards with plain `esptool`, kept for auditing the helper; not the
normal path). It additionally compares the generated `partitions.bin` with the live table and the
backup table over the same 3,072 bytes at **`0x8000`**. It needs `esptool` on PATH
(`uv tool install esptool`) and a Python 3 as `python` (`python3` on macOS). First read the selected
badge's identity (replace the port):

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

The manual reference leaves the badge in download mode for preservation checks; return to application
boot using its approved reset/power procedure **without holding Start** (the helper does this with a
watchdog reset); port names may change.
Do not repeatedly flash if the application fails to boot. Preserve the evidence and use the
device-specific recovery procedure. Full-image restore is a separate approved operation that
overwrites all flash settings/storage; `badge_flash.py restore` alone does not perform an independent
post-write full readback. A backup cannot recover damaged hardware or changed eFuses.

### 4. Verify diagnostics, then qualify before gameplay

After normal boot, from the repository root with the exact newly listed port:

```sh
uv run --with pyserial python tools/badge_flash.py --port PORT_FROM_LIST cmd id status selftest
uv run --with pyserial python tools/badge_flash.py --port PORT_FROM_LIST monitor --seconds 10
uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-XXXX --scan 15 --seconds 5
```

Replace placeholders; close the monitor before another console command and disconnect Chrome
before Bleak. Console opening can reset the badge; do not open it halfway through a timing run.
`id` must report the built version (`fw=0.2.1` for current source); a cold 0.2.x boot reports
`profile=range ble=on caps=0F` on the first `status` line and in the `HPDIAG` boot line.
`wand_ble_check.py` must pass its INFO gate on this build; a `creator`/`rate` boot row is expected to
fail it, and that is truthful rejection, not a reason to remove the gate.

For separately approved profile experiments, `uv run --with pyserial --with bleak python tools/badge_matrix.py --help` describes the
profile runner. It **reboots through eight profiles and sends real display/LED feedback**;
it is not passive monitoring. Leave it off the ordinary player startup path. Its short comparisons
cannot replace six faces, clipping tests, combined-load endurance, battery operation, reconnects
and Windows/two-badge acceptance. See [the contract's H0–H5 gates](../BADGE-FIRMWARE-CONTRACT.md#8-acceptance-and-handoff-checklist).

**Port busy/access denied:** close the actual IDE/monitor owning the port, then re-list ports. Do
not kill unrelated processes or disable security software. **Not in the pairing list:** verify
normal app boot, Bluetooth permission, no other central, and the actual `id`/`status` version.
Installed 0.1.8 cold boots use BLE `off`; 0.2.x boots with the radio on (0.2.1 starts it 1.2 s after
boot, later after brownout resets) and re-arms advertising.
A new source build is not proof that a connected badge has been flashed: check `id`.

## Checked against the official custom-flash guide

| Guide item | This firmware |
| --- | --- |
| ESP32-C3-MINI-1-N4, 4 MB, USB-Serial-JTAG console | `esp32-c3-devkitm-1` board, USB CDC on boot (`ARDUINO_USB_MODE=1`), Arduino-ESP32 (guide: "also works, same GPIOs") |
| Flash DIO, 80 MHz, app at 0x10000 | `board_build.flash_mode = dio`, `f_flash = 80 MHz`; app at 0x10000 in the factory slot of `partitions_badge.csv` (same table as stock) |
| LCD MOSI 10 / CLK 1 / CS 2 / DC 0 / RST 4, 40 MHz, mode 0, RGB565 | `pins.h`; Adafruit ST7789 at 40 MHz, mode 0, 16-bit colour |
| Init: invert_color(true), swap_xy(true), mirror(true,false) | Adafruit init sends INVON; the tested panel's current fresh rotation is **3**. Verify the actual panel; `rot <0-3>` persists an explicitly selected orientation |
| I2C SDA 5 / SCL 6, 400 kHz; accel 0x19, NFC 0x26 | `Wire.begin(5, 6, 400000)`; only the accelerometer is initialised, NFC untouched (guide: don't init it if unused) |
| Accel WHO_AM_I 0x11; CTRL_REG1 0x57; CTRL_REG4 0x80; ZYXDA poll; OUT_X_L auto-increment; raw>>4 | WHO_AM_I must be 0x11; the gameplay row is **0x47/0xA0** (50 Hz/±8 g, 4 mg/count); the creator 0x57/0x80 row stays selectable for diagnostics; all rows verify readbacks; ZYXDA gates every read, STATUS bit 7 is counted but not treated as loss |
| Bounded I2C timeouts + retry (NFC can wedge the bus) | 10 ms bus timeout; after 5 consecutive failures the bus is re-initialised and the sensor reconfigured; count in `status` (`i2c_recover`) |
| HC165 DATA 7 / LOAD 20 / CLK 21; order A,B,Home,Down,Left,Right,Up,Aux1; active-low; latch then 8× sample+clock | `buttons.cpp`: same protocol; bits 7..0 = A,B,Home,Down,Left,Right,Up,Aux1, inverted so 1 = pressed |
| Start on GPIO9, active-low, strapping pin | read with pull-up; only used to re-seed the activity baseline |
| Poll ~10 ms + debounce; Aux1 is a maintained switch | polled every 10 ms, 12 ms debounce; Aux1 treated as a level |
| WS2812B ×6 on GPIO3, GRB, RMT; order UL, UR, MR, BR, BL, ML; keep it dim | Adafruit NeoPixel (RMT on ESP32), `NEO_GRB`; brightness 24/255; battery-loaded validation pending |
| BLE: init once, never deinit; trim buffers | BLE-on boots initialize NimBLE once; BLE-off boots never initialize it. Legacy advertising resumes on disconnect; peripheral-only with one central. `status` reports heap/stack/notification failures; measure under load |
| Console: bare `\r` line ending; <256-byte USB writes; keep a button-inject/print path | `\r`, `\n` and `\r\n` all end a line; replies are short; `btn` prints the HC165 byte and held buttons |
| Checklist: Start read, HC165 read, 10 ms debounce, ST7789 fill-screen, accel WHO_AM_I + mg, WS2812 chase (dim) | boot shows reset reason and sensor identity; no NFC initialization or shared-bus scan |

## Bring-up checklist (first time on hardware)

1. After separately approved flash, open the monitor. Expect `HPHELLO|fw=0.2.1|name=WAND-xxxx|boot=…|hz=50|range=8|profile=range|ble=on|caps=0F|axes=…|sensor=1` after a cold boot (0.2.1 is the current source version; an `HPDIAG|reset=…|profile=range|ble=on|caps=0F|…` line precedes it). The screen
   shows boot diagnostics (accelerometer id 11, reset reason, `BLE WAND-xxxx starting`) then the wand screen;
   LEDs breathe blue once the staged start releases them (radio 1.2 s after boot, LEDs 2 s later). Fresh badges default to `rot 3`; use `rot 0`, `rot 1`, or `rot 2` if the panel differs. The selected rotation is saved in NVS.
2. `selftest` runs the contract's golden vectors on the badge. Expect `selftest failures=0`.
3. Axis check: lay the badge face up on a table and type `axes`. The contract wants about
   `0, 0, +1000` mg. If not, remap without reflashing, e.g. `axes -y +x +z` means contract X = −chip Y,
   contract Y = +chip X, contract Z = +chip Z. This saves the map for the next reboot so a live
   boot's axes never silently change. Reboot and check all six faces; ±100 mg tolerance.
4. `btn` while holding buttons confirms the shift-register order.
5. `uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-xxxx` from the repository root on the
   laptop walks the whole contract over real BLE (scan, INFO, OPEN, SYNC, SET_STATE, cues, motion
   stream, health) and prints PASS/FAIL per step with rate and interval statistics. Use `--scan 15`
   in a crowded venue. Chrome must be disconnected from the badge while it runs.
6. `status` after a minute of streaming should show `gaps` and `dropped` near zero and
   `notify_failures=0`; `overrun_flags` may be large and is informational. Collect counters through
   scripts, not a debug dashboard.
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
`txpower <-12..9>`, `echo on|off`, `recal`, `reboot`, `flashmode` (reboot into the ROM download mode for reflashing).
Rotation/axes/LED/TX-power settings persist in NVS; the diagnostic profile/BLE selection uses RTC RAM
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
`apps/web/src/wand/protocol.ts`, both pinned to the same golden vectors.
