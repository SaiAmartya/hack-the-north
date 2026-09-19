#pragma once
#include <stdint.h>

// Motion acquisition and streaming (contract section 4).
namespace wand {
struct MappedSample {
  int16_t x, y, z;
  bool saturated;
};

// Map a fresh chip-frame sample into contract axes and clamp it to the advertised range.
// Kept pure so the same mapping used by the acquisition task has host-test coverage.
inline MappedSample map_and_clip(const int16_t chip[3], const int8_t map[3], const int8_t sign[3], int16_t limit_mg) {
  int16_t output[3];
  bool saturated = false;
  for (int i = 0; i < 3; i++) {
    int32_t value = (int32_t)sign[i] * chip[map[i]];
    if (value > limit_mg) {
      value = limit_mg;
      saturated = true;
    }
    if (value < -limit_mg) {
      value = -limit_mg;
      saturated = true;
    }
    output[i] = (int16_t)value;
  }
  return {output[0], output[1], output[2], saturated};
}

struct Stats {
  uint32_t boot_id;
  uint32_t acquired;     // fresh sensor samples read
  uint32_t notified;     // MOTION notifications accepted by the stack
  uint32_t dropped;      // local stale/refused samples + observed overrun events, not radio loss
  uint32_t overruns;     // observed hardware overrun events; at least one lost sample each
  uint16_t seq;          // last sequence number
  int16_t x, y, z;       // last sample in contract axes, mg
  bool valid, saturated, sensor_ok;
  float activity;        // 0..1 smoothed movement level for local feedback
};

void begin(uint32_t boot_id);
void set_streaming(uint32_t generation);   // zero disables; otherwise OPEN/subscribed link generation
void set_axes(const int8_t map[3], const int8_t sign[3]);  // contract axis i = sign[i] * chip axis map[i]
void get_axes(int8_t map[3], int8_t sign[3]);
void recalibrate();                       // re-seed the activity baseline
void start();                             // launch the acquisition task (call after ble::begin)
Stats stats();                            // coherent snapshot, never a shared mutable reference
uint32_t stack_headroom();
}  // namespace wand
