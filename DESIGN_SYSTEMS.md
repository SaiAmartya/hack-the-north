# Wizarding Workshop Design System

**Status:** visual and interaction contract for the battle platform. It changes presentation, not mechanics, runtime state, evidence standards or implementation status.

**Applies to:** setup, Device Lab, calibration, practice, room entry and future duel UI. The current implemented boundary and open human gates remain in [the Slice 0–1 checkpoint](docs/qa/device-lab-stage-1.md).

## 1. Product character

The setup experience is an original **Wizarding Workshop**: a friendly academy workbench that teaches one concrete action at a time, celebrates verified progress and keeps technical evidence legible.

It combines the clarity and warmth of a modern language-learning lesson with an original storybook magic vocabulary. It must not copy another product's mascot, layouts, illustrations, sounds, logos or reward systems.

The experience should feel approachable before clever, playful before ornate, truthful before celebratory and handcrafted without becoming difficult to scan. Magic comes from clear input response, not hidden diagnostics.

Use two related presentation modes:

1. **Wizarding Workshop** is warm, bright and card-based. Use it for setup, Device Lab, calibration and practice.
2. **Enchanted Mirror** is dark, cinematic and video-first. Use it only for countdown, duel and result moments.

Do not turn Device Lab into a fantasy dashboard or the duel into a bright lesson page. Shared colors, spell glyphs, copy voice and status semantics make the modes feel like one product.

## 2. Foundation tokens

### Color

| Token | Value | Use |
| --- | --- | --- |
| `canvas-workshop` | `#f7f5ed` | Warm parchment page background |
| `surface-card` | `#fffefa` | Cards, inputs and raised controls |
| `ink-primary` | `#252641` | Body text, headings and strong borders |
| `action-primary` | `#7054cf` | Primary actions, active steps and focus accents |
| `action-base` | `#4c3796` | Button bottom edge, pressed state and strong purple text |
| `hero-gold-pale` | `#fff0bf` | Welcome and instruction hero background |
| `accent-gold` | `#ffc857` | Stars, achievement accents and selected glyph details |
| `status-healthy` | `#167363` | Connected, healthy and verified states |
| `status-healthy-pale` | `#e6f5ee` | Healthy status fills |
| `status-error` | `#b33a40` | Fault, destructive action and invalid evidence |
| `status-error-pale` | `#fff0ed` | Fault and warning fills |

Reserve teal for a state that is actually healthy or verified. Reserve coral for actionable faults, invalid input and destructive actions. Purple means action or current focus; gold means emphasis or delight, never health.

Use navy text on pale surfaces. When purple, teal or coral is used as a fill, verify text contrast and prefer white or navy according to the measured result. Never communicate status by color alone.

The Enchanted Mirror may add near-black `#05070d`, ivory `#f4e7c5` and brass `#c59b5a` around video. Its status colors retain exactly the Workshop meanings.

### Typography

Use only this local stack:

`ui-rounded, "SF Pro Rounded", "Trebuchet MS", system-ui, sans-serif`

Do not load external fonts. Use weight, size and spacing—not a decorative typeface—to create character.

| Role | Suggested size/line height | Treatment |
| --- | --- | --- |
| Page title | `clamp(2rem, 5vw, 3.75rem)` / `1.02` | 800, tight tracking, short line |
| Section title | `1.5rem` / `1.2` | 800 |
| Card title | `1.125rem` / `1.3` | 800 |
| Body | `1rem` / `1.55` | 500–600 |
| Label | `0.875rem` / `1.35` | 700 |
| Diagnostic | `0.8125rem` / `1.45` | 600; values may use local monospace |

Sentence case is the default. Short source labels such as `REPLAY` and `REAL BLE` may remain uppercase because they carry evidence meaning. Avoid all-caps decorative paragraphs and excessive letter spacing. Diagnostic, status and helper text must never render below 12 px.

### Shape, depth and spacing

- Page sections use an 8 px spacing rhythm, with 24–32 px gaps between major groups.
- Primary cards use 18–24 px radii, a 2 px warm-stone border and a 4 px solid warm-stone bottom shadow. Use navy or semantic borders only on controls and states that need stronger contrast.
- Buttons and compact controls use 14 px radii, a 2 px border and a 4 px solid bottom edge.
- Every interactive control is at least 44 × 44 px.
- Pressed controls translate down up to 2 px while their bottom edge compresses; layout must not jump.
- Use solid, readable separation. Avoid glass blur, hairline gray borders and diffuse dashboard shadows.
- Keep decorative sparkles sparse and away from labels, plots and live values.

## 3. Workshop page hierarchy

The page is a guided practice workbench, not a dense operations console.

Order the experience as:

1. compact product header and explicit build/source label;
2. pale-gold orientation hero with one sentence about the current goal;
3. truthful implementation notice describing what is and is not available;
4. numbered workbench steps in the order a person should perform them;
5. advanced diagnostics after the primary action, not before it;
6. a small next-gate footer with no promise that the gate has passed.

On wide screens, the current task and its evidence may form a two-column workbench. Reading order in the DOM must remain task first, evidence second. On narrow screens, use one column in that same order.

Keep diagnostic labels and all existing test controls explicit. Visual grouping may improve comprehension, but it must not rename replay as training, turn a trace trigger into a spell button or imply that unbuilt speech, casting, phone pairing, multiplayer or real hardware works.

## 4. Components

### Header

Use **Wand Duel** as the product wordmark with a small original star glyph. Name **The Workshop** and the current lesson in navigation or breadcrumbs; Wizarding Workshop is the experience direction, not a replacement product name. Show the current environment or stage as a bordered pill. Keep the header compact; it is orientation, not navigation theater.

### Orientation hero

- Use the pale-gold surface, navy copy and one original hand-drawn SVG familiar.
- The familiar is a tiny star-wizard guide: an asymmetric five-point star, simple hat and wand, loose imperfect strokes and no animal mascot silhouette.
- Keep SVG inline or repository-local, decorative where appropriate and excluded from accessibility output when it conveys no information.
- One headline, one explanatory sentence and at most one relevant primary action belong here.

### Step card

- Number each real task: connect, observe, test feedback, rehearse failure.
- Lead with a plain instruction, then place controls, current state and evidence.
- Cards may be complete only when runtime evidence establishes completion; do not pre-fill checkmarks.
- Advanced metrics may be visually quieter but must remain available and readable.

### Buttons

| State | Presentation |
| --- | --- |
| Default primary | Purple fill, white label, darker-purple bottom edge |
| Hover | Slightly darker fill; no size change |
| Pressed | 2 px downward movement and reduced bottom edge |
| Focus | High-contrast 3 px outline with at least 2 px offset |
| Disabled | Muted surface and border, readable label, `not-allowed`; not opacity alone |
| Destructive | Coral border/fill with explicit verb |
| Secondary | White card, navy label and warm-stone border/bottom edge; strengthen semantically when needed |

Replay trace and fault-injection controls stay secondary and say exactly what they inject. “Test cue (not a cast)” and equivalent evidence qualifiers remain visible.

### Inputs

- Labels always sit outside the control; placeholders are examples, not labels.
- Use white surfaces, 2 px warm-stone borders, 14 px radii and 44 px minimum height. Apply navy, purple or semantic borders only when focus, contrast or state needs them.
- Put help and error text immediately after its field and connect it semantically.
- A browser permission, chooser or connection attempt is never shown as success until the corresponding runtime state confirms it.

### Status and notices

- Healthy uses teal plus a check or explicit word such as “Connected.”
- Pending uses neutral navy/purple plus “Not checked,” “Connecting” or “Pending.”
- Fault uses coral plus a short cause and a recovery action when one exists.
- Simulator and surrogate labels remain persistent evidence badges, not dismissible decoration.
- The implementation notice names unavailable systems in direct language.

### Diagnostics and plots

- Preserve exact units, source, age, loss, uncertainty and generation labels.
- A dark navy instrument panel is allowed inside the bright Workshop for a live signal plot or device preview. Keep it bounded within a light card, provide a visible zero line and written legend, and meet contrast requirements; ordinary content surfaces stay white or pale.
- Axis colors need text labels or distinct line patterns; color alone is insufficient.
- Numeric columns use tabular figures or local monospace and must not jitter as values update.
- Live updates should not steal focus or cause screen readers to announce every sample.

### Progress and celebration

Show progress only for a finite, observable flow such as calibration examples collected or a real countdown. The current numbered Workshop path is neutral wayfinding: numbers communicate sequence, and a selected treatment communicates the user's present section—not completion or a passed gate. Do not add XP, streaks, ranks, house points, locked lessons or completion percentages that the runtime does not own.

Celebrate verified milestones with a brief star pop, warm copy or checked step. Never celebrate a button click as a successful connection, recognized spell or passed gate.

## 5. Copy system

Use friendly coaching with precise evidence language:

- “Connect your practice wand.”
- “Try a short jab trace.”
- “Replay connected. Real badge not tested.”
- “The signal paused for 600 ms, so this attempt was cleared.”
- “Next lesson: local speech. Not available in this build.”

Prefer action + reason + recovery. Keep magical nouns in headings and plain technical nouns in diagnostics.

Avoid faux-medieval prose, threatening error messages, unexplained abbreviations and claims such as “mastered,” “battle ready” or “spell accepted” unless the corresponding system actually proved them.

## 6. Motion and feedback

- Use 120–220 ms transitions for hover, press, card reveal and status changes.
- One small overshoot is acceptable for verified success; faults should not bounce.
- Never animate live numbers spatially or make the page depend on animation to explain state.
- Avoid strobe, rapid repeated flashes, parallax and cursor-following decoration.
- Under `prefers-reduced-motion: reduce`, remove nonessential translation, scale, particle and familiar motion; retain immediate state changes and server-timed combat readability.
- Sound is optional, muted independently and always paired with a visible result.

## 7. Responsive and accessible behavior

- Desktop content width is about 1200 px with comfortable page gutters.
- Collapse two columns below the point where either card would be narrower than about 340 px; do not key layout only to a named device.
- At phone widths, use 16–18 px gutters, full-width primary actions and stacked button groups.
- Diagnostic tables may wrap label/value pairs or scroll inside a clearly labelled region; the page itself must not scroll horizontally.
- Do not hide evidence, warnings or test controls to make the mobile layout cleaner.
- Maintain logical heading levels, landmarks, persistent labels and keyboard order.
- Provide a visible focus state, `aria-live` only for bounded state changes, and `role="alert"` only for actionable faults.
- Target WCAG 2.2 AA contrast and interaction behavior. Test at 200% zoom and with keyboard-only navigation.

## 8. Enchanted Mirror duel mode

The duel remains a dark, video-first **Enchanted Mirror**, not a darkened copy of the Workshop page.

- Opponent video is the dominant surface; bright cards must never block the opponent.
- Use compact translucent/navy HUD surfaces only where contrast needs support.
- Reuse the same original spell glyphs, rounded type, purple action, gold accent, teal healthy and coral fault semantics.
- Use the Workshop's friendly voice for Ready, recovery and results, but reduce coaching during play.
- Keep health, cooldowns, source integrity and time-critical defense cues visible without opening panels.
- Diagnostics remain in setup/practice. The duel may show a concise fault or source-loss state, not a metrics dashboard.

Three.js effects, server timing, fixed anchors and performance budgets remain defined by [the implementation plan](IMPLEMENTATION-PLAN.md#37-visual-and-audio-specification). This design system does not add tracking, a 3D world, avatars, physics or new combat mechanics.

## 9. Originality and asset rules

- Use original hand-authored SVG glyphs, simple CSS shapes and procedural Three.js effects.
- Do not use Hogwarts crests, house marks, film typography, character likenesses, franchise logos, copied spell icons, Duo artwork or another product's mascot.
- Do not add network-fetched images, fonts, icon kits or generated-art runtime dependencies.
- If public-facing naming must be safer, preserve the mechanics while using original generic wizard-academy names; presentation is not a dependency on protected brand assets.

## 10. Review checklist

- the correct Workshop or Mirror mode is used;
- every status remains source- and evidence-true;
- unavailable features are still identified as unavailable;
- all controls retain their existing mechanical meaning;
- 44 px targets, focus, keyboard order, contrast and reduced motion work;
- desktop and narrow layouts preserve the task order and diagnostics;
- no external asset request or third-party visual imitation was introduced;
- the duel keeps opponent video dominant;
- the change does not modify runtime gates, test claims or game rules.
