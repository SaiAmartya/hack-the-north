# Tutorial duel referee

The tutorial uses a private `mode: "tutorial"` reservation, the ordinary player connection, and the existing `DuelEngine`. The tutorial opponent has no token or socket. Duel and solo rules are unchanged.

## Contract

Every snapshot includes `tutorial`; ordinary duel/solo snapshots use `null`. Tutorial snapshots use:

```json
{"step":0,"spell":"stupefy","stage":"instruction","paused":true}
```

`step` is 0–5, `spell` is nullable, and `stage` is `instruction`, `practice`, `complete`, or `free`. The lesson order is Stupefy, Protego, Episkey, Expelliarmus, Incendio, then the free duel. Send `{v:1,type:"tutorialContinue",roundId,step}` to open an instruction or move from a completed lesson to the next instruction. The response is an ordinary acknowledgement with command `tutorialContinue`. It validates the authenticated session, recent healthy input, live round, and matching step. Clicking Continue during practice cannot advance a lesson.

Guided practice has `roundEndsAtMs: 0`, meaning no deadline. During instruction/completion, active cooldowns, shields, locks and projectile timestamps freeze relative to the current snapshot's `serverNowMs`. Reading never postpones heartbeat failures: unhealthy input, disconnection, heartbeat timeout, and the existing reconnect lease still work normally. A rematch resets to lesson zero.

## Lesson gates and training assumptions

- Stupefy: actual player projectile damage must land. Launching alone does not finish the lesson.
- Protego: the bot launches a normal Stupefy after 1.5 seconds. An actual `impactBlocked` completes the lesson. A miss displays real damage and pauses at the same instruction; Continue explicitly restores pre-attempt health before retrying. Repeated misses cannot kill or strand the learner.
- Episkey: the bot first lands a real 20-damage Stupefy. The player must actually heal to complete the lesson; a full-health cast does not count.
- Expelliarmus: its actual hit must apply the opponent's offense lock.
- Incendio: actual 30-damage impact completes the lesson.
- The final instruction resets both players to 100 HP with clear effects/cooldowns and begins a 30-second free duel. The normal PracticeBot and normal combat rules decide the result. This reset is a training checkpoint, not a fabricated healing spell/event.

During guided practice only the current lesson spell is accepted. Projectile spells wait for the outstanding effect before accepting another attempt. Paused casts are rejected, including casts submitted just before the countdown transitions to play. Gesture classification and speech remain the client's existing input path; tutorial progression depends on server-confirmed effects, not on how a cast was requested.

## Verification

Deterministic room tests execute all five lessons through real ready/heartbeat/cast messages and the existing engine, including long reading pauses, wrong-spell/skip rejection, shield misses and retries, actual shielding and healing, damage and disarm, preserved cooldown time, free-duel bot actions and timeout, and rematch. Separate tests abort paused tutorials on unhealthy input, lost heartbeat, and disconnect; reconnect and expired reservation removal retain existing semantics. HTTP/WebSocket tests cover private tutorial reservations, tokenless bot identity, reserved-source rejection without room leaks, snapshot shape, and the new message route.

Latest affected engine/room/API/registry run: 75 passed. Latest full host run: 109 passed (including concurrent speech work); only the existing Starlette/AnyIO deprecation warning appeared. Browser/visual and physical voice/gesture qualification are separate root-task checks.
