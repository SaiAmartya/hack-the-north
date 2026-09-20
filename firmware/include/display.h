#pragma once
#include <stdint.h>

namespace display {
constexpr int SPELL_SLOTS = 8;  // index = contract spell code 1..7; slot 0 unused

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
  int16_t x, y, z;         // mg, contract axes
  const char *foot;        // small diagnostics line
  // Per-spell cooldown rings (contract spell codes 1..7). `cd_frac` is the remaining fraction
  // 0..255 (0 = ready, ring shows its button); `cd_secs` is the whole seconds left, for the label.
  uint8_t cd_frac[SPELL_SLOTS];
  uint8_t cd_secs[SPELL_SLOTS];
  bool recovering;         // global cast recovery: every ring dims briefly after any cast
};

bool begin(uint8_t rotation);
void set_rotation(uint8_t rotation);
void boot_line(const char *text);
void draw(const View &v);      // repaints only changed fields
void force_redraw();
uint16_t spell_color(uint8_t spell);   // RGB565 per contract spell code
const char *spell_button(uint8_t spell);  // one-glyph badge button that casts this spell
}  // namespace display
