# Wandduel design system

The product is a game, not a development dashboard. A friendly wizard-school setup leads into a cinematic, video-first duel. Keep the clarity and tactile warmth of a language-learning app, with original magical artwork—not another product's mascot or franchise assets.

## Player experience

One task per screen: **Connect wand → microphone → illustrated grip → Start calibration → visible stillness → three jabs → three guards → cast each spell → Ready → duel → rematch.** Calibration never starts behind microphone setup.

Supported choices are Bluetooth badge and iPhone. Both are physical inputs; synthetic replay is never a third way to play.

- **Connect badge** opens Chrome's chooser directly from the click; **Connect iPhone** shows one QR code, followed by a matching-number confirmation. QR URLs contain only the public rendezvous ID, never bearer capabilities. The optional LAN setup uses a short pairing code. Keep the phone screen focused on motion permission, connection and feedback.
- Short heading, one primary action, optional necessary secondary action. No promotional hero paragraphs, sidebar, feature inventory, implementation notice or explanatory footer.
- No “virtual transport,” simulated wand, replay, packet, clock, stage or firmware-engineering terminology in the player UI.
- Coaching is brief and physical: “Hold your wand still,” “Three gentle jabs,” “Raise. Tilt. Hold.” Success appears only after observed input.
- Show one actionable fault at a time. Device/profile incompatibility is a setup failure, never a cosmetic warning permitting play.
- The phone has two essential, expiring player indicators: **Sensor active** (fresh finite acceleration) and **Reaching laptop** (laptop-confirmed accepted input). A small acceleration-responsive orb and synchronized coaching/example dots make movement visible. Optional **Connection details** reveals observed/received rate, age and last issue, with an explicit sanitized trace download. These are necessary input feedback, not a general debugging dashboard; no gyro claim.
- **Reset grip** restarts visible stillness without disconnecting. Show one actionable retry hint and the current movement stage, never a silent 0/3. A diagnostic badge offers **Use iPhone**, not a futile reconnect loop. Direct Wi-Fi failure offers **Use internet connection** explicitly; never switch routes during a round.
- Recommend a comfortable sideways/slightly diagonal grip with an angled illustration. Other consistent grips are valid; never demand portrait, screen-facing or top-edge-up. Coach return to the learned starting grip, not an absolute device axis. Screen rotation must not interrupt play.
- Keep test routes behind `VITE_WAND_QA=1`; they are never linked from the game and are excluded from the default production bundle. Automated replay remains a regression tool, not a player feature.

## Visual foundations

| Element | Treatment |
| --- | --- |
| Setup canvas | Warm paper `#f8f6ee`, generous empty space |
| Primary ink | Deep plum `#29243d` |
| Primary action | Violet `#7655d3`, darker solid bottom edge `#533a9b` |
| Secondary surface | Ivory `#fffefb`, pale violet border |
| Accent | Warm brass `#bf8b32`, sparse original stars |
| Success | Muted teal, accompanied by a check or text |
| Fault | Coral on pale coral, plain recovery copy |
| Duel | Near-black `#15121f`, ivory type, restrained brass frame |
| Spells | Crimson/white Stupefy, cyan/violet Protego, conditional gold/scarlet Expelliarmus |

Use local rounded/system fonts only. Headings 25–34 px; body/control text 14–18 px. Buttons have 17 px corners, a 2 px border, a 4 px pressed edge and at least 44 px targets. Use a visible 3 px focus outline. Inputs have persistent labels.

Author artwork in local SVG/CSS/Three.js. The wand illustration, lightning glyph, shield glyph and brass corners are original, simple shapes. No external font/image requests, copied crests, movie typography, mascots or asset service dependencies.

## Duel composition

The opponent video fills the arena. Overlay a transparent Three.js effects canvas and a readable DOM HUD:

- opponent health top-centre; round clock top-left;
- own health bottom-left; spell cooldown glyphs bottom-centre;
- small mirrored self-preview bottom-right;
- brief confirmed shield/hit/result labels, no metrics wall.

Spell glyphs are informational, **not clickable cast buttons**. Casting requires movement and spoken incantation. All health, launches, shielding and results follow the authoritative referee; local detection never pretends a hit occurred.

Use hand-authored emissive cores, curved ribbon trails, a translucent shield rim and confirmed impact ripples. No scene lighting, shadow maps, physics, video textures, bloom or postprocessing. Pool resources. Seek late events to server time; do not restart duplicate effects or replay old explosions from snapshots. Expired shields must immediately stop appearing protective.

## Motion, access and performance

Transitions last roughly 120–220 ms; small tactile presses, no layout jumps. Respect reduced-motion preferences and provide visible labels for time-critical events. Sound is optional and starts muted; never put spoken incantations in effects.

Normal rendering caps at 1920×1080, low at 1280×720. Select quality before play. Test desktop, narrow screens, keyboard focus, 200% zoom, readable health/cooldowns, and renderer resource stability. Preserve face/HUD readability over decoration.

## Review rule

Keep engineering detail in script-driven QA, except the optional bounded input details above. Never hide a real gameplay failure to make the screen cleaner. A paused phone requires a foreground Resume tap; recovery clears interrupted examples/casts and requires a fresh Ready. Hardware qualification, acoustic accuracy and measured performance remain explicit reports outside the game.
