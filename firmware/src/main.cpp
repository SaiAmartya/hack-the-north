// Build-check skeleton; replaced by the full game once the toolchain is verified.
#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
#include "pins.h"

static Adafruit_NeoPixel strip(LED_COUNT, PIN_LED_DIN, NEO_GRB + NEO_KHZ800);
static Adafruit_ST7789 tft(&SPI, PIN_DISP_CS, PIN_DISP_DC, PIN_DISP_RST);

void setup() {
  Serial.begin(115200);
  strip.begin();
  strip.setBrightness(40);
  SPI.begin(PIN_DISP_SCLK, -1, PIN_DISP_MOSI, PIN_DISP_CS);
  tft.init(240, 320);
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(20, 100);
  tft.print("PHANTOM ARENA");
}

void loop() {
  static uint8_t i = 0;
  strip.clear();
  strip.setPixelColor(i % LED_COUNT, strip.Color(0, 80, 255));
  strip.show();
  i++;
  Serial.println("PA|alive");
  delay(200);
}
