#pragma once
#include <stdint.h>
#include "proto.h"

// Turns the session's state and cues into what the player sees (contract sections 5 and 6).
namespace present {
void begin(uint8_t rotation);
void boot_line(const char *text);
void link_changed();                                       // connect/disconnect: neutral screen
void play_cue(const proto::Cue &c, uint8_t phase);        // one-shot effect
bool healthy();                                            // presentation health bit
void tick(const proto::Session &s, uint32_t now_ms, bool connected, bool streaming, uint32_t rate_hz, uint32_t dropped);
}  // namespace present
