#include "buttons.h"
#include "pins.h"
#include <Arduino.h>

namespace btn {
namespace {
// Bit inside the byte clocked out MSB-first (verified on a real badge by the drone-hacking project).
const uint8_t kBit[COUNT] = {1 /*UP*/, 4 /*DOWN*/, 3 /*LEFT*/, 2 /*RIGHT*/, 7 /*A*/, 6 /*B*/, 5 /*HOME*/, 0 /*SLIDE*/, 0xFF /*START=GPIO9*/};
uint8_t g_raw = 0;
bool g_stable[COUNT] = {false}, g_cand[COUNT] = {false}, g_pressed[COUNT] = {false};
uint32_t g_changed[COUNT] = {0};
const uint32_t kDebounceMs = 12;

uint8_t shift_in() {
  digitalWrite(PIN_SR_SHLD, LOW);
  delayMicroseconds(5);
  digitalWrite(PIN_SR_SHLD, HIGH);
  delayMicroseconds(5);
  uint8_t v = 0;
  for (int i = 0; i < 8; i++) {
    v = (uint8_t)((v << 1) | (digitalRead(PIN_SR_QH) ? 1 : 0));
    digitalWrite(PIN_SR_CLK, HIGH);
    delayMicroseconds(3);
    digitalWrite(PIN_SR_CLK, LOW);
    delayMicroseconds(3);
  }
  return v;
}
}  // namespace

void begin() {
  pinMode(PIN_SR_QH, INPUT);
  pinMode(PIN_SR_SHLD, OUTPUT);
  pinMode(PIN_SR_CLK, OUTPUT);
  digitalWrite(PIN_SR_SHLD, HIGH);
  digitalWrite(PIN_SR_CLK, LOW);
  pinMode(PIN_BOOT_BTN, INPUT_PULLUP);
}

void poll() {
  const uint32_t now = millis();
  g_raw = (uint8_t)~shift_in();  // switches pull to GND: invert so 1 = down
  for (int i = 0; i < COUNT; i++) {
    const bool sample = (i == START) ? (digitalRead(PIN_BOOT_BTN) == LOW) : ((g_raw >> kBit[i]) & 1) != 0;
    g_pressed[i] = false;
    if (sample != g_cand[i]) {
      g_cand[i] = sample;
      g_changed[i] = now;
    } else if (sample != g_stable[i] && now - g_changed[i] >= kDebounceMs) {
      g_stable[i] = sample;
      g_pressed[i] = sample;
    }
  }
}

bool down(Id b) { return g_stable[b]; }
bool pressed(Id b) { return g_pressed[b]; }
uint8_t raw() { return g_raw; }
}  // namespace btn
