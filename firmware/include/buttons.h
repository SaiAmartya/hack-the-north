#pragma once
#include <stdint.h>
// 74HC165 shift-register buttons. Since 0.2.3 A/B/arrows/HOME cast spells through STATUS kind 2
// (main.cpp); START recalibrates the activity baseline.
namespace btn {
enum Id : uint8_t { UP = 0, DOWN, LEFT, RIGHT, A, B, HOME, SLIDE, START, COUNT };
void begin();
void poll();
bool down(Id b);
bool pressed(Id b);   // edge since last poll
uint8_t raw();
}  // namespace btn
