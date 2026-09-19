# Wandduel teammate setup

Use this guide for the current game, not the superseded Phantom Arena/Lua/gateway instructions.
Commands assume a terminal at the **repository root** unless a block explicitly changes directory.
Initial package/model/browser downloads need internet; this guide does not deploy a service,
change certificate trust, open firewall rules or flash a badge automatically.

## 1. Checkpoint and prerequisites

- Install **Git, Python 3.11 and Node 26.5.0 with npm** on each laptop. Use desktop Chrome;
  physical phones use iPhone Safari. Windows x64 is the target, but full Windows qualification
  is still pending. Do not substitute a newer Python for the documented environment.
- Each player needs their own laptop microphone, camera and one phone or qualified BLE badge.
  Voice stays on that laptop; the phone requests motion access only.
- The current firmware source is **0.2.0**, the first gameplay-profile image (50 Hz/±8 g, radio on after
  every reset, measured-gap discontinuity instead of the sensor's overwrite flag). It is built but must
  be flashed and physically QA'd per [the 0.2.0 change record](qa/firmware-0.2.0.md) before a badge is
  called qualified. See [firmware installation and recovery](../firmware/README.md).
- iPhone recognition has been rebuilt, but real held-out movement/speech testing is pending.
  Internet relay has an unresolved intermittent 500 ms freshness failure. Prefer the direct
  route for the next physical test; do not describe either input as fully qualified yet.
- The existing public phone service is already deployed. Teammates do **not** need Wrangler,
  a Cloudflare login, a new deployment, API keys for speech, or a phone certificate installation.
  They do need the existing phone enrollment credential supplied privately by Sai/the service owner.

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
apps/host/.venv/bin/python tools/setup_speech.py --model-dir "$HOME/.cache/wand-speech/faster-whisper-base.en"
apps/host/.venv/bin/python tools/run_game.py
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
$wandModel = Join-Path $env:USERPROFILE '.cache/wand-speech/faster-whisper-base.en'
.\apps\host\.venv\Scripts\python.exe .\tools\setup_speech.py --model-dir $wandModel
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py
```

No virtual-environment activation or PowerShell execution-policy change is required.
The host package still installs some legacy dependencies, but this launcher does not start
legacy serial, camera/director or OpenAI workers. Do not use `phantom_host.main` for this game.

`setup_speech.py` downloads pinned `faster-whisper base.en` weights once, outside the repo.
The runtime loads only local files, uses CPU INT8 and keeps audio in memory. If you choose
a different model **directory**, pass that same path with `--speech-model` to every launch;
the model/revision itself must remain the pinned one. Each laptop needs its own model.

Wait for **Game ready: http://127.0.0.1:5173**, then open that exact URL in Chrome.
Do not use `localhost`, a random port or a LAN URL interchangeably: permissions/origin checks
are scoped to the selected origin. Startup verifies the frontend, referee and warm speech
worker; it is not a declaration that physical calibration or multiplayer has passed.

The default launcher builds a stable temporary frontend snapshot. Source edits do not replace
a running session. **Ctrl+C**, wait for shutdown, then rerun after updates. `--dev` opts into
hot reload for engineering only. The launcher refuses occupied ports instead of killing
unrelated processes and stops its children on startup failure.

| Service | Default address | Responsibility |
| --- | --- | --- |
| Player frontend | `127.0.0.1:5173` | UI; tightly scoped game, speech and phone proxies |
| Referee | `127.0.0.1:8000` | One authoritative two-player room |
| Speech helper | `127.0.0.1:8001` | Only this laptop's audio; per-launch authentication |

## 3. Connect an iPhone

First stop the plain launcher with Ctrl+C. Ask Sai/the service owner to provide the **existing**
enrollment-secret file through an approved private channel. Store it outside the repository,
readable only by your user. On macOS the launcher requires mode `0600`; on Windows restrict
the file's Security permissions to its intended owner. Do not paste the value into commands,
chat, screenshots, `.env`, URLs or logs. Generating a new local value will not match the service.

The following paths are examples for that privately delivered file; they do not create it.

macOS, from the root:

```sh
wandPhoneSecret="$HOME/.config/wandduel/phone-enrollment-secret"
chmod 600 "$wandPhoneSecret"
apps/host/.venv/bin/python tools/run_game.py --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file "$wandPhoneSecret"
```

Windows PowerShell, from the root:

```powershell
$wandPhoneSecret = Join-Path $env:USERPROFILE '.config/wandduel/phone-enrollment-secret'
.\apps\host\.venv\Scripts\python.exe .\tools\run_game.py --phone-service https://wandduel-phone.saiamartya19.workers.dev --phone-secret-file $wandPhoneSecret
```

1. On the laptop choose **Connect iPhone**. Scan its fresh QR with the phone camera and open
   the controller in **Safari**. Tap **Connect wand**, allow motion, and approve the matching
   number on the laptop. No phone microphone/camera capture is requested by the controller.
2. Keep the phone unlocked and Safari foregrounded. Use the same Wi-Fi for the direct route.
   The phone tries direct data-only WebRTC first; after a failed ten-second preflight, select
   **Use internet connection** only if you want the cloud motion relay. It never silently
   changes route during play. Internet is needed for initial QR pairing/signalling either way.
3. Move gently. Check **Sensor active** and **Reaching laptop** on the phone. If either fails,
   open Connection details; socket connection alone does not mean valid motion is arriving.
4. Enable the **laptop** microphone and allow two seconds of quiet. Find a comfortable grip:
   sideways/slightly diagonal is recommended; another consistent grip is valid. Tap
   **Start calibration**, hold still for three visible seconds, then follow three jabs and
   three guard examples. Calibration is movement-only. Do not jab harder to overcome a rejection.
5. Follow spoken Stupefy/Protego practice, enable the laptop camera, then Ready when both players
   have passed setup. Both speech and matching movement are required. Return to the starting
   grip between attempts; **Reset grip** is for an intentional grip change without re-pairing.

Locking/hiding Safari pauses input; use its foreground **Resume** action. Recovery cannot
resume an aborted round or deliver buffered casts. Reloading either endpoint needs fresh QR
approval. Phone Connection details offers an explicitly requested, sanitized last-minute trace;
it excludes audio/video, transcripts, credentials, addresses and persistent device IDs.

The older private-LAN HTTPS profile is optional diagnostic infrastructure, not the default.
It requires separate certificate/trust and LAN-exposure approval; see the
[workflow](../.agents/skills/wand-dev-workflow/references/workflow.md#3-optional-private-lan-phone-session).
Do not tunnel the game, referee or speech helper publicly.

## 4. Two laptops, one referee

Finish installation on **both** laptops. Use the same approved private network and get approval
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
to A; only game/referee traffic does. Opponent video is a separate direct, video-only WebRTC
connection, with no deployed TURN fallback. Wi-Fi peer isolation can block phone or video peers.

For a later **qualified** badge, omit the two `--phone-*` options on that player's launcher
and select Connect badge. Badge-only qualification can additionally use `--badge-only`.
A badge on a 0.1.x diagnostic image cannot pass Ready; flash 0.2.0 rather than changing browser gates.

## 5. Repeatable checks and useful failure reports

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
in [the input rebuild report](qa/input-rebuild.md); the older `qa_public_phone.mjs` is historical.

| Symptom | Next check |
| --- | --- |
| No `Game ready` / speech unavailable | Keep the first startup error. Verify Python 3.11 environment, speech extra, pinned model path and free ports. Do not start a second partial stack. |
| `DLL load failed` / native dependency error on Windows | Capture only the package/error and Python/architecture versions. Windows runtime setup needs qualification; do not substitute cloud speech or remove health gates. |
| Phone hosting unavailable | Use both hosted-service flags, the existing approved credential, private file permissions and working internet. Wait ten seconds before retrying pair creation. Never print the credential. |
| Certificate warning | The selected phone URL must be the public HTTPS service, not a stale LAN-IP bookmark. Start from a fresh QR; do not bypass TLS warnings. |
| Direct connection unavailable | Check venue peer isolation; explicitly try Internet if desired. Its intermittent freshness failure is still open. Do not loosen timing limits. |
| Sensor active, but no Reaching laptop | Report route, received rate, age and visible last failure from Connection details. Export a trace only deliberately. |
| Jab/guard counter stuck | Report its actionable hint; Reset grip and hold the same starting grip. Share a fresh trace if requested. Physical classifier accuracy is not yet qualified. |
| Badge missing after a cold boot | A badge still on 0.1.8 boots with BLE off after any power cycle. Flash 0.2.0 (radio on for every reset, advertising watchdog); check `id` on the console, not repeated blind reconnects. |
| Badge says firmware needs repair / diagnostic INFO only | The badge is on a 0.1.x image or a diagnostic boot row (`profile creator|rate`). Flash 0.2.0 or select `profile range on`; never restore capability bits in the browser. |
| Laptop says Reconnecting your badge… | Normal bounded auto-reconnect after a dropped link (up to three per minute). If it ends in Reconnect badge, press it once; if that fails, power-cycle the badge and report `status`. |
| Camera or multiplayer peers cannot connect | Confirm both clients selected the same referee, their own local origin, network approval and peer reachability. No public TURN fallback is configured. |
| Port occupied | Stop the known old launcher using its own Ctrl+C. Do not kill every Node/Python process or print full process environments/arguments. |

Keep the next physical card small: **Sensor active → Reaching laptop → visible stillness →
accepted jab examples**. Reply with **commit/build · route/devices · failed step · expected →
observed · visible reason/rates**. Continue to spoken practice and two-player play only after
that gate. [Current evidence](qa/input-rebuild.md) keeps scripted, physical iPhone and real-badge
results separate; a passing test count does not erase an unmeasured or failing physical gate.
