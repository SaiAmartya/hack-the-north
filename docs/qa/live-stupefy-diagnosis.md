# Live Stupefy diagnosis — September 20, 2026

## What the supplied capture proves

Source: `wandduel-telemetry-2026-09-20T08-22-24.793Z.json`, REAL BLE, solo, `quick-play-jab-raise-v3`. The retained excerpt is 11.252 seconds, not the entire round. Raw exports, transcripts and device identifiers are not copied into this report or repository.

The bot (P2) casts Stupefy twice. The player has one exact, confidently recognized Stupefy incantation, but no `cast.attempt`, cast acknowledgement or P1 `castAccepted` in the excerpt. A motion event labelled `spell: stupefy` is the legacy internal name for a jab; it is not proof of a spoken or server-accepted spell.

| Time from excerpt start | Evidence |
| --- | --- |
| +1.322 s | First accepted jab; its accompanying speech is a longer non-incantation phrase and is rejected |
| +2.281 s | A movement is accepted as a raise, setting the remembered guard direction |
| +6.391 s | Strong horizontal movement overlaps the later recognized Stupefy, but produces no accepted gesture |
| +7.194 s | Exact Stupefy speech result arrives; fusion stores the confirmed incantation |
| +7.255 s | Another energy-onset callback clears the confirmed word |
| +7.805 s | That later sound is classified as no speech |
| +9.723 s | Bot Stupefy damage ends the round |

The badge stream is healthy: 550 valid samples at approximately 48.75 Hz, no sequence gaps or gesture breaks, 19–22 ms capture intervals and maximum reported age about 103 ms. Speech inference for the clean Stupefy takes 312 ms; its result arrives 542 ms after the voice interval ends, within the existing one-second deadline. Firmware, transport, weak motion and an expired result are not supported explanations for this attempt.

## Two distinct logic failures

**Motion: old guard-direction state vetoes a new horizontal jab.** The movement spans browser time 318174.85–318892.85 ms, peaks at 2337 mg, and has approximately 0.096 alignment with gravity. The explicit downward-launch/braking detector is false. Nevertheless, its 25-degree ending wrist tilt points 131 degrees opposite a prior accepted guard, so the legacy angle-based lowering rule suppresses it before jab selection. Its force is far above the approximately 670 mg passive gravity/reorientation envelope. The first accepted jab is similar. Increasing sensitivity does not address this cause.

**Speech: callback arrival is mistaken for capture time.** The next energy candidate began 29.6 ms before the Stupefy transcription result arrived, while inference was still busy. Its onset callback arrived 60.6 ms after that result, when the pending request had already been cleared. The previous pending-request check therefore did not suppress it. Fusion then treated unverified energy as a second utterance and erased the confirmed incantation; the later no-speech result proves that this was not a second recognized spell.

The motion failure is sufficient to explain why this particular cast was never submitted. Fixing the speech reset alone cannot create the missing gesture. With the overlapping jab accepted, the existing timing rules would allow a pair: zero interval gap, 1232 ms total span, 718 ms overlap and a 542 ms final-result delay. This is a timing counterfactual, not a claim of an observed cast or a won match.

## Proposed reliability pass — not yet production changes

1. **Bound return suppression to a movement episode.** Retain explicit downward-launch/braking rejection and the remembered direction used to distinguish guards. Expire only the legacy angle-based jab veto two seconds after the sample confirming a guard; do not expire the entire guard direction. A temporary replay of that candidate recovers this Stupefy with zero classification or timing changes across all four prior recordings: 20/20 raises, 9/10 jabs and unchanged Still/extra-movement counts. Known returns start about 1.2–1.9 seconds after confirmation; this new jab starts about 3.2 seconds afterward. A forceful return after a hold longer than two seconds remains an untested negative and could become a jab. Verify that case before shipping this proposal. Two rejected alternatives: restricting the veto to passive reorientation produced four extra return jabs; expiring the entire guard direction produced five extra return guards and a Still activation.
2. **Use capture time for speech arbitration.** Retain the interval during which inference was busy so an onset captured then remains suppressed even if its callback arrives after completion. At fusion, unverified energy must not erase an already confirmed incantation. Only actual conflicting command evidence, expiry, invalid input generation or a transport/visibility break should retire that confirmed attempt. Keep one inference job, the existing 350 ms interval-gap / 2 s union limits, the one-second result deadline and exactly-once evidence consumption.
3. **Verify complete attempts, not isolated component counts.** Add a regression of this full motion/speech event sequence, including the result/onset race and the eventual no-speech result. Assert one submitted and acknowledged Stupefy, plus no duplicate or later replay. Re-run previous positive, Still and return sequences and preserve each unresolved extra movement in the report. Fresh real combined attempts remain the physical gate; the earlier 20/20 was classified raises in tuning recordings, not 20 successful live casts.
4. **Then make the feedback legible.** Keep one compact player status for heard incantation, waiting for motion, correction or accepted cast. In Dev mode, group speech, motion decision, pairing and referee acknowledgement under one attempt and call motion classes `jab`/`raise`, reserving spell names for incantations and casts. This is the next UI/UX pass, not an additional diagnostic dashboard in ordinary play.

No model replacement or looser confidence thresholds are justified by the clean Stupefy here. The existing local ASR supports [word timestamps and VAD](https://github.com/SYSTRAN/faster-whisper#word-level-timestamps), but adding those would require measuring latency and acoustic behavior; it is not a substitute for the demonstrated state-machine fixes. Do not accept any sentence merely because it contains a spell substring. No audio is retained in this export, so acoustic speaker/noise attribution cannot be recovered.

## Change implemented now

The solo practice bot waits 12 seconds after play starts and at least 12 seconds between attempts, casts only ordinary Stupefy, and no longer heals, shields, disarms or uses fire. It retains normal damage, flight, cooldown and disarm rules. A skipped turn is not followed by a catch-up burst. Rematches restore the opening grace. Scripted tutorial lessons are unchanged; their final free duel uses the gentle pacing.

An idle player survives the full 60-second round with 20 HP. This intentionally makes practice survivable; normal timeout scoring still decides the winner. Verification passed: 111 host tests, web typecheck and both affected browser scenarios (solo five-spell battle/rematch/reconnection, and tutorial/telemetry). The solo browser result was inspected visually: the player won the timeout with 58 HP versus the bot's 40 HP. Independent review found no defects. No input algorithm or firmware change is included in this bot update.
