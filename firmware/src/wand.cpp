#include "wand.h"
#include "accel.h"
#include "ble.h"
#include "config.h"
#include "proto.h"
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>
#include <atomic>

// The acquisition task owns sensor reads and MOTION; combined-load timing still needs measurement.
namespace wand {
namespace {
Stats g_stats, g_published;
portMUX_TYPE g_stats_lock = portMUX_INITIALIZER_UNLOCKED;
std::atomic<uint32_t> g_stream_generation{0};
std::atomic<bool> g_recal{false};
bool g_discontinuity = false;
int8_t g_map[3] = {0, 1, 2};
int8_t g_sign[3] = {1, 1, 1};
float g_baseline = 0;
bool g_baseline_ready = false;
TaskHandle_t g_task = nullptr;
uint32_t g_seen_stream_generation = 0;

void publish_stats() {
  portENTER_CRITICAL(&g_stats_lock);
  g_published = g_stats;
  portEXIT_CRITICAL(&g_stats_lock);
}

void process(uint32_t capture_ms, int16_t cx, int16_t cy, int16_t cz, bool saturated) {
  g_stats.sensor_ok = true;
  const int16_t chip[3] = {cx, cy, cz};
  int8_t map[3], sign[3];
  get_axes(map, sign);
  int32_t v[3];
  for (int i = 0; i < 3; i++) {
    v[i] = (int32_t)sign[i] * chip[map[i]];
    if (v[i] > RANGE_G * 1000) {
      v[i] = RANGE_G * 1000;
      saturated = true;
    }
    if (v[i] < -RANGE_G * 1000) {
      v[i] = -RANGE_G * 1000;
      saturated = true;
    }
  }
  g_stats.acquired++;
  g_stats.seq++;
  g_stats.x = (int16_t)v[0];
  g_stats.y = (int16_t)v[1];
  g_stats.z = (int16_t)v[2];
  g_stats.valid = true;
  g_stats.saturated = saturated;

  // Local activity indicator: deviation of the magnitude from a slow baseline (gravity).
  const float mag = sqrtf((float)v[0] * v[0] + (float)v[1] * v[1] + (float)v[2] * v[2]);
  if (g_recal.exchange(false)) {
    g_baseline_ready = false;
  }
  if (!g_baseline_ready) {
    g_baseline = mag;
    g_baseline_ready = true;
  }
  const float jolt = fabsf(mag - g_baseline);
  if (jolt < ACTIVITY_MG * 0.5f) g_baseline += (mag - g_baseline) * BASELINE_ALPHA;
  float level = jolt / (2.0f * ACTIVITY_MG);
  if (level > 1) level = 1;
  g_stats.activity += (level - g_stats.activity) * (level > g_stats.activity ? 0.6f : 0.15f);

  const uint32_t generation = g_stream_generation.load();
  if (generation != g_seen_stream_generation) {
    g_discontinuity = true;
    g_seen_stream_generation = generation;
  }
  if (!generation) return;
  if (millis() - capture_ms > SAMPLE_MAX_AGE_MS) {
    g_stats.dropped++;
    g_discontinuity = true;
    return;
  }
  proto::Motion m;
  m.flags = proto::MF_VALID | (saturated ? proto::MF_SATURATED : 0) | (g_discontinuity ? proto::MF_DISCONTINUITY : 0);
  m.seq = g_stats.seq;
  m.capture_ms = capture_ms;
  m.boot_id = g_stats.boot_id;
  m.ax = (int16_t)v[0];
  m.ay = (int16_t)v[1];
  m.az = (int16_t)v[2];
  uint8_t rec[proto::REC];
  proto::encode_motion(m, rec);
  if (ble::notify_motion(rec, generation)) {
    g_stats.notified++;
    g_discontinuity = false;
  } else {
    g_stats.dropped++;
    g_discontinuity = true;
  }
}

void acq_task(void *) {
  uint32_t last_fresh = millis();
  for (;;) {
    int16_t cx, cy, cz;
    bool saturated = false, bus_error = false, overrun = false;
    const uint32_t now = millis();
    if (accel::poll(cx, cy, cz, saturated, bus_error, overrun)) {
      const uint32_t captured = millis();
      if (overrun) {
        ++g_stats.overruns;
        ++g_stats.dropped;  // one observed overrun, not an invented number of missed native samples
        g_discontinuity = true;
      }
      if (captured - last_fresh > 40) g_discontinuity = true;
      last_fresh = captured;
      process(captured, cx, cy, cz, saturated);
      publish_stats();
      // Diagnostic: observe native DRDY each RTOS tick, without assuming a 20 ms output period.
      // Never manufacture, decimate or relabel samples to hide the measured sensor cadence.
      vTaskDelay(1);
      continue;
    }
    if (bus_error || now - last_fresh > 100) {
      g_stats.sensor_ok = false;
      g_stats.valid = false;
      g_stats.activity = 0;
      g_discontinuity = true;   // whatever comes next is not contiguous with the last sample
      publish_stats();
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    vTaskDelay(1);
  }
}
}  // namespace

void begin(uint32_t boot_id) {
  g_stats = Stats{};
  g_stats.boot_id = boot_id;
  g_stats.sensor_ok = accel::present();
  g_stats.seq = 0xFFFF;  // first acquired sample becomes 0
  publish_stats();
}

void start() {
  if (g_task) return;
  if (xTaskCreate(acq_task, "acq", 6144, nullptr, 4, &g_task) != pdPASS) {
    g_stats.sensor_ok = false;
    publish_stats();
  }
}

void set_streaming(uint32_t generation) { g_stream_generation = generation; }
void set_axes(const int8_t map[3], const int8_t sign[3]) {
  portENTER_CRITICAL(&g_stats_lock);
  for (int i = 0; i < 3; i++) {
    g_map[i] = (int8_t)(map[i] < 0 || map[i] > 2 ? i : map[i]);
    g_sign[i] = (int8_t)(sign[i] < 0 ? -1 : 1);
  }
  portEXIT_CRITICAL(&g_stats_lock);
  g_recal = true;
}
void get_axes(int8_t map[3], int8_t sign[3]) {
  portENTER_CRITICAL(&g_stats_lock);
  for (int i = 0; i < 3; i++) {
    map[i] = g_map[i];
    sign[i] = g_sign[i];
  }
  portEXIT_CRITICAL(&g_stats_lock);
}
void recalibrate() { g_recal = true; }
Stats stats() {
  portENTER_CRITICAL(&g_stats_lock);
  const Stats result = g_published;
  portEXIT_CRITICAL(&g_stats_lock);
  return result;
}
uint32_t stack_headroom() { return g_task ? uxTaskGetStackHighWaterMark(g_task) : 0; }
}  // namespace wand
