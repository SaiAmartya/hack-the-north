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
-- This app is deliberately boring. It listens on the shared Lua radio channel,
-- keeps only packets that start with "PA1|", and prints them to serial so the
-- laptop host can read them with pyserial. It makes no game decisions.
--
-- IMPORTANT: the MAC is logged BEFORE the payload. Appending it would land
-- inside the packet's last field and corrupt every sequence number, because the
-- host reads from "PA1|" to end of line.
--
-- Controls: A clears the counters. HOME exits (and releases the radio).
-- Leave this app open for the whole demo: apps only run in the foreground, so a
-- radio listener stops the moment you return to the launcher.

local PREFIX = "PA1|"
local PREFIX_LEN = 4
local UI_REFRESH_MS = 200
local DROP_REPORT_MS = 3000
local PULSE_MS = 120

local radio_ok = false
local received = 0
local ignored = 0
local last_sender = "-"
local last_payload = "-"
local reported_drops = -1

local next_ui = 0
local next_drop_report = 0
local pulse_until = 0
local leds_dirty = true

local status_label, count_label, last_label, drop_label

-- LEDs: dim green means listening, a brief cyan flash means a packet landed,
-- solid red means the radio never started.
local function paint_leds()
  local now = badge.sys.ms()
  if not radio_ok then
    badge.led.set_all(90, 0, 0)
    badge.led.show()
    return
  end
  if now < pulse_until then
    badge.led.set_all(0, 160, 200)
  else
    badge.led.set_all(0, 24, 8)
  end
  badge.led.show()
end

function on_enter(root)
  local title = badge.ui.label(root, "Phantom Gateway")
  title:style({ text_font = 20 })
  title:align("top_mid", 0, 10)

  status_label = badge.ui.label(root, "Starting radio...")
  status_label:align("top_mid", 0, 42)

  count_label = badge.ui.label(root, "kept 0   ignored 0")
  count_label:style({ text_font = 18 })
  count_label:align("top_mid", 0, 74)

  last_label = badge.ui.label(root, "waiting for a packet")
  last_label:style({ text_font = 14 })
  last_label:align("top_mid", 0, 104)

  drop_label = badge.ui.label(root, "dropped 0")
  drop_label:style({ text_font = 14 })
  drop_label:align("top_mid", 0, 128)

  local version = badge.ui.label(root, "fw " .. badge.sys.version())
  version:style({ text_font = 14 })
  version:align("bottom_mid", 0, -34)

  local hint = badge.ui.label(root, "A reset counters   HOME exit")
  hint:style({ text_font = 14 })
  hint:align("bottom_mid", 0, -12)

  -- Log the firmware version: pre-2026-09-16 builds allow only 6 ms per tick
  -- instead of 250 ms, which changes what every badge app can afford to do.
  badge.sys.log("phantom_gateway start fw=" .. badge.sys.version())
  badge.sys.log("phantom_gateway mac=" .. badge.radio.mac())

  radio_ok = badge.radio.enable()
  if not radio_ok then
    -- A successful USB push does not prove the radio started; Bluetooth needs
    -- its own RAM and can fail independently.
    status_label:set_text("Radio unavailable - reboot badge")
    status_label:set_color(0xff6666)
    badge.sys.log("phantom_gateway radio_enable_failed")
    paint_leds()
    return
  end

  status_label:set_text("Listening for PA1 packets")
  status_label:set_color(0x66ff99)
  badge.sys.log("phantom_gateway radio_ok")

  -- Keep this handler short: it runs inside the shared tick budget, and a slow
  -- receive handler delays drawing and input for the whole app.
  badge.radio.on_recv(function(mac, rssi, payload)
    if string.sub(payload, 1, PREFIX_LEN) ~= PREFIX then
      ignored = ignored + 1
      return
    end
    received = received + 1
    last_payload = payload
    last_sender = mac
    pulse_until = badge.sys.ms() + PULSE_MS
    leds_dirty = true
    -- MAC first. This is the line the host parses.
    badge.sys.log(mac .. " " .. payload)
    if rssi then
      last_sender = mac .. "  " .. rssi .. "dBm"
    end
  end)

  paint_leds()
end

function on_tick()
  local now = badge.sys.ms()

  if leds_dirty or now < pulse_until + 40 then
    paint_leds()
    leds_dirty = false
  end

  if now < next_ui then
    return
  end
  next_ui = now + UI_REFRESH_MS

  count_label:set_text("kept " .. received .. "   ignored " .. ignored)
  last_label:set_text(string.sub(last_payload, 1, 40))

  if not radio_ok then
    return
  end

  -- The receive ring holds 8 frames and drains 4 per tick. The channel is shared
  -- with every other badge app in the room, so surface contention instead of
  -- letting packets vanish silently.
  local dropped = badge.radio.dropped()
  if dropped ~= reported_drops then
    reported_drops = dropped
    drop_label:set_text("dropped " .. dropped .. "   from " .. last_sender)
    if dropped > 0 then
      drop_label:set_color(0xffcc55)
    end
  end

  if now >= next_drop_report then
    next_drop_report = now + DROP_REPORT_MS
    badge.sys.log(
      "phantom_gateway stats kept=" .. received ..
      " ignored=" .. ignored ..
      " dropped=" .. dropped
    )
  end
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then
    return
  end
  if button == badge.input.BUTTON.A then
    received = 0
    ignored = 0
    last_payload = "-"
    last_sender = "-"
    reported_drops = -1
    drop_label:set_color(0xffffff)
    badge.sys.log("phantom_gateway counters_reset")
  end
end

function on_exit()
  if radio_ok then
    -- Never unregister from inside the handler: frames may already be queued for
    -- this tick. Tear down here instead.
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
