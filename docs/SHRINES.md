# NFC shrines and the loot economy

The QNX Makerspace stocks 100 NFC stickers and a PN532 reader/writer kit. Each sticker becomes a
shrine: a hidden spot around the venue that gives a relic to the first tap from each badge.

## Sticker payloads

Write an NDEF **Text** record (language `en`) to each sticker:

```
pa:loot:p:1      Potion       heals 30 when used
pa:loot:e:2      Ember Core   next hit ×1.5 (two of them)
pa:loot:k:1      Phase Cloak  hidden for 10 s
pa:decree:3:20   apply deck card 3 for 20 s (the altar writes these)
```

`python tools/nfc_tags.py` writes `dist/shrine_tags.csv`: 100 payloads with weighted rarity
(50% potions, 30% embers, 20% cloaks; mostly ×1, some ×2, a few ×3) and a hint column for where
you hid each one. Write them with:

* a phone: NFC Tools app > Write > Add a record > Text > paste the payload > Write, or
* the altar Arduino: `python -m phantom_host.altar --port COM7 --batch dist/shrine_tags.csv`
  (waits for Enter, then writes the next payload to the sticker on the reader).

Ask organizers before sticking anything to the building. Keep a map.

## On the badge

START > **Shrine: tap NFC loot stickers** enables NFC (it is off otherwise: NFC is
power-hungry). Hold the badge on the sticker:

* `pa:loot:...`: the item goes into the inventory (persisted in `badge.store` as `inv`), the
  sticker's UID is appended to `appdata/claimed.txt` so it is one pickup per sticker per badge,
  an `L` frame announces it to everyone in range ("Ada found Ember Core x2"), LEDs rainbow.
* Tapping a claimed sticker again says *Already claimed this shrine*. Foreign tags say
  *Not a shrine tag*; unreadable ones *Unreadable tag*.
* `pa:decree:...`: the badge applies the decree (host) or forwards it (client).

B leaves the shrine screen and turns NFC off. Back in the arena, UP/DOWN pick an item and B uses it.

## Stats

Each badge counts its own loot pickups (`loot` store key, shown in the menu title with kills,
deaths and matches). The laptop counts every `L` frame it overhears: the headline
"installed on N badges, M matches, K loot pickups" comes straight from the arena page.
