#include "config.h"
#include "wand.h"
#include <assert.h>
#include <stdio.h>

// Contract section 4: the discontinuity bit marks the first emitted sample after a gap, a local
// drop, a refused notification or a stream (re)start; the sensor's overwrite flag is not evidence.
int main() {
  using wand::classify_fresh_sample;
  // 1.5 periods: a single lost native sample (two periods) is always outside the contiguous band.
  static_assert(wand::max_gap_ms(20) == 30 && wand::max_gap_ms(10) == 15, "gap limit is 1.5 output periods");
  static_assert(wand::max_gap_ms(20) < 2 * 20 && wand::max_gap_ms(10) < 2 * 10, "one lost sample must be detectable");
  const uint32_t gap = wand::max_gap_ms(20), age = SAMPLE_MAX_AGE_MS;
  wand::Continuity c = classify_fresh_sample(20, 1, false, false, gap, age);
  assert(!c.discontinuity && !c.drop);
  c = classify_fresh_sample(gap, age, false, false, gap, age);           // inclusive bounds are contiguous
  assert(!c.discontinuity && !c.drop);
  c = classify_fresh_sample(gap + 1, 1, false, false, gap, age);         // missed sample -> discontinuity, still delivered
  assert(c.discontinuity && !c.drop);
  c = classify_fresh_sample(20, age + 1, false, false, gap, age);        // too old to be fresh -> dropped
  assert(c.discontinuity && c.drop);
  c = classify_fresh_sample(20, 1, true, false, gap, age);               // previous sample lost -> this one marked
  assert(c.discontinuity && !c.drop);
  c = classify_fresh_sample(20, 1, false, true, gap, age);               // OPEN/subscribe restarted the stream
  assert(c.discontinuity && !c.drop);
  c = classify_fresh_sample(0, 0, false, false, gap, age);               // first read after boot has no gap input
  assert(!c.discontinuity && !c.drop);
  puts("PASS: continuity policy");
  return 0;
}
