#include "accel.h"
#include "diagnostic.h"
#include "esp_system.h"
#include <assert.h>
#include <initializer_list>
#include <stdio.h>

namespace {
esp_reset_reason_t reset_reason = ESP_RST_POWERON;
void expect_selection(uint8_t profile, bool ble) {
  assert(diagnostic::selection().profile == profile);
  assert(diagnostic::selection().ble == ble);
  assert(&diagnostic::profile() == &diagnostic::PROFILES[profile]);
}
}
esp_reset_reason_t esp_reset_reason() { return reset_reason; }

int main() {
  using namespace diagnostic;
  constexpr uint8_t expected[4][6] = {
      {0x00, 0x57, 0x80, 100, 2, 1}, {0x00, 0x47, 0x80, 50, 2, 1},
      {0x00, 0x47, 0xa0, 50, 8, 4}, {0x01, 0x47, 0xa0, 50, 8, 4},
  };
  for (uint8_t index = 0; index < PROFILE_COUNT; ++index) {
    const Profile &p = PROFILES[index];
    assert(p.ctrl0 == expected[index][0] && p.ctrl1 == expected[index][1] && p.ctrl4 == expected[index][2]);
    assert(p.sample_hz == expected[index][3] && p.range_g == expected[index][4] && p.mg_per_count == expected[index][5]);
    assert(profile_index(p.name) == index);
    // Positive and negative native little-endian 12-bit values, discarded low nibble,
    // zero and both rails: conversion must use the selected row's actual sensitivity.
    assert(to_mg(accel::signed_counts(0x80, 0x3e), p) == 1000 * p.mg_per_count);
    assert(to_mg(accel::signed_counts(0x80, 0xc1), p) == -1000 * p.mg_per_count);
    assert(to_mg(accel::signed_counts(0xaf, 0x0f), p) == 250 * p.mg_per_count);
    assert(to_mg(accel::signed_counts(0x60, 0xf0), p) == -250 * p.mg_per_count);
    assert(to_mg(accel::signed_counts(0x00, 0x00), p) == 0);
    assert(to_mg(accel::signed_counts(0xf0, 0x7f), p) == 2047 * p.mg_per_count);
    assert(to_mg(accel::signed_counts(0x00, 0x80), p) == -2048 * p.mg_per_count);
    const proto::Info info = info_for(p, 0x10203040);
    uint8_t encoded[proto::REC];
    proto::encode_info(info, encoded);
    assert(encoded[1] == 0 && encoded[2] == p.sample_hz && encoded[3] == p.range_g);
    assert(encoded[10] == 0x40 && encoded[13] == 0x10);
    assert(encoded[14] == 0 && encoded[15] == 1 && encoded[16] == 9 && encoded[17] == 1);
    for (bool ble : {false, true}) {
      const Retained r = retain({index, ble});
      assert(valid(r));
      const Selection warm = boot_selection(r, true), cold = boot_selection(r, false);
      assert(warm.profile == index && warm.ble == ble);
      assert(cold.profile == 0 && cold.ble);
      // Each bit of all four retained words is checked, not just the profile bounds.
      for (unsigned bit = 0; bit < 32; ++bit) {
        Retained corrupt = r;
        corrupt.magic ^= (1u << bit);
        assert(!valid(corrupt));
        corrupt = r; corrupt.value ^= (1u << bit);
        assert(!valid(corrupt));
        corrupt = r; corrupt.inverse_value ^= (1u << bit);
        assert(!valid(corrupt));
        corrupt = r; corrupt.inverse_magic ^= (1u << bit);
        assert(!valid(corrupt));
      }
    }
  }
  assert(profile_index(nullptr) == -1 && profile_index("") == -1 && profile_index("HIGH") == -1);
  assert(!valid(retain({4, true})) && !valid(retain({255, false})));
  Retained reserved = retain({0, false});
  reserved.value |= 0x200; reserved.inverse_value = ~reserved.value;
  assert(!valid(reserved));
  assert(boot_selection({}, true).profile == 0 && boot_selection({}, true).ble);

  // Exercise the real RTC-selection implementation with only the reset-reason API stubbed.
  // Selecting the next boot must never change the live profile or BLE state.
  begin(); expect_selection(0, true);
  for (uint8_t index = 0; index < PROFILE_COUNT; ++index) {
    for (bool ble : {false, true}) {
      const Selection before = selection();
      assert(select_next_boot(index, ble));
      expect_selection(before.profile, before.ble);
      reset_reason = ESP_RST_SW;
      begin(); expect_selection(index, ble);
      begin(); expect_selection(index, ble); // ordinary software reboot keeps selection
    }
  }
  assert(!select_next_boot(4, false));
  begin(); expect_selection(3, true); // invalid request leaves the previous RTC selection intact
  reset_reason = ESP_RST_POWERON;
  begin(); expect_selection(0, true);
  assert(select_next_boot(3, true));
  reset_reason = ESP_RST_TASK_WDT;
  begin(); expect_selection(0, true); // unexpected reset fails closed to discoverable diagnostic mode, even with valid RTC words
  puts("PASS: four profiles, eight boot modes, signed decoding, INFO, RTC corruption and immutable live selection");
}
