"""The OpenAI Arena Director.

The Director adds twists and commentary. It is explicitly NOT a referee:

* It may only propose one of three modifiers, as a closed enum with a bounded
  duration. Anything else is discarded.
* Every proposal still goes through ``game.apply_directive``, which re-validates
  it before it can touch the match.
* A timeout, a malformed response, an unsupported modifier, or a missing API key
  all take the same deterministic fallback path. The offline demo therefore
  exercises exactly the code the audience would see if the network died.

It is given compact, non-identifying game state: health, mana, last spells, the
active modifier, and elapsed round time. No MAC addresses, badge IDs, names, or
device paths.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import ValidationError

from phantom_host.config import Settings
from phantom_host.contracts import ArenaDirective, ArenaState, MarkerPose

logger = logging.getLogger(__name__)

FALLBACK_MODIFIER = "mana_rain"
FALLBACK_DURATION_MS = 3000
FALLBACK_COMMENTARY = "Mana surges through the arena."

SYSTEM_PROMPT = (
    "You are the Arena Director for a 1v1 spell duel. "
    "Pick one arena modifier that makes the current moment more interesting. "
    "Reply with JSON only, no prose and no code fences, using exactly these keys: "
    '{"modifier": "meteor" | "mana_rain" | "double_damage", '
    '"duration_ms": integer between 3000 and 8000, '
    '"commentary": string of at most 120 characters}. '
    "meteor damages both players, mana_rain refills both, "
    "double_damage doubles all spell damage. "
    "Commentary is a single punchy line for a live audience."
)


def fallback_directive() -> ArenaDirective:
    return ArenaDirective(
        modifier=FALLBACK_MODIFIER,
        duration_ms=FALLBACK_DURATION_MS,
        commentary=FALLBACK_COMMENTARY,
    )


def _strip_code_fence(text: str) -> str:
    """Models wrap JSON in ```json fences even when told not to."""
    cleaned = text.strip()
    if not cleaned.startswith("```"):
        return cleaned

    lines = cleaned.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


class ArenaDirector:
    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self.settings = settings
        self._client = client if client is not None else self._build_client(settings)
        self._next_request_ms: int | None = None
        self.requests_made = 0
        self.fallbacks_used = 0

    @staticmethod
    def _build_client(settings: Settings) -> Any | None:
        if not settings.director_enabled or not settings.openai_api_key:
            return None
        try:
            from openai import OpenAI

            return OpenAI(api_key=settings.openai_api_key)
        except Exception as error:  # pragma: no cover - import/credential issues
            logger.warning("OpenAI client unavailable, using fallbacks: %s", error)
            return None

    @property
    def live(self) -> bool:
        """True when a real model will be asked. False means fallbacks only."""
        return self._client is not None and self.settings.director_enabled

    # -- scheduling ----------------------------------------------------------

    def should_request(self, state: ArenaState, now_ms: int) -> bool:
        if not self.settings.director_enabled:
            return False
        if state.phase != "playing":
            return False

        if self._next_request_ms is None:
            # Deliberately early. A mana-limited duel can be over in about 15 s,
            # so waiting a full interval for the first one risks never firing.
            due = state.started_at_ms + self.settings.director_first_request_ms
            return now_ms >= due

        return now_ms >= self._next_request_ms

    def schedule_next(self, now_ms: int) -> None:
        self._next_request_ms = now_ms + self.settings.director_interval_ms

    def reset(self) -> None:
        self._next_request_ms = None

    # -- the request ---------------------------------------------------------

    def observation(
        self, state: ArenaState, markers: dict[str, MarkerPose]
    ) -> dict[str, Any]:
        elapsed_ms = max(0, state.last_tick_ms - state.started_at_ms)
        return {
            "elapsed_seconds": round(elapsed_ms / 1000, 1),
            "active_modifier": state.modifier,
            "players": {
                player_id: {
                    "health": player.health,
                    "mana": int(player.mana),
                    "last_spell": player.last_spell,
                    "on_camera": bool(markers.get(player_id, None) and markers[player_id].visible),
                }
                for player_id, player in state.players.items()
            },
        }

    def request_directive(
        self, state: ArenaState, markers: dict[str, MarkerPose]
    ) -> ArenaDirective:
        """Always returns a usable directive. Never raises."""
        if not self.live:
            self.fallbacks_used += 1
            return fallback_directive()

        try:
            response = self._client.chat.completions.create(  # type: ignore[union-attr]
                model=self.settings.openai_model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": json.dumps(self.observation(state, markers)),
                    },
                ],
                response_format={"type": "json_object"},
                timeout=self.settings.openai_timeout_s,
            )
            self.requests_made += 1
            content = response.choices[0].message.content or ""
        except Exception as error:
            # Timeout, rate limit, transport failure, malformed SDK response.
            logger.warning("Director request failed, using fallback: %s", error)
            self.fallbacks_used += 1
            return fallback_directive()

        try:
            directive = ArenaDirective.model_validate_json(_strip_code_fence(content))
        except (ValidationError, ValueError) as error:
            logger.warning("Director response rejected, using fallback: %s", error)
            self.fallbacks_used += 1
            return fallback_directive()

        return directive
