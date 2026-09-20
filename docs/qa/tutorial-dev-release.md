# Tutorial, development telemetry and speech reliability — September 20, 2026

## Scope and decisions

- Sai requested home options, a guided tutorial and substantial speech improvements. He subsequently **withdrew motion-only casting and the Say the spells option**. Ordinary play still requires local speech plus a jab or held raise.
- Work continues directly on main under the sprint authorization. Preserve the existing engine, input protocol, local speech boundary and script-driven QA infrastructure.
- Dev mode defaults off each page load. It is selected on the homepage, retains wand-first pairing, and makes the five spell cards explicit cast buttons. Clicks use the same referee validation, damage/effects and cooldowns. Microphone availability does not gate developer clicks; physical wand health still does.
- Tutorial teaches Stupefy, Protego, Episkey, Expelliarmus and Incendio with locally drawn animated SVG demonstrations. Speech and movement should overlap. Each lesson advances only on a confirmed server effect. Guided lessons are untimed; instructions and completed lessons pause combat deadlines. A missed shield permits an explicit checkpoint retry. The finale resets both players to 100 HP and allows 30 seconds of ordinary combat.
- No unmeasured gesture threshold change is made for the reported unreliable raise. The new trace will distinguish raw input, classifier outcome, speech result, fusion timing and referee rejection.

## Reuse and implementation

- `DuelController`, `GameClient`, the existing spell cards and the raw-input browser fixture remain the integration points.
- `DuelTelemetry` is a local, opt-in 30,000-event ring. It displays only 80 recent rows, counts overwritten events and exports on the player's click. It includes raw received MOTION bytes, decoded fresh samples, rejection reasons, timing/generation, classifier candidates, fusion decisions, local ASR raw transcript/quality/timing, developer clicks and referee acknowledgements/events. It records no microphone audio, game token, phone enrollment secret or pairing capability. Pausing the view does not pause capture.
- A persistent **Last heard** line keeps the latest raw transcription readable as motion rows scroll past. Referee events retain their server timestamp and include estimated browser event time, offset and synchronization RTT; entry time is browser receipt. The export labels each clock separately so device, browser and server values are not confused.
- `GestureGuide` contains original vector animation; `TelemetryPanel` keeps diagnostic UI out of ordinary play. The server-owned lesson policy is the only new combat orchestration; existing rules/effects remain authoritative.
- Speech research, comparisons and acoustic evidence are recorded in [speech reliability](speech-reliability.md); tutorial protocol and lifecycle evidence are in [tutorial backend](tutorial-backend.md).

## Running verification record

- Initial integration typecheck and 69 affected client/controller/contracts/wand unit tests passed.
- Canonical `apps/host/.venv/bin/python tools/qa_game.py` passed 109 host tests, 32 launcher/tool tests, 226 web unit tests, typecheck and production build. It passed 26 of 27 browser scenarios; the existing solo test incorrectly required an unblocked attack against a bot that can legitimately shield. Its oracle now binds each projectile to exactly one lawful hit or block, retaining independent guaranteed damage/disarm checks in tutorial and multiplayer tests. All six `game.spec.ts` scenarios then passed (1.5 minutes), including tutorial and solo. A final test-only check accounts for a newer shield after the measured impact; the affected solo test passed again in 31.9 seconds. All 27 browser scenarios therefore have passing evidence on the final runtime implementation.
- The new integrated browser scenario covers all five tutorial effects, paused deadlines, the 30-second free duel, developer click restrictions, raw packet/gesture fusion, actual AudioWorklet capture with a scripted ASR response, raw transcription display, export, clearing, responsive layout and reduced motion. Desktop/mobile homepage, tutorial, HUD and telemetry screenshots were inspected; the original gesture SVG previews were shared with Sai.
- Independent review found and resolved the cross-clock telemetry ambiguity and an inaccurate retained-event caption. No review findings remain.
- Restarted the complete owned stack with the current production frontend, referee and speech helper. Through the real local frontend proxy, all five synthetic incantations were accepted in 301–332 ms and both silence and noise were rejected in 3 ms. This supplements the larger controlled acoustic experiment; it is not physical microphone qualification.

## Physical trace collection

1. Open the latest game, enable **Dev mode** in the homepage's bottom-right corner, then connect the intended badge or iPhone.
2. Enter Tutorial duel or Duel a bot and select **Enable microphone**. For a real input trial, do not click a spell card: say the spell while performing its gesture. Try Protego/Episkey raises with a brief stable hold; lower before the next attempt. Tutorial accepts casts only after **Try it**; its instruction/completion screens intentionally pause recognition.
3. Record the intended spell, approximate attempt time, source, grip and expected/observed result. Include both successes and misses. The log uses browser monotonic seconds; the packet's captureMs is a separate device clock. Exported referee events include their clock conversion estimate.
4. Click **Pause view** to inspect; capture continues. Click **Export JSON** soon after the useful attempt, before older rows are overwritten. Raw transcript text is intentionally included; microphone audio is not.
5. Send the JSON with the attempted spell and failure description. Mark any developer-click casts explicitly; they do not prove gesture or microphone recognition.

## Remaining physical QA contract

1. On each teammate laptop, pull main, rerun `python3 tools/run_game.py`, and open `http://127.0.0.1:5173` in Chrome. Reconnect the intended wand. The launcher replaces only its previous owned stack.
2. Complete Tutorial duel with real voice and movement. Verify each gesture, shield block, heal, disarm and damage, then finish the timed practice duel. Test developer clicks separately, then reload with Dev mode off and verify spell cards are read-only.
3. Collect five trials per spell with each intended badge/iPhone, first in quiet and then with nearby conversation/game audio. Include speech without motion, motion without speech, and a nearby second speaker. Export promptly after an unreliable raise or transcription miss using the steps above.
4. With two physical laptops, create/join one duel and confirm reciprocal HP/effects, independent cooldowns, 0-HP result and rematch. Briefly background/disconnect one input, verify the duel pauses safely, then reconnect and start a fresh round.
5. Firmware remains 0.3.0 and is unchanged by this release. The previously connected WAND-B602 was already flashed; other badges still need the documented [flash and recovery procedure](../../firmware/README.md). Check LEDs/display, battery-only boot and a full unplugged duel. Existing [firmware evidence](firmware-0.3.0.md) distinguishes completed checks from these physical gates.

Actual noisy-room voices, physical raises, badge/phone handling and battery/Windows/network qualification still require physical observations. Synthetic audio and raw replay demonstrate specific software behavior, not those hardware/acoustic conditions.
