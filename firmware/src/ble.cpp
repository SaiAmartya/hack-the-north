#include "ble.h"
#include "config.h"
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_mac.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace ble {
namespace {
struct CtrlMsg {
  uint8_t data[20];
  uint8_t len;
  uint32_t at_ms;
};

NimBLEServer *g_server = nullptr;
NimBLECharacteristic *g_info = nullptr, *g_motion = nullptr, *g_control = nullptr, *g_status = nullptr;
QueueHandle_t g_ctrl = nullptr;
volatile bool g_connected = false, g_motion_sub = false, g_status_sub = false;
volatile uint32_t g_gen = 0;
uint8_t g_health[20];
char g_name[16] = "WAND-0000";

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override {
    g_connected = true;
    g_motion_sub = false;
    g_status_sub = false;
    g_gen = g_gen + 1;
  }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    g_connected = false;
    g_motion_sub = false;
    g_status_sub = false;
    g_gen = g_gen + 1;
    NimBLEDevice::startAdvertising();  // resume connectable advertising for the next central
  }
};

class ControlCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    NimBLEAttValue v = c->getValue();
    CtrlMsg m;
    m.len = (uint8_t)(v.size() > 255 ? 255 : v.size());
    memset(m.data, 0, sizeof(m.data));
    memcpy(m.data, v.data(), v.size() < 20 ? v.size() : 20);
    m.at_ms = millis();
    if (g_ctrl) xQueueSend(g_ctrl, &m, 0);
  }
};

class SubscribeCB : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *c, NimBLEConnInfo &, uint16_t subValue) override {
    const bool on = (subValue & 0x0001) != 0;  // notifications
    if (c == g_motion) g_motion_sub = on;
    if (c == g_status) g_status_sub = on;
  }
};

ServerCB g_server_cb;
ControlCB g_control_cb;
SubscribeCB g_subscribe_cb;
}  // namespace

void begin(const uint8_t device_id[6], const uint8_t info_rec[20], const uint8_t health_rec[20]) {
  snprintf(g_name, sizeof(g_name), "%s%02X%02X", DEVICE_NAME_PREFIX, device_id[4], device_id[5]);
  memcpy(g_health, health_rec, 20);
  g_ctrl = xQueueCreate(8, sizeof(CtrlMsg));

  NimBLEDevice::init(g_name);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  g_server = NimBLEDevice::createServer();
  g_server->setCallbacks(&g_server_cb);
  g_server->advertiseOnDisconnect(true);

  NimBLEService *svc = g_server->createService(NimBLEUUID(UUID_WAND_SERVICE));
  g_info = svc->createCharacteristic(NimBLEUUID(UUID_INFO), NIMBLE_PROPERTY::READ);
  g_info->setValue(info_rec, 20);
  g_motion = svc->createCharacteristic(NimBLEUUID(UUID_MOTION), NIMBLE_PROPERTY::NOTIFY);
  g_motion->setCallbacks(&g_subscribe_cb);
  g_control = svc->createCharacteristic(NimBLEUUID(UUID_CONTROL), NIMBLE_PROPERTY::WRITE);
  g_control->setCallbacks(&g_control_cb);
  g_status = svc->createCharacteristic(NimBLEUUID(UUID_STATUS), NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  g_status->setCallbacks(&g_subscribe_cb);
  g_status->setValue(g_health, 20);

  // 128-bit service UUID fills the advertising packet; the name goes in the scan response.
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  advData.addServiceUUID(NimBLEUUID(UUID_WAND_SERVICE));
  adv->setAdvertisementData(advData);
  NimBLEAdvertisementData scan;
  scan.setName(g_name);
  adv->setScanResponseData(scan);
  adv->start();
}

const char *name() { return g_name; }
bool connected() { return g_connected; }
bool motion_subscribed() { return g_motion_sub; }
bool status_subscribed() { return g_status_sub; }
uint32_t generation() { return g_gen; }

bool notify_motion(const uint8_t rec[20]) {
  if (!g_connected || !g_motion_sub || !g_motion) return false;
  g_motion->setValue(rec, 20);
  return g_motion->notify();
}

void set_health(const uint8_t rec[20]) {
  memcpy(g_health, rec, 20);
  if (g_status) g_status->setValue(g_health, 20);
}

void notify_status(const uint8_t rec[20]) {
  if (!g_status) return;
  if (g_connected && g_status_sub) {
    g_status->setValue(rec, 20);
    g_status->notify();
  }
  g_status->setValue(g_health, 20);  // a read always returns current health
}

bool pop_control(uint8_t out[20], size_t &len, uint32_t &received_ms) {
  CtrlMsg m;
  if (!g_ctrl || xQueueReceive(g_ctrl, &m, 0) != pdTRUE) return false;
  memcpy(out, m.data, 20);
  len = m.len;
  received_ms = m.at_ms;
  return true;
}
}  // namespace ble
