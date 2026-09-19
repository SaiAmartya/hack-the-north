#include "leds.h"
#include "config.h"
#include "pins.h"
#include "proto.h"
#include <Adafruit_NeoPixel.h>
#include <math.h>

namespace leds {
namespace {
Adafruit_NeoPixel strip(LED_COUNT, PIN_LED_DIN, NEO_GRB + NEO_KHZ800);
Base g_base = Base::Boot;
float g_activity = 0;
bool g_shield = false, g_stale = false, g_enabled = true;
uint32_t g_next = 0, g_cue_until = 0, g_cue_start = 0;
uint8_t g_cue_effect = 0, g_cue_spell = 0, g_cue_phase = 0;
uint16_t g_phase = 0;

uint32_t rgb(uint8_t r, uint8_t g, uint8_t b, float k = 1.0f) {
  if (k < 0) k = 0;
  if (k > 1) k = 1;
  return strip.Color((uint8_t)(r * k), (uint8_t)(g * k), (uint8_t)(b * k));
}
void fill(uint32_t c) {
  for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, c);
}
uint32_t spell_color(uint8_t spell, float k) {
  switch (spell) {
    case proto::SP_STUPEFY: return rgb(255, 20, 40, k);      // crimson bolt
    case proto::SP_PROTEGO: return rgb(0, 200, 255, k);      // cyan shield
    case proto::SP_EXPELLIARMUS: return rgb(255, 120, 0, k); // red-gold ribbon
    default: return rgb(255, 255, 255, k);
  }
}
}  // namespace

void begin() {
  strip.begin();
  strip.setBrightness(LED_BRIGHTNESS);
  strip.clear();
  strip.show();
}
void set_base(Base b) { g_base = b; }
void set_activity(float level) { g_activity = level; }
void set_shield(bool on) { g_shield = on; }
void set_stale(bool on) { g_stale = on; }
void set_enabled(bool on) {
  g_enabled = on;
  if (!on) {
    strip.clear();
    strip.show();
  }
}

void cue(uint8_t effect, uint8_t spell, uint16_t duration_ms, uint8_t phase) {
  g_cue_effect = effect;
  g_cue_spell = spell;
  g_cue_phase = phase;
  g_cue_start = millis();
  g_cue_until = g_cue_start + duration_ms;
}

void tick() {
  const uint32_t now = millis();
  if (now < g_next) return;
  g_next = now + LED_FRAME_MS;
  g_phase++;
  if (!g_enabled) return;

  if (g_cue_effect && now < g_cue_until) {
    const float t = (float)(now - g_cue_start) / (float)(g_cue_until - g_cue_start + 1);
    const float k = 1.0f - t;  // fade out
    switch (g_cue_effect) {
      case proto::FX_ACCEPTED_CAST: {
        const int head = (int)(t * LED_COUNT * 2) % LED_COUNT;  // sweeps around the ring
        for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, i == head ? spell_color(g_cue_spell, 1) : spell_color(g_cue_spell, 0.25f * k));
        break;
      }
      case proto::FX_BLOCKED:
        fill(rgb(0, 200, 255, 0.4f + 0.6f * fabsf(sinf(t * 6.28f))));  // ripple
        break;
      case proto::FX_DAMAGE:
        fill(rgb(255, 0, 0, ((g_phase % 4) < 2) ? 1.0f : 0.15f));   // hard red strobe
        break;
      case proto::FX_RESULT:
        if (g_cue_phase == proto::PH_WON) {
          const int head = (g_phase / 2) % LED_COUNT;
          for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, i == head ? rgb(255, 215, 0) : rgb(0, 180, 60, 0.5f));
        } else if (g_cue_phase == proto::PH_LOST) {
          fill(rgb(160, 0, 0, 0.5f + 0.5f * k));
        } else {
          fill(rgb(200, 200, 200, 0.5f));
        }
        break;
    }
    strip.show();
    return;
  }
  g_cue_effect = 0;

  switch (g_base) {
    case Base::Boot: {
      const int head = (g_phase / 3) % LED_COUNT;
      for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, i == head ? rgb(120, 120, 120) : 0);
      break;
    }
    case Base::Error:
      fill((g_phase % 20) < 10 ? rgb(160, 0, 0) : 0);
      break;
    case Base::Advertising: {
      const float breath = 0.5f + 0.5f * sinf(g_phase * 0.06f);
      fill(rgb(40, 60, 255, 0.05f + 0.25f * breath));   // slow blue breath: looking for a laptop
      break;
    }
    case Base::Connected: {
      if (g_shield) {
        fill(rgb(0, 200, 255, 0.35f + 0.65f * g_activity));
      } else if (g_stale) {
        fill(rgb(200, 110, 0, 0.12f + 0.88f * g_activity));  // amber: game state missing
      } else {
        const float breath = 0.55f + 0.45f * sinf(g_phase * 0.08f);
        fill(rgb(120, 40, 255, 0.10f * breath + 0.90f * g_activity));  // violet glow that brightens with movement
      }
      break;
    }
  }
  strip.show();
}
}  // namespace leds
