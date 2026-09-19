#pragma once
#include <stddef.h>
#include <stdint.h>

// GATT peripheral per BADGE-FIRMWARE-CONTRACT.md section 3. Connection and subscription callbacks
// only set flags; CONTROL writes are handed straight to the registered handler on the NimBLE task so
// command results do not wait for the main loop.
namespace ble {
typedef void (*ControlHandler)(const uint8_t *raw, size_t len, uint32_t received_ms);  // raw is 20 bytes, zero padded; len = ATT value length

void set_control_handler(ControlHandler handler);   // call before begin()
void begin(const uint8_t device_id[6], const uint8_t info_rec[20], const uint8_t health_rec[20]);
const char *name();                 // "WAND-46BA"
bool connected();
bool motion_subscribed();
bool status_subscribed();
uint32_t generation();              // increments on every connect and disconnect
bool notify_motion(const uint8_t rec[20]);   // false when not subscribed or the stack refused it
void set_health(const uint8_t rec[20]);      // value returned by a STATUS read
void notify_status(const uint8_t rec[20]);   // one-off notification (result or health); read value stays health
}  // namespace ble
