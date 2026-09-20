// Wandduel wand firmware for the Hack the North 2026 Hacker Badge.
// Implements BADGE-FIRMWARE-CONTRACT.md v1: BLE GATT peripheral, native 50 Hz raw acceleration,
// session commands (OPEN/SYNC/SET_STATE/CUE) and on-badge feedback. See README.md in this folder.
//
// Tasks: the NimBLE host task answers CONTROL writes (on_control), the acquisition task in wand.cpp
// samples and notifies MOTION, and the Arduino loop does everything else (buttons, console, leases,
// cues, health, screen and LEDs). g_session and the STATUS characteristic are shared between the
// host task and the loop and are only touched under g_lock; the loop never holds it while drawing.
#include <Arduino.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "accel.h"
#include "ble.h"
#include "buttons.h"
#include "config.h"
#include "console.h"
#include "diagnostic.h"
#include "leds.h"
#include "present.h"
#include "proto.h"
#include "wand.h"

namespace {
proto::Session g_session;
StaticSemaphore_t g_lock_storage;
SemaphoreHandle_t g_lock = nullptr;
struct Lock {
  Lock() { xSemaphoreTake(g_lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(g_lock); }
};
bool g_health_dirty = false;           // guarded by g_lock
uint32_t g_boot_id = 0;
uint32_t g_session_gen = 0, g_seen_gen = 0, g_present_revision = 0;
uint32_t g_next_health = 0, g_last_health_bits = 0xFFFFFFFF;
uint32_t g_next_adv_check = 0;
bool g_streaming = false;
// Battery soft start: the radio and LEDs come up in stages after the boost converter has settled.
uint8_t g_device_id[6], g_info_rec[proto::REC], g_health_rec[proto::REC];
diagnostic::RadioPolicy g_policy{};
uint32_t g_radio_start_at = 0, g_radio_started_at = 0;
bool g_radio_started = false, g_leds_released = false, g_boot_stable = false;

uint32_t health_bits() {
  const wand::Stats &w = wand::stats();
  return (w.sensor_ok ? proto::H_SENSOR : 0) | (g_streaming ? proto::H_STREAM : 0) | (present::healthy() ? proto::H_PRESENTATION : 0);
}

// Loop only. Health is notified at 1 Hz and immediately when its bits change.
void publish_health(uint32_t now, bool force) {
  Lock lock;
  const uint32_t bits = health_bits() | (g_session.state_stale() ? proto::H_STATE_STALE : 0);
  if (!force && !g_health_dirty && bits == g_last_health_bits && (int32_t)(now - g_next_health) < 0) return;
  g_health_dirty = false;
  g_last_health_bits = bits;
  g_next_health = now + STATUS_HEALTH_PERIOD_MS;
  const proto::Status h = g_session.health(now, wand::stats().lost, health_bits());
  uint8_t rec[proto::REC];
  proto::encode_status(h, rec);
  ble::set_health(rec);
  ble::notify_status(rec, g_session_gen);
}

// Encode current health as the STATUS read value. Call with g_lock held.
void store_health(uint32_t now) {
  uint8_t rec[proto::REC];
  proto::encode_status(g_session.health(now, wand::stats().lost, health_bits()), rec);
  ble::set_health(rec);
}

void update_stream() {
  g_streaming = ble::connected() && g_session.is_open() && ble::motion_subscribed();
  wand::set_streaming(g_streaming ? g_session_gen : 0);
}

void on_link(uint32_t generation) {
  Lock lock;
  if (generation != g_session_gen) {
    g_session_gen = generation;
    g_session.reset();
  }
  update_stream();
  g_health_dirty = true;
  store_health(millis());
}

// Runs on the NimBLE host task the moment a CONTROL write lands, so a command result never waits
// for the loop: with results sent from the loop, a screen redraw added up to ~100 ms to the
// browser's round trip and its clock-sync policy gave up. One result per identifiable frame.
void on_control(const uint8_t *raw, size_t len, uint32_t received_ms, uint32_t generation) {
  {
    Lock lock;
    if (!ble::connected() || generation != g_session_gen) return;
    const bool stale_before = g_session.state_stale();
    g_session.tick(received_ms);
    proto::Status result;
    if (g_session.handle_control(raw, len, received_ms, result)) {
      uint8_t rec[proto::REC];
      proto::encode_status(result, rec);
      ble::notify_status(rec, generation);
    }
    update_stream();
    if (stale_before != g_session.state_stale()) g_health_dirty = true;
    store_health(millis());
  }
}

void boot_diag() {
  char b[64];
  const diagnostic::Profile &p = diagnostic::profile();
  snprintf(b, sizeof(b), "wand firmware %s", FW_VERSION_STR);
  present::boot_line(b);
  snprintf(b, sizeof(b), accel::present() ? "accel OK (who %02X) %u Hz +/-%u g" : "accel MISSING", accel::who_am_i(), p.sample_hz, p.range_g);
  present::boot_line(b);
  snprintf(b, sizeof(b), "reset reason %d", (int)esp_reset_reason());
  present::boot_line(b);
  if (Serial) Serial.printf("HPDIAG|reset=%d|profile=%s|ble=%s|caps=%02X|accel=%d|who=%02X|ctrl0=%02X|ctrl1=%02X|ctrl4=%02X|brownouts=%lu|radio_delay_ms=%lu|tx_dbm=%d|leds=%s\n",
                            (int)esp_reset_reason(), p.name, diagnostic::selection().ble ? "on" : "off", diagnostic::capabilities_for(p),
                            accel::present() ? 1 : 0, accel::who_am_i(), accel::diagnostics().ctrl0, accel::ctrl1(), accel::ctrl4(),
                            (unsigned long)diagnostic::brownouts(), (unsigned long)g_policy.radio_delay_ms, (int)g_policy.tx_dbm_cap,
                            g_policy.leds_off ? "off-after-brownouts" : "staged");
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(5);  // a stalled USB host must never block acquisition
  diagnostic::begin(); // latch the boot profile before any sensor or radio access
  g_lock = xSemaphoreCreateMutexStatic(&g_lock_storage);
  btn::begin();
  console::load_settings();
  const Settings &s = console::settings();
  g_policy = diagnostic::radio_policy(diagnostic::brownouts(), s.tx_dbm);
  present::begin(s.rot);
  leds::set_enabled(false);  // LEDs join after the radio is up (staged battery load)
  accel::begin();
  boot_diag();

  g_boot_id = esp_random();
  if (g_boot_id == 0) g_boot_id = 1;
  esp_read_mac(g_device_id, ESP_MAC_BT);
  ble::identify(g_device_id);

  proto::Info info = diagnostic::info_for(diagnostic::profile(), g_boot_id);
  memcpy(info.device_id, g_device_id, 6);
  proto::encode_info(info, g_info_rec);
  wand::begin(g_boot_id);
  wand::set_axes(s.axis_map, s.axis_sign);
  proto::encode_status(g_session.health(millis(), 0, health_bits()), g_health_rec);
  ble::set_control_handler(on_control);
  ble::set_link_handler(on_link);
  g_radio_start_at = millis() + g_policy.radio_delay_ms;
  if (!diagnostic::selection().ble) {
    ble::begin(g_device_id, g_info_rec, g_health_rec, false, g_policy.tx_dbm_cap);
    g_radio_started = true;
    g_radio_started_at = millis();
  }

  char b[64];
  snprintf(b, sizeof(b), "BLE %s %s  boot %08lX", ble::name(),
           diagnostic::selection().ble ? (diagnostic::brownouts() ? "after brownout" : "starting") : "OFF", (unsigned long)g_boot_id);
  present::boot_line(b);
  console::begin();
  console::hello();
  wand::start();
  delay(700);
  present::link_changed();
}

void loop() {
  uint32_t now = millis();
  static uint32_t next_btn = 0;
  if ((int32_t)(now - next_btn) >= 0) {
    next_btn = now + 10;
    btn::poll();
    if (btn::pressed(btn::START)) wand::recalibrate();
  }
  console::tick();
  now = millis();

  // Cue activation is serialized with session changes; only SPI drawing runs outside the lock.
  proto::DisplayState st;
  bool stale, streaming;
  {
    Lock lock;
    now = millis();
    g_session.tick(now);
    update_stream();
    streaming = g_streaming;
    st = g_session.state();
    stale = g_session.state_stale();
    if (g_seen_gen != g_session_gen || g_present_revision != g_session.presentation_revision()) {
      present::link_changed();
      g_seen_gen = g_session_gen;
      g_present_revision = g_session.presentation_revision();
    }
    proto::Cue cue;
    while (g_session.take_cue(now, cue)) present::play_cue(cue, st.phase);
  }

  // Staged battery load: radio after the boot inrush, LEDs after the radio, and the brownout
  // count is forgotten once the boot has proven stable.
  if (!g_radio_started && (int32_t)(now - g_radio_start_at) >= 0) {
    ble::begin(g_device_id, g_info_rec, g_health_rec, true, g_policy.tx_dbm_cap);
    g_radio_started = true;
    g_radio_started_at = now;
  }
  if (g_radio_started && !g_leds_released && now - g_radio_started_at >= LED_START_AFTER_RADIO_MS) {
    g_leds_released = true;
    leds::set_enabled(console::settings().leds && !g_policy.leds_off);
  }
  if (!g_boot_stable && now >= STABLE_BOOT_MS) {
    g_boot_stable = true;
    if (diagnostic::brownouts()) diagnostic::clear_brownouts();
  }

  // Advertising watchdog: an idle wand must always be discoverable (contract section 6).
  if ((int32_t)(now - g_next_adv_check) >= 0) {
    g_next_adv_check = now + ADV_WATCHDOG_MS;
    ble::ensure_advertising();
  }

  publish_health(now, false);
  present::tick(st, stale, now, ble::connected(), streaming);
  delay(1);
}
