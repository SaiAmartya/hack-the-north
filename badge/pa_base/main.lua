-- PA Base Station: relays every Phantom Arena radio frame to USB serial.
-- Plug this badge into the laptop and leave this app open.
-- Serial line format (one per frame):   PARX|<mac>|<rssi>|<payload>
-- Every 5 s:                            PAST|frames=<n>|badges=<n>|dropped=<n>
-- At start:                             PAMEM|... free_heap before/after radio enable (BLE cost)
-- A resets the counters. HOME exits.

local ssub = string.sub
local rxq, macs = {}, {}
local frames, nmacs, radio_ok = 0, 0, false
local status, counts, last, dirty = nil, nil, nil, false
local next_stat, next_ui, next_led, last_rx = 0, 0, 0, -100000
local led_step = 0

local function log_mem(tag)
  local st = badge.sys.stats()
  badge.sys.log(string.format("PAMEM|%s|lua=%d/%d peak=%d free_heap=%d", tag, st.lua_used, st.lua_limit, st.lua_peak, st.free_heap))
end

function on_enter(root)
  log_mem("enter")
  local title = badge.ui.label(root, "PA BASE STATION")
  title:style({ text_font = 20, text_color = 0xffcc55 })
  title:align("top_mid", 0, 10)
  status = badge.ui.label(root, "Starting radio...")
  status:align("top_mid", 0, 46)
  counts = badge.ui.label(root, "")
  counts:style({ text_font = 20, text_align = "center" })
  counts:align("center", 0, -6)
  last = badge.ui.label(root, "")
  last:set_size(312, 40)
  last:style({ text_font = 14, text_align = "center", text_color = 0x99aabb })
  last:align("bottom_mid", 0, -34)
  local hint = badge.ui.label(root, "USB relay to laptop   A reset   HOME exit")
  hint:style({ text_font = 14, text_color = 0x556677 })
  hint:align("bottom_mid", 0, -10)
  radio_ok = badge.radio.enable()
  log_mem(radio_ok and "radio on" or "radio FAILED")
  if not radio_ok then
    status:set_text("Radio unavailable - reboot and retry")
    return
  end
  badge.radio.on_recv(function(mac, rssi, payload)
    if #rxq < 32 and ssub(payload or "", 1, 2) == "PA" then rxq[#rxq + 1] = { mac, rssi, payload } end
  end)
  status:set_text("Listening on " .. (badge.radio.mac() or "?"))
  badge.sys.log("PAST|up|" .. (badge.radio.mac() or "?"))
  dirty = true
end

function on_tick()
  local now = badge.sys.ms()
  local n = math.min(8, #rxq)
  for _ = 1, n do
    local f = table.remove(rxq, 1)
    badge.sys.log("PARX|" .. f[1] .. "|" .. f[2] .. "|" .. f[3])
    frames = frames + 1
    if not macs[f[1]] then macs[f[1]] = true; nmacs = nmacs + 1 end
    last_rx, dirty = now, true
    if last then last:set_text(f[3]) end
  end
  if radio_ok and now >= next_stat then
    next_stat = now + 5000
    badge.sys.log(string.format("PAST|frames=%d|badges=%d|dropped=%d", frames, nmacs, badge.radio.dropped() or 0))
  end
  if dirty and now >= next_ui then
    next_ui, dirty = now + 250, false
    counts:set_text(string.format("%d frames\n%d badges heard", frames, nmacs))
  end
  if now >= next_led then
    next_led = now + 80
    badge.led.clear()
    if now - last_rx < 400 then
      led_step = led_step % 6 + 1
      badge.led.set(led_step, 0, 120, 255)
    elseif radio_ok then
      local w = (now % 2000) / 1000
      w = w <= 1 and w or 2 - w
      local l = math.floor(8 + 30 * w)
      badge.led.set_all(0, l, math.floor(l * 1.5))
    end
    badge.led.show()
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED or button ~= badge.input.BUTTON.A then return end
  frames, nmacs, macs, dirty = 0, 0, {}, true
  badge.sys.log("PAST|reset")
end

function on_exit()
  if radio_ok then
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
