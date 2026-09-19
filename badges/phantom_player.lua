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
-- The mana and cooldown numbers here are a LOCAL ESTIMATE for feedback only. The
-- laptop is the only authority, and radio.send reports that a frame was queued,
-- never that it arrived or that a hit landed.

local MANA_MAX = 100
local MANA_REGEN_PER_SECOND = 8
local SEND_REPEATS = 3
local SEND_SPACING_MS = 40
local QUEUE_MAX = 8
local UI_REFRESH_MS = 100
local ACCEL_SAMPLE_MS = 40

-- ---------------------------------------------------------------------------
-- Gesture tuning. These are the ONLY numbers that need changing on hardware.
-- Sample the live readout at the bottom of the duel screen while holding the
-- badge in the orientation you will use on stage, then set the threshold just
-- below the peak of a deliberate motion.
-- ---------------------------------------------------------------------------
local GESTURE_THRESHOLD_MG = 700
local GESTURE_LOCKOUT_MS = 450
local BASELINE_SMOOTHING = 0.10

local SPELLS = {
  F = { name = "Fireball", cost = 20, cooldown = 900, r = 255, g = 90, b = 0 },
  S = { name = "Shield", cost = 15, cooldown = 1400, r = 0, g = 200, b = 255 },
  A = { name = "Arc Slash", cost = 10, cooldown = 500, r = 170, g = 0, b = 255 },
  U = { name = "Ultimate", cost = 60, cooldown = 5000, r = 255, g = 255, b = 255 },
}

local CHASE_ORDER = { 1, 2, 3, 4, 5, 6 }
local LEFT_SIDE = { 1, 6, 5 }
local RIGHT_SIDE = { 2, 3, 4 }

local mode = "select"
local side = "P1"
local radio_ok = false

local mana = MANA_MAX
local cooldown_until = { F = 0, S = 0, A = 0, U = 0 }
local sequence = 0
local queue = {}
local send_failures = 0
local casts_sent = 0

local accel_ok = true
local base_x, base_y, base_z = 0, 0, 0
local baseline_ready = false
local next_accel = 0
local gesture_locked_until = 0
local last_gesture = "-"

local effect_spell = nil
local effect_until = 0
local next_ui = 0
local last_tick_ms = 0

local select_label, select_hint
local side_label, mana_label, spell_label, status_label, accel_label

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

local function cast(spell_key)
  local spell = SPELLS[spell_key]
  if not spell then
    return
  end

  if not radio_ok then
    status_label:set_text("Radio unavailable")
    status_label:set_color(0xff6666)
    return
  end

  local now = badge.sys.ms()
  if now < cooldown_until[spell_key] then
    status_label:set_text(spell.name .. " cooling down")
    status_label:set_color(0xffcc55)
    return
  end
  if mana < spell.cost then
    status_label:set_text("Not enough mana for " .. spell.name)
    status_label:set_color(0xffcc55)
    return
  end

  mana = mana - spell.cost
  cooldown_until[spell_key] = now + spell.cooldown
  gesture_locked_until = now + GESTURE_LOCKOUT_MS

  local payload = "PA1|" .. side .. "|CAST|" .. spell_key .. "|" .. next_sequence()
  if queue_send(payload) then
    casts_sent = casts_sent + 1
    effect_spell = spell_key
    effect_until = now + 500
    -- "Sent", not "hit": the laptop decides whether anything landed.
    status_label:set_text(spell.name .. " sent")
    status_label:set_color(0x66ff99)
    spell_label:set_text(spell.name)
    badge.sys.log("phantom_player queued " .. payload)
  else
    status_label:set_text("Queue full")
    status_label:set_color(0xffcc55)
  end
end

local function send_ready()
  if not radio_ok then
    return
  end
  local payload = "PA1|" .. side .. "|READY|1|" .. next_sequence()
  if queue_send(payload) then
    status_label:set_text("Ready sent - waiting for host")
    status_label:set_color(0x66ff99)
    badge.sys.log("phantom_player queued " .. payload)
  end
end

-- ---------------------------------------------------------------------------
-- gestures
-- ---------------------------------------------------------------------------

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
      accel_label:set_text("Accelerometer unavailable - use buttons")
      accel_label:set_color(0xffcc55)
    end
    return
  end

  if not accel_ok then
    accel_ok = true
    accel_label:set_color(0xffffff)
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
    if badge.sensor.shake() then
      last_gesture = "shake"
      -- Consume the shake even when it cannot pay for the Ultimate, otherwise it
      -- falls through and triggers a cheaper spell from the same motion.
      gesture_locked_until = now + GESTURE_LOCKOUT_MS
      if mana >= SPELLS.U.cost then
        cast("U")
      else
        status_label:set_text("Not enough mana for Ultimate")
        status_label:set_color(0xffcc55)
      end
      return
    end

    local ax, ay, az = dx, dy, dz
    if ax < 0 then ax = -ax end
    if ay < 0 then ay = -ay end
    if az < 0 then az = -az end

    if ax >= GESTURE_THRESHOLD_MG or ay >= GESTURE_THRESHOLD_MG
        or az >= GESTURE_THRESHOLD_MG then
      if ay >= ax and ay >= az and dy > 0 then
        last_gesture = "thrust"
        cast("F")
        return
      elseif az >= ax and az >= ay and dz > 0 then
        last_gesture = "raise"
        cast("S")
        return
      elseif ax >= ay and ax >= az then
        last_gesture = "slash"
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
  side_label = badge.ui.label(root, "")
  side_label:style({ text_font = 24 })
  side_label:align("top_mid", 0, 8)

  mana_label = badge.ui.label(root, "mana 100")
  mana_label:style({ text_font = 20 })
  mana_label:align("top_mid", 0, 42)

  spell_label = badge.ui.label(root, "no cast yet")
  spell_label:style({ text_font = 18 })
  spell_label:align("top_mid", 0, 70)

  status_label = badge.ui.label(root, "DOWN sends ready")
  status_label:style({ text_font = 14 })
  status_label:align("top_mid", 0, 96)

  local hint = badge.ui.label(
    root,
    "A fire   B shield   START slash   UP ult   DOWN ready"
  )
  hint:style({ text_font = 14 })
  hint:align("bottom_mid", 0, -30)

  accel_label = badge.ui.label(root, "reading sensor")
  accel_label:style({ text_font = 14 })
  accel_label:align("bottom_mid", 0, -12)
end

function on_enter(root)
  last_tick_ms = badge.sys.ms()

  build_select_ui(root)
  build_duel_ui(root)

  side = badge.store.get_str("side", "P1")
  if side ~= "P1" and side ~= "P2" then
    side = "P1"
  end

  badge.sys.log("phantom_player start fw=" .. badge.sys.version())

  radio_ok = badge.radio.enable()
  if not radio_ok then
    badge.sys.log("phantom_player radio_enable_failed")
  else
    badge.sys.log("phantom_player radio_ok mac=" .. badge.radio.mac())
  end

  mode = "select"
  refresh_select()

  side_label:hidden(true)
  mana_label:hidden(true)
  spell_label:hidden(true)
  status_label:hidden(true)
  accel_label:hidden(true)

  paint_leds()
end

local function enter_duel()
  mode = "duel"
  badge.store.set_str("side", side)

  select_label:hidden(true)
  select_hint:hidden(true)

  side_label:hidden(false)
  mana_label:hidden(false)
  spell_label:hidden(false)
  status_label:hidden(false)
  accel_label:hidden(false)

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
    -- Local estimate only. Fractional regeneration is kept so 8 mana/second
    -- still accumulates on a short tick.
    mana = mana + MANA_REGEN_PER_SECOND * elapsed / 1000
    if mana > MANA_MAX then
      mana = MANA_MAX
    end
    sample_accel()
  end

  paint_leds()

  if now < next_ui then
    return
  end
  next_ui = now + UI_REFRESH_MS

  if mode ~= "duel" then
    return
  end

  mana_label:set_text("mana " .. math.floor(mana) .. "   sent " .. casts_sent)
  if accel_ok then
    accel_label:set_text(
      "gesture " .. last_gesture ..
      "   queue " .. #queue ..
      "   fail " .. send_failures
    )
  end
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
