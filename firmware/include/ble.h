#pragma once
#include <stddef.h>
#include <stdint.h>

// GATT peripheral per BADGE-FIRMWARE-CONTRACT.md section 3. Callbacks run on the NimBLE task and
// only queue; everything protocol-related happens in the main loop.
namespace ble {
void begin(const uint8_t device_id[6], const uint8_t info_rec[20], const uint8_t health_rec[20]);
const char *name();                 // "WAND-46BA"
bool connected();
bool motion_subscribed();
bool status_subscribed();
uint32_t generation();              // increments on every connect and disconnect
bool notify_motion(const uint8_t rec[20]);   // false when not subscribed or the stack refused it
void set_health(const uint8_t rec[20]);      // value returned by a STATUS read
void notify_status(const uint8_t rec[20]);   // one-off notification (result or health); read value stays health
// Queued CONTROL writes. `len` is the raw ATT value length (may differ from 20).
bool pop_control(uint8_t out[20], size_t &len, uint32_t &received_ms);
}  // namespace ble
