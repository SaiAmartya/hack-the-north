--[==[badge-app
slug=phantom_gateway
name=Phantom Gateway
icon=GW
api=2
heap_kb=48
wake_lock=1
]==]

-- Phantom Arena: radio to USB serial bridge.
--
-- Deliberately tiny. On this ESP32-C3 the BLE stack needs about 47 KB and an app
-- only sees ~77 KB free, and compiling main.lua itself costs tens of KB BEFORE
-- on_enter ever runs. Every function, table and string literal here is memory
-- the radio cannot have, so this file stays minimal on purpose: no LED effects,
-- no statistics, no helper layers. If you are tempted to add a feature, check
-- the logged free heap first.
--
-- It keeps only packets starting "PA1|" and prints them with the sender's MAC
-- FIRST, because the host reads from "PA1|" to end of line and a trailing MAC
-- would corrupt the sequence field.
--
-- Leave this app open for the whole demo: apps only run in the foreground.

local radio_ok = false
local kept = 0
local shown = -1
local status_label, count_label

function on_enter(root)
  badge.sys.log("phantom_gateway start fw=" .. badge.sys.version())

  -- Reclaim whatever compiling this file left behind, so BLE gets every byte we
  -- can give it. The log line below shows whether it helped.
  for _ = 1, 24 do
    badge.sys.gc_step()
  end

  local stats = badge.sys.stats()
  badge.sys.log(
    "phantom_gateway heap lua=" .. stats.lua_used ..
    " widgets=" .. stats.widgets ..
    " free=" .. stats.free_heap
  )

  radio_ok = badge.radio.enable()

  if radio_ok then
    badge.sys.log("phantom_gateway radio_ok mac=" .. badge.radio.mac())
    badge.radio.on_recv(function(mac, rssi, payload)
      if string.sub(payload, 1, 4) == "PA1|" then
        kept = kept + 1
        badge.sys.log(mac .. " " .. payload)
      end
    end)
  else
    badge.sys.log("phantom_gateway radio_enable_failed")
  end

  status_label = badge.ui.label(root, "")
  status_label:align("center", 0, -20)

  count_label = badge.ui.label(root, "0 packets")
  count_label:style({ text_font = 24 })
  count_label:align("center", 0, 24)

  if radio_ok then
    status_label:set_text("Gateway listening")
    status_label:set_color(0x66ff99)
    badge.led.set_all(0, 24, 8)
  else
    status_label:set_text("Radio did not start - see serial")
    status_label:set_color(0xff6666)
    badge.led.set_all(90, 0, 0)
  end
  badge.led.show()
end

function on_tick()
  -- Only touch the label when the number actually changed. Setting unchanged
  -- text every tick is wasted native work.
  if kept ~= shown then
    shown = kept
    count_label:set_text(kept .. " packets")

    -- The receive ring holds 8 frames and drains 4 per tick, on a channel shared
    -- with every other badge app in the room. Surface contention rather than
    -- letting packets vanish silently.
    if radio_ok then
      local dropped = badge.radio.dropped()
      if dropped > 0 then
        badge.sys.log("phantom_gateway dropped=" .. dropped)
      end
    end
  end
end

function on_button(button, kind)
  if kind == badge.input.KIND.PRESSED and button == badge.input.BUTTON.A then
    kept = 0
    badge.sys.log("phantom_gateway counters_reset")
  end
end

function on_exit()
  if radio_ok then
    -- Never unregister from inside the handler: frames may already be queued.
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
