#pragma once
#include <stddef.h>
#include <stdint.h>

// Link and CONTROL callbacks execute serially on the NimBLE task; neither performs display I/O.
namespace ble {
typedef void (*ControlHandler)(const uint8_t *raw, size_t len, uint32_t received_ms, uint32_t generation);
typedef void (*LinkHandler)(uint32_t generation);

void set_control_handler(ControlHandler handler);   // call before begin()
void set_link_handler(LinkHandler handler);
void begin(const uint8_t device_id[6], const uint8_t info_rec[20], const uint8_t health_rec[20]);
const char *name();                 // "WAND-46BA"
bool connected();
bool motion_subscribed();
bool status_subscribed();
uint32_t generation();              // increments on every connect and disconnect
bool notify_motion(const uint8_t rec[20], uint32_t generation);
void set_health(const uint8_t rec[20]);      // value returned by a STATUS read
bool notify_status(const uint8_t rec[20], uint32_t generation);
uint32_t notification_failures();
}  // namespace ble
