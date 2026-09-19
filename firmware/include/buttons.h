#pragma once
#include <stdint.h>
// 74HC165 shift-register buttons. No gameplay is bound to them; they drive the debug screen only.
namespace btn {
enum Id : uint8_t { UP = 0, DOWN, LEFT, RIGHT, A, B, HOME, SLIDE, START, COUNT };
void begin();
void poll();
bool down(Id b);
bool pressed(Id b);   // edge since last poll
uint8_t raw();
}  // namespace btn
