"""Badge simulator: runs Phantom Arena's real Lua in a sandbox that mirrors the
Hack the North 2026 badge firmware limits."""
from .badge import SimBadge, LuaError, PRESSED, RELEASED
from .world import World

__all__ = ["SimBadge", "World", "LuaError", "PRESSED", "RELEASED"]
