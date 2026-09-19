// Harry Potter Battle Simulator wand firmware for the Hack the North 2026 Hacker Badge.
// Implements BADGE-FIRMWARE-CONTRACT.md v1: BLE GATT peripheral, 50 Hz raw acceleration, session
// commands (OPEN/SYNC/SET_STATE/CUE) and on-badge feedback. See README.md in this folder.
#include <Arduino.h>
#include <esp_mac.h>
#include <esp_random.h>
#include "accel.h"
#include "ble.h"
#include "buttons.h"
#include "config.h"
#include "console.h"
#include "leds.h"
#include "present.h"
#include "proto.h"
#include "wand.h"

namespace {
proto::Session g_session;
uint32_t g_boot_id = 0;
uint32_t g_seen_gen = 0;
uint32_t g_next_health = 0, g_last_health_bits = 0xFFFFFFFF;
uint32_t g_rate_window_start = 0, g_rate_window_count = 0, g_rate_hz = 0, g_last_acquired = 0;
bool g_streaming = false;

uint32_t health_bits() {
  const wand::Stats &w = wand::stats();
  return (w.sensor_ok ? proto::H_SENSOR : 0) | (g_streaming ? proto::H_STREAM : 0) | (present::healthy() ? proto::H_PRESENTATION : 0);
}

void publish_health(uint32_t now, bool force) {
  const uint32_t bits = health_bits() | (g_session.state_stale() ? proto::H_STATE_STALE : 0);
  if (!force && bits == g_last_health_bits && now < g_next_health) return;
  g_last_health_bits = bits;
  g_next_health = now + STATUS_HEALTH_PERIOD_MS;
  const proto::Status h = g_session.health(now, wand::stats().dropped, health_bits());
  uint8_t rec[proto::REC];
  proto::encode_status(h, rec);
  ble::set_health(rec);
  ble::notify_status(rec);
}

void boot_diag() {
  char b[64];
  snprintf(b, sizeof(b), "wand firmware %s", FW_VERSION_STR);
  present::boot_line(b);
  uint8_t found[8];
  const int n = accel::scan(found, 8);
  char list[40] = "";
  for (int i = 0; i < n; i++) {
    char one[8];
    snprintf(one, sizeof(one), "%02X ", found[i]);
    strncat(list, one, sizeof(list) - strlen(list) - 1);
  }
  snprintf(b, sizeof(b), "i2c: %s", n ? list : "nothing answered");
  present::boot_line(b);
  snprintf(b, sizeof(b), accel::present() ? "accel OK (who_am_i %02X) 50 Hz +/-8 g" : "accel MISSING", accel::who_am_i());
  present::boot_line(b);
  Serial.printf("HPDIAG|i2c=%s|accel=%d|who=%02X\n", n ? list : "none", accel::present() ? 1 : 0, accel::who_am_i());
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(5);  // a stalled USB host must never block acquisition
  btn::begin();
  console::load_settings();
  const Settings &s = console::settings();
  present::begin(s.rot);
  leds::set_enabled(s.leds);
  accel::begin();
  boot_diag();

  g_boot_id = esp_random();
  if (g_boot_id == 0) g_boot_id = 1;
  uint8_t device_id[6];
  esp_read_mac(device_id, ESP_MAC_BT);

  proto::Info info{proto::CAP_ALL, SAMPLE_HZ, RANGE_G, {0}, g_boot_id, FW_MAJOR, FW_MINOR, FW_PATCH, AXIS_CONVENTION};
  memcpy(info.device_id, device_id, 6);
  uint8_t info_rec[proto::REC], health_rec[proto::REC];
  proto::encode_info(info, info_rec);
  wand::begin(g_boot_id);
  wand::set_axes(s.axis_map, s.axis_sign);
  proto::encode_status(g_session.health(millis(), 0, health_bits()), health_rec);
  ble::begin(device_id, info_rec, health_rec);

  char b[64];
  snprintf(b, sizeof(b), "BLE %s advertising  boot %08lX", ble::name(), (unsigned long)g_boot_id);
  present::boot_line(b);
  console::begin();
  console::hello();
  wand::start();
  delay(700);
  present::link_changed();
}

void loop() {
  const uint32_t now = millis();
  static uint32_t next_btn = 0;
  if (now >= next_btn) {  // ~10 ms poll + debounce (guide section 3); bit-banging every loop would waste the loop
    next_btn = now + 10;
    btn::poll();
    if (btn::pressed(btn::START)) wand::recalibrate();
  }
  console::tick();

  // Connection generation: any connect/disconnect forgets the session (contract section 6).
  const uint32_t gen = ble::generation();
  if (gen != g_seen_gen) {
    g_seen_gen = gen;
    g_session.reset();
    present::link_changed();
    publish_health(now, true);
  }

  // Commands arrive on the BLE task and are processed here, one result per identifiable frame.
  uint8_t raw[proto::REC];
  size_t len;
  uint32_t received;
  while (ble::pop_control(raw, len, received)) {
    proto::Status result;
    const bool stale_before = g_session.state_stale();
    if (g_session.handle_control(raw, len, received, result)) {
      uint8_t rec[proto::REC];
      proto::encode_status(result, rec);
      ble::notify_status(rec);
    }
    if (stale_before != g_session.state_stale()) publish_health(now, true);
  }
  g_session.tick(now);

  g_streaming = ble::connected() && g_session.is_open() && ble::motion_subscribed();
  wand::set_streaming(g_streaming);  // sampling + MOTION notifications run on the acquisition task

  proto::Cue cue;
  while (g_session.take_cue(now, cue)) present::play_cue(cue, g_session.state().phase);

  // effective acquisition rate, for the footer
  const wand::Stats &w = wand::stats();
  if (now - g_rate_window_start >= 1000) {
    g_rate_hz = w.acquired - g_last_acquired;
    g_last_acquired = w.acquired;
    g_rate_window_start = now;
  }
  (void)g_rate_window_count;

  publish_health(now, false);
  present::tick(g_session, now, ble::connected(), g_streaming, g_rate_hz, w.dropped);
  delay(1);
}
