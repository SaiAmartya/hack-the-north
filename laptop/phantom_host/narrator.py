"""Live commentator: OpenAI reacts to the real event log; ElevenLabs gives it a voice.

Without an OPENAI_API_KEY the narrator still talks, using templated lines, so the
arena view never goes silent on stage. Without an ELEVENLABS_API_KEY the browser's
speech synthesis reads the lines instead.
"""
from __future__ import annotations

import os
import random
import sys
import time

import httpx

SYSTEM_PROMPT = """You are the hype commentator of Phantom Arena, a live spell duel played on hackathon badges.
Players cast spells by drawing them in the air. You receive the current state and the latest events.
Reply with ONE or TWO short spoken sentences (max 45 words total) reacting to the newest events.
Be vivid, funny and specific: use the players' names and spell names. Never invent events that are not in the log.
No emojis, no hashtags, no stage directions."""

FALLBACK = {
    "hit": ["{a} lands {sp} on {b} for {v}!", "Ouch! {b} eats a {sp} from {a}.", "{a} connects with {sp}, {b} is reeling!"],
    "kill": ["{a} takes down {b}! What a finish!", "{b} is out! {a} stands tall.", "Lights out for {b}, courtesy of {a}!"],
    "cast": ["{a} winds up {sp}!", "Here comes {sp} from {a}!"],
    "decree": ["The Game Master speaks: {text}", "A decree descends on the arena: {text}"],
    "start": ["The match is on! Wands up!", "Fight! Draw your spells!"],
    "over": ["It is over! {winner} wins the arena!", "{winner} takes it! Bow to the champion!"],
    "loot": ["{text}! The shrines are generous today.", "{text}, a relic changes hands."],
    "join": ["{text}. The arena grows.", "Welcome, {text}."],
    "boss": ["The Phantom is enraged! Run!", "Half health and furious: the Phantom awakens!"],
    "log": ["{text}", "{text}"],
}


class Narrator:
    def __init__(self, client=None, model: str | None = None, min_interval: float = 7.0, enabled: bool = True,
                 allow_network: bool = True):
        self.client = client
        self.model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
        self.min_interval = min_interval
        self.last_at = 0.0
        self.enabled = enabled
        self.rng = random.Random(42)
        if enabled and allow_network and client is None and os.environ.get("OPENAI_API_KEY"):
            try:
                from openai import OpenAI
                self.client = OpenAI()
            except Exception as e:  # pragma: no cover
                print(f"[narrator] OpenAI unavailable, using templates ({e})", file=sys.stderr)

    def ready(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return self.enabled and now - self.last_at >= self.min_interval

    def commentate(self, events: list[dict], state: dict, now: float | None = None) -> str | None:
        """Return a line of commentary for the given new events (or None if nothing to say)."""
        now = time.time() if now is None else now
        interesting = [e for e in events if e.get("kind") in FALLBACK]
        if not interesting:
            return None
        self.last_at = now
        if self.client is not None:
            try:
                return self._ask_model(interesting, state)
            except Exception as e:
                print(f"[narrator] model call failed, using template ({e})", file=sys.stderr)
        return self.template(interesting[-1])

    def template(self, ev: dict) -> str:
        kind = ev.get("kind", "log")
        opts = FALLBACK.get(kind, FALLBACK["log"])
        text = ev.get("text", "")
        parts = text.split(" ")
        fields = {"text": text, "a": parts[0] if parts else "", "sp": parts[1] if len(parts) > 1 else "",
                  "b": parts[2] if len(parts) > 2 else "", "v": ev.get("v", ""), "winner": ev.get("winner", "someone")}
        try:
            return self.rng.choice(opts).format(**fields)
        except (KeyError, IndexError):
            return text

    def _ask_model(self, events: list[dict], state: dict) -> str:
        lines = "\n".join(e["text"] for e in events[-8:])
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=1.0,
            max_tokens=90,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"State: {state}\nNewest events (oldest first):\n{lines}"},
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        return text or self.template(events[-1])


class ElevenLabsVoice:
    """Text to speech via the ElevenLabs REST API. Returns MP3 bytes or None."""

    def __init__(self, api_key: str | None = None, voice_id: str | None = None, model_id: str | None = None):
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY")
        self.voice_id = voice_id or os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
        self.model_id = model_id or os.environ.get("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def speak(self, text: str, timeout: float = 15.0) -> bytes | None:
        if not self.available or not text:
            return None
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}"
        try:
            r = httpx.post(url, timeout=timeout, headers={"xi-api-key": self.api_key, "accept": "audio/mpeg"},
                           json={"text": text, "model_id": self.model_id,
                                 "voice_settings": {"stability": 0.35, "similarity_boost": 0.8, "style": 0.6}})
            r.raise_for_status()
            return r.content
        except Exception as e:
            print(f"[tts] ElevenLabs failed: {e}", file=sys.stderr)
            return None
