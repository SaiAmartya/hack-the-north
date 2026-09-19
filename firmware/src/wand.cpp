#include "wand.h"
#include "accel.h"
#include "ble.h"
#include "config.h"
#include "proto.h"
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>

// Acquisition runs on its own FreeRTOS task, above the Arduino loop task, so screen redraws and
// LED frames in the loop can never stall sampling: with everything in one loop the 150 ms display
// refresh cost 1-3 samples each time (measured 40-42 Hz instead of 50). The loop only reads
// `stats()` and flips `set_streaming`; the task owns the sensor and the MOTION notifications.
namespace wand {
namespace {
Stats g_stats;
volatile bool g_streaming = false, g_echo = false, g_recal = false;
bool g_discontinuity = false;
int8_t g_map[3] = {0, 1, 2};
int8_t g_sign[3] = {1, 1, 1};
float g_baseline = 0;
bool g_baseline_ready = false;
TaskHandle_t g_task = nullptr;

void process(uint32_t capture_ms, int16_t cx, int16_t cy, int16_t cz, bool saturated) {
  g_stats.sensor_ok = true;
  const int16_t chip[3] = {cx, cy, cz};
  const MappedSample mapped = map_and_clip(chip, g_map, g_sign, RANGE_G * 1000);
  const int16_t v[3] = {mapped.x, mapped.y, mapped.z};
  saturated = saturated || mapped.saturated;
  g_stats.acquired++;
  g_stats.seq++;
  g_stats.x = (int16_t)v[0];
  g_stats.y = (int16_t)v[1];
  g_stats.z = (int16_t)v[2];
  g_stats.valid = true;
  g_stats.saturated = saturated;

  // Local activity indicator: deviation of the magnitude from a slow baseline (gravity).
  const float mag = sqrtf((float)v[0] * v[0] + (float)v[1] * v[1] + (float)v[2] * v[2]);
  if (g_recal) {
    g_recal = false;
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

  if (g_echo) Serial.printf("HPM|%u|%lu|%d|%d|%d|%s\n", g_stats.seq, (unsigned long)capture_ms, (int)v[0], (int)v[1], (int)v[2], saturated ? "sat" : "ok");

  if (!g_streaming) return;
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
  if (ble::notify_motion(rec)) {
    g_stats.notified++;
    g_discontinuity = false;
  } else {
    g_stats.dropped++;
    g_discontinuity = true;
  }
}

void acq_task(void *) {
  for (;;) {
    int16_t cx, cy, cz;
    bool saturated = false, bus_error = false;
    const uint32_t now = millis();
    if (accel::poll(cx, cy, cz, saturated, bus_error)) {
      process(now, cx, cy, cz, saturated);
      // The next sample is due in 20 ms at 50 Hz: sleep through most of it, then poll every tick
      // so the timestamp lands within ~1 ms of the sensor flagging new data.
      vTaskDelay(pdMS_TO_TICKS(16));
      continue;
    }
    if (bus_error) {
      g_stats.sensor_ok = false;
      g_discontinuity = true;   // whatever comes next is not contiguous with the last sample
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
}

void start() {
  if (g_task) return;
  xTaskCreate(acq_task, "acq", 6144, nullptr, 4, &g_task);  // loop task runs at priority 1
}

void set_streaming(bool on) {
  if (on && !g_streaming) g_discontinuity = true;  // first sample after (re)start marks a break in the stream
  g_streaming = on;
}
void set_axes(const int8_t map[3], const int8_t sign[3]) {
  for (int i = 0; i < 3; i++) {
    g_map[i] = (int8_t)(map[i] < 0 || map[i] > 2 ? i : map[i]);
    g_sign[i] = (int8_t)(sign[i] < 0 ? -1 : 1);
  }
}
void get_axes(int8_t map[3], int8_t sign[3]) {
  for (int i = 0; i < 3; i++) {
    map[i] = g_map[i];
    sign[i] = g_sign[i];
  }
}
void set_echo(bool on) { g_echo = on; }
void recalibrate() { g_recal = true; }
const Stats &stats() { return g_stats; }
}  // namespace wand
