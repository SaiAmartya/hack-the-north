# QA reports

Current evidence, read these first:

- [motion-recognition-debugging.md](motion-recognition-debugging.md) — active investigation of inaccurate spell detection: confirmed classifier/test defects, transport-vs-classifier diagnosis, experiment log, and remaining physical gates.
- [input-rebuild.md](input-rebuild.md) — phone sessions, recognizer v3, badge auto-reconnect, repeatable checks and the next physical card.
- [firmware-0.2.0.md](firmware-0.2.0.md) — firmware 0.2.x change record: why the badge was invisible and why every sample was rejected, the flash record, the 0.2.1 brownout soft start, and the physical QA card.

Historical records (superseded; kept for the measurements they contain):

- [firmware-0.1.8-matrix.md](firmware-0.1.8-matrix.md) — eight-row sensor profile comparison on the 0.1.8 diagnostic image.
- [physical-gesture-analysis.md](physical-gesture-analysis.md) — the first recorded iPhone trace and why recognizer v2 rejected it.
- [game-platform.md](game-platform.md) — platform checkpoint before the input rebuild: setup fixes, the exact-upstream `6a50929` badge blocker and that day's automated counts.
- [connectivity-stabilization.md](connectivity-stabilization.md) — repaired clock/relay lifecycle, phone onboarding, and 0.1.x firmware review/app-only flashing of WAND-B602; the badge was still no-ship for gameplay.
- [device-lab-stage-1.md](device-lab-stage-1.md) — the first Device Lab checkpoint (`device-lab-01`): codec, virtual endpoint and replay controls before speech, phone pairing or combat existed.
- [firmware-reliability.md](firmware-reliability.md) — physical-badge reliability QA card from the 0.1.x era (self-test, six faces, transport soak, screen/LEDs, battery).
- [firmware-integration-review.md](firmware-integration-review.md) — review of the 0.1.0 baseline and the 0.1.1/0.1.2 remediation, superseded by the connectivity investigation.
- [firmware-main-6a50929.md](firmware-main-6a50929.md) — review and diagnostic flash of the teammate's exact `6a50929` image: it booted but failed live BLE OPEN.
- [firmware-build-0.1.1.md](firmware-build-0.1.1.md) — 0.1.1 build manifest for the first hardware check.
- [firmware-build-0.1.2.md](firmware-build-0.1.2.md) — 0.1.2 build manifest, superseded after a battery-only boot loop.
