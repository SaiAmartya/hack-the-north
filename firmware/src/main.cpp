// Harry Potter Battle Simulator wand firmware for the Hack the North 2026 Hacker Badge.
// Implements BADGE-FIRMWARE-CONTRACT.md v1: BLE GATT peripheral, 50 Hz raw acceleration, session
// commands (OPEN/SYNC/SET_STATE/CUE) and on-badge feedback. See README.md in this folder.
//
// Tasks: the NimBLE host task answers CONTROL writes (on_control), the acquisition task in wand.cpp
// samples and notifies MOTION, and the Arduino loop does everything else (buttons, console, leases,
// cues, health, screen and LEDs). g_session and the STATUS characteristic are shared between the
// host task and the loop and are only touched under g_lock; the loop never holds it while drawing.
#include <Arduino.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
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
SemaphoreHandle_t g_lock = nullptr;
struct Lock {
  Lock() { xSemaphoreTake(g_lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(g_lock); }
};
volatile bool g_health_dirty = false;   // set by the host task when a command changed the stale bit
uint32_t g_boot_id = 0;
uint32_t g_seen_gen = 0;
uint32_t g_next_health = 0, g_last_health_bits = 0xFFFFFFFF;
uint32_t g_rate_window_start = 0, g_rate_hz = 0, g_last_acquired = 0;
bool g_streaming = false;

uint32_t health_bits() {
  const wand::Stats &w = wand::stats();
  return (w.sensor_ok ? proto::H_SENSOR : 0) | (g_streaming ? proto::H_STREAM : 0) | (present::healthy() ? proto::H_PRESENTATION : 0);
}

// Loop only. Health is notified at 1 Hz and immediately when its bits change.
void publish_health(uint32_t now, bool force) {
  Lock lock;
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

// Runs on the NimBLE host task the moment a CONTROL write lands, so a command result never waits
// for the loop: with results sent from the loop, a screen redraw added up to ~100 ms to the
// browser's round trip and its clock-sync policy gave up. One result per identifiable frame.
void on_control(const uint8_t *raw, size_t len, uint32_t received_ms) {
  bool stale_changed = false;
  {
    Lock lock;
    const bool stale_before = g_session.state_stale();
    proto::Status result;
    if (g_session.handle_control(raw, len, received_ms, result)) {
      uint8_t rec[proto::REC];
      proto::encode_status(result, rec);
      ble::notify_status(rec);
    }
    stale_changed = stale_before != g_session.state_stale();
  }
  if (stale_changed) g_health_dirty = true;
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
  g_lock = xSemaphoreCreateMutex();
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
  ble::set_control_handler(on_control);
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
    {
      Lock lock;
      g_session.reset();
    }
    present::link_changed();
    publish_health(now, true);
  }
  if (g_health_dirty) {
    g_health_dirty = false;
    publish_health(now, true);
  }

  // Lease expiry, stream gate and due cues, then a snapshot of the state for presentation.
  proto::Cue cues[proto::MAX_CUES];
  int n_cues = 0;
  proto::DisplayState st;
  bool stale;
  {
    Lock lock;
    g_session.tick(now);
    g_streaming = ble::connected() && g_session.is_open() && ble::motion_subscribed();
    while (n_cues < proto::MAX_CUES && g_session.take_cue(now, cues[n_cues])) n_cues++;
    st = g_session.state();
    stale = g_session.state_stale();
  }
  wand::set_streaming(g_streaming);  // sampling + MOTION notifications run on the acquisition task
  for (int i = 0; i < n_cues; i++) present::play_cue(cues[i], st.phase);

  // effective acquisition rate, for the footer
  const wand::Stats &w = wand::stats();
  if (now - g_rate_window_start >= 1000) {
    g_rate_hz = w.acquired - g_last_acquired;
    g_last_acquired = w.acquired;
    g_rate_window_start = now;
  }

  publish_health(now, false);
  present::tick(st, stale, now, ble::connected(), g_streaming, g_rate_hz, w.dropped);
  delay(1);
}
