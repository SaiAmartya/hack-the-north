# Wandduel teammate setup

Use this guide for the current game, not the superseded Phantom Arena/Lua/gateway instructions.
Commands assume a terminal at the **repository root** unless a block explicitly changes directory.
Initial package/model/browser downloads need internet; this guide does not deploy a service,
change certificate trust, open firewall rules or flash a badge automatically.

**Run `python3 tools/run_game.py` for the hosted release.** Each laptop runs its own
frontend and speech helper; Render runs only the shared referee. Pair a wand first, then
choose **Duel a bot**, **Start a duel**, or **Join with code**. The exact deployed commit,
rollout progress and QA results live in [the solo release record](qa/solo-release.md).
Use `--local-referee` for a single laptop without the hosted referee, or
[Section 4](#4-optional-local-and-lan-referee) to share a local referee between laptops.

## 1. Checkpoint and prerequisites

- Install **Git, Python 3.11 and Node 26.5.0 with npm** on each laptop. Use desktop Chrome;
  physical phones use iPhone Safari. Windows x64 is the target, but full Windows qualification
  is still pending. Do not substitute a newer Python for the documented environment.
- Each player needs their own laptop microphone and one phone or qualified BLE badge.
  Voice stays on that laptop; the phone requests motion access only.
- The current firmware source is **0.3.0**, with five-spell display and LED feedback.
  **WAND-B602 is flashed with 0.3.0; all 48 self-tests and BLE validation passed.**
  Flash other badges separately. See [firmware evidence](qa/firmware-0.3.0.md) and
  [installation and recovery](../firmware/README.md) for the image and remaining physical checks.
- iPhone recognition has been rebuilt, but real held-out movement/speech testing is pending.
  Internet relay has an unresolved intermittent 500 ms freshness failure. Prefer the direct
  route for the next physical test; do not describe either input as fully qualified yet.
- The public phone service provides phone pairing. The hosted referee can broker the pair
  without an enrollment secret on each laptop. Sai's laptop also has approved local phone
  defaults saved; Section 3 covers both routes.

Clone, or update an existing checkout without discarding local work:

```sh
git clone https://github.com/SaiAmartya/hack-the-north.git
cd hack-the-north
git status --short --branch
```

For an existing clean `main`, use `git pull --ff-only origin main`. Stop and inspect if Git
reports divergence or local changes; do not reset or force-push. Make further edits on a
feature branch. Keep virtual environments, models, credentials, flash backups and build
artifacts out of commits.

After a team update, pull `main` and restart the launcher on **every laptop**. Render updates
only the referee; it does not update anyone's local frontend, speech helper or running tab.

## 2. Install each laptop and start locally

### macOS

```sh
node --version
python3.11 --version
python3.11 -m venv apps/host/.venv
apps/host/.venv/bin/python -m pip install -e './apps/host[dev,speech]'
cd apps/web
npm ci
cd ../..
python3 tools/run_game.py
```

### Windows PowerShell

```powershell
node --version
py -3.11 --version
py -3.11 -m venv apps/host/.venv
.\apps\host\.venv\Scripts\python.exe -m pip install -e './apps/host[dev,speech]'
Set-Location apps/web
npm.cmd ci
Set-Location ../..
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py
```

No virtual-environment activation or PowerShell execution-policy change is required.
These commands start this laptop's speech helper and frontend and connect them to the shared
hosted referee. The Python environment installed above supplies the local runtime dependencies.
Both teammates use the same commands; the referee keeps their game rooms together.

The first launch downloads the pinned `faster-whisper base.en` weights once, outside the repo
(`.cache/wand-speech/faster-whisper-base.en` under your home directory), by running
`tools/setup_speech.py` for you; running `setup_speech.py --model-dir <dir>` yourself beforehand
is optional. The runtime loads only local files, uses CPU INT8 and keeps audio in memory. If you
choose a different model **directory**, pass that same path with `--speech-model` to every launch
(a missing directory is provisioned the same way); the model/revision itself must remain the
pinned one. Each laptop needs its own model.

Wait for **Game ready: http://127.0.0.1:5173**, then open that exact URL in Chrome.
A tab typed as `localhost:5173` is redirected there automatically; the hosted phone service
accepts the laptop's connection only from that exact origin. A random port or a LAN URL is
still wrong: permissions/origin checks are scoped to the selected origin. Startup verifies the
frontend, referee and warm speech worker; it is not a declaration that physical calibration or
multiplayer has passed.

On the page, **each player pairs a badge or iPhone first**. Once connected, choose **Duel a bot**
for a full solo match against the Practice Wizard, or **Start a duel** and share its six-character
code with a teammate who selects **Join with code**. Solo uses the same five spells, HUD,
cooldowns, damage, effects and result screen. The human still uses their own wand and laptop
microphone. The bot readies with you; **Ready** starts the normal countdown, and **Rematch**
starts another round after a result. No duel room or player slot is reserved just to pair a wand. The referee keeps
one room per code; solo rooms cannot be joined by another human. An empty room expires after
ten minutes. **Leave duel** returns to room selection while keeping the connected wand.

Say the exact incantation while moving the wand. Attack spells use a firm jab; support spells
use a raise and hold. Cooldowns are independent, so a different ready move can follow immediately.

| Spell | Movement | Result | Cooldown |
| --- | --- | --- | --- |
| Stupefy | Firm jab | 20 damage | 2 s |
| Protego | Raise and hold | Block one hit within 1.2 s | 3 s |
| Expelliarmus | Firm jab | 10 damage and 1 s offensive lock | 6 s |
| Incendio | Firm jab | 30 damage | 8 s |
| Episkey | Raise and hold | Restore up to 18 HP | 12 s |

Everyone starts with 100 HP. Healing cannot exceed 100 HP; a full-health attempt spends no
cooldown. Shielding and healing remain available while disarmed. Zero HP ends the duel;
at the 60-second deadline higher HP wins, with equal HP or simultaneous knockouts producing a draw.

The default launcher builds a stable temporary frontend snapshot. Source edits do not replace
a running session. **Ctrl+C**, wait for shutdown, then rerun after updates. `--dev` opts into
hot reload for engineering only. Rerunning the launcher first stops a stack it started itself
(tracked in `launcher.pid` beside the `launcher.json` described in Section 3); it refuses ports
held by anything else instead of killing unrelated processes and stops its children on startup
failure.

| Service | Default address | Responsibility |
| --- | --- | --- |
| Player frontend | `127.0.0.1:5173` | UI; tightly scoped game, speech and phone proxies |
| Hosted referee | `https://wandduel-referee.onrender.com` | Authoritative solo and two-player rooms |
| Optional local referee | `127.0.0.1:8000` with `--local-referee`, or laptop A's selected private IP | The same game rules without the hosted referee |
| Speech helper | `127.0.0.1:8001` | Only this laptop's audio; per-launch authentication |

## 3. Connect an iPhone

For normal hosted play, the referee brokers QR pairing; **start with the numbered steps below**.
Saved approved local phone-service defaults take precedence when present; Sai's laptop already
has them. The following optional setup is for a laptop that needs its own pairing broker,
including the local/LAN referee profile. Ask Sai/the service owner for the
**existing** enrollment-secret file through an approved private channel. Store it outside the
repository, readable only by your user. On macOS the launcher requires mode `0600`; on Windows
restrict the file's Security permissions to its intended owner. Do not paste the value into
commands, chat, screenshots, `.env`, URLs or logs. Generating a new local value will not match
the service. A plain launcher stack that is still running is stopped automatically when you
rerun the launcher. The following paths are examples for that privately delivered file; they
do not create it.

macOS, from the root:

```sh
wandPhoneSecret="$HOME/.config/wandduel/phone-enrollment-secret"
chmod 600 "$wandPhoneSecret"
python3 tools/run_game.py --save-defaults --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file "$wandPhoneSecret"
```

Windows PowerShell, from the root:

```powershell
$wandPhoneSecret = Join-Path $env:USERPROFILE '.config/wandduel/phone-enrollment-secret'
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py --save-defaults --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file $wandPhoneSecret
```

`--save-defaults` writes only the service origin and the secret file's **path** to `launcher.json`
under `~/.local/share/wandduel/` (or `$XDG_DATA_HOME/wandduel`) on macOS and
`%LOCALAPPDATA%\wandduel\` on Windows; the secret itself stays in your private file. From then on
a `tools/run_game.py` run uses those phone defaults, `--no-phone` ignores them for one run and
`--badge-only` also skips them. The same command starts the stack, so continue below.

1. On the laptop choose **Connect iPhone**. Scan its fresh QR with the phone camera and open
   the controller in **Safari**. Tap **Connect wand**, allow motion, and approve the matching
   number on the laptop. No phone microphone/camera capture is requested by the controller.
2. Keep the phone unlocked and Safari foregrounded. Use the same Wi-Fi for the direct route.
   The phone tries direct data-only WebRTC first; after a failed ten-second preflight, select
   **Use internet connection** only if you want the cloud motion relay. It never silently
   changes route during play. Internet is needed for initial QR pairing/signalling either way.
3. Move gently. Check **Sensor active** and **Reaching laptop** on the phone. If either fails,
   open Connection details; socket connection alone does not mean valid motion is arriving.
4. Once the wand streams, choose **Duel a bot**, **Start a duel**, or **Join with code**.
   Allow the laptop microphone and give it
   two seconds of quiet for automatic noise calibration. Hold the wand comfortably still
   briefly so the shared motion profile can anchor its resting pose; it re-anchors from
   stillness during play. A firm jab plus the exact spoken incantation chooses one of the
   three attacks; a raise and hold plus speech chooses Protego or Episkey. Lowering alone
   casts nothing. Choose **Ready** when wand and voice are ready.

Switching laptop tabs retains the selected wand where available, pauses input and aborts an active
duel. Returning checks fresh input; microphone and battle recovery stay available in the lobby.
Locking/hiding Safari pauses input; use its foreground **Resume** action. Recovery cannot
resume an aborted round or deliver buffered casts. Reloading either endpoint needs fresh QR
approval. Phone Connection details offers an explicitly requested, sanitized last-minute trace;
it excludes audio/video, transcripts, credentials, addresses and persistent device IDs.

The older private-LAN HTTPS profile is optional diagnostic infrastructure, not the default.
It requires separate certificate/trust and LAN-exposure approval; see the
[workflow](../.agents/skills/wand-dev-workflow/references/workflow.md#3-optional-private-lan-phone-session).
Do not tunnel the game, referee or speech helper publicly.

## 4. Optional local and LAN referee

For solo play without the hosted referee, run `python3 tools/run_game.py --local-referee`.
For two laptops on a LAN, laptop A runs the referee and laptop B points at it. Running
`--local-referee` independently on both creates separate room lists, so their codes will
not match. Phone QR setup still requires internet;
badge play can use the LAN after dependencies and speech models are installed. Finish
installation on **both** laptops. Use the same approved private network and get approval
before exposing laptop A's referee or adjusting a narrowly scoped firewall rule. Do not disable
the firewall, bind a wildcard/public interface or add router forwarding. Replace the example
`192.168.1.20` below with laptop A's actual selected private IPv4 address.

Stop each existing single-laptop stack. For phone input, retain each laptop's private
`wandPhoneSecret` variable from Section 3.

macOS — run the appropriate command on each laptop:

```sh
# Laptop A: frontend and speech stay local; referee listens on this private IP.
apps/host/.venv/bin/python tools/run_game.py --referee-bind 192.168.1.20 --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file "$wandPhoneSecret"
# Laptop B: its own frontend and speech, but no second referee.
apps/host/.venv/bin/python tools/run_game.py --referee http://192.168.1.20:8000 --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file "$wandPhoneSecret"
```

Windows PowerShell — run the appropriate command on each laptop:

```powershell
# Laptop A
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py --referee-bind 192.168.1.20 --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file $wandPhoneSecret
# Laptop B
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py --referee http://192.168.1.20:8000 --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file $wandPhoneSecret
```

Mixed Mac/Windows is configured the same way, but still needs qualification. Start A before B.
Each player opens **their own** `http://127.0.0.1:5173`, pairs their own phone, and uses their
own microphone. Neither player browses to the other laptop's frontend. Speech never proxies
to A; only game/referee traffic does. Wi-Fi peer isolation can block the direct phone motion
connection; the phone offers an explicit Internet fallback.

For badge input, replace the two `--phone-*` options on that player's launcher
with `--no-phone` (saved phone defaults would otherwise still apply) and select Connect badge.
Badge-only qualification can use `--badge-only` instead, which also skips them.
A badge on a diagnostic image cannot pass Ready. The manual handoff uses the current 0.3.0
image and its physical checks; keep the browser gates intact.

## 5. Hosted referee release

The hosted rollout is authorized. Check [the solo release record](qa/solo-release.md) for
the verified live commit and deployment/QA status before a team session. Teammates should
pull the matching `main` build and restart their local launcher after an update.

The team referee is deployed at **https://wandduel-referee.onrender.com** from
[`render.yaml`](../render.yaml). A plain `tools/run_game.py` uses it: each laptop runs only its
own frontend and speech helper, and only game traffic (`/api/game`, `/ws/game`) leaves the
laptop, over HTTPS/WSS through the local proxy. The referee also brokers phone pairing;
phones keep using the public phone service. Render does not host the player frontend or speech.
A single laptop can duel the Practice Wizard;
two laptops with internet can duel after each pairs a wand and one shares a new duel code.

No Render account is needed to play. `--local-referee` opts out for one run (offline, the LAN
setup in Section 4, scripted QA). `--referee https://<other> --save-defaults` points at
another deployment from then on; `--local-referee` still overrides it.

### What Render's free tier means for demos and QA

The referee is a Render **free web service**: 0.1 shared CPU, 512 MB, one instance, no card,
no uptime guarantee. Checked against Render's documentation on September 19, 2026:

- **It would sleep after 15 minutes without inbound traffic and take about a minute to wake**,
  so a keep-alive Worker ([`apps/referee-keepalive`](../apps/referee-keepalive/wrangler.jsonc),
  a Cloudflare cron trigger on the team account) fetches its health route every ten minutes
  and it normally never sleeps. Its last run is shown at
  <https://wandduel-referee-keepalive.saiamartya19.workers.dev/> (a timestamp older than
  ten minutes means the schedule stopped). If that Worker is ever removed, the launcher still copes: it
  wakes the referee before printing `Game ready`, pings it every four minutes while a stack
  runs, and player heartbeats keep it awake during play. Either way, **start both laptops'
  stacks a couple of minutes before a demo and leave them running.**
- **750 instance-hours per month, counted only while awake.** Kept awake around the clock the
  referee uses about 720–744 of them, which fits, but only if it stays the **only free web
  service in the Render workspace**; a second one would exhaust the pool and Render then
  suspends every free service until the next month. Redeploy the keep-alive Worker with
  `npm run deploy` in its directory after `wrangler login`; delete it in the Cloudflare
  dashboard (Workers → wandduel-referee-keepalive) to let the referee sleep again.
- **5 GB outbound per month.** A match is roughly 40 KB/s of snapshots, about 150 MB per hour
  of continuous play, so this covers tens of hours of matches. Nothing else is served from the
  referee. Exceeding it without a card on file suspends the service until next month.
- **Every deploy or restart drops every live socket and every room** (rooms live in memory).
  `autoDeploy` is off in the blueprint, so Render deploys only when someone clicks Deploy: do
  that between matches, never during a demo. If a match aborts with "Game disconnected",
  both players start a new duel with a fresh code.
- **Latency:** region Ohio, measured 50–80 ms round trip from Waterloo, far inside the 1.5 s
  heartbeat timeout. Several simultaneous duels are fine; a dozen could jitter the 50 ms tick
  on the shared CPU.
- **The join code is the access control.** The referee's origin check is only a browser
  header; the code (about a billion possibilities, expiring rooms, a 32-room cap) is what keeps
  strangers out of a duel.

### Hosted demo checklist

1. Check the verified deployment in [the release record](qa/solo-release.md). On each laptop,
   pull `main`, stop the previous launcher with **Ctrl+C**, and restart it. Deploy between matches.
2. Both laptops: `python3 tools/run_game.py` two minutes early. Confirm `Game ready` and the
   `Hosted referee:` line, then leave the terminals open.
3. Pair each wand first and allow each laptop microphone. For solo, choose **Duel a bot**
   and **Ready**. For two players, A selects **Start a duel**, B selects **Join with code**,
   then both choose **Ready**.
4. After game-over, choose **Rematch** or **Leave duel** to keep the wand and pick
   another mode. If Render is unreachable, fall back to Section 4 over a hotspot.

### Redeploying or hosting another copy

`render.yaml` describes the service. In Render choose **New → Blueprint**, pick the
repository and branch, and wait for the health check `/api/game/health`. Point laptops at that deployment with
`tools/run_game.py --referee https://<name>.onrender.com --save-defaults`.

### No account at all: tunnel laptop A

For a rehearsal without deploying anything, laptop A starts a local referee:

```sh
python3 tools/run_game.py --local-referee
```

In a second terminal on laptop A, expose that referee with a Cloudflare quick tunnel
(no account, no uptime guarantee, development use):

```sh
cloudflared tunnel --url http://127.0.0.1:8000
```

Laptop B then runs `tools/run_game.py --referee https://<random>.trycloudflare.com` with the
printed hostname. Laptop A must stay up for the whole session.

## 6. Repeatable checks and useful failure reports

Install the test browser once (not needed merely to play):

```sh
cd apps/web
npm exec playwright install chromium
cd ../..
```

PowerShell: use `Set-Location` in place of `cd` if preferred and `npm.cmd` instead of `npm`.
From the root, run `apps/host/.venv/bin/python tools/qa_game.py` on macOS, or
`.\apps\host\.venv\Scripts\python.exe .\tools\qa_game.py` on Windows. It runs host/tooling
tests, frontend typecheck/tests/build and browser tests. QA servers use loopback `15173`/`18000`
and do not replace a running stable session. This is software evidence, not physical input QA.

The phone Worker has a separate local suite if you edit it. First run `npm run build:phone`
from `apps/web` to generate its ignored `apps/phone-relay/public` assets. Then, from
`apps/phone-relay`, run `npm ci`, `npm test`, and `npm run typecheck` (`npm.cmd` on Windows).
No deployment or account login is needed to run those checks.
For an explicitly approved live-service rehearsal, use the v2 script and its evidence limits
in [the input rebuild report](qa/input-rebuild.md).

| Symptom | Next check |
| --- | --- |
| No `Game ready` / speech unavailable | Keep the first startup error. Verify Python 3.11 environment, speech extra, pinned model path (internet is needed for its one-time download) and free ports. Do not start a second partial stack. |
| `DLL load failed` / native dependency error on Windows | Capture only the package/error and Python/architecture versions. Windows runtime setup needs qualification; do not substitute cloud speech or remove health gates. |
| `iPhone pairing is not set up on this referee.` or `Phone connection unavailable` | Check the deployed commit in the release record, the referee selected by the launcher and internet access. For a local broker, check both phone-service flags (or saved defaults) and the existing credential file permissions. Hosted referee pairing requests have a two-second retry cooldown after success or failure (`Wait a moment, then reconnect`). Never print the credential. |
| Laptop shows `Connection interrupted. Reconnecting…` after Connect iPhone and never recovers | Check the address bar: the game must be open at `http://127.0.0.1:5173`. The hosted phone service refuses the laptop's connection from any other origin, `localhost:5173` included; the frontend now redirects such a tab to the exact origin, so close or reload an older tab. If the origin is already correct, report route and last failure from Connection details. |
| Certificate warning | The selected phone URL must be the public HTTPS service, not a stale LAN-IP bookmark. Start from a fresh QR; do not bypass TLS warnings. |
| Direct connection unavailable | Check venue peer isolation; explicitly try Internet if desired. Its intermittent freshness failure is still open. Do not loosen timing limits. |
| Sensor active, but no Reaching laptop | Report route, received rate, age and visible last failure from Connection details. Export a trace only deliberately. |
| Spells not recognized | Say the exact spell while jabbing for Stupefy, Expelliarmus or Incendio, or raising and holding for Protego or Episkey. Allow quiet microphone setup and briefly hold the wand still first. The shared profile accepts any firm jab direction; a weak wobble or a slow tilt is ignored. Report the failed move and visible message. |
| Badge missing after a cold boot | Check the installed image and the 0.3.0 manual flash/physical QA handoff. Earlier 0.1.x images may boot with BLE disabled. Capture `id`/`status` for the failing device instead of repeatedly reconnecting. |
| Badge says firmware needs repair / diagnostic INFO only | Follow the current firmware handoff and report the installed version/profile. A diagnostic image cannot become playable by changing browser capability gates. |
| Laptop says Reconnecting your badge… | Normal bounded auto-reconnect after a dropped link (up to three per minute). If it ends in Reconnect badge, press it once; if that fails, power-cycle the badge and report `status`. |
| `No duel with that code.` | The code was mistyped, the room sat empty for ten minutes, or the two laptops point at different referees. Compare the referee printed at `Game ready` on both laptops, then start a new duel and share the fresh code. |
| `Waking the hosted referee…` then `readiness timed out` | The free instance takes about a minute to wake; rerun once. If it repeats, open `https://wandduel-referee.onrender.com/api/game/health` in a browser and check the Render dashboard for a failed deploy. Without internet, run `--local-referee` (single laptop) or Section 4 (LAN). |
| Port occupied | A stack started by this launcher is stopped automatically on the next run; anything else holding `5173`, `8000` or `8001` must be stopped by whoever owns it. Do not kill every Node/Python process or print full process environments/arguments. |

Follow the [solo release and manual QA handoff](qa/solo-release.md) for the current build;
the [final-sprint report](qa/final-sprint.md) retains earlier verification evidence.
Report **commit/build · route/devices · failed step · expected → observed · visible message**.
That report separates scripted results from actual microphone, phone, badge and two-laptop evidence.
