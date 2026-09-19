--[==[badge-app
slug=phantom_player
name=Phantom Player
icon=PA
api=2
heap_kb=48
wake_lock=1
]==]

-- Phantom Arena: the player's wand.
--
-- One app serves both players. Pick a side on launch; the choice is remembered
-- between launches, so re-opening the app and pressing A is enough.
--
-- Controls in duel mode:
--   A      Fireball    20 mana, 900 ms
--   B      Shield      15 mana, 1400 ms
--   START  Arc Slash   10 mana, 500 ms
--   UP     Ultimate    60 mana, 5000 ms
--   DOWN   Ready       tell the host you are ready in the lobby
--
-- Gestures do the same thing as the buttons: thrust forward for Fireball, raise
-- for Shield, swing sideways for Arc Slash, shake for Ultimate.
--
-- HOME exits. HOME is deliberately not an action: its press is swallowed by the
-- launcher intercept and its default behaviour leaves the app mid-duel.
--
-- READY has its own button rather than sharing one with a spell, because the
-- radio only goes one way. This badge never learns the match phase, so it cannot
-- safely change its own mapping based on it. The host ignores a READY outside
-- the lobby and a cast outside play, so a mistimed press is harmless.
--
-- This badge deliberately knows NOTHING about game rules.
--
-- It used to keep its own mana and cooldown counters and refuse to send when they
-- said no. That is a bug, not a feature: the radio is one way, so those counters
-- can never be corrected. After the judge fires Mana Rain the host grants +40
-- mana, the badge never hears about it, and the player's Ultimate is silently
-- swallowed at the exact moment the projector says MANA RAIN.
--
-- What is left is a flat send-rate cap. That is radio hygiene, not a rule: it
-- stops a mashed button flooding a channel shared with every other badge in the
-- room, and it cannot disagree with the laptop because it does not model mana,
-- cooldowns, phases or damage at all.
--
-- radio.send reports that a frame was QUEUED, never that it arrived or landed.
-- The LEDs therefore mean "cast sent", and the projector is the only truth.

local SEND_REPEATS = 3
local SEND_SPACING_MS = 40
local QUEUE_MAX = 8
-- One packet per this long, whatever the button. Three copies of each packet is
-- already 3 frames; at 4 casts/second that is 12 frames/second from one badge.
local SEND_RATE_LIMIT_MS = 250
local UI_REFRESH_MS = 250
local ACCEL_SAMPLE_MS = 40
-- The LED strip is latched on a timer, not every tick. On pre-2026-09-16
-- firmware a tick only gets 6 ms, and a full clear/set/show every tick would
-- eat most of it.
local LED_REFRESH_MS = 50

-- ---------------------------------------------------------------------------
-- Gesture tuning. These are the ONLY numbers that need changing on hardware.
--
-- To tune: plug THIS badge into the laptop, open the app, and run
--     python tools/badge_monitor.py
-- Every gesture logs its peak magnitude, e.g. "gesture slash peak=820mg". Swing
-- the badge the way you will on stage, read the real numbers, then set the
-- threshold just under the peak of a deliberate motion. Reading exact values off
-- serial beats squinting at a 320x240 screen mid-swing.
-- ---------------------------------------------------------------------------
local GESTURE_THRESHOLD_MG = 700
local GESTURE_LOCKOUT_MS = 450
local BASELINE_SMOOTHING = 0.10

local SPELLS = {
  F = { name = "Fireball", r = 255, g = 90, b = 0 },
  S = { name = "Shield", r = 0, g = 200, b = 255 },
  A = { name = "Arc Slash", r = 170, g = 0, b = 255 },
  U = { name = "Ultimate", r = 255, g = 255, b = 255 },
}

local CHASE_ORDER = { 1, 2, 3, 4, 5, 6 }
local LEFT_SIDE = { 1, 6, 5 }
local RIGHT_SIDE = { 2, 3, 4 }

local mode = "select"
local side = "P1"
local radio_ok = false

local next_send_allowed = 0
local sequence = 0
local queue = {}
local send_failures = 0
local casts_sent = 0
local rate_limited = 0

local accel_ok = true
local base_x, base_y, base_z = 0, 0, 0
local baseline_ready = false
local next_accel = 0
local gesture_locked_until = 0

local effect_spell = nil
local effect_until = 0
local next_ui = 0
local next_led = 0
local last_tick_ms = 0

local ui_root
local select_label, select_hint
local side_label, status_label

-- ---------------------------------------------------------------------------
-- radio
-- ---------------------------------------------------------------------------

local function queue_send(payload)
  if #queue >= QUEUE_MAX then
    return false
  end
  queue[#queue + 1] = {
    payload = payload,
    left = SEND_REPEATS,
    next_at = badge.sys.ms(),
  }
  return true
end

-- One copy per tick at most. Three copies land inside roughly 120 ms without
-- ever blocking a callback: there is no sleep on this badge.
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
    -- Derive the next slot from now so a late tick does not cause a burst.
    entry.next_at = now + SEND_SPACING_MS
  end
end

local function next_sequence()
  local value = sequence
  sequence = (sequence + 1) % 256
  return value
end

-- ---------------------------------------------------------------------------
-- LEDs
-- ---------------------------------------------------------------------------

local function paint_group(group, r, g, b)
  for index = 1, #group do
    badge.led.set(group[index], r, g, b)
  end
end

local function paint_leds()
  local now = badge.sys.ms()

  if mode == "select" then
    badge.led.clear()
    if side == "P1" then
      paint_group(LEFT_SIDE, 120, 0, 0)
    else
      paint_group(RIGHT_SIDE, 0, 40, 120)
    end
    badge.led.show()
    return
  end

  if not radio_ok then
    badge.led.set_all(90, 0, 0)
    badge.led.show()
    return
  end

  if effect_spell and now < effect_until then
    local spell = SPELLS[effect_spell]
    local remaining = effect_until - now
    badge.led.clear()

    if effect_spell == "F" then
      -- Orange chase, one step every 60 ms.
      local step = (math.floor(now / 60) % 6) + 1
      badge.led.set(CHASE_ORDER[step], spell.r, spell.g, spell.b)
      local trail = ((step - 2) % 6) + 1
      badge.led.set(CHASE_ORDER[trail], 60, 20, 0)
    elseif effect_spell == "S" then
      -- Cyan dome that fades out.
      local scale = remaining / 500
      if scale > 1 then
        scale = 1
      end
      badge.led.set_all(
        math.floor(spell.r * scale),
        math.floor(spell.g * scale),
        math.floor(spell.b * scale)
      )
    elseif effect_spell == "A" then
      -- Purple sweep: left side then right side.
      if remaining > 200 then
        paint_group(LEFT_SIDE, spell.r, spell.g, spell.b)
      else
        paint_group(RIGHT_SIDE, spell.r, spell.g, spell.b)
      end
    else
      -- Ultimate: full white burst.
      badge.led.set_all(spell.r, spell.g, spell.b)
    end

    badge.led.show()
    return
  end

  effect_spell = nil

  -- Idle: your side colour, dim, on your side of the badge.
  badge.led.clear()
  if side == "P1" then
    paint_group(LEFT_SIDE, 40, 0, 0)
  else
    paint_group(RIGHT_SIDE, 0, 12, 40)
  end
  badge.led.show()
end

-- ---------------------------------------------------------------------------
-- casting
-- ---------------------------------------------------------------------------

local function set_status(text, color)
  if status_label then
    status_label:set_text(text)
    status_label:set_color(color)
  end
end

local function cast(spell_key)
  local spell = SPELLS[spell_key]
  if not spell then
    return
  end

  if not radio_ok then
    set_status("Radio unavailable", 0xff6666)
    return
  end

  local now = badge.sys.ms()

  -- The ONLY gate on this badge. Not a cooldown, not a mana check: purely a cap
  -- on how fast we are allowed to occupy a shared radio channel. Whether the
  -- spell is legal is the laptop's decision, and it will reject it there.
  if now < next_send_allowed then
    rate_limited = rate_limited + 1
    set_status("Easy - too fast", 0xffcc55)
    return
  end
  next_send_allowed = now + SEND_RATE_LIMIT_MS

  local payload = "PA1|" .. side .. "|CAST|" .. spell_key .. "|" .. next_sequence()
  if queue_send(payload) then
    casts_sent = casts_sent + 1
    effect_spell = spell_key
    effect_until = now + 500
    -- "Sent", not "hit": the laptop decides whether anything landed.
    set_status(spell.name .. " sent", 0x66ff99)
    badge.sys.log("phantom_player queued " .. payload)
  else
    set_status("Queue full", 0xffcc55)
  end
end

local function send_ready()
  if not radio_ok then
    return
  end
  local now = badge.sys.ms()
  if now < next_send_allowed then
    return
  end
  next_send_allowed = now + SEND_RATE_LIMIT_MS

  local payload = "PA1|" .. side .. "|READY|1|" .. next_sequence()
  if queue_send(payload) then
    set_status("Ready sent - waiting for host", 0x66ff99)
    badge.sys.log("phantom_player queued " .. payload)
  end
end

-- ---------------------------------------------------------------------------
-- gestures
-- ---------------------------------------------------------------------------

-- Tuning channel. Plug this badge into the laptop and run
-- tools/badge_monitor.py to read real peak magnitudes while you swing it.
local function log_gesture(name, peak_mg)
  badge.sys.log(
    "phantom_player gesture " .. name ..
    " peak=" .. math.floor(peak_mg) .. "mg" ..
    " threshold=" .. GESTURE_THRESHOLD_MG
  )
end

local function sample_accel()
  local now = badge.sys.ms()
  if now < next_accel then
    return
  end
  next_accel = now + ACCEL_SAMPLE_MS

  -- Readings are already cached at 50 Hz; this only paces our own use of them.
  local x, y, z = badge.sensor.accel()
  if not x then
    if accel_ok then
      accel_ok = false
      set_status("No accelerometer - use buttons", 0xffcc55)
      badge.sys.log("phantom_player accel_unavailable")
    end
    return
  end

  if not accel_ok then
    accel_ok = true
  end

  if not baseline_ready then
    base_x, base_y, base_z = x, y, z
    baseline_ready = true
    return
  end

  local dx = x - base_x
  local dy = y - base_y
  local dz = z - base_z

  -- Shake is checked first and shares one lockout with the threshold gestures.
  -- A shake energetic enough to trip shake() also crosses every axis threshold,
  -- so per-gesture refractory alone would fire two spells from one motion.
  if now >= gesture_locked_until then
    local ax, ay, az = dx, dy, dz
    if ax < 0 then ax = -ax end
    if ay < 0 then ay = -ay end
    if az < 0 then az = -az end

    local peak = ax
    if ay > peak then peak = ay end
    if az > peak then peak = az end

    if badge.sensor.shake() then
      gesture_locked_until = now + GESTURE_LOCKOUT_MS
      log_gesture("shake", peak)
      cast("U")
      return
    end

    if peak >= GESTURE_THRESHOLD_MG then
      -- Consume the lockout on DETECTION, not on a successful send, so a gesture
      -- during the rate limit does not re-fire on every later sample.
      gesture_locked_until = now + GESTURE_LOCKOUT_MS

      if ay >= ax and ay >= az and dy > 0 then
        log_gesture("thrust", peak)
        cast("F")
        return
      elseif az >= ax and az >= ay and dz > 0 then
        log_gesture("raise", peak)
        cast("S")
        return
      elseif ax >= ay and ax >= az then
        log_gesture("slash", peak)
        cast("A")
        return
      end
    end
  end

  -- Low-pass the baseline only while resting, so gravity in any orientation is
  -- absorbed automatically and no manual calibration step is needed.
  base_x = base_x + (x - base_x) * BASELINE_SMOOTHING
  base_y = base_y + (y - base_y) * BASELINE_SMOOTHING
  base_z = base_z + (z - base_z) * BASELINE_SMOOTHING
end

-- ---------------------------------------------------------------------------
-- lifecycle
-- ---------------------------------------------------------------------------

local function build_select_ui(root)
  select_label = badge.ui.label(root, "")
  select_label:style({ text_font = 24 })
  select_label:align("center", 0, -20)

  select_hint = badge.ui.label(
    root,
    "LEFT / RIGHT choose side\nA confirm     HOME exit"
  )
  select_hint:style({ text_font = 16 })
  select_hint:align("center", 0, 50)
end

local function refresh_select()
  if side == "P1" then
    select_label:set_text("P1   red")
    select_label:set_color(0xff4d4d)
  else
    select_label:set_text("P2   blue")
    select_label:set_color(0x4d9dff)
  end
end

local function build_duel_ui(root)
  -- Two widgets. Nobody reads a 320x240 panel with their arm extended mid-duel,
  -- and the projector shows everything that matters. The status line exists for
  -- exactly one job the radio cannot do: telling you the radio is broken.
  side_label = badge.ui.label(root, "")
  side_label:style({ text_font = 24 })
  side_label:align("top_mid", 0, 20)

  status_label = badge.ui.label(
    root,
    "DOWN ready   A fire   B shield\nSTART slash   UP ult"
  )
  status_label:style({ text_font = 16 })
  status_label:align("center", 0, 20)
end

function on_enter(root)
  last_tick_ms = badge.sys.ms()
  ui_root = root

  -- Radio first, widgets second.
  --
  -- On this ESP32-C3 the BLE stack needs about 47 KB and only ~78 KB is free
  -- when an app opens. This app used to build the select screen AND the duel
  -- screen before enabling the radio, which left BLE short and made enable()
  -- fail with "hal_radio: host sync timeout". The duel screen is now built on
  -- demand in enter_duel() so nothing is allocated before it is needed.
  badge.sys.log("phantom_player start fw=" .. badge.sys.version())

  radio_ok = badge.radio.enable()
  if radio_ok then
    badge.sys.log("phantom_player radio_ok mac=" .. badge.radio.mac())
  else
    badge.sys.log("phantom_player radio_enable_failed")
  end

  build_select_ui(root)

  side = badge.store.get_str("side", "P1")
  if side ~= "P1" and side ~= "P2" then
    side = "P1"
  end

  mode = "select"
  refresh_select()
  paint_leds()
end

local function enter_duel()
  mode = "duel"
  badge.store.set_str("side", side)

  -- Free the select screen before allocating the duel screen, so peak widget
  -- and heap use stays flat rather than holding both at once.
  select_label:delete()
  select_hint:delete()
  select_label = nil
  select_hint = nil

  build_duel_ui(ui_root)

  if side == "P1" then
    side_label:set_text("P1")
    side_label:set_color(0xff4d4d)
  else
    side_label:set_text("P2")
    side_label:set_color(0x4d9dff)
  end

  if not radio_ok then
    status_label:set_text("Radio unavailable - reboot badge")
    status_label:set_color(0xff6666)
  end

  badge.sys.log("phantom_player side=" .. side)
end

function on_tick()
  local now = badge.sys.ms()
  local elapsed = now - last_tick_ms
  if elapsed < 0 then
    elapsed = 0
  end
  last_tick_ms = now

  pump_queue()

  if mode == "duel" then
    sample_accel()
  end

  if now >= next_led then
    next_led = now + LED_REFRESH_MS
    paint_leds()
  end

  if now < next_ui then
    return
  end
  next_ui = now + UI_REFRESH_MS

  if mode ~= "duel" then
    return
  end

  -- Side plus a send counter is all the on-badge telemetry anyone needs. The
  -- detailed numbers go to serial, where they can actually be read.
  side_label:set_text(side .. "   sent " .. casts_sent)
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then
    return
  end

  local B = badge.input.BUTTON

  if mode == "select" then
    if button == B.LEFT then
      side = "P1"
      refresh_select()
      paint_leds()
    elseif button == B.RIGHT then
      side = "P2"
      refresh_select()
      paint_leds()
    elseif button == B.A then
      enter_duel()
    end
    return
  end

  if button == B.A then
    cast("F")
  elseif button == B.B then
    cast("S")
  elseif button == B.START then
    cast("A")
  elseif button == B.UP then
    cast("U")
  elseif button == B.DOWN then
    send_ready()
  end
end

function on_exit()
  if mode == "duel" then
    badge.store.set_str("side", side)
  end
  if radio_ok then
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end
