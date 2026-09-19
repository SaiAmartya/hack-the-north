# Firmware 0.2.0 — first gameplay image, change record and QA card

September 19, 2026 (evening). Source in `firmware/`; image `.pio/build/badge/firmware.bin`,
655,961 bytes flash / 26,304 bytes static RAM, SHA-256
`3cce4f3c3658e526413387ecf17f0d4491698a34e725ecd44eae4571e54cbc1e`. **Flashed to WAND-B602 on September 19 evening** (see the flash record below).

## Why the badge was "broken"

Two source-level defects in every 0.1.x image explain the symptoms Sai reported, independently of
radio quality:

1. **Radio off after any real reset.** The installed 0.1.8 image honoured its retained boot
   selection only after a *software* reboot; a power cycle, USB replug, brownout or watchdog
   reset booted the `creator` row with **BLE off**. The live probe over USB confirmed it:
   `HPDIAG|reset=11|profile=creator|ble=off|caps=0`. That is why WAND-B602 never appeared in the
   Chrome chooser. 0.2.0 boots `range` (50 Hz/±8 g) with BLE **on** for every reset reason, and a
   500 ms watchdog re-arms advertising if the stack ever leaves it stopped.
2. **Every sample flagged discontinuous.** The sensor's STATUS bit 7 ("overwritten") is set on
   virtually every fresh read of this SC7A20H revision, yet the measured fresh-read cadence equals the
   configured output rate (`status` on the live badge: 428 fresh reads, 3,957 no-data polls in 4.4 s
   at 100 Hz; 223 fresh reads / 4,330 no-data polls at 50 Hz, interval bins all in the 17–23 ms bucket).
   A sample overwritten before every read cannot produce that cadence. 0.1.x counted the flag as a
   drop (`dropped=425` of `acquired=428`) and set the MOTION discontinuity bit on nearly every record,
   which the browser rejects by contract; no gesture could ever form. 0.2.0 derives discontinuity from
   measured gaps (over 1.5 output periods, 30 ms at 50 Hz, so a single lost native sample is always
caught), stale samples (>100 ms), refused notifications, bus errors and stream restarts, and keeps the
flag as an informational counter. STATUS health `detail0` reports `lost = dropped + gaps`.

Also new: connection-interval request (15–30 ms, 3 s supervision timeout), 20–40 ms advertising,
capture timestamp taken at new-data observation, paced acquisition instead of 1 kHz bus polling, and
a 250 ms back-off on I²C recovery. INFO now advertises `capabilities 0x0F`; the creator and ±2 g rows
stay diagnostic (`caps 0`) and are reachable via the console `profile` command.

## Browser-side changes that pair with it

- `BleWandTransport.recover()`: after a GATT drop the browser reconnects the **already chosen**
  badge without opening the chooser (up to four attempts, 0/0.5/1/2 s apart), then the client runs a
  full fresh handshake (new nonce, OPEN, five SYNC probes, one second of clean motion) before the
  recognizer resumes from its stored calibration with one still second.
- Bounded automatic recovery (three per minute, then an explicit "Reconnect" button) also covers
  "wand went quiet for 500 ms" and applies while validating, not only while streaming.
- A browser stall of 200 ms to 2 s no longer tears the link down: buffered samples fail the age
  check, evidence is cleared, and the next fresh sample starts a new gesture baseline.

## Repeatable evidence on this Mac

- Firmware native tests: protocol golden vectors, boot-profile/RTC selection, continuity policy,
  axis mapping, console defaults — all pass.
- Web unit tests: 150 pass, including 15 recognizer cases (one drives Sai's recorded iPhone jabs
  through calibration and held-out recognition), badge auto-reconnect and recovery budgets.
- Tools tests: 25 pass.

Mac-side Bleak checks cannot be run from inside the Claude session on this machine (macOS kills a bare
Python that touches CoreBluetooth without a usage description), so the radio numbers below must come
from a normal Terminal.

## Flash record (WAND-B602, approved by Sai)

- The first attempt used `tools/badge_flash.py flash`, which at the time ran `pio run -t upload`.
  PlatformIO's bundled esptool crashed in its progress logger (`EsptoolLogger` has no
  `_get_progress_print_file`) **while writing the pioarduino bootloader at 0x0**, leaving
  10,578 of 18,688 bootloader bytes changed. Nothing else was touched; the badge stayed in the ROM
  download mode. The tool has been rewritten: app slot only, a consistent `esptool` from `uv`,
  `--no-progress`, readback verification, and a `restore-boot` command.
- Recovery: read 0x0–0x9000, confirmed the partition table still matched the stock backup, rewrote
  0x0–0x8000 from the verified two-read stock backup (`fc5d6fe3…`), read back: 0x0–0x9000 byte-identical
  to stock.
- App: wrote 685,600 bytes at 0x10000, read back, SHA-256 identical (`3cce4f3c…`). Watchdog reset out of
  the bootloader.
- First boot after a plain USB reset (reset reason 11, not a software reset):
  `HPDIAG|reset=11|profile=range|ble=on|caps=0F|accel=1|who=11|ctrl1=47|ctrl4=A0`,
  `radio enabled=1 advertising=1`, `gaps=0 dropped=0 lost=0 overrun_flags=225`, 228 fresh reads in
  4.65 s (49.0 Hz) with 1,246 status polls (paced acquisition), `heap_free=159348`. This is USB-powered
  console evidence only; radio, Chrome, battery and reconnect evidence come from the QA card.

## 0.2.1 — battery brownout fix (flashed)

Sai's first battery test of 0.2.0 boot-looped with **reset reason 9 (brownout)**; on USB the same
image ran. 0.1.8 never showed this only because it never turned the radio on when on battery, and the
earlier "0.1.2 battery boot loop" was the same mechanism: the radio's current steps on a sagging AA
rail. 0.2.1 (SHA-256 `492bf8e42f423ee8bdbdc12338b810e71470fefdc7441c55b9fd911381f9d577`, app slot only,
readback verified) stages the load and adapts:

- Display and sensor first; the radio starts 1.2 s after boot; the LEDs 2 s after the radio.
- Default TX power 0 dBm (was +3); console `txpower <-12..9>` persists another level.
- Advertising 40–80 ms instead of 20–40 ms (Chrome still lists the badge in about a second).
- Each brownout reset since the batteries went in (RTC-retained count, cleared by a power-on reset or
  30 s of stable running) delays the radio a further 1.5 s (max +4.5 s), lowers TX power 3 dB (floor
  −12 dBm) and, from the second brownout, keeps the LEDs off for that boot. `HPDIAG` and `status`
  report `brownouts`, the applied `tx_dbm` and the radio delay.

Sai reported that fresh batteries also fixed the loop on their own; 0.2.1 keeps the margin for tired
ones. Battery run time and the 30-minute endurance gate remain to be measured.

## Physical QA card (after the app-only flash above)

For any later reflash, from the repository root with the badge on USB and no other program on the port
(the tool verifies the stock backup, refuses to touch the bootloader region, and reads the app back):

```sh
uv run --with pyserial --with esptool python tools/badge_flash.py flash
```

Then, in order, and please report each line's result verbatim:

1. **Cold boot discoverability.** Unplug USB, put in batteries (or replug), do not touch Start. Within
   5 s the screen should say `BLE WAND-xxxx advertising`. On the laptop, Chrome → Wandduel → *Connect
   badge*: does `WAND-xxxx` appear in the chooser within ~5 s? Repeat three power cycles.
   *Report:* appeared yes/no per cycle, and seconds to appear.
2. **Console identity.** `uv run --with pyserial python tools/badge_flash.py cmd id status` (this
   resets the badge; fine). *Report:* the `HPHELLO` line and the `status` lines containing
   `profile=`, `gaps=`, `dropped=`, `overrun_flags=`, `radio ...`, `heap_free`.
3. **Radio gate from a normal Terminal** (not from Claude; close Chrome's badge connection first):
   `uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-xxxx --seconds 30`.
   *Report:* the PASS/FAIL lines plus the `MOTION ... Hz; seq gaps N, discontinuity flags N` line and the
   `command RTT ... p95` line. Target: ≥45 Hz, discontinuity flags ≤ 2, p95 ≤ 150 ms.
4. **Chrome stream.** Connect the badge in Wandduel, enable microphone, *Start calibration*, hold still
   1.5 s, jab three times, raise/hold/lower three times. *Report:* did calibration complete, how many
   attempts per spell, any coaching text shown, and whether practice casts of *Stupefy* and *Protego*
   registered (the badge screen shows `STUPEFY!`/`PROTEGO!` cues).
5. **Drop and recover.** While streaming, walk the badge ~10 m away or wrap it in foil until the
   laptop says *Reconnecting your badge…*, then bring it back. *Report:* seconds until *Checking fresh
   movement…* then the practice screen returns, and whether calibration was kept (no new stillness step).
6. **Stability soak.** Leave it connected and streaming for 10 minutes while occasionally moving it.
   *Report:* `status` afterwards (`gaps`, `dropped`, `notify_failures`, `heap_min`, `adv_restarts`,
   `conn_interval_us`) and any laptop error banner text.

What I am looking for: (1) proves the discoverability fix; (2) and (3) prove the profile and the
discontinuity fix on real radio; (4) validates the v3 recognizer on the badge's sensor (its noise and
quantization differ from the iPhone); (5) proves auto-reconnect; (6) surfaces heap or link drift.
