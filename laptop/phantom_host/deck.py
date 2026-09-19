"""Encounter deck: OpenAI writes the cards, the badge runs the director.

A deck is a small text file (deck.txt) the host badge draws from by game state.
Each line:  trigger|type|value|seconds|title|text
  trigger  low (someone under 25% HP) | stale (no damage for 20 s) | timer (every 45 s) | boss (Phantom under 50%)
  type     dmg (damage x value/10) | cd (cooldowns x value/10) | heal (everyone +value %) | fog (everyone hidden)
The badge accepts only these enums, so the model cannot invent mechanics; it only
picks numbers within bounds and writes the flavour. Run:

    phantom-deck --out ../badge/phantom_arena/deck.txt --theme "haunted library"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

TRIGGERS = ("low", "stale", "timer", "boss")
TYPES = ("dmg", "cd", "heal", "fog")
BOUNDS = {"dmg": (11, 30), "cd": (3, 9), "heal": (10, 50), "fog": (0, 0)}
DUR_BOUNDS = {"dmg": (8, 30), "cd": (8, 30), "heal": (0, 0), "fog": (8, 20)}
MAX_TITLE, MAX_TEXT, MAX_CARDS = 24, 44, 40
_ASCII = re.compile(r"[^ -~]")


@dataclass
class Card:
    trig: str
    type: str
    val: int
    dur: int
    title: str
    text: str

    def line(self) -> str:
        return f"{self.trig}|{self.type}|{self.val}|{self.dur}|{self.title}|{self.text}"


class CardError(ValueError):
    pass


def clean_text(s: str, limit: int) -> str:
    s = _ASCII.sub("", str(s)).replace("|", "-").strip()
    return s[:limit].strip()


def validate(raw: dict) -> Card:
    trig = str(raw.get("trig", raw.get("trigger", ""))).strip().lower()
    typ = str(raw.get("type", "")).strip().lower()
    if trig not in TRIGGERS:
        raise CardError(f"bad trigger {trig!r}")
    if typ not in TYPES:
        raise CardError(f"bad type {typ!r}")
    try:
        val, dur = int(raw.get("val", raw.get("value", 0))), int(raw.get("dur", raw.get("seconds", 0)))
    except (TypeError, ValueError) as e:
        raise CardError(f"bad number: {e}")
    lo, hi = BOUNDS[typ]
    val = min(hi, max(lo, val))
    dlo, dhi = DUR_BOUNDS[typ]
    dur = min(dhi, max(dlo, dur))
    title, text = clean_text(raw.get("title", ""), MAX_TITLE), clean_text(raw.get("text", ""), MAX_TEXT)
    if not title or not text:
        raise CardError("title and text are required")
    return Card(trig, typ, val, dur, title, text)


def default_deck() -> list[Card]:
    return [validate(c) for c in [
        dict(trig="low", type="heal", val=30, dur=0, title="Mercy of the Veil", text="The Phantom pities the weak: all heal 30%."),
        dict(trig="low", type="dmg", val=20, dur=15, title="Blood Frenzy", text="Wounds sing. Damage doubled for 15 s."),
        dict(trig="stale", type="fog", val=0, dur=12, title="Whispering Fog", text="Fog swallows the arena. Get close to see."),
        dict(trig="stale", type="cd", val=5, dur=15, title="Quickening", text="Time bends. Cooldowns halved for 15 s."),
        dict(trig="timer", type="dmg", val=15, dur=12, title="Sharpened Runes", text="Every spell bites harder: x1.5 for 12 s."),
        dict(trig="timer", type="heal", val=20, dur=0, title="Second Wind", text="A cool wind. Everyone recovers 20%."),
        dict(trig="boss", type="dmg", val=20, dur=20, title="Phantom Rage", text="The Phantom is enraged. Damage doubled."),
    ]]


def serialize(cards: list[Card]) -> str:
    return "".join(c.line() + "\n" for c in cards[:MAX_CARDS])


def parse(text: str) -> list[Card]:
    cards = []
    for line in text.splitlines():
        m = re.match(r"^([a-z]+)\|([a-z]+)\|(\d+)\|(\d+)\|([^|]*)\|([^|]*)$", line.strip())
        if m:
            cards.append(validate(dict(trig=m[1], type=m[2], val=m[3], dur=m[4], title=m[5], text=m[6])))
    return cards


SYSTEM_PROMPT = """You are the Game Master of Phantom Arena, a spell-duel game played on hackathon badges.
Write an encounter deck of rule mutations ("decrees"). Return ONLY JSON: {"cards": [...]}.
Each card: {"trig": one of low|stale|timer|boss, "type": one of dmg|cd|heal|fog,
"val": integer, "dur": integer seconds, "title": <= 24 ASCII chars, "text": <= 44 ASCII chars, no '|' characters}.
Meaning: trig low = a mage is under 25% HP; stale = nobody dealt damage for 20 s; timer = every 45 s; boss = the Phantom boss is under half HP.
type dmg = all damage multiplied by val/10 (val 11-30); cd = cooldowns multiplied by val/10 (val 3-9, lower is faster);
heal = everyone heals val percent (val 10-50, dur 0); fog = everyone is hidden unless within arm's reach (val 0, dur 8-20).
Durations 8-30 seconds for dmg/cd. Flavour should fit the theme, be punchy and readable on a 320x240 badge screen."""


def generate(theme: str = "haunted arena", n: int = 16, client=None, model: str | None = None) -> list[Card]:
    """Ask OpenAI for a deck; falls back to the built-in deck when no client/key is available."""
    if client is None:
        try:
            from openai import OpenAI
            if not os.environ.get("OPENAI_API_KEY"):
                raise RuntimeError("OPENAI_API_KEY not set")
            client = OpenAI()
        except Exception as e:  # no SDK, no key, no network: deterministic fallback
            print(f"[deck] using built-in deck ({e})", file=sys.stderr)
            return default_deck()
    model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        temperature=0.9,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Theme: {theme}. Write {n} cards, at least 3 for each trigger."},
        ],
    )
    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        print("[deck] model returned invalid JSON, using built-in deck", file=sys.stderr)
        return default_deck()
    cards: list[Card] = []
    for raw in data.get("cards", []) if isinstance(data, dict) else []:
        try:
            cards.append(validate(raw))
        except CardError as e:
            print(f"[deck] dropped card: {e}", file=sys.stderr)
    for trig in TRIGGERS:  # make sure every trigger has at least one card
        if not any(c.trig == trig for c in cards):
            cards += [c for c in default_deck() if c.trig == trig]
    return cards[:MAX_CARDS]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate deck.txt for the badge host")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "badge" / "phantom_arena" / "deck.txt"))
    ap.add_argument("--theme", default="haunted arena at a hackathon")
    ap.add_argument("--n", type=int, default=16)
    ap.add_argument("--offline", action="store_true", help="write the built-in deck without calling OpenAI")
    ap.add_argument("--json", action="store_true", help="also print the cards as JSON")
    a = ap.parse_args(argv)
    cards = default_deck() if a.offline else generate(a.theme, a.n)
    text = serialize(cards)
    Path(a.out).write_text(text, encoding="ascii", newline="\n")
    print(f"wrote {len(cards)} cards ({len(text)} bytes) to {a.out}")
    if a.json:
        print(json.dumps([asdict(c) for c in cards], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
