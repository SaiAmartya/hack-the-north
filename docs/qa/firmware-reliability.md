# Firmware reliability QA card

Use this card after a separately approved flash. It records physical-badge evidence; passing a
laptop script does not prove display/LED visibility, battery endurance, or browser gameplay.

## Prerequisites

- Record the image commit/hash, badge short ID, laptop OS and Bluetooth adapter.
- Close Chrome and any other BLE client. The badge permits one central connection.
- Keep the stock backup and recovery procedure available. Do not erase NVS to run this card.

## Automated regression checks

From the repository root:

```sh
c++ -std=c++17 -I firmware/include firmware/tests/wand_mapping_test.cpp -o /tmp/wand-mapping-test
/tmp/wand-mapping-test
pio run -d firmware
```

The host test covers raw axis swap/inversion/clipping behavior. The PlatformIO build verifies the
firmware image compiles for the badge; neither check touches hardware.

## Physical badge checks

1. Connect the USB monitor and run `selftest`, `status`, and `axes`. Require `sensor=1`, no I2C
   recoveries, `selftest failures=0`, and six-face readings within the contract's initial ±100 mg
   tolerance around the expected gravity axis. Record the selected `axes` mapping.
2. Run a ten-minute transport soak while moving the badge periodically and watching its screen/LEDs:

   ```sh
   uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-XXXX --seconds 600
   ```

   Require `ALL PASS`, no reset, no sequence gaps/discontinuity flags, no reported drops, and a
   roughly 50 Hz stream. Confirm by eye that state/cue feedback appears and that the badge returns
   neutral after disconnect. This is a transport soak; record visible-feedback results separately.
3. Run 20 fresh link sessions; each invocation connects, performs OPEN/SYNC/commands, streams,
   then disconnects:

   ```sh
   for i in {1..20}; do
     uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-XXXX --seconds 5 || exit 1
   done
   ```

   Require every run to print `ALL PASS`, advertising to return between runs, and no boot/reset or
   growing drop/recovery counter.
4. Repeat the ten-minute soak on AA power after any USB-powered run. Record battery type, display
   brightness, LED state, heat, disconnects, and sampling gaps. This advances the battery gate but
   does not replace the 30-minute full-acceptance endurance run.

## Result line

Record one line per badge:

> image/commit · badge ID · laptop/adapter · six-face pass/fail · 10-minute transport result · 20 reconnect result · battery result · visible feedback result · observed issue
