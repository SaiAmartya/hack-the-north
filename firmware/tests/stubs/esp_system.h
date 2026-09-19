#pragma once
// Only the reset-reason surface used by diagnostic.cpp; no device access in host tests.
enum esp_reset_reason_t { ESP_RST_UNKNOWN, ESP_RST_POWERON, ESP_RST_SW, ESP_RST_TASK_WDT, ESP_RST_BROWNOUT };
esp_reset_reason_t esp_reset_reason();
