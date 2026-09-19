"""Arena Director tests.

No API key and no network. Every OpenAI response shape the Director can receive
is faked, and the rule under test is always the same: the match stays playable.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from phantom_host.arena_director import (
    FALLBACK_COMMENTARY,
    FALLBACK_DURATION_MS,
    FALLBACK_MODIFIER,
    ArenaDirector,
)
from phantom_host.config import Settings
from phantom_host.contracts import MarkerPose
from phantom_host.game import COUNTDOWN_MS, apply_directive, apply_event, new_match, tick
from phantom_host.contracts import RadioEvent

T0 = 50_000


class FakeCompletions:
    """Mimics client.chat.completions.create from the OpenAI SDK."""

    def __init__(self, outcome: str | Exception) -> None:
        self._outcome = outcome
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self._outcome))]
        )


class FakeClient:
    def __init__(self, outcome: str | Exception) -> None:
        self.completions = FakeCompletions(outcome)
        self.chat = SimpleNamespace(completions=self.completions)


def settings(**overrides: Any) -> Settings:
    base = {
        "serial_enabled": False,
        "camera_enabled": False,
        "director_enabled": True,
        "openai_api_key": "test-key-not-used",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def playing_state(at: int = T0):
    state = new_match(at)
    for sender in ("P1", "P2"):
        apply_event(
            state,
            RadioEvent(
                sender=sender,  # type: ignore[arg-type]
                kind="READY",
                value="1",
                sequence=0,
                received_at_ms=at,
            ),
            at,
        )
    tick(state, at + COUNTDOWN_MS)
    assert state.phase == "playing"
    return state


def markers() -> dict[str, MarkerPose]:
    return {
        "P1": MarkerPose(player_id="P1", x=0.3, y=0.5, visible=True),
        "P2": MarkerPose(player_id="P2", x=0.7, y=0.5, visible=False),
    }


def director_with(outcome: str | Exception, **overrides: Any) -> tuple[ArenaDirector, FakeClient]:
    client = FakeClient(outcome)
    return ArenaDirector(settings(**overrides), client=client), client


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------


def test_valid_meteor_json_is_accepted() -> None:
    payload = json.dumps(
        {"modifier": "meteor", "duration_ms": 6000, "commentary": "Rocks incoming"}
    )
    director, _client = director_with(payload)

    directive = director.request_directive(playing_state(), markers())

    assert directive.modifier == "meteor"
    assert directive.duration_ms == 6000
    assert directive.commentary == "Rocks incoming"
    assert director.fallbacks_used == 0


def test_the_request_asks_for_json_and_applies_a_timeout() -> None:
    payload = json.dumps(
        {"modifier": "mana_rain", "duration_ms": 4000, "commentary": "Refill"}
    )
    director, client = director_with(payload)

    director.request_directive(playing_state(), markers())

    call = client.completions.calls[0]
    assert call["response_format"] == {"type": "json_object"}
    assert call["timeout"] == 5.0
    assert call["model"] == "gpt-4o-mini"


def test_the_prompt_carries_game_state_and_nothing_identifying() -> None:
    payload = json.dumps(
        {"modifier": "meteor", "duration_ms": 5000, "commentary": "ok"}
    )
    director, client = director_with(payload)
    state = playing_state()
    state.players["P1"].health = 64
    state.players["P2"].last_spell = "S"

    director.request_directive(state, markers())

    prompt = json.dumps(client.completions.calls[0]["messages"])
    assert "64" in prompt, "health should reach the model"
    assert '"S"' in prompt or "S" in prompt

    # Nothing that could identify a person or a device.
    for leak in ["AA:BB", "mac", "badge_id", "likayla", "/dev/"]:
        assert leak not in prompt


# ---------------------------------------------------------------------------
# every failure mode falls back deterministically
# ---------------------------------------------------------------------------


def assert_is_fallback(directive: Any) -> None:
    assert directive.modifier == FALLBACK_MODIFIER
    assert directive.duration_ms == FALLBACK_DURATION_MS
    assert directive.commentary == FALLBACK_COMMENTARY


def test_an_unsupported_modifier_falls_back() -> None:
    payload = json.dumps(
        {"modifier": "black_hole", "duration_ms": 5000, "commentary": "nope"}
    )
    director, _client = director_with(payload)

    assert_is_fallback(director.request_directive(playing_state(), markers()))
    assert director.fallbacks_used == 1


def test_malformed_json_falls_back() -> None:
    director, _client = director_with("{not json at all")

    assert_is_fallback(director.request_directive(playing_state(), markers()))
    assert director.fallbacks_used == 1


def test_a_timeout_falls_back() -> None:
    director, _client = director_with(TimeoutError("deadline exceeded"))

    assert_is_fallback(director.request_directive(playing_state(), markers()))
    assert director.fallbacks_used == 1


def test_any_api_error_falls_back() -> None:
    director, _client = director_with(RuntimeError("503 upstream unavailable"))

    assert_is_fallback(director.request_directive(playing_state(), markers()))


def test_a_duration_outside_the_band_falls_back() -> None:
    payload = json.dumps(
        {"modifier": "meteor", "duration_ms": 60000, "commentary": "forever"}
    )
    director, _client = director_with(payload)

    assert_is_fallback(director.request_directive(playing_state(), markers()))


def test_over_long_commentary_falls_back() -> None:
    payload = json.dumps(
        {"modifier": "meteor", "duration_ms": 5000, "commentary": "x" * 400}
    )
    director, _client = director_with(payload)

    assert_is_fallback(director.request_directive(playing_state(), markers()))


def test_an_empty_response_falls_back() -> None:
    director, _client = director_with("")

    assert_is_fallback(director.request_directive(playing_state(), markers()))


def test_with_no_client_configured_it_never_calls_out() -> None:
    """No API key must behave exactly like a timeout, so the offline demo is the
    same code path the audience would see if the network died."""
    director = ArenaDirector(settings(openai_api_key=None), client=None)

    assert_is_fallback(director.request_directive(playing_state(), markers()))


def test_json_wrapped_in_a_markdown_fence_is_still_read() -> None:
    """Models do this even when told not to."""
    payload = "```json\n" + json.dumps(
        {"modifier": "double_damage", "duration_ms": 4000, "commentary": "Gloves off"}
    ) + "\n```"
    director, _client = director_with(payload)

    directive = director.request_directive(playing_state(), markers())
    assert directive.modifier == "double_damage"


# ---------------------------------------------------------------------------
# cadence
# ---------------------------------------------------------------------------


def test_no_directive_is_requested_outside_the_playing_phase() -> None:
    director, _client = director_with("{}")
    lobby = new_match(T0)

    assert director.should_request(lobby, T0 + 60_000) is False


def test_the_first_request_comes_early_enough_to_land_in_a_short_duel() -> None:
    """A duel can end in about 15 s, so a 20 s first request would never fire."""
    director, _client = director_with("{}")
    state = playing_state()
    started = state.started_at_ms

    assert director.should_request(state, started + 1000) is False
    assert director.should_request(state, started + 5999) is False
    assert director.should_request(state, started + 6000) is True


def test_subsequent_requests_are_spaced_by_the_interval() -> None:
    director, _client = director_with("{}")
    state = playing_state()
    started = state.started_at_ms

    assert director.should_request(state, started + 6000) is True
    director.schedule_next(started + 6000)

    assert director.should_request(state, started + 6001) is False
    assert director.should_request(state, started + 25_999) is False
    assert director.should_request(state, started + 26_000) is True


def test_a_disabled_director_never_requests() -> None:
    director, _client = director_with("{}", director_enabled=False)
    state = playing_state()

    assert director.should_request(state, state.started_at_ms + 60_000) is False


def test_reset_puts_the_schedule_back_for_the_next_match() -> None:
    director, _client = director_with("{}")
    state = playing_state()
    director.schedule_next(state.started_at_ms + 6000)
    assert director.should_request(state, state.started_at_ms + 7000) is False

    director.reset()
    assert director.should_request(state, state.started_at_ms + 7000) is True


# ---------------------------------------------------------------------------
# the engine remains authoritative
# ---------------------------------------------------------------------------


def test_the_fallback_is_a_directive_the_engine_actually_accepts() -> None:
    """The fallback must be demonstrable with networking off, which means it has
    to survive the engine's own validation."""
    director = ArenaDirector(settings(openai_api_key=None), client=None)
    state = playing_state()
    directive = director.request_directive(state, markers())

    effects = apply_directive(state, directive, state.started_at_ms + 6000)

    assert effects, "fallback directive must actually apply"
    assert state.modifier == FALLBACK_MODIFIER


def test_a_directive_cannot_end_the_match_by_itself() -> None:
    """The Director is flavour. Only the deterministic rules decide a winner."""
    payload = json.dumps(
        {"modifier": "meteor", "duration_ms": 8000, "commentary": "Extinction"}
    )
    director, _client = director_with(payload)
    state = playing_state()
    state.players["P1"].health = 2
    state.players["P2"].health = 2

    directive = director.request_directive(state, markers())
    apply_directive(state, directive, state.started_at_ms + 6000)

    assert state.phase == "playing"
    assert state.winner is None


@pytest.mark.parametrize("modifier", ["meteor", "mana_rain", "double_damage"])
def test_all_three_allowed_modifiers_round_trip(modifier: str) -> None:
    payload = json.dumps(
        {"modifier": modifier, "duration_ms": 5000, "commentary": "go"}
    )
    director, _client = director_with(payload)

    directive = director.request_directive(playing_state(), markers())
    assert directive.modifier == modifier
