-- Phantom Arena game module (loaded by main.lua AFTER the radio is up, so Bluetooth gets a clean heap).
-- Hold A, draw, release to cast. While holding A: UP/B/DOWN/START/LEFT/RIGHT pick a spell directly.
-- LEFT/RIGHT target, UP/DOWN item, B use item, START menu, HOME exit. Tap = Jab, shake = Burst,
-- face-down = Ward. Lowest MAC heard in 3 s hosts; host resolves casts, broadcasts state at 4 Hz.
local M = {}

local floor, min, max, abs = math.floor, math.min, math.max, math.abs
local sfmt, ssub, schar, supper = string.format, string.sub, string.char, string.upper
local NEAR, REVEAL, ENTER_MG, EXIT_MG = -58, -62, 450, 250
local IDLE_TXT = "Hold A, draw a spell, release A"

local SPELLS = {
  { id = "L", name = "LIGHTNING", g = "LT", hint = "flick up", gest = "+Y -Y", dmg = 18, cd = 1500, kind = "dmg", range = "any", col = 0x508cff, btn = "UP" },
  { id = "F", name = "FIREBALL", g = "FB", hint = "push fwd", gest = "-Z +Z", dmg = 34, cd = 4000, kind = "dmg", range = "fall", col = 0xff5a00, btn = "B" },
  { id = "W", name = "WARD", g = "WD", hint = "flick dn", gest = "-Y +Y", dmg = 0, cd = 6000, kind = "ward", range = "self", col = 0x00c8ff, btn = "DOWN" },
  { id = "V", name = "VORTEX", g = "VX", hint = "circle", gest = "+X +Y -X -Y", dmg = 12, cd = 5000, kind = "aoe", range = "near", col = 0xb400ff, btn = "START" },
  { id = "H", name = "HEAL", g = "HL", hint = "flick L", gest = "-X +X", dmg = 25, cd = 7000, kind = "heal", range = "self", col = 0x00ff5a, btn = "LEFT" },
  { id = "P", name = "PHASE", g = "PH", hint = "flick R", gest = "+X -X", dmg = 0, cd = 12000, kind = "hide", range = "self", col = 0x783cc8, btn = "RIGHT" },
  { id = "J", name = "JAB", g = "JB", hint = "tap", gest = "", dmg = 10, cd = 600, kind = "dmg", range = "near", col = 0xffffff },
  { id = "B", name = "BURST", g = "BS", hint = "shake", gest = "", dmg = 8, cd = 8000, kind = "aoe", range = "near", col = 0xffdc00 },
}
local ITEMS = { { id = "p", name = "Potion", kind = "heal" }, { id = "e", name = "Ember Core", kind = "dmgup" }, { id = "k", name = "Phase Cloak", kind = "hide" } }
local BY = {}
for _, sp in ipairs(SPELLS) do BY[sp.id] = sp end
for _, it in ipairs(ITEMS) do BY[it.id] = it end
local ALIAS = { potion = "p", ember = "e", cloak = "k" }
local TEAM = { ["0"] = "Solo", ["1"] = "Red", ["2"] = "Blue", ["3"] = "Green", ["4"] = "Gold" }
local TCOL = { 0x9696aa, 0xff2828, 0x285aff, 0x28dc50, 0xffc800 }
local RAINBOW = { 0xff0000, 0xff9600, 0xffff00, 0x00ff00, 0x0078ff, 0xaa00ff }
local EMSG = { H = "%s %s %s -%d", M = "%s %s missed %s", W = "%s %s warded by %s", G = "%s raises a ward",
  V = "%s vanishes", L = "%s %s %s +%d", K = "%s %s KO %s!", R = "%s respawns", I = "%s uses %s" }
local MENU = { "Start match: Duel", "Start match: Teams", "Start match: Raid", "Become the Phantom", "Switch team", "Teach a spell", "Shrine: NFC loot" }
-- trigger|type|value|seconds|title|text   value: dmg/cd = multiplier x10, heal = percent
local DECK0 = [[
low|heal|30|0|Mercy of the Veil|The Phantom pities the weak: all heal 30%.
low|dmg|20|15|Blood Frenzy|Wounds sing. Damage doubled for 15 s.
stale|fog|0|12|Whispering Fog|Fog swallows the arena. Get close to see.
stale|cd|5|15|Quickening|Time bends. Cooldowns halved for 15 s.
timer|dmg|15|12|Sharpened Runes|Every spell bites harder: x1.5 for 12 s.
timer|heal|20|0|Second Wind|A cool wind. Everyone recovers 20%.
boss|dmg|20|20|Phantom Rage|The Phantom is enraged. Damage doubled.
]]

local my = { mac = "", id = "0000", name = "Mage", team = "0", role = "M", hp = 100, st = 0 }
local peers, order, deck, templates = {}, {}, {}, {}
local view = { phase = "L", mode = "D", decree = 0, dec_until = 0, cd_mult = 1, host = "", host_mac = "", target = nil }
local host, radio_ok, nfc_ok, accel_ok = nil, false, false, true
local rxq, seen, resend = {}, {}, {}
local cast_seq, dirty = 0, true
local cd_until, cd_len, arc_val = {}, {}, {}
local inv, inv_sel = { p = 0, e = 0, k = 0 }, 1
local stats, stats_dirty = { kills = 0, deaths = 0, matches = 0, loot = 0 }, false
local screen, ui, logs = "arena", {}, { "", "" }
local gest = { on = false, syms = {}, above = false, peak = 0, psym = "+Y", start = 0, forced = nil,
               gx = 0, gy = 0, gz = 0, gok = false, released = 0, shown = 0 }
local led = { fx = nil, till = 0, len = 1, col = 0xffffff, next = 0 }
local teach, shrine, menu_sel = { spell = 1, tries = {} }, { uid = nil, poll = 0 }, 1
local next_hk, next_elect, next_render, next_orient, flat_since = 0, 0, 0, 0, 0

-- ===== helpers =====
local function now_ms() return badge.sys.ms() end
local function clamp(n, lo, hi) if n < lo then return lo elseif n > hi then return hi end return n end
local function hex2(n) return sfmt("%02X", floor(clamp(n, 0, 255))) end
local function unhex(s) return tonumber(s or "", 16) end
local function id_of(mac) return supper(ssub((string.gsub(mac or "", ":", "")), -4)) end
local function pad4(s) s = ssub(tostring(s), 1, 4); while #s < 4 do s = "0" .. s end return s end
local function mode_name(m) return m == "T" and "Teams" or m == "R" and "Raid" or "Duel" end

local function log_mem(tag)
  local st = badge.sys.stats()
  badge.sys.log(sfmt("PAMEM|%s|lua=%d/%d peak=%d free_heap=%d", tag, st.lua_used, st.lua_limit, st.lua_peak, st.free_heap))
end

local function clean_name(n)
  n = string.gsub(tostring(n or ""), "[^A-Za-z0-9 ]", "")
  n = string.gsub(ssub((string.gsub(n, "^%s+", "")), 1, 10), "%s+$", "")
  return n == "" and "Mage" or n
end

local function reorder()
  order = {}
  for k in pairs(peers) do if k ~= my.id then order[#order + 1] = k end end
  table.sort(order)
  dirty = true
end

local function get_peer(id)
  local pe = peers[id]
  if not pe then
    pe = { id = id, mac = "", name = "????", team = "0", role = "M", hp = 100, st = 0, seen = 0, rssi = -99 }
    peers[id] = pe
    reorder()
  end
  return pe
end

local function name_of(id)
  if id == my.id then return my.name end
  local pe = peers[id]
  return pe and pe.name or "????"
end

local function log_push(t)
  logs[1], logs[2] = logs[2], ssub(t, 1, 44)
  if ui.log1 then ui.log1:set_text(logs[1]); ui.log2:set_text(logs[2]) end
end

local function show_gesture(t)
  if ui.gest and screen == "arena" then ui.gest:set_text(ssub(t, 1, 44)) end
  gest.shown = now_ms() + 2500
end

local function save_inv() badge.store.set_str("inv", "p" .. inv.p .. "e" .. inv.e .. "k" .. inv.k) end

local function save_stats()
  if not stats_dirty then return end
  stats_dirty = false
  for k, v in pairs(stats) do badge.store.set_int(k, v) end
end

-- ===== LEDs =====
local function led_flash(col, ms) led.fx, led.col, led.len, led.till = "flash", col, ms, now_ms() + ms end
local function led_effect(name, ms) led.fx, led.len, led.till = name, ms, now_ms() + ms end
local function breath(now, period) local w = (now % period) / (period / 2); return w <= 1 and w or 2 - w end
local function led_all(c, k) badge.led.set_all(floor((c >> 16) * k), floor(((c >> 8) & 255) * k), floor((c & 255) * k)) end

local function led_frame(now)
  if now < led.next then return end
  led.next = now + 50
  badge.led.clear()
  local fx = led.fx
  if fx and now >= led.till then led.fx = nil; fx = nil end
  if fx == "flash" then led_all(led.col, clamp((led.till - now) / led.len, 0, 1))
  elseif fx == "rainbow" then
    local step = floor(now / 70)
    for i = 1, 6 do local c = RAINBOW[(step + i) % 6 + 1]; badge.led.set(i, c >> 16, (c >> 8) & 255, c & 255) end
  elseif fx == "gold" then
    for i = 1, 6 do local on = (floor(now / 90) + i) % 3 == 0; badge.led.set(i, on and 255 or 60, on and 200 or 40, 0) end
  elseif gest.on then
    for i = 1, clamp(floor((now - gest.start) / 250) + 1, 1, 6) do badge.led.set(i, 190, 110, 255) end
  elseif my.hp <= 0 then led_all(0xffffff, 0.08 + 0.15 * breath(now, 3000))
  elseif my.st % 2 == 1 then led_all(0x0099ff, 0.25 + 0.75 * breath(now, 1600))
  elseif my.st % 4 >= 2 then led_all(0x6000b0, 0.3)
  elseif my.hp <= 25 then
    local t = now % 1000
    led_all(0xff0000, (t < 120 or (t >= 250 and t < 370)) and 1 or 0.1)
  else led_all(TCOL[tonumber(my.team) + 1], 0.08 + 0.25 * breath(now, 2600)) end
  badge.led.show()
end

-- ===== gestures =====
local function tokens(s)
  local t = {}
  for w in string.gmatch(s or "", "[+-][XYZ]") do t[#t + 1] = w end
  return t
end

local function edit_dist(a, b)
  local la, lb = #a, #b
  if la == 0 or lb == 0 then return la + lb end
  local prev, cur = {}, {}
  for j = 0, lb do prev[j] = j end
  for i = 1, la do
    cur[0] = i
    for j = 1, lb do cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + ((a[i] == b[j]) and 0 or 1)) end
    prev, cur = cur, prev
  end
  return prev[lb]
end

local function match_gesture(syms)
  local best, bestd, bestfirst = nil, 99, false
  if #syms == 0 then return nil end
  for _, sp in ipairs(SPELLS) do
    local t = templates[sp.id]
    if #t > 0 then
      local d, first = edit_dist(syms, t), t[1] == syms[1]
      if d <= max(1, floor(#t / 2)) and (d < bestd or (d == bestd and first and not bestfirst)) then best, bestd, bestfirst = sp, d, first end
    end
  end
  return best
end

local function gest_tick()
  local x, y, z = badge.sensor.accel()
  if not x then accel_ok = false; return end
  accel_ok = true
  if not gest.gok then gest.gx, gest.gy, gest.gz, gest.gok = x, y, z, true end
  local a = gest.on and 0.02 or 0.08
  gest.gx, gest.gy, gest.gz = gest.gx + (x - gest.gx) * a, gest.gy + (y - gest.gy) * a, gest.gz + (z - gest.gz) * a
  if not gest.on then return end
  x, y, z = x - gest.gx, y - gest.gy, z - gest.gz
  local ax, ay, az = abs(x), abs(y), abs(z)
  local s, m
  if ax >= ay and ax >= az then s, m = (x > 0 and "+X" or "-X"), ax
  elseif ay >= az then s, m = (y > 0 and "+Y" or "-Y"), ay
  else s, m = (z > 0 and "+Z" or "-Z"), az end
  if not gest.above then
    if m > ENTER_MG then gest.above, gest.peak, gest.psym = true, m, s end
  else
    if m > gest.peak then gest.peak, gest.psym = m, s end
    if m < EXIT_MG then
      gest.above = false
      if #gest.syms < 8 then gest.syms[#gest.syms + 1] = gest.psym end
    end
  end
end

-- ===== radio =====
local function queue_send(p, times)
  if #p > 44 then badge.sys.log("PA|oversize|" .. p); return end
  if radio_ok then badge.radio.send(p) end
  if times > 1 then
    if #resend >= 12 then table.remove(resend, 1) end
    resend[#resend + 1] = { p = p, left = times - 1, at = now_ms() + 100 }
  end
end

local function seen_recently(p, now)
  for i = #seen, 1, -1 do
    if now - seen[i].at > 2500 then table.remove(seen, i) elseif seen[i].p == p then return true end
  end
  seen[#seen + 1] = { p = p, at = now }
  if #seen > 24 then table.remove(seen, 1) end
  return false
end

local function send_heartbeat()
  queue_send("PAH" .. my.id .. my.team .. my.role .. view.mode .. (host and "1" or "0") .. my.name, 1)
end

local function targetable(pe)
  return pe ~= nil and pe.id ~= my.id and pe.hp > 0 and not (view.mode == "T" and pe.team == my.team)
    and not (pe.st % 4 >= 2 and pe.rssi < REVEAL)
end

local function current_target()
  local pe = view.target and peers[view.target]
  if targetable(pe) then return pe end
  for _, id in ipairs(order) do
    if targetable(peers[id]) then view.target, dirty = id, true; return peers[id] end
  end
  if view.target then view.target, dirty = nil, true end
  return nil
end

local function cycle_target(dir)
  local idx = 1
  for i, id in ipairs(order) do if id == view.target then idx = i end end
  for _ = 1, #order do
    idx = ((idx - 1 + dir) % #order) + 1
    if targetable(peers[order[idx]]) then view.target, dirty = order[idx], true; return end
  end
end

-- ===== client-side events =====
local function view_apply(id, hp, st)
  local pe = get_peer(id)
  if pe.hp ~= hp or pe.st ~= st then pe.hp, pe.st, dirty = hp, st, true end
  if id == my.id then my.hp, my.st = hp, st end
end

local function decree_view(idx, dur, now)
  local card = deck[idx]
  view.decree, view.dec_until, view.cd_mult = idx, now + dur * 1000, 1
  if card then
    if card.type == "cd" then view.cd_mult = max(0.2, card.val / 10) end
    log_push("DECREE: " .. card.title)
    log_push(card.text)
  end
  led_effect("gold", 1500)
  dirty = true
end

local function handle_E(p, now)
  local k, a, b, v, s = ssub(p, 4, 4), ssub(p, 7, 10), ssub(p, 11, 14), unhex(ssub(p, 15, 16)) or 0, ssub(p, 17, 17)
  local an, bn, sp = name_of(a), name_of(b), BY[s]
  if EMSG[k] then log_push(sfmt(EMSG[k], an, sp and sp.name or "?", bn, v)) end
  if k == "H" then
    if b == my.id then led_flash(0xff0000, 350) elseif a == my.id and sp then led_flash(sp.col, 250) end
  elseif k == "L" then
    if b == my.id then led_flash(0x00ff5a, 400) end
  elseif k == "K" then
    if a == my.id then stats.kills, stats_dirty = stats.kills + 1, true; led_effect("rainbow", 2000)
    elseif b == my.id then stats.deaths, stats_dirty = stats.deaths + 1, true end
  elseif k == "S" then
    view.phase, view.mode = "F", s
    log_push("MATCH START: " .. mode_name(s))
    led_effect("gold", 1200)
  elseif k == "O" then
    view.phase = "O"
    local w = a == "MAGE" and "The mages" or a == "BOSS" and "The Phantom" or a == "NONE" and "Nobody"
      or ssub(a, 1, 2) == "TM" and ("Team " .. (TEAM[ssub(a, 3, 3)] or "?")) or an
    log_push("MATCH OVER: " .. w .. " wins")
    stats.matches, stats_dirty = stats.matches + 1, true
    led_effect((a == my.id or a == "TM" .. my.team .. "0" or (a == "MAGE") == (my.role ~= "B")) and "rainbow" or "gold", 3000)
    save_stats()
  elseif k == "D" then decree_view(v, tonumber(b) or 0, now)
  elseif k == "B" then log_push("THE PHANTOM IS ENRAGED (" .. v .. "%)"); led_flash(0xff0028, 600) end
  dirty = true
end

-- ===== host (authoritative) =====
local function player(id)
  local pl = host.players[id]
  if not pl then
    pl = { id = id, hp = 100, maxhp = 100, st = 0, ward = 0, hide = 0, dmgup = false, last = {}, dead_at = 0 }
    host.players[id] = pl
  end
  return pl
end

local function emit(kind, a, b, v, s, times)
  host.eseq = (host.eseq + 1) % 256
  local p = "PAE" .. kind .. hex2(host.eseq) .. pad4(a) .. pad4(b) .. hex2(v or 0) .. ssub(tostring(s or "-") .. "-", 1, 1)
  queue_send(p, times or 1)
  handle_E(p, now_ms())
end

local function alive()
  local n, last, teams, nt, boss, mages, total = 0, "NONE", {}, 0, false, 0, 0
  for id, pl in pairs(host.players) do
    total = total + 1
    if pl.hp > 0 then
      local pe = peers[id]
      n, last = n + 1, id
      if pe and pe.role == "B" then boss = true else mages = mages + 1 end
      local t = pe and pe.team or "0"
      if not teams[t] then teams[t], nt = true, nt + 1 end
    end
  end
  return n, last, nt, boss, mages, total
end

local function reset_players(mode, total)
  for id, pl in pairs(host.players) do
    local pe = peers[id]
    pl.maxhp = (mode == "R" and pe and pe.role == "B") and (250 + 100 * max(0, total - 1)) or 100
    pl.hp, pl.ward, pl.hide, pl.dmgup = pl.maxhp, 0, 0, false
  end
  host.decree, host.enraged, view.decree = nil, false, 0
end

local function start_match(mode, now)
  local _, _, _, _, _, total = alive()
  host.mode, host.phase, host.started, host.lastdmg, host.last_decree, host.timer_fired, host.used = mode, "F", now, now, now, 0, {}
  reset_players(mode, total)
  emit("S", my.id, my.id, 0, mode, 3)
end

local function apply_decree(idx, dur, now)
  local card = deck[idx]
  if not card then return end
  host.decree = { idx = idx, type = card.type, val = card.val, till = now + dur * 1000 }
  host.used[idx], host.last_decree = true, now
  for _, pl in pairs(host.players) do
    if card.type == "heal" and pl.hp > 0 then pl.hp = min(pl.maxhp, pl.hp + floor(pl.maxhp * card.val / 100))
    elseif card.type == "fog" then pl.hide = host.decree.till end
  end
  emit("D", my.id, sfmt("%04d", dur), idx, card.type, 3)
end

local function fire_trigger(trig, now)
  local pool = {}
  for i, card in ipairs(deck) do if card.trig == trig and not host.used[i] then pool[#pool + 1] = i end end
  if #pool == 0 then return end
  local idx = pool[badge.sys.random(#pool) + 1]
  apply_decree(idx, deck[idx].dur, now)
end

local function check_triggers(now)
  if host.decree or now - host.last_decree < 15000 then return end
  local trig = nil
  for _, pl in pairs(host.players) do if pl.hp > 0 and pl.hp * 4 < pl.maxhp then trig = "low" end end
  if not trig and now - host.lastdmg > 20000 then trig, host.lastdmg = "stale", now
  elseif not trig and floor((now - host.started) / 45000) > host.timer_fired then host.timer_fired, trig = host.timer_fired + 1, "timer" end
  if trig then fire_trigger(trig, now) end
end

local function check_end(now)
  local n, last, nt, boss, mages, total = alive()
  local winner = nil
  if host.mode == "R" then
    if not boss then winner = "MAGE" elseif mages == 0 then winner = "BOSS" end
  elseif host.mode == "T" then
    if nt <= 1 and total >= 2 then winner = n == 0 and "NONE" or ("TM" .. (peers[last] and peers[last].team or "0") .. "0") end
  elseif n <= 1 and total >= 2 then winner = last end
  if winner then
    host.phase, host.over_at = "O", now
    emit("O", winner, my.id, 0, host.mode, 3)
  end
end

local function hit(cid, tid, sp, charge, rssi, now)
  local c, t, cpe, tpe = player(cid), host.players[tid], peers[cid], peers[tid]
  if not t or t.hp <= 0 or (host.mode == "T" and cpe and tpe and cpe.team == tpe.team) then return end
  if (t.hide > 0 and rssi < REVEAL) or (sp.range == "near" and rssi < NEAR) then emit("M", cid, tid, 0, sp.id); return end
  local dmg = sp.dmg * (0.8 + 0.1 * charge)
  if sp.range == "fall" then dmg = dmg * clamp((rssi + 95) / 45, 0.35, 1) end
  if host.decree and host.decree.type == "dmg" then dmg = dmg * host.decree.val / 10 end
  if c.dmgup then dmg, c.dmgup = dmg * 1.5, false end
  if host.mode == "R" and cpe and cpe.role == "B" then dmg = dmg * (host.enraged and 2 or 1.3) end
  dmg, c.hide = max(1, floor(dmg + 0.5)), 0
  if t.ward > 0 then t.ward = 0; emit("W", cid, tid, 0, sp.id); return end
  t.hp, host.lastdmg = t.hp - dmg, now
  emit("H", cid, tid, min(255, dmg), sp.id)
  if t.hp <= 0 then
    t.hp, t.dead_at = 0, now
    emit("K", cid, tid, 0, sp.id, 3)
  elseif host.mode == "R" and tpe and tpe.role == "B" and not host.enraged and t.hp * 2 < t.maxhp then
    host.enraged = true
    emit("B", tid, tid, floor(t.hp * 100 / t.maxhp), "E", 3)
    if not host.decree then fire_trigger("boss", now) end
  end
end

local function resolve(cid, code, charge, rssi, targets, now)
  if code == "!" then
    if host.phase ~= "F" then start_match(({ "D", "T", "R" })[charge] or "D", now) end
    return
  elseif code == "?" then apply_decree(-rssi, charge * 10, now); return
  elseif host.phase == "O" then return end
  local c, sp = player(cid), BY[code]
  if c.hp <= 0 or not sp then return end
  if sp.cd then
    local cd = floor(sp.cd * (host.decree and host.decree.type == "cd" and max(0.2, host.decree.val / 10) or 1) * 0.7)
    if now - (c.last[code] or -100000) < cd then return end
    c.last[code] = now
  end
  local kind = sp.kind
  if kind == "ward" then c.ward = now + 10000; emit("G", cid, cid, 0, code)
  elseif kind == "hide" then c.hide = now + (sp.cd and 8000 or 10000); emit("V", cid, cid, 0, code)
  elseif kind == "heal" then
    local amount = sp.cd and floor(sp.dmg * (0.8 + 0.1 * charge)) or 30
    c.hp = min(c.maxhp, c.hp + amount)
    emit("L", cid, cid, amount, code)
  elseif kind == "dmgup" then c.dmgup = true; emit("I", cid, cid, 0, code)
  elseif kind == "aoe" then
    for i = 1, min(#targets - 3, 25), 4 do hit(cid, ssub(targets, i, i + 3), sp, charge, rssi, now) end
  else hit(cid, ssub(targets, 1, 4), sp, charge, rssi, now) end
end

local function send_snapshot()
  local ids = {}
  for id in pairs(host.players) do ids[#ids + 1] = id end
  table.sort(ids)
  host.page = host.page % max(1, floor((#ids + 4) / 5))
  local p = "PAS" .. host.phase .. host.mode .. schar(48 + host.page) .. hex2(host.decree and host.decree.idx or 0)
  for i = host.page * 5 + 1, min(#ids, host.page * 5 + 5) do
    local pl = host.players[ids[i]]
    p = p .. pl.id .. hex2(floor(pl.hp * 100 / pl.maxhp + 0.5)) .. sfmt("%X", pl.st)
  end
  host.page = host.page + 1
  queue_send(p, 1)
end

local function become_host(now)
  host = { players = {}, phase = view.phase, mode = view.mode, used = {}, started = now, lastdmg = now, eseq = 0, page = 0,
           next_snap = now, next_tick = now, last_decree = 0, timer_fired = 0, enraged = false, over_at = now }
  for id, pe in pairs(peers) do
    local pl = player(id)
    if pe.role == "B" and view.mode == "R" then pl.maxhp = 250 end
    pl.hp = floor(pe.hp * pl.maxhp / 100)
    if pe.st % 2 == 1 then pl.ward = now + 8000 end
    if pe.st % 4 >= 2 then pl.hide = now + 6000 end
  end
  local card = view.dec_until > now and deck[view.decree]
  if card then host.decree = { idx = view.decree, type = card.type, val = card.val, till = view.dec_until } end
end

local function host_tick(now)
  if now < host.next_tick then return end
  host.next_tick = now + 250
  for id, pe in pairs(peers) do if now - pe.seen <= 15000 then player(id) end end
  for id in pairs(host.players) do
    local pe = peers[id]
    if not pe or now - pe.seen > 15000 then host.players[id] = nil end
  end
  if host.decree and now >= host.decree.till then host.decree, dirty = nil, true end
  for _, pl in pairs(host.players) do
    if now >= pl.ward then pl.ward = 0 end
    if now >= pl.hide then pl.hide = 0 end
    if pl.hp <= 0 and host.phase == "L" and now - pl.dead_at >= 3000 then pl.hp = pl.maxhp; emit("R", pl.id, pl.id, 0, "-") end
    pl.st = (pl.ward > 0 and 1 or 0) + (pl.hide > 0 and 2 or 0) + (pl.hp <= 0 and 4 or 0)
  end
  if host.phase == "F" then
    check_end(now)
    if host.phase == "F" then check_triggers(now) end
  elseif host.phase == "O" and now - host.over_at >= 8000 then
    host.phase = "L"
    reset_players("L", 0)
  end
  if now >= host.next_snap then host.next_snap = now + 250; send_snapshot() end
  view.phase, view.mode = host.phase, host.mode
  if host.decree then view.decree, view.dec_until = host.decree.idx, host.decree.till else view.decree = 0 end
  for id, pl in pairs(host.players) do view_apply(id, floor(pl.hp * 100 / pl.maxhp + 0.5), pl.st) end
end

-- ===== election and inbound frames =====
local function elect(now)
  local best = my.mac
  for id, pe in pairs(peers) do
    if id ~= my.id and pe.mac ~= "" and now - pe.seen <= 3000 and pe.mac < best then best = pe.mac end
  end
  if view.host_mac ~= best then dirty = true end
  view.host_mac, view.host = best, id_of(best)
  if best == my.mac and not host then become_host(now); log_push("You are the host now")
  elseif best ~= my.mac and host then host = nil; log_push("Host: " .. name_of(view.host)) end
end

local function handle_S(p, mac, now)
  mac = supper(mac)
  if view.host_mac ~= "" and mac > view.host_mac then return end
  local pe = get_peer(id_of(mac))
  if pe.mac == "" then pe.mac = mac end
  pe.seen = now
  local phase, mode, dec = ssub(p, 4, 4), ssub(p, 5, 5), unhex(ssub(p, 7, 8)) or 0
  if phase ~= view.phase or mode ~= view.mode then view.phase, view.mode, dirty = phase, mode, true end
  if dec ~= view.decree then
    if dec == 0 then view.decree, view.cd_mult, dirty = 0, 1, true else decree_view(dec, 60, now) end
  end
  for i = 9, #p - 6, 7 do view_apply(ssub(p, i, i + 3), unhex(ssub(p, i + 4, i + 5)) or 0, unhex(ssub(p, i + 6, i + 6)) or 0) end
end

local function process_rx(now)
  for _ = 1, min(8, #rxq) do
    local f = table.remove(rxq, 1)
    local mac, rssi, p, k = f[1], f[2], f[3], ssub(f[3], 3, 3)
    local pe = mac ~= my.mac and peers[id_of(mac)]
    if pe then pe.rssi, pe.seen = rssi, now end
    if k == "H" then
      local id, name = ssub(p, 4, 7), clean_name(ssub(p, 12, 21))
      if id ~= my.id then
        pe = get_peer(id)
        if pe.name ~= name or pe.team ~= ssub(p, 8, 8) or pe.role ~= ssub(p, 9, 9) then dirty = true end
        if not pe.known then pe.known = true; log_push(name .. " joined the arena") end
        pe.mac, pe.name, pe.team, pe.role, pe.seen, pe.rssi = supper(mac), name, ssub(p, 8, 8), ssub(p, 9, 9), now, rssi
      end
    elseif k == "S" then handle_S(p, mac, now)
    elseif k == "E" then if not seen_recently(p, now) then handle_E(p, now) end
    elseif k == "C" then
      if host and not seen_recently(p, now) then
        get_peer(ssub(p, 6, 9)).seen = now
        resolve(ssub(p, 6, 9), ssub(p, 10, 10), clamp(tonumber(ssub(p, 11, 11)) or 1, 0, 9), -(unhex(ssub(p, 12, 13)) or 99), ssub(p, 14), now)
      end
    elseif k == "L" then
      if not seen_recently(p, now) and BY[ssub(p, 8, 8)] then log_push(name_of(ssub(p, 4, 7)) .. " found " .. BY[ssub(p, 8, 8)].name .. " x" .. ssub(p, 9, 9)) end
    end
  end
end

-- ===== casting =====
local function send_cast(code, charge, rssi, targets)
  cast_seq = (cast_seq + 1) % 256
  local p = ssub("PAC" .. hex2(cast_seq) .. my.id .. code .. schar(48 + clamp(charge, 0, 9)) .. hex2(-rssi) .. targets, 1, 44)
  if host then rxq[#rxq + 1] = { my.mac, 0, p } end
  queue_send(p, 3)
end

local function cast(sp, charge)
  local now = now_ms()
  if (cd_until[sp.id] or 0) > now then show_gesture(sp.name .. " is cooling down"); return end
  if my.hp <= 0 then show_gesture("You are down"); return end
  local targets, rssi = my.id, 0
  if sp.kind == "aoe" then
    targets = ""
    for _, id in ipairs(order) do
      local pe = peers[id]
      if targetable(pe) and pe.rssi >= NEAR and #targets < 28 then targets, rssi = targets .. id, min(rssi, pe.rssi) end
    end
    if targets == "" then show_gesture(sp.name .. ": no one in reach"); return end
  elseif sp.range ~= "self" then
    local t = current_target()
    if not t then show_gesture(sp.name .. ": no target (LEFT/RIGHT)"); return end
    targets, rssi = t.id, t.rssi
    if sp.range == "near" and rssi < NEAR then show_gesture(sp.name .. ": get closer!"); return end
  end
  send_cast(sp.id, charge, rssi, targets)
  cd_len[sp.id] = floor(sp.cd * (view.dec_until > now and view.cd_mult or 1))
  cd_until[sp.id] = now + cd_len[sp.id]
  led_flash(sp.col, 300)
  dirty = true
end

local function use_item()
  local it = ITEMS[inv_sel]
  if inv[it.id] <= 0 then show_gesture("No " .. it.name .. ": find a shrine"); return end
  inv[it.id] = inv[it.id] - 1
  save_inv()
  send_cast(it.id, 1, 0, my.id)
  show_gesture("Used " .. it.name)
  led_flash(0xc8ffff, 300)
  dirty = true
end

local function request_start(mode)
  if host then start_match(mode, now_ms()) else send_cast("!", mode == "T" and 2 or mode == "R" and 3 or 1, 0, "") end
end

local function begin_channel(now) gest.on, gest.syms, gest.above, gest.forced, gest.start = true, {}, false, nil, now end

local teach_record

local function end_channel(now)
  gest.on, gest.released = false, now
  local shown = table.concat(gest.syms, " ")
  if screen == "teach" then teach_record(shown); return end
  local sp = gest.forced or match_gesture(gest.syms)
  if sp then
    show_gesture((shown == "" and "button" or shown) .. " = " .. sp.name)
    cast(sp, clamp(floor((now - gest.start) / 250) + 1, 1, 6))
  elseif #gest.syms > 0 then show_gesture(shown .. " = ?  (START > Teach)")
  else show_gesture(accel_ok and "no motion: hold A and draw" or "no accel: hold A + button") end
end

local function sensors_tick(now)
  if screen ~= "arena" then return end
  if badge.sensor.tap() and not gest.on and now - gest.released > 300 then cast(BY.J, 1) end
  if badge.sensor.shake() and not gest.on and now - gest.released > 600 then cast(BY.B, 3) end
  if now < next_orient then return end
  next_orient = now + 100
  if badge.sensor.orientation() == "flat_down" and not gest.on then
    if flat_since == 0 then flat_since = now
    elseif now - flat_since > 400 and (cd_until.W or 0) <= now then
      flat_since = now + 100000
      show_gesture("face-down = WARD")
      cast(BY.W, 2)
    end
  else flat_since = 0 end
end

-- ===== arena UI =====
local function label(parent, text, font, color)
  local l = badge.ui.label(parent, text)
  l:style({ text_font = font, text_color = color })
  return l
end

local function build_ui(root)
  ui.me_lbl = label(root, "", 14, 0xffffff)
  ui.me_lbl:set_pos(4, 2)
  ui.tg_lbl = label(root, "", 14, 0xffffff)
  ui.tg_lbl:align("top_right", -4, 2)
  ui.me_bar = badge.ui.bar(root, 0, 100, 100)
  ui.tg_bar = badge.ui.bar(root, 0, 100, 100)
  for i, bar in ipairs({ ui.me_bar, ui.tg_bar }) do
    bar:set_size(120, 8)
    bar:set_pos(i == 1 and 4 or 196, 20)
    bar:style({ bg_color = 0x223344, radius = 3 }, "main")
    bar:style({ bg_color = i == 1 and TCOL[tonumber(my.team) + 1] or 0xff4040, radius = 3 }, "indicator")
  end
  ui.phase = label(root, "LOBBY", 14, 0xffcc55)
  ui.phase:align("top_mid", 0, 2)
  ui.status = label(root, "", 14, 0x99aabb)
  ui.status:align("top_mid", 0, 32)
  ui.arcs, ui.glyphs = {}, {}
  for i, sp in ipairs(SPELLS) do
    local ax, ay = 12 + ((i - 1) % 4) * 78, i <= 4 and 50 or 108
    local arc = badge.ui.arc(root, 0, 100, 100)
    arc:set_size(40, 40)
    arc:set_pos(ax, ay)
    arc:style({ arc_color = 0x22303c, arc_width = 4 }, "main")
    arc:style({ arc_color = sp.col, arc_width = 4 }, "indicator")
    arc:style({ bg_opa = 0 }, "knob")
    local g = label(root, sp.g, 16, sp.col)
    g:set_pos(ax + 10, ay + 12)
    local h = label(root, sp.hint, 14, 0x667788)
    h:set_size(72, 14)
    h:style({ text_align = "center" })
    h:set_pos(ax - 16, ay + 42)
    ui.arcs[i], ui.glyphs[i], arc_val[i] = arc, g, 100
  end
  ui.inv = label(root, "", 14, 0xaabbcc)
  ui.inv:set_pos(4, 168)
  ui.gest = label(root, IDLE_TXT, 14, 0xffffff)
  ui.gest:set_pos(4, 184)
  ui.log1 = label(root, "", 14, 0x8899aa)
  ui.log1:set_pos(4, 200)
  ui.log2 = label(root, "", 14, 0xffffff)
  ui.log2:set_pos(4, 214)
  label(root, "L/R target  U/D item  B use  START menu", 14, 0x556677):set_pos(4, 227)
end

local function render(now)
  local tg = current_target()
  ui.me_lbl:set_text(my.name .. "  " .. my.hp .. (my.role == "B" and " [PHANTOM]" or ""))
  ui.me_bar:set_value(clamp(my.hp, 0, 100))
  ui.tg_lbl:set_text(tg and sfmt("%s  %d  (%d)", tg.name, tg.hp, tg.rssi) or "no target")
  ui.tg_bar:hidden(not tg)
  if tg then ui.tg_bar:set_value(clamp(tg.hp, 0, 100)) end
  local ph = view.phase
  ui.phase:set_text(ph == "F" and ("FIGHT " .. mode_name(view.mode)) or ph == "O" and "MATCH OVER" or "LOBBY practice")
  if view.decree > 0 and view.dec_until > now and deck[view.decree] then
    ui.status:set_text("DECREE: " .. deck[view.decree].title)
    ui.status:set_color(0xffcc55)
  else
    local n = 0
    for _, pe in pairs(peers) do if pe.id == my.id or now - pe.seen <= 15000 then n = n + 1 end end
    ui.status:set_text(sfmt("host %s  |  %d in arena  |  %s%s", host and "YOU" or name_of(view.host), n, TEAM[my.team],
      my.st % 2 == 1 and "  WARD" or my.st % 4 >= 2 and "  HIDDEN" or ""))
    ui.status:set_color(0x99aabb)
  end
  local it = ITEMS[inv_sel]
  ui.inv:set_text(sfmt("item %d/3: %s x%d  (B use)", inv_sel, it.name, inv[it.id]))
end

local function render_arcs(now)
  for i, sp in ipairs(SPELLS) do
    local u, v = cd_until[sp.id] or 0, 100
    if u > now then v = clamp(floor(100 - (u - now) * 100 / max(1, cd_len[sp.id] or sp.cd)), 0, 100) end
    if v ~= arc_val[i] then
      arc_val[i] = v
      ui.arcs[i]:set_value(v)
      ui.glyphs[i]:set_color(v >= 100 and sp.col or 0x556677)
    end
  end
end

-- ===== menu / teach / shrine, drawn in the gesture and status lines =====
local function show_mode()
  if screen == "menu" then
    ui.gest:set_text(sfmt("MENU %d/7: %s", menu_sel, (menu_sel == 4 and my.role == "B") and "Back to mage" or MENU[menu_sel]))
    ui.status:set_text(sfmt("UP/DOWN pick  A ok  B back   K%d D%d M%d L%d", stats.kills, stats.deaths, stats.matches, stats.loot))
  elseif screen == "teach" then
    local sp = SPELLS[teach.spell]
    ui.gest:set_text(sfmt("TEACH %s %d/3: hold A, draw, release", sp.name, #teach.tries + 1))
    ui.status:set_text("L/R spell  START default  B back  now " .. table.concat(templates[sp.id], " "))
  else
    ui.gest:set_text(nfc_ok and "SHRINE: hold badge on a sticker   B back" or "SHRINE: NFC unavailable   B back")
    ui.status:set_text(sfmt("Potion %d  Ember %d  Cloak %d   loot %d", inv.p, inv.e, inv.k, stats.loot))
  end
  ui.status:set_color(0xffcc55)
end

local function close_mode()
  if nfc_ok then badge.nfc.disable(); nfc_ok = false end
  screen, gest.on, dirty = "arena", false, true
  ui.gest:set_text(IDLE_TXT)
end

local function menu_pick()
  local s = menu_sel
  if s <= 3 then close_mode(); request_start(({ "D", "T", "R" })[s])
  elseif s == 4 then
    my.role = my.role == "B" and "M" or "B"
    peers[my.id].role = my.role
    log_push(my.role == "B" and "You are the PHANTOM" or "You are a mage again")
    send_heartbeat()
    show_mode()
  elseif s == 5 then
    my.team = schar(48 + (tonumber(my.team) + 1) % 5)
    peers[my.id].team = my.team
    badge.store.set_str("team", my.team)
    ui.me_bar:style({ bg_color = TCOL[tonumber(my.team) + 1] }, "indicator")
    log_push("Team: " .. TEAM[my.team])
    send_heartbeat()
    show_mode()
  elseif s == 6 then screen, teach.tries = "teach", {}; show_mode()
  else
    screen, shrine.uid = "shrine", nil
    nfc_ok = badge.nfc.enable()
    if nfc_ok then badge.nfc.clear() end
    show_mode()
  end
end

teach_record = function(shown)
  local t = teach.tries
  t[#t + 1] = shown
  log_push(sfmt("try %d: %s", #t, shown == "" and "(no motion)" or shown))
  led_flash(0xc8c8ff, 200)
  if #t >= 3 then
    local toks, best, bestsum = {}, 0, 999
    for i = 1, 3 do toks[i] = tokens(t[i]) end
    for i = 1, 3 do
      local sum = 0
      for j = 1, 3 do if i ~= j then sum = sum + edit_dist(toks[i], toks[j]) end end
      if #toks[i] > 0 and sum < bestsum then best, bestsum = i, sum end
    end
    local sp = SPELLS[teach.spell]
    if best > 0 then
      templates[sp.id] = toks[best]
      badge.store.set_str("g_" .. sp.id, t[best])
      log_push("Learned " .. sp.name .. ": " .. t[best])
      led_effect("rainbow", 1200)
    else log_push("No motion seen, try again") end
    teach.tries = {}
  end
  show_mode()
end

local function handle_tag(uid, text, now)
  local kind, a, b = string.match(text or "", "^pa:(%a+):(%w+):?(%d*)$")
  local code = kind == "loot" and (ALIAS[a] or (BY[a] and a))
  if code then
    local list = badge.fs.read("appdata/claimed.txt") or ""
    if string.find(list, uid, 1, true) then log_push("Already claimed this shrine"); led_flash(0xff7800, 400); return end
    local q = clamp(tonumber(b) or 1, 1, 9)
    inv[code] = min(99, inv[code] + q)
    save_inv()
    if #list > 14000 then badge.fs.write("appdata/claimed.txt", uid .. "\n") else badge.fs.append("appdata/claimed.txt", uid .. "\n") end
    stats.loot, stats_dirty = stats.loot + q, true
    queue_send("PAL" .. my.id .. code .. q, 3)
    log_push("You found " .. BY[code].name .. " x" .. q)
    led_effect("rainbow", 1500)
  elseif kind == "decree" and deck[tonumber(a) or 0] then
    local idx, dur = tonumber(a), clamp(tonumber(b) or 20, 0, 90)
    if host then apply_decree(idx, dur, now) else send_cast("?", floor(dur / 10), -idx, "") end
    led_effect("gold", 1500)
  else
    log_push(text and "Not a shrine tag" or "Unreadable tag")
    led_flash(0xff0000, 400)
  end
end

local function shrine_tick(now)
  if screen ~= "shrine" or not nfc_ok or now < shrine.poll then return end
  shrine.poll = now + 200
  local card = badge.nfc.card()
  if card and card.uid ~= shrine.uid then
    shrine.uid = card.uid
    handle_tag(card.uid, badge.nfc.read_text(), now)
    show_mode()
  end
end

-- ===== lifecycle =====
function M.enter(root, radio)
  local now = now_ms()
  radio_ok = radio
  if radio_ok then
    my.mac = supper(badge.radio.mac() or "")
    badge.radio.on_recv(function(mac, rssi, payload)
      if #rxq < 16 and ssub(payload or "", 1, 2) == "PA" then rxq[#rxq + 1] = { mac, rssi, payload } end
    end)
  end
  if my.mac == "" then my.mac = sfmt("FF:FF:FF:FF:%02X:%02X", badge.sys.random(256), badge.sys.random(256)) end
  my.id = id_of(my.mac)
  my.name = clean_name(badge.me.name())
  my.team = badge.store.get_str("team", "")
  if not TEAM[my.team] then
    local r, g, b = badge.me.color()
    r, g, b = r or 0, g or 0, b or 0
    my.team = (r > 150 and g > 150 and b < 120) and "4" or (r >= g and r >= b) and "1" or (b >= g) and "2" or "3"
  end
  for k in pairs(stats) do stats[k] = badge.store.get_int(k, 0) end
  for k, v in string.gmatch(badge.store.get_str("inv", ""), "(%a)(%d+)") do if inv[k] then inv[k] = clamp(tonumber(v), 0, 99) end end
  local text = badge.fs.exists("deck.txt") and badge.fs.read("deck.txt") or DECK0
  for line in string.gmatch(text or "", "[^\r\n]+") do
    local tr, ty, v, d, title, txt = string.match(line, "^(%a+)|(%a+)|(%d+)|(%d+)|([^|]*)|([^|]*)$")
    if tr and #deck < 40 then
      deck[#deck + 1] = { trig = tr, type = ty, val = tonumber(v), dur = clamp(tonumber(d), 0, 255), title = ssub(title, 1, 24), text = ssub(txt, 1, 44) }
    end
  end
  for _, sp in ipairs(SPELLS) do
    local saved = badge.store.get_str("g_" .. sp.id, "")
    templates[sp.id] = tokens(saved ~= "" and saved or sp.gest)
  end
  build_ui(root)
  peers[my.id] = { id = my.id, mac = my.mac, name = my.name, team = my.team, role = my.role, hp = 100, st = 0, seen = now, rssi = 0 }
  elect(now)
  log_push(radio_ok and "Radio on. Hold A, draw, release." or "Radio unavailable: practice mode")
  send_heartbeat()
  next_hk = now + 1000
  render(now)
  log_mem("ready")
end

function M.tick()
  local now = now_ms()
  gest_tick()
  sensors_tick(now)
  process_rx(now)
  for i = #resend, 1, -1 do
    local r = resend[i]
    if now >= r.at then
      if radio_ok then badge.radio.send(r.p) end
      r.left, r.at = r.left - 1, now + 100
      if r.left <= 0 then table.remove(resend, i) end
    end
  end
  if now >= next_hk then
    next_hk = now + 1000
    send_heartbeat()
    for id, pe in pairs(peers) do
      if id ~= my.id and now - pe.seen > 15000 then
        peers[id] = nil
        if view.target == id then view.target = nil end
        log_push(pe.name .. " left the arena")
        reorder()
      end
    end
  end
  if now >= next_elect then next_elect = now + 500; elect(now) end
  if host then host_tick(now) end
  shrine_tick(now)
  if gest.shown > 0 and now >= gest.shown then
    gest.shown = 0
    if screen == "arena" then ui.gest:set_text(IDLE_TXT) end
  end
  if now >= next_render and screen == "arena" then
    next_render = now + 100
    if dirty then dirty = false; render(now) end
    render_arcs(now)
  end
  led_frame(now)
end

function M.button(button, kind)
  local B, K, now = badge.input.BUTTON, badge.input.KIND, now_ms()
  local pressed = kind == K.PRESSED
  if screen == "menu" then
    if not pressed then return end
    if button == B.UP then menu_sel = (menu_sel - 2) % 7 + 1; show_mode()
    elseif button == B.DOWN then menu_sel = menu_sel % 7 + 1; show_mode()
    elseif button == B.A then menu_pick()
    elseif button == B.B then close_mode() end
  elseif screen == "teach" then
    if button == B.A then
      if pressed then begin_channel(now) elseif gest.on then end_channel(now) end
    elseif not pressed then return
    elseif button == B.LEFT or button == B.RIGHT then
      teach.spell, teach.tries = (teach.spell - 1 + (button == B.LEFT and 5 or 1)) % 6 + 1, {}
      show_mode()
    elseif button == B.START then
      local sp = SPELLS[teach.spell]
      templates[sp.id], teach.tries = tokens(sp.gest), {}
      badge.store.set_str("g_" .. sp.id, "")
      show_mode()
    elseif button == B.B then close_mode() end
  elseif screen == "shrine" then
    if pressed and button == B.B then close_mode() end
  elseif button == B.A then
    if pressed then begin_channel(now) elseif gest.on then end_channel(now) end
  elseif not pressed then return
  elseif gest.on then
    for _, sp in ipairs(SPELLS) do
      if sp.btn and button == B[sp.btn] then gest.forced = sp; show_gesture(sp.name .. " picked, release A") end
    end
  elseif button == B.LEFT then cycle_target(-1)
  elseif button == B.RIGHT then cycle_target(1)
  elseif button == B.UP then inv_sel, dirty = (inv_sel - 2) % 3 + 1, true
  elseif button == B.DOWN then inv_sel, dirty = inv_sel % 3 + 1, true
  elseif button == B.B then use_item()
  elseif button == B.START then screen, menu_sel = "menu", 1; show_mode() end
end

function M.exit()
  stats_dirty = true
  save_stats()
  if nfc_ok then badge.nfc.disable() end
  if radio_ok then
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
  badge.led.clear()
  badge.led.show()
end

return M
