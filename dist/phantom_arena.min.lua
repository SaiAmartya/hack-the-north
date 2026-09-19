--[==[badge-app
slug=phantom_arena
name=Phantom Arena
icon=PA
api=2
heap_kb=96
wake_lock=1
confirm_home=1
version=1.0
author=Phantom Arena
]==]



local G, radio_ok = nil, false

local function log_mem(tag)
local st = badge.sys.stats()
badge.sys.log(string.format("PAMEM|%s|lua=%d/%d peak=%d free_heap=%d", tag, st.lua_used, st.lua_limit, st.lua_peak, st.free_heap))
end

function on_enter(root)
log_mem("boot")
radio_ok = badge.radio.enable()
log_mem(radio_ok and "radio on" or "radio FAILED")
G = require("game")
G.enter(root, radio_ok)
end

function on_tick()
if G then G.tick() end
end

function on_button(button, kind)
if G then G.button(button, kind) end
end

function on_exit()
if G then
G.exit()
elseif radio_ok then
badge.radio.disable()
end
end
