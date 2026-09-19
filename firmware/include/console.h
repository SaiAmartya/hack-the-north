#pragma once
#include <stdint.h>

// Persistent settings (NVS) and the USB serial command line (diagnostics only; not used in play).
struct Settings {
  uint8_t rot;        // display rotation 0..3
  bool leds;
  int8_t axis_map[3]; // contract axis i = axis_sign[i] * chip axis axis_map[i]
  int8_t axis_sign[3];
};

constexpr uint8_t kDefaultDisplayRotation = 3;

constexpr Settings default_settings() {
  return {kDefaultDisplayRotation, true, {0, 1, 2}, {1, 1, 1}};
}

namespace console {
void load_settings();
void save_settings();
Settings &settings();
void begin();
void tick();          // parse complete lines from Serial
void hello();         // HPHELLO banner
}  // namespace console
