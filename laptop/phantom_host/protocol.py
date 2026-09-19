"""Phantom Arena radio protocol, decoded on the laptop.

Mirrors badge/phantom_arena/main.lua exactly. Every frame is at most 44 bytes and
starts with "PA" followed by a kind letter:

  PAH <id4> <team1> <role1> <mode1> <host1> <name<=10>              heartbeat / identity
  PAC <seq2> <caster4> <spell1> <charge1> <rssi2> <targets 4*n>      cast (resent 3x)
  PAS <phase1> <mode1> <page1> <decree2> (<id4> <hp2> <st1>)*<=5     host snapshot, 4 Hz, paged
  PAE <kind1> <seq2> <a4> <b4> <v2> <s1>                            host event
  PAL <id4> <item1> <qty1>                                          loot pickup announcement

The base-station badge prints "PARX|<mac>|<rssi>|<payload>" per frame over USB.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SPELLS: dict[str, dict] = {
    "L": {"name": "LIGHTNING", "color": "#508cff", "kind": "dmg"},
    "F": {"name": "FIREBALL", "color": "#ff5a00", "kind": "dmg"},
    "W": {"name": "WARD", "color": "#00c8ff", "kind": "ward"},
    "V": {"name": "VORTEX", "color": "#b400ff", "kind": "aoe"},
    "H": {"name": "HEAL", "color": "#00ff5a", "kind": "heal"},
    "P": {"name": "PHASE", "color": "#783cc8", "kind": "hide"},
    "J": {"name": "JAB", "color": "#ffffff", "kind": "dmg"},
    "B": {"name": "BURST", "color": "#ffdc00", "kind": "aoe"},
    "p": {"name": "Potion", "color": "#ff88cc", "kind": "item"},
    "e": {"name": "Ember Core", "color": "#ff8800", "kind": "item"},
    "k": {"name": "Phase Cloak", "color": "#8866ff", "kind": "item"},
    "!": {"name": "START", "color": "#ffffff", "kind": "control"},
    "~": {"name": "RESET", "color": "#ffffff", "kind": "control"},
    "?": {"name": "DECREE", "color": "#ffcc55", "kind": "control"},
}
TEAMS = {"0": "Solo", "1": "Red", "2": "Blue", "3": "Green", "4": "Gold"}
MODES = {"D": "Duel", "T": "Teams", "R": "Raid"}
PHASES = {"L": "lobby", "F": "fight", "O": "over"}
ST_WARD, ST_HIDDEN, ST_DEAD = 1, 2, 4
EVENT_TEMPLATES = {  # same wording as the badge's EMSG table: args (a, spell, b, v)
    "H": "{a} {sp} {b} -{v}", "M": "{a} {sp} missed {b}", "W": "{a} {sp} warded by {b}", "G": "{a} raises a ward",
    "V": "{a} vanishes", "L": "{a} {sp} {b} +{v}", "K": "{a} {sp} KO {b}!", "R": "{a} respawns", "I": "{a} uses {sp}",
}

_BASE_RE = re.compile(r"PARX\|([0-9A-Fa-f:]{17})\|(-?\d+)\|(PA.*)$")
_ID = re.compile(r"^[0-9A-F]{4}$")


@dataclass
class Heartbeat:
    id: str
    team: str
    role: str
    mode: str
    is_host: bool
    name: str
    kind: str = "H"


@dataclass
class Cast:
    seq: int
    caster: str
    spell: str
    charge: int
    rssi: int
    targets: list[str] = field(default_factory=list)
    kind: str = "C"


@dataclass
class Snapshot:
    phase: str
    mode: str
    page: int
    decree: int
    players: list[tuple[str, int, int]] = field(default_factory=list)  # (id, hp percent, status bits)
    kind: str = "S"


@dataclass
class Event:
    ekind: str
    seq: int
    a: str
    b: str
    v: int
    s: str
    kind: str = "E"

    def text(self, name_of) -> str:
        sp = SPELLS.get(self.s, {}).get("name", "?")
        if self.ekind in EVENT_TEMPLATES:
            return EVENT_TEMPLATES[self.ekind].format(a=name_of(self.a), sp=sp, b=name_of(self.b), v=self.v)
        if self.ekind == "S":
            return f"MATCH START: {MODES.get(self.s, 'Duel')}"
        if self.ekind == "O":
            return f"MATCH OVER: {winner_name(self.a, name_of)} wins"
        if self.ekind == "D":
            return f"DECREE #{self.v} for {int(self.b) if self.b.isdigit() else 0}s"
        if self.ekind == "B":
            return f"THE PHANTOM IS ENRAGED ({self.v}%)"
        return f"event {self.ekind}"


@dataclass
class Loot:
    id: str
    item: str
    qty: int
    kind: str = "L"


Frame = Heartbeat | Cast | Snapshot | Event | Loot


def winner_name(a: str, name_of) -> str:
    if a == "MAGE":
        return "The mages"
    if a == "BOSS":
        return "The Phantom"
    if a == "NONE":
        return "Nobody"
    if a.startswith("TM"):
        return "Team " + TEAMS.get(a[2:3], "?")
    return name_of(a)


def _hex(s: str) -> int | None:
    try:
        return int(s, 16)
    except ValueError:
        return None


def parse_frame(payload: str) -> Frame | None:
    """Decode one radio payload. Returns None for anything malformed."""
    if not isinstance(payload, str) or len(payload) < 3 or len(payload.encode("utf-8")) > 44 or not payload.startswith("PA"):
        return None
    k, body = payload[2], payload[3:]
    if k == "H":
        if len(body) < 8 or not _ID.match(body[:4]):
            return None
        return Heartbeat(id=body[:4], team=body[4], role=body[5], mode=body[6], is_host=body[7] == "1", name=body[8:18])
    if k == "C":
        if len(body) < 10:
            return None
        seq, caster, spell, charge, rssi = _hex(body[:2]), body[2:6], body[6], body[7], _hex(body[8:10])
        if seq is None or rssi is None or not _ID.match(caster) or not charge.isdigit():
            return None
        rest = body[10:]
        targets = [rest[i:i + 4] for i in range(0, len(rest) - 3, 4)]
        return Cast(seq=seq, caster=caster, spell=spell, charge=int(charge), rssi=-rssi, targets=targets)
    if k == "S":
        if len(body) < 5 or body[0] not in PHASES or not body[2].isdigit():
            return None
        dec = _hex(body[3:5])
        if dec is None:
            return None
        players = []
        rest = body[5:]
        for i in range(0, len(rest) - 6, 7):
            pid, hp, st = rest[i:i + 4], _hex(rest[i + 4:i + 6]), _hex(rest[i + 6])
            if not _ID.match(pid) or hp is None or st is None:
                return None
            players.append((pid, hp, st))
        return Snapshot(phase=body[0], mode=body[1], page=int(body[2]), decree=dec, players=players)
    if k == "E":
        if len(body) < 14:
            return None
        seq, v = _hex(body[1:3]), _hex(body[11:13])
        if seq is None or v is None:
            return None
        return Event(ekind=body[0], seq=seq, a=body[3:7], b=body[7:11], v=v, s=body[13] if len(body) > 13 else "-")
    if k == "L":
        if len(body) < 6 or not _ID.match(body[:4]) or not body[5].isdigit():
            return None
        return Loot(id=body[:4], item=body[4], qty=int(body[5]))
    return None


def parse_base_line(line: str) -> tuple[str, int, str] | None:
    """Find a PARX|mac|rssi|payload record anywhere in a serial line."""
    m = _BASE_RE.search(line.strip())
    if not m:
        return None
    return m.group(1).upper(), int(m.group(2)), m.group(3).rstrip("\r\n")


def id_of_mac(mac: str) -> str:
    return mac.replace(":", "").upper()[-4:]
