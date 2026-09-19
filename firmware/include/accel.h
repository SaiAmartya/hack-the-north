#pragma once
#include <stdint.h>
namespace accel {
constexpr uint8_t TRACE_CAPACITY = 16;
struct ReadyTrace {
  uint32_t last_not_ready_us, ready_us, burst_start_us, burst_end_us, after_status_us;
  uint8_t last_not_ready_status, before, after;
  bool have_not_ready;
  int16_t counts[3], mg[3]; // native chip axes, before remap/clamping; same burst as timings
};
struct Diagnostics {
  uint8_t ctrl0, ctrl2, ctrl3, ctrl5, ctrl6, fifo_ctrl, revision;
  uint8_t status_before, status_after;
  uint32_t overrun_cleared, overrun_still_set;
  uint32_t status_polls, not_ready_polls, fresh_reads;
  uint32_t ready_interval_us, min_ready_interval_us, max_ready_interval_us;
  uint32_t ready_after_read_us, min_ready_after_read_us, max_ready_after_read_us;
  uint64_t ready_interval_sum_us;
  // Ready-observation intervals: <5 ms, <12 ms, <17 ms, <23 ms, <40 ms, >=40 ms.
  uint32_t interval_bins[6];
  uint8_t reset_ctrl0, reset_ctrl1, reset_ctrl4, trace_count;
  bool reset_readback_ok;
};
// One fresh acquisition. `ready_ms` is the MCU clock when new-data was observed, before the burst
// read; that is the contract's capture time. `overrun_flag` mirrors STATUS bit 7 for diagnostics
// only: on this sensor it is set on virtually every fresh read while the measured fresh-read
// cadence equals the configured output rate, so it is not evidence of a lost sample.
struct Sample {
  int16_t x, y, z;   // mg on the chip's own axes
  bool saturated;    // any native axis at its rail
  bool overrun_flag;
  uint32_t ready_ms;
};
Diagnostics diagnostics();
bool ready_trace(uint8_t index, ReadyTrace &out); // first 16 successful bursts after boot/trace reset
void reset_trace(); // re-arm bounded capture; does not change configuration or health counters
bool begin();                 // boot-selected SC7A20H profile
bool present();
uint8_t who_am_i();
uint8_t ctrl1();
uint8_t ctrl4();
uint32_t recoveries();        // how often the wedged bus had to be re-initialised
uint32_t period_ms();         // nominal output period for the boot-selected profile
// Returns true only when the sensor flagged a new sample since the last read (fresh data).
// `bus_error` reports an I2C failure; no values are produced in that case.
bool poll(Sample &out, bool &bus_error);
// Native signed decoding, before any axis remap or normalized wire encoding.
constexpr int16_t signed_counts(uint8_t low, uint8_t high) {
  const uint16_t raw = (uint16_t)low | ((uint16_t)high << 8);
  const uint16_t counts = raw >> 4;
  return (int16_t)((counts & 0x800) ? (int32_t)counts - 4096 : counts);
}
}  // namespace accel
