# Wandduel

Hold your hacker badge like a wand. Say the incantation. Make the movement. Watch the spell
cross a live video portal and hit a real opponent on the other side of it.

## Inspiration

Every wizard duel we grew up watching has the same two beats: the wizard *says* something, and
the wizard *does* something. Nobody presses a button.

Almost every "magic wand" project we'd seen collapses that into a trigger — hold the button,
wave, release. It works, and it feels like a TV remote. We wanted the opposite constraint:
**no combat button anywhere on the device.** If you want to cast Protego, you raise your wand
into a guard and you say "Protego." If you only do one of those, nothing happens.

The Hack the North badge made that suddenly plausible. It's an ESP32-C3 with a real
accelerometer, a 320×240 IPS display and six addressable LEDs, hanging on a lanyard around a
thousand necks — a wand everyone was already carrying. Add two laptops, two webcams, and the
fiction writes itself: the screen is an enchanted mirror, your opponent stands on the other
side of it, and the spell you cast in the air arrives on their face.

## What it does

Two players, two laptops, one 60-second duel, 100 health each.

- **Find each other.** One player clicks **Start a duel** and reads out a six-character code;
  the other clicks **Join with code**. The referee is deployed, so the two laptops only need
  internet — not the same room, not the same network.
- **Connect a wand** — a custom-firmware badge over Bluetooth LE, or an iPhone as a motion
  controller when a badge isn't available. Both stream the *same bytes*.
- **Calibrate.** Hold still, throw three jabs, raise three guards, rehearse each incantation.
  This teaches the system *your* grip instead of demanding a specific one.
- **Duel.** Say "Stupefy!" and jab — a crimson bolt crosses the portal, 20 damage, two seconds
  of flight. Say "Protego!" and raise your wand — a 1.2-second shield catches it. A third
  spell, Expelliarmus, is implemented and deliberately switched off behind a flag until the
  two-spell core passes its accuracy gates.
- A Python referee — not either browser — decides what actually happened. Damage resolves at a
  scheduled impact time against whatever shield exists *then*, so a shield raised half a second
  late genuinely fails.

The entire speech pipeline runs on your own laptop. No audio ever leaves the machine.

## How we built it

### The shape of the system

```
badge (ESP32-C3, BLE GATT)  ─┐
                             ├─► browser ──► local Whisper helper (127.0.0.1:8001)
iPhone (WebRTC data / WSS) ──┘     │
                                   ├──► Python referee (FastAPI, 20 Hz ticks, rooms by code)
                                   └──◄─► opponent browser (WebRTC, video only)
```

Four pieces, deliberately separated:

| Layer | Stack | Job |
| --- | --- | --- |
| Wand firmware | C++ on PlatformIO, Arduino core 3.x (ESP-IDF 5.x), NimBLE | Stream fresh acceleration; render bounded feedback. **No game rules.** |
| Browser | React + TypeScript + Vite, plain Three.js | Segment motion, endpoint speech, fuse the two, render the duel |
| Speech helper | Python, `faster-whisper base.en`, CPU int8 | One pre-warmed worker, loopback only, no queue |
| Referee | Python 3.11, FastAPI + Pydantic | Single authority: health, cooldowns, projectiles, results |

The rule that kept us sane: **the wand senses, the browser decides, the referee adjudicates.**

The badge never says "I cast Stupefy." It says "here is acceleration, here is my sequence
number, here is my clock." So every calibration change and every threshold tweak was a browser
reload, not a reflash. With one flashable badge and a single day, that was the difference
between iterating in seconds and iterating in ten-minute cycles.

Everything crossing the wand boundary is **exactly 20 bytes**, across four GATT characteristics
(`INFO`, `MOTION`, `CONTROL`, `STATUS`). That isn't an aesthetic choice: 20 bytes is what fits
inside the baseline BLE ATT MTU of 23, so we never depend on a negotiated large MTU and never
fragment at the application layer. The payoff turned out to be bigger than the radio. Because
the phone relay and the QA replay harness carry the *same opaque 20-byte envelopes*, one
decoder serves all three sources — a real badge, an iPhone and a recorded trace are
indistinguishable to every line of code downstream of `wand/client.ts`.

Staleness is handled with generations rather than trust. `INFO` carries a random nonzero boot
id, `CONTROL` carries a browser-chosen nonce, `MOTION` carries a 16-bit sequence with a wrap
classifier that accepts only

$$0 < (s_{\text{new}} - s_{\text{old}}) \bmod 2^{16} < 2^{15}$$

and every browser callback is scoped to its connection generation. A sample older than 200 ms
is rejected, a gesture cannot span a gap over 150 ms, and 500 ms of silence marks the wand
unavailable. None of this is authentication — there's no bonding in v1 and we don't pretend
otherwise — but it does guarantee that a notification queued before a reconnect can never cast
a spell after it.

### Recognizing a gesture without a gyroscope

The badge's accelerometer is three axes and nothing else. No gyro. That matters more than it
sounds: you cannot recover absolute orientation, so you cannot reconstruct the path a wand
traced through the air. Rotating the wand only changes how gravity is distributed across the
axes.

So we stopped trying to recognize *shapes* and started recognizing *strokes*: where a burst of
acceleration pointed, how hard it was, and what pose the hand ended in.

**Segmentation first.** The current detector is our third attempt, and the rebuild was the
single biggest unlock of the project. A movement starts on a sharp sample-to-sample change —
jerk $\geq 180$ mg per 20 ms on two consecutive samples, a single sample $\geq 450$, a linear
excursion $\geq 450$ mg, or a $15°$ orientation change — and ends when the trailing 200 ms is
quiet again (jerk $< 140$, spread $< 150$ mg), *in whatever pose the hand ended up*. The
resting reference re-anchors at every still run, so nothing requires returning to the
calibrated grip. Strong strokes ($\geq 800$ mg) resolve about 120 ms after the peak, before
the hand has settled, which is what makes a jab feel immediate.

**Direction, weighted toward the part that matters.** Within a burst we take the lobe around
the peak — the contiguous samples whose linear acceleration $\ell_i = a_i - a_{\text{rest}}$
stays above half the peak — and compute a cubically weighted mean direction:

$$d \;=\; \frac{\displaystyle\sum_{i \in L} \lVert \ell_i \rVert^{3}\, \ell_i}
{\left\lVert \displaystyle\sum_{i \in L} \lVert \ell_i \rVert^{3}\, \ell_i \right\rVert}$$

The cubic weight is the whole trick. A real jab has a wind-up and a follow-through that rotate
*around* the thrust; weighting linearly lets them drag the answer off-axis, and weighting by
$\lVert \ell_i \rVert^3$ anchors the direction on the strongest part of the stroke.

**Directedness.** We then score how one-dimensional the stroke actually was:

$$\rho \;=\; \frac{\sum_{i \in L} \langle \ell_i,\, d\rangle^{2}}{\sum_{i \in L} \lVert \ell_i \rVert^{2}},
\qquad \rho \geq 0.35$$

A jab and a sweep are directed, so $\rho$ is high. Shaking the badge nervously is isotropic,
$\rho$ collapses, and nothing fires.

**Telling a raise from a thrust without a gyro.** This is our favourite piece of the whole
recognizer. When you rotate the wand by $\theta$, gravity alone sweeps across the axes by a
chord of $2g\sin(\theta/2)$. So we can predict how much apparent acceleration a *pure*
re-orientation would produce, and compare it to what we actually measured:

$$\text{peak} \;\leq\; 1.3 \cdot 2000\sin\!\left(\frac{\theta}{2}\right) + 100 \;\;\text{mg}
\quad\Longrightarrow\quad \text{this was a raise, not a jab}$$

A movement no stronger than its own gravity change has to be a re-orientation, whatever
direction it points. That one inequality is what lets Protego and Stupefy coexist on a sensor
that cannot measure rotation.

**Classification is then a set of angles against templates you trained.** Three examples per
spell; the template keeps the mean direction and the median peak. A jab or sweep matches within
$40°$ of its template direction with a lobe of at least 60 ms; a guard matches within $45°$ of
its tilt direction with at least $22°$ of tilt. Training examples must be self-consistent
within $50°$, and Stupefy and Expelliarmus must be at least $50°$ apart or we refuse to enable
the second one.

This is why calibration is worth thirty seconds of the player's time. We learn *your* stroke
relative to *your* resting grip, so a sideways hold, a diagonal hold and a pistol grip all
work. Nothing is pinned to a device axis — which also means rotating your phone mid-duel is a
non-event.

### Hearing the incantation, locally

Each laptop runs its own speech helper on `127.0.0.1:8001`, reached through a same-origin
proxy. An `AudioWorklet` owns the microphone timebase and does the endpointing: a two-second
quiet calibration establishes an idle noise floor, then 60 ms of speech-on hysteresis, 150 ms
of pre-roll, 200 ms of end-silence to close, hard-capped at three seconds.

The bounded PCM clip (16 kHz mono `pcm_s16le`) goes to a single pre-warmed `faster-whisper
base.en` worker pinned to an exact model revision: greedy decode, `beam_size=1`,
`temperature=0`, no previous-text conditioning, and a three-word initial prompt that biases the
tokenizer toward the spell vocabulary.

We accept only an exact canonical incantation after Unicode normalization and casefolding. No
fuzzy matching, no phoneme distance, no aliases. In a hall with a thousand people, fuzzy
matching means your opponent's cough casts your spell.

### Fusing the two

This is the part that decides whether the game feels magical or broken, and it is almost
entirely about time. A cast requires an incantation *and* a movement that name the same spell,
with intervals that overlap or nearly do:

$$\text{gap}\big(I_{\text{voice}},\, I_{\text{motion}}\big) \leq 350\,\text{ms},
\qquad \big|\,I_{\text{voice}} \cup I_{\text{motion}}\,\big| \leq 2000\,\text{ms}$$

and the transcript must land within 1000 ms of the **unpadded end of speech** — measured from
the worklet's timebase, never from whenever transcription happened to come back. The endpoint
fires an `onset` event the instant voice starts, so fusion opens a pending slot immediately and
the ASR latency hides inside a window the player never notices.

Crucially, the recognized word chooses *which* motion evidence must pass. Saying "Stupefy" with
only guard-shaped evidence is rejected. The word is not a spell picker that waits around for
any subsequent wave. Only one unresolved utterance is allowed at a time; a second onset
invalidates the attempt rather than queueing it. Both gesture and utterance IDs go through a
64-entry dedup ring, and everything is generation-scoped — a disconnect, a round change, a page
suspension or an audio restart bumps the generation and kills all older evidence.

### Making the duel fair

The referee holds the only real state. Accepted attacks become projectiles with a *future*
impact time (2 s of flight, chosen so a human can hear the bolt coming, speak, gesture and have
the network deliver it). Damage resolves at impact against the shield that exists at impact.
Both browsers animate the same server-scheduled event from opposite ends — on the attacker's
screen the bolt flies away, on the defender's it grows toward the camera and breaks on the
shield in the foreground.

Clock agreement is a one-sided NTP estimate, accepted only when a pong sets a new minimum RTT,
so a single jittery sample can't corrupt the offset:

$$\text{offset} \;=\; \text{server}_{ms} - \frac{\text{ping}_{ms} + \text{now}_{ms}}{2}$$

Rejected input costs nothing: no damage, no cooldown, and one line of coaching on the laptop. A
stale wand, an unhealthy microphone or a hidden tab aborts the round with no winner rather than
quietly continuing on degraded input.

The engine itself is deliberately inert: it holds no clock, opens no socket and does no I/O.
You call `advance(now_ms)`, and it resolves the ordered command queue plus every impact now
due, batching same-tick lethal impacts so a genuine double knockout comes out as a draw instead
of a race. That is what makes combat testable with a fake clock.

### Getting two strangers into the same duel

Late in the build we replaced "one room per process" with a `RoomRegistry`: `POST
/api/game/room` mints a six-character code from an alphabet with no `0/O/1/I`, capped at 32
live rooms and reaped after ten idle minutes. Every socket resolves its room from the player's
token, so the protocol after auth didn't change at all — the entire multiplayer feature landed
without touching the game messages.

The referee runs as a free Render web service, which sleeps after 15 minutes and takes about a
minute to wake. That's fine for a soak test and fatal for a judge standing at your table. So a
scheduled Cloudflare Worker pings its health route every ten minutes to keep it warm, and the
launcher wakes it before printing `Game ready`. Opponent video stays peer-to-peer, using ICE
servers the referee hands out in the welcome message — Cloudflare STUN by default, or
short-lived TURN credentials minted and cached when the keys are configured.

## Challenges we ran into

### 576 bytes of free heap

Our first badge apps crashed on startup with `assert failed: ble_hs_init` — or, when we got
lucky, hung on `host sync timeout`. The serial log told the story: free heap collapsing to
**576 bytes** exactly as the Bluetooth stack tried to sync. The stock Lua sandbox shares one
~75 KB heap between the Lua state and Bluetooth, so a Lua radio app has a few hundred bytes to
work with. We were clearing the bar by a hair and then losing to fragmentation, which is why
the failure mode kept changing between runs and looked non-deterministic.

The immediate fix was one line of ordering — **claim the radio before you draw anything** —
plus building the duel screen lazily. The real fix was leaving the sandbox entirely and writing
native firmware, which is also what let us stream raw acceleration at a fixed rate.

### The sensor flag that wasn't a sensor problem

This one nearly sank the badge, and the resolution is the most useful thing we learned all day.

The accelerometer sets bit 7 of its `STATUS` register — documented as *overwrite*, meaning a
sample was lost before we read it — on essentially every read. Not occasionally: **1,484
flagged frames out of 1,503** in a 30-second capture. We chased it through seven diagnostic
firmware builds, each flashed and read back with a verified SHA-256: every register profile we
could configure (100 Hz/±2 g, 50 Hz/±2 g, 50 Hz/±8 g, high-performance mode), with Bluetooth
enabled and fully disabled, with the acquisition sleep removed entirely and polling at 1 ms,
with the datasheet's documented `SOFT_RESET`, and finally as a controlled eight-combination
matrix. All 128 captured bursts showed the same `FF → 00`.

We had been treating the flag as ground truth — counting it as a dropped sample and setting the
`MOTION` discontinuity bit, which the browser rejects by contract. That meant **no gesture
could ever form on the badge.**

The thing that broke it open was measuring cadence instead of arguing about the register. At
100 Hz the badge produced 428 fresh reads against 3,957 no-data polls in 4.4 s; at 50 Hz, 223
fresh reads with every inter-sample interval landing in a 17–23 ms bucket. **A sample that was
genuinely overwritten before every read cannot produce that cadence.** The silicon was fine;
our interpretation was wrong.

So firmware 0.2.0 stopped trusting the flag and started deriving discontinuity from things we
can actually observe: a fresh-read gap longer than 1.5 output periods (30 ms at 50 Hz, so a
single lost sample is always caught), a sample older than 100 ms at notification time, a
refused notification, a bus error, or a stream restart. The flag became an informational
counter. That single change turned the badge from a diagnostic brick into the first gameplay
image.

It also explains why the iPhone path exists at all. While the badge was marking every sample
discontinuous, it was *impossible* to develop the gesture recognizer against badge data — the
browser correctly refused all of it. So the entire calibration and recognition pipeline was
built against iPhone motion and recorded traces, in parallel, and the 20-byte envelope is what
let that work transfer to the badge unchanged the moment the firmware was fixed. A fallback we
added for redundancy turned out to be the thing that kept the project moving.

### The badge that wouldn't show up in the chooser

Meanwhile a teammate reported the badge simply wasn't appearing in Chrome's Bluetooth chooser.
We assumed a radio problem and went looking for one.

It was a boot-selection bug, visible only over USB: the installed image honoured its retained
boot profile after a *software* reboot, but a power cycle, USB replug, brownout or watchdog
reset booted a row with **BLE off**. The live probe said it in one line —
`HPDIAG|reset=11|profile=creator|ble=off|caps=0`. 0.2.0 now boots 50 Hz/±8 g with the radio on
for *every* reset reason, and a 500 ms watchdog re-arms advertising if the stack ever leaves it
stopped.

The lesson generalizes: **"reset" is not one thing, and the firmware has to know which one
happened.** Telling `ESP_RST_SW` (a deliberate console `profile` command) apart from
`ESP_RST_POWERON`, `ESP_RST_WDT` and `ESP_RST_BROWNOUT` is load-bearing, and getting it wrong
made the wand invisible on exactly the power source it ships with.

### When drawing a screen broke the clock

Command round-trips were timing out, and the browser's clock sync gives up if `SYNC` takes more
than 100 ms. The cause was structural: we were answering `CONTROL` writes from the Arduino
loop, so a command that happened to land behind a screen redraw inherited up to ~100 ms of
someone else's work.

Two fixes. `CONTROL` writes are now answered synchronously on the NimBLE host task, so a
command result never queues behind rendering — `OPEN` measures 58–60 ms and `SYNC` p95 lands at
60–67 ms. And the display stopped being slow: a single line of size-1 text drawn directly cost
around 60 ms in per-pixel SPI address-window transactions, so text fields now render into an
off-screen `GFXcanvas16` and go out as one bulk transfer, dirty-checked so nothing redraws
unless it changed.

There's a related trap we bolted the door on: Espressif documented that NimBLE's host flow
control causes silent stalls and connection loss on the ESP-IDF version we're pinned to. It
fails with no obvious error, so the firmware carries a compile-time `#error` that fails the
build if a future SDK bump ever switches it back on.

### Batteries, brownouts and an adaptive soft start

The first battery test of the new image boot-looped with **reset reason 9 — brownout**. On USB
the same image was fine. The earlier firmware had never shown this for an embarrassing reason:
it never turned the radio on when running on batteries. The radio's current steps on a sagging
AA rail were browning out the chip.

0.2.1 stages the load instead of fighting it — display and sensor first, radio at 1.2 s, LEDs
2 s after the radio, default TX power dropped from +3 to 0 dBm, advertising relaxed to
40–80 ms. Then it adapts: each brownout since the batteries went in is counted in RTC-retained
memory, and for brownout $n$ the firmware applies

$$\text{radio delay} = 1.2 + \min(1.5n,\ 4.5)\ \text{s},
\qquad P_{\text{tx}} = \max(0 - 3n,\ -12)\ \text{dBm}$$

keeping the LEDs dark from the second brownout onward. The count clears on a clean power-on or
30 seconds of stable running. Fresh batteries fix the loop on their own; this keeps the margin
for tired ones.

### We nearly bricked the only badge we had

Flashing went badly wrong. Our first attempt shelled out to `pio run -t upload`, and
PlatformIO's bundled esptool crashed inside its own progress logger — `EsptoolLogger` has no
`_get_progress_print_file` — **while writing the bootloader at 0x0**, leaving 10,578 of 18,688
bootloader bytes changed. The badge stayed in ROM download mode, which is the only reason this
is a story and not an obituary.

Recovery worked because we had taken a verified two-read stock backup *before* touching
anything: read 0x0–0x9000, confirm the partition table still matched, rewrite 0x0–0x8000 from
the backup, read back byte-identical. Then we rewrote the flashing tool so it can't happen
again — app slot only, a refusal to touch the bootloader region at all, a consistent `esptool`
pinned through `uv`, `--no-progress`, mandatory readback verification, and a `restore-boot`
command.

**Take the backup before you need it** is the cheapest insurance in hardware work. (The badge
also has native USB, which means no auto-reset circuit — every recovery involves physically
holding START while plugging the cable in. There is no software substitute, so the tool grew a
`flashmode` console command for the case where the app is still alive enough to hear it.)

One more hardware hazard worth naming: the accelerometer shares its I²C bus with the badge's
NFC reader, which can wedge the bus outright when the battery rail sags. We never initialize
the NFC chip, and the sensor driver defends anyway — a 10 ms bus timeout, five consecutive
errors before attempting recovery, and a 250 ms back-off between attempts, with the recovery
count reported in telemetry so a wedged bus shows up as a number instead of a mystery.

### The calibration that rejected everything

A teammate held the recommended grip, threw jab after jab, and the system rejected **every
single training example** — 48 seconds, 2,892 raw samples, zero accepted, with the coaching
text cycling uselessly through "return to neutral," "duration," "stopping movement," "too
small."

The trace saved us. Because sanitized trace export went in early, we could see the phone was
delivering at 59.94 Hz with a p95 sample age of 50 ms and bursts hitting 4–5.7 g. The transport
was *fine*. That eliminated everything except the recognizer.

The recording showed six clear strokes of 3.7–4.8 g whose direction was consistent to within
~15°, separated by 12–18° of hand drift and slow returns. Our detector rejected all of them
(`too-long`, `too-short`, `missing-stop`) because it segmented on drift away from a frozen
neutral pose and then demanded a return to that same pose. Every real jab "took too long,"
because the duration clock started on pre-jab drift rather than on the actual impulse — and
guards failed with a nonsense "stopping movement" complaint because we demanded braking
evidence even when a movement legitimately releases into a held pose.

That's what triggered the v3 rebuild described above: jerk-based onset, a resting reference
that re-anchors at every still run, and completion on *stillness in any pose*. The recorded
trace now calibrates on its first three jabs and recognizes the remaining two as held-out
Stupefy, as a regression test. We also widened trace export to 10,000 entries and made every
rejection carry a human-readable reason with the timestamps, magnitude, direction concentration
and final angle that produced it.

**The debugging lesson outlived the bug:** build the trace export before you need it. Being
able to *prove* the transport was healthy turned an unbounded search into a ten-minute one.

### The phone's coordinate frame doesn't rotate

We had the recognizer remapping accelerometer axes according to screen orientation. It felt
obviously correct and it is obviously wrong: the W3C `DeviceMotion` frame is fixed to the
*physical device* and does not rotate with the display. Applying a screen-rotation matrix to
motion data meant a landscape grip expected a jab in a different direction than a portrait one.
We deleted the remapping, the portrait-only connection gate and the rotation-triggered
disconnect. Rotating your phone mid-duel is now a non-event.

### Certificates are not a hackathon-scale problem

Safari won't hand you `DeviceMotionEvent.requestPermission()` without a user gesture *and*
HTTPS. Our first attempt was `mkcert`: local CA, certificate pinned to the MacBook's LAN IP,
trusted in the macOS keychain. The iPhone reached the page and refused it — iOS needs the CA
trusted in Settings *and* separately enabled in Certificate Trust Settings, and the certificate
was bound to one DHCP-assigned address the venue network would happily have changed.

We moved the controller to a Cloudflare Worker with a Durable Object per pairing room, behind a
publicly trusted certificate. Zero per-device setup, survives any network, free tier. The QR
code carries only a rendezvous id — never a bearer token — and pairing completes with a
matching number the laptop has to confirm, so scanning someone else's code gets you nothing.
Only opaque 20-byte envelopes cross it: no game token, no audio, no transcript, no video.

### Frame 0, then frame 256

Microphone capture kept dying with "Audio frame continuity was lost" even after we'd fixed what
we thought was the cause. A Chromium-specific test against the real capture graph reproduced it
exactly: a valid block at frame 0, followed by frame **256** — a whole 128-frame quantum simply
missing from the `AudioWorklet`'s clock at startup.

We now require two consecutive valid startup blocks before any PCM reaches the speech helper,
and discard isolated ones rather than fabricating or retimestamping the gap. Web Audio startup
behaviour is platform-specific, and you cannot infer it from track metadata or the
`AudioContext`'s advertised sample rate — you have to test the graph you actually ship.

### Ten minutes is not ten seconds

Our hosted phone relay passed every short smoke test and then failed twice on extended runs —
once at 182 s, once at 363 s. The second failure retained a `delivery_backlog` error code,
which was the whole ballgame: a full eight-notification delivery window was disconnecting
*immediately* when a `STATUS` record arrived, with no drain phase, so a transient burst of
health frames looked identical to a dead link.

We let the relay hold four pending `STATUS` records for up to 100 ms and drain them ahead of
coalesced motion. The next run went the full 600 s: **30,019 samples, 5 missing (99.98%),
50.0 Hz, p95 sync RTT 64 ms.** The maximum arrival gap was 198 ms, still above our 150 ms
freshness rule — so one unlucky gesture in a long match can still be invalidated. We know; we
haven't fixed it. The first failure at 182 s was never explained, because we hadn't retained
its error code. We do now.

### The badge that knew rules it couldn't check

An earlier version of this project kept mana and cooldown counters on the badge itself and
silently refused to transmit when they said no. Then the host granted a player +40 mana, the
badge never heard about it — the radio only went one way — and a completely legal cast was
swallowed at the exact moment the projector displayed the event that authorized it.

The badge now models **nothing**. No mana, no cooldowns, no phase, no damage. The only
remaining device-side gate is a flat send-rate cap for radio hygiene, and a static test fails
the build if a game rule ever creeps back in. A silent always-closed failure isn't exploitable,
but at a demo table it's indistinguishable from a crash — and that conviction is what the whole
current architecture is built around.

## What we learned

**Put the intelligence where iteration is cheap.** Making the wand dumb was our single most
valuable decision. Every threshold, every calibration idea, every "what if a jab needs a second
lobe" experiment became a browser reload instead of a flash cycle. Firmware and platform meet
at a versioned 20-byte GATT record and nowhere else, which also let a virtual wand stand in for
the real one in tests — the decoder and everything downstream never knew the difference.

**Measure the thing, don't argue with the datasheet.** We lost hours treating a status bit as
ground truth. The question that actually resolved it wasn't "why is this flag set?" but "what
cadence are we observing?" — and the cadence proved the flag couldn't mean what it said. When a
signal and a measurement disagree, trust the measurement and instrument harder.

**Integrate over observed time, not over samples.** Both input paths deliver samples in jittery
bursts. Nearly every early gesture bug traced back to code that implicitly assumed uniform
sampling; weighting by observed interval instead of sample count fixed a whole class of them at
once.

**Calibrate the person, not the device.** The moment we stopped asking "which way is the
phone's Y axis pointing" and started asking "which way does *this player's* jab go relative to
*this player's* resting grip," recognition stopped being grip-dependent and screen rotation
stopped mattering.

**Segment on change, not on distance from a remembered pose.** v2 assumed a movement is a
departure from and return to a fixed neutral. Real hands drift, and real guards *end* somewhere
else entirely. Starting on jerk and ending on stillness-in-any-pose was the difference between
rejecting every jab and recognizing them from a recording.

**Exact matching beats clever matching in a loud room.** Fuzzy ASR matching is a liability when
a thousand people are talking. Same instinct behind rejecting an ambiguous cast rather than
recovering from it: a no-cast with a one-line reason is a far better player experience than a
wrong cast.

**Refuse to fake it.** The temptation at 4 a.m. is to add a button that "helps" when
recognition is flaky, or to backdate a shield so the demo looks good. We wrote those
prohibitions into the spec on day one — no hidden button shield, no pre-activating from a
partial word, no silently switching transports mid-round — and we're glad we did, because the
version of this project that secretly cheats isn't the one we wanted to build.

**Separate "it works" from "we measured it."** Our docs are pedantic about which claims are
implementation plans, which are measured results, and which gates are still open. It felt slow.
It was the only reason we always knew what was actually true at 3 a.m.

## What's next

We want to be precise about what this is, because we've been precise about it with each other
all day. The referee, the fusion, the local speech pipeline, the Three.js duel, code-based
multiplayer and the iPhone controller path are built and tested: **253 host tests, 158 frontend
tests, 27 browser tests, 33 Worker tests and 25 tooling tests** currently pass, plus the
firmware's native suite and 42 protocol golden-vector checks that the badge can run *on itself*
over serial — so a flashed wand can prove its own wire format without a laptop in the loop.
Badge firmware 0.2.1 is flashed with readback verification, and the last console capture showed
49.0 Hz acquisition with ~159 KB of free heap under full load.

What is **not** yet qualified is physical, and software tests can't close it:

- **The badge's physical QA card.** 0.2.1 is flashed and awaiting its run: cold-boot
  discoverability across three power cycles, a 30-second radio gate at ≥45 Hz with ≤2
  discontinuity flags and p95 command RTT ≤150 ms, calibration on the badge's own noise
  profile, drop-and-recover, and a ten-minute soak.
- **A fresh physical calibration pass.** v3 fixes the defects the trace exposed and recognizes
  the recorded jabs, but "the tests pass" is not "a human successfully calibrated."
- **Sustained iPhone qualification** on venue Wi-Fi rather than a quiet apartment, including
  the one open intermittent Internet-relay freshness failure.
- **A measured two-player match**: recognition accuracy, true negatives, an opponent saying
  your incantation three feet away, end-to-end defendability, and five consecutive matches on
  Windows Chrome.
- **Battery endurance.** No cold-boot-to-30-minutes-on-AAs evidence yet.
- **Expelliarmus**, fully implemented and flag-disabled by design. It turns on when Stupefy and
  Protego clear their gates — 18 of 20 fused casts per player per spell, 8 of 10 deliberate
  shields accepted before impact, and zero accepts across 10 trials of an opponent speaking
  your incantation three feet away.

Beyond the gates: a six-face sensor axis and clipping verification, and a spectator view — the
duel is already fully described by the referee's authoritative event stream, so a third browser
could watch the whole thing without either player's laptop doing extra work.

The spell list is deliberately tiny, and the stop-rule is written down: if only two spells pass,
we present a scoped two-spell duel rather than weaken the input contract. We'd rather ship
*say it, move the wand, see the magic, counter your opponent* and have it genuinely work than
ship twelve spells behind a button.
