-- PA Probe: measures the badge's memory model in one run. Push, Reboot, open, paste the console.
-- Order matters: load a real slice of the game FIRST (its cost shows in PAMEM|loaded), then the radio.
local ok_radio, lines = false, {}

local function stats(tag)
  local st = badge.sys.stats()
  badge.sys.log(string.format("PAMEM|%s|lua=%d/%d peak=%d free_heap=%d gc=%d", tag, st.lua_used, st.lua_limit,
    st.lua_peak, st.free_heap, math.floor(collectgarbage("count") * 1024)))
  lines[#lines + 1] = string.format("%s: lua %dK  heap %dK", tag, math.floor(st.lua_used / 1024), math.floor(st.free_heap / 1024))
end

function on_enter(root)
  badge.sys.log(string.format("PAVM|%s|maxint=%s|fw=%s", _VERSION, tostring(math.maxinteger), tostring(badge.sys.version())))
  stats("boot")
  local S = require("slice")
  collectgarbage("collect")
  stats("loaded")
  ok_radio = badge.radio.enable()
  stats(ok_radio and "radio on" or "radio FAILED")
  local t = badge.ui.label(root, "PA PROBE\n" .. table.concat(lines, "\n") .. "\nHOME exit")
  t:style({ text_font = 14, text_align = "center" })
  t:align("center", 0, 0)
  stats("ui")
end

function on_exit()
  if ok_radio then badge.radio.disable() end
end
