#pragma once
// Project constants. Wire-level values come from BADGE-FIRMWARE-CONTRACT.md v1; change them there first.
#define FW_MAJOR 0
#define FW_MINOR 1
#define FW_PATCH 0
#define FW_VERSION_STR "0.1.0"

// GATT surface (contract section 3)
#define UUID_WAND_SERVICE "7f510000-1b15-4f0d-8f3c-8db47a812000"
#define UUID_INFO "7f510001-1b15-4f0d-8f3c-8db47a812000"
#define UUID_MOTION "7f510002-1b15-4f0d-8f3c-8db47a812000"
#define UUID_CONTROL "7f510003-1b15-4f0d-8f3c-8db47a812000"
#define UUID_STATUS "7f510004-1b15-4f0d-8f3c-8db47a812000"
#define DEVICE_NAME_PREFIX "WAND-"   // + four hex digits of the device id

// Stream profile (contract sections 2 and 4)
#define SAMPLE_HZ 50
#define RANGE_G 8
#define AXIS_CONVENTION 1
#define SAMPLE_MAX_AGE_MS 100        // older samples are dropped instead of notified
#define STATUS_HEALTH_PERIOD_MS 1000
#define STATE_MAX_LEASE_MS 1500      // SET_STATE valid_until may be at most this far ahead
#define CUE_MAX_LEAD_MS 500          // CUE start_before may be at most this far ahead

// Local feedback (contract section 5 and 6)
#define ACTIVITY_MG 350              // |a - baseline| above this brightens the LEDs
#define BASELINE_ALPHA 0.05f
#define LED_FRAME_MS 40
#define LED_BRIGHTNESS 48
#define SCREEN_REFRESH_MS 150
