# Final build sprint — September 20, 2026

Historical checkpoint: the subsequent [solo release and current QA contract](solo-release.md)
records the authorized push/deployment, completed WAND-B602 flash, bot mode and complete
camera removal. Use that contract for current testing; the no-push/no-flash and optional-camera
statements below describe this earlier checkpoint.

## Requested outcome and decisions

Work directly on `main` with atomic local commits; do not push or flash. The initial checkout was clean at `dd0e2ff`. The first fetch found no new teammate commits on `origin/main`.

The existing architecture is retained: React/Vite player, Python authoritative referee, local laptop speech, shared badge/phone protocol, Playwright and raw-motion QA. The new brief replaces video-first visuals and room-first entry. Original pixel art gives the battle a back-facing player at lower left, a front-facing rival at upper right, readable HP and five informational spell cards.

Five moves: Stupefy (quick attack), Protego (one-hit shield), Expelliarmus (damage and brief offensive lock), Incendio (heavy attack), Episkey (heal). Unique per-spell cooldowns; no shared recovery gate. Jab + speech casts offense; held raise + speech casts defense/heal. Voice chooses the spell. Rules/numbers come from referee, not duplicated UI constants.

Pair a physical wand before room creation or code entry. Pairing ownership must be independent of the selected duel, including the hosted phone broker and optional LAN relay. Camera remains optional as small portraits; the pixel arena is primary.

## Work log

- Audit: existing authoritative damage/shield/game-over, fusion, WebRTC, BLE adapter and scripts are reusable. Existing global offensive recovery and disabled third move conflict with the brief.
- Parallel work: mechanics/referee/voice; original assets and reference research; firmware/protocol feedback. Root handles entry/lifecycle, battle UI, visual integration and QA.
- Assumption: game remains real-time, since the explicit independent cooldown requirement and physical inputs fit reactive dueling. Pokemon is a composition/readability reference, not a turn-system requirement.

## Verification and remaining work

Completed browser checks now cover wand-first entry, two ordinary player views, all five spells, synchronized HP/effects, cooldowns, zero-HP results, rematch and recovery. Desktop and narrow screenshots have been inspected. The completed final validation is recorded below; only physical qualification remains.

Physical-only evidence is deferred until autonomous work completes: actual flashing, badge sensor/BLE/power/LED behavior, actual Safari permissions/cadence, acoustic recognition and two-laptop venue network behavior. No hardware was flashed during this sprint.

### Implementation and first verification pass

- Added original Higgsfield-generated courtyard and back/front wizard sprites; inspected alpha, pixel edges and complete scene composition. Assets ship locally with no runtime image-service dependency. Official Pokemon galleries and spell references are recorded in the art direction and below.
- Removed shared offensive recovery. Stupefy: 20 damage / 2 s; Protego: one blocked hit during 1.2 s / 3 s; Expelliarmus: 10 damage + 1 s offense lock / 6 s; Incendio: 30 damage / 8 s; Episkey: heal 18 / 12 s. Healing caps at 100; casting at full HP is rejected without spending cooldown. Defense/healing remain available while disarmed.
- Pairing now owns its own token, independently of duel sessions. Existing origin checks, bounded grants, expiration and owner-disconnect cleanup remain. Pairing capabilities cannot authenticate a game socket. Failed hosted pair attempts also respect the two-second cooldown.
- Browser inspection found PhoneWand CSS leaking into GameApp. Lazy-loading the phone route removed the collision. Per Sai's supervision, removed homepage taglines, numbered steps, progress strip, subtitles, captions and footer: title + two buttons + artwork.
- Restarted the launcher with `python3 tools/run_game.py --local-referee --dev --qa`. Frontend `5173`, local referee `8000` and warmed local speech `8001` reached readiness. No remote infrastructure changed. Live iPhone pairing reached matching-code approval before any duel was created. This establishes that setup step only, not physical input or a completed match.
- The initial verification pass recorded 202 web Vitest tests, 79 host pytest tests, 32 tool tests, web typecheck, production build and phone build passing. Loopback tests ran with network binding permission. These precede the final freeze; final checks remain listed below. Firmware evidence is in [firmware 0.3.0](firmware-0.3.0.md).
- Browser-fixture mistakes correctly tripped production input protection: fractional milligravity after a guard, repeated capture timestamps when replay returned to idle, and stamping recorded samples with callback time instead of acquisition time. The fixture now rounds sensor axes, deduplicates identical capture milliseconds and preserves the existing raw trace's 20 ms acquisition cadence, as the QA harness already does. The 100 ms replay-stall guard remains unchanged. No production protection was weakened. An earlier hot-reload interruption was discarded and rerun with source frozen.
- Initial local commits: `df5c648` for firmware feedback, `43aa003` for original pixel art and `4beab73` for the five-spell game. Automatic review initially refused a local commit; Sai reaffirmed the authorization and those commits succeeded. No push or deployment occurred.

### Completed browser evidence

Tests use the existing isolated Playwright servers at `127.0.0.1:15173` and `127.0.0.1:18000`. The ordinary game fixture intercepts browser responses only inside Playwright: paced raw sensor bytes traverse the real BLE adapter, `WandClient`, recognizer, fusion, controller and referee. Voice evidence is explicitly scripted. No test mutates authoritative HP or cooldowns, and no production test hook was added. Physical BLE, acoustic recognition and venue-network quality remain separate evidence.

| Existing test | Verified result |
| --- | --- |
| Homepage, `game.spec.ts` | Only badge/iPhone actions before pairing; no room action, code input or QA controls. Desktop and 390 px layouts fit without horizontal overflow. |
| Failed phone setup, `game.spec.ts` | Broker failure exposes reconnect/choose-another-wand actions instead of leaving a preparing screen. |
| Hosted phone pairing, `game.spec.ts` | POST-only brokers, public QR, matching-code confirmation, explicit approval and cancellation. QR/socket URLs do not contain the owner token. |
| Existing raw-motion harness, `game.spec.ts` | Two referee slots, paced calibration, fused Stupefy/Protego, a blocked hit at 100 HP, abort on unhealthy input and a fresh rematch. |
| Wand-first entry, `multiplayer-entry.spec.ts` | Pairing precedes room controls; invalid code is rejected; room creation opens the lobby without calibration/practice; microphone readiness gates Ready. |
| Full GameApp match, `multiplayer-entry.spec.ts` | A second paired client joins the same code and both Ready. All five spells and cooldown indicators work. Shield blocks damage. Incendio plus Stupefy reduce both views of the defender to 50 HP; Episkey restores both to 68; Expelliarmus reduces both to 58 and displays disarm on both screens. Repeat Incendio/Episkey casts are refused during cooldown; Stupefy can cast while Incendio recharges. Attacks reach 0 HP with matching Victory/Defeat. Rematch restores 100 HP in a new round. Hidden-tab pause, microphone recovery and battle reconnection retain the chosen badge. No page errors were observed. |

The stable six-test run passed five tests. The isolated full-match test subsequently passed in 50.3 s, and passed again in 51.7 s after preserving acquisition timestamps and adding 200% CSS zoom/reduced-motion checks. Both owned E2E files pass a targeted strict TypeScript check. The later full suite passed all 29 tests, followed by all eight affected browser tests after the speech cancellation fix. Each final complete match passed in 49.8 s.

### Captured and inspected screens

These local evidence files are uncommitted. Homepage captures reflect the simplified design; battle captures include the enlarged spell text.

| File | Inspected state |
| --- | --- |
| `/tmp/wandduel-home.png` | Desktop title, two wand actions and original pixel scene; no wordmark overlap. |
| `/tmp/wandduel-mobile.png` | 390 px homepage with both actions and artwork fitting the viewport width. |
| `/tmp/wandduel-qr-desktop.png` | Hosted iPhone QR at desktop size. |
| `/tmp/wandduel-qr-narrow.png` | Hosted iPhone QR at 390 px, visible without an inherited SVG stroke. |
| `/tmp/wandduel-battle.png` | Active duel: diagonal front/back wizards, both 100 HP meters, timer and five spell cards. |
| `/tmp/wandduel-hud.png` | Spell descriptions, movement hints and distinct cooldown values. |
| `/tmp/wandduel-disarm.png` | Confirmed 10-damage impact, rival at 58 HP, disarm label and Expelliarmus recharge. |
| `/tmp/wandduel-battle-narrow.png` | 390 px active battle with both health panels and all five cards; no horizontal overflow. |
| `/tmp/wandduel-battle-zoom-reduced.png` | Final 200% CSS zoom capture: all five cards fit their content, the grid wraps to available width, and wizard animations stop under reduced motion. The initial clipped Expelliarmus card was corrected; content-overflow assertions pass. |
| `/tmp/wandduel-victory.png` | Winner at 100 HP, rival at 0 HP, Victory and Rematch; refreshed minimal result has no lobby code, joined status or camera setup. |
| `/tmp/wandduel-defeat.png` | Same authoritative result from the loser: own 0 HP, rival 100 HP, Defeat and Rematch; refreshed minimal result matches the winner. |

### Final review and local runtime

- Independent review has no unresolved finding. Fixed pre-room badge feedback (`WAND READY` with the existing renewable lease), atomic room plus first-player reservation with rollback, the premature countdown clock and effects retained after leaving a room. Regression assertions cover each state boundary.
- Before teammate reconciliation, the web unit run passed **208 tests** and the referee suite passed **82 tests**. Typecheck, production and phone builds passed. The unchanged tool suite previously passed **32 tests**. Firmware was rebuilt after the final `WAND READY` label; its exact artifact hash is recorded in the firmware report.
- The actual warmed local Whisper `base.en` recognizer accepted synthetic speech for all five names: Stupefy 318 ms, Protego 319 ms, Expelliarmus 326 ms, Incendio 320 ms and Episkey 351 ms. PCM was generated locally with macOS Samantha at 16 kHz, sent through the existing local speech proxy, and stayed on this laptop. This verifies the model/glossary/proxy path; it does not establish real voices, microphone capture or room acoustics.
- The first full 29-test browser run passed 27 and exposed two fixture issues. The relay fixture still used a game token instead of the new standalone pairing owner token; correcting it preserved every byte/feedback assertion and added a zero-duel-reservations assertion. Subsequent broad runs passed 28/29 in 1.3 and 1.2 minutes; only raw replay delivery stalled under the default headless software renderer.
- The gesture rejection was reproduced without browser load: a 25 ms delivery delay shortens a callback-stamped jab's measured half-peak width from 80 to 55 ms, below the real 60 ms rule. Keeping planned acquisition times preserves 80 ms and accepts the identical trace at 0/25/35/45 ms delivery delays. The diagnostic script/output are local at `/tmp/wandduel-replay-clock.ts` and `/tmp/wandduel-replay-clock.cjs`.
- Follow-up timing evidence ruled out hidden-tab throttling: a failed replay was 154 ms late while native visibility was `visible` and focus was true, with a 68 ms long task overlapping its deadline. Default Playwright headless-shell WebGL identified itself as ANGLE Vulkan SwiftShader; the installed full Chromium headless and headed modes both identified ANGLE Metal on Apple M3 Pro. Use the supported full Chromium channel for realistic graphics QA, with separate browser contexts for the two laptops. The existing timing guard and all referee assertions remain unchanged; timing/GPU reports are attached to the existing tests.
- Restarted the complete stack after all runtime changes using `python3 tools/run_game.py --local-referee`. The production build, updated referee and warmed local speech reached readiness at `http://127.0.0.1:5173`. Browser inspection confirmed the minimal homepage. Completed result overlays now show the outcome, final HP and Rematch without lobby code, joined status or camera setup.
- A later fetch found teammate commits `28c2770`, `652c5eb` and merge `d56f3bd`. Reconciliation is recorded below. All work remains on `main`; nothing has been pushed or deployed.

### Final validation

| Check | Result |
| --- | --- |
| Canonical `apps/host/.venv/bin/python tools/qa_game.py` | Passed: 87 host tests, 32 tool tests, TypeScript, 210 web tests at that checkpoint, production build and all 29 Playwright tests (1.8 min). |
| Final speech-cancellation change | All 214 web tests, TypeScript, production build and phone build pass. All eight affected game/entry/speech-worklet E2E tests pass (1.3 min), including another full two-player match. |
| Final live speech check | After the final stack restart, synthetic speech again reached the actual local `base.en` model: Stupefy 268 ms, Protego 275 ms, Expelliarmus 278 ms, Incendio 266 ms, Episkey 296 ms. All five returned the expected spell. Evidence: `/tmp/wandduel-asr/final-report.json`. |
| Browser timing | Full Chromium uses ANGLE Metal on this Apple M3 Pro. The broad match's maximum scripted delivery lateness was 4.7 ms; the 100 ms stall guard remained unchanged. Independent browser contexts model the two laptops. |
| Visual inspection | Homepage, phone QR, battle, HUD, disarm, Victory/Defeat, 390 px layout and 200% CSS zoom/reduced motion inspected. No remaining text clipping or horizontal overflow in these captures. |
| Firmware | All five native programs, 48 protocol checks, 64 focused wand tests, four Python codec tests, checker syntax and PlatformIO compile/link pass. Final image is 689,248 bytes; full SHA-256 and flashing procedure are in [firmware 0.3.0](firmware-0.3.0.md). |
| Review | Initial independent review and final reconciliation peer review have no unresolved findings. The latter found an orphaned speech onset after a dropped utterance; an ID/generation-scoped cancellation now retires that evidence, preserves fresh evidence and allows an immediate valid retry. Real SpeechClient + CastFusion reproduction now yields exactly one fresh cast. |
| Git | Latest fetched main and merge target both `d56f3bd`; conflicts reconciled locally with no additional branches. Diff checks pass. The local merge commit records the final result. No push or deployment. |

The full-browser headless setting is Playwright's documented [Chromium new headless mode](https://playwright.dev/docs/browsers#chromium-new-headless-mode). The existing `playwright install chromium` command installs it; do not install only the separate headless shell for this suite. GPU availability on other machines remains a measured environment property.

## Physical-only QA contract

Run this after autonomous verification. Use the final local build and shared new referee from [teammate setup](../TEAM-SETUP.md#4-two-laptops-sharing-the-new-referee); the existing deployed referee has not received these changes. Each laptop opens its own `http://127.0.0.1:5173` and runs its own local speech helper.

1. **Flash and cold boot each badge.** Follow [the firmware 0.3.0 device contract](firmware-0.3.0.md#final-device-qa-contract) and its linked app-only installation procedure. Confirm app readback, `fw=0.3.0`, `profile=range ble=on caps=0F`, 50 Hz / ±8 g and `selftest failures=0`. Unplug USB, boot from the intended AA supply and confirm the same badge advertises without repeated resets. The agent has not performed this step.
2. **Observe real badge feedback and gestures.** Run the firmware report's ten-minute BLE check with Chrome disconnected. Observe readable spell names and LEDs: Stupefy crimson, Protego cyan, Expelliarmus red-gold, Incendio orange and Episkey mint. Then pair in Chrome. Real jabs and held raises must reach the browser; a stationary wand must not cast. In battle, badge HP, shield/disarm state and win/loss feedback must agree with the laptop. Inspect `EXPELLIARMUS!` for clipping.
3. **Use real voice for all five spells on both laptops.** Let each microphone complete quiet setup. Each player performs five attempts per spell: jab while saying Stupefy, Expelliarmus or Incendio; raise and hold while saying Protego or Episkey. Take damage before healing. Expect one accepted cast per valid pair, the named effect and its cooldown. Try voice alone, a silent gesture and a repeat during cooldown; none should create an extra hit/heal. While one player gestures silently, have the nearby rival speak a spell to check microphone cross-talk. Report misses, duplicates and false casts immediately.
4. **Exercise actual iPhone Safari.** Pair before room creation/join, open the fresh QR, grant motion permission and confirm the matching code. Verify Sensor active and Reaching laptop during movement. Use a comfortable consistent grip; rotate the screen once without changing it. Complete real jab/raise casts, then lock the phone or switch apps: the duel must pause and stale input must not cast. Return to foreground, tap Resume when requested and Ready for a fresh round. Record Direct or Internet; neither route's physical reliability follows from scripted tests.
5. **Play on two laptops at the venue.** Confirm both launchers use the same new referee. Pair first, create/join by code and complete a duel and rematch with the intended wand combination. Compare both HP values after hits/heals, one-hit shielding, independent cooldowns, disarm and matching victory/defeat at 0 HP. Test optional cameras if they will be used. A two-page loopback test does not establish venue peer connectivity or microphone separation.
6. **Interrupt and recover the physical session.** Switch away from a laptop tab, disconnect/power-cycle a badge and briefly interrupt the chosen phone/network link during play. Expect a clear pause, expiry of stale badge feedback and no replayed spell/result. Reconnect, enable the microphone if needed and start a fresh round; a retained badge connection should not need another chooser. Follow the firmware report's two-badge, 30-minute AA session and finish with a fresh match, recording resets, dropouts and feedback errors.

For every failure, send **build/commit · devices/OS/browser · Direct or Internet · failed step · expected → observed · visible message**. Stop that failing sequence and surface the issue immediately so it can be reproduced. Exclude credentials, raw microphone audio and private phone identifiers. Physical results remain pending until recorded for the actual devices and network.

### Design sources

Spell identities follow official descriptions: [Shield Charm](https://www.harrypotter.com/fact-file/spells/the-shield-charm), [Disarming Charm](https://www.harrypotter.com/fact-file/spells/the-disarming-charm), [Incendio](https://www.harrypotter.com/features/useful-spells-for-winter), [Stupefy](https://www.harrypotter.com/features/your-guide-to-the-best-spells-in-harry-potter), [Episkey](https://www.harrypotter.com/features/what-would-be-your-signature-spell). Damage, duration, cooldown and healing values are original game balancing, not claims about canon.

## Teammate reconciliation

Checkpoint `4beab73` saved the reviewed five-spell implementation before merging `origin/main` at `d56f3bd`. The merge preserves the teammate commits in history and their raw motion recordings, optional logger and launcher entry. The launcher entry explicitly selects the updated local referee. Both legacy spell-selection environment names are cleared when launching.

The incoming seven-move rules, 500 ms global cooldown, duplicate cooldowns, button-only cast path and mandatory calibration/practice conflict with this task's five-move, independent-cooldown and minimal wand-first requirements. Those alternatives are not enabled. Existing phone broker, atomic reservation, reconnect/retained-GATT and clipped-input safeguards are preserved; the incoming merge would have removed them. The unused seven-spell runtime catalog is excluded while its captured data remains documented in `traces/README.md`.

Two compatible improvements were integrated and verified: bounded local speech deadline/backpressure recovery, and clearer badge HP styling. Historical spell IDs 5–7 are reserved; Episkey moves to ID 8 so already-flashed seven-spell firmware cannot silently display healing as Sectumsempra. The active game still contains exactly five moves. Final codec/build artifacts and browser checks passed, and the reconciliation review has no unresolved findings.
