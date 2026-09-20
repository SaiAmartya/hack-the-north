#include "display.h"
#include "pins.h"
#include "proto.h"
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
#include <stdio.h>
#include <string.h>

namespace display {
namespace {
Adafruit_ST7789 tft(&SPI, PIN_DISP_CS, PIN_DISP_DC, PIN_DISP_RST);
const uint16_t BG = 0x0000, FG = 0xFFFF, DIM = 0x8410, PURPLE = 0xA11F, CYAN = 0x07FF, AMBER = 0xFD20, GREEN = 0x07E8, RED = 0xF800, GREY = 0x2104;
bool g_ok = false;
int g_boot_y = 4;
uint8_t g_rot = 1;

// Text fields are rendered into a RAM canvas and pushed with one bulk SPI transfer. Printing
// straight to the panel costs one address-window transaction per pixel (about 60 ms for a
// size-1 footer line, more for size 3), which stalled the main loop and everything it services.
constexpr int16_t FIELD_W = 300, FIELD_H_MAX = 24;  // widest field, tallest text (size 3)
GFXcanvas16 *g_canvas = nullptr;

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

Field f_title{10, 8, 3, PURPLE, 300, "", 0};
Field f_link{10, 40, 2, DIM, 300, "", 0};
Field f_phase{10, 68, 3, FG, 300, "", 0};
Field f_hp{10, 100, 2, FG, 300, "", 0};
Field f_cue{10, 130, 3, CYAN, 300, "", 0};
Field f_hint{10, 164, 2, DIM, 300, "", 0};
Field f_foot{10, 226, 1, DIM, 300, "", 0};
int g_last_bar = -1, g_last_hp = -1;
bool g_last_hp_shown = false;
enum class Screen { None, Boot, Main } g_screen = Screen::None;

void clear_to(Screen s) {
  if (g_screen == s) return;
  g_screen = s;
  tft.fillScreen(BG);
  Field *all[] = {&f_title, &f_link, &f_phase, &f_hp, &f_cue, &f_hint, &f_foot};
  for (Field *f : all) f->reset();
  g_last_bar = -1;
  g_last_hp = -1;
  g_last_hp_shown = false;
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
}  // namespace

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
  snprintf(b, sizeof(b), "WAND %s", v.id);
  f_title.draw(b);
  snprintf(b, sizeof(b), "%s%s", v.link, v.sensor_ok ? "" : "  SENSOR FAULT");
  f_link.draw(b, v.sensor_ok ? DIM : RED, true);

  if (v.state_valid) {
    f_phase.draw(phase_text(v.phase), phase_color(v.phase), true);
  } else {
    f_phase.draw(v.stale && strcmp(v.link, "advertising") != 0 ? "WAITING FOR GAME" : "SAY THE SPELL, MOVE", DIM, true);
  }

  const bool show_hp = v.state_valid && (v.phase == proto::PH_PLAYING || v.phase >= proto::PH_WON);
  if (show_hp) {
    snprintf(b, sizeof(b), "HP %3u%s%s", v.hp, (v.status & proto::ST_SHIELD) ? "  SHIELD" : "", (v.status & proto::ST_LOCKED) ? "  DISARMED" : "");
    f_hp.draw(b, (v.status & proto::ST_SHIELD) ? CYAN : FG, true);
    const int w = (int)v.hp * 3;  // 0..300
    if (w != g_last_hp || !g_last_hp_shown) {
      tft.fillRect(10, 118, w, 6, v.hp > 30 ? GREEN : RED);
      tft.fillRect(10 + w, 118, 300 - w, 6, GREY);
      g_last_hp = w;
      g_last_hp_shown = true;
    }
  } else {
    f_hp.draw("");
    if (g_last_hp_shown) {
      tft.fillRect(10, 118, 300, 6, BG);
      g_last_hp_shown = false;
    }
  }

  f_cue.draw(v.cue, v.cue_color, true);
  f_hint.draw(v.state_valid ? "Say the spell, make its move" : "Stupefy jab  Protego raise  +5 more");

  int bar = (int)(v.activity * 300);
  if (bar < 0) bar = 0;
  if (bar > 300) bar = 300;
  if (bar != g_last_bar) {
    tft.fillRect(10, 196, bar, 12, PURPLE);
    tft.fillRect(10 + bar, 196, 300 - bar, 12, GREY);
    g_last_bar = bar;
  }
  f_foot.draw(v.foot);
}
}  // namespace display
