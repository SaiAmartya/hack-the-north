# Demo runbook

## Hour one (before anything else)

1. Push `dist/phantom_arena.min.lua` to two badges through the IDE. Open it on both. Confirm the
   status line reads `host YOU` on one and `host <name>` on the other and that a flick up lands
   `LIGHTNING` with damage on both screens.
2. Test **Share**: Share > Send an app > Phantom Arena > A: offer app on one badge; Share >
   Receive an app > A: accept on the other. Time it. If it says "App is too big to share",
   remove `icon.bin` from the app folder (`rm /littlefs/apps/phantom_arena/icon.bin` then
   `reload` in the IDE console) or push the minified build.
3. Push `dist/pa_base.lua` to a third badge, plug it into the laptop, `uv run phantom-host --port auto`,
   open http://127.0.0.1:8000 and confirm the base-station dot turns green and frames count up.
4. Note the free heap: in the IDE console type `heap` before launching. If the app ever fails at
   launch with "Lua memory limit exceeded", reboot the badge and open Phantom Arena first;
   the firmware releases Bluetooth memory on reboot.

## Judge flow (two minutes)

1. Arena page on the laptop, sound enabled, base station blinking.
2. "Install it on your badge": Share from our badge to the judge's badge (about 20 s). They open it.
3. Their name appears on the arena page and on our badge. "Hold A, flick up, let go." Lightning
   hits us; both screens show the damage; the commentator reacts.
4. Show the gesture string on their screen, then START > Teach a spell: they draw their own
   fireball three times and cast it.
5. START > Start match: Duel. Fight to a KO. Show the decree banner when the Game Master
   intervenes (low HP or 45 s timer).
6. Tap a shrine sticker on the Shrine screen: loot announced on every badge and on the page.
7. Close with the stats line on the page: badges, matches, loot, casts.

## If something fails

* No gesture recognized: hold A and press UP (button fallback) and keep talking.
* Radio unavailable on a badge: reboot it, open Phantom Arena first.
* Base station silent: the arena page still works from `--replay logs/demo.txt`; the badges
  do not depend on the laptop at all.
* OpenAI or ElevenLabs down: commentary falls back to templates and browser speech automatically.
* Two hosts flickering: one badge has not heard the other for 3 s. Move closer; it converges.

## Record for Devpost

`uv run phantom-host --port auto --log logs/demo.txt` keeps every frame. The stats on the page
(and `PAST` lines from the base station) give "installed on N badges, M matches, K loot".
