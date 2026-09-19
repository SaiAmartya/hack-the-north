#include "accel.h"
#include "config.h"
#include "diagnostic.h"
#include "pins.h"
#include <Arduino.h>
#include <Wire.h>
#include <atomic>

// SC7A20HTR on the shared I2C bus. Do not initialize the attached NFC controller.
namespace accel {
namespace {
const uint8_t REG_WHO_AM_I = 0x0F, REG_CTRL0 = 0x1F, REG_CTRL1 = 0x20, REG_CTRL4 = 0x23, REG_STATUS = 0x27, REG_OUT_X_L = 0x28, AUTO_INC = 0x80;
const uint8_t STATUS_ZYXDA = 0x08;   // new X, Y and Z data available
const uint8_t STATUS_ZYXOR = 0x80;   // "overwritten" report; see Sample::overrun_flag
const int16_t RAIL_COUNTS = 2040;    // 12-bit output rails at +/-2047
const uint16_t BUS_TIMEOUT_MS = 10;  // bounded: the NFC chip can wedge the bus on droopy power
const uint8_t ERRORS_BEFORE_RECOVERY = 5;
const uint32_t RECOVERY_BACKOFF_MS = 250;
std::atomic<bool> g_present{false};
std::atomic<uint8_t> g_who{0}, g_ctrl1{0}, g_ctrl4{0};
uint8_t g_errors = 0;
std::atomic<uint32_t> g_recoveries{0};
uint32_t g_next_recovery_ms = 0;
portMUX_TYPE g_diag_lock = portMUX_INITIALIZER_UNLOCKED;
Diagnostics g_diag{};
ReadyTrace g_trace[TRACE_CAPACITY]{};
uint32_t g_last_ready_us = 0, g_read_finished_us = 0;
bool g_have_previous_read = false;
uint32_t g_last_not_ready_us = 0;
uint8_t g_last_not_ready_status = 0;
bool g_have_not_ready = false;

bool write_reg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ACCEL_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool read_regs(uint8_t reg, uint8_t *buf, size_t n) {
  Wire.beginTransmission(ACCEL_ADDR);
  Wire.write((uint8_t)(n > 1 ? (reg | AUTO_INC) : reg));
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)ACCEL_ADDR, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

bool bus_begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  Wire.setTimeOut(BUS_TIMEOUT_MS);
  return true;
}

bool configure() {
  const diagnostic::Profile &p = diagnostic::profile();
  uint8_t who = 0, c0 = 0, c1 = 0, c4 = 0;
  if (!read_regs(REG_WHO_AM_I, &who, 1)) return false;
  g_who = who;
  if (who != 0x11) return false;
  if (!write_reg(REG_CTRL1, 0x07) || !read_regs(REG_CTRL0, &c0, 1)) return false;
  // Normal rows leave CTRL0 at its documented reset value; never overwrite reserved bits.
  // Only the high-performance row writes the documented HR bit.
  if (c0 != 0 && c0 != p.ctrl0) return false;
  if (c0 != p.ctrl0 && !write_reg(REG_CTRL0, p.ctrl0)) return false;
  if (!write_reg(REG_CTRL4, p.ctrl4)) return false;
  if (!write_reg(REG_CTRL1, p.ctrl1)) return false;
  delay(1);
  if (!read_regs(REG_CTRL1, &c1, 1) || !read_regs(REG_CTRL4, &c4, 1)) return false;
  g_ctrl1 = c1;
  g_ctrl4 = c4;
  if (c1 != p.ctrl1 || c4 != p.ctrl4) return false;
  Diagnostics snapshot{};
  if (!read_regs(0x1f, &snapshot.ctrl0, 1) || !read_regs(0x21, &snapshot.ctrl2, 1) ||
      !read_regs(0x22, &snapshot.ctrl3, 1) || !read_regs(0x24, &snapshot.ctrl5, 1) ||
      !read_regs(0x25, &snapshot.ctrl6, 1) || !read_regs(0x2e, &snapshot.fifo_ctrl, 1) ||
      !read_regs(0x70, &snapshot.revision, 1)) return false;
  if (snapshot.ctrl0 != p.ctrl0) return false;
  portENTER_CRITICAL(&g_diag_lock);
  snapshot.overrun_cleared = g_diag.overrun_cleared;
  snapshot.overrun_still_set = g_diag.overrun_still_set;
  snapshot.reset_ctrl0 = g_diag.reset_ctrl0;
  snapshot.reset_ctrl1 = g_diag.reset_ctrl1;
  snapshot.reset_ctrl4 = g_diag.reset_ctrl4;
  snapshot.reset_readback_ok = g_diag.reset_readback_ok;
  snapshot.trace_count = g_diag.trace_count;
  g_diag = snapshot;
  portEXIT_CRITICAL(&g_diag_lock);
  g_have_previous_read = false;
  g_have_not_ready = false;
  return true;
}

bool reset_once_at_boot() {
  uint8_t who = 0, revision = 0, c0 = 0, c1 = 0, c4 = 0;
  if (!read_regs(REG_WHO_AM_I, &who, 1) || !read_regs(0x70, &revision, 1) ||
      who != 0x11 || revision != 0x28) return false;
  // Silan SC7A20H v1.1 p27 section 13.34: this command resets the sensor circuit.
  // One boot-only step; never write reserved/calibration/NVM registers.
  if (!write_reg(0x68, 0xa5)) return false;
  delay(10); // bounded settling margin, not a manufacturer-specified reset completion time
  if (!read_regs(REG_WHO_AM_I, &who, 1) || !read_regs(0x70, &revision, 1) ||
      who != 0x11 || revision != 0x28 || !read_regs(REG_CTRL0, &c0, 1) ||
      !read_regs(REG_CTRL1, &c1, 1) || !read_regs(REG_CTRL4, &c4, 1)) return false;
  const bool reset_defaults_ok = c0 == 0x00 && c1 == 0x07 && c4 == 0x00;
  portENTER_CRITICAL(&g_diag_lock);
  g_diag.reset_ctrl0 = c0;
  g_diag.reset_ctrl1 = c1;
  g_diag.reset_ctrl4 = c4;
  g_diag.reset_readback_ok = reset_defaults_ok;
  portEXIT_CRITICAL(&g_diag_lock);
  return reset_defaults_ok;
}

void recover() {
  const uint32_t now = millis();
  if ((int32_t)(now - g_next_recovery_ms) < 0) return;  // bounded retry rate while the bus is wedged
  g_next_recovery_ms = now + RECOVERY_BACKOFF_MS;
  g_recoveries++;
  Wire.end();
  delay(2);
  bus_begin();
  g_present = configure();
  g_errors = 0;
}

bool fail() {
  if (++g_errors >= ERRORS_BEFORE_RECOVERY) recover();
  return false;
}
}  // namespace

bool begin() {
  bus_begin();
  g_present = reset_once_at_boot() && configure();
  if (g_present) delay(20);
  return g_present;
}

bool present() { return g_present; }
uint8_t who_am_i() { return g_who; }
uint8_t ctrl1() { return g_ctrl1; }
uint8_t ctrl4() { return g_ctrl4; }
uint32_t recoveries() { return g_recoveries; }
uint32_t period_ms() {
  const uint8_t hz = diagnostic::profile().sample_hz;
  return hz ? 1000u / hz : 20u;
}
Diagnostics diagnostics() {
  portENTER_CRITICAL(&g_diag_lock);
  const Diagnostics snapshot = g_diag;
  portEXIT_CRITICAL(&g_diag_lock);
  return snapshot;
}
bool ready_trace(uint8_t index, ReadyTrace &out) {
  portENTER_CRITICAL(&g_diag_lock);
  const bool exists = index < g_diag.trace_count;
  if (exists) out = g_trace[index];
  portEXIT_CRITICAL(&g_diag_lock);
  return exists;
}
void reset_trace() {
  portENTER_CRITICAL(&g_diag_lock);
  g_diag.trace_count = 0;
  portEXIT_CRITICAL(&g_diag_lock);
}

bool poll(Sample &out, bool &bus_error) {
  bus_error = false;
  if (!g_present) {
    bus_error = true;
    fail();
    return false;
  }
  uint8_t st;
  if (!read_regs(REG_STATUS, &st, 1)) {
    bus_error = true;
    return fail();
  }
  const uint32_t ready_observed_us = micros();
  const uint32_t ready_observed_ms = millis();
  portENTER_CRITICAL(&g_diag_lock);
  ++g_diag.status_polls;
  if (!(st & STATUS_ZYXDA)) ++g_diag.not_ready_polls;
  portEXIT_CRITICAL(&g_diag_lock);
  if (!(st & STATUS_ZYXDA)) {
    g_last_not_ready_us = ready_observed_us;
    g_last_not_ready_status = st;
    g_have_not_ready = true;
    g_errors = 0;
    return false;   // nothing new since the last read: never re-emit an old register image
  }
  uint8_t b[6];
  const uint32_t burst_start_us = micros();
  if (!read_regs(REG_OUT_X_L, b, 6)) {
    bus_error = true;
    return fail();
  }
  const uint32_t burst_end_us = micros();
  uint8_t after;
  if (!read_regs(REG_STATUS, &after, 1)) {
    bus_error = true;
    return fail();
  }
  const uint32_t read_finished_us = micros();
  const diagnostic::Profile &p = diagnostic::profile();
  const int16_t rx = signed_counts(b[0], b[1]);
  const int16_t ry = signed_counts(b[2], b[3]);
  const int16_t rz = signed_counts(b[4], b[5]);
  out.x = diagnostic::to_mg(rx, p);
  out.y = diagnostic::to_mg(ry, p);
  out.z = diagnostic::to_mg(rz, p);
  out.ready_ms = ready_observed_ms;
  portENTER_CRITICAL(&g_diag_lock);
  if (g_diag.trace_count < TRACE_CAPACITY) {
    g_trace[g_diag.trace_count++] = ReadyTrace{g_last_not_ready_us, ready_observed_us,
        burst_start_us, burst_end_us, read_finished_us, g_last_not_ready_status, st, after, g_have_not_ready,
        {rx, ry, rz}, {out.x, out.y, out.z}};
  }
  ++g_diag.fresh_reads;
  if (g_have_previous_read) {
    const uint32_t interval = ready_observed_us - g_last_ready_us;
    const uint32_t after_read = ready_observed_us - g_read_finished_us;
    g_diag.ready_interval_us = interval;
    g_diag.ready_after_read_us = after_read;
    if (!g_diag.min_ready_interval_us || interval < g_diag.min_ready_interval_us) g_diag.min_ready_interval_us = interval;
    if (interval > g_diag.max_ready_interval_us) g_diag.max_ready_interval_us = interval;
    if (!g_diag.min_ready_after_read_us || after_read < g_diag.min_ready_after_read_us) g_diag.min_ready_after_read_us = after_read;
    if (after_read > g_diag.max_ready_after_read_us) g_diag.max_ready_after_read_us = after_read;
    g_diag.ready_interval_sum_us += interval;
    const unsigned bin = interval < 5000 ? 0 : interval < 12000 ? 1 : interval < 17000 ? 2 : interval < 23000 ? 3 : interval < 40000 ? 4 : 5;
    ++g_diag.interval_bins[bin];
  }
  g_diag.status_before = st;
  g_diag.status_after = after;
  if (st & STATUS_ZYXOR) {
    if (after & STATUS_ZYXOR) ++g_diag.overrun_still_set;
    else ++g_diag.overrun_cleared;
  }
  portEXIT_CRITICAL(&g_diag_lock);
  g_last_ready_us = ready_observed_us;
  g_read_finished_us = read_finished_us;
  g_have_previous_read = true;
  g_have_not_ready = false;
  g_errors = 0;
  out.overrun_flag = (st & STATUS_ZYXOR) != 0;
  out.saturated = abs(rx) >= RAIL_COUNTS || abs(ry) >= RAIL_COUNTS || abs(rz) >= RAIL_COUNTS;
  return true;
}

}  // namespace accel
