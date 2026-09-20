# Wandduel design system

An original 16-bit wizard duel with the clear diagonal composition of a handheld creature-battle RPG. Pixel characters and a moonlit castle courtyard are the game; technical tools stay in scripts or gated QA routes.

## Player flow

**Pair wand → Tutorial, duel a bot, start a duel or join with code → Ready → Battle → Result → Rematch.**

The homepage offers Connect badge and Connect iPhone before any duel is created or any join code is requested. Pairing persists through room selection and rematches. No calibration or practice gate. The microphone starts after pairing; Ready requires fresh wand input and a healthy local microphone. Both badge and iPhone remain supported. Synthetic input is QA only.

Solo uses the same arena and rules against Practice Wizard, a paced server-owned opponent. It hides invitation controls. Human input still requires the paired wand and local speech. Ready and Rematch start without another player; leaving retains the wand. The game has no webcam feature; iPhone WebRTC carries motion data only.

Tutorial sits immediately below Duel a bot. Its five lessons pause between confirmed spell effects, show a small original vector gesture demonstration, and finish with a 30-second free duel. Guidance uses the server's spell stats and keeps both HP panels visible. Speech and gesture overlap; the tutorial does not infer success from an instruction button.

Dev mode is an explicit, default-off switch at the homepage's bottom right. It retains wand pairing but permits spell-card clicks without microphone readiness. Those clicks obey the same referee rules and are labeled in a local diagnostic log under the battle. The log includes raw received wand data, classification/fusion outcomes and raw transcription text; no microphone audio or credentials. Keep capture bounded, export on request, and render only a short recent window. Ordinary play has no diagnostic panel or clickable spells. Motion-only casting was explicitly withdrawn.

After pairing in Dev mode, a collapsed gesture-trial recorder can capture ten labelled attempts before entering a duel. Failed recognition is useful data and must still be recorded. Keep recordings local, bounded and explicitly exported; mark interruptions rather than inventing completed trials.

Phone pairing uses a public QR and matching-number confirmation, or the optional trusted LAN code. Bearer capabilities never appear in URLs. The phone remains focused on permission, fresh movement, connection and expiring feedback. Failed direct connection offers an explicit internet fallback. No automatic route switch in a round.

## Visual direction

Original crisp pixel art, warm parchment, deep ink, burgundy player robes, teal rival robes, brass accents and an indigo moonlit courtyard. Local assets and system fonts only. Never copy franchise characters, crests or screenshots into the product.

The homepage is a quiet split composition: one title and two wand choices beside a pixel courtyard vignette. No tagline, numbered steps, progress strip or decorative captions. Setup surfaces are warm parchment with squared double borders and hard offset shadows. Typography combines a local serif display face with a readable system monospace for the battle HUD. Keep prose short and controls at least 44 px high with visible keyboard focus.

## Battle composition

- Back-facing player wizard stands lower-left; front-facing rival stands upper-right.
- Own HP panel upper-left above the player's wizard; rival HP panel lower-right beneath the opponent. Show the player name, HP bar and numeric health, with a status only when active. No Wizard or Duelist captions.
- The clock and round appear in a compact arena heading.
- Five spell cards show names, damage/healing/effect and each cooldown. Always show the gesture; voice selects the spell in ordinary play. Only Dev mode makes them cast buttons. No global cooldown.
- A short battle message reflects authoritative casts, blocks, hits, healing and result. Both players see the same server outcome from their own perspective.
- Shield, disarm, healing and impact feedback target the correct sprite.
- A recognized incantation with a failed gesture match may fizzle near the local wand, with one short yellow corrective message. The fizzle has no health or cooldown effect and never previews a hit on the opponent. Silence, discarded speech and stale input do not create spell animations.
- At 0 HP, show clear Victory or Defeat, both final HP values, and Rematch. Aborts and timed draws have distinct wording. Retain pairing while recovering.

The authoritative referee owns all health, shields, projectiles, cooldowns and results. Never preview an unconfirmed hit. Late snapshots restore current state without replaying completed effects.

## Access and performance

Respect reduced motion; convey critical effects with text as well as color. No fast flashing. Layout must work at desktop, narrow viewports and 200% zoom without horizontal scrolling. Use local assets, bounded effects and pooled Three.js resources. Rendering caps at 1920×1080; the internal low-quality renderer used by QA caps at 1280×720.

Switching away pauses input and aborts an active round. Return validates fresh input and requires a new Ready. A phone that was backgrounded requires a foreground Resume tap. Recovery explains one actionable problem at a time and must not make players choose the same wand again unnecessarily.
