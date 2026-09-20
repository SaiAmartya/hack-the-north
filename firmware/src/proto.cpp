#include "proto.h"
#include "config.h"
#include <stdio.h>
#include <string.h>

namespace proto {
namespace {
void put16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}
uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
int16_t geti16(const uint8_t *p) { return (int16_t)get16(p); }
// Wrap-safe "a is after b" for 32-bit millisecond clocks.
int32_t diff32(uint32_t a, uint32_t b) { return (int32_t)(a - b); }
}  // namespace

void encode_info(const Info &v, uint8_t out[REC]) {
  memset(out, 0, REC);
  out[0] = VERSION;
  out[1] = v.caps;
  out[2] = v.sample_hz;
  out[3] = v.range_g;
  memcpy(out + 4, v.device_id, 6);
  put32(out + 10, v.boot_id);
  out[14] = v.fw_major;
  out[15] = v.fw_minor;
  out[16] = v.fw_patch;
  out[17] = v.axis_convention;
}

void encode_motion(const Motion &v, uint8_t out[REC]) {
  memset(out, 0, REC);
  out[0] = VERSION;
  out[1] = v.flags;
  put16(out + 2, v.seq);
  put32(out + 4, v.capture_ms);
  put32(out + 8, v.boot_id);
  put16(out + 12, (uint16_t)v.ax);
  put16(out + 14, (uint16_t)v.ay);
  put16(out + 16, (uint16_t)v.az);
}

bool decode_motion(const uint8_t *in, size_t len, Motion &v) {
  if (len != REC || in[0] != VERSION) return false;
  if (in[1] & ~(MF_VALID | MF_SATURATED | MF_DISCONTINUITY)) return false;
  if (in[18] || in[19]) return false;
  v.flags = in[1];
  v.seq = get16(in + 2);
  v.capture_ms = get32(in + 4);
  v.boot_id = get32(in + 8);
  v.ax = geti16(in + 12);
  v.ay = geti16(in + 14);
  v.az = geti16(in + 16);
  const int16_t lim = RANGE_G * 1000;
  if (v.ax < -lim || v.ax > lim || v.ay < -lim || v.ay > lim || v.az < -lim || v.az > lim) return false;
  return true;
}

bool decode_control(const uint8_t *in, size_t len, Control &v) {
  if (len != REC) return false;
  v.version = in[0];
  v.opcode = in[1];
  v.seq = get16(in + 2);
  v.nonce = get32(in + 4);
  v.arg0 = get32(in + 8);
  v.arg1 = get32(in + 12);
  v.arg2 = get32(in + 16);
  return true;
}

void encode_control(const Control &v, uint8_t out[REC]) {
  out[0] = v.version;
  out[1] = v.opcode;
  put16(out + 2, v.seq);
  put32(out + 4, v.nonce);
  put32(out + 8, v.arg0);
  put32(out + 12, v.arg1);
  put32(out + 16, v.arg2);
}

void encode_status(const Status &v, uint8_t out[REC]) {
  out[0] = VERSION;
  out[1] = v.kind;
  put16(out + 2, v.seq);
  put32(out + 4, v.nonce);
  put32(out + 8, v.device_ms);
  put32(out + 12, v.detail0);
  put32(out + 16, v.detail1);
}

// ---------------------------------------------------------------------------------------------
// Session

void Session::reset() {
  open_ = false;
  nonce_ = 0;
  last_seq_ = 0;
  have_last_ = false;
  memset(last_cmd_, 0, sizeof(last_cmd_));
  memset(&last_result_, 0, sizeof(last_result_));
  memset(&state_, 0, sizeof(state_));
  stale_ = true;
  clear_cues();
  cue_order_ = 0;
}

void Session::clear_cues() {
  ++presentation_revision_;
  for (Cue &c : cues_) c.used = false;
}

int Session::pending_cues() const {
  int n = 0;
  for (const Cue &c : cues_) n += c.used ? 1 : 0;
  return n;
}

bool Session::handle_control(const uint8_t *in, size_t len, uint32_t now_ms, Status &result) {
  Control c;
  if (!decode_control(in, len, c)) return false;  // unidentifiable: no correlatable result
  result.kind = 1;
  result.seq = c.seq;
  result.nonce = nonce_;
  result.device_ms = now_ms;
  result.detail0 = c.opcode;

  if (c.version != VERSION) {
    result.detail1 = RC_MALFORMED;
    return true;
  }
  if (!open_) {
    if (c.opcode != OP_OPEN) {
      result.detail1 = RC_WRONG_SESSION;
      return true;
    }
    if (c.seq != 0 || c.nonce == 0 || c.arg0 || c.arg1 || c.arg2) {
      result.detail1 = RC_INVALID_ARG;
      return true;
    }
    open_ = true;
    nonce_ = c.nonce;
    last_seq_ = c.seq;
    stale_ = true;
    state_.valid = false;
    clear_cues();
    result.nonce = nonce_;
    result.detail1 = RC_OK;
    memcpy(last_cmd_, in, REC);
    last_result_ = result;
    have_last_ = true;
    return true;
  }
  if (c.nonce != nonce_) {
    result.detail1 = RC_WRONG_SESSION;
    return true;
  }
  if (have_last_ && memcmp(last_cmd_, in, REC) == 0) {
    result = last_result_;  // exact duplicate: re-ACK, no effect, original receipt time
    return true;
  }
  const uint16_t d = (uint16_t)(c.seq - last_seq_);
  if (d == 0 || d >= 0x8000) {
    result.detail1 = RC_STALE_SEQ;
    return true;
  }
  last_seq_ = c.seq;  // a well-formed in-order command consumes its sequence even when rejected
  result.detail1 = apply(c, now_ms);
  memcpy(last_cmd_, in, REC);
  last_result_ = result;
  have_last_ = true;
  return true;
}

uint32_t Session::apply(const Control &c, uint32_t now_ms) {
  switch (c.opcode) {
    case OP_OPEN:
      return RC_WRONG_SESSION;  // only the first OPEN establishes the session
    case OP_SYNC:
      return (c.arg0 || c.arg1 || c.arg2) ? RC_INVALID_ARG : RC_OK;
    case OP_SET_STATE: {
      const uint8_t phase = (uint8_t)c.arg0, hp = (uint8_t)(c.arg0 >> 8), maxhp = (uint8_t)(c.arg0 >> 16), st = (uint8_t)(c.arg0 >> 24);
      if (phase > PH_ABORTED || hp > 100 || maxhp != 100 || (st & ~(ST_SHIELD | ST_LOCKED)) || c.arg1 == 0) return RC_INVALID_ARG;
      const int32_t lead = diff32(c.arg2, now_ms);
      if (lead <= 0) return RC_EXPIRED;
      if (lead > STATE_MAX_LEASE_MS) return RC_INVALID_ARG;
      if (!state_.valid || state_.epoch != c.arg1) clear_cues();
      state_.valid = true;
      state_.phase = phase;
      state_.hp = hp;
      state_.maxhp = maxhp;
      state_.status = st;
      state_.epoch = c.arg1;
      state_.valid_until_ms = c.arg2;
      stale_ = false;
      return RC_OK;
    }
    case OP_CUE: {
      const uint8_t effect = (uint8_t)c.arg0, spell = (uint8_t)(c.arg0 >> 8);
      const uint16_t duration = (uint16_t)(c.arg0 >> 16);
      if (effect < FX_ACCEPTED_CAST || effect > FX_RESULT || spell > SP_LAST || duration < 1 || duration > 1000) return RC_INVALID_ARG;
      if (effect == FX_ACCEPTED_CAST && spell == SP_NONE) return RC_INVALID_ARG;
      if (!state_.valid || diff32(now_ms, state_.valid_until_ms) >= 0 || c.arg1 != state_.epoch) return RC_INVALID_ARG;
      if (effect == FX_RESULT && (spell != SP_NONE || (state_.phase != PH_WON && state_.phase != PH_LOST && state_.phase != PH_DRAW))) return RC_INVALID_ARG;
      const int32_t lead = diff32(c.arg2, now_ms);
      if (lead <= 0) return RC_EXPIRED;
      if (lead > CUE_MAX_LEAD_MS) return RC_INVALID_ARG;
      // Find a slot: unused first, else the oldest queued cue is replaced (bounded, fresh-first).
      Cue *slot = nullptr;
      for (Cue &q : cues_) {
        if (!q.used) {
          slot = &q;
          break;
        }
        if (!slot || q.order < slot->order) slot = &q;
      }
      slot->used = true;
      slot->effect = effect;
      slot->spell = spell;
      slot->duration_ms = duration;
      slot->epoch = c.arg1;
      slot->start_before_ms = c.arg2;
      slot->order = cue_order_++;
      return RC_OK;
    }
    default:
      return RC_UNSUPPORTED;
  }
}

void Session::tick(uint32_t now_ms) {
  if (state_.valid && diff32(now_ms, state_.valid_until_ms) >= 0) {
    state_.valid = false;
    stale_ = true;
    clear_cues();
  }
}

bool Session::take_cue(uint32_t now_ms, Cue &out) {
  tick(now_ms);
  Cue *best = nullptr;
  for (Cue &q : cues_) {
    if (!q.used) continue;
    if (diff32(now_ms, q.start_before_ms) >= 0) {
      q.used = false;  // expired before it could start: dropped, never drained late
      continue;
    }
    if (!best || q.order < best->order) best = &q;
  }
  if (!best) return false;
  out = *best;
  best->used = false;
  return true;
}

Status Session::health(uint32_t now_ms, uint32_t dropped, uint32_t bits) const {
  Status s;
  s.kind = 0;
  s.seq = 0;
  s.nonce = open_ ? nonce_ : 0;
  s.device_ms = now_ms;
  s.detail0 = dropped;
  s.detail1 = bits | (stale_ ? H_STATE_STALE : 0);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Golden vectors (contract section 7)

namespace {
int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
// "01 0f 32 ..." -> bytes; returns count
size_t unhex(const char *text, uint8_t *out, size_t max) {
  size_t n = 0;
  int hi = -1;
  for (const char *p = text; *p && n < max; p++) {
    const int v = hexval(*p);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out[n++] = (uint8_t)((hi << 4) | v);
      hi = -1;
    }
  }
  return n;
}
struct Check {
  int fails;
  void (*log)(const char *);
  void expect(bool ok, const char *name) {
    char line[96];
    snprintf(line, sizeof(line), "%s %s", ok ? "PASS" : "FAIL", name);
    log(line);
    if (!ok) fails++;
  }
  void expect_bytes(const uint8_t *got, const char *hex, const char *name) {
    uint8_t want[REC];
    const size_t n = unhex(hex, want, REC);
    expect(n == REC && memcmp(got, want, REC) == 0, name);
  }
};
}  // namespace

int selftest(void (*log)(const char *line)) {
  Check t{0, log};
  uint8_t buf[REC], raw[REC];

  Info info{CAP_ALL, 50, 8, {0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6}, 0x11223344, 0, 1, 0, 1};
  encode_info(info, buf);
  t.expect_bytes(buf, "01 0f 32 08 a1 b2 c3 d4 e5 f6 44 33 22 11 00 01 00 01 00 00", "INFO golden vector");

  Motion m{MF_VALID, 42, 1000, 0x11223344, -100, 200, 1000};
  encode_motion(m, buf);
  t.expect_bytes(buf, "01 01 2a 00 e8 03 00 00 44 33 22 11 9c ff c8 00 e8 03 00 00", "MOTION golden vector");
  Motion md;
  t.expect(decode_motion(buf, REC, md) && md.ax == -100 && md.ay == 200 && md.az == 1000 && md.seq == 42, "MOTION decodes back");
  m.ax = -8000;
  m.ay = 8000;
  encode_motion(m, buf);
  t.expect(buf[12] == 0xc0 && buf[13] == 0xe0 && buf[14] == 0x40 && buf[15] == 0x1f, "signed endpoints -8000/+8000");
  t.expect(decode_motion(buf, REC, md), "endpoints are valid");
  buf[12] = 0x41;
  buf[13] = 0x1f;
  t.expect(!decode_motion(buf, REC, md), "+8001 is malformed");
  buf[12] = 0x00;
  buf[13] = 0x80;
  t.expect(!decode_motion(buf, REC, md), "-32768 is malformed");
  encode_motion(m, buf);
  buf[19] = 1;
  t.expect(!decode_motion(buf, REC, md), "nonzero reserved byte is malformed");
  t.expect(!decode_motion(buf, REC - 1, md), "wrong length is malformed");

  // OPEN / SET_STATE / CUE session fixture
  Session s;
  Status r;
  unhex("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s.handle_control(raw, REC, 1010, r), "OPEN produces a result");
  encode_status(r, buf);
  t.expect_bytes(buf, "01 01 00 00 dd cc bb aa f2 03 00 00 01 00 00 00 00 00 00 00", "OPEN result golden vector");
  t.expect(s.is_open() && s.nonce() == 0xAABBCCDD && s.state_stale(), "session open, state stale");
  t.expect(s.handle_control(raw, REC, 1020, r) && r.detail1 == RC_OK && r.device_ms == 1010, "duplicate OPEN re-ACKs original receipt");

  unhex("01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00", raw, REC);
  t.expect(s.handle_control(raw, REC, 1100, r) && r.detail1 == RC_OK, "SET_STATE at 1100 accepted");
  t.expect(s.state().valid && s.state().phase == PH_PLAYING && s.state().hp == 100 && s.state().epoch == 0x01020304 && !s.state_stale(), "state applied, stale cleared");

  unhex("01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00", raw, REC);
  t.expect(s.handle_control(raw, REC, 1150, r) && r.detail1 == RC_OK && s.pending_cues() == 1, "CUE at 1150 accepted");
  t.expect(s.handle_control(raw, REC, 1160, r) && r.detail1 == RC_OK && r.device_ms == 1150 && s.pending_cues() == 1, "duplicate CUE re-ACKs without replay");
  Cue cue;
  t.expect(s.take_cue(1200, cue) && cue.effect == FX_ACCEPTED_CAST && cue.spell == SP_STUPEFY && cue.duration_ms == 300, "cue dequeues once");
  t.expect(!s.take_cue(1200, cue), "queue empty afterwards");
  // contract v1.1: spell codes 4-7 are valid cue spells; 8 is not
  Control c7{VERSION, OP_CUE, 3, 0xAABBCCDD, (uint32_t)FX_ACCEPTED_CAST | ((uint32_t)SP_EXPECTO_PATRONUM << 8) | (300u << 16), 0x01020304, 1500};
  encode_control(c7, raw);
  t.expect(s.handle_control(raw, REC, 1200, r) && r.detail1 == RC_OK && s.take_cue(1250, cue) && cue.spell == SP_EXPECTO_PATRONUM, "CUE spell 7 (Expecto Patronum) accepted");
  Control c8 = c7;
  c8.seq = 4;
  c8.arg0 = (uint32_t)FX_ACCEPTED_CAST | (8u << 8) | (300u << 16);
  encode_control(c8, raw);
  t.expect(s.handle_control(raw, REC, 1200, r) && r.detail1 == RC_INVALID_ARG, "CUE spell 8 is invalid");

  // independent fixture: same CUE first arriving at 1400 is expired
  Session s2;
  unhex("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  s2.handle_control(raw, REC, 1010, r);
  unhex("01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00", raw, REC);
  s2.handle_control(raw, REC, 1100, r);
  unhex("01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00", raw, REC);
  t.expect(s2.handle_control(raw, REC, 1400, r) && r.detail1 == RC_EXPIRED && s2.pending_cues() == 0, "CUE arriving at 1400 is expired");
  unhex("01 04 03 00 dd cc bb aa 01 01 2c 01 05 03 02 01 78 05 00 00", raw, REC);
  t.expect(s2.handle_control(raw, REC, 1150, r) && r.detail1 == RC_INVALID_ARG && s2.pending_cues() == 0, "CUE with a different epoch is rejected");
  s2.tick(2300);
  t.expect(!s2.state().valid && s2.state_stale(), "state lease expires at 2200");

  // wrap fixture: last processed sequence 65535, SYNC with sequence 0 is next
  Session s3;
  unhex("01 01 ff ff dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s3.handle_control(raw, REC, 1000, r) && r.detail1 == RC_INVALID_ARG && !s3.is_open(), "OPEN must begin at sequence zero");
  Control wrap{VERSION, OP_OPEN, 0, 0xAABBCCDD, 0, 0, 0};
  encode_control(wrap, raw);
  s3.handle_control(raw, REC, 1000, r);
  wrap.opcode = OP_SYNC;
  const uint16_t steps[] = {32767, 65534, 65535};
  for (uint16_t step : steps) {
    wrap.seq = step;
    encode_control(wrap, raw);
    s3.handle_control(raw, REC, 1010, r);
  }
  unhex("01 02 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s3.handle_control(raw, REC, 2000, r), "SYNC after wrap produces a result");
  encode_status(r, buf);
  t.expect_bytes(buf, "01 01 00 00 dd cc bb aa d0 07 00 00 02 00 00 00 00 00 00 00", "SYNC wrap result golden vector");
  unhex("01 02 ff ff dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s3.handle_control(raw, REC, 2010, r) && r.detail1 == RC_STALE_SEQ, "replaying 65535 is stale");
  unhex("01 02 00 80 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s3.handle_control(raw, REC, 2020, r) && r.detail1 == RC_STALE_SEQ, "jump 0 -> 32768 is ambiguous");

  // gap fixture: after sequence 2, sequence 4 is allowed and 3 is then stale
  Session s4;
  unhex("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  s4.handle_control(raw, REC, 1000, r);
  unhex("01 02 01 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  s4.handle_control(raw, REC, 1010, r);
  unhex("01 02 02 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  s4.handle_control(raw, REC, 1020, r);
  unhex("01 02 04 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s4.handle_control(raw, REC, 2100, r), "SYNC 4 after 2 produces a result");
  encode_status(r, buf);
  t.expect_bytes(buf, "01 01 04 00 dd cc bb aa 34 08 00 00 02 00 00 00 00 00 00 00", "SYNC gap result golden vector");
  unhex("01 02 03 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s4.handle_control(raw, REC, 2110, r) && r.detail1 == RC_STALE_SEQ, "late sequence 3 is stale");

  // session guards
  Session s5;
  unhex("01 02 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s5.handle_control(raw, REC, 10, r) && r.detail1 == RC_WRONG_SESSION && r.nonce == 0, "SYNC before OPEN is wrong session");
  unhex("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  s5.handle_control(raw, REC, 20, r);
  unhex("01 02 01 00 00 11 22 33 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s5.handle_control(raw, REC, 30, r) && r.detail1 == RC_WRONG_SESSION, "wrong nonce is wrong session");
  unhex("02 02 01 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s5.handle_control(raw, REC, 40, r) && r.detail1 == RC_MALFORMED, "version 2 is malformed");
  unhex("01 02 01 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(!s5.handle_control(raw, REC - 1, 50, r), "19-byte frame gets no result");
  unhex("01 09 01 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s5.handle_control(raw, REC, 60, r) && r.detail1 == RC_UNSUPPORTED, "opcode 9 is unsupported");
  unhex("01 01 02 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00", raw, REC);
  t.expect(s5.handle_control(raw, REC, 70, r) && r.detail1 == RC_WRONG_SESSION, "second OPEN with a new sequence is rejected");
  Status h = s5.health(80, 3, H_SENSOR | H_STREAM);
  t.expect(h.kind == 0 && h.nonce == 0xAABBCCDD && h.detail0 == 3 && h.detail1 == (H_SENSOR | H_STREAM | H_STATE_STALE), "health reports stale state before SET_STATE");

  Session expiry;
  Control c{VERSION, OP_OPEN, 0, 7, 0, 0, 0};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 100, r);
  c = {VERSION, OP_SET_STATE, 1, 7, 0x00646403, 9, 200};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 110, r);
  c = {VERSION, OP_CUE, 2, 7, 0x00640101, 9, 180};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 120, r);
  t.expect(!expiry.take_cue(180, cue), "cue does not start at its deadline");
  const uint32_t revision = expiry.presentation_revision();
  expiry.tick(200);
  t.expect(expiry.state_stale() && expiry.presentation_revision() != revision, "lease expires at exact deadline and invalidates active presentation");
  c = {VERSION, OP_SET_STATE, 3, 7, 0x00646403, 9, 300};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 210, r);
  t.expect(!expiry.state_stale() && expiry.presentation_revision() != revision, "same-epoch refresh cannot resurrect expired cue");
  c = {VERSION, OP_CUE, 4, 7, 0x00640101, 9, 280};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 220, r);
  c = {VERSION, OP_SET_STATE, 5, 7, 0x00646403, 10, 350};
  encode_control(c, raw);
  expiry.handle_control(raw, REC, 230, r);
  t.expect(expiry.pending_cues() == 0, "new epoch clears pending cues");
  expiry.reset();
  c = {VERSION, OP_OPEN, 0, 8, 0, 0, 0};
  encode_control(c, raw);
  t.expect(expiry.handle_control(raw, REC, 240, r) && r.detail1 == RC_OK && r.nonce == 8, "physical reconnect accepts fresh OPEN zero and nonce");

  char line[48];
  snprintf(line, sizeof(line), "selftest done: %d failure(s)", t.fails);
  log(line);
  return t.fails;
}
}  // namespace proto
