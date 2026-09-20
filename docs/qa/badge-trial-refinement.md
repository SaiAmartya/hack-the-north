# Labelled badge trial refinement — September 20, 2026

## Evidence and scope

Sai provided two Protego sessions (07:40:26 and 07:44:17 UTC), one Incendio session (07:47:18), and a partial Still session (07:48:41). The three spell sessions contain ten complete trials each. Still contains five complete trials and one interrupted trial. Sai reported background noise during Protego; the exact session and acoustic content cannot be recovered because these exports deliberately contain no audio.

All four exports identify REAL BLE, firmware 0.3.0, the 50 Hz / ±8 g profile and `quick-play-jab-raise-v2`. Observed sampling is approximately 48.8 Hz. Samples have valid flags, no gesture-breaking gap markers or saturation, and maximum reported age below 140 ms. No firmware or transport change is indicated by these captures.

Baseline retained movement evidence:

| Set | Intended movement detected in movement cue | Other observations |
| --- | --- | --- |
| Protego 07:40 | 4/10 raises | Most misses were accepted as jabs; some returns also became jabs |
| Protego 07:44 | 0/10 raises | Eight jabs and two misses during intended raises |
| Incendio | 9/10 jabs | Trial ten has no detected candidate; returns occasionally produce extra jabs |
| Still | No acceptance in the five completed movement cues | Three accepted jabs occur during settle/rest; these remain part of the negative evidence, with intentional repositioning versus accidental movement unresolved |

The first Protego note describes a right-hand, diagonal grip and a straight upward raise. The samples nevertheless include substantial ending tilt in most attempts. Current failures include the generic guard's 2 g acceleration ceiling and impulse decisions made before a lift has settled. A direction-free jab alone cannot distinguish an upward lift from an attack.

Speech diagnostics show a second independent defect: a new energy onset during ASR inference invalidates the already completed utterance and reaches fusion as a second utterance. Many such onsets are separated from the prior voice interval by at least the full endpoint silence window. Inference latency itself is healthy (roughly 300 ms and below the one-second deadline). Several correct Protego hypotheses were discarded this way. Counts must deduplicate the controller and diagnostic records of the same onset/discard.

## Implementation and verification log

- Reuse the shared accelerometer recognizer, existing raw-trace fixtures and tests. Develop against the first Protego session; initially reserve the second for validation. Its preparatory-stroke failures informed a subsequent correction, so neither Protego set is now an untouched holdout. Future captures must supply independent accuracy evidence.
- Preserve acquisition intervals, axes, flags, ages, gaps and source provenance in sanitized motion fixtures. Do not commit the raw exports, speech transcripts, device identifiers or audio.
- Reuse the local speech endpoint/client and existing lifecycle tests. Distinguish silence-ended clips from forced cutoffs; do not discard completed speech solely because another sound begins while inference is running. Ignore the later clip without queuing it or exposing its onset to fusion. A continuation after a forced cutoff still invalidates that pending result; a cutoff without a continuation retains its existing behavior. Keep one ASR request, bounded clips, the final-result deadline, capture-generation fences and explicit recognition pauses.
- Keep confidence/model/vocabulary settings unchanged: without audio, confidence-threshold experiments on these labels cannot establish noisy-room acoustic accuracy.
- Generic quick play now waits for a possible vertical lift to settle. A strong vertical stroke may exceed the old 2 g guard ceiling; a straight lift needs upward launch, sustained braking and a quiet finish. Preparatory motion is tolerated for a rotated held guard. Reverse translations are ignored. Both generic moves require at least 60 ms of detected movement; a brief wrist twitch alone is intentionally insufficient. Learned guard profiles retain their prior duration behavior.
- Telemetry now identifies `quick-play-jab-raise-v3` and records the speech endpoint's stop reason.

## Replay results

Chronological replay retains recognizer state across the supplied files, including the last guard direction. It cannot recover motion that happened between exported sessions. These are known-recording regression results, not an independent accuracy estimate.

| Recording | Before | After |
| --- | --- | --- |
| Protego 07:40, intended movement | 4/10 raises | 10/10 raises |
| Protego 07:44, intended movement | 0/10 raises | 10/10 raises |
| Incendio, intended movement | 9/10 jabs | 9/10 jabs; trial ten still has no onset |
| Still, five completed Move windows | One brief guard in stateful replay | Zero gestures |
| Still, entire completed trials | Four gestures in stateful replay | Two jabs: trial one rest and trial two settle |

The original live Still log contains three jabs, whereas chronological replay before this patch also produces a short guard. Missing between-session movement means replay state cannot exactly reconstruct the live state. The duration floor eliminates both brief detections. The remaining two rest/settle movements are not counted as proven intentional movements; whether Sai adjusted his grip is unresolved. Their classification also depends on the preceding guard state: replay with a fresh profile can label one as a guard. Tests retain both state setups and assert two remaining detections across the entire capture, with neither short candidate or Move-window detection returning. Three return jabs in the first Protego set and three in Incendio also remain. Speech and temporal fusion are still required for an actual spell; gesture acceptance alone is not cast acceptance.

Speech logs contain four naturally silence-ended, intended Protego results that the old overlap rule discarded. Client tests now cover that lifecycle with the first result arriving both before and after the suppressed clip ends, exactly one cast, a subsequent fresh spell, forced-cutoff continuation, and noise-floor adaptation. A forced-cutoff request also leaves the endpoint waiting for quiet after completion, preventing a fast first result from allowing the same continuing sound to start another request. Quiet already observed during inference counts toward that gate. No recorded audio is available to rerun transcription or claim an acoustic recognition improvement.

The browser regression replays a previously misclassified strong Protego trace through the BLE adapter, packet validation, recognizer, fusion, controller and real solo referee. Only recognized speech is scripted. It verifies exactly one Protego gesture, one accepted cast and a server shield event. Existing freshness and gap boundaries are unchanged.

Review found and addressed four issues: reject downward launch/braking despite residual wrist tilt; keep forced-cutoff tails suppressed after a fast result; await the browser test's referee acknowledgement; and check overlap with Still windows rather than only gesture start time. Final independent re-review returned no findings. The earlier browser pass also exposed old synthetic raises with only 40 ms of detected motion; the fixture now generates a deliberate 500 mg raise rather than bypassing the new minimum duration. A pass during ongoing source edits was interrupted by development reloads; the final run below used frozen source.

Final verification: `apps/host/.venv/bin/python tools/qa_game.py` passed 109 host tests, 32 tool tests, web typecheck, 273 web tests, production build and all 30 browser tests (3.3 minutes). Browser coverage includes pairing, solo and two-player battles, all five spells, cooldowns, damage/effects, game-over/rematch, miscast correction, tutorial, telemetry/trial exports and phone transport. The battle screenshot also retains the requested health-bar placement and compact labels. Local log: `/tmp/wandduel-badge-refinement-verified-qa.log`. No firmware source changed or hardware was flashed during this refinement.

## Next physical check

No badge reflash is needed: firmware is unchanged. Use the updated local build, the same badge, and your normal grip.

1. Turn on **Dev mode**, connect the badge, then open **Record gesture trials** before entering a duel.
2. Select **Protego · raise**, keep **Say the spell while moving** checked, enable the microphone, and run ten trials. Speak while raising, pause briefly at the top, and return during the settle cue. Note the grip and background noise, then **Export trial JSON**.
3. Reset and select **Still · negative**. Keep the badge still throughout all cues, including settle/rest, for an unambiguous negative capture; export it. If you also record fidgeting, use a separate session and label that explicitly in notes.
4. Reset and capture at least five **Incendio · jab** attempts with speech. Stop and export if doing fewer than ten; interrupted attempts remain useful.
5. In a solo duel, verify a spoken raise forms Protego and can block an incoming attack, then check Episkey's raised gesture heals after damage. Say Protego with a jab once: expect the yellow correction/fizzle and no shield or cooldown consumption.

Export misses as well as successes. Do not refresh or leave the recorder before exporting. These new captures, rather than reusing the development recordings, are the remaining physical validation gate.
