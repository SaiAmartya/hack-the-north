# Radio protocol

The badge's Lua radio is broadcast only: 1 to 44 byte payloads, no acknowledgements,
an 8-slot receive ring drained 4 frames per tick. Everything below is designed for that.
Reference implementations: `badge/phantom_arena/main.lua` (encoder and host) and
`laptop/phantom_host/protocol.py` (decoder). The test `test_every_frame_from_the_real_app_parses`
cross-checks the two against each other.

## Identity

* Player id = last two bytes of `badge.radio.mac()` as four uppercase hex characters (`0A1F`).
* Name = `badge.me.name()` cleaned to `[A-Za-z0-9 ]`, at most 10 characters (`Mage` when empty).
* Team = derived from `badge.me.color()` (red/blue/green/gold) or switched in the menu; saved in `badge.store`.
* Role = `M` mage or `B` the Phantom (boss).

## Frames

All frames start with `PA` and a kind letter. Numbers are fixed-width hex or single digits so every
field sits at a fixed offset and no delimiter bytes are spent.

| Kind | Layout | Bytes | Sender | Cadence |
|---|---|---|---|---|
| `H` heartbeat | `PAH` id4 team1 role1 mode1 host1 name≤10 | ≤21 | everyone | 1 Hz, and after any identity change |
| `C` cast | `PAC` seq2 caster4 spell1 charge1 rssi2 targets(4×n, n≤7) | 13..41 | caster | on cast, sent 3× 100 ms apart |
| `S` snapshot | `PAS` phase1 mode1 page1 decree2 (id4 hp2 st1)×≤5 | ≤43 | host | 4 Hz, pages rotate when >5 players |
| `E` event | `PAE` kind1 seq2 a4 b4 v2 s1 | 17 | host | on event; important kinds sent 3× |
| `L` loot | `PAL` id4 item1 qty1 | 9 | finder | on shrine pickup, sent 3× |

* `rssi2` is `-rssi` in hex (`37` = -55 dBm). `charge1` is `1`..`6` (quarter seconds A was held).
* `hp2` is a percentage 0..100 so a 450 HP boss still fits. `st1` bits: 1 warded, 2 hidden, 4 dead.
* `spell1`: `L` lightning, `F` fireball, `W` ward, `V` vortex, `H` heal, `P` phase, `J` jab, `B` burst;
  items `p` potion, `e` ember core, `k` phase cloak; control `!` start match (charge = 1 duel, 2 teams, 3 raid),
  `~` reset to lobby, `?` apply decree (rssi field carries the card index, charge = duration/10).
* Event kinds: `H` hit (v = damage), `M` miss, `W` warded, `G` ward raised, `V` vanished, `L` heal, `K` kill,
  `R` respawn, `I` item used, `S` match start (s = mode), `O` match over (a = winner: id, `TM<t>0`, `MAGE`, `BOSS`, `NONE`),
  `D` decree (v = card index, b = duration as 4 decimal digits), `B` boss enraged (v = boss hp %).

## Host election

Every badge keeps a peer table from the frames it hears. The host is the lowest MAC among
itself and every peer heard in the last 3 seconds. No negotiation frames: because everyone
runs the same rule over roughly the same peer set, they converge within one heartbeat.

* A new host seeds its authoritative world from the last snapshot it rendered (HP percent and
  status per player), so a host pressing HOME mid-fight costs nobody their damage.
* Clients only accept `S` frames from a MAC less than or equal to their elected host, which
  silences a badge that briefly believes it is host during a hand-over.
* Peers silent for 15 s are dropped ("left the arena").

## Reliability on a lossy channel

* Casts and important events are re-sent twice, 100 ms apart. Receivers keep a 2.5 s ring of
  recently seen payloads and drop byte-identical repeats. Snapshots and heartbeats are idempotent
  and never deduplicated.
* Sequence numbers make otherwise identical casts distinct (256-wrap).
* Every `on_recv` only queues (16-frame cap); parsing happens in `on_tick`, at most 8 frames per tick.
* The simulator's `loss=0.35` test confirms a cast still lands with a third of frames dropped.

## RSSI mechanics

Each badge records the RSSI of the last frame from every peer. A cast carries the caster's
measured RSSI to its target (for area spells: the weakest of the chosen targets), so the host
can apply proximity rules it could not measure itself:

* Jab, Vortex and Burst need `rssi >= -58` (roughly arm's reach).
* Fireball damage scales with `clamp((rssi + 95) / 45, 0.35, 1)`.
* A hidden mage (Phase, Phase Cloak, Fog decree) cannot be targeted unless `rssi >= -62`, and any
  attack a hidden mage makes reveals them.

Tune `NEAR` and `REVEAL` at the top of `main.lua`; the target label on the badge prints the live RSSI.

## Base-station serial format

The `pa_base` app prints one line per frame: `PARX|<mac>|<rssi>|<payload>` and every 5 s
`PAST|frames=<n>|badges=<n>|dropped=<n>`. The laptop searches each line for `PARX|` because the
firmware prefixes log lines with the app slug.
