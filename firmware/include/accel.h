#pragma once
#include <stdint.h>
namespace accel {
bool begin();                 // SC7A20/LIS2DH at 50 Hz, +/-8 g; bounded I2C timeouts
bool present();
uint8_t who_am_i();
uint32_t recoveries();        // how often the wedged bus had to be re-initialised
// Returns true only when the sensor flagged a new sample since the last read (fresh data). Values
// in mg on the chip's own axes. `saturated` is set when any axis railed. `bus_error` reports an
// I2C failure; no values are produced in that case.
bool poll(int16_t &x, int16_t &y, int16_t &z, bool &saturated, bool &bus_error);
int scan(uint8_t *found, int n);   // I2C bus scan for diagnostics
}  // namespace accel
