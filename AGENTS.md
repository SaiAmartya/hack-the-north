# Repository development workflow

For Harry Potter battle-platform planning, implementation, input testing or firmware integration, read and follow [.agents/skills/wand-dev-workflow/SKILL.md](.agents/skills/wand-dev-workflow/SKILL.md). It is Sai's repo-local workflow; explicit invocation is `$wand-dev-workflow`. Do not load it for unrelated edits.

Use iPhone Safari for physical surrogate testing, deterministic replay for repeatable checks, and real badges for hardware qualification. The skill is an operating procedure, not proof that its planned harness exists.

Keep development on a feature branch/worktree. Preserve existing changes. Do not commit until Sai explicitly requests it after diff review; push, deployment, certificate/device trust changes and firmware flashing require their own explicit approval. Never expose or commit secrets.

## UI design system

For any user-facing UI or visual work, read and follow [DESIGN_SYSTEMS.md](DESIGN_SYSTEMS.md). Use **Wizarding Workshop** for setup, Device Lab, calibration and practice; preserve the dark, video-first **Enchanted Mirror** for live duels. Keep diagnostics and implementation labels evidence-true: a visual treatment must never imply that an unbuilt feature or pending gate works. Do not introduce external fonts, network assets or copied third-party/franchise visual assets.
