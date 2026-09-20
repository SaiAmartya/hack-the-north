# Local speech reliability — 2026-09-20

The speech path still runs entirely on the player's laptop: browser microphone → bounded mono 16 kHz PCM → local `faster-whisper base.en` CPU/int8 → exact incantation → gesture fusion. No cloud ASR, new model download, microphone recording, fuzzy spell matching, or expanded evidence deadline was introduced.

## Findings and chosen approach

The previous browser configuration explicitly disabled echo cancellation, noise suppression, and automatic gain control. Its RMS calibration averaged all energy, so a short loud sound during setup raised the threshold for the rest of the session. Its decoder also accepted a glossary-biased canonical word without checking acoustic confidence: in this experiment it returned **Stupefy for silence, white noise, and a 60 Hz hum**. Three inference deadline misses permanently disabled the otherwise healthy helper.

We compared four local decoder configurations on the same synthetic corpus. Bundled Silero VAD was the material improvement; a larger decoding beam did not improve its results and increased latency. The implementation therefore keeps beam size 1 and the existing pinned model.

| Approach | Decision and primary evidence |
| --- | --- |
| Browser echo/noise suppression and gain control | Enabled as browser capture preferences. The [W3C Media Capture specification](https://www.w3.org/TR/mediacapture-streams/#constrainable-properties) defines these controls. Browser/device implementation still determines their acoustic effect. |
| Neural VAD before local Whisper | Selected. [faster-whisper](https://github.com/SYSTRAN/faster-whisper#vad-filter) bundles Silero and configurable segmentation; [Silero's documentation](https://github.com/snakers4/silero-vad/wiki/FAQ) describes 16 kHz support and low-cost ONNX inference. This filters noise before the glossary can hallucinate a spell. |
| Larger Whisper beam / vocabulary hints | Beam 3 was measured, then rejected because it added latency without benefit after VAD. The glossary remains a hint, never an instruction to force one of five outputs. [Decoder options and segment scores](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py) support the implemented confidence checks. |
| Grammar-constrained decoder | [whisper.cpp's command example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/command) supports command lists and grammars. A new inference backend adds packaging work, and forcing a closed vocabulary alone does not distinguish noise from a command. Not selected over the measured VAD improvement. |
| Dedicated keyword models | [openWakeWord](https://github.com/dscripka/openWakeWord) supports VAD, custom training, and negative-data evaluation. It is a credible later option after collecting representative pronunciations and negatives; this sprint does not have a validated five-spell training corpus. |
| Vosk vocabulary adaptation | [Vosk's adaptation procedure](https://alphacephei.com/vosk/lm) includes dictionary and language-model updates. Invented incantations need pronunciation coverage; changing recognizers without that evidence was not justified. |

Implemented:

- Capture requests browser echo cancellation, noise suppression, and gain control. Audio remains mono with the existing exact 16 kHz worklet and continuity checks.
- Calibration uses the 35th-percentile background level rather than average energy. Lower hysteresis thresholds, 250 ms pre-roll, and slow tracking of sub-onset background preserve quieter syllables. Only an explicit neural **no-speech** response may update the floor after a sudden persistent noise; ordinary words cannot teach the endpoint a louder floor.
- Silero filtering uses 80 ms minimum speech, 180 ms silence, and 150 ms padding. Both VAD and Whisper are warmed before health becomes ready. Decoding stays deterministic, history-free, bounded to 24 new tokens and the existing three-second PCM request bound.
- The whole utterance is rejected when any segment has non-finite scores, average log probability below -1.0, or no-speech probability above 0.6. Exact normalized vocabulary matching still follows that gate; confidence scores are model indicators, not calibrated correctness probabilities.
- Non-spells, uncertain audio, overlap, worker busy, and late results quietly discard their evidence. Temporary request failures keep listening; three consecutive failures produce one actionable connection error. Missed inference deadlines no longer permanently disable a healthy worker. No late result is reused or retried as a new cast.
- A short audio gap cancels all pending speech/fusion evidence and automatically recalibrates fresh capture. Repeated gaps before calibration still surface a capture fault. Hidden pages, ended tracks, invalid PCM, and inconsistent helper identities still invalidate capture.
- Dev-mode diagnostics can include raw transcript text (maximum 512 characters), recognized spell, voice interval, inference duration, speech duration, model scores, and rejection reasons. They contain no audio. Root telemetry owns the explicit opt-in memory buffer and export.

## Measured results

Local machine, pinned `base.en` CPU/int8, one synthetic macOS Samantha voice; five previously generated incantations. Samples were peak-normalized to 0.3 and mixed with deterministic Gaussian noise using NumPy seed 2419. SNR is relative to each source clip's RMS. These are controlled regression measurements, not human/venue accuracy estimates.

| Decoder trial: clean, +15 dB, +5 dB, 0 dB (20 positives) | Correct spells | Noise-only false spells | Positive median |
| --- | ---: | ---: | ---: |
| Previous beam 1, no VAD | 18/20 | 3/3 | 275.5 ms |
| Beam 3, no VAD | 19/20 | 2/3 | 311 ms |
| Beam 1 + VAD | 20/20 | 0/3 | 295.5 ms |
| Beam 3 + VAD | 20/20 | 0/3 | 321.5 ms |

The first VAD trial included a 987 ms cold initialization. Production now warms both models before accepting speech. A separate run through the **final production decoder** recognized **30/30 positives**: those 20 plus five 40 ms echoes at 30% amplitude and five clips at 15% original gain. It rejected **8/8 negatives**: ordinary speech at all four noise levels, silence, white noise, 60 Hz hum, and a click. Warm positive inference was 270–354 ms (median 281.5 ms); noise-only rejection took 3–4 ms. VAD/Whisper warmup took 400 ms in that run.

We also fed the actual TypeScript endpoint 128-sample frames with two seconds of noisy calibration before the word, then ran emitted clips through the final decoder. This is a stricter boundary than isolated ASR clips:

- Previous endpoint emitted a clip for **12/20** cases.
- New endpoint emitted **18/20**; all 18 decoded to the correct spell.
- Clean, +15 dB, and +5 dB each passed **5/5** through endpoint + decoder.
- At 0 dB, **3/5** passed; Expelliarmus and Incendio did not reach endpoint onset. Browser acoustic suppression was not simulated. Equal-power noise remains a demonstrated limitation rather than a passed case.

Local synthetic artifacts and comparison scripts are under `/tmp/wandduel-asr/`: `compare.py`, `compare.json`, `validate.py`, `validated.json`, `endpoint-check.cjs`, `endpoint-before.json`, `endpoint-after.json`, and `endpoint-recognized.json`. No human audio was collected, and no WAV/PCM was committed. To reconstruct the input files on this Mac, use `say -v Samantha -o /tmp/<spell>.wav --data-format=LEI16@16000 '<Spell>'`. Generate white noise with `np.random.default_rng(2419).normal(...)`, scale its RMS to `speech_rms / 10**(snr_db/20)`, and preserve 150 ms leading / 200 ms trailing padding for the decoder comparison. The endpoint experiment instead places speech after 36,000 leading samples and includes 16,000 trailing samples, so calibration and onset run on the same noisy stream.

## Regression verification and physical follow-up

Focused host speech tests passed **25/25**. Web speech tests passed **34/34**, including calibration spikes, background drift, sudden no-speech floor adaptation, continuous capture, canonical confidence rejection with raw diagnostics, repeated helper failure handling, overlap/late cancellation, gap recovery, and future valid casts. Existing browser audio-worklet tests passed **2/2**, checking processed capture requests, contiguous mono 16 kHz frames, timing origins, resource cleanup, and reported post-start loss. The root release report records the final integrated suite.

Remaining physical check: on each intended laptop/browser, use real incantations and gestures in the venue at normal speaking volume, then repeat with nearby conversation and game audio. Keep dev mode enabled to export rejected and accepted transcripts alongside motion windows. Include five attempts per spell, ordinary speech without a cast, gestures without speech, overlapping players, and a brief device/background interruption. Inspect both false rejects and false casts. Synthetic one-voice results do not qualify accents, reverberant rooms, microphone placement, cross-talk, Windows CPU latency, or a browser's actual denoising quality.
