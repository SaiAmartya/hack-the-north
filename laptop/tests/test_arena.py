from phantom_host.arena import Arena
from phantom_host.deck import default_deck

MAC1, MAC2 = "AA:BB:CC:DD:00:01", "AA:BB:CC:DD:00:02"


def make() -> Arena:
    a = Arena()
    a.deck = [c.__dict__ for c in default_deck()]
    return a


def test_heartbeats_create_named_players_and_join_events():
    a = make()
    ev = a.ingest(MAC1, -50, "PAH00011MD1Ada", now=1.0)
    assert ev and ev[0]["kind"] == "join" and "Ada joined" in ev[0]["text"]
    a.ingest(MAC2, -60, "PAH00022MD0Bob", now=1.5)
    assert a.name_of("0001") == "Ada" and a.name_of("0002") == "Bob"
    assert a.host_id == "0001"
    assert a.ingest(MAC1, -50, "PAH00011MD1Ada", now=2.0) == []  # no duplicate join


def test_snapshot_updates_hp_and_phase():
    a = make()
    a.ingest(MAC1, -50, "PAH00011MD1Ada", now=1.0)
    ev = a.ingest(MAC1, -50, "PASFD00000016400002527", now=2.0)
    assert ev[0]["kind"] == "phase" and "fight" in ev[0]["text"]
    p = a.players["0002"].public()
    assert (p["hp"], p["st"], p["dead"], p["hidden"], p["warded"]) == (82, 7, True, True, True)
    snap = a.snapshot(now=2.0)
    assert snap["phase_name"] == "fight" and snap["host_name"] == "Ada"
    assert [q["id"] for q in snap["players"]] == ["0001", "0002"]


def test_events_produce_log_lines_kill_counters_and_dedupe():
    a = make()
    a.ingest(MAC1, -50, "PAH00011MD1Ada", now=1.0)
    a.ingest(MAC2, -60, "PAH00022MD0Bob", now=1.0)
    ev = a.ingest(MAC1, -50, "PAEH010002000112L", now=2.0)
    assert ev[0]["kind"] == "hit" and ev[0]["text"] == "Bob LIGHTNING Ada -18"
    assert a.ingest(MAC1, -50, "PAEH010002000112L", now=2.1) == []  # resend ignored
    ev = a.ingest(MAC1, -50, "PAEK020002000100L", now=3.0)
    assert ev[0]["kind"] == "kill"
    assert a.players["0002"].kills == 1 and a.players["0001"].deaths == 1
    ev = a.ingest(MAC1, -50, "PAEO030002000100D", now=4.0)
    assert ev[0]["kind"] == "over" and ev[0]["winner"] == "Bob" and a.matches == 1
    ev = a.ingest(MAC1, -50, "PAED040001001502d", now=5.0)
    assert ev[0]["kind"] == "decree" and ev[0]["card"]["title"] == "Blood Frenzy"
    assert a.snapshot(now=6.0)["decree_card"]["title"] == "Blood Frenzy"
    assert a.snapshot(now=30.0)["decree_card"] is None


def test_casts_and_loot_feed_stats():
    a = make()
    a.ingest(MAC2, -60, "PAH00022MD0Bob", now=1.0)
    ev = a.ingest(MAC2, -60, "PAC010002F2370001", now=2.0)
    assert ev[0]["kind"] == "cast" and ev[0]["targets"] == ["0001"] and ev[0]["spell"] == "F"
    assert a.ingest(MAC2, -60, "PAC010002F2370001", now=2.1) == []
    ev = a.ingest(MAC2, -60, "PAL0002e2", now=3.0)
    assert ev[0]["kind"] == "loot" and "Bob found Ember Core x2" in ev[0]["text"]
    st = a.snapshot(now=3.0)["stats"]
    assert st == {"badges": 1, "matches": 0, "loot": 2, "casts": 1, "frames": 4}  # frames counts the resend too


def test_prune_removes_silent_badges():
    a = make()
    a.ingest(MAC2, -60, "PAH00022MD0Bob", now=1.0)
    assert a.prune(now=10.0) == []
    ev = a.prune(now=20.0)
    assert ev[0]["kind"] == "leave" and "0002" not in a.players


def test_ingest_line_ignores_noise():
    a = make()
    assert a.ingest_line("[pa_base] PAST|frames=1|badges=1|dropped=0") == []
    assert a.ingest_line("garbage") == []
    assert a.ingest_line("[pa_base] PARX|AA:BB:CC:DD:00:02|-60|PAH00022MD0Bob")[0]["kind"] == "join"
