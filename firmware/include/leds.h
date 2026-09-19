#pragma once
#include <stdint.h>
namespace leds {
enum class Base : uint8_t { Boot, Advertising, Connected, Error };
void begin();
void set_base(Base b);
void set_activity(float level);       // 0..1 brightens the glow
void set_shield(bool on);             // steady cyan while the referee says the shield is up
void set_stale(bool on);              // amber tint while host state is stale/expired
// One-shot cue: effect/spell per contract section 5, phase for result colouring.
void cue(uint8_t effect, uint8_t spell, uint16_t duration_ms, uint8_t phase);
void clear_cue();
void set_enabled(bool on);
void tick();
}  // namespace leds
