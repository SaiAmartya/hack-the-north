#include "ble.h"
#include "config.h"
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_mac.h>
#include <string.h>
#include <atomic>
#include <freertos/semphr.h>

namespace ble {
namespace {
NimBLEServer *g_server = nullptr;
NimBLECharacteristic *g_info = nullptr, *g_motion = nullptr, *g_control = nullptr, *g_status = nullptr;
ControlHandler g_handler = nullptr;
LinkHandler g_link_handler = nullptr;
std::atomic<bool> g_connected{false}, g_motion_sub{false}, g_status_sub{false};
std::atomic<uint32_t> g_gen{0}, g_notify_failures{0};
uint16_t g_handle = BLE_HS_CONN_HANDLE_NONE;
StaticSemaphore_t g_send_lock_storage;
SemaphoreHandle_t g_send_lock = nullptr;
struct SendLock {
  SendLock() { xSemaphoreTake(g_send_lock, portMAX_DELAY); }
  ~SendLock() { xSemaphoreGive(g_send_lock); }
};
char g_name[16] = "WAND-0000";

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, NimBLEConnInfo &info) override {
    if (g_connected) {
      server->disconnect(info.getConnHandle());
      return;
    }
    {
      SendLock lock;
      g_handle = info.getConnHandle();
      g_motion_sub = false;
      g_status_sub = false;
      ++g_gen;
      g_connected = true;
    }
    NimBLEDevice::stopAdvertising();
    if (g_link_handler) g_link_handler(g_gen.load());
  }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &info, int) override {
    {
      SendLock lock;
      if (info.getConnHandle() != g_handle) return;
      g_connected = false;
      g_motion_sub = false;
      g_status_sub = false;
      g_handle = BLE_HS_CONN_HANDLE_NONE;
      ++g_gen;
    }
    if (g_link_handler) g_link_handler(g_gen.load());
    NimBLEDevice::startAdvertising();  // resume connectable advertising for the next central
  }
};

class ControlCB : public NimBLECharacteristicCallbacks {
  // Runs on the NimBLE host task without the host lock held, so the handler may notify from here.
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    if (!g_connected || info.getConnHandle() != g_handle) return;
    NimBLEAttValue v = c->getValue();
    uint8_t raw[20];
    memset(raw, 0, sizeof(raw));
    memcpy(raw, v.data(), v.size() < 20 ? v.size() : 20);
    if (g_handler) g_handler(raw, v.size(), millis(), g_gen.load());
  }
};

class SubscribeCB : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *c, NimBLEConnInfo &info, uint16_t subValue) override {
    if (!g_connected || info.getConnHandle() != g_handle) return;
    const bool on = (subValue & 0x0001) != 0;  // notifications
    if (c == g_motion) g_motion_sub = on;
    if (c == g_status) g_status_sub = on;
    if (g_link_handler) g_link_handler(g_gen.load());
  }
};

ServerCB g_server_cb;
ControlCB g_control_cb;
SubscribeCB g_subscribe_cb;
}  // namespace

void set_control_handler(ControlHandler handler) { g_handler = handler; }
void set_link_handler(LinkHandler handler) { g_link_handler = handler; }

void begin(const uint8_t device_id[6], const uint8_t info_rec[20], const uint8_t health_rec[20], bool enabled) {
  snprintf(g_name, sizeof(g_name), "%s%02X%02X", DEVICE_NAME_PREFIX, device_id[4], device_id[5]);
  if (!enabled) return;
  g_send_lock = xSemaphoreCreateMutexStatic(&g_send_lock_storage);

  NimBLEDevice::init(g_name);
  NimBLEDevice::setPower(ESP_PWR_LVL_P3);
  g_server = NimBLEDevice::createServer();
  g_server->setCallbacks(&g_server_cb);
  g_server->advertiseOnDisconnect(false);

  NimBLEService *svc = g_server->createService(NimBLEUUID(UUID_WAND_SERVICE));
  g_info = svc->createCharacteristic(NimBLEUUID(UUID_INFO), NIMBLE_PROPERTY::READ);
  g_info->setValue(info_rec, 20);
  g_motion = svc->createCharacteristic(NimBLEUUID(UUID_MOTION), NIMBLE_PROPERTY::NOTIFY);
  g_motion->setCallbacks(&g_subscribe_cb);
  g_control = svc->createCharacteristic(NimBLEUUID(UUID_CONTROL), NIMBLE_PROPERTY::WRITE);
  g_control->setCallbacks(&g_control_cb);
  g_status = svc->createCharacteristic(NimBLEUUID(UUID_STATUS), NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  g_status->setCallbacks(&g_subscribe_cb);
  g_status->setValue(health_rec, 20);

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

bool notify_motion(const uint8_t rec[20], uint32_t gen) {
  if (!g_send_lock) return false; // BLE-off boot: no semaphore or NimBLE objects exist
  SendLock lock;
  if (gen != g_gen || !g_connected || !g_motion_sub || !g_motion) return false;
  const bool sent = g_motion->notify(rec, 20, g_handle);
  if (!sent) ++g_notify_failures;
  return sent;
}

void set_health(const uint8_t rec[20]) {
  if (g_status) g_status->setValue(rec, 20);
}

bool notify_status(const uint8_t rec[20], uint32_t gen) {
  if (!g_send_lock) return false;
  SendLock lock;
  if (gen != g_gen || !g_status || !g_connected || !g_status_sub) return false;
  // Explicit bytes are copied into the packet; notifying the characteristic value defers/coalesces it.
  const bool sent = g_status->notify(rec, 20, g_handle);
  if (!sent) ++g_notify_failures;
  return sent;
}
uint32_t notification_failures() { return g_notify_failures.load(); }
}  // namespace ble
