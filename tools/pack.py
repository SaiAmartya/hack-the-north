#!/usr/bin/env python3
"""Build the badge IDE bundles and check every limit.

Usage:
    python tools/pack.py                 # packs badge/phantom_arena and badge/pa_base into dist/
    python tools/pack.py badge/pa_base   # one app

For each app directory this:
  * validates manifest.cfg keys/values (slug, name, icon, api, heap_kb, wake_lock, home_button, confirm_home)
  * checks every .lua file respects the sandbox (no pcall/xpcall/setmetatable/load/os./io./coroutine)
  * writes dist/<slug>.lua           = main.lua with the --[==[badge-app ... ]==] header (paste into Import app)
           dist/<slug>.min.lua       = same, indentation and comment lines stripped (line numbers preserved)
           dist/<slug>.<module>.lua  = each extra module (add it in the IDE with "+", same file name)
           dist/<slug>.<module>.min.lua
  * reports bytes against the caps: 64 KiB main.lua, 48 KiB / 16 files Share bundle, 16 KiB per fs file
  * compiles each file with a real Lua 5.4 (lupa) when available and reports bytecode size
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
MAIN_CAP = 64 * 1024
SHARE_CAP = 48 * 1024
SHARE_FILES = 16
FS_FILE_CAP = 16 * 1024
FORBIDDEN = [
    (r"\bpcall\s*\(", "pcall is not available in the badge sandbox"),
    (r"\bxpcall\s*\(", "xpcall is not available in the badge sandbox"),
    (r"\bsetmetatable\s*\(", "setmetatable is not available in the badge sandbox"),
    (r"\bgetmetatable\s*\(", "getmetatable is not documented for the badge sandbox"),
    (r"\bload\s*\(", "load is not available in the badge sandbox"),
    (r"\bloadfile\s*\(", "loadfile is not available in the badge sandbox"),
    (r"\bdofile\s*\(", "dofile is not available in the badge sandbox"),
    (r"\bos\.", "os library is absent on the badge"),
    (r"\bio\.", "io library is absent on the badge"),
    (r"\bcoroutine\.", "coroutine library is absent on the badge"),
    (r"\bdebug\.", "debug library is absent on the badge"),
    (r"\bpackage\.", "package library is absent on the badge"),
    (r"\bbadge\.(wifi|http|socket|lvgl|ble|audio|timer)\b", "invented badge API"),
]
MANIFEST_KEYS = {"slug", "name", "icon", "api", "heap_kb", "wake_lock", "home_button", "confirm_home", "version", "author"}


def read_manifest(app: Path) -> dict[str, str]:
    m: dict[str, str] = {}
    for raw in (app / "manifest.cfg").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise SystemExit(f"{app}: manifest line without '=': {raw!r}")
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in m:
            raise SystemExit(f"{app}: duplicate manifest key {k}")
        m[k] = v
    return m


def check_manifest(app: Path, m: dict[str, str]) -> list[str]:
    errs = []
    for k in m:
        if k not in MANIFEST_KEYS:
            errs.append(f"unknown manifest key {k}")
    slug = m.get("slug", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", slug):
        errs.append(f"bad slug {slug!r}")
    if slug != app.name:
        errs.append(f"slug {slug!r} must equal the folder name {app.name!r}")
    if not 1 <= len(m.get("name", "").encode()) <= 48:
        errs.append("name must be 1-48 bytes")
    if "icon" in m and not 1 <= len(m["icon"].encode()) <= 12:
        errs.append("icon must be 1-12 bytes")
    if m.get("api", "1") not in ("1", "2"):
        errs.append("api must be 1 or 2")
    if m.get("heap_kb", "48") not in ("48", "96"):
        errs.append("heap_kb must be 48 or 96")
    for k in ("wake_lock", "home_button", "confirm_home"):
        if m.get(k, "0") not in ("0", "1"):
            errs.append(f"{k} must be 0 or 1")
    if m.get("confirm_home") == "1" and m.get("home_button") == "1":
        errs.append("confirm_home=1 cannot be combined with home_button=1")
    return errs


def check_source(src: str) -> list[str]:
    errs = []
    for i, line in enumerate(src.splitlines(), 1):
        code = line.split("--", 1)[0]
        for pat, why in FORBIDDEN:
            if re.search(pat, code):
                errs.append(f"line {i}: {why}: {line.strip()[:70]}")
    return errs


def minify(src: str) -> str:
    """Strip indentation, trailing whitespace and whole-line comments; keep line numbers."""
    out = []
    in_long = False
    for line in src.splitlines():
        s = line.strip()
        if in_long:
            out.append(line.rstrip())
            if "]]" in line or "]==]" in line:
                in_long = False
            continue
        if s.startswith("--") and not s.startswith("--[[") and not s.startswith("--[=="):
            out.append("")
            continue
        if "[[" in s and "]]" not in s:
            in_long = True
        out.append(s)
    return "\n".join(out) + "\n"


def header(m: dict[str, str]) -> str:
    return "--[==[badge-app\n" + "".join(f"{k}={v}\n" for k, v in m.items()) + "]==]\n\n"


def bytecode_size(src: str) -> tuple[int, int] | None:
    try:
        from lupa import lua54  # type: ignore
    except Exception:
        try:
            import lupa as lua54  # type: ignore
        except Exception:
            return None
    L = lua54.LuaRuntime()
    try:
        fn = L.compile(src)
    except Exception as e:  # pragma: no cover
        raise SystemExit(f"Lua syntax error: {e}")
    dump = L.eval("function(f) return #string.dump(f), #string.dump(f, true) end")
    full, stripped = dump(fn)
    return int(full), int(stripped)


def pack(app: Path) -> bool:
    ok = True
    m = read_manifest(app)
    slug = m["slug"]
    problems = check_manifest(app, m)
    files = [p for p in app.rglob("*") if p.is_file() and p.name != "README.md"]
    lua_files = sorted(p for p in files if p.suffix == ".lua")
    DIST.mkdir(exist_ok=True)
    bundle_readable = bundle_min = 0
    for p in files:
        rel = p.relative_to(app).as_posix()
        if len(rel.encode()) > 64 or rel.count("/") > 3:
            problems.append(f"bundle path too long/deep for Share: {rel}")
        if p.suffix == ".txt" and p.stat().st_size > FS_FILE_CAP:
            problems.append(f"{rel} exceeds the 16 KiB badge.fs read limit")
        if p.suffix != ".lua":
            bundle_readable += p.stat().st_size
            bundle_min += p.stat().st_size
    for p in lua_files:
        src = p.read_text(encoding="utf-8")
        problems += [f"{p.name}: {e}" for e in check_source(src)]
        nbytes = len(src.encode("utf-8"))
        if nbytes > MAIN_CAP:
            problems.append(f"{p.name} is {nbytes} bytes, over the 64 KiB cap")
        mini = minify(src)
        mini_bytes = len(mini.encode("utf-8"))
        bundle_readable += nbytes
        bundle_min += mini_bytes
        if p.name == "main.lua":
            out, out_min = DIST / f"{slug}.lua", DIST / f"{slug}.min.lua"
            out.write_text(header(m) + src, encoding="utf-8", newline="\n")
            out_min.write_text(header(m) + mini, encoding="utf-8", newline="\n")
        else:
            out, out_min = DIST / f"{slug}.{p.stem}.lua", DIST / f"{slug}.{p.stem}.min.lua"
            out.write_text(src, encoding="utf-8", newline="\n")
            out_min.write_text(mini, encoding="utf-8", newline="\n")
        bc = bytecode_size(src)
        bc_txt = f"; bytecode {bc[0]:,} B ({bc[1]:,} stripped)" if bc else ""
        print(f"[{slug}] {p.name}: {nbytes:,} B readable, {mini_bytes:,} B minified{bc_txt} -> dist/{out_min.name}")
    print(f"[{slug}] Share bundle: {len(files)} files, {bundle_readable:,} B readable / {bundle_min:,} B minified (cap {SHARE_CAP:,} B, {SHARE_FILES} files)")
    if bundle_min > SHARE_CAP:
        problems.append(f"minified bundle {bundle_min} B exceeds the 48 KiB Share cap")
    elif bundle_readable > SHARE_CAP:
        print(f"[{slug}] NOTE: install the .min.lua files (the readable build does not fit the Share cap)")
    if len(files) > SHARE_FILES:
        problems.append("more than 16 files in the bundle")
    for p in problems:
        print(f"[{slug}] PROBLEM: {p}")
        ok = False
    return ok


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    apps = [ROOT / a for a in argv[1:]] or [ROOT / "badge" / "phantom_arena", ROOT / "badge" / "pa_base"]
    ok = True
    for app in apps:
        ok = pack(app) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
