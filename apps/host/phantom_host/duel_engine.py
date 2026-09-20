"""Pure, deterministic Wand Duel combat authority.

The engine has no clock, socket, task, or legacy-host dependency. Callers pass
server receipt/tick times explicitly. One ``advance`` call is one simulation
step: every impact, burn tick and powerup deadline due in that step resolves
before knockout adjudication.

Variance (critical hits, stun rolls and arena powerups) comes from one seeded
generator per round, so an identical command timeline replays identically.
``variance=False`` removes every roll for deterministic lessons and checks.
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from phantom_host.duel_models import (
    DuelEvent,
    Outcome,
    Phase,
    PowerupKind,
    PowerupSnapshot,
    ProjectileSnapshot,
    ResultSnapshot,
    RulesetWire,
    Slot,
    Spell,
    SpellRuleWire,
)

TICK_MS = 50
COUNTDOWN_MS = 3_000
ROUND_MS = 90_000
HEARTBEAT_TIMEOUT_MS = 1_500
MAX_HP = 100
RECENT_EVENT_LIMIT = 96
EVIDENCE_LIMIT = 256

CRIT_CHANCE_PERCENT = 12
CRIT_MULTIPLIER_PERCENT = 150
PERFECT_BLOCK_MS = 350
REFLECT_FLIGHT_MS = 900
BURN_TICK_MS = 1_000

POWERUP_LIFETIME_MS = 10_000
POWERUP_FIRST_MS = (8_000, 14_000)
POWERUP_GAP_MS = (12_000, 20_000)
POWERUP_WEIGHTS: tuple[tuple[PowerupKind, int], ...] = (
    (PowerupKind.PHOENIX, 25),
    (PowerupKind.BEZOAR, 25),
    (PowerupKind.FELIX, 20),
    (PowerupKind.MIRROR, 15),
    (PowerupKind.HASTE, 15),
)
BEZOAR_HEAL = 20
MIRROR_MS = 8_000
HASTE_MS = 8_000


@dataclass(frozen=True)
class SpellRule:
    enabled: bool
    damage: int
    cooldown_ms: int
    heal: int = 0
    flight_ms: int = 0
    shield_ms: int = 0
    offense_lock_ms: int = 0
    stun_ms: int = 0
    stun_chance_percent: int = 0
    burn_damage: int = 0
    burn_ms: int = 0
    breaks_shield: bool = False


SPELL_RULES: dict[Spell, SpellRule] = {
    # Quick bolt: hard to react to, chips reliably, sometimes stuns.
    Spell.STUPEFY: SpellRule(
        enabled=True,
        damage=14,
        cooldown_ms=2_500,
        flight_ms=800,
        stun_ms=1_200,
        stun_chance_percent=25,
    ),
    # One block; a block raised just before impact reflects the spell back.
    Spell.PROTEGO: SpellRule(
        enabled=True, damage=0, cooldown_ms=4_000, shield_ms=1_500
    ),
    # Shatters shields, yanks the wand away and locks attacks.
    Spell.EXPELLIARMUS: SpellRule(
        enabled=True,
        damage=8,
        cooldown_ms=6_000,
        flight_ms=1_100,
        offense_lock_ms=2_500,
        breaks_shield=True,
    ),
    # Slow fireball with a lingering burn.
    Spell.INCENDIO: SpellRule(
        enabled=True,
        damage=22,
        cooldown_ms=9_000,
        flight_ms=1_800,
        burn_damage=3,
        burn_ms=4_000,
    ),
    # Sustain; also cures burning.
    Spell.EPISKEY: SpellRule(
        enabled=True, damage=0, heal=22, cooldown_ms=12_000
    ),
}
OTHER_SLOT = {Slot.P1: Slot.P2, Slot.P2: Slot.P1}


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
            stun_ms=rule.stun_ms,
            stun_chance_percent=rule.stun_chance_percent,
            burn_damage=rule.burn_damage,
            burn_ms=rule.burn_ms,
            breaks_shield=rule.breaks_shield,
        )
        for spell, rule in SPELL_RULES.items()
    )
    return RulesetWire(
        crit_chance_percent=CRIT_CHANCE_PERCENT,
        crit_multiplier_percent=CRIT_MULTIPLIER_PERCENT,
        perfect_block_ms=PERFECT_BLOCK_MS,
        powerup_lifetime_ms=POWERUP_LIFETIME_MS,
        spells=spells,
    )


@dataclass
class CombatPlayer:
    hp: int = MAX_HP
    ready: bool = False
    shield_until_ms: int = 0
    shield_raised_at_ms: int = -1_000_000
    offense_locked_until_ms: int = 0
    stunned_until_ms: int = 0
    burn_until_ms: int = 0
    burn_next_ms: int = 0
    haste_until_ms: int = 0
    mirror_until_ms: int = 0
    lucky: bool = False
    cooldown_until_ms: dict[Spell, int] = field(default_factory=dict)

    def clear_statuses(self) -> None:
        self.shield_until_ms = 0
        self.shield_raised_at_ms = -1_000_000
        self.offense_locked_until_ms = 0
        self.stunned_until_ms = 0
        self.burn_until_ms = 0
        self.burn_next_ms = 0
        self.haste_until_ms = 0
        self.mirror_until_ms = 0
        self.lucky = False


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
    reflected: bool = False

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
            reflected=self.reflected,
        )


@dataclass(frozen=True)
class Powerup:
    id: str
    kind: PowerupKind
    spawned_at_ms: int
    expires_at_ms: int

    def snapshot(self) -> PowerupSnapshot:
        return PowerupSnapshot(
            id=self.id,
            kind=self.kind,
            spawned_at_ms=self.spawned_at_ms,
            expires_at_ms=self.expires_at_ms,
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

    def __init__(
        self,
        *,
        round_duration_ms: int | None = ROUND_MS,
        seed: int = 0,
        variance: bool = True,
    ) -> None:
        self.round_duration_ms = round_duration_ms
        self.seed = seed
        self.variance = variance
        self.room_generation = 1
        self.round_id = 0
        self.state_version = 0
        self.phase = Phase.LOBBY
        self.countdown_ends_at_ms = 0
        self.round_ends_at_ms = 0
        self.result: ResultSnapshot | None = None
        self.players: dict[Slot, CombatPlayer] = {}
        self.projectiles: list[Projectile] = []
        self.powerup: Powerup | None = None
        self.powerup_spawn_at_ms: int | None = None
        self.recent_events: deque[DuelEvent] = deque(maxlen=RECENT_EVENT_LIMIT)
        self._rng = random.Random(seed)
        self._event_sequence = 0
        self._action_sequence = 0
        self._projectile_sequence = 0
        self._effect_sequence = 0
        self._powerup_sequence = 0
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
        self.powerup = None
        self.powerup_spawn_at_ms = None
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
        if self.powerup is not None:
            self.powerup = replace(
                self.powerup,
                spawned_at_ms=self.powerup.spawned_at_ms + elapsed_ms,
                expires_at_ms=self.powerup.expires_at_ms + elapsed_ms,
            )
        if self.powerup_spawn_at_ms is not None:
            self.powerup_spawn_at_ms += elapsed_ms
        for player in self.players.values():
            for name in (
                "shield_until_ms", "offense_locked_until_ms", "stunned_until_ms",
                "burn_until_ms", "burn_next_ms", "haste_until_ms", "mirror_until_ms",
            ):
                deadline = getattr(player, name)
                if deadline > after_ms:
                    setattr(player, name, deadline + elapsed_ms)
            if player.shield_until_ms > after_ms:
                player.shield_raised_at_ms += elapsed_ms
            player.cooldown_until_ms = {
                spell: deadline + elapsed_ms if deadline > after_ms else deadline
                for spell, deadline in player.cooldown_until_ms.items()
            }
        self._touch()

    def restore_training_checkpoint(self, *, health: dict[Slot, int], clear_effects: bool = False) -> None:
        """Explicit lesson reset; never emit a fabricated spell/healing event."""
        for slot, hp in health.items():
            player = self.players[slot]
            player.hp = hp
            # A retried lesson never carries a lingering burn or stun into the retry.
            player.burn_until_ms = 0
            player.burn_next_ms = 0
            player.stunned_until_ms = 0
        if clear_effects:
            self.projectiles.clear()
            self.powerup = None
            for player in self.players.values():
                player.clear_statuses()
                player.cooldown_until_ms.clear()
        self._touch()

    def schedule_powerups(self, *, now_ms: int) -> None:
        """Start (or restart) arena powerups from ``now_ms`` when variance is enabled."""
        if not self.variance or self.phase is not Phase.PLAYING:
            self.powerup_spawn_at_ms = None
            return
        self.powerup_spawn_at_ms = now_ms + self._rng.randint(*POWERUP_FIRST_MS)

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
        burn ticks, powerup deadlines, round deadline, then player commands.
        Impact versus guard is therefore impact-first. Knockout is deferred
        until every impact due by ``now_ms`` has resolved, which preserves
        simultaneous knockout within a step.
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
                    player.burn_next_ms
                    for player in self.players.values()
                    if player.burn_until_ms and player.burn_next_ms <= now_ms
                ]
                if due_burns:
                    candidates.append(min(due_burns))
                if self.powerup is not None and self.powerup.expires_at_ms <= now_ms:
                    candidates.append(self.powerup.expires_at_ms)
                if (
                    self.powerup is None
                    and self.powerup_spawn_at_ms is not None
                    and self.powerup_spawn_at_ms <= now_ms
                ):
                    candidates.append(self.powerup_spawn_at_ms)
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
                self.schedule_powerups(now_ms=at_ms)

            if self.phase is Phase.PLAYING:
                self._resolve_impacts_at(at_ms)
                self._resolve_burns_at(at_ms)
                self._resolve_powerup_at(at_ms)

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
        self.powerup = None
        self.powerup_spawn_at_ms = None
        for player in self.players.values():
            player.ready = False
            player.clear_statuses()
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
        self.powerup = None
        self.powerup_spawn_at_ms = None
        self.recent_events.clear()
        self._rng = random.Random(
            (self.seed * 1_000_003 + self.room_generation * 7_919 + self.round_id) & 0xFFFFFFFF
        )
        self._action_sequence = 0
        self._projectile_sequence = 0
        self._effect_sequence = 0
        self._powerup_sequence = 0
        for slot, player in self.players.items():
            player.hp = MAX_HP
            player.ready = True
            player.clear_statuses()
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
        if command.at_ms < player.stunned_until_ms:
            return self._cast_reject(command, "stunned")
        if command.at_ms < player.cooldown_until_ms.get(command.spell, 0):
            return self._cast_reject(command, "cooldown")
        if rule.damage:
            if command.at_ms < player.offense_locked_until_ms:
                return self._cast_reject(command, "offense_locked")
        if rule.heal and player.hp == MAX_HP and not player.burn_until_ms:
            return self._cast_reject(command, "full_health")

        action_id = self._next_action_id()
        cooldown_ms = rule.cooldown_ms
        if command.at_ms < player.haste_until_ms:
            cooldown_ms //= 2
        player.cooldown_until_ms[command.spell] = command.at_ms + cooldown_ms

        self._event(
            "castAccepted",
            command.at_ms,
            actor=command.slot,
            spell=command.spell,
            action_id=action_id,
            effect_id=self._next_effect_id(),
        )
        self._claim_powerup(command.slot, command.at_ms)

        if command.spell is Spell.PROTEGO:
            player.shield_until_ms = command.at_ms + rule.shield_ms
            player.shield_raised_at_ms = command.at_ms
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
            cured = bool(player.burn_until_ms)
            player.burn_until_ms = 0
            player.burn_next_ms = 0
            self._event(
                "healed",
                command.at_ms,
                actor=command.slot,
                target=command.slot,
                spell=command.spell,
                action_id=action_id,
                effect_id=self._next_effect_id(),
                amount=amount,
                reason="cured" if cured else None,
            )
            return CommandDecision(
                command_id=command.command_id,
                command="cast",
                accepted=True,
                action_id=action_id,
            )

        projectile_id = self._next_projectile_id()
        target = OTHER_SLOT[command.slot]
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
            self._resolve_impact(projectile, at_ms)

    def _resolve_impact(self, projectile: Projectile, at_ms: int) -> None:
        target = self.players[projectile.target]
        caster = self.players[projectile.caster]
        rule = SPELL_RULES[projectile.spell]
        shielded = at_ms < target.shield_until_ms
        mirrored = at_ms < target.mirror_until_ms
        common: dict[str, Any] = dict(
            actor=projectile.caster,
            target=projectile.target,
            spell=projectile.spell,
            action_id=projectile.action_id,
            projectile_id=projectile.id,
        )
        if shielded and rule.breaks_shield and not projectile.reflected:
            # Expelliarmus shatters the guard and still disarms; no damage.
            target.shield_until_ms = 0
            self._event("shieldBroken", at_ms, effect_id=self._next_effect_id(), **common)
            self._apply_disarm(projectile, target, at_ms, common)
            return
        if shielded or mirrored:
            perfect = mirrored or (at_ms - target.shield_raised_at_ms <= PERFECT_BLOCK_MS)
            if mirrored:
                target.mirror_until_ms = 0
            else:
                target.shield_until_ms = 0
            if perfect:
                self._event(
                    "impactReflected", at_ms, effect_id=self._next_effect_id(),
                    reason="mirror" if mirrored else "perfect", **common,
                )
                reflected = Projectile(
                    id=self._next_projectile_id(),
                    action_id=projectile.action_id,
                    spell=projectile.spell,
                    caster=projectile.target,
                    target=projectile.caster,
                    launch_at_ms=at_ms,
                    impact_at_ms=at_ms + REFLECT_FLIGHT_MS,
                    damage=projectile.damage,
                    offense_lock_ms=projectile.offense_lock_ms,
                    reflected=True,
                )
                self.projectiles.append(reflected)
                self._event(
                    "projectileLaunched", at_ms, actor=reflected.caster, target=reflected.target,
                    spell=reflected.spell, action_id=reflected.action_id,
                    projectile_id=reflected.id, reason="reflected",
                )
            else:
                self._event("impactBlocked", at_ms, effect_id=self._next_effect_id(), **common)
            return

        critical = False
        if self.variance and projectile.damage:
            critical = caster.lucky or self._rng.randrange(100) < CRIT_CHANCE_PERCENT
            caster.lucky = False
        damage = projectile.damage
        if critical:
            damage = damage * CRIT_MULTIPLIER_PERCENT // 100
        amount = min(target.hp, damage)
        target.hp -= amount
        self._event(
            "damage", at_ms, effect_id=self._next_effect_id(), amount=amount,
            critical=critical, **common,
        )
        if target.hp == 0:
            return
        if projectile.offense_lock_ms:
            self._apply_disarm(projectile, target, at_ms, common)
        if rule.burn_ms and not projectile.reflected:
            fresh = not target.burn_until_ms
            target.burn_until_ms = max(target.burn_until_ms, at_ms + rule.burn_ms)
            if fresh:
                target.burn_next_ms = at_ms + BURN_TICK_MS
            self._event(
                "burning", at_ms, effect_id=self._next_effect_id(),
                amount=rule.burn_damage, **common,
            )
        if rule.stun_ms and self.variance and not projectile.reflected:
            if self._rng.randrange(100) < rule.stun_chance_percent:
                target.stunned_until_ms = max(target.stunned_until_ms, at_ms + rule.stun_ms)
                self._event(
                    "stunned", at_ms, effect_id=self._next_effect_id(),
                    amount=rule.stun_ms, **common,
                )

    def _apply_disarm(
        self, projectile: Projectile, target: CombatPlayer, at_ms: int, common: dict[str, Any]
    ) -> None:
        target.offense_locked_until_ms = max(
            target.offense_locked_until_ms,
            at_ms + projectile.offense_lock_ms,
        )
        self._event(
            "offenseLocked", at_ms, effect_id=self._next_effect_id(),
            amount=projectile.offense_lock_ms, **common,
        )

    def _resolve_burns_at(self, at_ms: int) -> None:
        for slot in (Slot.P1, Slot.P2):
            player = self.players.get(slot)
            if player is None or not player.burn_until_ms or player.burn_next_ms != at_ms:
                continue
            if player.hp > 0:
                amount = min(player.hp, SPELL_RULES[Spell.INCENDIO].burn_damage)
                player.hp -= amount
                self._event(
                    "burned", at_ms, actor=OTHER_SLOT[slot], target=slot, spell=Spell.INCENDIO,
                    effect_id=self._next_effect_id(), amount=amount,
                )
            if player.hp == 0 or at_ms + BURN_TICK_MS > player.burn_until_ms:
                player.burn_until_ms = 0
                player.burn_next_ms = 0
            else:
                player.burn_next_ms = at_ms + BURN_TICK_MS

    def _resolve_powerup_at(self, at_ms: int) -> None:
        if self.powerup is not None and self.powerup.expires_at_ms == at_ms:
            expired = self.powerup
            self.powerup = None
            self._event("powerupExpired", at_ms, powerup=expired.kind, reason=expired.id)
            self.powerup_spawn_at_ms = at_ms + self._rng.randint(*POWERUP_GAP_MS)
            return
        if self.powerup is None and self.powerup_spawn_at_ms == at_ms:
            if not self.variance:
                self.powerup_spawn_at_ms = None
                return
            kinds = [kind for kind, _ in POWERUP_WEIGHTS]
            weights = [weight for _, weight in POWERUP_WEIGHTS]
            kind = self._rng.choices(kinds, weights=weights, k=1)[0]
            self._powerup_sequence += 1
            self.powerup = Powerup(
                id=f"r{self.round_id}:u{self._powerup_sequence}",
                kind=kind,
                spawned_at_ms=at_ms,
                expires_at_ms=at_ms + POWERUP_LIFETIME_MS,
            )
            self.powerup_spawn_at_ms = None
            self._event(
                "powerupAppeared", at_ms, powerup=kind, reason=self.powerup.id,
                effect_id=self._next_effect_id(),
            )

    def _claim_powerup(self, slot: Slot, at_ms: int) -> None:
        powerup = self.powerup
        if powerup is None:
            return
        self.powerup = None
        self.powerup_spawn_at_ms = at_ms + self._rng.randint(*POWERUP_GAP_MS)
        player = self.players[slot]
        amount: int | None = None
        if powerup.kind is PowerupKind.PHOENIX:
            player.cooldown_until_ms.clear()
        elif powerup.kind is PowerupKind.BEZOAR:
            amount = min(BEZOAR_HEAL, MAX_HP - player.hp)
            player.hp += amount
            player.burn_until_ms = 0
            player.burn_next_ms = 0
            player.stunned_until_ms = 0
        elif powerup.kind is PowerupKind.FELIX:
            player.lucky = True
        elif powerup.kind is PowerupKind.MIRROR:
            player.mirror_until_ms = at_ms + MIRROR_MS
            amount = MIRROR_MS
        elif powerup.kind is PowerupKind.HASTE:
            player.haste_until_ms = at_ms + HASTE_MS
            player.cooldown_until_ms = {
                spell: at_ms + (deadline - at_ms) // 2 if deadline > at_ms else deadline
                for spell, deadline in player.cooldown_until_ms.items()
            }
            amount = HASTE_MS
        self._event(
            "powerupClaimed", at_ms, actor=slot, target=slot, powerup=powerup.kind,
            reason=powerup.id, amount=amount, effect_id=self._next_effect_id(),
        )
        if powerup.kind is PowerupKind.BEZOAR and amount:
            self._event(
                "healed", at_ms, actor=slot, target=slot, amount=amount,
                reason="bezoar", effect_id=self._next_effect_id(),
            )

    def _finish_knockout(self, at_ms: int) -> None:
        dead = [slot for slot, player in self.players.items() if player.hp == 0]
        if len(dead) == 2:
            self._finish(at_ms, Outcome.DRAW, None, "knockout")
        elif len(dead) == 1:
            winner = OTHER_SLOT[dead[0]]
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
        self.powerup = None
        self.powerup_spawn_at_ms = None
        for player in self.players.values():
            player.ready = False
            player.clear_statuses()
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
        critical: bool = False,
        powerup: PowerupKind | None = None,
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
            critical=critical,
            powerup=powerup,
        )
        self.recent_events.append(event)
        self._touch()
        return event

    def _touch(self) -> None:
        self.state_version += 1
