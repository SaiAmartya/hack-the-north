# Wandduel design system

An original 16-bit wizard duel with the clear diagonal composition of a handheld creature-battle RPG. Pixel characters and a moonlit castle courtyard are the game; technical tools stay in scripts or gated QA routes.

## Player flow

**Pair wand → Start a duel or join with code → Ready → Battle → Result → Rematch.**

The homepage offers Connect badge and Connect iPhone before any duel is created or any join code is requested. Pairing persists through room selection and rematches. No calibration or practice gate. The microphone starts after pairing; Ready requires fresh wand input and a healthy local microphone. Both badge and iPhone remain supported. Synthetic input is QA only.

Phone pairing uses a public QR and matching-number confirmation, or the optional trusted LAN code. Bearer capabilities never appear in URLs. The phone remains focused on permission, fresh movement, connection and expiring feedback. Failed direct connection offers an explicit internet fallback. No automatic route switch in a round.

## Visual direction

Original crisp pixel art, warm parchment, deep ink, burgundy player robes, teal rival robes, brass accents and an indigo moonlit courtyard. Local assets and system fonts only. Never copy franchise characters, crests or screenshots into the product.

The homepage is a quiet split composition: one title and two wand choices beside a pixel courtyard vignette. No tagline, numbered steps, progress strip or decorative captions. Setup surfaces are warm parchment with squared double borders and hard offset shadows. Typography combines a local serif display face with a readable system monospace for the battle HUD. Keep prose short and controls at least 44 px high with visible keyboard focus.

## Battle composition

- Back-facing player wizard stands lower-left; front-facing rival stands upper-right.
- Rival HP panel upper-left; own HP panel lower-right. Numeric health accompanies a bar.
- The clock and round appear in a compact arena heading.
- Five non-clickable spell cards show names, damage/healing/effect and each cooldown. Always show the gesture; voice selects the spell. No global cooldown.
- A short battle message reflects authoritative casts, blocks, hits, healing and result. Both players see the same server outcome from their own perspective.
- Shield, disarm, healing and impact feedback target the correct sprite. Optional camera portraits stay secondary.
- At 0 HP, show clear Victory or Defeat, both final HP values, and Rematch. Aborts and timed draws have distinct wording. Retain pairing while recovering.

The authoritative referee owns all health, shields, projectiles, cooldowns and results. Never preview an unconfirmed hit. Late snapshots restore current state without replaying completed effects.

## Access and performance

Respect reduced motion; convey critical effects with text as well as color. No fast flashing. Layout must work at desktop, narrow viewports and 200% zoom without horizontal scrolling. Use local assets, bounded effects and pooled Three.js resources. Rendering caps at 1920×1080; the internal low-quality renderer used by QA caps at 1280×720. Camera is optional and never required for a pixel duel.

Switching away pauses input and aborts an active round. Return validates fresh input and requires a new Ready. A phone that was backgrounded requires a foreground Resume tap. Recovery explains one actionable problem at a time and must not make players choose the same wand again unnecessarily.
