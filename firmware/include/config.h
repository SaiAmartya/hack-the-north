#pragma once
// Project constants. Wire-level values come from BADGE-FIRMWARE-CONTRACT.md v1; change them there first.
#define FW_MAJOR 0
#define FW_MINOR 2
#define FW_PATCH 0
#define FW_VERSION_STR "0.2.0"

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

// Radio (contract section 3): fast connectable advertising and a short connection interval request.
#define ADV_INTERVAL_MIN 32          // 0.625 ms units -> 20 ms
#define ADV_INTERVAL_MAX 64          // 40 ms
#define CONN_INTERVAL_MIN 12         // 1.25 ms units -> 15 ms
#define CONN_INTERVAL_MAX 24         // 30 ms
#define CONN_LATENCY 0
#define CONN_TIMEOUT 300             // 10 ms units -> 3 s supervision timeout
#define ADV_WATCHDOG_MS 500          // the loop re-arms advertising if it silently stopped
#define TX_POWER_DBM 3

// Local feedback (contract section 5 and 6)
#define ACTIVITY_MG 350              // |a - baseline| above this brightens the LEDs
#define BASELINE_ALPHA 0.05f
#define LED_FRAME_MS 40
#define LED_BRIGHTNESS 24
#define SCREEN_REFRESH_MS 150
