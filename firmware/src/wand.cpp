#include "wand.h"
#include "accel.h"
#include "ble.h"
#include "config.h"
#include "diagnostic.h"
#include "proto.h"
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>
#include <atomic>

// The acquisition task owns sensor reads and MOTION notifications. It paces itself to the sensor's
// output period: sleep until just before the next sample is due, then poll new-data once per tick.
namespace wand {
namespace {
Stats g_stats, g_published;
portMUX_TYPE g_stats_lock = portMUX_INITIALIZER_UNLOCKED;
std::atomic<uint32_t> g_stream_generation{0};
std::atomic<bool> g_recal{false};
bool g_break_pending = true;   // next emitted sample is not contiguous with the previous one
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

void process(const accel::Sample &sample, uint32_t gap_ms) {
  g_stats.sensor_ok = true;
  const int16_t chip[3] = {sample.x, sample.y, sample.z};
  int8_t map[3], sign[3];
  get_axes(map, sign);
  const MappedSample mapped = map_and_clip(chip, map, sign, diagnostic::profile().range_g * 1000);
  const int16_t v[3] = {mapped.x, mapped.y, mapped.z};
  const bool saturated = sample.saturated || mapped.saturated;
  g_stats.acquired++;
  g_stats.seq++;
  g_stats.x = v[0];
  g_stats.y = v[1];
  g_stats.z = v[2];
  g_stats.valid = true;
  g_stats.saturated = saturated;

  // Local activity indicator: deviation of the magnitude from a slow baseline (gravity).
  const float mag = sqrtf((float)v[0] * v[0] + (float)v[1] * v[1] + (float)v[2] * v[2]);
  if (g_recal.exchange(false)) g_baseline_ready = false;
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
  const bool generation_changed = generation != g_seen_stream_generation;
  g_seen_stream_generation = generation;
  if (!generation) {
    g_break_pending = true;  // not streaming: whatever is emitted next is not contiguous
    return;
  }
  const uint32_t age_ms = millis() - sample.ready_ms;
  const Continuity c = classify_fresh_sample(gap_ms, age_ms, g_break_pending, generation_changed, max_gap_ms(accel::period_ms()), SAMPLE_MAX_AGE_MS);
  if (c.drop) {
    g_stats.dropped++;
    g_stats.lost++;
    g_break_pending = true;
    return;
  }
  proto::Motion m;
  m.flags = proto::MF_VALID | (saturated ? proto::MF_SATURATED : 0) | (c.discontinuity ? proto::MF_DISCONTINUITY : 0);
  m.seq = g_stats.seq;
  m.capture_ms = sample.ready_ms;
  m.boot_id = g_stats.boot_id;
  m.ax = v[0];
  m.ay = v[1];
  m.az = v[2];
  uint8_t rec[proto::REC];
  proto::encode_motion(m, rec);
  if (ble::notify_motion(rec, generation)) {
    g_stats.notified++;
    g_break_pending = false;
  } else {
    g_stats.dropped++;
    g_stats.lost++;
    g_break_pending = true;
  }
}

void acq_task(void *) {
  uint32_t last_ready = millis();
  bool have_last = false;
  for (;;) {
    accel::Sample sample;
    bool bus_error = false;
    if (accel::poll(sample, bus_error)) {
      const uint32_t period = accel::period_ms();
      const uint32_t limit = max_gap_ms(period);
      const uint32_t gap = have_last ? sample.ready_ms - last_ready : limit + 1;
      if (have_last && gap > limit) {
        ++g_stats.gaps;
        ++g_stats.lost;
      }
      if (sample.overrun_flag) ++g_stats.overrun_flags;
      last_ready = sample.ready_ms;
      have_last = true;
      process(sample, gap);
      publish_stats();
      // Pace to the output period, anchored to the capture time so processing/notify time never eats
      // the margin: wake shortly before the next expected sample, then poll once per tick.
      const int32_t until = (int32_t)(sample.ready_ms + period - ACQ_WAKE_MARGIN_MS) - (int32_t)millis();
      vTaskDelay(until > 1 ? pdMS_TO_TICKS((uint32_t)until) : 1);
      continue;
    }
    if (bus_error || millis() - last_ready > SENSOR_SILENCE_MS) {
      g_stats.sensor_ok = false;
      g_stats.valid = false;
      g_stats.activity = 0;
      g_break_pending = true;   // whatever comes next is not contiguous with the last sample
      have_last = false;
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
