#pragma once
#include <stdint.h>

// Motion acquisition and streaming (contract section 4).
namespace wand {
struct Stats {
  uint32_t boot_id;
  uint32_t acquired;     // fresh sensor samples read
  uint32_t notified;     // MOTION notifications accepted by the stack
  uint32_t dropped;      // samples not delivered: stale before enqueue, or refused by the stack
  uint16_t seq;          // last sequence number
  int16_t x, y, z;       // last sample in contract axes, mg
  bool valid, saturated, sensor_ok;
  float activity;        // 0..1 smoothed movement level for local feedback
};

void begin(uint32_t boot_id);
void set_streaming(bool on);              // OPEN succeeded and MOTION is subscribed
void set_axes(const int8_t map[3], const int8_t sign[3]);  // contract axis i = sign[i] * chip axis map[i]
void get_axes(int8_t map[3], int8_t sign[3]);
void set_echo(bool on);                   // print every sample on the serial console (diagnostics)
void recalibrate();                       // re-seed the activity baseline
void start();                             // launch the acquisition task (call after ble::begin)
const Stats &stats();
}  // namespace wand
