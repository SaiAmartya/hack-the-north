from pathlib import Path

from badge_sim import World
from phantom_host.protocol import Cast, Event, Heartbeat, Loot, Snapshot, id_of_mac, parse_base_line, parse_frame

APP = Path(__file__).resolve().parents[2] / "badge" / "phantom_arena"


def test_heartbeat():
    f = parse_frame("PAH00011MD1Ada")
    assert isinstance(f, Heartbeat)
    assert (f.id, f.team, f.role, f.mode, f.is_host, f.name) == ("0001", "1", "M", "D", True, "Ada")


def test_cast_single_and_multi_target():
    f = parse_frame("PAC0A0002L2370001")
    assert isinstance(f, Cast)
    assert (f.seq, f.caster, f.spell, f.charge, f.rssi, f.targets) == (10, "0002", "L", 2, -55, ["0001"])
    f = parse_frame("PAC0B0001B3320002000300040005")
    assert f.targets == ["0002", "0003", "0004", "0005"]
    assert parse_frame("PAC0B0001") is None  # truncated


def test_snapshot_pages():
    f = parse_frame("PASFD00300016400002527")
    assert isinstance(f, Snapshot)
    assert (f.phase, f.mode, f.page, f.decree) == ("F", "D", 0, 3)
    assert f.players == [("0001", 100, 0), ("0002", 82, 7)]
    assert parse_frame("PASXD000") is None  # bad phase


def test_event_text():
    names = {"0001": "Ada", "0002": "Bob"}.get
    e = parse_frame("PAEH010002000112L")
    assert isinstance(e, Event)
    assert e.text(names) == "Bob LIGHTNING Ada -18"
    assert parse_frame("PAEK020001000200F").text(names) == "Ada FIREBALL KO Bob!"
    assert parse_frame("PAEO03MAGE000100R").text(names) == "MATCH OVER: The mages wins"
    assert parse_frame("PAEO03TM10000100T").text(names) == "MATCH OVER: Team Red wins"
    assert parse_frame("PAED040001002007d").text(names) == "DECREE #7 for 20s"


def test_loot_and_base_line():
    f = parse_frame("PAL0002e2")
    assert isinstance(f, Loot) and (f.id, f.item, f.qty) == ("0002", "e", 2)
    rec = parse_base_line("[pa_base] PARX|aa:bb:cc:dd:00:02|-51|PAL0002e2")
    assert rec == ("AA:BB:CC:DD:00:02", -51, "PAL0002e2")
    assert parse_base_line("PAST|frames=3|badges=1|dropped=0") is None
    assert id_of_mac("AA:BB:CC:DD:00:02") == "0002"


def test_rejects_garbage_and_oversize():
    assert parse_frame("") is None
    assert parse_frame("HELLO1:hi") is None
    assert parse_frame("PAZ" + "x" * 10) is None
    assert parse_frame("PAH" + "x" * 50) is None


def test_every_frame_from_the_real_app_parses():
    """Cross-check: the Lua encoder and the Python decoder agree on every frame kind."""
    w = World(default_rssi=-45)
    bs = [w.add_badge(APP, f"AA:BB:CC:DD:00:{i:02X}", name=f"Mage{i}") for i in range(1, 4)]
    for b in bs:
        b.open()
    w.run(3000)
    bs[1].click("START"); bs[1].click("A")  # start a duel
    w.run(1000)
    w.button_cast(bs[0], "UP"); w.run(500)
    w.button_cast(bs[2], "START"); w.run(500)  # vortex, multi-target
    w.shake(bs[1]); w.run(500)
    bs[2].click("START"); [bs[2].click("DOWN") for _ in range(6)]; bs[2].click("A"); w.run(300)  # shrine
    bs[2].present_tag("04AA", "pa:loot:p:3"); w.run(800)
    kinds = set()
    for _, mac, rssi, payload in w.transcript:
        f = parse_frame(payload)
        assert f is not None, payload
        kinds.add(f.kind)
        if isinstance(f, Heartbeat):
            assert f.id == id_of_mac(mac)
    assert kinds == {"H", "C", "S", "E", "L"}
