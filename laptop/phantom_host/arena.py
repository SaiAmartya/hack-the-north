"""Laptop-side model of the arena, built purely from what the base station overhears.

The badges are authoritative; this model only mirrors host snapshots, resolves
names from heartbeats and turns events into log lines, animations and stats for
the spectator view and the AI commentator.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field, asdict

from .protocol import (Cast, Event, Heartbeat, Loot, Snapshot, SPELLS, TEAMS, MODES, PHASES, ST_DEAD, ST_HIDDEN, ST_WARD,
                       id_of_mac, parse_frame, winner_name)


@dataclass
class Player:
    id: str
    name: str = "????"
    team: str = "0"
    role: str = "M"
    hp: int = 100
    st: int = 0
    mac: str = ""
    rssi: int = -99
    is_host: bool = False
    last_seen: float = 0.0
    kills: int = 0
    deaths: int = 0
    casts: int = 0
    loot: int = 0

    def public(self) -> dict:
        d = asdict(self)
        d["team_name"] = TEAMS.get(self.team, "?")
        d["boss"] = self.role == "B"
        d["dead"] = bool(self.st & ST_DEAD)
        d["hidden"] = bool(self.st & ST_HIDDEN)
        d["warded"] = bool(self.st & ST_WARD)
        return d


@dataclass
class Arena:
    players: dict[str, Player] = field(default_factory=dict)
    phase: str = "L"
    mode: str = "D"
    decree: int = 0
    decree_until: float = 0.0
    host_id: str = ""
    events: deque = field(default_factory=lambda: deque(maxlen=60))
    badges_seen: set = field(default_factory=set)
    matches: int = 0
    loot_total: int = 0
    casts_total: int = 0
    frames_total: int = 0
    deck: list = field(default_factory=list)
    _recent: dict = field(default_factory=dict)  # payload -> time, dedupe for resent frames
    peer_timeout: float = 15.0

    # ---------- names ----------
    def name_of(self, pid: str) -> str:
        p = self.players.get(pid)
        return p.name if p else "????"

    def player(self, pid: str) -> Player:
        p = self.players.get(pid)
        if p is None:
            p = Player(id=pid)
            self.players[pid] = p
        return p

    # ---------- ingest ----------
    def ingest_line(self, line: str, now: float | None = None) -> list[dict]:
        from .protocol import parse_base_line
        rec = parse_base_line(line)
        if not rec:
            return []
        mac, rssi, payload = rec
        return self.ingest(mac, rssi, payload, now)

    def ingest(self, mac: str, rssi: int, payload: str, now: float | None = None) -> list[dict]:
        """Feed one frame; returns UI events (dicts) produced by it."""
        now = time.time() if now is None else now
        frame = parse_frame(payload)
        if frame is None:
            return []
        self.frames_total += 1
        self.badges_seen.add(mac.upper())
        sender = self.player(id_of_mac(mac))
        sender.mac, sender.rssi, sender.last_seen = mac.upper(), rssi, now
        out: list[dict] = []
        if isinstance(frame, Heartbeat):
            p = self.player(frame.id)
            if not p.name or p.name == "????":
                out.append(self._event(now, "join", f"{frame.name.strip() or frame.id} joined the arena", a=frame.id))
            p.name, p.team, p.role, p.is_host = frame.name.strip() or p.name, frame.team, frame.role, frame.is_host
            p.last_seen = now
            if frame.is_host:
                self.host_id = frame.id
        elif isinstance(frame, Snapshot):
            if self.phase != frame.phase or self.mode != frame.mode:
                self.phase, self.mode = frame.phase, frame.mode
                out.append(self._event(now, "phase", f"{PHASES[frame.phase]} ({MODES.get(frame.mode, '?')})"))
            if frame.decree == 0 and self.decree:
                self.decree = 0
            elif frame.decree and frame.decree != self.decree:
                self.decree, self.decree_until = frame.decree, now + 60
            self.host_id = sender.id
            sender.is_host = True
            for pid, hp, st in frame.players:
                p = self.player(pid)
                p.hp, p.st, p.last_seen = hp, st, max(p.last_seen, now - 5)
        elif isinstance(frame, Cast):
            if self._dup(payload, now):
                return out
            p = self.player(frame.caster)
            if frame.spell in "!~?":
                out.append(self._event(now, "control", f"{p.name} requests {SPELLS[frame.spell]['name'].lower()}", a=frame.caster, spell=frame.spell))
            else:
                p.casts += 1
                self.casts_total += 1
                sp = SPELLS.get(frame.spell, {"name": frame.spell, "color": "#ffffff", "kind": "?"})
                out.append(self._event(now, "cast", f"{p.name} casts {sp['name']} (charge {frame.charge})", a=frame.caster,
                                       targets=frame.targets, spell=frame.spell, color=sp["color"], charge=frame.charge, rssi=frame.rssi))
        elif isinstance(frame, Event):
            if self._dup(payload, now):
                return out
            text = frame.text(self.name_of)
            ev = self._event(now, "log", text, a=frame.a, b=frame.b, ekind=frame.ekind, spell=frame.s, v=frame.v)
            if frame.ekind == "K":
                self.player(frame.a).kills += 1
                self.player(frame.b).deaths += 1
                ev["kind"] = "kill"
            elif frame.ekind == "H":
                ev["kind"] = "hit"
                ev["color"] = SPELLS.get(frame.s, {}).get("color", "#ffffff")
            elif frame.ekind == "S":
                self.phase, self.mode = "F", frame.s
                ev["kind"] = "start"
            elif frame.ekind == "O":
                self.phase = "O"
                self.matches += 1
                ev["kind"] = "over"
                ev["winner"] = winner_name(frame.a, self.name_of)
            elif frame.ekind == "D":
                dur = int(frame.b) if frame.b.isdigit() else 0
                self.decree, self.decree_until = frame.v, now + dur
                card = self.deck[frame.v - 1] if 0 < frame.v <= len(self.deck) else None
                ev["kind"] = "decree"
                ev["card"] = card
                if card:
                    ev["text"] = f"DECREE: {card['title']} - {card['text']}"
            elif frame.ekind == "B":
                ev["kind"] = "boss"
            out.append(ev)
        elif isinstance(frame, Loot):
            if self._dup(payload, now):
                return out
            p = self.player(frame.id)
            p.loot += frame.qty
            self.loot_total += frame.qty
            item = SPELLS.get(frame.item, {"name": frame.item})["name"]
            out.append(self._event(now, "loot", f"{p.name} found {item} x{frame.qty}", a=frame.id, item=item, qty=frame.qty))
        for ev in out:
            self.events.append(ev)
        return out

    def _dup(self, payload: str, now: float) -> bool:
        for k in [k for k, t in self._recent.items() if now - t > 2.5]:
            del self._recent[k]
        if payload in self._recent:
            return True
        self._recent[payload] = now
        return False

    def _event(self, now: float, kind: str, text: str, **extra) -> dict:
        d = {"t": now, "kind": kind, "text": text}
        d.update(extra)
        return d

    # ---------- housekeeping ----------
    def prune(self, now: float | None = None) -> list[dict]:
        now = time.time() if now is None else now
        gone = [pid for pid, p in self.players.items() if now - p.last_seen > self.peer_timeout]
        out = []
        for pid in gone:
            p = self.players.pop(pid)
            out.append(self._event(now, "leave", f"{p.name} left the arena", a=pid))
        for ev in out:
            self.events.append(ev)
        return out

    # ---------- views ----------
    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        card = self.deck[self.decree - 1] if 0 < self.decree <= len(self.deck) else None
        return {
            "phase": self.phase, "phase_name": PHASES.get(self.phase, "?"), "mode": self.mode, "mode_name": MODES.get(self.mode, "?"),
            "host": self.host_id, "host_name": self.name_of(self.host_id) if self.host_id else "",
            "decree": self.decree if self.decree_until > now else 0, "decree_card": card if self.decree_until > now else None,
            "players": [p.public() for p in sorted(self.players.values(), key=lambda p: p.id)],
            "stats": {"badges": len(self.badges_seen), "matches": self.matches, "loot": self.loot_total,
                      "casts": self.casts_total, "frames": self.frames_total},
            "events": list(self.events)[-12:],
        }

    def summary_for_ai(self) -> dict:
        """Compact, non-identifying state for the commentator."""
        return {
            "phase": PHASES.get(self.phase, "?"), "mode": MODES.get(self.mode, "?"),
            "players": [{"name": p.name, "hp": p.hp, "team": TEAMS.get(p.team, "?"), "boss": p.role == "B",
                         "dead": bool(p.st & ST_DEAD), "hidden": bool(p.st & ST_HIDDEN), "warded": bool(p.st & ST_WARD)}
                        for p in self.players.values()],
            "recent": [e["text"] for e in list(self.events)[-10:]],
        }
