# Multiplayer entry and retained wand pairing

September 19, 2026. Built on `main` at `c523b4a` together with the quick-play recognizer profile, the badge motion dump tool and the keep-alive status route from the same evening. This is local software evidence; no deployment, firmware operation or physical qualification is included.

## Findings and approach

The multiplayer game already has six-character rooms, an authoritative referee, countdown, attack/block/health, video, results and rematches. A replacement multiplayer implementation is unnecessary for this request.

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Keep the sequential setup and only skip practice casts | Smallest UI change, but microphone/setup failures still hide the multiplayer interface | Insufficient for immediate access |
| Open a battle lobby after pairing; keep Ready health-gated | Reuses quick-play recognition, rooms, video and referee; the player can see/join the multiplayer interface before finishing microphone setup | Implemented |
| Continue combat while the game tab is hidden | Background throttling can interrupt sensor/audio evidence and timing; it conflicts with authoritative input-health aborts | Retain pairing, suspend gameplay instead |

The original `DuelController.visibility` called `WandClient.suspend`, which failed the protocol and explicitly disconnected BLE. Separately, the result screen hid recovery controls and recreated the entire controller to reconnect. Both behaviors made a temporary tab switch look like lost pairing.

## Implemented behavior

- After pairing the dark lobby opens by itself. There is no calibration or practice screen: the recognizer's shared quick-play profile is applied the moment the wand streams (and re-applied after any reset), and the microphone is started for the player. Per-player calibration remains in the recognizer for scripted QA only.
- Lobby: visible room code, opponent presence, microphone/camera controls and Ready. Supported wand input, fresh stream, microphone and renderer remain required for Ready; the tutorial shortcut never invents a cast or server health.
- Hiding the laptop page clears fusion/movement evidence, stops speech, sends an unhealthy heartbeat and suspends wand processing/feedback. An active round is aborted without a winner. The physical carrier is retained where available.
- Returning revalidates clocks and one second of fresh movement. A retained BLE session keeps its protocol nonce/next CONTROL sequence because firmware rejects a second OPEN with a new nonce on an already-open link. Actual carrier loss uses the existing bounded reconnect and fresh OPEN. Old browser callback generations remain invalid.
- Recovery can restart the microphone, reconnect the selected wand or reattach the referee session from the lobby/result screen. Expired referee reservations rejoin the same room; a full or expired room still reports failure. A fresh Ready is required; rounds never resume automatically.
- A resumed referee session renews video negotiation even when room membership did not change.

Reuse: extended `DuelController`, `GameClient`, `WandClient` and `BleWandTransport`; reused the existing recognizer profile, session authentication, transport recovery, validation and presentation. New public methods are `reconnectBattle`, `reconnect` and `resume`; searches of their existing classes found the underlying primitives but no equivalent operation retaining both pairing and recovery UI. No new runtime dependency or player QA route was added.

## Any laptop, any iPhone

The hosted phone service mints a pairing room only for a caller presenting the enrollment secret,
and until now that secret had to live on each laptop. A teammate's laptop without it fell back to
the old private-LAN profile and reported `Phone control needs the trusted HTTPS setup.` The
deployed referee now brokers pairing: `POST /api/game/phone/pair`, authenticated by the player's
own game session (which must be a phone session), calls the phone service server-side with the
secret from `WAND_PHONE_SERVICE`/`WAND_PHONE_CREATE_SECRET` and returns the same pair record the
laptop broker would. The browser prefers its laptop's own broker when the launcher holds the
secret (offline and LAN play), otherwise asks the referee, whose health route advertises
`phoneBroker`. A referee without the variables reports `iPhone pairing is not set up on this
referee.` instead of mentioning certificates. Per-session cooldown and an in-flight cap mirror the
laptop broker; the secret never reaches a laptop or the browser.

## Verification

- Frontend unit suite: 183 tests passed, including stale callbacks, retained BLE/phone carriers, bounded recovery, the shared quick-play profile (any-direction jab, held raise, ignored lowering; upstream's DTW matching still applies to calibrated templates), automatic lobby entry, recognizer repair after a foreign reset, referee-brokered pairing and the no-broker explanation, speech/fusion and game-session reattachment.
- Referee suite: 60 passed (rooms by join code, ICE provider, phone broker unit and API behaviour, engine, API); launcher suite: 32 passed.
- Frontend typecheck and production build passed. The existing large-bundle warning remains; no lint command is configured in the web package.
- Browser suite: 29 passed, including the two `multiplayer-entry` specs: a paired scripted badge lands in the lobby at once with no calibration, practice or "join" control; two lobbies in one browser context start a duel, one player hides the tab (duel paused, badge not disconnected, no second chooser), returns, restarts the microphone, loses and reattaches the battle socket, and can Rematch. (One run of the unrelated speech-worklet timing spec failed while the launcher was rebuilding on the same CPU; it passed alone.) Lobby screenshots at desktop and 390 px width showed the dark lobby card with the code, rival status, spell hints, microphone/camera/Ready controls and no horizontal overflow.

The browser fixtures use a protocol-faithful virtual endpoint at the mocked Bluetooth boundary and generated silent microphone PCM. They exercise the production adapter, input client, controller, React interface and local referee. They do not establish real Bluetooth endurance, acoustic recognition or cross-network media behavior.

## Deployment and next work

Cloudflare's configured asset build serves the **phone controller** (`vite.phone.config.ts`); Render runs the **referee** (`render.yaml`). Each laptop still runs `python3 tools/run_game.py` and opens `http://127.0.0.1:5173`, with its own local speech helper. Deploying those two services alone does not update the laptop game interface.

Remaining multiplayer work, in order:

1. Add an actionable camera retry/ICE recovery path. Current video failure only reports a message; a working camera is optional for Ready.
2. Verify opponent cameras and TURN on two actual networks through the deployed referee. In-process camera negotiation and local scripted rooms are not venue evidence.
3. Test the quick-play profile with real voices and physical controllers: correct casts, negatives/nearby voices, defense timing and five complete two-player matches.
4. Qualify physical tab-switch/recovery and a ten-minute loaded session separately for badge and iPhone. Keep badge battery, cold-boot, Windows and two-badge gates separate.

Physical test card: start both laptop stacks; start/join one code; pair each wand (the lobby opens by itself); allow microphones, enable cameras; Ready on both. Switch one laptop to another tab for 15 seconds. Return: same wand should recover without a chooser, both players should see a paused duel, and microphone/Rematch recovery should remain available. Ready again, then verify a real Stupefy/Protego exchange. Repeat with the phone staying foregrounded; separately test phone lock and its explicit Resume flow.

The application no longer deliberately drops a healthy badge for an ordinary laptop tab switch. [Chrome may freeze or discard hidden pages](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), and [background timers can be throttled](https://developer.chrome.com/blog/timer-throttling-in-chrome-88). OS sleep, tab discard/reload, physical Bluetooth loss and hidden/locked iPhone sensing cannot be guaranteed away by this web application.
