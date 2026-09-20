#include "present.h"
#include "ble.h"
#include "config.h"
#include "display.h"
#include "leds.h"
#include "wand.h"
#include <Arduino.h>
#include <stdio.h>

namespace present {
namespace {
uint32_t g_next_screen = 0, g_cue_until = 0;
char g_cue_text[24] = "";
uint16_t g_cue_color = 0xFFFF;
bool g_ok = true;
bool g_redraw = false;

const char *spell_name(uint8_t s) {
  switch (s) {
    case proto::SP_STUPEFY: return "STUPEFY";
    case proto::SP_PROTEGO: return "PROTEGO";
    case proto::SP_EXPELLIARMUS: return "EXPELLIARMUS";
    case proto::SP_INCENDIO: return "INCENDIO";
    case proto::SP_EPISKEY: return "EPISKEY";
    default: return "";
  }
}
}  // namespace

void begin(uint8_t rotation) {
  g_ok = display::begin(rotation);
  leds::begin();
  leds::set_base(leds::Base::Boot);
}

void boot_line(const char *text) { display::boot_line(text); }
bool healthy() { return g_ok; }

void link_changed() {
  g_cue_text[0] = 0;
  g_cue_until = 0;
  leds::clear_cue();
  leds::set_shield(false);
  g_next_screen = millis();
  g_redraw = true;
}

void play_cue(const proto::Cue &c, uint8_t phase) {
  const uint32_t now = millis();
  g_cue_until = now + c.duration_ms;
  g_cue_color = 0xFFFF;
  switch (c.effect) {
    case proto::FX_ACCEPTED_CAST:
      snprintf(g_cue_text, sizeof(g_cue_text), "%s!", spell_name(c.spell));
      switch (c.spell) {
        case proto::SP_PROTEGO: g_cue_color = 0x07FF; break;
        case proto::SP_EXPELLIARMUS: g_cue_color = 0xFD20; break;
        case proto::SP_INCENDIO: g_cue_color = 0xF4A9; break;
        case proto::SP_EPISKEY: g_cue_color = 0x6F15; break;
        default: g_cue_color = 0xF80A; break;
      }
      break;
    case proto::FX_BLOCKED:
      snprintf(g_cue_text, sizeof(g_cue_text), "BLOCKED");
      g_cue_color = 0x07FF;
      break;
    case proto::FX_DAMAGE:
      snprintf(g_cue_text, sizeof(g_cue_text), "HIT!");
      g_cue_color = 0xF800;
      break;
    case proto::FX_RESULT:
      snprintf(g_cue_text, sizeof(g_cue_text), "%s", phase == proto::PH_WON ? "YOU WIN" : phase == proto::PH_LOST ? "YOU LOSE" : "DRAW");
      g_cue_color = phase == proto::PH_WON ? 0x07E8 : phase == proto::PH_LOST ? 0xF800 : 0xFFFF;
      break;
  }
  leds::cue(c.effect, c.spell, c.duration_ms, phase);
}

void tick(const proto::DisplayState &st, bool stale, uint32_t now_ms, bool connected, bool streaming) {
  const wand::Stats &w = wand::stats();
  leds::set_base(!w.sensor_ok ? leds::Base::Error : connected ? leds::Base::Connected : leds::Base::Advertising);
  leds::set_activity(w.activity);
  leds::set_shield(st.valid && (st.status & proto::ST_SHIELD));
  leds::set_stale(connected && stale);
  leds::tick();

  if ((int32_t)(now_ms - g_next_screen) < 0) return;
  g_next_screen = now_ms + SCREEN_REFRESH_MS;
  if ((int32_t)(now_ms - g_cue_until) >= 0) g_cue_text[0] = 0;
  if (g_redraw) {
    g_redraw = false;
    display::force_redraw();
  }

  display::View v;
  v.id = ble::name() + 5;
  v.link = streaming ? "streaming" : connected ? "connected" : "advertising";
  v.sensor_ok = w.sensor_ok;
  v.state_valid = st.valid;
  v.stale = stale;
  v.phase = st.phase;
  v.hp = st.hp;
  v.status = st.status;
  v.cue = g_cue_text;
  v.cue_color = g_cue_color;
  v.activity = w.activity;
  display::draw(v);
}
}  // namespace present
