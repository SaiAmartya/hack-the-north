"""The packed/minified bundle must still be a working app, and the packer must catch sandbox violations."""
import importlib.util
import shutil
from pathlib import Path

from badge_sim import World

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "badge" / "phantom_arena"


def load_pack():
    spec = importlib.util.spec_from_file_location("pack", ROOT / "tools" / "pack.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_minified_app_still_duels(tmp_path):
    pack = load_pack()
    app = tmp_path / "phantom_arena"
    shutil.copytree(APP, app)
    for lua in APP.glob("*.lua"):
        src = lua.read_text(encoding="utf-8")
        mini = pack.minify(src)
        assert len(mini) < len(src)
        assert mini.count("\n") == src.count("\n"), "line numbers must be preserved for tracebacks"
        (app / lua.name).write_text(mini, encoding="utf-8", newline="\n")
    w = World()
    a = w.add_badge(app, "AA:BB:CC:DD:00:01", name="Ada")
    b = w.add_badge(app, "AA:BB:CC:DD:00:02", name="Bob")
    a.open()
    b.open()
    w.run(3000)
    w.gesture(b, ["+Y", "-Y"])
    w.run(1500)
    assert a.find_text("Ada  82") and b.find_text("Ada  82")
    assert a.find_text("DECREE") is False  # the long-string deck survived minification and parsed silently


def test_bootstrap_starts_radio_before_loading_the_game():
    """Bluetooth needs a clean heap: main.lua must call radio.enable before require("game")."""
    src = (APP / "main.lua").read_text(encoding="utf-8")
    assert src.index("badge.radio.enable()") < src.index('require("game")')
    assert len(src.encode()) < 2000, "the bootstrap must stay tiny"
    w = World()
    a = w.add_badge(APP, "AA:BB:CC:DD:00:01", name="Ada")
    a.open()
    w.run(500)
    assert any(l.startswith("PAMEM|boot|") for l in a.logs)
    assert any(l.startswith("PAMEM|radio on|") for l in a.logs)
    assert any(l.startswith("PAMEM|ready|") for l in a.logs)


def test_app_survives_radio_failure():
    w = World()
    a = w.add_badge(APP, "AA:BB:CC:DD:00:01", name="Ada", radio_available=False)
    a.open()
    w.run(1000)
    assert any(l.startswith("PAMEM|radio FAILED|") for l in a.logs)
    assert a.find_text("Radio unavailable")
    w.button_cast(a, "UP")
    w.run(300)
    assert not a.violations


def test_packer_flags_sandbox_violations_and_manifest_errors():
    pack = load_pack()
    problems = pack.check_source("local ok = pcall(print)\nlocal t = setmetatable({}, {})\nprint(os.time())\n-- pcall(comment) is fine\n")
    assert len(problems) == 3
    for lua in APP.glob("*.lua"):
        assert pack.check_source(lua.read_text(encoding="utf-8")) == []
    m = pack.read_manifest(APP)
    assert pack.check_manifest(APP, m) == []
    bad = dict(m, confirm_home="1", home_button="1", heap_kb="128")
    errs = pack.check_manifest(APP, bad)
    assert any("heap_kb" in e for e in errs) and any("confirm_home" in e for e in errs)


def test_bundle_fits_share_caps():
    files = [p for p in APP.rglob("*") if p.is_file()]
    assert len(files) <= 16
    pack = load_pack()
    total = 0
    for p in files:
        if p.suffix == ".lua":
            assert p.stat().st_size <= 64 * 1024
            total += len(pack.minify(p.read_text(encoding="utf-8")).encode())
        else:
            total += p.stat().st_size
    assert total <= 48 * 1024
