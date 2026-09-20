#pragma once
// Wire codec and session rules from BADGE-FIRMWARE-CONTRACT.md v1.
// Pure C++: no Arduino, no BLE. Clock values are injected so the golden vectors run on the badge
// itself (serial command `selftest`) and can be ported to a host test verbatim.
#include <stddef.h>
#include <stdint.h>

namespace proto {
constexpr uint8_t VERSION = 1;
constexpr size_t REC = 20;

enum Opcode : uint8_t { OP_OPEN = 1, OP_SYNC = 2, OP_SET_STATE = 3, OP_CUE = 4 };
enum Result : uint32_t { RC_OK = 0, RC_MALFORMED = 1, RC_WRONG_SESSION = 2, RC_INVALID_ARG = 3, RC_EXPIRED = 4, RC_UNSUPPORTED = 5, RC_STALE_SEQ = 6 };
enum Phase : uint8_t { PH_IDLE = 0, PH_PRACTICE, PH_COUNTDOWN, PH_PLAYING, PH_WON, PH_LOST, PH_DRAW, PH_ABORTED };
enum Effect : uint8_t { FX_ACCEPTED_CAST = 1, FX_BLOCKED = 2, FX_DAMAGE = 3, FX_RESULT = 4 };
enum Spell : uint8_t { SP_NONE = 0, SP_STUPEFY = 1, SP_PROTEGO = 2, SP_EXPELLIARMUS = 3, SP_INCENDIO = 4, SP_SECTUMSEMPRA = 5, SP_PETRIFICUS_TOTALUS = 6, SP_EXPECTO_PATRONUM = 7, SP_LAST = SP_EXPECTO_PATRONUM };
enum StatusBits : uint8_t { ST_SHIELD = 1, ST_LOCKED = 2 };
// STATUS kinds: health and command results per contract section 5; kind 2 (firmware 0.2.3) is a badge
// button press asking the browser to cast `detail0` (spell code 1..7), `detail1` = presses since boot.
enum StatusKind : uint8_t { SK_HEALTH = 0, SK_RESULT = 1, SK_BUTTON = 2 };
enum Health : uint32_t { H_SENSOR = 1, H_STREAM = 2, H_PRESENTATION = 4, H_STATE_STALE = 8 };
enum Caps : uint8_t { CAP_MOTION = 1, CAP_STATE = 2, CAP_CUE = 4, CAP_SYNC = 8, CAP_ALL = 0x0F };
enum MotionFlags : uint8_t { MF_VALID = 1, MF_SATURATED = 2, MF_DISCONTINUITY = 4 };

struct Info {
  uint8_t caps, sample_hz, range_g;
  uint8_t device_id[6];
  uint32_t boot_id;
  uint8_t fw_major, fw_minor, fw_patch;
  uint8_t axis_convention;
};

struct Motion {
  uint8_t flags;
  uint16_t seq;
  uint32_t capture_ms, boot_id;
  int16_t ax, ay, az;
};

struct Control {
  uint8_t version, opcode;
  uint16_t seq;
  uint32_t nonce, arg0, arg1, arg2;
};

struct Status {
  uint8_t kind;   // StatusKind: 0 health, 1 command result, 2 button cast request
  uint16_t seq;
  uint32_t nonce, device_ms, detail0, detail1;
};

void encode_info(const Info &v, uint8_t out[REC]);
void encode_motion(const Motion &v, uint8_t out[REC]);
bool decode_motion(const uint8_t *in, size_t len, Motion &v);  // strict: version, length, reserved, range
bool decode_control(const uint8_t *in, size_t len, Control &v);  // false only when the frame cannot be identified (bad length)
void encode_control(const Control &v, uint8_t out[REC]);
void encode_status(const Status &v, uint8_t out[REC]);

struct DisplayState {
  bool valid;
  uint8_t phase, hp, maxhp, status;
  uint32_t epoch, valid_until_ms;
};

struct Cue {
  bool used;
  uint8_t effect, spell;
  uint16_t duration_ms;
  uint32_t epoch, start_before_ms, order;
};
constexpr int MAX_CUES = 4;

// One GATT connection's command state (contract sections 5 and 6).
class Session {
 public:
  Session() { reset(); }
  void reset();  // on connect and disconnect: forget nonce, sequence, state and cues
  // Handle one CONTROL write. Returns true when `result` must be sent as a STATUS notification.
  bool handle_control(const uint8_t *in, size_t len, uint32_t now_ms, Status &result);
  void tick(uint32_t now_ms);                 // expire the state lease and stale cues
  bool take_cue(uint32_t now_ms, Cue &out);   // pops the next due cue, dropping expired ones
  Status health(uint32_t now_ms, uint32_t dropped, uint32_t bits) const;
  bool is_open() const { return open_; }
  uint32_t nonce() const { return nonce_; }
  const DisplayState &state() const { return state_; }
  bool state_stale() const { return stale_; }
  int pending_cues() const;
  uint32_t presentation_revision() const { return presentation_revision_; }

 private:
  void clear_cues();
  uint32_t apply(const Control &c, uint32_t now_ms);
  bool open_;
  uint32_t nonce_;
  uint16_t last_seq_;
  bool have_last_;
  uint8_t last_cmd_[REC];
  Status last_result_;
  DisplayState state_;
  bool stale_;
  Cue cues_[MAX_CUES];
  uint32_t cue_order_;
  uint32_t presentation_revision_ = 0;
};

// Runs the contract's golden vectors through the codec and a Session. Returns the number of
// failures; `log` receives one line per check.
int selftest(void (*log)(const char *line));
}  // namespace proto
