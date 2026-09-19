# AI build log

The OpenAI prize asks what you built with the API and how coding agents helped. This file is
the honest record. Fill in the Codex section with what your team actually does; do not claim
tool use that did not happen.

## What the OpenAI API does in the product

* `laptop/phantom_host/deck.py`: `chat.completions` with `response_format=json_object` writes
  the encounter deck into a closed schema (4 triggers, 4 mechanic types, bounded numbers,
  ASCII flavour text). The badge runs the director; the model only authors cards.
* `laptop/phantom_host/narrator.py`: the live commentator reacts to the real event log with a
  compact, non-identifying state summary, one or two sentences at a time, rate limited to one
  call per ~7 s, with a templated fallback so an outage never silences the demo.

## How an agent built the repo (this session)

The badge and laptop code in this repository were produced with Claude Code (Anthropic) in a
single session, working from the official badge guide (the `AGENTS.md`-style document shipped
with the Badge IDE, which is written as instructions for coding agents). The workflow that made
it reliable:

1. Read the guide end to end and extract the constraints: no `pcall`/`setmetatable`, 44-byte
   frames, 250 ms tick budget, 48 KiB Share cap, `badge.fs` relative paths, single-file import
   format.
2. Build a simulator that enforces those constraints (`laptop/badge_sim`), so the agent could
   run the real Lua instead of guessing.
3. Write the game, then let the tests find the bugs. Things the tests caught that a human would
   have found on stage: a shim ordering bug, a locale-dependent `%w` pattern that would have
   mangled non-ASCII names differently on the badge, a snapshot arriving before a heartbeat
   suppressing the "joined" line, the menu cursor not resetting between opens, and a two-line
   log that scrolled the enrage message off screen during a decree.
4. Measure sizes and bytecode, and cut the app by a fifth when the first version would have
   been too big for the Lua quota.

## Codex (fill in)

Suggested use during the event: open this repo in Codex, point it at
`badge/phantom_arena/main.lua` and `laptop/tests/test_badge_app.py`, and ask for one change at
a time (a new spell, a tuned threshold, a new decree type), then run `uv run pytest`. Keep the
log below.

| When | Ask | What Codex changed | Tests after |
|---|---|---|---|
| | | | |

One concrete sentence for the demo: "Codex added ___ and the simulator suite confirmed eight
badges still agreed on the host in ___ seconds."
