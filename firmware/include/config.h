#pragma once
// Project constants. Wire-level values come from BADGE-FIRMWARE-CONTRACT.md v1; change them there first.
#define FW_MAJOR 0
#define FW_MINOR 2
#define FW_PATCH 3
#define FW_VERSION_STR "0.2.3"

// GATT surface (contract section 3)
#define UUID_WAND_SERVICE "7f510000-1b15-4f0d-8f3c-8db47a812000"
#define UUID_INFO "7f510001-1b15-4f0d-8f3c-8db47a812000"
#define UUID_MOTION "7f510002-1b15-4f0d-8f3c-8db47a812000"
#define UUID_CONTROL "7f510003-1b15-4f0d-8f3c-8db47a812000"
#define UUID_STATUS "7f510004-1b15-4f0d-8f3c-8db47a812000"
#define DEVICE_NAME_PREFIX "WAND-"   // + four hex digits of the device id

// Contract codec bounds (sections 2 and 4). The boot-selected sensor profile in diagnostic.h decides
// the INFO rate/range and whether the duel capabilities are advertised.
#define SAMPLE_HZ 50
#define RANGE_G 8
#define AXIS_CONVENTION 1
#define SAMPLE_MAX_AGE_MS 100        // a sample read this long before it can be notified is dropped
#define STREAM_GAP_PERIODS_X2 3      // fresh reads further apart than 1.5 output periods mark a discontinuity
#define ACQ_WAKE_MARGIN_MS 4         // wake this long before the next expected sample, then poll per tick
#define SENSOR_SILENCE_MS 100        // no fresh sample for this long: sensor unhealthy until it returns
#define STATUS_HEALTH_PERIOD_MS 1000
#define STATE_MAX_LEASE_MS 1500      // SET_STATE valid_until may be at most this far ahead
#define CUE_MAX_LEAD_MS 500          // CUE start_before may be at most this far ahead

// Radio (contract section 3): connectable advertising and a short connection interval request.
// Advertising is moderate rather than fastest: on AA power the radio's current steps are what
// brown the board out, and Chrome still lists the badge within about a second at 40-80 ms.
#define ADV_INTERVAL_MIN 64          // 0.625 ms units -> 40 ms
#define ADV_INTERVAL_MAX 128         // 80 ms
#define CONN_INTERVAL_MIN 12         // 1.25 ms units -> 15 ms
#define CONN_INTERVAL_MAX 24         // 30 ms
#define CONN_LATENCY 0
#define CONN_TIMEOUT 300             // 10 ms units -> 3 s supervision timeout
#define ADV_WATCHDOG_MS 500          // the loop re-arms advertising if it silently stopped
#define TX_POWER_DBM 0               // default; console `txpower` persists another level, brownouts cap it
#define TX_POWER_MIN_DBM -12
#define TX_POWER_MAX_DBM 9
// Battery soft start: the display and sensor come up first, the radio only after the boost
// converter has settled, and the LEDs after the radio. Each brownout reset (reason 9) seen since
// the batteries went in delays the radio further and lowers its power (diagnostic.h).
#define RADIO_START_DELAY_MS 1200
#define RADIO_BROWNOUT_DELAY_MS 1500
#define LED_START_AFTER_RADIO_MS 2000
#define STABLE_BOOT_MS 30000         // this long without a reset clears the brownout count

// Local feedback (contract section 5 and 6)
#define ACTIVITY_MG 350              // |a - baseline| above this brightens the LEDs
#define BASELINE_ALPHA 0.05f
#define LED_FRAME_MS 40
#define LED_BRIGHTNESS 24
#define SCREEN_REFRESH_MS 150
