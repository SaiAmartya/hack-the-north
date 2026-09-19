#pragma once
#include "config.h"
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

// Stream continuity policy (contract section 4), pure for host tests. A fresh sample is dropped
// when it is already too old to be fresh for the browser; the discontinuity bit is set on the first
// emitted sample after any gap, drop, refused notification or stream (re)start. The sensor's
// STATUS overwrite bit is deliberately not an input: measured fresh-read cadence, not that flag,
// is the evidence of lost samples. `max_gap_ms` is 1.5 output periods (30 ms at 50 Hz), so a
// single lost native sample (a ~41 ms gap) is always flagged.
constexpr uint32_t max_gap_ms(uint32_t period_ms) { return period_ms * STREAM_GAP_PERIODS_X2 / 2; }
struct Continuity {
  bool discontinuity;
  bool drop;
};
inline Continuity classify_fresh_sample(uint32_t gap_ms, uint32_t age_ms, bool break_pending, bool generation_changed,
                                        uint32_t max_gap_ms, uint32_t max_age_ms) {
  const bool drop = age_ms > max_age_ms;
  return {generation_changed || break_pending || gap_ms > max_gap_ms || drop, drop};
}

struct Stats {
  uint32_t boot_id;
  uint32_t acquired;     // fresh sensor samples read
  uint32_t notified;     // MOTION notifications accepted by the stack
  uint32_t dropped;      // local stale/refused samples, not radio loss
  uint32_t gaps;         // fresh-read gaps longer than 1.5 periods (real cadence evidence)
  uint32_t lost;         // dropped + gaps: the contract's local loss counter for STATUS health
  uint32_t overrun_flags;// raw STATUS bit 7 observations (diagnostic only)
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
