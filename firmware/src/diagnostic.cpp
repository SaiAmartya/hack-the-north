#include "diagnostic.h"
#include <esp_attr.h>
#include <esp_system.h>

namespace diagnostic {
namespace {
// Unlike initialized RTC_DATA_ATTR, RTC_NOINIT_ATTR survives a software restart without
// startup overwriting the selection. It is never trusted without reset reason + validation.
RTC_NOINIT_ATTR Retained g_retained;
struct BrownoutWords { uint32_t magic, count, inverse_count, inverse_magic; };
constexpr uint32_t BROWNOUT_MAGIC = 0x42524f57;
RTC_NOINIT_ATTR BrownoutWords g_brownouts;
Selection g_selection = DEFAULT_SELECTION;
uint32_t g_brownout_count = 0;
void store_brownouts(uint32_t count) {
  g_brownout_count = count;
  g_brownouts = {BROWNOUT_MAGIC, count, ~count, ~BROWNOUT_MAGIC};
}
}
void begin() {
  const esp_reset_reason_t reason = esp_reset_reason();
  g_selection = boot_selection(g_retained, reason == ESP_RST_SW);
  g_retained = retain(g_selection);
  const bool words_valid = g_brownouts.magic == BROWNOUT_MAGIC && g_brownouts.inverse_magic == ~BROWNOUT_MAGIC &&
      g_brownouts.inverse_count == ~g_brownouts.count && g_brownouts.count < 1000;
  if (reason == ESP_RST_BROWNOUT) store_brownouts(words_valid ? g_brownouts.count + 1 : 1);
  else if (reason == ESP_RST_POWERON || !words_valid) store_brownouts(0);
  else g_brownout_count = g_brownouts.count;
}
uint32_t brownouts() { return g_brownout_count; }
void clear_brownouts() { store_brownouts(0); }
Selection selection() { return g_selection; }
const Profile &profile() { return PROFILES[g_selection.profile]; }
bool select_next_boot(uint8_t index, bool ble) {
  if (index >= PROFILE_COUNT) return false;
  g_retained = retain({index, ble});
  return true;
}
}  // namespace diagnostic
