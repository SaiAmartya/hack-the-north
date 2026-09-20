"""Versioned wire models for the isolated Wand Duel runtime.

This module deliberately has no imports from the legacy Phantom Arena host.
All browser-facing JSON uses camelCase aliases and rejects unknown fields.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
)
from pydantic.alias_generators import to_camel


class Slot(str, Enum):
    P1 = "P1"
    P2 = "P2"


class Source(str, Enum):
    PHONE = "phone"
    BLE = "ble"
    REPLAY = "replay"
    BOT = "bot"


class Mode(str, Enum):
    DUEL = "duel"
    SOLO = "solo"
    TUTORIAL = "tutorial"


class Spell(str, Enum):
    STUPEFY = "stupefy"
    PROTEGO = "protego"
    EXPELLIARMUS = "expelliarmus"
    INCENDIO = "incendio"
    EPISKEY = "episkey"


class Phase(str, Enum):
    LOBBY = "lobby"
    COUNTDOWN = "countdown"
    PLAYING = "playing"
    RESULT = "result"


class Outcome(str, Enum):
    WIN = "win"
    DRAW = "draw"
    ABORTED = "aborted"


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        strict=True,
    )


RoomCode = Annotated[str, Field(min_length=6, max_length=6, pattern=r"^[A-Z0-9]{6}$")]
RoomId = Annotated[str, Field(min_length=4, max_length=8, pattern=r"^[A-Za-z0-9]+$")]


class RoomResponse(WireModel):
    code: RoomCode


class SessionRequest(WireModel):
    name: str = Field(min_length=1, max_length=24)
    source: Source
    code: RoomCode | None = None
    mode: Mode = Mode.DUEL

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.strip().split())
        if not cleaned or any(ord(character) < 32 for character in cleaned):
            raise ValueError("name must contain printable characters")
        return cleaned


class SessionResponse(WireModel):
    token: str
    slot: Slot
    room_id: RoomId = "main"
    mode: Mode = Mode.DUEL


class PairResponse(WireModel):
    code: str
    expires_at_ms: int


class HealthResponse(WireModel):
    version: Literal[1] = 1
    stage: Literal["game"] = "game"
    multiplayer_ready: Literal[True] = True
    dev_relay_enabled: bool
    allow_replay: bool
    phone_broker: bool = False


class SpellRuleWire(WireModel):
    spell: Spell
    enabled: bool
    damage: int = Field(ge=0, le=100)
    heal: int = Field(ge=0, le=100)
    cooldown_ms: int = Field(ge=0)
    flight_ms: int = Field(ge=0)
    shield_ms: int = Field(ge=0)
    offense_lock_ms: int = Field(ge=0)
    stun_ms: int = Field(ge=0)
    stun_chance_percent: int = Field(ge=0, le=100)
    burn_damage: int = Field(ge=0, le=100)
    burn_ms: int = Field(ge=0)
    breaks_shield: bool


class PowerupKind(str, Enum):
    PHOENIX = "phoenix"
    BEZOAR = "bezoar"
    FELIX = "felix"
    MIRROR = "mirror"
    HASTE = "haste"


class RulesetWire(WireModel):
    version: Literal[1] = 1
    tick_ms: Literal[50] = 50
    countdown_ms: Literal[3000] = 3000
    round_ms: Literal[90000] = 90_000
    heartbeat_ms: Literal[500] = 500
    heartbeat_timeout_ms: Literal[1500] = 1500
    max_hp: Literal[100] = 100
    crit_chance_percent: int = Field(ge=0, le=100)
    crit_multiplier_percent: int = Field(ge=100, le=300)
    perfect_block_ms: int = Field(ge=0)
    powerup_lifetime_ms: int = Field(ge=0)
    spells: tuple[SpellRuleWire, ...]


Identifier = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$"),
]
InputGeneration = Annotated[int, Field(ge=1, le=2_147_483_647)]


class AuthMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["auth"] = "auth"
    token: str = Field(min_length=20, max_length=256)


class HeartbeatMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["heartbeat"] = "heartbeat"
    client_ms: float = Field(ge=0, le=1e15)
    input_generation: InputGeneration
    healthy: bool


class ReadyMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["ready"] = "ready"
    ready: bool
    input_generation: InputGeneration
    healthy: bool
    device_id: Identifier
    boot_id: int = Field(ge=1, le=0xFFFFFFFF)


class CastMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["cast"] = "cast"
    round_id: int = Field(ge=1, le=2_147_483_647)
    attempt_id: Identifier
    spell: Spell
    gesture_id: Identifier
    speech_id: Identifier
    input_generation: InputGeneration


class TutorialContinueMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["tutorialContinue"] = "tutorialContinue"
    round_id: int = Field(ge=1, le=2_147_483_647)
    step: int = Field(ge=0, le=5)


class LeaveMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["leave"] = "leave"


GameMessage = Annotated[
    HeartbeatMessage | ReadyMessage | CastMessage | TutorialContinueMessage | LeaveMessage,
    Field(discriminator="type"),
]
GAME_MESSAGE_ADAPTER: TypeAdapter[GameMessage] = TypeAdapter(GameMessage)


class ResultSnapshot(WireModel):
    outcome: Outcome
    winner: Slot | None = None
    reason: str = Field(min_length=1, max_length=64)
    ended_at_ms: int


class PlayerSnapshot(WireModel):
    slot: Slot
    name: str
    source: Source
    connected: bool
    ready: bool
    input_healthy: bool
    input_generation: int | None
    device_id: str | None
    boot_id: int | None
    hp: int = Field(ge=0, le=100)
    max_hp: Literal[100] = 100
    shield_until_ms: int
    offense_locked_until_ms: int
    stunned_until_ms: int
    burn_until_ms: int
    haste_until_ms: int
    mirror_until_ms: int
    lucky: bool
    cooldown_until_ms: dict[str, int]


class ProjectileSnapshot(WireModel):
    id: str
    action_id: str
    spell: Literal[Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO]
    caster: Slot
    target: Slot
    launch_at_ms: int
    impact_at_ms: int
    damage: int
    offense_lock_ms: int
    reflected: bool


class PowerupSnapshot(WireModel):
    id: str
    kind: PowerupKind
    spawned_at_ms: int
    expires_at_ms: int


EventType = Literal[
    "playerJoined",
    "playerLeft",
    "playerReady",
    "roundCountdown",
    "roundStarted",
    "castAccepted",
    "shieldRaised",
    "projectileLaunched",
    "impactBlocked",
    "impactReflected",
    "shieldBroken",
    "damage",
    "burning",
    "burned",
    "stunned",
    "healed",
    "offenseLocked",
    "powerupAppeared",
    "powerupClaimed",
    "powerupExpired",
    "roundEnded",
    "roundAborted",
]


class DuelEvent(WireModel):
    id: str
    type: EventType
    at_ms: int
    round_id: int
    state_version: int
    actor: Slot | None = None
    target: Slot | None = None
    spell: Spell | None = None
    action_id: str | None = None
    projectile_id: str | None = None
    effect_id: str | None = None
    amount: int | None = None
    reason: str | None = None
    critical: bool = False
    powerup: PowerupKind | None = None


class TutorialSnapshot(WireModel):
    step: int = Field(ge=0, le=5)
    spell: Spell | None
    stage: Literal["instruction", "practice", "complete", "free"]
    paused: bool


class Snapshot(WireModel):
    room_id: RoomId = "main"
    mode: Mode = Mode.DUEL
    room_generation: int
    round_id: int
    state_version: int
    server_now_ms: int
    phase: Phase
    countdown_ends_at_ms: int
    round_ends_at_ms: int
    result: ResultSnapshot | None
    players: dict[str, PlayerSnapshot | None]
    projectiles: tuple[ProjectileSnapshot, ...]
    powerup: PowerupSnapshot | None = None
    recent_events: tuple[DuelEvent, ...]
    tutorial: TutorialSnapshot | None = None


class SnapshotMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["snapshot"] = "snapshot"
    snapshot: Snapshot


class WelcomeMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["welcome"] = "welcome"
    slot: Slot
    room_id: RoomId = "main"
    mode: Mode = Mode.DUEL
    rules: RulesetWire
    snapshot: Snapshot


class AckMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["ack"] = "ack"
    command: Literal["ready", "cast", "tutorialContinue"]
    request_id: str | None = None
    accepted: bool
    reason: str | None = None
    state_version: int
    action_id: str | None = None
    projectile_id: str | None = None


class PongMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["pong"] = "pong"
    client_ms: float
    server_ms: int


class ErrorMessage(WireModel):
    v: Literal[1] = 1
    type: Literal["error"] = "error"
    code: str = Field(min_length=1, max_length=64)


ByteValue = Annotated[int, Field(ge=0, le=255)]
Bytes20 = Annotated[list[ByteValue], Field(min_length=20, max_length=20)]


class RelayOwnerAuth(WireModel):
    v: Literal[1] = 1
    type: Literal["owner"] = "owner"
    token: str = Field(min_length=20, max_length=256)


class RelayPhoneAuth(WireModel):
    v: Literal[1] = 1
    type: Literal["phone"] = "phone"
    code: str = Field(min_length=8, max_length=32)


RelayAuth = Annotated[
    RelayOwnerAuth | RelayPhoneAuth,
    Field(discriminator="type"),
]
RELAY_AUTH_ADAPTER: TypeAdapter[RelayAuth] = TypeAdapter(RelayAuth)


class RelayOperation(WireModel):
    v: Literal[1] = 1
    type: Literal["op"] = "op"
    id: Identifier
    operation: Literal[
        "info", "status", "subscribe-motion", "subscribe-status", "control"
    ]
    data: Bytes20 | None = None

    @field_validator("data")
    @classmethod
    def validate_operation_data(
        cls, value: list[int] | None, info: Any
    ) -> list[int] | None:
        operation = info.data.get("operation")
        if operation == "control" and value is None:
            raise ValueError("control requires a 20-byte value")
        if operation != "control" and value is not None:
            raise ValueError("only control carries operation data")
        return value


class RelayReply(WireModel):
    v: Literal[1] = 1
    type: Literal["reply"] = "reply"
    id: Identifier
    data: Bytes20 | None = None
    error: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("error")
    @classmethod
    def reply_has_one_result(cls, value: str | None, info: Any) -> str | None:
        if value is not None and info.data.get("data") is not None:
            raise ValueError("reply cannot contain both data and error")
        return value


class RelayNotify(WireModel):
    v: Literal[1] = 1
    type: Literal["notify"] = "notify"
    kind: Literal["motion", "status"]
    data: Bytes20


RelayOwnerMessage = RelayOperation
RelayPhoneMessage = Annotated[
    RelayReply | RelayNotify,
    Field(discriminator="type"),
]
RELAY_OWNER_MESSAGE_ADAPTER: TypeAdapter[RelayOwnerMessage] = TypeAdapter(
    RelayOwnerMessage
)
RELAY_PHONE_MESSAGE_ADAPTER: TypeAdapter[RelayPhoneMessage] = TypeAdapter(
    RelayPhoneMessage
)


class RelayPaired(WireModel):
    v: Literal[1] = 1
    type: Literal["paired"] = "paired"
    pair_id: str
    generation: int


class RelayWaiting(WireModel):
    v: Literal[1] = 1
    type: Literal["waiting"] = "waiting"
    role: Literal["owner"] = "owner"


class RelayError(WireModel):
    v: Literal[1] = 1
    type: Literal["error"] = "error"
    code: str = Field(min_length=1, max_length=64)


def wire_dict(model: BaseModel) -> dict[str, Any]:
    """Serialize a wire model with aliases and JSON-safe enum values."""

    return model.model_dump(mode="json", by_alias=True)
