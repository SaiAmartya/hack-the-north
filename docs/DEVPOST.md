# Devpost draft

**Tagline.** Draw a spell in the air, and your Hack the North badge casts it at the badge next to
you. No phone, no Wi-Fi, no server: the arena is the badges.

## Inspiration

Every hacker got a badge with an accelerometer, six LEDs, NFC and a broadcast radio. We wanted a
game that only that hardware can play: gestures recognized on a microcontroller inside a Lua
sandbox, a multiplayer protocol built for a 44-byte broadcast channel, and loot hidden in the
building.

## What it does

* Hold A, draw, release: Lightning, Fireball, Ward, Vortex, Heal, Phase; tap to Jab, shake to
  Burst, flip the badge face-down to raise a Ward. Teach the badge your own version of any spell.
* Any number of badges in range form an arena; the lowest MAC hosts, and if that person walks
  away the next one takes over without losing anyone's HP. Duel, team battle, or raid a
  player who chose to become the Phantom.
* Proximity matters because the radio reports signal strength: melee needs arm's reach,
  fireballs weaken with distance, hidden mages can only be seen up close.
* NFC shrine stickers hide relics around the venue; the first tap per badge claims one and every
  badge nearby hears about it.
* The whole app travels badge to badge over the built-in Share app in about 20 seconds.
* A laptop with a base-station badge shows the arena and an OpenAI commentator narrates with an
  ElevenLabs voice. Before each round OpenAI writes an encounter deck of rule mutations that the
  host badge draws from by game state; an Arduino altar can deliver a decree as a physical NFC tag.

## How we built it

Lua on the badge (`api=2`), against the official badge guide, with a purpose-built simulator
(real Lua 5.4 in Python with the firmware's sandbox and limits) so the protocol, gesture engine
and host logic could be tested with eight virtual badges and a lossy radio before touching
hardware. Python (FastAPI, pyserial) and a canvas page on the laptop. OpenAI for the deck and
commentary, ElevenLabs for the voice. Arduino + PN532 for the altar.

## Challenges

* 44 bytes per frame and no acknowledgements: fixed-offset hex fields, paged snapshots, resends
  with dedupe, and a host election that needs no negotiation frames.
* No gyroscope: peak detection on gravity-subtracted acceleration plus edit-distance matching
  and per-player calibration instead of shape reconstruction.
* Memory: a feature-complete app had to be trimmed to fit the Lua quota and the 48 KiB Share
  cap while keeping every headline feature.

## Accomplishments

Gesture spells, host fail-over and NFC loot all working inside the badge's Lua sandbox; a
simulator that lets us change the game and know in three seconds whether eight badges still agree.

## What we learned

Designing for the channel you actually have. Broadcast-only radio pushes you toward
deterministic, idempotent state and away from handshakes.

## What's next

Haptic hits on a wristband, match results as compressed NFTs, and a venue-wide raid boss.

## Headline stats (fill in at the end)

Installed on __ badges · __ matches · __ loot pickups · __ casts (read them off the arena page).
