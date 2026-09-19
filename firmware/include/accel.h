#pragma once
#include <stdint.h>
namespace accel {
constexpr uint8_t TRACE_CAPACITY = 16;
struct ReadyTrace {
  uint32_t last_not_ready_us, ready_us, burst_start_us, burst_end_us, after_status_us;
  uint8_t last_not_ready_status, before, after;
  bool have_not_ready;
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
Diagnostics diagnostics();
bool ready_trace(uint8_t index, ReadyTrace &out); // first 16 successful bursts, immutable until reboot
bool begin();                 // SC7A20H configured for 50 Hz, +/-8 g; native cadence unqualified
bool present();
uint8_t who_am_i();
uint8_t ctrl1();
uint8_t ctrl4();
uint32_t recoveries();        // how often the wedged bus had to be re-initialised
// Returns true only when the sensor flagged a new sample since the last read (fresh data). Values
// in mg on the chip's own axes. `saturated` is set when any axis railed. `bus_error` reports an
// I2C failure; no values are produced in that case.
bool poll(int16_t &x, int16_t &y, int16_t &z, bool &saturated, bool &bus_error, bool &overrun);
// Native signed decoding, before any axis remap or normalized wire encoding.
constexpr int16_t signed_counts(uint8_t low, uint8_t high) {
  const uint16_t raw = (uint16_t)low | ((uint16_t)high << 8);
  const uint16_t counts = raw >> 4;
  return (int16_t)((counts & 0x800) ? (int32_t)counts - 4096 : counts);
}
}  // namespace accel
