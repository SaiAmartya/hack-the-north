# On-device gesture recognition

The badge has a 3-axis accelerometer (milli-g, cached at 50 Hz) and no gyroscope, so the
app never tries to reconstruct a drawn shape. It turns motion into a short symbol string and
matches it with edit distance. Everything runs inside the 20 ms `on_tick` budget.

## Pipeline (`gest_tick` in `main.lua`)

1. **Gravity estimate.** A slow low-pass filter (alpha 0.08 idle, 0.02 while channeling)
   tracks gravity; subtracting it leaves linear acceleration.
2. **Peak detection with hysteresis.** While A is held, the dominant axis of linear
   acceleration is watched. When its magnitude crosses 450 mg the app starts tracking a peak;
   when it falls back under 250 mg the peak's signed axis is emitted as one symbol
   (`+X -X +Y -Y +Z -Z`). At most 8 symbols per cast.
3. **Release A to cast.** The symbols are matched against every spell's template with
   Levenshtein distance. A template of length n tolerates `max(1, floor(n/2))` edits; ties go to
   the template that starts with the same symbol.
4. **Feedback.** The recognized string and result are shown for 2.5 s (`+Y -Y = LIGHTNING`,
   or `+Z +Z +Z = ?`), which is how players learn the vocabulary in a minute.

A physical flick produces an acceleration peak followed by a deceleration peak, so the default
templates are pairs:

| Spell | Default template | Motion |
|---|---|---|
| Lightning | `+Y -Y` | flick up |
| Fireball | `-Z +Z` | push forward |
| Ward | `-Y +Y` | flick down |
| Vortex | `+X +Y -X -Y` | circle |
| Heal | `-X +X` | flick left |
| Phase | `+X -X` | flick right |
| Jab | `badge.sensor.tap()` | tap the badge (melee, must be close) |
| Burst | `badge.sensor.shake()` | shake (area, must be close) |
| Ward | `orientation() == "flat_down"` for 0.4 s | screen face-down |

Axis signs depend on how the badge is held; that is what calibration is for.

## Charge

Charge = quarter seconds A was held, 1..6. Damage is multiplied by `0.8 + 0.1 × charge`.
The six LEDs fill clockwise from the upper left as you hold.

## Teach a spell (personal calibration)

START menu > *Teach a spell*: pick a spell with LEFT/RIGHT, draw it three times. The app
keeps the medoid attempt (the one closest to the other two by edit distance) and stores it in
`badge.store` under `g_<spell>` (six keys). Templates load at startup; START inside the Teach
screen restores the default. The simulator test `test_teach_spell_persists_and_is_recognized`
re-opens the app and casts with the taught gesture.

## Button fallback (always on)

While holding A, UP = Lightning, B = Fireball, DOWN = Ward, START = Vortex, LEFT = Heal,
RIGHT = Phase. Release A to cast. A badge without a working accelerometer says
`no accel: hold A + button` and still plays.

## Tuning

`ENTER_MG`, `EXIT_MG` (peak hysteresis) and the template tolerance live at the top of
`main.lua`. The simulator's `World.gesture()` plays synthetic impulses (900 mg, 120 ms, 80 ms
rest); use `phantom-sim`-style scripts or the tests to check a change before pushing.
