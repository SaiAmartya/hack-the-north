#pragma once
#include "config.h"
#include "proto.h"
#include <stdint.h>
#include <string.h>

// Explicit, boot-only diagnostic matrix. No row is a gameplay-qualified profile.
namespace diagnostic {
struct Profile {
  const char *name;
  uint8_t ctrl0, ctrl1, ctrl4, sample_hz, range_g, mg_per_count;
};
inline constexpr Profile PROFILES[] = {
    {"creator", 0x00, 0x57, 0x80, 100, 2, 1},
    {"rate",    0x00, 0x47, 0x80,  50, 2, 1},
    {"range",   0x00, 0x47, 0xa0,  50, 8, 4},
    {"high",    0x01, 0x47, 0xa0,  50, 8, 4},
};
constexpr uint8_t PROFILE_COUNT = sizeof(PROFILES) / sizeof(PROFILES[0]);
struct Selection { uint8_t profile; bool ble; };
constexpr Selection DEFAULT_SELECTION{0, true};

// Versioned, complemented RTC words: reject cold/watchdog resets, random RTC contents,
// partially written selections and selections retained from another diagnostic image.
struct Retained { uint32_t magic, value, inverse_value, inverse_magic; };
constexpr uint32_t MAGIC = 0x57440819;
constexpr Retained retain(Selection s) {
  const uint32_t value = s.profile | (s.ble ? 0x100u : 0u);
  return {MAGIC, value, ~value, ~MAGIC};
}
constexpr bool valid(const Retained &r) {
  return r.magic == MAGIC && r.inverse_magic == ~MAGIC && r.inverse_value == ~r.value &&
      (r.value & ~0x103u) == 0 && (r.value & 0xffu) < PROFILE_COUNT;
}
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
constexpr proto::Info info_for(const Profile &p, uint32_t boot_id) {
  // Literal zero: no build flag or selected matrix row can claim qualified capabilities.
  return {0, p.sample_hz, p.range_g, {0}, boot_id, FW_MAJOR, FW_MINOR, FW_PATCH, AXIS_CONVENTION};
}
void begin(); // once at setup, before sensor/BLE initialization
Selection selection();
const Profile &profile(); // immutable for this boot, including during I2C recovery
bool select_next_boot(uint8_t profile, bool ble); // writes RTC only; does not change this boot
}  // namespace diagnostic
