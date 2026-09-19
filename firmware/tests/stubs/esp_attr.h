#pragma once
// Host-only test shim. The device build uses ESP-IDF's .rtc_noinit section attribute.
#define RTC_NOINIT_ATTR
