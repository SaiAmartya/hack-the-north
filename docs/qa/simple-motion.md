# Dev-mode simple motion — September 20, 2026

## Scope and decision

Sai requested an immediate opt-in fallback: a recognized spell name plus a direction-independent acceleration spike. Speech still selects one of the five spells. The default typed jab/raise path remains available and unchanged. No firmware, protocol, referee, spell balance or ASR model change is required.

The homepage/paired menu exposes **Simple motion** only while **Dev mode** is on. It defaults off, cannot change inside a room, and turns off with Dev mode. Mode changes discard outstanding input. Spell cards and tutorial wording use “move” in this mode rather than demanding a jab or held raise.

## Implementation and reuse

- `controller.ts` reuses the accepted raw `WandClient` sample stream, existing speech callbacks, `CastFusion`, server cast commands, lifecycle resets and bounded telemetry. The ordinary classifier runs in parallel for diagnosis; its `gesture.shadow` results cannot cast or block simple motion.
- `input/spike.ts` is a small separate detector because the existing `MotionRecognizer` combines direction/hold classification with segmentation. It emits directionless evidence without pretending that movement identifies a spell. It uses changes in the acceleration vector, including gravity; rotation can therefore count as movement.
- `fusion.ts` accepts spike evidence only when explicitly enabled. The existing 350 ms interval-gap, two-second combined interval, one-second transcription-result deadline, three-second pending expiry and evidence IDs remain. In this mode, later unverified noise cannot erase a confirmed incantation. At most one confirmed incantation waits; subsequent onsets do not queue commands.
- Telemetry distinguishes `speech+acceleration-spike`, ordinary `speech+motion`, and developer clicks. Exports identify the active profile. Raw input and original classifier diagnostics remain local for the next typed-mode investigation.

## Running verification notes

- Final web typecheck passed; all **312 web unit tests** passed (`npm run typecheck`, `npm test`). Initial proxy-test failures were loopback sandbox restrictions; the complete rerun with loopback access passed.
- **Four affected Playwright scenarios passed**: Dev-only simple motion, recorded-badge ordinary Protego, ordinary tutorial/telemetry and wand-first homepage. Command: `npm run test:e2e -- --grep 'dev-only simple motion|recorded badge raise|developer mode teaches|homepage requires'`.
- New browser scenario passes the same raw sideways pulse through BLE packet decoding, the real detector, fusion and local referee for all five recognized spell names, with exactly one accepted acknowledgement apiece. Speech recognition alone is scripted; no spell-card clicks or direct server cast injection. Speech-only and movement-only attempts submit no cast. Healing follows genuine bot damage (80 → 98 HP). Toggle gates and telemetry profile/source labels are asserted.
- Desktop/mobile homepage and battle screenshots were inspected: controls fit at 390 px without overflow, five cards use MOVE + SPEAK, and the existing battle/HUD composition remains intact. Files: `/tmp/wandduel-simple-home.png`, `/tmp/wandduel-simple-mobile.png`, `/tmp/wandduel-simple-battle.png`.
- Fresh read-only review caught an old-spike expiry clearing a newer valid spike. The fix prunes stale motion separately from the pending word; the exact 0 ms / 2900 ms spikes plus 3100 ms speech regression passes. Final independent review: patch correct, no remaining findings.
- The owned stack was rebuilt/restarted with `python3 tools/run_game.py --referee https://wandduel-referee.onrender.com`. Frontend returns HTTP 200; local speech reports ready/warm/worker available; the existing referee reports multiplayer ready. The live production build was inspected through computer use, with both Dev mode and Simple motion enabled in a fresh tab. The previous results/telemetry tab was preserved.
- Origin/main was fetched and still matched the base commit `c94e64b`; no teammate changes needed reconciliation. This was the uncommitted fallback checkpoint; the later release includes this work together with the normal-mode timing fixes.

The detector requires acceleration-vector change of 200 mg for at least 20 ms, uses a 120 ms moving baseline, and rearms after 180 ms below 75 mg. It retains the <=200 ms sample-age and <=150 ms gap boundaries, sample flags and continuity checks. It intentionally accepts direction changes and reorientation; it does not infer intent.

Private recording replay found movement during all 20/20 supplied Protego trials and 9/10 Incendio trials; the last Incendio still contains no detected movement. Whole-session movement counts include lowering/repositioning. The Still capture produced four spikes across rest/settle/one completed Move window/an interrupted countdown; four of five completed Still Move windows stayed silent. These recordings helped set the behavior and are not an independent physical accuracy measurement.

A counterfactual replay of the latest live export preserved all 550 raw samples and the controller's six onset/four discard callbacks in receipt order, plus its one accepted Stupefy transcript. The new mode produced **exactly one fused Stupefy** at the original result arrival, using the previously vetoed movement (318174.85–318195.85 ms), with no duplicate after subsequent noise. This is software replay evidence, not a cast that occurred in the original match. No private exports, transcripts or device identifiers were added to the repository.

## Remaining typed-mode investigation

The subsequent [normal-mode timing pass](normal-input-timing.md) addresses gesture pre-roll, acquisition-clock shape timing and capture-time inference arbitration. Its wider pairing limits apply only to typed mode; the Simple motion limits above remain unchanged. Verification below describes the earlier fallback checkpoint.

The previous report, [live Stupefy diagnosis](live-stupefy-diagnosis.md), identifies a stale remembered guard direction vetoing a later strong jab and a separate delayed noise-onset race. This fallback avoids the classifier veto and protects confirmed words in simple mode. It does not establish that normal-mode gesture recognition is repaired.

The next narrow typed-mode experiment is to expire only the old angle-based jab veto two seconds after guard confirmation, keeping explicit downward-return rejection. The missing negative is a forceful lowering after holding a guard longer than two seconds. Broadly removing return suppression already introduced extra activations in earlier replays. Capture-time inference arbitration also remains a normal-mode follow-up.

## Physical QA card

1. Refresh the restarted local game; enable Dev mode, then Simple motion before entering a room. Pair the badge and enable the laptop microphone. Enter Duel a bot.
2. Say each spell while making one small, brisk movement in any direction, then let the wand settle. Do not click the spell cards. Test Episkey after taking damage and respect each spell's cooldown.
3. Say a spell while keeping the wand still; then move silently after that attempt expires. Neither should cast. Try a repeated movement during one spoken spell: expect at most one cast.
4. Verify Protego creates a shield, Stupefy/Incendio cause damage, Expelliarmus disarms and Episkey heals. Export telemetry if a recognized spell plus motion still fails.
5. Leave the duel and switch Simple motion off to compare the original jab/raise system. Its remaining defects are still open.

No firmware flash is needed. Scripted recognition/replayed sensor samples verify software behavior, not real microphone accuracy or fresh badge/phone qualification.
