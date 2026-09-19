"""End-to-end tests of the real badge Lua (badge/phantom_arena) inside the simulator."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from badge_sim import LuaError, World

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "badge" / "phantom_arena"
BASE = ROOT / "badge" / "pa_base"


def make(n: int = 2, app: Path = APP, **kw):
    w = World(**kw)
    badges = [w.add_badge(app, f"AA:BB:CC:DD:00:{i:02X}", name=f"Mage{i}") for i in range(1, n + 1)]
    for b in badges:
        b.open()
    w.run(3000)  # gravity estimate settles, heartbeats exchanged, host elected
    return w, badges


def frames(w: World, prefix: str, sender=None) -> list[str]:
    return [p for _, mac, _, p in w.transcript if p.startswith(prefix) and (sender is None or mac == sender.mac)]


def menu_pick(b, item: int) -> None:
    """Open the START menu and choose item N (1-based)."""
    b.click("START")
    for _ in range(item - 1):
        b.click("DOWN")
    b.click("A")


# ---------- loading and limits ----------

def test_app_loads_within_limits_and_greets_by_name():
    w, (a,) = make(1)
    assert a.live_widgets() <= 512
    assert not a.violations
    assert not a.budget_violations()
    assert a.find_text("Mage1  100")
    assert a.find_text("host YOU")


def test_every_frame_is_prefixed_and_within_44_bytes():
    w, bs = make(3)
    w.gesture(bs[1], ["+Y", "-Y"])
    w.button_cast(bs[2], "START")  # vortex: multi-target frame
    w.run(1000)
    assert w.transcript, "no frames were sent"
    for _, _, _, p in w.transcript:
        assert p.startswith("PA")
        assert 1 <= len(p.encode("utf-8")) <= 44, p
    for b in bs:
        assert not b.violations


def test_name_is_sanitized_to_ten_ascii_chars():
    w = World()
    a = w.add_badge(APP, "AA:BB:CC:DD:00:01", name="Zoë-Q. \"The\" Wizard!!!")
    b = w.add_badge(APP, "AA:BB:CC:DD:00:02", name="Bob")
    a.open()
    b.open()
    w.run(3000)
    hb = frames(w, "PAH", a)[0]
    assert hb[11:] == "ZoQ The Wi"
    assert b.find_text("ZoQ The Wi joined")


def test_simulator_enforces_sandbox(tmp_path):
    app = tmp_path / "bad_app"
    app.mkdir()
    (app / "manifest.cfg").write_text("slug=bad_app\nname=Bad\napi=2\n")
    (app / "main.lua").write_text("function on_enter(root) pcall(print, 'x') end\n")
    w = World()
    b = w.add_badge(app, "AA:BB:CC:DD:00:01")
    with pytest.raises(LuaError):
        b.open()


# ---------- host election ----------

def test_lowest_mac_becomes_host_and_everyone_agrees():
    w, (a, b, c) = make(3)
    assert a.find_text("host YOU")
    assert b.find_text("host Mage1")
    assert c.find_text("host Mage1")
    assert all(x.find_text("3 in arena") for x in (a, b, c))


def test_host_failover_keeps_hp():
    w, (a, b, c) = make(3)
    b.click("RIGHT")  # target c instead of a
    w.run(200)
    w.gesture(b, ["+Y", "-Y"])
    w.run(1500)
    assert c.find_text("Mage3  82")
    a.home()  # host presses HOME
    w.run(5000)
    assert b.find_text("host YOU")
    assert c.find_text("host Mage2")
    assert c.find_text("Mage3  82"), "new host lost the snapshot state"
    assert not b.violations and not c.violations


def test_departed_badge_is_dropped_after_timeout():
    w, (a, b) = make(2)
    b.home()
    w.run(17000)
    assert a.find_text("Mage2 left the arena")
    assert a.find_text("1 in arena")


# ---------- casting ----------

def test_gesture_lightning_hits_the_target_and_logs():
    w, (a, b) = make(2)
    w.gesture(b, ["+Y", "-Y"])
    w.run(1500)
    assert b.find_text("+Y -Y = LIGHTNING")
    assert a.find_text("Mage1  82")           # own hp on the host
    assert b.find_text("Mage1  82")           # target hp on the caster
    assert a.find_text("Mage2 LIGHTNING Mage1 -18")


def test_cast_retransmissions_are_deduplicated():
    w, (a, b) = make(2)
    w.gesture(b, ["+Y", "-Y"])
    w.run(1500)
    casts = frames(w, "PAC", b)
    assert len(casts) == 3 and len(set(casts)) == 1
    assert len(frames(w, "PAEH")) == 1
    assert a.find_text("Mage1  82")


def test_lossy_radio_still_lands_a_cast():
    w, (a, b) = make(2, loss=0.35, seed=3)
    w.gesture(b, ["+Y", "-Y"])
    w.run(2500)
    assert a.find_text("Mage1  82")


def test_button_fallback_casts_without_accelerometer():
    w, (a, b) = make(2)
    b.accel_available = False
    w.button_cast(b, "UP")
    w.run(1500)
    assert b.find_text("button = LIGHTNING")
    assert a.find_text("Mage1  82")


def test_unknown_gesture_is_reported_not_cast():
    w, (a, b) = make(2)
    w.gesture(b, ["+Z", "+Z", "+Z"])  # three pushes: not within edit tolerance of any spell
    w.run(500)
    assert b.find_text("= ?")
    assert not frames(w, "PAC", b)


def test_cooldown_blocks_spam():
    w, (a, b) = make(2)
    w.button_cast(b, "UP")
    w.run(200)
    w.button_cast(b, "UP")
    w.run(1500)
    assert b.find_text("LIGHTNING is cooling down")
    assert a.find_text("Mage1  82")


def test_ward_absorbs_one_hit():
    w, (a, b) = make(2)
    w.gesture(a, ["-Y", "+Y"])  # ward
    w.run(600)
    assert a.find_text("Mage1 raises a ward")
    w.gesture(b, ["+Y", "-Y"])
    w.run(1500)
    assert a.find_text("Mage1  100")
    assert b.find_text("Mage2 LIGHTNING warded by Mage1")


def test_face_down_raises_ward():
    w, (a, b) = make(2)
    a.orientation = "flat_down"
    w.run(800)
    a.orientation = "flat_up"
    assert a.find_text("Mage1 raises a ward")


def test_heal_restores_hp():
    w, (a, b) = make(2)
    w.button_cast(b, "UP")
    w.run(1500)
    assert a.find_text("Mage1  82")
    w.gesture(a, ["-X", "+X"])
    w.run(600)
    assert a.find_text("Mage1  100")


def test_melee_jab_needs_proximity():
    w, (a, b) = make(2, default_rssi=-75)
    w.tap(b)
    w.run(300)
    assert b.find_text("JAB: get closer")
    w.set_rssi(a, b, -40)
    w.run(1500)
    w.tap(b)
    w.run(1000)
    assert a.find_text("Mage1  91")


def test_fireball_damage_falls_off_with_distance():
    w, (a, b) = make(2, default_rssi=-45)
    w.button_cast(b, "B")
    w.run(1500)
    assert a.find_text("Mage1  66")  # 34 at full strength
    w2, (a2, b2) = make(2, default_rssi=-80)
    w2.button_cast(b2, "B")
    w2.run(1500)
    assert a2.find_text("Mage1  88")  # 34 * 0.35 = 12


def test_hidden_mage_cannot_be_targeted_from_afar():
    w, (a, b) = make(2, default_rssi=-75)
    w.gesture(a, ["+X", "-X"])  # phase
    w.run(600)
    assert a.find_text("Mage1 vanishes")
    w.button_cast(b, "UP")
    w.run(500)
    assert b.find_text("no target")
    w.set_rssi(a, b, -40)
    w.run(1500)
    w.button_cast(b, "UP")
    w.run(1500)
    assert a.find_text("Mage1  82")


def test_shake_burst_hits_everyone_in_reach():
    w, (a, b, c) = make(3, default_rssi=-45)
    w.shake(a)
    w.run(1500)
    assert b.find_text("Mage2  9")
    assert c.find_text("Mage3  9")
    burst = frames(w, "PAC", a)[0]
    assert burst[13:] in ("00020003", "00030002")


# ---------- match flow ----------

def test_match_start_fight_and_winner():
    w, (a, b) = make(2)
    menu_pick(b, 1)  # b (a client) asks the host to start a duel
    w.run(1500)
    assert a.find_text("FIGHT Duel") and b.find_text("FIGHT Duel")
    for _ in range(6):
        w.button_cast(a, "UP")
        w.run(1600)
    assert a.find_text("MATCH OVER")
    assert b.find_text("MATCH OVER: Mage1 wins")
    assert a.find_text("Mage1 LIGHTNING KO Mage2!")
    w.run(9000)
    assert a.find_text("LOBBY") and b.find_text("LOBBY")
    assert b.find_text("Mage2  100")


def test_lobby_respawns_the_fallen():
    w, (a, b) = make(2)
    for _ in range(6):
        w.button_cast(a, "UP")
        w.run(1600)
    w.run(3500)  # lobby respawn after 3 s
    assert b.find_text("Mage2 respawns")
    assert b.find_text("Mage2  100")


def test_team_mode_has_no_friendly_fire():
    w, (a, b, c) = make(3)
    menu_pick(c, 5)  # c switches team
    c.click("B")
    w.run(1500)
    menu_pick(a, 2)  # team battle
    w.run(1500)
    assert a.find_text("FIGHT Teams")
    w.button_cast(a, "UP")
    w.run(1500)
    assert b.find_text("Mage2  100")
    assert c.find_text("Mage3  82")


def test_raid_boss_has_scaled_hp_and_enrages():
    w, (a, b, c) = make(3, default_rssi=-45)
    menu_pick(c, 4)  # c becomes the Phantom
    c.click("B")
    w.run(1500)
    menu_pick(a, 3)  # raid
    w.run(1500)
    assert a.find_text("FIGHT Raid")
    a.click("RIGHT")  # target the boss
    w.run(200)
    for _ in range(7):
        w.button_cast(a, "B")  # 7 fireballs = 238 of 450 boss hp
        w.run(4100)
    assert frames(w, "PAEB"), "no enrage event was broadcast"
    assert c.find_text("Mage3  47")
    assert c.find_text("[PHANTOM]")
    assert c.find_text("DECREE: Phantom Rage")  # the boss trigger drew the boss card


def test_snapshot_pages_reach_all_eight_badges():
    w, bs = make(8)
    w.run(2000)
    for b in bs:
        assert b.find_text("8 in arena"), b.screen_text()
    assert {p[5] for p in frames(w, "PAS")} == {"0", "1"}
    assert not any(b.violations for b in bs)


# ---------- game master deck ----------

def test_decree_fires_on_low_hp_and_shows_card():
    w, (a, b) = make(2)
    menu_pick(a, 1)
    w.run(1500)
    for _ in range(5):
        w.button_cast(a, "UP")
        w.run(1600)
    assert b.find_text("Mage2  10")
    w.run(8000)  # first decree is allowed 15 s after match start
    assert a.find_text("DECREE:") and b.find_text("DECREE:")


def test_deck_txt_overrides_the_default_deck_and_altar_tags_apply_it(tmp_path):
    app = tmp_path / "phantom_arena"
    shutil.copytree(APP, app)
    (app / "deck.txt").write_text("timer|cd|5|20|Custom Quickening|Test card from the laptop deck.\n")
    w, (a, b) = make(2, app=app)
    menu_pick(b, 7)  # shrine
    w.run(300)
    b.present_tag("04DEADBEEF", "pa:decree:1:20")
    w.run(1200)
    assert b.find_text("DECREE: Custom Quickening")
    b.click("B")
    w.run(500)
    assert a.find_text("DECREE: Custom Quickening")
    assert b.find_text("DECREE: Custom Quickening")


# ---------- NFC shrines ----------

def test_shrine_loot_once_per_tag_persists_and_announces():
    w, (a, b) = make(2)
    menu_pick(b, 7)
    w.run(300)
    b.present_tag("04A1B2C3", "pa:loot:e:2")
    w.run(600)
    assert b.find_text("You found Ember Core x2")
    assert b.store["inv"] == "p0e2k0"
    assert frames(w, "PAL", b)
    assert a.find_text("Mage2 found Ember Core x2")
    b.click("B")  # leave the shrine and come back with the same sticker
    b.remove_tag()
    menu_pick(b, 7)
    w.run(300)
    b.present_tag("04A1B2C3", "pa:loot:e:2")
    w.run(600)
    assert b.find_text("Already claimed")
    assert b.store["inv"] == "p0e2k0"
    b.click("B")
    b.reopen()
    w.run(500)
    b.click("DOWN")
    w.run(200)
    assert b.find_text("Ember Core x2")


def test_shrine_rejects_foreign_tags():
    w, (a, b) = make(2)
    menu_pick(b, 7)
    w.run(300)
    b.present_tag("0499", "https://example.com")
    w.run(600)
    assert b.find_text("Not a shrine tag")


def test_item_use_ember_boosts_next_hit():
    w, (a, b) = make(2)
    b.store["inv"] = "p0e1k0"
    b.reopen()
    w.run(3000)
    b.click("DOWN")  # select Ember Core (item 2)
    b.click("B")     # use it
    w.run(600)
    assert a.find_text("Mage2 uses Ember Core")
    w.button_cast(b, "UP")
    w.run(1500)
    assert a.find_text("Mage1  73")  # 18 * 1.5 = 27


# ---------- teaching gestures ----------

def test_teach_spell_persists_and_is_recognized():
    w, (a, b) = make(2)
    menu_pick(b, 6)
    w.run(200)
    assert b.find_text("TEACH LIGHTNING")
    for _ in range(3):
        w.gesture(b, ["+Z", "-Z"])
        w.run(200)
    assert b.store["g_L"] == "+Z -Z"
    assert b.find_text("Learned LIGHTNING: +Z -Z")
    b.click("B")
    w.run(200)
    w.gesture(b, ["+Z", "-Z"])
    w.run(1500)
    assert a.find_text("Mage1  82")
    b.reopen()
    w.run(3000)
    w.gesture(b, ["+Z", "-Z"])
    w.run(1500)
    assert a.find_text("Mage1  64")


def test_teach_picks_the_consistent_attempt():
    w, (a, b) = make(2)
    menu_pick(b, 6)
    w.run(200)
    w.gesture(b, ["+X", "+Y"])
    w.gesture(b, ["+X", "+Y", "-X"])
    w.gesture(b, ["+X", "+Y"])
    w.run(200)
    assert b.store["g_L"] == "+X +Y"


# ---------- base station and performance ----------

def test_base_station_relays_every_frame_to_serial():
    w = World()
    a = w.add_badge(APP, "AA:BB:CC:DD:00:01", name="Ada")
    base = w.add_badge(BASE, "AA:BB:CC:DD:00:FF", name="Base")
    a.open()
    base.open()
    w.run(6000)
    relayed = [l for l in base.logs if l.startswith("PARX|")]
    assert relayed
    assert all(l.split("|")[3].startswith("PA") for l in relayed)
    assert any(l.startswith("PAST|frames=") for l in base.logs)
    assert base.find_text("badges heard")


def test_tick_work_stays_small_in_a_busy_arena():
    w, bs = make(4)
    for i in range(6):
        w.button_cast(bs[i % 4], "UP")
        w.run(400)
    w.run(5000)
    for b in bs:
        assert not b.budget_violations(), b.budget_violations()
        avg = b.tick_time_total / max(1, b.tick_count)
        assert avg < 3.0, f"average on_tick {avg:.2f} ms on the laptop"
