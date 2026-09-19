#pragma once
// Hack the North 2026 Hacker Badge pin map. Read from badge.kicad_pcb (ESP32-C3-MINI-1-N4, U9) and
// verified on hardware by the drone-hacking project; the button bit order was confirmed on a real badge.

// Buttons: 74HC165 shift register (U8), active low, MSB first: bit7 A, 6 B, 5 HOME, 4 DOWN, 3 LEFT, 2 RIGHT, 1 UP, 0 slide
#define PIN_SR_QH 7
#define PIN_SR_SHLD 20
#define PIN_SR_CLK 21
#define PIN_BOOT_BTN 9  // START / play icon, straight to GPIO9 (boot strap), active low

// I2C bus shared by the SC7A20 accelerometer (0x19) and the MFRC522 NFC reader (address found by scan). External 4k7 pull-ups.
#define PIN_I2C_SDA 5
#define PIN_I2C_SCL 6
#define ACCEL_ADDR 0x19

// Six WS2812B-2020 LEDs, 5 V, data through a level shifter on GPIO3
#define PIN_LED_DIN 3
#define LED_COUNT 6

// HS20HS072RX 2.0" 320x240 IPS, ST7789, 4-wire SPI. Backlight is hard-wired on.
#define PIN_DISP_DC 0
#define PIN_DISP_SCLK 1
#define PIN_DISP_CS 2
#define PIN_DISP_RST 4
#define PIN_DISP_MOSI 10
