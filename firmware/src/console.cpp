#include "console.h"
#include "accel.h"
#include "ble.h"
#include "buttons.h"
#include "config.h"
#include "display.h"
#include "diagnostic.h"
#include "leds.h"
#include "proto.h"
#include "wand.h"
#include <Arduino.h>
#include <Preferences.h>
#include <esp_system.h>
#include <soc/rtc_cntl_reg.h>
#include <stdlib.h>
#include <string.h>

namespace console {
namespace {
Settings g_settings = default_settings();
Preferences g_prefs;
char g_line[96];
size_t g_len = 0;
bool g_overflow = false, g_echo = false;
uint32_t g_next_echo = 0;

void reply(const char *fmt, ...) {
  char b[240];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  Serial.printf("HPOK|%s\n", b);
}

void log_line(const char *line) { Serial.printf("HPTEST|%s\n", line); }

void axes_text(char *out, size_t n) {
  const char names[3] = {'x', 'y', 'z'};
  snprintf(out, n, "%c%c %c%c %c%c", g_settings.axis_sign[0] < 0 ? '-' : '+', names[g_settings.axis_map[0]], g_settings.axis_sign[1] < 0 ? '-' : '+',
           names[g_settings.axis_map[1]], g_settings.axis_sign[2] < 0 ? '-' : '+', names[g_settings.axis_map[2]]);
}

void help() {
  Serial.println("HPOK|commands: help status trace id selftest axes [+x -y +z] btn rot <0-3> leds on|off echo on|off recal reboot flashmode");
  Serial.println("HPOK|boot profile: profile creator|rate|range|high on|off (sensor row + radio; reboots; range on is the gameplay default); trace reset (capture next 16 bursts)");
}

bool parse_axis(const char *tok, int8_t &map, int8_t &sign) {
  if (!tok) return false;
  sign = 1;
  if (*tok == '-') {
    sign = -1;
    tok++;
  } else if (*tok == '+') {
    tok++;
  }
  if (!*tok || tok[1]) return false;
  if (*tok == 'x' || *tok == 'X') map = 0;
  else if (*tok == 'y' || *tok == 'Y') map = 1;
  else if (*tok == 'z' || *tok == 'Z') map = 2;
  else return false;
  return true;
}

void handle(char *line) {
  char *cmd = strtok(line, " \t");
  if (!cmd) return;
  char *arg = strtok(nullptr, " \t");
  if (!strcmp(cmd, "help")) {
    help();
  } else if (!strcmp(cmd, "id")) {
    reply("name=%s fw=%s boot=%08lX", ble::name(), FW_VERSION_STR, (unsigned long)wand::stats().boot_id);
  } else if (!strcmp(cmd, "status")) {
    const diagnostic::Profile &p = diagnostic::profile();
    reply("profile=%s ble=%s caps=%02X configured_hz=%u range_g=%u mg_per_count=%u expected_ctrl0_1_4=%02X/%02X/%02X",
          p.name, diagnostic::selection().ble ? "on" : "off", diagnostic::capabilities_for(p), p.sample_hz, p.range_g, p.mg_per_count, p.ctrl0, p.ctrl1, p.ctrl4);
    const wand::Stats &w = wand::stats();
    char ax[24];
    axes_text(ax, sizeof(ax));
    reply("fw=%s name=%s connected=%d motion_sub=%d status_sub=%d sensor=%d cfg=%02X/%02X i2c_recover=%lu seq=%u acquired=%lu notified=%lu dropped=%lu gaps=%lu lost=%lu overrun_flags=%lu xyz=%d,%d,%d axes=%s",
          FW_VERSION_STR, ble::name(), ble::connected() ? 1 : 0, ble::motion_subscribed() ? 1 : 0, ble::status_subscribed() ? 1 : 0, w.sensor_ok ? 1 : 0,
          accel::ctrl1(), accel::ctrl4(), (unsigned long)accel::recoveries(), w.seq, (unsigned long)w.acquired, (unsigned long)w.notified,
          (unsigned long)w.dropped, (unsigned long)w.gaps, (unsigned long)w.lost, (unsigned long)w.overrun_flags, w.x, w.y, w.z, ax);
    reply("radio enabled=%d advertising=%d connections=%lu adv_restarts=%lu conn_interval_us=%lu",
          ble::enabled() ? 1 : 0, ble::advertising() ? 1 : 0, (unsigned long)ble::connections(), (unsigned long)ble::advertising_restarts(),
          (unsigned long)ble::conn_interval_us());
    reply("resources reset=%d heap_free=%lu heap_min=%lu heap_largest=%lu acq_stack_hwm_bytes=%lu notify_failures=%lu",
          (int)esp_reset_reason(), (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap(),
          (unsigned long)ESP.getMaxAllocHeap(), (unsigned long)wand::stack_headroom(),
          (unsigned long)ble::notification_failures());
    const accel::Diagnostics d = accel::diagnostics();
    reply("sensor ctrl0=%02X ctrl2=%02X ctrl3=%02X ctrl5=%02X ctrl6=%02X fifo_ctrl=%02X revision=%02X status_before=%02X status_after=%02X overrun_cleared=%lu overrun_still_set=%lu",
          d.ctrl0, d.ctrl2, d.ctrl3, d.ctrl5, d.ctrl6, d.fifo_ctrl, d.revision, d.status_before, d.status_after,
          (unsigned long)d.overrun_cleared, (unsigned long)d.overrun_still_set);
    reply("cadence configured_hz=%d tick_hz=%d status_polls=%lu not_ready=%lu fresh_reads=%lu ready_span_us=%llu",
          p.sample_hz, configTICK_RATE_HZ, (unsigned long)d.status_polls,
          (unsigned long)d.not_ready_polls, (unsigned long)d.fresh_reads, (unsigned long long)d.ready_interval_sum_us);
    reply("cadence ready_us_last_min_max=%lu,%lu,%lu after_read_us_last_min_max=%lu,%lu,%lu",
          (unsigned long)d.ready_interval_us, (unsigned long)d.min_ready_interval_us, (unsigned long)d.max_ready_interval_us,
          (unsigned long)d.ready_after_read_us, (unsigned long)d.min_ready_after_read_us, (unsigned long)d.max_ready_after_read_us);
    reply("cadence interval_bins_lt_5_12_17_23_40_ge40ms=%lu,%lu,%lu,%lu,%lu,%lu",
          (unsigned long)d.interval_bins[0], (unsigned long)d.interval_bins[1], (unsigned long)d.interval_bins[2],
          (unsigned long)d.interval_bins[3], (unsigned long)d.interval_bins[4], (unsigned long)d.interval_bins[5]);
    reply("sensor_reset readback_ok=%d ctrl0_1_4=%02X/%02X/%02X trace_count=%u",
          d.reset_readback_ok ? 1 : 0, d.reset_ctrl0, d.reset_ctrl1, d.reset_ctrl4, d.trace_count);
  } else if (!strcmp(cmd, "trace")) {
    if (arg) {
      if (strcmp(arg, "reset") || strtok(nullptr, " \t")) { reply("usage: trace [reset]"); return; }
      accel::reset_trace();
      reply("trace armed; next 16 fresh bursts; profile and health counters unchanged");
      return;
    }
    reply("trace profile=%s ble=%s native_chip_axes=1 mg_per_count=%u", diagnostic::profile().name,
          diagnostic::selection().ble ? "on" : "off", diagnostic::profile().mg_per_count);
    for (uint8_t i = 0; i < accel::TRACE_CAPACITY; ++i) {
      accel::ReadyTrace t{};
      if (!accel::ready_trace(i, t)) break;
      reply("trace n=%u have_zero=%u zero_us=%lu zero_st=%02X ready_us=%lu before=%02X burst_start_us=%lu burst_end_us=%lu after_us=%lu after=%02X",
            i + 1, t.have_not_ready ? 1 : 0, (unsigned long)t.last_not_ready_us, t.last_not_ready_status,
            (unsigned long)t.ready_us, t.before, (unsigned long)t.burst_start_us, (unsigned long)t.burst_end_us,
            (unsigned long)t.after_status_us, t.after);
      reply("trace n=%u counts=%d,%d,%d mg=%d,%d,%d", i + 1, t.counts[0], t.counts[1], t.counts[2], t.mg[0], t.mg[1], t.mg[2]);
    }
    reply("trace end");
  } else if (!strcmp(cmd, "profile")) {
    const int index = diagnostic::profile_index(arg);
    const char *mode = strtok(nullptr, " \t");
    if (index < 0 || !mode || (strcmp(mode, "off") && strcmp(mode, "on")) || strtok(nullptr, " \t")) {
      reply("usage: profile creator|rate|range|high on|off (sensor row + radio; reboots)");
      return;
    }
    if (ble::connected()) { reply("disconnect BLE before selecting a boot profile"); return; }
    if (!diagnostic::select_next_boot((uint8_t)index, !strcmp(mode, "on"))) return;
    reply("next_boot profile=%s ble=%s caps=%02X; software rebooting; no NVS write", arg, mode, diagnostic::capabilities_for(diagnostic::PROFILES[index]));
    delay(100);
    ESP.restart();
  } else if (!strcmp(cmd, "selftest")) {
    if (ble::connected()) { reply("disconnect BLE before selftest"); return; }
    const int fails = proto::selftest(log_line);
    reply("selftest failures=%d", fails);
  } else if (!strcmp(cmd, "axes")) {
    if (arg) {
      int8_t map[3], sign[3];
      char *a2 = strtok(nullptr, " \t");
      char *a3 = strtok(nullptr, " \t");
      if (!parse_axis(arg, map[0], sign[0]) || !parse_axis(a2, map[1], sign[1]) || !parse_axis(a3, map[2], sign[2]) ||
          map[0] == map[1] || map[0] == map[2] || map[1] == map[2]) {
        Serial.println("HPERR|usage: axes +x -y +z   (contract X Y Z in terms of chip axes)");
        return;
      }
      memcpy(g_settings.axis_map, map, 3);
      memcpy(g_settings.axis_sign, sign, 3);
      save_settings();
      reply("axes saved; reboot required to apply with a new boot identity");
      return;
    }
    char ax[24];
    axes_text(ax, sizeof(ax));
    const wand::Stats &w = wand::stats();
    reply("axes=%s  now x=%d y=%d z=%d mg  (face up on a table should read 0,0,+1000)", ax, w.x, w.y, w.z);
  } else if (!strcmp(cmd, "rot") && arg) {
    g_settings.rot = (uint8_t)(atoi(arg) & 3);
    display::set_rotation(g_settings.rot);
    save_settings();
    reply("rot=%u", g_settings.rot);
  } else if (!strcmp(cmd, "leds") && arg) {
    g_settings.leds = !strcmp(arg, "on");
    leds::set_enabled(g_settings.leds);
    save_settings();
    reply("leds=%d", g_settings.leds ? 1 : 0);
  } else if (!strcmp(cmd, "echo") && arg) {
    g_echo = !strcmp(arg, "on");
    reply("echo=%s (5 Hz snapshots, not raw acquisition)", arg);
  } else if (!strcmp(cmd, "btn")) {
    // Button read-out over USB (guide section 9): raw HC165 byte plus the names currently held.
    static const char *names[btn::COUNT] = {"UP", "DOWN", "LEFT", "RIGHT", "A", "B", "HOME", "AUX1", "START"};
    char held[80] = "";
    for (int i = 0; i < btn::COUNT; i++) {
      if (!btn::down((btn::Id)i)) continue;
      strncat(held, names[i], sizeof(held) - strlen(held) - 1);
      strncat(held, " ", sizeof(held) - strlen(held) - 1);
    }
    reply("hc165=%02X held=%s", btn::raw(), held[0] ? held : "-");
  } else if (!strcmp(cmd, "recal")) {
    wand::recalibrate();
    reply("baseline reset");
  } else if (!strcmp(cmd, "reboot")) {
    reply("rebooting");
    delay(100);
    ESP.restart();
  } else if (!strcmp(cmd, "flashmode")) {
    // Software entry into the ROM download mode (USB-Serial-JTAG): the official guide's manual
    // route is holding START while plugging in; the RTS/DTR emulation does not reset this badge.
    reply("entering download mode, screen goes blank; run the flasher now");
    delay(100);
    REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
    ESP.restart();
  } else {
    Serial.printf("HPERR|unknown command: %s\n", cmd);
    help();
  }
}
}  // namespace

void load_settings() {
  g_prefs.begin("hpwand", true);
  g_settings.rot = g_prefs.getUChar("rot", kDefaultDisplayRotation);
  g_settings.leds = g_prefs.getBool("leds", true);
  const int8_t dmap[3] = {0, 1, 2}, dsign[3] = {1, 1, 1};
  if (g_prefs.getBytesLength("amap") != 3 || g_prefs.getBytes("amap", g_settings.axis_map, 3) != 3) memcpy(g_settings.axis_map, dmap, 3);
  if (g_prefs.getBytesLength("asign") != 3 || g_prefs.getBytes("asign", g_settings.axis_sign, 3) != 3) memcpy(g_settings.axis_sign, dsign, 3);
  g_prefs.end();
  for (int i = 0; i < 3; i++) {
    if (g_settings.axis_map[i] < 0 || g_settings.axis_map[i] > 2) g_settings.axis_map[i] = (int8_t)i;
    g_settings.axis_sign[i] = (int8_t)(g_settings.axis_sign[i] < 0 ? -1 : 1);
  }
  if (g_settings.axis_map[0] == g_settings.axis_map[1] || g_settings.axis_map[0] == g_settings.axis_map[2] ||
      g_settings.axis_map[1] == g_settings.axis_map[2]) memcpy(g_settings.axis_map, dmap, 3);
}

void save_settings() {
  g_prefs.begin("hpwand", false);
  g_prefs.putUChar("rot", g_settings.rot);
  g_prefs.putBool("leds", g_settings.leds);
  g_prefs.putBytes("amap", g_settings.axis_map, 3);
  g_prefs.putBytes("asign", g_settings.axis_sign, 3);
  g_prefs.end();
}

Settings &settings() { return g_settings; }
void begin() { g_len = 0; }

void hello() {
  if (!Serial) return;
  char ax[24];
  axes_text(ax, sizeof(ax));
  const diagnostic::Profile &p = diagnostic::profile();
  Serial.printf("HPHELLO|fw=%s|name=%s|boot=%08lX|hz=%u|range=%u|profile=%s|ble=%s|caps=%02X|axes=%s|sensor=%d\n",
                FW_VERSION_STR, ble::name(), (unsigned long)wand::stats().boot_id, p.sample_hz, p.range_g,
                p.name, diagnostic::selection().ble ? "on" : "off", diagnostic::capabilities_for(p), ax, wand::stats().sensor_ok ? 1 : 0);
}

void tick() {
  if (!Serial) { g_echo = false; return; }
  if (g_echo && (int32_t)(millis() - g_next_echo) >= 0 && Serial.availableForWrite() >= 80) {
    g_next_echo = millis() + 200;
    const wand::Stats w = wand::stats();
    Serial.printf("HPM|%u|%d|%d|%d|%s\n", w.seq, w.x, w.y, w.z, w.valid ? "snapshot" : "invalid");
  }
  for (int budget = 0; budget < 128 && Serial.available() > 0; ++budget) {
    const int c = Serial.read();
    if (c < 0) break;
    // The badge console convention is a bare '\r' line ending; terminals send '\n' or "\r\n".
    if (c == '\n' || c == '\r') {
      g_line[g_len] = 0;
      if (g_len > 0 && !g_overflow) handle(g_line);
      g_len = 0;
      g_overflow = false;
      continue;
    }
    if (g_len < sizeof(g_line) - 1) g_line[g_len++] = (char)c;
    else g_overflow = true;
  }
}
}  // namespace console
