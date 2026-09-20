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
// Cooldown rings: started by an accepted-cast cue during the duel, cleared with the link/epoch.
// The durations mirror the referee rules (apps/host/phantom_host/duel_engine.py SPELL_RULES); the
// referee stays authoritative and the browser tells the player when a cast was refused.
const uint16_t kCooldownMs[display::SPELL_SLOTS] = {0, 2000, 3000, 6000, 6000, 9000, 10000, 15000};
const uint16_t kCastRecoveryMs = 500;  // global recovery after any accepted cast
uint32_t g_cd_until[display::SPELL_SLOTS] = {0};
uint32_t g_recover_until = 0;
bool g_cd_active = false;

void clear_cooldowns() {
  for (uint32_t &u : g_cd_until) u = 0;
  g_recover_until = 0;
  g_cd_active = false;
}

const char *spell_name(uint8_t s) {
  switch (s) {
    case proto::SP_STUPEFY: return "STUPEFY";
    case proto::SP_PROTEGO: return "PROTEGO";
    case proto::SP_EXPELLIARMUS: return "EXPELLIARMUS";
    case proto::SP_INCENDIO: return "INCENDIO";
    case proto::SP_SECTUMSEMPRA: return "SECTUMSEMPRA";
    case proto::SP_PETRIFICUS_TOTALUS: return "PETRIFICUS";
    case proto::SP_EXPECTO_PATRONUM: return "PATRONUM";
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
  clear_cooldowns();
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
      g_cue_color = display::spell_color(c.spell);
      // Practice casts never reach the referee, so only a duel cast starts a recharge ring.
      if (phase == proto::PH_PLAYING && c.spell > 0 && c.spell < display::SPELL_SLOTS) {
        g_cd_until[c.spell] = now + kCooldownMs[c.spell];
        g_recover_until = now + kCastRecoveryMs;
        g_cd_active = true;
      }
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

  if ((int32_t)(now_ms - g_next_screen) < 0) return;
  g_next_screen = now_ms + SCREEN_REFRESH_MS;
  if ((int32_t)(now_ms - g_cue_until) >= 0) g_cue_text[0] = 0;
  if (g_cd_active && (!st.valid || st.phase != proto::PH_PLAYING)) clear_cooldowns();
  if (g_redraw) {
    g_redraw = false;
    display::force_redraw();
  }

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
  for (int i = 0; i < display::SPELL_SLOTS; i++) {
    const int32_t left = (int32_t)(g_cd_until[i] - now_ms);
    if (!g_cd_until[i] || left <= 0 || kCooldownMs[i] == 0) {
      v.cd_frac[i] = 0;
      v.cd_secs[i] = 0;
      continue;
    }
    uint32_t frac = ((uint32_t)left * 255u + kCooldownMs[i] - 1) / kCooldownMs[i];
    v.cd_frac[i] = (uint8_t)(frac < 1 ? 1 : frac > 255 ? 255 : frac);
    const uint32_t secs = ((uint32_t)left + 999u) / 1000u;
    v.cd_secs[i] = (uint8_t)(secs > 255 ? 255 : secs);
  }
  v.recovering = g_recover_until != 0 && (int32_t)(now_ms - g_recover_until) < 0;
  display::draw(v);
}
}  // namespace present
