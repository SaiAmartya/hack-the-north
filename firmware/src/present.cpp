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

const char *spell_name(uint8_t s) {
  switch (s) {
    case proto::SP_STUPEFY: return "STUPEFY";
    case proto::SP_PROTEGO: return "PROTEGO";
    case proto::SP_EXPELLIARMUS: return "EXPELLIARMUS";
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
  display::force_redraw();
}

void play_cue(const proto::Cue &c, uint8_t phase) {
  const uint32_t now = millis();
  g_cue_until = now + c.duration_ms;
  g_cue_color = 0xFFFF;
  switch (c.effect) {
    case proto::FX_ACCEPTED_CAST:
      snprintf(g_cue_text, sizeof(g_cue_text), "%s!", spell_name(c.spell));
      g_cue_color = c.spell == proto::SP_PROTEGO ? 0x07FF : c.spell == proto::SP_EXPELLIARMUS ? 0xFD20 : 0xF80A;
      break;
    case proto::FX_BLOCKED:
      snprintf(g_cue_text, sizeof(g_cue_text), "BLOCKED");
      g_cue_color = 0x07FF;
      break;
    case proto::FX_DAMAGE:
      snprintf(g_cue_text, sizeof(g_cue_text), "HIT%s%s", c.spell ? " by " : "", spell_name(c.spell));
      g_cue_color = 0xF800;
      break;
    case proto::FX_RESULT:
      snprintf(g_cue_text, sizeof(g_cue_text), "%s", phase == proto::PH_WON ? "YOU WIN" : phase == proto::PH_LOST ? "YOU LOSE" : "DRAW");
      g_cue_color = phase == proto::PH_WON ? 0x07E8 : phase == proto::PH_LOST ? 0xF800 : 0xFFFF;
      break;
  }
  leds::cue(c.effect, c.spell, c.duration_ms, phase);
}

void tick(const proto::DisplayState &st, bool stale, uint32_t now_ms, bool connected, bool streaming, uint32_t rate_hz, uint32_t dropped) {
  const wand::Stats &w = wand::stats();
  leds::set_base(!w.sensor_ok ? leds::Base::Error : connected ? leds::Base::Connected : leds::Base::Advertising);
  leds::set_activity(w.activity);
  leds::set_shield(st.valid && (st.status & proto::ST_SHIELD));
  leds::set_stale(connected && stale);
  leds::tick();

  if (now_ms < g_next_screen) return;
  g_next_screen = now_ms + SCREEN_REFRESH_MS;
  if ((int32_t)(now_ms - g_cue_until) > 0) g_cue_text[0] = 0;

  char foot[64];
  snprintf(foot, sizeof(foot), "fw %s  %s  %lu Hz  drop %lu  %s", FW_VERSION_STR, ble::name(), (unsigned long)rate_hz, (unsigned long)dropped,
           w.saturated ? "SAT" : "");
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
  v.x = w.x;
  v.y = w.y;
  v.z = w.z;
  v.foot = foot;
  display::draw(v);
}
}  // namespace present
