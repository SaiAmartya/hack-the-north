#pragma once
#include <sdkconfig.h>
// Arduino's SDK header defines these first; override consistently for the source-built NimBLE host.
#undef CONFIG_BT_NIMBLE_MAX_CONNECTIONS
#define CONFIG_BT_NIMBLE_MAX_CONNECTIONS 1
#undef CONFIG_BT_NIMBLE_ROLE_CENTRAL
#undef CONFIG_NIMBLE_ROLE_CENTRAL
#define CONFIG_BT_NIMBLE_ROLE_CENTRAL 0
#undef CONFIG_BT_NIMBLE_ROLE_OBSERVER
#undef CONFIG_NIMBLE_ROLE_OBSERVER
#define CONFIG_BT_NIMBLE_ROLE_OBSERVER 0
#if CONFIG_BT_NIMBLE_HS_FLOW_CTRL
#error "The qualified peripheral configuration requires host flow control disabled"
#endif
#if CONFIG_BT_NIMBLE_MAX_CCCDS < 2
#error "Both MOTION and STATUS subscriptions are required"
#endif
