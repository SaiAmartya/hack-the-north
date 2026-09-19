



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


return M
