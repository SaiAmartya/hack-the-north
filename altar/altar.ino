// Oracle Altar for Phantom Arena (Tier 2, optional).
//
// An Arduino with a PN532 NFC breakout rewrites ONE NFC tag every time the laptop's
// Game Master issues a decree. Players tap the altar with their badge (Shrine screen)
// to receive the mutation. The same sketch doubles as a loot-sticker writing station.
//
// Hardware: Arduino Uno/Nano + PN532 breakout in I2C mode (Uno: SDA=A4, SCL=A5,
//           IRQ=D2, RESET=D3). Tags: NTAG213/215/216 stickers (7-byte UID, NDEF formatted).
// Library:  "Adafruit PN532" (Library Manager)     arduino-cli lib install "Adafruit PN532"
// Build:    arduino-cli compile --fqbn arduino:avr:uno altar && arduino-cli upload -p COM7 --fqbn arduino:avr:uno altar
//
// Serial (115200):
//   laptop -> W|<text>\n    write an NDEF Text record (lang "en") with <text> to the tag on the reader (waits 5 s)
//   arduino -> READY | OK|<text> | ERR|<reason> | TAG|<uid hex> (a tag seen while idle)

#include <Wire.h>
#include <Adafruit_PN532.h>

#define PN532_IRQ 2
#define PN532_RESET 3

Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);

static char lineBuf[160];
static uint8_t lineLen = 0;

static void printUid(const uint8_t* uid, uint8_t len) {
  for (uint8_t i = 0; i < len; i++) {
    if (uid[i] < 0x10) Serial.print('0');
    Serial.print(uid[i], HEX);
  }
}

// Writes: NDEF TLV (0x03, len) + Text record (D1 01 <plen> 'T' 02 'e' 'n' <text>) + terminator (0xFE),
// as 4-byte pages starting at page 4 (user memory on NTAG21x).
static bool writeTextRecord(const char* text) {
  size_t n = strlen(text);
  if (n == 0 || n > 120) return false;
  uint8_t payloadLen = (uint8_t)(3 + n);
  uint8_t msgLen = (uint8_t)(4 + payloadLen);
  uint8_t buf[144];
  uint8_t i = 0;
  buf[i++] = 0x03;
  buf[i++] = msgLen;
  buf[i++] = 0xD1;  // MB=1 ME=1 SR=1 TNF=1 (well-known)
  buf[i++] = 0x01;  // type length
  buf[i++] = payloadLen;
  buf[i++] = 'T';
  buf[i++] = 0x02;  // status: UTF-8, language code length 2
  buf[i++] = 'e';
  buf[i++] = 'n';
  memcpy(buf + i, text, n);
  i += n;
  buf[i++] = 0xFE;  // terminator TLV
  uint8_t page = 4;
  for (uint8_t off = 0; off < i; off += 4, page++) {
    uint8_t chunk[4] = {0, 0, 0, 0};
    for (uint8_t k = 0; k < 4 && (uint8_t)(off + k) < i; k++) chunk[k] = buf[off + k];
    if (!nfc.ntag2xx_WritePage(page, chunk)) return false;
  }
  return true;
}

static void handleLine(char* line) {
  if (line[0] == 'W' && line[1] == '|') {
    const char* text = line + 2;
    uint8_t uid[7];
    uint8_t uidLen = 0;
    unsigned long t0 = millis();
    bool found = false;
    while (millis() - t0 < 5000UL) {
      if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 250)) { found = true; break; }
    }
    if (!found) { Serial.println(F("ERR|no tag on the reader")); return; }
    if (uidLen != 7) { Serial.println(F("ERR|not an NTAG21x (need a 7-byte UID)")); return; }
    if (writeTextRecord(text)) {
      Serial.print(F("OK|"));
      Serial.println(text);
    } else {
      Serial.println(F("ERR|write failed (keep the tag still)"));
    }
    return;
  }
  Serial.println(F("ERR|unknown command, use W|<text>"));
}

void setup() {
  Serial.begin(115200);
  nfc.begin();
  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    Serial.println(F("ERR|PN532 not found (check I2C wiring and the mode switches)"));
    while (true) delay(100);
  }
  nfc.SAMConfig();
  Serial.println(F("READY"));
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      lineBuf[lineLen] = 0;
      if (lineLen) handleLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    }
  }
  uint8_t uid[7];
  uint8_t uidLen = 0;
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 150)) {
    Serial.print(F("TAG|"));
    printUid(uid, uidLen);
    Serial.println();
    delay(400);
  }
}
