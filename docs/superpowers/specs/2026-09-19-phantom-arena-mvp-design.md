# Phantom Arena MVP Design

## Problem

Two people should be able to fight a spell duel using HTN badges as wands, with the
match visible to an audience on a laptop screen. Badge-to-badge state sync is
unreliable and badge screens are small, so the badges must not be the source of truth
and must not be the display surface for the match.

## Shape of the solution

One-way fan-in. Each badge broadcasts a tiny ASCII packet on the badge's restricted
Lua BLE channel whenever its wielder casts. A fourth badge runs a gateway app that
does nothing but print received packets to USB serial. A Python host on the laptop is
the single authority: it parses packets, de-duplicates retries, applies deterministic
game rules, tracks player positions with a webcam and ArUco markers, and publishes one
authoritative state stream over a websocket to a React canvas client.

```
P1 badge ─┐
P2 badge ─┼─ BLE broadcast ─> gateway badge ─ USB serial ─> Python host ─ ws ─> browser
Chaos    ─┘                                                     │
                                                          webcam + OpenAI
```

## Why the host owns the rules

Badge radio is lossy and unordered, badge clocks are independent monotonic counters
with no shared epoch, and `badge.radio.send` reports *queued* rather than delivered.
Any design that lets two badges negotiate health will desync on stage. Putting all
rules on the laptop means a lost packet costs at most one cast, and the projected
display is always self-consistent.

Badges therefore render local feedback only: mana, cooldown, and a "cast sent" LED
effect. They never claim a hit landed.

## Packet design

`PA1|sender|kind|value|sequence` in ASCII, at most 44 bytes, sent three times roughly
40 ms apart because a single BLE broadcast is frequently missed. The host de-duplicates
`(sender, sequence)` for two seconds, so retries are free and a dropped first copy is
invisible.

The `PA1|` prefix is mandatory: the Lua radio channel is shared with every other badge
app at the venue, so the gateway must filter.

## Game rules

100 health, 100 mana, 8 mana/second regeneration. Fireball `F` (20 mana, 18 damage,
900 ms), Shield `S` (15 mana, 1200 ms shield, 1400 ms), Arc Slash `A` (10 mana,
10 damage, 500 ms), Ultimate `U` (60 mana, 35 damage, 5000 ms). A live shield absorbs
exactly one incoming spell and is consumed.

Mana cost rather than cooldown is the real limiter, which makes a duel last roughly
15-25 seconds. Phases are `lobby → countdown → playing → finished`, started by both
players pressing ready and resettable from the judge badge so the demo can be re-run.

## Arena Director

A judge badge can inject Meteor, Mana Rain, and Double Damage manually. The same three
modifiers are the only things the OpenAI Director may propose, as a closed enum with a
bounded duration. Every proposal is re-validated by the deterministic engine before it
touches state, and any timeout or malformed response falls back to Mana Rain for
3000 ms. The Director is commentary and spice, never a referee.

## Vision

ArUco markers 17 and 23 identify P1 and P2. Marker poses only position the HUD overlay;
they are not hit detection. Marker loss degrades to a fixed corner HUD rather than
guessing, because misattributing a health bar to the wrong player is worse than not
anchoring it at all.

## Non-goals

No database, no accounts, no Wi-Fi or HTTP from the badge, no badge-to-badge gameplay
sync, no physical hit detection, no mobile client.
