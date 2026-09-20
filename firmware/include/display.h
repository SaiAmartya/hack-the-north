#pragma once
#include <stdint.h>

namespace display {
struct View {
  const char *id;          // "46BA"
  const char *link;        // "advertising" / "connected" / "streaming"
  bool sensor_ok;
  bool state_valid;        // SET_STATE lease alive
  bool stale;              // host state stale bit
  uint8_t phase, hp, status;
  const char *cue;         // one-shot text while a cue plays, else ""
  uint16_t cue_color;      // RGB565
  float activity;          // 0..1
};

bool begin(uint8_t rotation);
void set_rotation(uint8_t rotation);
void boot_line(const char *text);
void draw(const View &v);      // repaints only changed fields
void force_redraw();
}  // namespace display
