--[==[badge-app
slug=phantom_chaos
name=Phantom Chaos
icon=CH
api=2
heap_kb=48
wake_lock=1
]==]

-- Phantom Arena: the judge's chaos badge.
--
-- Injects arena modifiers into a running match, and resets a finished one so the
-- demo can be run twice without touching code.
--
--   A      Meteor         12 damage to both players, shields still apply
--   B      Mana Rain      +40 mana to both players
--   START  Double Damage  all spell damage x2 for 5 s
--   UP     Reset match    return to lobby
--
-- HOME exits. HOME is never mapped to an action: its press is swallowed by the
-- launcher intercept and its default action leaves the app.
--
-- Every payload is sent three times, 40 ms apart, from a queue drained in
-- on_tick. There is no sleep, no busy wait and no coroutine on this badge, so
-- spacing sends inside a single callback is impossible.

local SEND_REPEATS = 3
local SEND_SPACING_MS = 40
local QUEUE_MAX = 6
local ACTION_COOLDOWN_MS = 800
local PULSE_MS = 220
local UI_REFRESH_MS = 150

local SENDER = "J"

local radio_ok = false
local sequence = 0
local queue = {}
local queued_total = 0
local send_failures = 0
local next_action_at = 0
local pulse_until = 0
local pulse_rgb = { 0, 0, 0 }
local next_ui = 0

local status_label, detail_label, queue_label

local ACTIONS = {
  MET = { name = "Meteor", r = 255, g = 110, b = 0 },
  MANA = { name = "Mana Rain", r = 0, g = 120, b = 255 },
  DBL = { name = "Double Damage", r = 255, g = 40, b = 40 },
  RST = { name = "Reset match", r = 200, g = 200, b = 200 },
}

local function paint_leds()
  local now = badge.sys.ms()
  if not radio_ok then
    badge.led.set_all(90, 0, 0)
    badge.led.show()
    return
  end
  if now < pulse_until then
    badge.led.set_all(pulse_rgb[1], pulse_rgb[2], pulse_rgb[3])
  else
    -- Idle: a dim purple pair at the top so the judge can see it is alive.
    badge.led.clear()
    badge.led.set(1, 20, 0, 30)
    badge.led.set(2, 20, 0, 30)
  end
  badge.led.show()
end

local function queue_send(payload)
  if #queue >= QUEUE_MAX then
    return false
  end
  queue[#queue + 1] = {
    payload = payload,
    left = SEND_REPEATS,
    next_at = badge.sys.ms(),
  }
  queued_total = queued_total + 1
  return true
end

-- Send at most one copy per tick. With a nominal 20 ms tick and 40 ms spacing
-- this keeps three copies inside roughly 120 ms without ever blocking.
local function pump_queue()
  local entry = queue[1]
  if not entry then
    return
  end

  local now = badge.sys.ms()
  if now < entry.next_at then
    return
  end

  if not badge.radio.send(entry.payload) then
    send_failures = send_failures + 1
  end

  entry.left = entry.left - 1
  if entry.left <= 0 then
    table.remove(queue, 1)
  else
    -- Derive the next slot from now, so a delayed tick does not cause a burst.
    entry.next_at = now + SEND_SPACING_MS
  end
end

local function fire(value)
  local action = ACTIONS[value]
  if not action then
    return
  end

  if not radio_ok then
    status_label:set_text("Radio unavailable")
    return
  end

  local now = badge.sys.ms()
  if now < next_action_at then
    status_label:set_text("Too fast - wait a moment")
    status_label:set_color(0xffcc55)
    return
  end
  next_action_at = now + ACTION_COOLDOWN_MS

  -- PA1|J|EVT|MANA|255 is 18 bytes at worst, well inside the 44 byte cap.
  local payload = "PA1|" .. SENDER .. "|EVT|" .. value .. "|" .. sequence
  sequence = (sequence + 1) % 256

  if queue_send(payload) then
    status_label:set_text(action.name .. " queued")
    status_label:set_color(0x66ff99)
    pulse_rgb = { action.r, action.g, action.b }
    pulse_until = now + PULSE_MS
  else
    status_label:set_text("Queue full - try again")
    status_label:set_color(0xffcc55)
  end

  -- "Queued" is the honest word: radio.send reports that the frame was accepted
  -- for transmission, never that anything received it.
  detail_label:set_text(payload)
  badge.sys.log("phantom_chaos queued " .. payload)
end

function on_enter(root)
  -- Radio first, widgets second. BLE needs about 47 KB on this ESP32-C3 and
  -- only ~78 KB is free at app start; building the UI first starved it and
  -- enable() failed on real hardware.
  badge.sys.log("phantom_chaos start fw=" .. badge.sys.version())
  radio_ok = badge.radio.enable()
  if radio_ok then
    badge.sys.log("phantom_chaos radio_ok mac=" .. badge.radio.mac())
  else
    badge.sys.log("phantom_chaos radio_enable_failed")
  end

  local title = badge.ui.label(root, "Phantom Chaos")
  title:style({ text_font = 20 })
  title:align("top_mid", 0, 8)

  status_label = badge.ui.label(root, "")
  status_label:align("top_mid", 0, 36)

  local menu = badge.ui.label(
    root,
    "A      Meteor\n" ..
    "B      Mana Rain\n" ..
    "START  Double Damage\n" ..
    "UP     Reset match"
  )
  menu:style({ text_font = 16 })
  menu:align("center", 0, 6)

  detail_label = badge.ui.label(root, "no packet sent yet")
  detail_label:style({ text_font = 14 })
  detail_label:align("bottom_mid", 0, -52)

  queue_label = badge.ui.label(root, "queue 0")
  queue_label:style({ text_font = 14 })
  queue_label:align("bottom_mid", 0, -32)

  local hint = badge.ui.label(root, "HOME exit   fw " .. badge.sys.version())
  hint:style({ text_font = 14 })
  hint:align("bottom_mid", 0, -12)

  if radio_ok then
    status_label:set_text("Ready")
    status_label:set_color(0x66ff99)
  else
    status_label:set_text("Radio unavailable - reboot badge")
    status_label:set_color(0xff6666)
  end

  paint_leds()
end

function on_tick()
  pump_queue()
  paint_leds()

  local now = badge.sys.ms()
  if now < next_ui then
    return
  end
  next_ui = now + UI_REFRESH_MS

  local text = "queue " .. #queue .. "   sent " .. queued_total
  if send_failures > 0 then
    text = text .. "   fail " .. send_failures
  end
  queue_label:set_text(text)
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then
    return
  end

  local B = badge.input.BUTTON
  if button == B.A then
    fire("MET")
  elseif button == B.B then
    fire("MANA")
  elseif button == B.START then
    fire("DBL")
  elseif button == B.UP then
    fire("RST")
  end
end

function on_exit()
  if radio_ok then
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
