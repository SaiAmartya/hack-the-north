---
name: wand-dev-workflow
description: Plan, build, or run Harry Potter battle-platform QA in this repository using deterministic wand replay, an iPhone motion surrogate, and later real BLE badges. Use for platform development, human test cards, phone setup, input regressions, and firmware integration; not firmware implementation or unrelated repository edits.
---

# Sai's wand development workflow

Use this repository-local skill to keep the game testable before firmware arrives and guide Sai through short physical QA sessions. Invoke explicitly with `$wand-dev-workflow`; relevant workspace development tasks should load it via the root `AGENTS.md`.

## Establish the stage

1. Inspect the branch, existing changes and actual implementation. Do not mistake the plan for working software. At this skill's creation, the repo still contained the legacy game; the new Device Lab, virtual endpoint, local speech helper and iPhone controller were unbuilt.
2. Read the current [MVP outline](../../../MVP-OUTLINE.md) for gameplay scope, [implementation plan](../../../IMPLEMENTATION-PLAN.md) for the approved slices/architecture, and [firmware contract](../../../BADGE-FIRMWARE-CONTRACT.md) for device behavior. Those documents, not duplicated packet definitions here, are authoritative.
3. For platform/input planning, phone setup, physical QA or hardware handoff, read [the operating procedure](references/workflow.md) completely. For a purely cosmetic change, preserve these boundaries without running an unnecessary physical test session.
4. State what this turn will change/test and what requires Sai. A planning or diagnostic request does not authorize implementation or device/security changes.

## Preserve the testing boundary

- Use **iPhone Safari as the only required physical surrogate**. Do not reintroduce Android, USB debugging or a native phone app as a prerequisite. Keep deterministic virtual/replay tests on the computers; "iPhone-only" does not mean moving the whole game or automated test suite onto the phone.
- Use trusted private-LAN HTTPS + same-origin WSS for live iPhone motion. Keep voice/video on the laptop. Voice means browser-owned PCM timing/endpointing plus that laptop's fixed-loopback `faster-whisper base.en` CPU-`int8` helper; do not substitute Web Speech, cloud ASR or phone audio. Explain certificate trust and get approval before installing tools/certificates, changing firewall/trust settings or exposing a dev server. This skill authorizes none of those actions itself.
- Retain `BleWandTransport` and `VirtualWandTransport` above the same protocol-faithful boundary. Phone motion feeds the virtual endpoint, never direct spell/cast injection. Preserve clock alignment, raw gravity acceleration, gap/age checks, bounded queues, feedback expiry and source labels.
- Qualify the actual iPhone's cadence, gaps, sync and round-trip behavior before relying on live results. Do not manufacture 50 Hz readings, weaken timing gates, use phone-only gyro features or transfer its calibration to the badge.
- Separate evidence: deterministic checks; measured iPhone interaction + real laptop speech; real badge/BLE hardware acceptance. No phone can certify badge sampling, radio, LEDs or battery life.

## Work with Sai

Follow the current procedural checkpoint in the approved [IMPLEMENTATION-PLAN.md](../../../IMPLEMENTATION-PLAN.md) without leapfrogging its gates, run repeatable checks, then give a short human test card: build/source/device, prerequisites, exact actions, expected results and the smallest opt-in diagnostic needed if it fails. Start gameplay with Stupefy/Protego and a scripted ordinary second client. Record once and replay motion/timing failures; raw audio and transcripts are excluded from default traces, so do not claim a replay reproduces acoustic conditions it did not capture.

Keep the user's branch/review/commit safety floor. If stage skills are available, use `dev-build`, `dev-review` and `dev-verify` only for their respective stages. Otherwise preserve the same scoped plan, independent review and evidence-backed verification boundaries. Do not claim a cross-model review or physical test that did not happen.

Finish with what changed, checks actually run, a short next QA card if runnable, and remaining hardware gates. Leave changes uncommitted until Sai explicitly requests a reviewed commit; remote writes and flashing require separate explicit approval.
