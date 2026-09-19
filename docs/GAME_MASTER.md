# The AI game master, in three honest tiers

The laptop can hear the badges (a base-station badge relays every frame over USB serial)
but cannot talk back to them from Lua. So the game master is structured around that.

## Tier 0: the encounter deck (ships, runs on the badge)

`phantom-deck` asks OpenAI for a deck of rule mutations ("decrees") and writes
`badge/phantom_arena/deck.txt`. The host badge stores it and draws from it by game state.

```
phantom-deck --theme "haunted library" --n 16      # needs OPENAI_API_KEY
phantom-deck --offline                             # built-in deck, no network
```

The model only fills a closed schema; the badge never runs model-written logic:

```
trigger|type|value|seconds|title|text
low|dmg|20|15|Blood Frenzy|Wounds sing. All damage is doubled for 15 seconds.
```

* triggers: `low` (a mage under 25% HP), `stale` (20 s without damage), `timer` (every 45 s),
  `boss` (the Phantom under half HP)
* types: `dmg` (damage × value/10), `cd` (cooldowns × value/10), `heal` (everyone +value %),
  `fog` (everyone hidden unless within arm's reach)
* `laptop/phantom_host/deck.py` validates enums, clamps numbers, strips non-ASCII and `|`,
  caps title/text length for the 320×240 screen, and backfills any trigger the model left empty.

The host evaluates triggers every 250 ms during a fight, at most one decree per 15 s, each card
once per match, and broadcasts `E D` (resent 3×) plus the card index in every snapshot. Every
badge shows the title on its status line and the text in its log; the laptop shows the banner.
If a badge has no `deck.txt` it uses the embedded default deck, so an OTA-shared copy always
has cards. To install the deck: in the IDE press **+**, name the file `deck.txt`, paste, Push.

## Tier 1: the arena and the commentator (ships, runs on the laptop)

`phantom-host` reads the base station, rebuilds the arena from snapshots and events, and serves
`http://127.0.0.1:8000`: players on a ring (teams face each other, the Phantom in the middle),
bolts on casts, damage numbers, KOs, decrees, loot, a battle log and the headline stats
(badges heard, matches, loot, casts).

Every ~7 s with new events, `Narrator` sends the last events plus a compact, non-identifying
state (names, HP, statuses only) to OpenAI and asks for one or two spoken sentences about what
actually happened. `ElevenLabsVoice` turns them into MP3 through the ElevenLabs REST API and the
page plays it (click **enable sound** once; browsers require a gesture). Without keys the
narrator uses templated lines and the browser's speech synthesis, so the demo never goes silent.

`phantom-host --sim` runs the real badge Lua inside the simulator with bot mages, so the whole
Tier 1 can be rehearsed without a single badge.

## Tier 2: the Oracle Altar (stretch, physical delivery)

`altar/altar.ino` (Arduino + PN532, compiled with arduino-cli) rewrites one NFC tag whenever the
laptop sees a decree: `phantom-host --altar-port COM7` sends `W|pa:decree:<card>:<seconds>`.
A player who taps the altar from the Shrine screen receives the mutation on their badge
(`handle_tag` in `main.lua`), and if they are not the host, their badge forwards it as a `?`
cast. This is the only two-way channel that stays inside the badge rules: the AI's decision
reaches the badge through a physical object.

## Prompts and safety

* The commentator is told to never invent events not in the log, and to keep to 45 words.
* The deck prompt lists the exact enums and bounds; anything else is dropped before it reaches a badge.
* The state sent to the model contains names and HP only, never badge ids, MACs or contact data.
