#include "diagnostic.h"
#include <esp_attr.h>
#include <esp_system.h>

namespace diagnostic {
namespace {
// Unlike initialized RTC_DATA_ATTR, RTC_NOINIT_ATTR survives a software restart without
// startup overwriting the selection. It is never trusted without reset reason + validation.
RTC_NOINIT_ATTR Retained g_retained;
Selection g_selection = DEFAULT_SELECTION;
}
void begin() {
  g_selection = boot_selection(g_retained, esp_reset_reason() == ESP_RST_SW);
  g_retained = retain(g_selection);
}
Selection selection() { return g_selection; }
const Profile &profile() { return PROFILES[g_selection.profile]; }
bool select_next_boot(uint8_t index, bool ble) {
  if (index >= PROFILE_COUNT) return false;
  g_retained = retain({index, ble});
  return true;
}
}  // namespace diagnostic
