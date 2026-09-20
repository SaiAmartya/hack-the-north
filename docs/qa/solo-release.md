# Solo duel and hosted rollout — September 20, 2026

Sai authorized pushing main, deploying the existing Render referee, adding a real solo-bot feature, and flashing the USB-connected wand. Work stays on main. This record supplements the completed [final sprint](final-sprint.md).

## Running record

- Published the four final-sprint commits through `153c53b` to `origin/main` after fetching and confirming no intervening teammate commits.
- Render dashboard initially required sign-in; Sai completed it. The first rollout of `153c53b` succeeded in 1m03s at [deployment dep-danmv3p42hec73f1h49g](https://dashboard.render.com/web/srv-danjisjtqb8s73c4t430/deploys/dep-danmv3p42hec73f1h49g). A fresh public `/api/game/rules` request returned all five enabled spells, healing and independent cooldowns. The solo follow-up deploy is recorded below.
- Solo reuses the same authoritative room, spell validation, projectiles, HP, effects and result logic. Only P2 is automated; human badge/iPhone motion and local speech still pass through the normal input pipeline.
- Added **Duel a bot** after wand pairing. Solo hides invitation codes, retains the wand when leaving, and starts a fresh solo reservation if reconnect credentials expire.
- Solo uses the existing artwork. No new image assets were generated.
- Client typecheck and 37 focused game tests passed at the first frontend milestone. Full integrated browser evidence follows when the bot implementation is ready.
- Connected WAND-B602 was flashed with the documented app-only 0.3.0 image. Full readback matched its SHA-256; runtime and BLE evidence is recorded in [the firmware report](firmware-0.3.0.md).
- Both affected browser specs passed: seven tests, including a full solo match with all five human spells, actual bot damage, zero-HP defeat, rematch, active-round socket reconnect and retained wand pairing; the ordinary two-player match also passed.
- The new reconnect check exposed a stale playing snapshot hiding recovery controls. A lost referee connection now displays the paused/reconnect overlay immediately.
- Independent review found an old camera warning could survive the multiplayer-to-solo transition. The transition was fixed and tested, then the camera feature was removed entirely at Sai's subsequent request. A second scoped fix keys presentation context and event deduplication by room so replacement solo rooms cannot suppress fresh feedback with repeated event IDs. Both regressions pass; the independent reviewer cleared both fixes.
- The full suite passed at the solo milestone: 97 host, 32 tooling, 220 web unit and 30 browser tests, plus typecheck/build.
- Sai then requested removal of the redundant lobby instruction and all opponent-camera functionality. Removed the video component/controller/media acquisition, video peer module, signaling and ICE/TURN code, camera CSS/configuration, and obsolete camera tests. Phone data-only RTC, motion pairing and local microphone capture remain intact. The remaining browser tests explicitly assert that solo and multiplayer expose no camera controls or video elements and omit the removed sentence.
- Final camera-free `tools/qa_game.py` run passed: **94 host, 32 tooling, 217 web unit and 26 browser tests**, plus TypeScript checks and the production build. Browser tests covered ordinary two-player synchronization, all five spells, bot knockout, rematch, reconnect, phone permissions/RTC/relay, speech capture and 100 renderer cycles. Removed tests exercised only the deleted camera feature.
- Inspected captured mode-selection, solo lobby, battle HUD and zero-HP result screens. The final lobby has only the title, short opponent status and Ready action; the requested instruction and camera controls are absent.

## Assumptions

- Solo is a basic practice opponent, with exactly the same 100 HP, 60-second round, five spell rules and cooldowns as human duels.
- The bot waits three seconds before its first action and pauses between decisions. It can attack, occasionally shield, and heal after taking damage; it receives no damage or cooldown advantage.
- Solo requires one real badge or iPhone and the laptop microphone. It does not expose simulated inputs or clickable spells to players.
- A solo room is private, cannot accept a second human, and rematches begin when the human readies again.

Implementation reuses `DuelRoom` and `DuelEngine`; the small `PracticeBot` policy only chooses a spell for a normal cast command. `POST /api/game/session` accepts optional `mode: "solo"` (default `"duel"`), and session/welcome/snapshots carry the mode. `source: "bot"` is reserved for server-owned P2 and rejected from client reservations. The bot has no authentication token or socket. Human disconnect/unhealthy input follows the existing abort path; expiry or leave removes both participants, and empty rooms use the existing bounded cleanup. Browser QA shares the existing raw-input helper rather than maintaining another harness.

## Physical QA contract

Use the latest main checkout and restart the launcher after pulling. The final release section below records which referee revision was deployed. On this Mac WAND-B602 is already flashed; teammates must follow the guarded [firmware instructions](firmware-0.3.0.md) for their own devices.

1. **Entry:** Open `http://127.0.0.1:5173` in Chrome. Pair the intended badge or iPhone, permit the laptop microphone, hold the wand briefly still and allow two seconds of quiet. Choose **Duel a bot**, then **Ready**. Expect a countdown and no second-device or opponent requirement.
2. **Five spells:** Across as many rematches as needed, make five attempts per spell, speaking its exact name with the displayed gesture. Stupefy: jab, 20 damage, 2 s cooldown. Protego: raise/hold, one-hit shield for 1.2 s, 3 s cooldown. Expelliarmus: jab, 10 damage and 1 s offensive lock, 6 s cooldown. Incendio: jab, 30 damage, 8 s cooldown. Episkey: raise/hold, heal up to 18, 12 s cooldown; take damage first. Confirm each accepted cast fires once and the badge displays the matching feedback.
3. **Strategy and negatives:** Shield an incoming attack; heal after damage; cast another ready spell while one recharges. Repeating a cooling spell must fail without extra damage. Voice alone, silent movement, unrelated speech and fidgeting must not cast. Healing at 100 HP must not spend its cooldown. Shield/heal must remain available when disarmed.
4. **Results:** Defeat the bot; then rematch and let it defeat you. At 0 HP expect the correct result. Rematch must reset both HP and cooldowns. Leave duel and start another solo duel without pairing again.
5. **Recovery:** Switch away from the game, return, and ready for a fresh round. Disconnect/power-cycle the badge and reconnect; expect no stale spell or old feedback. With iPhone Safari also test lock/background, foreground Resume and fresh movement. Confirm which route, Direct or Internet, was used.
6. **Device-only checks:** Inspect display/LED spell colors, long labels and HP/status feedback. Cold-boot the badge on AA power, then complete a 30-minute session and one more fresh duel. Repeat on the actual Windows/Chrome laptops and badges to be used.

Solo covers individual input and combat behavior. Two humans are still needed later for microphone cross-talk, two physical input streams at once, venue network behavior and synchronized remote views. Run one full human match and rematch, plus a disconnect/reconnect, on the same deployed referee before claiming multiplayer hardware qualification.

For any failure, report the step, commit, badge firmware, device/browser/OS, expected versus observed behavior, and the visible message. Do not send credentials or private audio.
