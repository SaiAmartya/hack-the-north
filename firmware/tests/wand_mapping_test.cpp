#include "wand.h"

int main() {
  const int16_t chip[3] = {100, -200, 300};
  const int8_t maps[][3] = {{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}};
  for (const auto &map : maps) {
    for (int bits = 0; bits < 8; bits++) {
      const int8_t signs[3] = {static_cast<int8_t>(bits & 1 ? -1 : 1), static_cast<int8_t>(bits & 2 ? -1 : 1), static_cast<int8_t>(bits & 4 ? -1 : 1)};
      const wand::MappedSample mapped = wand::map_and_clip(chip, map, signs, 8000);
      if (mapped.x != signs[0] * chip[map[0]] || mapped.y != signs[1] * chip[map[1]] || mapped.z != signs[2] * chip[map[2]] || mapped.saturated) return 1;
    }
  }

  const int16_t rail[3] = {9000, -9000, 10};
  const int8_t identity[3] = {0, 1, 2};
  const int8_t positive[3] = {1, 1, 1};
  const wand::MappedSample clipped = wand::map_and_clip(rail, identity, positive, 8000);
  return clipped.x == 8000 && clipped.y == -8000 && clipped.z == 10 && clipped.saturated ? 0 : 1;
}
