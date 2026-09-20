# Arcane Duel — Visual & Gameplay Design Brief

## 1. One-sentence pitch

**Arcane Duel** is a two-player motion-and-voice spellcasting game where each player holds a physical hacker badge like a wand, speaks an incantation, performs its matching movement, and watches an original chibi wizard reproduce that action in a spectacular real-time Three.js duel. The 1v1 duel is the only required Hackathon demo mode.

The experience is inspired by the immediate readability and satisfying battle feedback of creature-duel games, while using an entirely original fantasy world, characters, spell glyphs, and visual language.

## 2. What the judges should understand in ten seconds

Two people are standing with badges. One says a spell and makes a deliberate wand motion. On both laptops, their wizard performs the same motion, launches a vivid spell, and the other player physically raises their badge to create a shield. The shield catches the projectile in a bright, satisfying collision.

The magic is not selected from a menu: voice and motion are both required. That physical cause-and-effect is the product's signature moment.

## 3. Experience pillars

### Physical actions become readable fantasy actions

Every recognized gesture has a matching animated silhouette. A forward jab makes the wizard step forward and thrust their wand; a raised guard makes the wizard brace and lift a shield; a horizontal sweep produces a wide follow-through. The character animation begins immediately after recognition, then the server-confirmed spell effect follows. This gives the player instant embodiment without moving game authority to the client.

### High spectacle, low UI clutter

The arena and spell effects should feel rich: bloom, particles, glowing trails, runes, moving fog, light reflections, and small camera reactions. The heads-up display remains intentionally minimal—two health bars, a round state/countdown, and brief feedback such as **Spell ready** or **Stupefy recharging: 1.2 s**. Do not build a spell-card belt for the MVP.

### Defense must look heroic

The best live moment is not an attack landing. It is an incoming crimson bolt being visibly stopped by a cyan shield because the defending player correctly spoke and raised their real controller. Every visual choice should make that counterplay easy to see.

## 4. World and art direction

### Setting: The Mirrorfall Arena

The duel takes place on a circular floating stone platform suspended in a deep indigo night sky. Broken mirror frames, distant floating ruins, a moon, and drifting purple clouds surround the platform. Engraved floor runes emit a low continuous glow; they brighten and rotate slightly when a spell is cast.

Use a dark, cool environment so every spell colour reads instantly. The arena should be built from a small number of reusable low-poly meshes plus procedural atmosphere rather than large imported environments.

### Characters

Use two original apprentice-wizard characters in a stylized 3D chibi / low-poly form: oversized hats, short cloaks, clear staffs or wands, large expressive silhouettes. Each player chooses a colour identity at room setup (for example crimson and azure), but spell colours remain consistent across both players so their meaning never changes.

Required animation states:

- `idle`: small breathing motion, cloak sway, faint wand glow
- `jabCast`: step forward and thrust the wand
- `guard`: turn slightly sideways and raise wand/arm
- `sweepCast`: planted feet, wide lateral wand swing
- `hit`: brief recoil and magical spark burst
- `win`: wand raised, runes flare upward

The MVP does not need facial animation, custom character creation, or complex skeletal simulation. Clear poses matter much more than fidelity.

### Shared palette

| Purpose | Colour family | Meaning |
| --- | --- | --- |
| Arena | indigo, violet, midnight blue | calm magical space that makes effects pop |
| Attack | crimson/red | direct damage and threat |
| Defense | cyan/ice blue | shield and successful block |
| Control | gold/amber | disruption, lockout, restraint |
| Fire | orange/coral | burn and persistent damage |
| Ultimate | silver-white | rare, protective, cinematic magic |

## 5. Game flow

### A. Setup and practice

1. Each player connects their selected physical controller and grants microphone/camera permission.
2. The game shows one simple illustrated cue at a time: jab, guard, then sweep.
3. The player says the spell and repeats the movement until the system shows a concise success pulse.
4. Once both players are ready, the arena fades in, a three-second countdown begins, and the music rises.

### B. Active duel

1. The player speaks an exact incantation and performs its compatible motion.
2. The browser validates fresh voice-and-motion evidence and sends one cast request.
3. On server acceptance, both clients schedule the same action from the authoritative event time.
4. The casting wizard plays a readable animation; the arena rune flashes in the spell colour; a projectile or shield appears.
5. At the scheduled impact time, the server resolves damage, shield state, lockout, and winner state.
6. Both clients show the same hit/block reaction, health change, and short event cue.

### C. Result

At 0 health or after the 60-second round timer, the winning character receives a restrained win pose. The arena brightens, particles drift upward, and the UI offers **Rematch**. No progression, inventory, or account system is needed.

## 6. Core spell roster and visual behavior

The visual system should support all future spells, but the first playable demo should prove only the most reliable four. More spells may appear only after their physical-recognition paths are stable.

| Priority | Spell | Physical input | Combat effect | Visual sequence | Cooldown feedback |
| --- | --- | --- | --- | --- | --- |
| Core | Stupefy | forward jab | 20 damage; 2.0 s flight | wand tip flash → crimson bolt with bright trail → impact sparks and target recoil | wand tip’s red glow dims, then returns with a quick red pulse |
| Core | Protego | raise and briefly hold guard | 1.2 s shield; blocks one projectile | cyan curved barrier blooms from the floor → moving rune rim → large ripple at impact | shield runes contract into the wand and slowly relight |
| Core | Expelliarmus | horizontal sweep | 10 damage + 1.0 s offensive lockout | gold-red ribbon follows the swing → impacts in a spiralling shockwave | small gold broken-rune cue fades until ready |
| Core/Stretch | Incendio | upward snap | 8 initial damage + burn ticks | orange flame helix rises from wand → ember trail → target briefly surrounded by embers | embers at wand tip extinguish, then reignite |
| Stretch | Petrificus Totalus | downward chop | short full-cast lockout | amber geometric bindings rise from the ground | gold sealing ring completes around the wand |
| Stretch | Reducto | sharp pull-back | 35 damage; long, defendable warning | purple-red orb compresses behind caster → slow unstable projectile → large fracture burst | wand core remains dark while recharging |
| Stretch | Expecto Patronum | full circle | long, unbreakable barrier | silver-white rings draw in the air → abstract guardian spirit silhouette → vast dome barrier | moon-like ring refills over 15 seconds |

## 7. Cooldown treatment without a spell bar

Cooldown should be felt through the world and character, not a row of cards.

- **On cast:** briefly show the spell name and cooldown in a small, elegant floating cue near the caster: `STUPEFY · 2.0 s`.
- **While unavailable:** the spell's colour drains from the wand tip. If a player repeats that gesture too early, show a quiet grey rune near the wand and a one-line reason: `Stupefy recharging`.
- **When ready:** the wand tip gives a single coloured glint. For long cooldowns, use a subtle circular rune at the caster's feet that slowly completes.
- **On the physical badge:** match only the most important confirmed event with the same colour pulse; do not duplicate the whole visual effect on the badge.

This retains a luxurious magical feeling while avoiding a time-consuming HUD implementation.

## 8. Three.js visual implementation strategy

### Layering

1. **Arena layer:** low-poly platform, rune texture/decal, floating fragments, mirror frames, sky gradient, fog planes.
2. **Character layer:** two low-poly models with a small animation state machine.
3. **Spell layer:** pooled meshes/particles for projectiles, trails, shields, impact bursts, ribbon splines, and rings.
4. **Presentation layer:** bloom, restrained screen shake, camera push at impact, directional lights keyed to spell colour.
5. **DOM UI layer:** health bars, countdown, round state, feedback text, camera preview.

### Effects worth building first

- Stupefy bolt: emissive sphere/capsule, trail points, additive sparks, impact burst.
- Protego: transparent curved shield or hemisphere, Fresnel-style bright edge, shader/texture ripple, floor rune.
- Shared impact system: particle burst, small point-light flash, 80–120 ms camera shake, character recoil.
- Arena reaction: one emissive rune ring that expands whenever an accepted spell launches.

Avoid cinematic post-processing stacks, live video texture mapping, hand tracking, or unique assets per spell until the core two-spell loop is reliable. Use instanced or pooled particles and cap device pixel ratio to preserve a stable demo frame rate.

## 9. Minimal screen composition

The central 70–80% of the screen is the arena. Player A's character occupies the left side, Player B's character the right side. Their health bars sit near the top corners. A small opponent webcam/magic-mirror window can sit unobtrusively at the lower corner, with an optional tiny local preview. During play, no diagnostics are visible unless input fails.

## 10. Scope decisions

### Must ship

- Two connected players, voice plus physical motion required
- Stupefy and Protego, including combat resolution and cooldowns
- Two characters with idle, cast, guard, hit, and win states
- Floating arena, projectile, shield, impact particles, health bars, and countdown
- A reliable demo path: cast → defend → block → rematch

### Nice to have after the core loop

- Expelliarmus and Incendio
- richer arena fog, lanterns, mirror frames, and custom sound effects
- character colour selection and final result animation

### Future multiplayer extensions — not part of this Hackathon build

The room and combat-event model may keep a generic player identifier so the game can grow later, but no additional mode must be implemented, tested, or presented for this demo.

| Future mode | Later design direction | Why it is deferred |
| --- | --- | --- |
| 1v1v1 free-for-all | Three wizards at the points of a triangular arena; target ring indicates the current enemy | Needs multi-target selection, three-player UI, and elimination/spectating rules |
| 2v2 team clash | Two team-coloured spawn circles per side; friendly-fire protection | Needs team assignment, teammate/enemy targeting, and team win rules |
| 2 vs boss | Two wizards cooperate against a large telegraphed enemy | Needs boss AI, attack patterns, balancing, and additional art/animation |

The 1v1 visual composition should still be designed so the arena can expand later: player positions are data-driven, spell effects receive an explicit target ID, and health bars are generated from a player list. These are implementation boundaries, not a reason to spend time on future modes.

### Explicitly out of scope

- spell-card HUD, inventory, accounts, progression, loadouts
- camera-based hit detection or hand tracking
- seven fully tuned gestures, large imported environment assets, cinematic cutscenes
- 1v1v1, 2v2, and boss mode logic, targeting, UI, balancing, or AI

## 11. Success criteria

The design succeeds if an observer can correctly say: “they said the spell, moved the badge, and the wizard on screen did it,” and can see an attack be physically countered with a shield. The scene should feel memorable and magical while still running smoothly and leaving enough hackathon time for the input system—the part that makes the project special.
