#include "display.h"
#include "pins.h"
#include "proto.h"
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

// Landscape 320x240 HUD (rotation 1/3):
//   y   2  WAND 46BA  streaming                 (size 2)
//   y  22  DUEL / PRACTICE / VICTORY ...         (size 3)
//   y  52  [heart] 100  SHIELD                    (size 2) + HP bar at y 70
//   y  84  seven cooldown rings, one per spell; the ring shows its button while ready and the
//          seconds left while recharging, the inner disc drains clockwise like a clock
//   y 126  three-letter spell labels under the rings (size 1)
//   y 140  cue text: STUPEFY! / BLOCKED / HIT ...  (size 3)
//   y 170  movement bar
//   y 186  hint line                               (size 1)
//   y 226  diagnostics footer                      (size 1)
namespace display {
namespace {
Adafruit_ST7789 tft(&SPI, PIN_DISP_CS, PIN_DISP_DC, PIN_DISP_RST);
const uint16_t BG = 0x0000, FG = 0xFFFF, DIM = 0x8410, PURPLE = 0xA11F, CYAN = 0x07FF, AMBER = 0xFD20, GREEN = 0x07E8, RED = 0xF800, GREY = 0x2104,
               HEART = 0xF8A3, HP_MID = 0xFDE0;
bool g_ok = false;
int g_boot_y = 4;
uint8_t g_rot = 1;

// Text fields are rendered into a RAM canvas and pushed with one bulk SPI transfer. Printing
// straight to the panel costs one address-window transaction per pixel (about 60 ms for a
// size-1 footer line, more for size 3), which stalled the main loop and everything it services.
constexpr int16_t FIELD_W = 300, FIELD_H_MAX = 24;  // widest field, tallest text (size 3)
GFXcanvas16 *g_canvas = nullptr;

// Cooldown rings are rendered the same way into a small square canvas.
constexpr int16_t RING_W = 40, RING_R_OUT = 18, RING_R_IN = 15, RING_Y = 84, RING_PITCH = 44, RING_X0 = 28;
GFXcanvas16 *g_ring = nullptr;
uint8_t g_angle[RING_W * RING_W];  // clockwise angle from 12 o'clock, 0..255, per ring pixel

struct Field {
  int16_t x, y;
  uint8_t size;
  uint16_t color;
  int16_t w;   // must equal FIELD_W: the canvas row stride is FIELD_W
  char last[44];
  uint16_t last_color;
  void draw(const char *text, uint16_t c = 0xFFFF, bool use_color = false) {
    const uint16_t col = use_color ? c : color;
    if (strcmp(text, last) == 0 && col == last_color) return;
    strncpy(last, text, sizeof(last) - 1);
    last[sizeof(last) - 1] = 0;
    last_color = col;
    const int16_t h = 8 * size;
    if (g_canvas && w == FIELD_W && h <= FIELD_H_MAX) {
      g_canvas->fillScreen(BG);
      g_canvas->setTextWrap(false);
      g_canvas->setTextSize(size);
      g_canvas->setTextColor(col);
      g_canvas->setCursor(0, 0);
      g_canvas->print(text);
      tft.drawRGBBitmap(x, y, g_canvas->getBuffer(), w, h);
      return;
    }
    tft.fillRect(x, y, w, h, BG);
    tft.setTextSize(size);
    tft.setTextColor(col, BG);
    tft.setCursor(x, y);
    tft.print(text);
  }
  void reset() {
    last[0] = 0;
    last_color = 0;
  }
};

Field f_title{10, 2, 2, DIM, 300, "", 0};
Field f_phase{10, 22, 3, FG, 300, "", 0};
Field f_hp{32, 52, 2, FG, 300, "", 0};
Field f_cue{10, 140, 3, CYAN, 300, "", 0};
Field f_hint{10, 186, 1, DIM, 300, "", 0};
Field f_foot{10, 226, 1, DIM, 300, "", 0};
int g_last_bar = -1, g_last_hp = -1;
bool g_last_hp_shown = false, g_labels_drawn = false;
uint32_t g_ring_key[SPELL_SLOTS];  // last drawn (frac, secs, ready, dim) per ring
enum class Screen { None, Boot, Main } g_screen = Screen::None;

const char *const kSpellLabel[SPELL_SLOTS] = {"", "STU", "PRO", "EXP", "INC", "SEC", "PET", "PAT"};
// Badge buttons that cast each spell (main.cpp sends the matching STATUS button event).
const char *const kSpellButton[SPELL_SLOTS] = {"", "A", "B", ">", "^", "<", "v", "H"};

void clear_to(Screen s) {
  if (g_screen == s) return;
  g_screen = s;
  tft.fillScreen(BG);
  Field *all[] = {&f_title, &f_phase, &f_hp, &f_cue, &f_hint, &f_foot};
  for (Field *f : all) f->reset();
  g_last_bar = -1;
  g_last_hp = -1;
  g_last_hp_shown = false;
  g_labels_drawn = false;
  for (uint32_t &k : g_ring_key) k = 0xFFFFFFFF;
}

const char *phase_text(uint8_t p) {
  switch (p) {
    case proto::PH_PRACTICE: return "PRACTICE";
    case proto::PH_COUNTDOWN: return "GET READY";
    case proto::PH_PLAYING: return "DUEL";
    case proto::PH_WON: return "VICTORY";
    case proto::PH_LOST: return "DEFEATED";
    case proto::PH_DRAW: return "DRAW";
    case proto::PH_ABORTED: return "ROUND ABORTED";
    default: return "CONNECTED";
  }
}
uint16_t phase_color(uint8_t p) {
  switch (p) {
    case proto::PH_WON: return GREEN;
    case proto::PH_LOST: return RED;
    case proto::PH_ABORTED: return AMBER;
    case proto::PH_PLAYING: return FG;
    default: return CYAN;
  }
}

// Scale an RGB565 colour by k (0..1).
uint16_t scale565(uint16_t c, float k) {
  if (k < 0) k = 0;
  if (k > 1) k = 1;
  const uint16_t r = (uint16_t)(((c >> 11) & 0x1F) * k), g = (uint16_t)(((c >> 5) & 0x3F) * k), b = (uint16_t)((c & 0x1F) * k);
  return (uint16_t)((r << 11) | (g << 5) | b);
}

void draw_heart(int16_t x, int16_t y, uint16_t c) {
  tft.fillCircle(x + 4, y + 4, 4, c);
  tft.fillCircle(x + 11, y + 4, 4, c);
  tft.fillTriangle(x, y + 6, x + 15, y + 6, x + 7, y + 14, c);
  tft.fillTriangle(x, y + 6, x + 15, y + 6, x + 8, y + 14, c);
}

// One cooldown ring. `frac` 0..255 is the remaining fraction (0 = ready); the inner disc shows the
// remaining wedge clockwise from 12 o'clock, so it drains like a clock as the spell recharges.
void draw_ring(int slot, uint8_t frac, uint8_t secs, bool dim) {
  const bool ready = frac == 0;
  const uint32_t key = ((uint32_t)(frac >> 1) << 16) | ((uint32_t)secs << 8) | (ready ? 2u : 0u) | (dim ? 1u : 0u);
  if (g_ring_key[slot] == key) return;
  g_ring_key[slot] = key;
  const int16_t cx = RING_X0 + (int16_t)(slot - 1) * RING_PITCH;
  const uint16_t color = spell_color((uint8_t)slot);
  const uint16_t ring = ready && !dim ? color : scale565(color, dim ? 0.30f : 0.45f);
  const uint16_t disc = ready ? scale565(color, dim ? 0.12f : 0.28f) : GREY;
  if (!g_ring) {
    // No RAM for the canvas: draw a plain circle and the label directly (slow path, rare).
    tft.fillCircle(cx, RING_Y + RING_W / 2, RING_R_OUT, BG);
    tft.drawCircle(cx, RING_Y + RING_W / 2, RING_R_OUT, ring);
    return;
  }
  g_ring->fillScreen(BG);
  uint16_t *px = g_ring->getBuffer();
  const float c = (RING_W - 1) * 0.5f;
  for (int y = 0; y < RING_W; y++) {
    const float dy = (float)y - c;
    for (int x = 0; x < RING_W; x++) {
      const float dx = (float)x - c;
      const float d2 = dx * dx + dy * dy;
      if (d2 > (float)((RING_R_OUT + 0.5f) * (RING_R_OUT + 0.5f))) continue;
      uint16_t v;
      if (d2 >= (float)((RING_R_IN + 0.5f) * (RING_R_IN + 0.5f))) v = ring;
      else if (ready) v = disc;
      else v = g_angle[y * RING_W + x] < frac ? disc : BG;
      px[y * RING_W + x] = v;
    }
  }
  // Centre glyph: the button while ready, the seconds left while recharging.
  char t[4];
  if (ready) snprintf(t, sizeof(t), "%s", kSpellButton[slot]);
  else if (secs >= 1) snprintf(t, sizeof(t), "%u", (unsigned)(secs > 99 ? 99 : secs));
  else t[0] = 0;
  const int len = (int)strlen(t);
  if (len) {
    g_ring->setTextWrap(false);
    g_ring->setTextSize(2);
    g_ring->setTextColor(ready ? (dim ? DIM : FG) : FG);
    g_ring->setCursor((RING_W - len * 12) / 2 + 1, (RING_W - 16) / 2 + 1);
    g_ring->print(t);
  }
  tft.drawRGBBitmap(cx - RING_W / 2, RING_Y, px, RING_W, RING_W);
}

void draw_labels() {
  if (g_labels_drawn) return;
  g_labels_drawn = true;
  tft.setTextSize(1);
  tft.setTextWrap(false);
  for (int slot = 1; slot < SPELL_SLOTS; slot++) {
    const int16_t cx = RING_X0 + (int16_t)(slot - 1) * RING_PITCH;
    tft.setTextColor(scale565(spell_color((uint8_t)slot), 0.8f), BG);
    tft.setCursor(cx - 9, RING_Y + RING_W + 2);
    tft.print(kSpellLabel[slot]);
  }
}
}  // namespace

uint16_t spell_color(uint8_t spell) {
  switch (spell) {
    case proto::SP_STUPEFY: return 0xF80A;             // crimson bolt
    case proto::SP_PROTEGO: return 0x07FF;             // cyan shield
    case proto::SP_EXPELLIARMUS: return 0xFD20;        // red-gold ribbon
    case proto::SP_INCENDIO: return 0xFBC3;            // fire orange
    case proto::SP_SECTUMSEMPRA: return 0xE73F;        // steel white
    case proto::SP_PETRIFICUS_TOTALUS: return 0x9DBF;  // pale binding blue
    case proto::SP_EXPECTO_PATRONUM: return 0xDFBF;    // silver-blue patronus
    default: return FG;
  }
}

const char *spell_button(uint8_t spell) { return spell < SPELL_SLOTS ? kSpellButton[spell] : ""; }

bool begin(uint8_t rotation) {
  SPI.begin(PIN_DISP_SCLK, -1, PIN_DISP_MOSI, PIN_DISP_CS);
  tft.init(240, 320);
  tft.setSPISpeed(40000000);
  g_rot = rotation & 3;
  tft.setRotation(g_rot);
  tft.fillScreen(BG);
  if (!g_canvas) {
    g_canvas = new GFXcanvas16(FIELD_W, FIELD_H_MAX);  // 14.4 KB; falls back to direct printing if this fails
    if (g_canvas && !g_canvas->getBuffer()) {
      delete g_canvas;
      g_canvas = nullptr;
    }
  }
  if (!g_ring) {
    g_ring = new GFXcanvas16(RING_W, RING_W);  // 3.2 KB
    if (g_ring && !g_ring->getBuffer()) {
      delete g_ring;
      g_ring = nullptr;
    }
  }
  const float c = (RING_W - 1) * 0.5f;
  for (int y = 0; y < RING_W; y++)
    for (int x = 0; x < RING_W; x++) {
      float a = atan2f((float)x - c, -((float)y - c));  // 0 at 12 o'clock, clockwise positive
      if (a < 0) a += 6.2831853f;
      int v = (int)(a * (256.0f / 6.2831853f));
      g_angle[y * RING_W + x] = (uint8_t)(v > 255 ? 255 : v);
    }
  g_ok = true;
  g_screen = Screen::Boot;
  g_boot_y = 4;
  return true;
}

void set_rotation(uint8_t rotation) {
  g_rot = rotation & 3;
  tft.setRotation(g_rot);
  force_redraw();
}

void force_redraw() {
  const Screen s = g_screen;
  g_screen = Screen::None;
  clear_to(s == Screen::None ? Screen::Boot : s);
}

void boot_line(const char *text) {
  if (!g_ok) return;
  clear_to(Screen::Boot);
  if (g_boot_y > 230) {
    tft.fillScreen(BG);
    g_boot_y = 4;
  }
  tft.setTextSize(1);
  tft.setTextColor(FG, BG);
  tft.setCursor(4, g_boot_y);
  tft.print(text);
  g_boot_y += 10;
}

void draw(const View &v) {
  if (!g_ok) return;
  clear_to(Screen::Main);
  char b[44];
  snprintf(b, sizeof(b), "WAND %s  %s%s", v.id, v.link, v.sensor_ok ? "" : "  SENSOR FAULT");
  f_title.draw(b, v.sensor_ok ? DIM : RED, true);

  if (v.state_valid) {
    f_phase.draw(phase_text(v.phase), phase_color(v.phase), true);
  } else {
    f_phase.draw(v.stale && strcmp(v.link, "advertising") != 0 ? "WAITING FOR GAME" : "SAY THE SPELL, MOVE", DIM, true);
  }

  const bool show_hp = v.state_valid && (v.phase == proto::PH_PLAYING || v.phase >= proto::PH_WON);
  if (show_hp) {
    const bool shield = (v.status & proto::ST_SHIELD) != 0, locked = (v.status & proto::ST_LOCKED) != 0;
    snprintf(b, sizeof(b), "%3u%s%s", v.hp, shield ? "  SHIELD" : "", locked ? "  DISARMED" : "");
    f_hp.draw(b, shield ? CYAN : locked ? AMBER : FG, true);
    const int w = (int)v.hp * 3;  // 0..300
    if (w != g_last_hp || !g_last_hp_shown) {
      if (!g_last_hp_shown) draw_heart(10, 52, HEART);
      tft.fillRect(10, 70, w, 6, v.hp > 50 ? GREEN : v.hp > 25 ? HP_MID : RED);
      tft.fillRect(10 + w, 70, 300 - w, 6, GREY);
      g_last_hp = w;
      g_last_hp_shown = true;
    }
  } else {
    f_hp.draw("");
    if (g_last_hp_shown) {
      tft.fillRect(10, 52, 300, 24, BG);
      g_last_hp_shown = false;
    }
  }

  for (int slot = 1; slot < SPELL_SLOTS; slot++) draw_ring(slot, v.cd_frac[slot], v.cd_secs[slot], v.recovering);
  draw_labels();

  f_cue.draw(v.cue, v.cue_color, true);
  f_hint.draw(v.state_valid ? "Say the spell + move, or press its button" : "Buttons cast too: A B ^ < v > H (see rings)");

  int bar = (int)(v.activity * 300);
  if (bar < 0) bar = 0;
  if (bar > 300) bar = 300;
  if (bar != g_last_bar) {
    tft.fillRect(10, 170, bar, 10, PURPLE);
    tft.fillRect(10 + bar, 170, 300 - bar, 10, GREY);
    g_last_bar = bar;
  }
  f_foot.draw(v.foot);
}
}  // namespace display
