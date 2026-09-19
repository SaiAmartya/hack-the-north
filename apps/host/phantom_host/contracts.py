"""Shared contracts for the Phantom Arena host.

These models are the single source of truth for the host/web boundary. The
TypeScript mirror lives in apps/web/src/types.ts and must be changed alongside
this file.

Everything that crosses the websocket serializes with camelCase aliases so the
client stays idiomatic TypeScript, while Python code keeps snake_case. Dump with
``model_dump(by_alias=True)``; ``populate_by_name=True`` means snake_case input
still parses, which matters for the OpenAI Director's JSON.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer
from pydantic.alias_generators import to_camel

PlayerId = Literal["P1", "P2"]
Sender = Literal["P1", "P2", "J"]
Kind = Literal["CAST", "EVT", "READY"]
Phase = Literal["lobby", "countdown", "playing", "finished"]
Modifier = Literal["none", "meteor", "mana_rain", "double_damage"]
DirectiveModifier = Literal["meteor", "mana_rain", "double_damage"]
Spell = Literal["F", "S", "A", "U"]

SPELLS: tuple[str, ...] = ("F", "S", "A", "U")


class WireModel(BaseModel):
    """Base for anything that crosses the host/web boundary."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RadioEvent(WireModel):
    """One packet that arrived from a badge via the gateway."""

    sender: Sender
    kind: Kind
    value: str = Field(max_length=16)
    sequence: int = Field(ge=0, le=255)
    received_at_ms: int
    # The gateway logs the sender's BLE address ahead of the payload. Optional so
    # payload-only lines still parse.
    mac: str | None = None


class PlayerState(WireModel):
    id: PlayerId
    health: int = Field(ge=0, le=100)
    # Stored as a float so fractional regeneration accumulates, serialized as an
    # int for display. 8 mana/second on a 10 Hz tick is 0.8, which would floor to
    # zero every tick and never regenerate at all if this were an int.
    mana: float = Field(ge=0, le=100)
    cooldown_until_ms: dict[str, int] = Field(default_factory=dict)
    shield_until_ms: int = 0
    ready: bool = False
    last_spell: str | None = None

    @field_serializer("mana")
    def _serialize_mana(self, mana: float) -> int:
        return int(mana)


class Effect(WireModel):
    """A JSON-friendly thing that just happened, for the client to animate."""

    type: Literal[
        "cast",
        "damage",
        "shield_absorb",
        "modifier",
        "reject",
        "phase",
        "win",
        "ready",
    ]
    player: PlayerId | None = None
    spell: str | None = None
    amount: int | None = None
    note: str | None = None


class ArenaState(WireModel):
    phase: Phase
    players: dict[str, PlayerState]
    modifier: Modifier = "none"
    modifier_until_ms: int = 0
    countdown_ends_ms: int = 0
    started_at_ms: int = 0
    # Host clock at the last tick, so regeneration can integrate real elapsed time
    # instead of assuming a fixed frame rate.
    last_tick_ms: int = 0
    winner: PlayerId | None = None


class MarkerPose(WireModel):
    player_id: PlayerId
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    visible: bool


class ArenaDirective(WireModel):
    """The only shape the OpenAI Director may influence the match with."""

    modifier: DirectiveModifier
    duration_ms: int = Field(ge=3000, le=8000)
    commentary: str = Field(max_length=120)


class ArenaEnvelope(WireModel):
    """One websocket message. Mirrors ArenaEnvelope in apps/web/src/types.ts."""

    type: Literal["state"] = "state"
    state: ArenaState
    markers: dict[str, MarkerPose]
    effects: list[Effect] = Field(default_factory=list)
    director_commentary: str | None = None
    frame_jpeg_base64: str | None = None
    gateway_connected: bool = False
    server_now_ms: int = 0
