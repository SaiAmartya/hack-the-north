"""Pure, deterministic Wand Duel combat authority.

The engine has no clock, socket, task, or legacy-host dependency. Callers pass
server receipt/tick times explicitly. One ``advance`` call is one simulation
step: every impact due in that step resolves before knockout adjudication.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field, replace
from typing import Literal

from phantom_host.duel_models import (
    DuelEvent,
    Outcome,
    Phase,
    ProjectileSnapshot,
    ResultSnapshot,
    RulesetWire,
    Slot,
    Spell,
    SpellRuleWire,
)

TICK_MS = 50
COUNTDOWN_MS = 3_000
ROUND_MS = 60_000
HEARTBEAT_TIMEOUT_MS = 1_500
MAX_HP = 100
RECENT_EVENT_LIMIT = 64
EVIDENCE_LIMIT = 256


@dataclass(frozen=True)
class SpellRule:
    enabled: bool
    damage: int
    cooldown_ms: int
    heal: int = 0
    flight_ms: int = 0
    shield_ms: int = 0
    offense_lock_ms: int = 0


SPELL_RULES: dict[Spell, SpellRule] = {
    Spell.STUPEFY: SpellRule(
        enabled=True, damage=20, cooldown_ms=2_000, flight_ms=2_000
    ),
    Spell.PROTEGO: SpellRule(
        enabled=True, damage=0, cooldown_ms=3_000, shield_ms=1_200
    ),
    Spell.EXPELLIARMUS: SpellRule(
        enabled=True,
        damage=10,
        cooldown_ms=6_000,
        flight_ms=2_200,
        offense_lock_ms=1_000,
    ),
    Spell.INCENDIO: SpellRule(
        enabled=True, damage=30, cooldown_ms=8_000, flight_ms=2_400
    ),
    Spell.EPISKEY: SpellRule(
        enabled=True, damage=0, heal=18, cooldown_ms=12_000
    ),
}


def ruleset() -> RulesetWire:
    spells = tuple(
        SpellRuleWire(
            spell=spell,
            enabled=rule.enabled,
            damage=rule.damage,
            heal=rule.heal,
            cooldown_ms=rule.cooldown_ms,
            flight_ms=rule.flight_ms,
            shield_ms=rule.shield_ms,
            offense_lock_ms=rule.offense_lock_ms,
        )
        for spell, rule in SPELL_RULES.items()
    )
    return RulesetWire(spells=spells)


@dataclass
class CombatPlayer:
    hp: int = MAX_HP
    ready: bool = False
    shield_until_ms: int = 0
    offense_locked_until_ms: int = 0
    cooldown_until_ms: dict[Spell, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Projectile:
    id: str
    action_id: str
    spell: Literal[Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO]
    caster: Slot
    target: Slot
    launch_at_ms: int
    impact_at_ms: int
    damage: int
    offense_lock_ms: int

    def snapshot(self) -> ProjectileSnapshot:
        return ProjectileSnapshot(
            id=self.id,
            action_id=self.action_id,
            spell=self.spell,
            caster=self.caster,
            target=self.target,
            launch_at_ms=self.launch_at_ms,
            impact_at_ms=self.impact_at_ms,
            damage=self.damage,
            offense_lock_ms=self.offense_lock_ms,
        )


@dataclass(frozen=True)
class CastCommand:
    command_id: int
    slot: Slot
    at_ms: int
    order: int
    round_id: int
    attempt_id: str
    spell: Spell
    gesture_id: str
    speech_id: str


@dataclass(frozen=True)
class ReadyCommand:
    command_id: int
    slot: Slot
    at_ms: int
    order: int
    ready: bool


@dataclass(frozen=True)
class AbortCommand:
    at_ms: int
    order: int
    reason: str


TimelineCommand = CastCommand | ReadyCommand | AbortCommand


@dataclass(frozen=True)
class CommandDecision:
    command_id: int
    command: Literal["ready", "cast"]
    accepted: bool
    reason: str | None = None
    action_id: str | None = None
    projectile_id: str | None = None


class DuelEngine:
    """One-room state machine with deterministic IDs and explicit time."""

    def __init__(self, *, round_duration_ms: int | None = ROUND_MS) -> None:
        self.round_duration_ms = round_duration_ms
        self.room_generation = 1
        self.round_id = 0
        self.state_version = 0
        self.phase = Phase.LOBBY
        self.countdown_ends_at_ms = 0
        self.round_ends_at_ms = 0
        self.result: ResultSnapshot | None = None
        self.players: dict[Slot, CombatPlayer] = {}
        self.projectiles: list[Projectile] = []
        self.recent_events: deque[DuelEvent] = deque(maxlen=RECENT_EVENT_LIMIT)
        self._event_sequence = 0
        self._action_sequence = 0
        self._projectile_sequence = 0
        self._effect_sequence = 0
        self._seen_evidence: dict[Slot, set[str]] = {}
        self._evidence_order: dict[Slot, deque[str]] = {}

    def reset_lobby(
        self,
        *,
        now_ms: int,
        room_generation: int,
        occupied_slots: set[Slot],
    ) -> None:
        self.room_generation = room_generation
        self.phase = Phase.LOBBY
        self.countdown_ends_at_ms = 0
        self.round_ends_at_ms = 0
        self.result = None
        self.projectiles.clear()
        self.recent_events.clear()
        self.players = {slot: CombatPlayer() for slot in occupied_slots}
        self._seen_evidence = {slot: set() for slot in occupied_slots}
        self._evidence_order = {
            slot: deque(maxlen=EVIDENCE_LIMIT) for slot in occupied_slots
        }
        self._touch()

    def pause_timeline(self, *, after_ms: int, elapsed_ms: int) -> None:
        """Freeze active combat deadlines while a tutorial instruction is read."""
        if elapsed_ms <= 0 or self.phase is not Phase.PLAYING:
            return
        if self.round_ends_at_ms:
            self.round_ends_at_ms += elapsed_ms
        self.projectiles = [replace(
            projectile,
            launch_at_ms=projectile.launch_at_ms + elapsed_ms,
            impact_at_ms=projectile.impact_at_ms + elapsed_ms,
        ) for projectile in self.projectiles]
        for player in self.players.values():
            if player.shield_until_ms > after_ms:
                player.shield_until_ms += elapsed_ms
            if player.offense_locked_until_ms > after_ms:
                player.offense_locked_until_ms += elapsed_ms
            player.cooldown_until_ms = {
                spell: deadline + elapsed_ms if deadline > after_ms else deadline
                for spell, deadline in player.cooldown_until_ms.items()
            }
        self._touch()

    def restore_training_checkpoint(self, *, health: dict[Slot, int], clear_effects: bool = False) -> None:
        """Explicit lesson reset; never emit a fabricated spell/healing event."""
        for slot, hp in health.items():
            self.players[slot].hp = hp
        if clear_effects:
            self.projectiles.clear()
            for player in self.players.values():
                player.shield_until_ms = 0
                player.offense_locked_until_ms = 0
                player.cooldown_until_ms.clear()
        self._touch()

    def record_membership(
        self, *, now_ms: int, slot: Slot, joined: bool, reason: str | None = None
    ) -> None:
        self._event(
            "playerJoined" if joined else "playerLeft",
            now_ms,
            actor=slot,
            reason=reason,
        )

    def advance(
        self, *, now_ms: int, commands: list[TimelineCommand]
    ) -> list[CommandDecision]:
        """Advance one step and return decisions for commands in this step.

        Ordering at one timestamp is abort, countdown transition, impacts,
        round deadline, then player commands. Impact versus guard is therefore
        impact-first. Knockout is deferred until every impact due by ``now_ms``
        has resolved, which preserves simultaneous knockout within a step.
        """

        decisions: list[CommandDecision] = []
        ordered = sorted(
            commands,
            key=lambda command: (
                command.at_ms,
                0 if isinstance(command, AbortCommand) else 1,
                command.order,
            ),
        )
        command_index = 0
        aborted_during_advance = False
        finished_during_advance = False

        while True:
            candidates: list[int] = []
            if (
                command_index < len(ordered)
                and ordered[command_index].at_ms <= now_ms
            ):
                candidates.append(ordered[command_index].at_ms)
            if self.phase is Phase.COUNTDOWN and self.countdown_ends_at_ms <= now_ms:
                candidates.append(self.countdown_ends_at_ms)
            if self.phase is Phase.PLAYING:
                due_impacts = [
                    projectile.impact_at_ms
                    for projectile in self.projectiles
                    if projectile.impact_at_ms <= now_ms
                ]
                if due_impacts:
                    candidates.append(min(due_impacts))
                if self.round_ends_at_ms and self.round_ends_at_ms <= now_ms:
                    candidates.append(self.round_ends_at_ms)
            if not candidates:
                break

            at_ms = min(candidates)
            same_time: list[TimelineCommand] = []
            while (
                command_index < len(ordered)
                and ordered[command_index].at_ms == at_ms
            ):
                same_time.append(ordered[command_index])
                command_index += 1

            for command in same_time:
                if isinstance(command, AbortCommand):
                    if (
                        self.phase in (Phase.COUNTDOWN, Phase.PLAYING)
                        and not self._has_lethal_player()
                    ):
                        self.abort(at_ms=at_ms, reason=command.reason)
                        aborted_during_advance = True

            if self.phase is Phase.COUNTDOWN and self.countdown_ends_at_ms == at_ms:
                self.phase = Phase.PLAYING
                self.round_ends_at_ms = (
                    at_ms + self.round_duration_ms if self.round_duration_ms is not None else 0
                )
                self._event("roundStarted", at_ms)

            if self.phase is Phase.PLAYING:
                self._resolve_impacts_at(at_ms)

            if self.phase is Phase.PLAYING and self.round_ends_at_ms and self.round_ends_at_ms == at_ms:
                if self._has_lethal_player():
                    self._finish_knockout(at_ms)
                else:
                    self._finish_timeout(at_ms)
                finished_during_advance = True

            for command in same_time:
                if isinstance(command, ReadyCommand):
                    if aborted_during_advance or finished_during_advance:
                        decisions.append(
                            CommandDecision(
                                command_id=command.command_id,
                                command="ready",
                                accepted=False,
                                reason=(
                                    "round_aborted"
                                    if aborted_during_advance
                                    else "round_ending"
                                ),
                            )
                        )
                    else:
                        decisions.append(self._apply_ready(command))
                elif isinstance(command, CastCommand):
                    if aborted_during_advance or finished_during_advance:
                        decisions.append(
                            CommandDecision(
                                command_id=command.command_id,
                                command="cast",
                                accepted=False,
                                reason=(
                                    "round_aborted"
                                    if aborted_during_advance
                                    else "round_ending"
                                ),
                            )
                        )
                    else:
                        decisions.append(self._apply_cast(command))

        if self.phase is Phase.PLAYING and self._has_lethal_player():
            self._finish_knockout(now_ms)

        return decisions

    def abort(self, *, at_ms: int, reason: str) -> None:
        if self.phase not in (Phase.COUNTDOWN, Phase.PLAYING):
            return
        self.phase = Phase.RESULT
        self.projectiles.clear()
        for player in self.players.values():
            player.ready = False
            player.shield_until_ms = 0
        self.result = ResultSnapshot(
            outcome=Outcome.ABORTED,
            winner=None,
            reason=reason,
            ended_at_ms=at_ms,
        )
        self._event("roundAborted", at_ms, reason=reason)

    def _apply_ready(self, command: ReadyCommand) -> CommandDecision:
        player = self.players.get(command.slot)
        if player is None:
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=False,
                reason="slot_empty",
            )
        if self.phase is Phase.PLAYING and self._has_lethal_player():
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=False,
                reason="round_ending",
            )
        if self.phase is Phase.PLAYING:
            if not command.ready:
                self.abort(at_ms=command.at_ms, reason="ready_lost")
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=False,
                reason="phase",
            )
        if self.phase is Phase.COUNTDOWN and not command.ready:
            self.abort(at_ms=command.at_ms, reason="ready_lost")
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=True,
            )
        if self.phase is Phase.COUNTDOWN:
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=False,
                reason="phase",
            )

        if player.ready == command.ready:
            return CommandDecision(
                command_id=command.command_id,
                command="ready",
                accepted=True,
                reason="unchanged",
            )
        player.ready = command.ready
        self._event(
            "playerReady",
            command.at_ms,
            actor=command.slot,
            reason="ready" if command.ready else "not_ready",
        )
        if command.ready and len(self.players) == 2 and all(
            candidate.ready for candidate in self.players.values()
        ):
            self._begin_countdown(command.at_ms)
        return CommandDecision(
            command_id=command.command_id,
            command="ready",
            accepted=True,
        )

    def _begin_countdown(self, at_ms: int) -> None:
        self.round_id += 1
        self.phase = Phase.COUNTDOWN
        self.countdown_ends_at_ms = at_ms + COUNTDOWN_MS
        self.round_ends_at_ms = 0
        self.result = None
        self.projectiles.clear()
        self.recent_events.clear()
        self._action_sequence = 0
        self._projectile_sequence = 0
        self._effect_sequence = 0
        for slot, player in self.players.items():
            player.hp = MAX_HP
            player.ready = True
            player.shield_until_ms = 0
            player.offense_locked_until_ms = 0
            player.cooldown_until_ms.clear()
            self._seen_evidence[slot].clear()
            self._evidence_order[slot].clear()
        self._event("roundCountdown", at_ms)

    def _apply_cast(self, command: CastCommand) -> CommandDecision:
        if self.phase is not Phase.PLAYING:
            return self._cast_reject(command, "phase")
        if command.round_id != self.round_id:
            return self._cast_reject(command, "wrong_round")
        player = self.players.get(command.slot)
        if player is None:
            return self._cast_reject(command, "slot_empty")
        if self._has_lethal_player():
            return self._cast_reject(command, "round_ending")
        if self._evidence_seen(command):
            return self._cast_reject(command, "duplicate_evidence")
        self._remember_evidence(command)

        rule = SPELL_RULES[command.spell]
        if not rule.enabled:
            return self._cast_reject(command, "spell_disabled")
        if command.at_ms < player.cooldown_until_ms.get(command.spell, 0):
            return self._cast_reject(command, "cooldown")
        if rule.damage:
            if command.at_ms < player.offense_locked_until_ms:
                return self._cast_reject(command, "offense_locked")
        if rule.heal and player.hp == MAX_HP:
            return self._cast_reject(command, "full_health")

        action_id = self._next_action_id()
        player.cooldown_until_ms[command.spell] = command.at_ms + rule.cooldown_ms

        self._event(
            "castAccepted",
            command.at_ms,
            actor=command.slot,
            spell=command.spell,
            action_id=action_id,
            effect_id=self._next_effect_id(),
        )

        if command.spell is Spell.PROTEGO:
            player.shield_until_ms = command.at_ms + rule.shield_ms
            self._event(
                "shieldRaised",
                command.at_ms,
                actor=command.slot,
                spell=command.spell,
                action_id=action_id,
                effect_id=self._next_effect_id(),
            )
            return CommandDecision(
                command_id=command.command_id,
                command="cast",
                accepted=True,
                action_id=action_id,
            )

        if command.spell is Spell.EPISKEY:
            amount = min(rule.heal, MAX_HP - player.hp)
            player.hp += amount
            self._event(
                "healed",
                command.at_ms,
                actor=command.slot,
                target=command.slot,
                spell=command.spell,
                action_id=action_id,
                effect_id=self._next_effect_id(),
                amount=amount,
            )
            return CommandDecision(
                command_id=command.command_id,
                command="cast",
                accepted=True,
                action_id=action_id,
            )

        projectile_id = self._next_projectile_id()
        target = Slot.P2 if command.slot is Slot.P1 else Slot.P1
        projectile = Projectile(
            id=projectile_id,
            action_id=action_id,
            spell=command.spell,
            caster=command.slot,
            target=target,
            launch_at_ms=command.at_ms,
            impact_at_ms=command.at_ms + rule.flight_ms,
            damage=rule.damage,
            offense_lock_ms=rule.offense_lock_ms,
        )
        self.projectiles.append(projectile)
        self._event(
            "projectileLaunched",
            command.at_ms,
            actor=command.slot,
            target=target,
            spell=command.spell,
            action_id=action_id,
            projectile_id=projectile_id,
        )
        return CommandDecision(
            command_id=command.command_id,
            command="cast",
            accepted=True,
            action_id=action_id,
            projectile_id=projectile_id,
        )

    def _cast_reject(self, command: CastCommand, reason: str) -> CommandDecision:
        return CommandDecision(
            command_id=command.command_id,
            command="cast",
            accepted=False,
            reason=reason,
        )

    def _resolve_impacts_at(self, at_ms: int) -> None:
        due = sorted(
            (
                projectile
                for projectile in self.projectiles
                if projectile.impact_at_ms == at_ms
            ),
            key=lambda projectile: (projectile.impact_at_ms, projectile.id),
        )
        if not due:
            return
        due_ids = {projectile.id for projectile in due}
        self.projectiles = [
            projectile
            for projectile in self.projectiles
            if projectile.id not in due_ids
        ]
        for projectile in due:
            target = self.players[projectile.target]
            if at_ms < target.shield_until_ms:
                target.shield_until_ms = 0
                self._event(
                    "impactBlocked",
                    at_ms,
                    actor=projectile.caster,
                    target=projectile.target,
                    spell=projectile.spell,
                    action_id=projectile.action_id,
                    projectile_id=projectile.id,
                    effect_id=self._next_effect_id(),
                )
                continue

            amount = min(target.hp, projectile.damage)
            target.hp -= amount
            self._event(
                "damage",
                at_ms,
                actor=projectile.caster,
                target=projectile.target,
                spell=projectile.spell,
                action_id=projectile.action_id,
                projectile_id=projectile.id,
                effect_id=self._next_effect_id(),
                amount=amount,
            )
            if projectile.offense_lock_ms and target.hp > 0:
                target.offense_locked_until_ms = max(
                    target.offense_locked_until_ms,
                    at_ms + projectile.offense_lock_ms,
                )
                self._event(
                    "offenseLocked",
                    at_ms,
                    actor=projectile.caster,
                    target=projectile.target,
                    spell=projectile.spell,
                    action_id=projectile.action_id,
                    projectile_id=projectile.id,
                    effect_id=self._next_effect_id(),
                )

    def _finish_knockout(self, at_ms: int) -> None:
        dead = [slot for slot, player in self.players.items() if player.hp == 0]
        if len(dead) == 2:
            self._finish(at_ms, Outcome.DRAW, None, "knockout")
        elif len(dead) == 1:
            winner = Slot.P2 if dead[0] is Slot.P1 else Slot.P1
            self._finish(at_ms, Outcome.WIN, winner, "knockout")

    def _finish_timeout(self, at_ms: int) -> None:
        health = {slot: player.hp for slot, player in self.players.items()}
        if health.get(Slot.P1, 0) == health.get(Slot.P2, 0):
            self._finish(at_ms, Outcome.DRAW, None, "timeout")
        else:
            winner = max(health, key=health.__getitem__)
            self._finish(at_ms, Outcome.WIN, winner, "timeout")

    def _finish(
        self,
        at_ms: int,
        outcome: Outcome,
        winner: Slot | None,
        reason: str,
    ) -> None:
        self.phase = Phase.RESULT
        self.projectiles.clear()
        for player in self.players.values():
            player.ready = False
            player.shield_until_ms = 0
        self.result = ResultSnapshot(
            outcome=outcome,
            winner=winner,
            reason=reason,
            ended_at_ms=at_ms,
        )
        self._event(
            "roundEnded",
            at_ms,
            actor=winner,
            reason=reason,
            effect_id=self._next_effect_id(),
        )

    def _has_lethal_player(self) -> bool:
        return any(player.hp == 0 for player in self.players.values())

    def _evidence_seen(self, command: CastCommand) -> bool:
        seen = self._seen_evidence[command.slot]
        return command.gesture_id in seen or command.speech_id in seen

    def _remember_evidence(self, command: CastCommand) -> None:
        seen = self._seen_evidence[command.slot]
        order = self._evidence_order[command.slot]
        for evidence_id in (command.gesture_id, command.speech_id):
            if evidence_id in seen:
                continue
            if len(order) == order.maxlen:
                seen.discard(order.popleft())
            order.append(evidence_id)
            seen.add(evidence_id)

    def _next_action_id(self) -> str:
        self._action_sequence += 1
        return f"r{self.round_id}:a{self._action_sequence}"

    def _next_projectile_id(self) -> str:
        self._projectile_sequence += 1
        return f"r{self.round_id}:p{self._projectile_sequence}"

    def _next_effect_id(self) -> str:
        self._effect_sequence += 1
        return f"r{self.round_id}:fx{self._effect_sequence}"

    def _event(
        self,
        event_type: str,
        at_ms: int,
        *,
        actor: Slot | None = None,
        target: Slot | None = None,
        spell: Spell | None = None,
        action_id: str | None = None,
        projectile_id: str | None = None,
        effect_id: str | None = None,
        amount: int | None = None,
        reason: str | None = None,
    ) -> DuelEvent:
        self._event_sequence += 1
        event = DuelEvent(
            id=f"g{self.room_generation}:r{self.round_id}:e{self._event_sequence}",
            type=event_type,  # type: ignore[arg-type]
            at_ms=at_ms,
            round_id=self.round_id,
            state_version=self.state_version + 1,
            actor=actor,
            target=target,
            spell=spell,
            action_id=action_id,
            projectile_id=projectile_id,
            effect_id=effect_id,
            amount=amount,
            reason=reason,
        )
        self.recent_events.append(event)
        self._touch()
        return event

    def _touch(self) -> None:
        self.state_version += 1
