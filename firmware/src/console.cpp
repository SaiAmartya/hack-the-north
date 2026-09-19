#include "console.h"
#include "accel.h"
#include "ble.h"
#include "buttons.h"
#include "config.h"
#include "display.h"
#include "leds.h"
#include "proto.h"
#include "wand.h"
#include <Arduino.h>
#include <Preferences.h>
#include <soc/rtc_cntl_reg.h>
#include <stdlib.h>
#include <string.h>

namespace console {
namespace {
Settings g_settings = default_settings();
Preferences g_prefs;
char g_line[96];
size_t g_len = 0;

void reply(const char *fmt, ...) {
  char b[200];
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
  Serial.println("HPOK|commands: help status id selftest axes [+x -y +z] btn rot <0-3> leds on|off echo on|off recal reboot flashmode");
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
    const wand::Stats &w = wand::stats();
    char ax[24];
    axes_text(ax, sizeof(ax));
    reply("fw=%s name=%s connected=%d motion_sub=%d status_sub=%d sensor=%d i2c_recover=%lu seq=%u acquired=%lu notified=%lu dropped=%lu xyz=%d,%d,%d axes=%s heap=%lu",
          FW_VERSION_STR, ble::name(), ble::connected() ? 1 : 0, ble::motion_subscribed() ? 1 : 0, ble::status_subscribed() ? 1 : 0, w.sensor_ok ? 1 : 0,
          (unsigned long)accel::recoveries(), w.seq, (unsigned long)w.acquired, (unsigned long)w.notified, (unsigned long)w.dropped, w.x, w.y, w.z, ax,
          (unsigned long)ESP.getFreeHeap());
  } else if (!strcmp(cmd, "selftest")) {
    const int fails = proto::selftest(log_line);
    reply("selftest failures=%d", fails);
  } else if (!strcmp(cmd, "axes")) {
    if (arg) {
      int8_t map[3], sign[3];
      char *a2 = strtok(nullptr, " \t");
      char *a3 = strtok(nullptr, " \t");
      if (!parse_axis(arg, map[0], sign[0]) || !parse_axis(a2, map[1], sign[1]) || !parse_axis(a3, map[2], sign[2])) {
        Serial.println("HPERR|usage: axes +x -y +z   (contract X Y Z in terms of chip axes)");
        return;
      }
      memcpy(g_settings.axis_map, map, 3);
      memcpy(g_settings.axis_sign, sign, 3);
      wand::set_axes(map, sign);
      save_settings();
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
    wand::set_echo(!strcmp(arg, "on"));
    reply("echo=%s", arg);
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
  char ax[24];
  axes_text(ax, sizeof(ax));
  Serial.printf("HPHELLO|fw=%s|name=%s|boot=%08lX|hz=%d|range=%d|axes=%s|sensor=%d\n", FW_VERSION_STR, ble::name(), (unsigned long)wand::stats().boot_id,
                SAMPLE_HZ, RANGE_G, ax, wand::stats().sensor_ok ? 1 : 0);
}

void tick() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    // The badge console convention is a bare '\r' line ending; terminals send '\n' or "\r\n".
    if (c == '\n' || c == '\r') {
      g_line[g_len] = 0;
      if (g_len > 0) handle(g_line);
      g_len = 0;
      continue;
    }
    if (g_len < sizeof(g_line) - 1) g_line[g_len++] = (char)c;
    else g_len = 0;
  }
}
}  // namespace console
