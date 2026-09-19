#include "accel.h"
#include "pins.h"
#include <Arduino.h>
#include <Wire.h>

// SC7A20HTR on the shared I2C bus (official custom-flash guide, section 5). Register map is
// LIS2DH-compatible. The NFC chip on the same bus can wedge it on droopy battery power, so every
// transaction has a bounded timeout and the bus is re-initialised after repeated failures.
namespace accel {
namespace {
const uint8_t REG_WHO_AM_I = 0x0F, REG_CTRL1 = 0x20, REG_CTRL4 = 0x23, REG_STATUS = 0x27, REG_OUT_X_L = 0x28, AUTO_INC = 0x80;
const uint8_t STATUS_ZYXDA = 0x08;   // new X, Y and Z data available
const uint8_t CTRL1_50HZ_XYZ = 0x47; // ODR 50 Hz, normal power, X/Y/Z enabled (guide's 0x57 = 100 Hz)
const uint8_t CTRL4_BDU_8G = 0xA0;   // block data update (guide's verified 0x80) + FS = +/-8 g
const int16_t RAIL_COUNTS = 2040;    // 12-bit output rails at +/-2047
const uint16_t BUS_TIMEOUT_MS = 10;
const uint8_t ERRORS_BEFORE_RECOVERY = 5;
bool g_present = false;
uint8_t g_who = 0;
uint8_t g_errors = 0;
uint32_t g_recoveries = 0;

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
  if (!read_regs(REG_WHO_AM_I, &g_who, 1)) return false;
  if (g_who != 0x11 && g_who != 0x33) return false;   // SC7A20 answers 0x11, a genuine LIS2DH 0x33
  if (!write_reg(REG_CTRL1, CTRL1_50HZ_XYZ)) return false;
  if (!write_reg(REG_CTRL4, CTRL4_BDU_8G)) return false;
  return true;
}

void recover() {
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
  g_present = configure();
  if (g_present) delay(20);
  return g_present;
}

bool present() { return g_present; }
uint8_t who_am_i() { return g_who; }
uint32_t recoveries() { return g_recoveries; }

bool poll(int16_t &x, int16_t &y, int16_t &z, bool &saturated, bool &bus_error) {
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
  if (!(st & STATUS_ZYXDA)) {
    g_errors = 0;
    return false;   // nothing new since the last read: never re-emit an old register image
  }
  uint8_t b[6];
  if (!read_regs(REG_OUT_X_L, b, 6)) {
    bus_error = true;
    return fail();
  }
  g_errors = 0;
  // 12-bit left-justified, little-endian (guide: counts = raw >> 4); 4 mg per count at +/-8 g
  const int16_t rx = (int16_t)((int16_t)((uint16_t)b[0] | ((uint16_t)b[1] << 8)) >> 4);
  const int16_t ry = (int16_t)((int16_t)((uint16_t)b[2] | ((uint16_t)b[3] << 8)) >> 4);
  const int16_t rz = (int16_t)((int16_t)((uint16_t)b[4] | ((uint16_t)b[5] << 8)) >> 4);
  saturated = abs(rx) >= RAIL_COUNTS || abs(ry) >= RAIL_COUNTS || abs(rz) >= RAIL_COUNTS;
  x = (int16_t)(rx * 4);
  y = (int16_t)(ry * 4);
  z = (int16_t)(rz * 4);
  return true;
}

int scan(uint8_t *found, int n) {
  int count = 0;
  for (uint8_t a = 0x08; a < 0x78 && count < n; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) found[count++] = a;
  }
  return count;
}
}  // namespace accel
