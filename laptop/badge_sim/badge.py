"""A simulated Hack the North 2026 Hacker Badge running a real Lua 5.4 VM.

The simulator mirrors the documented Lua sandbox and limits (badge-app-guide):
no pcall/xpcall/setmetatable/load/os/io/coroutine, 44-byte radio payloads,
8-slot receive ring drained 4 per tick, 512 widgets, 1024-byte widget text,
32 store keys, 64 KiB fs quota / 16 KiB per file, integer-only coordinates and
LED channels. Anything the firmware would reject raises here, so bugs surface on
the laptop instead of on stage.
"""
from __future__ import annotations

import random
import re
import time
from pathlib import Path
from typing import Any, Callable

try:  # prefer the Lua 5.4 build to match the badge firmware
    from lupa import lua54 as _lupa
except ImportError:  # pragma: no cover
    import lupa as _lupa

LuaRuntime = _lupa.LuaRuntime
LuaError = _lupa.LuaError

BUTTONS = {"A": 0, "B": 1, "HOME": 2, "DOWN": 3, "LEFT": 4, "RIGHT": 5, "UP": 6, "AUX1": 7, "START": 8}
PRESSED, RELEASED = 0, 1

STYLE_KEYS = {
    "bg_color", "bg_opa", "color", "opa", "radius",
    "border_color", "border_opa", "border_width",
    "text_color", "text_opa", "text_font", "text_align",
    "arc_color", "arc_opa", "arc_width", "line_color", "line_opa", "line_width",
    "pad_all", "pad_top", "pad_bottom", "pad_left", "pad_right", "pad_row", "pad_column",
    "shadow_color", "shadow_opa", "shadow_width", "shadow_spread", "shadow_offset_x", "shadow_offset_y",
    "flex_flow",
}
SELECTORS = {"main", "indicator", "knob", "items", "scrollbar"}
SELECTOR_STATES = {"pressed", "checked", "disabled", "focused"}
ALIGNS = {"center", "top_left", "top_mid", "top_right", "bottom_left", "bottom_mid", "bottom_right", "left_mid", "right_mid"}
FONTS = {14, 16, 18, 20, 22, 24, "small", "default", "large"}
FACTORIES = {"label", "box", "bar", "arc", "slider", "image", "line", "button", "switch", "checkbox", "roller", "textarea"}
TEXT_WIDGETS = {"label", "checkbox", "textarea"}
VALUE_WIDGETS = {"bar", "arc", "slider"}

BUDGET_MS = {"main": 3000, "on_enter": 3000, "on_tick": 250, "on_recv": 250, "on_button": 1000, "on_exit": 1000}

# Lua-side shim: builds the `badge` table with widget handles that behave like the
# firmware's single handle type, then removes everything the sandbox lacks.
SHIM = r"""
local py = ...
local setmetatable, getmetatable = setmetatable, getmetatable
local W = {}
W.__index = W
W.__eq = function(a, b) return a.__id == b.__id end
local function wrap(id) if id == nil then return nil end return setmetatable({ __id = id }, W) end
local function uid(w)
  if type(w) ~= "table" or getmetatable(w) ~= W then error("expected a widget handle") end
  return w.__id
end
local methods = { "set_pos", "set_size", "align", "hidden", "clickable", "bring_to_front", "delete",
  "set_text", "set_value", "set_range", "set_src", "set_points", "set_checked", "get_checked",
  "set_options", "get_selected", "set_color", "set_border", "set_font_size", "style", "type", "child_count" }
for _, m in ipairs(methods) do
  W[m] = function(self, ...)
    if type(self) ~= "table" or getmetatable(self) ~= W then error("use ':' to call widget method " .. m) end
    return py.ui(m, self.__id, ...)
  end
end
W.parent = function(self) return wrap(py.ui("parent", uid(self))) end
W.child = function(self, i) return wrap(py.ui("child", uid(self), i)) end

badge = {}
badge.ui = { screen_width = 320, screen_height = 240,
  theme = { background = 0x0b0e14, panel = 0x151a22, surface = 0x1c222c, track = 0x223344, border = 0x2f3a48,
    accent = 0x3cc8ff, accent_detail = 0x1d6fa5, text = 0xf0f4f8, text_soft = 0xc0c8d0, text_muted = 0x8899aa, text_dim = 0x556677 } }
for _, f in ipairs({ "label", "box", "bar", "arc", "slider", "image", "line", "button", "switch", "checkbox", "roller", "textarea" }) do
  badge.ui[f] = function(parent, ...)
    if type(parent) == "table" and getmetatable(parent) ~= W then
      local t = parent
      return wrap(py.ui("create_table", f, uid(t.parent), t))
    end
    return wrap(py.ui("create", f, uid(parent), ...))
  end
end
badge.led = {
  set = function(i, r, g, b) return py.led("set", i, r, g, b) end,
  set_all = function(r, g, b) return py.led("set_all", r, g, b) end,
  clear = function() return py.led("clear") end,
  show = function() return py.led("show") end,
  count = function() return 6 end,
}
badge.sensor = {
  accel = function() return py.sensor("accel") end,
  shake = function() return py.sensor("shake") end,
  tap = function() return py.sensor("tap") end,
  orientation = function() return py.sensor("orientation") end,
}
badge.input = {
  BUTTON = { A = 0, B = 1, HOME = 2, DOWN = 3, LEFT = 4, RIGHT = 5, UP = 6, AUX1 = 7, START = 8 },
  KIND = { PRESSED = 0, RELEASED = 1 },
  is_down = function(b) return py.input("is_down", b) end,
  held = function() return py.input("held") end,
}
badge.sys = {
  ms = function() return py.sys("ms") end,
  uptime = function() return py.sys("uptime") end,
  log = function(s) return py.sys("log", s) end,
  random = function(n) return py.sys("random", n) end,
  heap = function() return py.sys("heap") end,
  gc_step = function() return py.sys("gc_step") end,
  version = function() return py.sys("version") end,
  wake_lock = function(v) return py.sys("wake_lock", v) end,
  stats = function() return py.sys("stats") end,
}
badge.store = {
  set = function(k, v) return py.store("set", k, v) end,
  get = function(k, d) return py.store("get", k, d) end,
  set_int = function(k, v) return py.store("set_int", k, v) end,
  get_int = function(k, d) return py.store("get_int", k, d) end,
  set_str = function(k, v) return py.store("set_str", k, v) end,
  get_str = function(k, d) return py.store("get_str", k, d) end,
}
badge.me = {
  name = function() return py.me("name") end,
  role = function() return py.me("role") end,
  role_name = function() return py.me("role_name") end,
  color = function() return py.me("color") end,
  badge_id = function() return py.me("badge_id") end,
  provisioned = function() return py.me("provisioned") end,
}
badge.contacts = {
  count = function() return py.contacts("count") end,
  get = function(i) return py.contacts("get", i) end,
}
badge.app = {
  slug = function() return py.app("slug") end,
  name = function() return py.app("name") end,
  exit = function() return py.app("exit") end,
}
badge.fs = {
  write = function(p, d) return py.fs("write", p, d) end,
  append = function(p, d) return py.fs("append", p, d) end,
  read = function(p) return py.fs("read", p) end,
  exists = function(p) return py.fs("exists", p) end,
  remove = function(p) return py.fs("remove", p) end,
  list = function(p) return py.fs("list", p) end,
  mkdir = function(p) return py.fs("mkdir", p) end,
}
badge.nfc = {
  enable = function() return py.nfc("enable") end,
  disable = function() return py.nfc("disable") end,
  card = function() return py.nfc("card") end,
  read_text = function() return py.nfc("read_text") end,
  clear = function() return py.nfc("clear") end,
}
badge.radio = {
  enable = function() return py.radio("enable") end,
  disable = function() return py.radio("disable") end,
  send = function(p) return py.radio("send", p) end,
  on_recv = function(fn) return py.radio("on_recv", fn) end,
  mac = function() return py.radio("mac") end,
  dropped = function() return py.radio("dropped") end,
}
__wrap = wrap
-- sandbox: everything the firmware withholds from apps
for _, k in ipairs({ "os", "io", "package", "debug", "coroutine", "python", "dofile", "loadfile", "load",
  "pcall", "xpcall", "setmetatable", "getmetatable" }) do
  _G[k] = nil
end
_G.require = function(name) return py.require(name) end
"""


class Widget:
    def __init__(self, wid: int, wtype: str, parent: "Widget | None"):
        self.id = wid
        self.type = wtype
        self.parent = parent
        self.children: list[Widget] = []
        self.text = ""
        self.x = self.y = 0
        self.w = self.h = 0
        self.align = None
        self.hidden = False
        self.value = 0
        self.vmin, self.vmax = 0, 100
        self.checked = False
        self.options = ""
        self.selected = 0
        self.color = None
        self.styles: dict[str, dict] = {}
        self.deleted = False
        self.src = None
        self.points = None

    def visible(self) -> bool:
        w: Widget | None = self
        while w is not None:
            if w.hidden:
                return False
            w = w.parent
        return True


def _need_int(v: Any, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise LuaError(f"{what} must be an integer, got {type(v).__name__}")
    if isinstance(v, float):
        raise LuaError(f"{what} must be an integer, got float {v}")
    return int(v)


def _need_str(v: Any, what: str) -> str:
    if not isinstance(v, str):
        raise LuaError(f"{what} must be a string, got {type(v).__name__}")
    return v


class SimBadge:
    """One badge. `world` supplies the clock and the radio bus."""

    def __init__(self, world, app_dir: str | Path, mac: str, name: str = "Ada", color=(255, 80, 80),
                 role_name: str = "Hacker", badge_id: str | None = "HTN-0001", accel_available: bool = True,
                 radio_available: bool = True, nfc_available: bool = True, seed: int = 1):
        self.world = world
        self.app_dir = Path(app_dir)
        self.mac = mac.upper()
        self.name = name
        self.color = color
        self.role_name = role_name
        self.badge_id = badge_id
        self.accel_available = accel_available
        self.radio_available = radio_available
        self.nfc_available = nfc_available
        self.rng = random.Random(seed)
        self.manifest = self._read_manifest()
        # persistent across reopen
        self.store: dict[str, Any] = {}
        self.appdata: dict[str, bytes] = {}
        # programmable sensors
        self.accel = (0, 0, 1000)
        self.shake_pending = False
        self.tap_pending = False
        self.orientation = "flat_up"
        self.nfc_card: dict | None = None
        self.nfc_text: str | None = None
        self.nfc_cleared = False
        # runtime state
        self.lua = None
        self.open_state = False
        self.widgets: dict[int, Widget] = {}
        self.leds = [(0, 0, 0)] * 6
        self.led_staged = [(0, 0, 0)] * 6
        self.logs: list[str] = []
        self.sent: list[str] = []
        self.violations: list[str] = []
        self.radio_enabled = False
        self.nfc_enabled = False
        self.recv_cb = None
        self.rx_ring: list[tuple[str, int, str]] = []
        self.dropped = 0
        self.held: set[int] = set()
        self.exit_requested = False
        self.durations: dict[str, float] = {}
        self.tick_count = 0
        self.tick_time_total = 0.0
        self._modules: dict[str, Any] = {}
        self._loading: set[str] = set()

    # ---------- lifecycle ----------
    def _read_manifest(self) -> dict[str, str]:
        m: dict[str, str] = {}
        p = self.app_dir / "manifest.cfg"
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                m[k.strip()] = v.strip()
        return m

    def open(self) -> None:
        self.lua = LuaRuntime(unpack_returned_tuples=True, register_eval=False, register_builtins=False)
        self.widgets = {0: Widget(0, "screen", None)}
        self.leds = [(0, 0, 0)] * 6
        self.led_staged = [(0, 0, 0)] * 6
        self.recv_cb = None
        self.rx_ring = []
        self.radio_enabled = False
        self.nfc_enabled = False
        self.exit_requested = False
        self.held = set()
        self._modules = {}
        backend = self.lua.table_from({
            "ui": self._ui, "led": self._led, "sensor": self._sensor, "input": self._input, "sys": self._sys,
            "store": self._store, "me": self._me, "contacts": self._contacts, "app": self._app, "fs": self._fs,
            "nfc": self._nfc, "radio": self._radio, "require": self._require,
        })
        self.lua.execute(SHIM, backend)
        g = self.lua.globals()
        self._wrap = g["__wrap"]
        g["__wrap"] = None
        src = (self.app_dir / "main.lua").read_text(encoding="utf-8")
        if len(src.encode("utf-8")) > 65536:
            raise LuaError("main.lua exceeds 64 KiB")
        self._timed("main", lambda: self.lua.execute(src))
        self.open_state = True
        on_enter = g["on_enter"]
        if on_enter is not None:
            root = self._wrap(0)
            self._timed("on_enter", lambda: on_enter(root))

    def close(self) -> None:
        if not self.open_state:
            return
        on_exit = self.lua.globals()["on_exit"]
        if on_exit is not None:
            self._timed("on_exit", lambda: on_exit())
        self.open_state = False
        self.radio_enabled = False
        self.nfc_enabled = False
        self.recv_cb = None
        self.rx_ring = []

    def reopen(self) -> None:
        self.close()
        self.open()

    def _timed(self, what: str, fn: Callable[[], Any]) -> Any:
        t0 = time.perf_counter()
        try:
            return fn()
        finally:
            ms = (time.perf_counter() - t0) * 1000
            self.durations[what] = max(self.durations.get(what, 0.0), ms)
            if what == "on_tick":
                self.tick_count += 1
                self.tick_time_total += ms

    # ---------- driving ----------
    def deliver_rx(self, limit: int = 4) -> None:
        n = 0
        while self.rx_ring and n < limit and self.open_state and self.recv_cb is not None:
            mac, rssi, payload = self.rx_ring.pop(0)
            cb = self.recv_cb
            self._timed("on_recv", lambda: cb(mac, rssi, payload))
            n += 1

    def tick(self) -> None:
        if not self.open_state:
            return
        self.deliver_rx()
        on_tick = self.lua.globals()["on_tick"]
        if on_tick is not None:
            self._timed("on_tick", lambda: on_tick())
        if self.exit_requested:
            self.close()

    def button(self, name: str, kind: int) -> None:
        if not self.open_state:
            return
        code = BUTTONS[name]
        if name != "HOME":
            if kind == PRESSED:
                self.held.add(code)
            else:
                self.held.discard(code)
        on_button = self.lua.globals()["on_button"]
        if on_button is not None:
            self._timed("on_button", lambda: on_button(code, kind))
        if self.exit_requested:
            self.close()

    def press(self, name: str) -> None:
        self.button(name, PRESSED)

    def release(self, name: str) -> None:
        self.button(name, RELEASED)

    def click(self, name: str) -> None:
        self.press(name)
        self.release(name)

    def home(self) -> None:
        """Default HOME behaviour: the app exits (confirm_home is treated as confirmed)."""
        self.close()

    # ---------- inspection ----------
    def texts(self, visible_only: bool = True) -> list[str]:
        out = []
        for w in self.widgets.values():
            if w.deleted or w.type not in TEXT_WIDGETS:
                continue
            if visible_only and not w.visible():
                continue
            if w.text:
                out.append(w.text)
        return out

    def screen_text(self) -> str:
        return "\n".join(self.texts())

    def find_text(self, needle: str) -> bool:
        return any(needle in t for t in self.texts())

    def live_widgets(self) -> int:
        return sum(1 for w in self.widgets.values() if not w.deleted and w.id != 0)

    def budget_violations(self) -> list[str]:
        out = []
        for k, ms in self.durations.items():
            if ms > BUDGET_MS.get(k, 250):
                out.append(f"{k} took {ms:.0f} ms (budget {BUDGET_MS.get(k)} ms)")
        return out

    # ---------- backend: ui ----------
    def _widget(self, wid: int) -> Widget:
        w = self.widgets.get(wid)
        if w is None or w.deleted:
            raise LuaError("widget has been deleted")
        return w

    def _new_widget(self, wtype: str, parent: Widget) -> Widget:
        if self.live_widgets() >= 512:
            raise LuaError("too many widgets (512)")
        wid = max(self.widgets) + 1
        w = Widget(wid, wtype, parent)
        parent.children.append(w)
        self.widgets[wid] = w
        return w

    def _apply_style(self, w: Widget, tbl, selector: str = "main") -> None:
        if w.id == 0:
            raise LuaError("root widget is read-only")
        base = selector.split(":")[0]
        if base not in SELECTORS or any(s not in SELECTOR_STATES for s in selector.split(":")[1:]):
            raise LuaError(f"unknown style selector '{selector}'")
        st = w.styles.setdefault(selector, {})
        for k, v in tbl.items():
            if k not in STYLE_KEYS:
                raise LuaError(f"unknown style key '{k}'")
            if k == "text_font":
                if v not in FONTS:
                    raise LuaError(f"bad text_font {v!r}")
            elif k == "text_align":
                if v not in ("left", "center", "right"):
                    raise LuaError(f"bad text_align {v!r}")
            elif k == "flex_flow":
                if v not in ("row", "column", "row_wrap", "column_wrap"):
                    raise LuaError(f"bad flex_flow {v!r}")
            else:
                _need_int(v, f"style {k}")
                if k.endswith("_opa") and not 0 <= v <= 255:
                    raise LuaError(f"style {k} out of range: {v}")
            st[k] = v

    def _ui(self, op: str, *args):
        if op == "create":
            wtype, pid = args[0], args[1]
            parent = self._widget(pid)
            w = self._new_widget(wtype, parent)
            rest = args[2:]
            if wtype in ("label", "textarea"):
                w.text = _need_str(rest[0], f"{wtype} text") if rest else ""
                if len(w.text.encode("utf-8")) > 1024:
                    raise LuaError("widget text exceeds 1024 bytes")
            elif wtype in ("box", "button"):
                if len(rest) >= 2:
                    w.w, w.h = _need_int(rest[0], "width"), _need_int(rest[1], "height")
            elif wtype in VALUE_WIDGETS:
                if len(rest) >= 3:
                    w.vmin, w.vmax, w.value = (_need_int(rest[0], "min"), _need_int(rest[1], "max"), _need_int(rest[2], "value"))
            elif wtype == "image":
                self._check_src(rest[0] if rest else None)
                w.src = rest[0] if rest else None
            elif wtype == "line":
                w.points = list(rest[0].values()) if rest else []
            elif wtype == "switch":
                w.checked = bool(rest[0]) if rest else False
            elif wtype == "checkbox":
                w.text = _need_str(rest[0], "checkbox text") if rest else ""
                w.checked = bool(rest[1]) if len(rest) > 1 else False
            elif wtype == "roller":
                w.options = _need_str(rest[0], "roller options") if rest else ""
            return w.id
        if op == "create_table":
            wtype, pid, t = args
            parent = self._widget(pid)
            w = self._new_widget(wtype, parent)
            style = {}
            for k, v in t.items():
                if k == "parent":
                    continue
                if k in ("x", "y", "w", "h"):
                    setattr(w, k, _need_int(v, k))
                elif k == "text":
                    w.text = _need_str(v, "text")
                elif k == "value":
                    w.value = _need_int(v, "value")
                elif k in ("min", "max"):
                    setattr(w, "v" + k, _need_int(v, k))
                elif k == "hidden":
                    w.hidden = bool(v)
                elif k in ("clickable", "align", "align_x", "align_y", "checked", "options", "src", "points"):
                    pass
                elif k in STYLE_KEYS:
                    style[k] = v
                else:
                    raise LuaError(f"unknown factory key '{k}'")
            if style:
                self._apply_style(w, style)
            return w.id
        wid = args[0]
        w = self._widget(wid)
        a = args[1:]
        readonly_ops = {"set_pos", "set_size", "align", "hidden", "clickable", "delete", "set_text", "set_value", "set_range",
                        "set_src", "set_points", "set_checked", "set_options", "set_color", "set_border", "set_font_size", "style"}
        if wid == 0 and op in readonly_ops:
            raise LuaError("root widget is read-only")
        if op == "set_pos":
            w.x, w.y = _need_int(a[0], "x"), _need_int(a[1], "y")
        elif op == "set_size":
            w.w, w.h = _need_int(a[0], "width"), _need_int(a[1], "height")
        elif op == "align":
            name = _need_str(a[0], "align")
            if name not in ALIGNS:
                raise LuaError(f"unknown alignment '{name}'")
            dx = _need_int(a[1], "dx") if len(a) > 1 else 0
            dy = _need_int(a[2], "dy") if len(a) > 2 else 0
            w.align = (name, dx, dy)
        elif op == "hidden":
            w.hidden = bool(a[0])
        elif op == "clickable":
            pass
        elif op == "bring_to_front":
            if w.parent is not None:
                w.parent.children.remove(w)
                w.parent.children.append(w)
        elif op == "delete":
            self._delete(w)
        elif op == "set_text":
            if w.type not in TEXT_WIDGETS:
                raise LuaError(f"set_text is not supported on {w.type}")
            s = _need_str(a[0], "text")
            if len(s.encode("utf-8")) > 1024:
                raise LuaError("widget text exceeds 1024 bytes")
            w.text = s
        elif op == "set_value":
            if w.type not in VALUE_WIDGETS:
                raise LuaError(f"set_value is not supported on {w.type}")
            w.value = _need_int(a[0], "value")
        elif op == "set_range":
            if w.type not in VALUE_WIDGETS:
                raise LuaError(f"set_range is not supported on {w.type}")
            w.vmin, w.vmax = _need_int(a[0], "min"), _need_int(a[1], "max")
        elif op == "set_src":
            if w.type != "image":
                raise LuaError("set_src is only for images")
            self._check_src(a[0])
            w.src = a[0]
        elif op == "set_points":
            if w.type != "line":
                raise LuaError("set_points is only for lines")
            w.points = list(a[0].values())
        elif op == "set_checked":
            if w.type not in ("switch", "checkbox"):
                raise LuaError("set_checked is only for switch/checkbox")
            w.checked = bool(a[0])
        elif op == "get_checked":
            return w.checked
        elif op == "set_options":
            if w.type != "roller":
                raise LuaError("set_options is only for rollers")
            w.options = _need_str(a[0], "options")
        elif op == "get_selected":
            return w.selected
        elif op == "set_color":
            w.color = _need_int(a[0], "color")
        elif op == "set_border":
            _need_int(a[0], "border color")
            _need_int(a[1], "border width")
        elif op == "set_font_size":
            if a[0] not in ("small", "default", "large"):
                raise LuaError("set_font_size expects small/default/large")
        elif op == "style":
            self._apply_style(w, a[0], _need_str(a[1], "selector") if len(a) > 1 else "main")
        elif op == "type":
            return w.type
        elif op == "child_count":
            return len([c for c in w.children if not c.deleted])
        elif op == "parent":
            return None if w.parent is None else w.parent.id
        elif op == "child":
            i = _need_int(a[0], "child index")
            kids = [c for c in w.children if not c.deleted]
            if not 1 <= i <= len(kids):
                raise LuaError("child index out of range")
            return kids[i - 1].id
        else:
            raise LuaError(f"unknown widget method {op}")
        return None

    def _check_src(self, src) -> None:
        s = _need_str(src, "image src")
        if s.startswith("/") or s.startswith("A:") or ".." in s:
            raise LuaError("image src must be a relative path inside the app")
        if not (self.app_dir / s).exists():
            raise LuaError(f"image file not found: {s}")

    def _delete(self, w: Widget) -> None:
        w.deleted = True
        for c in list(w.children):
            self._delete(c)

    # ---------- backend: leds ----------
    def _led(self, op: str, *a):
        if op == "set":
            i = _need_int(a[0], "led index")
            if not 1 <= i <= 6:
                raise LuaError(f"led index out of range: {i}")
            rgb = tuple(_need_int(v, "led channel") for v in a[1:4])
            if any(not 0 <= v <= 255 for v in rgb):
                raise LuaError(f"led channel out of range: {rgb}")
            self.led_staged[i - 1] = rgb
        elif op == "set_all":
            rgb = tuple(_need_int(v, "led channel") for v in a[0:3])
            if any(not 0 <= v <= 255 for v in rgb):
                raise LuaError(f"led channel out of range: {rgb}")
            self.led_staged = [rgb] * 6
        elif op == "clear":
            self.led_staged = [(0, 0, 0)] * 6
        elif op == "show":
            self.leds = list(self.led_staged)
        return None

    # ---------- backend: sensors / input ----------
    def _sensor(self, op: str):
        if op == "accel":
            if not self.accel_available:
                return (None, "accelerometer unavailable")
            return tuple(self.accel)
        if op == "shake":
            v, self.shake_pending = self.shake_pending, False
            return v
        if op == "tap":
            v, self.tap_pending = self.tap_pending, False
            return v
        if op == "orientation":
            return self.orientation
        raise LuaError(f"unknown sensor op {op}")

    def _input(self, op: str, *a):
        if op == "is_down":
            return _need_int(a[0], "button") in self.held
        if op == "held":
            mask = 0
            for b in self.held:
                mask |= 1 << b
            return mask
        raise LuaError(f"unknown input op {op}")

    # ---------- backend: sys ----------
    def _sys(self, op: str, *a):
        if op == "ms":
            return int(self.world.now)
        if op == "uptime":
            return int(self.world.now // 1000)
        if op == "log":
            s = str(a[0]) if a else ""
            self.logs.append(s)
            self.world.on_log(self, s)
            return None
        if op == "random":
            if a and a[0] is not None:
                n = _need_int(a[0], "random bound")
                if n <= 0:
                    raise LuaError("random bound must be positive")
                return self.rng.randrange(n)
            return self.rng.getrandbits(32)
        if op == "heap":
            return 0
        if op == "gc_step":
            return None
        if op == "version":
            return "sim-1.0"
        if op == "wake_lock":
            return None
        if op == "stats":
            return self.lua.table_from({"lua_used": 0, "lua_peak": 0, "lua_limit": 98304, "widgets": self.live_widgets(),
                                        "uptime_ms": int(self.world.now), "free_heap": 100000})
        raise LuaError(f"unknown sys op {op}")

    # ---------- backend: store ----------
    _KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,24}$")

    def _store_check_key(self, k) -> str:
        k = _need_str(k, "store key")
        if not self._KEY_RE.match(k):
            raise LuaError(f"bad store key '{k}'")
        if k not in self.store and len(self.store) >= 32:
            raise LuaError("store is full (32 keys)")
        return k

    def _store(self, op: str, k, v=None):
        k = self._store_check_key(k)
        if op in ("set", "set_int", "set_str"):
            if isinstance(v, str):
                if op == "set_int":
                    raise LuaError("set_int expects an integer")
                if len(v.encode("utf-8")) > 128 or "\n" in v or "\r" in v:
                    raise LuaError("store string too long or contains line breaks")
                self.store[k] = v
            else:
                if op == "set_str":
                    raise LuaError("set_str expects a string")
                self.store[k] = _need_int(v, "store value")
            return None
        cur = self.store.get(k)
        if op == "get_int":
            return cur if isinstance(cur, int) else v
        if op == "get_str":
            return cur if isinstance(cur, str) else v
        return cur if cur is not None else v

    # ---------- backend: identity ----------
    def _me(self, op: str):
        if op == "name":
            return self.name
        if op == "role":
            return 1
        if op == "role_name":
            return self.role_name
        if op == "color":
            return tuple(self.color)
        if op == "badge_id":
            return self.badge_id
        if op == "provisioned":
            return self.badge_id is not None
        raise LuaError(f"unknown me op {op}")

    def _contacts(self, op: str, i=None):
        if op == "count":
            return 0
        return (None, "out of range")

    def _app(self, op: str):
        if op == "slug":
            return self.manifest.get("slug", self.app_dir.name)
        if op == "name":
            return self.manifest.get("name", self.app_dir.name)
        if op == "exit":
            self.exit_requested = True
            return None
        raise LuaError(f"unknown app op {op}")

    # ---------- backend: fs ----------
    def _fs_path(self, p) -> str:
        p = _need_str(p, "path")
        if p == "" or p.startswith("/") or "\\" in p or "\0" in p or ".." in p.split("/"):
            raise LuaError(f"rejected path '{p}'")
        return p

    def _fs_usage(self) -> int:
        total = sum(len(v) for v in self.appdata.values())
        for f in self.app_dir.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
        return total

    def _fs(self, op: str, p=None, data=None):
        if op == "list":
            names = []
            sub = self._fs_path(p) if p else ""
            base = self.app_dir / sub if sub and not sub.startswith("appdata") else self.app_dir
            if base.exists():
                names += [f.name for f in base.iterdir()]
            if not sub or sub.startswith("appdata"):
                names += [k.split("/", 1)[1] for k in self.appdata]
            return self.lua.table_from(sorted(names))
        p = self._fs_path(p)
        if op == "mkdir":
            return True
        private = p.startswith("appdata/")
        if op in ("write", "append"):
            if not isinstance(data, str):
                raise LuaError("fs data must be a string")
            b = data.encode("utf-8")
            old = self.appdata.get(p, b"") if private else b""
            new = old + b if op == "append" else b
            if len(new) > 16384:
                raise LuaError("file exceeds 16 KiB")
            if self._fs_usage() - len(old) + len(new) > 65536:
                raise LuaError("fs quota exceeded (64 KiB)")
            if not private:
                raise LuaError("simulator only allows writes under appdata/")
            self.appdata[p] = new
            return True
        if op == "read":
            if private:
                if p not in self.appdata:
                    return (None, "missing")
                return self.appdata[p].decode("utf-8")
            f = self.app_dir / p
            if not f.is_file():
                return (None, "missing")
            b = f.read_bytes()
            if len(b) > 16384:
                raise LuaError("file exceeds 16 KiB read limit")
            return b.decode("utf-8")
        if op == "exists":
            return p in self.appdata if private else (self.app_dir / p).is_file()
        if op == "remove":
            if private and p in self.appdata:
                del self.appdata[p]
                return True
            return False
        raise LuaError(f"unknown fs op {op}")

    # ---------- backend: nfc ----------
    def _nfc(self, op: str):
        if op == "enable":
            self.nfc_enabled = self.nfc_available
            return self.nfc_enabled
        if op == "disable":
            self.nfc_enabled = False
            return None
        if not self.nfc_enabled:
            if op == "card":
                return None
            if op == "read_text":
                return (None, "nfc disabled")
            return None
        if op == "card":
            if self.nfc_card is None or self.nfc_cleared:
                return None
            return self.lua.table_from(dict(self.nfc_card))
        if op == "read_text":
            self.world.nfc_reads += 1
            if self.nfc_card is None or self.nfc_text is None:
                return (None, "no NDEF text")
            return self.nfc_text
        if op == "clear":
            self.nfc_cleared = True
            return None
        raise LuaError(f"unknown nfc op {op}")

    def present_tag(self, uid: str, text: str | None) -> None:
        self.nfc_card = {"uid": uid, "sak": 0, "atqa": 68}
        self.nfc_text = text
        self.nfc_cleared = False

    def remove_tag(self) -> None:
        self.nfc_card = None
        self.nfc_text = None

    # ---------- backend: radio ----------
    def _radio(self, op: str, *a):
        if op == "enable":
            self.radio_enabled = self.radio_available
            return self.radio_enabled
        if op == "disable":
            self.radio_enabled = False
            return None
        if op == "mac":
            return self.mac
        if op == "dropped":
            return self.dropped
        if op == "on_recv":
            self.recv_cb = a[0] if a else None
            return None
        if op == "send":
            p = a[0] if a else None
            if not isinstance(p, str):
                self.violations.append(f"radio.send non-string payload {p!r}")
                return False
            n = len(p.encode("utf-8"))
            if n < 1 or n > 44:
                self.violations.append(f"radio.send payload {n} bytes: {p!r}")
                return False
            if not self.radio_enabled:
                return False
            self.sent.append(p)
            self.world.broadcast(self, p)
            return True
        raise LuaError(f"unknown radio op {op}")

    def receive(self, mac: str, rssi: int, payload: str) -> None:
        """Called by the world: put a frame in the 8-slot ring (dropped when full)."""
        if not self.radio_enabled or not self.open_state:
            return
        if len(self.rx_ring) >= 8:
            self.dropped += 1
            return
        self.rx_ring.append((mac, rssi, payload))

    # ---------- backend: require ----------
    def _require(self, name):
        name = _need_str(name, "module name")
        if not re.match(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$", name) or len(name) > 48:
            raise LuaError(f"bad module name '{name}'")
        if name in self._modules:
            return self._modules[name]
        if name in self._loading:
            raise LuaError(f"require cycle: {name}")
        if len(self._modules) >= 16:
            raise LuaError("too many modules (16)")
        f = self.app_dir / (name.replace(".", "/") + ".lua")
        if not f.is_file():
            raise LuaError(f"module not found: {name}")
        self._loading.add(name)
        try:
            fn = self.lua.compile(f.read_text(encoding="utf-8"))
            val = fn()
        finally:
            self._loading.discard(name)
        self._modules[name] = val if val is not None else True
        return self._modules[name]
