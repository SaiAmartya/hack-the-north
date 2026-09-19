#pragma once
#include "config.h"
#include "proto.h"
#include <stdint.h>
#include <string.h>

// Boot-only sensor profile selection. The default row is the gameplay profile (native 50 Hz, +/-8 g).
// Diagnostic rows keep the creator recipe and the +/-2 g variants reachable from the console; they
// never advertise duel capabilities, so the browser refuses to play on them.
namespace diagnostic {
struct Profile {
  const char *name;
  uint8_t ctrl0, ctrl1, ctrl4, sample_hz, range_g, mg_per_count;
  bool qualified;  // advertises capabilities 0x0F; false rows are diagnostic-only (INFO caps 0)
};
inline constexpr Profile PROFILES[] = {
    {"creator", 0x00, 0x57, 0x80, 100, 2, 1, false},
    {"rate",    0x00, 0x47, 0x80,  50, 2, 1, false},
    {"range",   0x00, 0x47, 0xa0,  50, 8, 4, true},
    {"high",    0x01, 0x47, 0xa0,  50, 8, 4, true},
};
constexpr uint8_t PROFILE_COUNT = sizeof(PROFILES) / sizeof(PROFILES[0]);
constexpr uint8_t GAMEPLAY_PROFILE = 2;
struct Selection { uint8_t profile; bool ble; };
// Every cold, watchdog, brownout or USB reset boots the gameplay profile with the radio on.
constexpr Selection DEFAULT_SELECTION{GAMEPLAY_PROFILE, true};

// Versioned, complemented RTC words: reject cold/watchdog resets, random RTC contents,
// partially written selections and selections retained from another firmware image.
struct Retained { uint32_t magic, value, inverse_value, inverse_magic; };
constexpr uint32_t MAGIC = 0x57440920;  // 0.2.x; 0.1.x selections are never honored
constexpr Retained retain(Selection s) {
  const uint32_t value = s.profile | (s.ble ? 0x100u : 0u);
  return {MAGIC, value, ~value, ~MAGIC};
}
constexpr bool valid(const Retained &r) {
  return r.magic == MAGIC && r.inverse_magic == ~MAGIC && r.inverse_value == ~r.value &&
      (r.value & ~0x103u) == 0 && (r.value & 0xffu) < PROFILE_COUNT;
}
// Only a deliberate software reboot (console `profile ...`) carries a selection into the next boot.
constexpr Selection boot_selection(const Retained &r, bool software_reset) {
  return software_reset && valid(r) ? Selection{(uint8_t)(r.value & 0xffu), (r.value & 0x100u) != 0}
                                   : DEFAULT_SELECTION;
}
inline int profile_index(const char *name) {
  if (name) for (uint8_t i = 0; i < PROFILE_COUNT; ++i) if (!strcmp(name, PROFILES[i].name)) return i;
  return -1;
}
constexpr int16_t to_mg(int16_t counts, const Profile &p) {
  return (int16_t)(counts * p.mg_per_count);
}
constexpr uint8_t capabilities_for(const Profile &p) { return p.qualified ? (uint8_t)proto::CAP_ALL : (uint8_t)0; }
constexpr proto::Info info_for(const Profile &p, uint32_t boot_id) {
  return {capabilities_for(p), p.sample_hz, p.range_g, {0}, boot_id, FW_MAJOR, FW_MINOR, FW_PATCH, AXIS_CONVENTION};
}
// Consecutive brownout resets since the batteries went in (power-on reset clears it, a stable
// boot clears it). Pure policy for host tests: later radio start, lower power, LEDs off.
struct RadioPolicy { uint32_t radio_delay_ms; int8_t tx_dbm_cap; bool leds_off; };
constexpr RadioPolicy radio_policy(uint32_t brownouts, int8_t configured_dbm) {
  const int8_t cap = (int8_t)(configured_dbm - 3 * (int)(brownouts > 4 ? 4 : brownouts));
  return {RADIO_START_DELAY_MS + RADIO_BROWNOUT_DELAY_MS * (brownouts > 3 ? 3 : brownouts),
          cap < TX_POWER_MIN_DBM ? (int8_t)TX_POWER_MIN_DBM : cap, brownouts >= 2};
}
uint32_t brownouts();
void clear_brownouts(); // call once the boot has proven stable
void begin(); // once at setup, before sensor/BLE initialization
Selection selection();
const Profile &profile(); // immutable for this boot, including during I2C recovery
bool select_next_boot(uint8_t profile, bool ble); // writes RTC only; does not change this boot
}  // namespace diagnostic
