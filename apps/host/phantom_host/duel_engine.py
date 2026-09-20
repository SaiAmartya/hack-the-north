"""Pure, deterministic Wand Duel combat authority.

The engine has no clock, socket, task, or legacy-host dependency. Callers pass
server receipt/tick times explicitly. One ``advance`` call is one simulation
step: every impact due in that step resolves before knockout adjudication.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
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
CAST_RECOVERY_MS = 500
RECENT_EVENT_LIMIT = 64
EVIDENCE_LIMIT = 256


@dataclass(frozen=True)
class SpellRule:
    """Starting values; every number is a physical-play tuning candidate."""

    damage: int
    cooldown_ms: int
    flight_ms: int = 0
    shield_ms: int = 0
    offense_lock_ms: int = 0
    bind_ms: int = 0
    burn_damage: int = 0
    burn_ticks: int = 0
    burn_interval_ms: int = 0
    barrier_ms: int = 0

    @property
    def offensive(self) -> bool:
        return self.flight_ms > 0


SPELL_RULES: dict[Spell, SpellRule] = {
    # Stunning Spell: the basic bolt.
    Spell.STUPEFY: SpellRule(damage=20, cooldown_ms=2_000, flight_ms=2_000),
    # Shield Charm: one incoming spell is caught, then the shield breaks.
    Spell.PROTEGO: SpellRule(damage=0, cooldown_ms=3_000, shield_ms=1_200),
    # Disarming Charm: light hit plus a short disarm (no offensive casts).
    Spell.EXPELLIARMUS: SpellRule(
        damage=10, cooldown_ms=6_000, flight_ms=2_200, offense_lock_ms=1_000
    ),
    # Fire-Making Spell: impact plus a burn that keeps ticking through later shields.
    Spell.INCENDIO: SpellRule(
        damage=8,
        cooldown_ms=6_000,
        flight_ms=2_000,
        burn_damage=4,
        burn_ticks=3,
        burn_interval_ms=1_000,
    ),
    # Slashing curse: the heavy hit, telegraphed by a long flight.
    Spell.SECTUMSEMPRA: SpellRule(damage=35, cooldown_ms=9_000, flight_ms=2_800),
    # Full Body-Bind: no damage; the target cannot cast anything for a moment.
    Spell.PETRIFICUS_TOTALUS: SpellRule(
        damage=0, cooldown_ms=10_000, flight_ms=2_400, bind_ms=1_500
    ),
    # Patronus Charm: a barrier that repels every incoming spell without breaking.
    Spell.EXPECTO_PATRONUM: SpellRule(damage=0, cooldown_ms=15_000, barrier_ms=3_000),
}
ALL_SPELLS: frozenset[Spell] = frozenset(SPELL_RULES)
CORE_SPELLS: frozenset[Spell] = frozenset({Spell.STUPEFY, Spell.PROTEGO})


def ruleset(*, enabled_spells: frozenset[Spell] = ALL_SPELLS) -> RulesetWire:
    spells = tuple(
        SpellRuleWire(
            spell=spell,
            enabled=spell in enabled_spells,
            damage=rule.damage,
            cooldown_ms=rule.cooldown_ms,
            flight_ms=rule.flight_ms,
            shield_ms=rule.shield_ms,
            offense_lock_ms=rule.offense_lock_ms,
            bind_ms=rule.bind_ms,
            burn_damage=rule.burn_damage,
            burn_ticks=rule.burn_ticks,
            burn_interval_ms=rule.burn_interval_ms,
            barrier_ms=rule.barrier_ms,
        )
        for spell, rule in SPELL_RULES.items()
    )
    return RulesetWire(spells=spells)


@dataclass(frozen=True)
class BurnTick:
    at_ms: int
    amount: int
    caster: Slot
    spell: Spell
    action_id: str


@dataclass
class CombatPlayer:
    hp: int = MAX_HP
    ready: bool = False
    shield_until_ms: int = 0
    barrier_until_ms: int = 0
    offense_locked_until_ms: int = 0
    bound_until_ms: int = 0
    cast_recovery_until_ms: int = 0
    cooldown_until_ms: dict[Spell, int] = field(default_factory=dict)
    burns: list[BurnTick] = field(default_factory=list)

    @property
    def burning_until_ms(self) -> int:
        return max((tick.at_ms for tick in self.burns), default=0)

    def clear_status(self) -> None:
        self.shield_until_ms = 0
        self.barrier_until_ms = 0
        self.offense_locked_until_ms = 0
        self.bound_until_ms = 0
        self.cast_recovery_until_ms = 0
        self.burns.clear()


@dataclass(frozen=True)
class Projectile:
    id: str
    action_id: str
    spell: Spell
    caster: Slot
    target: Slot
    launch_at_ms: int
    impact_at_ms: int
    damage: int
    offense_lock_ms: int
    bind_ms: int = 0
    burn_damage: int = 0
    burn_ticks: int = 0
    burn_interval_ms: int = 0

    def snapshot(self) -> ProjectileSnapshot:
        return ProjectileSnapshot(
            id=self.id,
            action_id=self.action_id,
            spell=self.spell,  # type: ignore[arg-type]
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

    def __init__(self, *, enabled_spells: frozenset[Spell] | None = None) -> None:
        self.enabled_spells = ALL_SPELLS if enabled_spells is None else enabled_spells
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
                due_burns = [
                    tick.at_ms
                    for player in self.players.values()
                    for tick in player.burns
                    if tick.at_ms <= now_ms
                ]
                if due_burns:
                    candidates.append(min(due_burns))
                if self.round_ends_at_ms <= now_ms:
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
                self.round_ends_at_ms = at_ms + ROUND_MS
                self._event("roundStarted", at_ms)

            if self.phase is Phase.PLAYING:
                self._resolve_impacts_at(at_ms)
                self._resolve_burns_at(at_ms)

            if self.phase is Phase.PLAYING and self.round_ends_at_ms == at_ms:
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
            player.clear_status()
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
            player.clear_status()
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
        if command.spell not in self.enabled_spells:
            return self._cast_reject(command, "spell_disabled")
        if command.at_ms < player.bound_until_ms:
            return self._cast_reject(command, "bound")
        if command.at_ms < player.cooldown_until_ms.get(command.spell, 0):
            return self._cast_reject(command, "cooldown")
        if command.at_ms < player.cast_recovery_until_ms:
            return self._cast_reject(command, "cast_recovery")
        if rule.offensive and command.at_ms < player.offense_locked_until_ms:
            return self._cast_reject(command, "offense_locked")

        action_id = self._next_action_id()
        player.cooldown_until_ms[command.spell] = command.at_ms + rule.cooldown_ms
        player.cast_recovery_until_ms = command.at_ms + CAST_RECOVERY_MS

        self._event(
            "castAccepted",
            command.at_ms,
            actor=command.slot,
            spell=command.spell,
            action_id=action_id,
            effect_id=self._next_effect_id(),
        )

        if rule.shield_ms:
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
        if rule.barrier_ms:
            player.barrier_until_ms = command.at_ms + rule.barrier_ms
            self._event(
                "barrierRaised",
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
            bind_ms=rule.bind_ms,
            burn_damage=rule.burn_damage,
            burn_ticks=rule.burn_ticks,
            burn_interval_ms=rule.burn_interval_ms,
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
            blocked_by = (
                "barrier"
                if at_ms < target.barrier_until_ms
                else "shield"
                if at_ms < target.shield_until_ms
                else None
            )
            if blocked_by is not None:
                if blocked_by == "shield":
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
                    reason=blocked_by,
                )
                continue

            if projectile.damage:
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
            if target.hp == 0:
                continue
            if projectile.offense_lock_ms:
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
            if projectile.bind_ms:
                target.bound_until_ms = max(
                    target.bound_until_ms, at_ms + projectile.bind_ms
                )
                self._event(
                    "bodyBound",
                    at_ms,
                    actor=projectile.caster,
                    target=projectile.target,
                    spell=projectile.spell,
                    action_id=projectile.action_id,
                    projectile_id=projectile.id,
                    effect_id=self._next_effect_id(),
                    amount=projectile.bind_ms,
                )
            if projectile.burn_ticks and projectile.burn_damage:
                # A fresh fire replaces an older one: burns never stack.
                target.burns = [
                    BurnTick(
                        at_ms=at_ms + index * projectile.burn_interval_ms,
                        amount=projectile.burn_damage,
                        caster=projectile.caster,
                        spell=projectile.spell,
                        action_id=projectile.action_id,
                    )
                    for index in range(1, projectile.burn_ticks + 1)
                ]
                self._event(
                    "burning",
                    at_ms,
                    actor=projectile.caster,
                    target=projectile.target,
                    spell=projectile.spell,
                    action_id=projectile.action_id,
                    projectile_id=projectile.id,
                    effect_id=self._next_effect_id(),
                    amount=projectile.burn_damage * projectile.burn_ticks,
                )

    def _resolve_burns_at(self, at_ms: int) -> None:
        for slot in sorted(self.players, key=lambda item: item.value):
            player = self.players[slot]
            due = [tick for tick in player.burns if tick.at_ms == at_ms]
            if not due:
                continue
            player.burns = [tick for tick in player.burns if tick.at_ms != at_ms]
            for tick in due:
                if player.hp == 0:
                    continue
                amount = min(player.hp, tick.amount)
                player.hp -= amount
                self._event(
                    "burnDamage",
                    at_ms,
                    actor=tick.caster,
                    target=slot,
                    spell=tick.spell,
                    action_id=tick.action_id,
                    effect_id=self._next_effect_id(),
                    amount=amount,
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
            player.clear_status()
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
