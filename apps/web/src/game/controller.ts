import { WandClient } from "../wand/client";
import { BleWandTransport } from "../wand/transport";
import { VirtualWandTransport } from "../wand/virtual";
import { PhoneSession } from "../phone/session";
import {
  PhoneRelayChannel,
  parseHostedPair,
  type HostedClaim,
  type HostedPair,
} from "../phone/relay";
import { MotionRecognizer, type SpellName } from "../input/motion";
import { CastFusion } from "../input/fusion";
import { SpeechClient } from "../speech/client";
import { GameClient } from "./client";
import { VideoLink } from "./video";
import { CueEffect, PresentationPhase, SpellCode } from "../wand/protocol";
import type { Source } from "./contracts";

export class DuelController {
  readonly game = new GameClient();
  readonly speech = new SpeechClient();
  readonly motion: MotionRecognizer;
  readonly fusion: CastFusion;
  wand?: WandClient;
  source?: Source;
  pairingCode = "";
  phoneUrl = "";
  phoneClaim?: HostedClaim;
  phoneClaimApproved = false;
  phoneHosted = false;
  issue = "";
  notice = "";
  noticeAt = 0;
  busy = false;
  generation = 0;
  localVideo?: MediaStream;
  remoteVideo?: MediaStream;
  cameraIssue = "";
  practiced = new Set<SpellName>();
  lastSpell?: SpellName;
  lastSpellAt = 0;
  renderingReady = false;
  private peer: VideoLink;
  private videoPeerKey = "";
  private timer: ReturnType<typeof setInterval>;
  private unsubscribers: (() => void)[] = [];
  private seen = new Set<string>();
  private context = "";
  private feedbackKey = "";
  private presentationEpoch =
    crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  private dead = false;
  private attemptGeneration = 0;
  private cameraAttempt = 0;
  private phoneRelay?: PhoneRelayChannel;
  phoneSession?: PhoneSession;
  private observedWandGeneration = -1;
  private wasStreaming = false;
  private calibrationIdentity = "";
  private phoneRequest?: AbortController;
  onChange = () => {};

  constructor() {
    this.fusion = new CastFusion((attempt) => {
      if (!this.healthy()) return;
      if (this.game.snapshot?.phase === "playing")
        this.game.send({
          type: "cast",
          roundId: this.game.snapshot.roundId,
          attemptId: attempt.id,
          spell: attempt.spell,
          gestureId: attempt.gestureId,
          speechId: attempt.utteranceId,
          inputGeneration: this.generation,
        });
      else if (
        this.game.snapshot?.phase === "lobby" ||
        this.game.snapshot?.phase === "result"
      ) {
        this.lastSpell = attempt.spell;
        this.lastSpellAt = performance.now();
        this.practiced.add(attempt.spell);
        this.notice = `${nameOf(attempt.spell)}!`;
        this.wand?.cue({
          effect: CueEffect.AcceptedCast,
          spell: codeOf(attempt.spell),
          durationMs: 180,
          presentationEpoch: this.presentationEpoch,
        });
      }
      this.onChange();
    });
    this.motion = new MotionRecognizer((evidence) =>
      this.fusion.pushGesture(evidence),
    );
    this.speech.setRecognitionEnabled(false);
    this.unsubscribers.push(
      this.speech.onOnset((e) => {
        // Calibration speech cannot become a cast just as the last example ends.
        if (this.motion.getState().phase === "ready")
          this.fusion.beginUtterance({ ...e, generation: this.generation });
      }),
      this.speech.onSpeech((e) => {
        if (this.motion.getState().phase === "ready")
          this.fusion.pushUtterance({
            ...e,
            generation: this.generation,
            finalAtMs: e.arrivedMs,
          });
      }),
    );
    this.game.getHealth = () => ({
      healthy: this.healthy(),
      inputGeneration: this.generation,
    });
    this.game.onChange = () => {
      this.syncGame();
      this.onChange();
    };
    this.game.onAck = (message) => {
      if (message.command === "cast" && !message.accepted) {
        this.notice =
          message.reason === "cooldown"
            ? "Spell recharging"
            : "Spell not ready";
        this.noticeAt = performance.now();
        this.lastSpell = undefined;
        this.onChange();
      }
    };
    this.peer = new VideoLink(
      (message) => this.game.signal(message),
      (stream) => {
        this.remoteVideo = stream;
        this.cameraIssue = "";
        this.onChange();
      },
      (issue) => {
        this.cameraIssue = issue;
        this.onChange();
      },
    );
    this.game.onSignal = (payload, generation) =>
      this.peer.receive(payload, generation);
    document.addEventListener("visibilitychange", this.visibility);
    this.timer = setInterval(() => {
      this.syncInputState();
      this.fusion.advance(performance.now());
      this.syncGame();
      this.updatePhoneCoaching();
      this.onChange();
    }, 100);
  }
  private visibility = () => {
    if (document.hidden) {
      this.generation++;
      this.fusion.reset(this.generation);
      this.wand?.suspend();
      this.speech.stop();
      this.game.send({
        type: "heartbeat",
        clientMs: performance.now(),
        inputGeneration: this.generation,
        healthy: false,
      });
      this.issue = "Paused. Reconnect your wand to continue.";
      this.onChange();
    }
  };
  healthy() {
    const mic = this.speech.getSnapshot().phase;
    return (
      !document.hidden &&
      !this.game.issue &&
      this.wand?.getSnapshot().phase === "streaming" &&
      this.motion.getState().phase === "ready" &&
      ["listening", "busy"].includes(mic) &&
      this.renderingReady
    );
  }
  async connect(source: "ble" | "phone" = "ble") {
    const request = ++this.attemptGeneration;
    this.busy = true;
    this.issue = "";
    this.pairingCode = "";
    this.phoneUrl = "";
    this.phoneClaim = undefined;
    this.phoneClaimApproved = false;
    this.phoneHosted = false;
    this.practiced.clear();
    this.context = "";
    this.feedbackKey = "";
    this.seen.clear();
    this.source = source;
    this.generation++;
    this.fusion.reset(this.generation);
    this.speech.setRecognitionEnabled(false);
    this.motion.reset();
    this.phoneRequest?.abort();
    this.phoneRequest = undefined;
    this.wand?.disconnect();
    this.phoneRelay = undefined;
    this.phoneSession = undefined;
    this.calibrationIdentity = "";
    this.wasStreaming = false;
    this.peer.stop();
    this.videoPeerKey = "";
    this.remoteVideo = undefined;
    try {
      // Start the chooser inside the user's click, before any HTTP request.
      if (source === "ble") {
        if (!navigator.bluetooth)
          throw new Error("Use Chrome on a Bluetooth-capable laptop.");
        this.wand = new WandClient(new BleWandTransport(navigator.bluetooth));
        this.bindSamples();
        await this.wand.connect();
      } else {
        const phoneRequest = new AbortController();
        this.phoneRequest = phoneRequest;
        const hosted = await hostedPhoneEnabled(phoneRequest.signal);
        if (!hosted && location.protocol !== "https:")
          throw new Error("Phone control needs the trusted HTTPS setup.");
        await this.game.connect("phone");
        if (request !== this.attemptGeneration || this.dead) return;
        const hostedPair = hosted
          ? await createHostedPair(phoneRequest.signal)
          : undefined;
        const localPair = hostedPair ? undefined : await this.game.pair();
        if (request !== this.attemptGeneration || this.dead) {
          this.game.disconnect();
          return;
        }
        this.phoneRequest = undefined;
        this.phoneHosted = Boolean(hostedPair);
        this.phoneUrl = hostedPair?.phoneUrl ?? `${location.origin}/phone`;
        this.pairingCode = localPair?.code ?? "";
        this.onChange();
        let relay: PhoneRelayChannel | PhoneSession;
        relay = hostedPair
          ? new PhoneSession({
              pair: hostedPair,
              onClaim: (claim) => {
                if (
                  request !== this.attemptGeneration ||
                  this.dead ||
                  this.phoneSession !== relay
                )
                  return;
                this.phoneClaim = claim;
                this.phoneClaimApproved = false;
                this.onChange();
              },
            })
          : new PhoneRelayChannel(this.game.token);
        if (relay instanceof PhoneSession) this.phoneSession = relay;
        else this.phoneRelay = relay;
        this.wand = new WandClient(
          new VirtualWandTransport(undefined, undefined, relay),
        );
        this.bindSamples();
        await this.wand.connect();
      }
      if (request !== this.attemptGeneration || this.dead) return;
      const state = this.wand!.getSnapshot();
      if (state.phase === "unsupported") return;
      if (state.phase === "fault" && state.canRetry) {
        this.pairingCode = this.phoneUrl = "";
        this.phoneClaim = undefined;
        return;
      }
      if (state.phase !== "streaming")
        throw new Error(state.issue || "Wand connection failed");
      if (source === "ble") await this.game.connect("ble");
      if (request !== this.attemptGeneration || this.dead) return;
      this.pairingCode = "";
      this.phoneUrl = "";
      this.phoneClaim = undefined;
      this.phoneClaimApproved = false;
      // Calibration deliberately waits for the player's explicit grip/start action.
      this.syncInputState();
    } catch (error) {
      if (request === this.attemptGeneration) {
        this.wand?.disconnect();
        this.phoneRelay = undefined;
        this.phoneSession = undefined;
        this.pairingCode = "";
        this.phoneUrl = "";
        this.phoneClaim = undefined;
        this.phoneClaimApproved = false;
        this.phoneHosted = false;
        this.game.disconnect();
        this.issue =
          error instanceof Error ? error.message : "Could not connect";
      }
    } finally {
      if (request === this.attemptGeneration) {
        this.phoneRequest = undefined;
        this.busy = false;
        this.onChange();
      }
    }
  }
  /** Explicit retry of a dropped wand link; completes the referee session a badge retry skipped. */
  async retryWand() {
    const wand = this.wand;
    if (!wand || this.busy) return;
    const request = ++this.attemptGeneration;
    this.busy = true;
    this.issue = "";
    this.onChange();
    try {
      await wand.retryRecovery();
      if (request !== this.attemptGeneration || this.dead || this.wand !== wand) return;
      const state = wand.getSnapshot();
      if (state.phase !== "streaming") {
        if (state.phase === "fault" && !state.canRetry) this.issue = state.issue || "Wand connection failed";
        return;
      }
      if (this.source === "ble" && !this.game.snapshot) await this.game.connect("ble");
      if (request !== this.attemptGeneration || this.dead) return;
      this.syncInputState();
    } catch (error) {
      if (request === this.attemptGeneration)
        this.issue = error instanceof Error ? error.message : "Could not reconnect";
    } finally {
      if (request === this.attemptGeneration) {
        this.busy = false;
        this.onChange();
      }
    }
  }
  confirmPhoneClaim() {
    const claim = this.phoneClaim;
    const phone = this.phoneSession ?? this.phoneRelay;
    if (!claim || !phone || this.phoneClaimApproved) return;
    try {
      phone.approve(claim.claimId);
      this.phoneClaimApproved = true;
    } catch {
      this.cancelPhonePairing();
      this.issue = "That iPhone confirmation expired. Start again.";
    }
    this.onChange();
  }
  cancelPhonePairing() {
    if (this.source !== "phone" || this.wand?.getSnapshot().phase === "streaming")
      return;
    this.attemptGeneration++;
    this.phoneRequest?.abort();
    this.phoneRequest = undefined;
    this.wand?.disconnect();
    this.wand = undefined;
    this.phoneRelay = undefined;
    this.phoneSession = undefined;
    this.game.disconnect();
    this.source = undefined;
    this.busy = false;
    this.pairingCode = "";
    this.phoneUrl = "";
    this.phoneClaim = undefined;
    this.phoneClaimApproved = false;
    this.phoneHosted = false;
    this.generation++;
    this.fusion.reset(this.generation);
    this.motion.reset();
    this.onChange();
  }
  private bindSamples() {
    const wand = this.wand!;
    this.unsubscribers.push(
      wand.onSample((sample) => {
        if (this.wand !== wand) return;
        this.syncInputState();
        if (sample.breaksGesture) this.fusion.reset(this.generation);
        this.motion.push(sample, this.generation);
        const state = wand.getSnapshot();
        this.phoneSession?.reportAccepted({ sequence: sample.seq, accepted: state.accepted,
          receivedHz: state.observedHz ?? 0, ageMs: Math.max(0, sample.ageUpperMs) });
        if (this.motion.getState().phase === "ready") this.calibrationIdentity = this.inputIdentity();
        this.speech.setRecognitionEnabled(
          this.motion.getState().phase === "ready",
        );
      }),
    );
  }
  private inputIdentity() {
    const info = this.wand?.getSnapshot().info;
    return info ? JSON.stringify([this.source, info.deviceId, info.bootId, info.sampleHz, info.rangeG, info.axisConvention]) : "";
  }
  private syncInputState() {
    const state = this.wand?.getSnapshot();
    if (!state) return;
    if (state.generation !== this.observedWandGeneration) {
      this.observedWandGeneration = state.generation;
      this.generation++;
      this.fusion.reset(this.generation);
      this.motion.clearPending();
      this.practiced.clear();
      this.feedbackKey = "";
      this.speech.setRecognitionEnabled(false);
      if (state.failureCode === "orientation") this.calibrationIdentity = "";
    }
    const streaming = state.phase === "streaming";
    if (streaming && !this.wasStreaming) {
      if (this.calibrationIdentity && this.calibrationIdentity === this.inputIdentity()) {
        if (!this.motion.resumeCalibration(this.generation)) this.motion.reset();
      } else this.motion.reset();
      this.issue = "";
    }
    if (!streaming && this.wasStreaming) {
      this.fusion.reset(this.generation);
      this.motion.clearPending();
      this.speech.setRecognitionEnabled(false);
      this.game.send({ type: "heartbeat", clientMs: performance.now(), inputGeneration: this.generation, healthy: false });
    }
    this.wasStreaming = streaming;
  }
  startCalibration() {
    if (this.wand?.getSnapshot().phase !== "streaming") return;
    this.syncInputState();
    this.generation++;
    this.practiced.clear();
    this.calibrationIdentity = "";
    this.fusion.reset(this.generation);
    this.speech.setRecognitionEnabled(false);
    this.motion.beginCalibration();
    this.updatePhoneCoaching();
    this.onChange();
  }
  private updatePhoneCoaching() {
    const motion = this.motion.getState();
    const mic = this.speech.getSnapshot().phase;
    const instruction = !["listening", "busy"].includes(mic) ? "Enable the laptop microphone"
      : motion.phase === "uncalibrated" ? "Find a comfortable grip. Start on the laptop."
      : motion.phase === "stillness" ? "Hold still"
      : motion.phase === "resuming" ? "Hold still for a moment"
      : motion.calibratingSpell === "stupefy" ? "Jab forward, three times"
      : motion.calibratingSpell === "protego" ? "Raise into a guard, hold, lower. Three times"
      : motion.calibratingSpell === "expelliarmus" ? "Sweep sideways, three times"
      : motion.phase === "ready" ? "Move and speak your spell" : "Continue on the laptop";
    this.phoneSession?.coach({ instruction, completed: motion.calibratingSpell ? motion.examplesBySpell[motion.calibratingSpell] : 0,
      total: motion.calibratingSpell ? 3 : 0, hint: motion.lastIssue, diagnostics: this.motion.getDiagnostics() });
  }
  async startMic() {
    this.issue = "";
    this.speech.setRecognitionEnabled(this.motion.getState().phase === "ready");
    try {
      await this.speech.start();
    } catch (error) {
      this.issue =
        error instanceof Error ? error.message : "Microphone unavailable";
    }
    this.onChange();
  }
  async startCamera(low = false) {
    const attempt = ++this.cameraAttempt;
    this.cameraIssue = "";
    let acquired: MediaStream | undefined;
    try {
      const stream = (acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: low ? 640 : 1280 },
          height: { ideal: low ? 480 : 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      }));
      if (this.dead || attempt !== this.cameraAttempt) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await this.peer.setLocalStream(stream);
      if (this.dead || attempt !== this.cameraAttempt) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.localVideo?.getTracks().forEach((t) => t.stop());
      this.localVideo = stream;
      this.syncGame();
    } catch {
      acquired?.getTracks().forEach((t) => t.stop());
      if (!this.dead && attempt === this.cameraAttempt)
        this.cameraIssue = "Camera unavailable";
    }
    this.onChange();
  }
  calibrate(spell: SpellName) {
    this.practiced.clear();
    this.fusion.reset(this.generation);
    this.motion.beginGestureCalibration(spell);
    this.speech.setRecognitionEnabled(false);
    this.onChange();
  }
  ready() {
    const info = this.wand?.getSnapshot().info;
    if (!info || !this.healthy() || this.practiced.size < 2) return;
    this.game.send({
      type: "ready",
      ready: true,
      inputGeneration: this.generation,
      healthy: true,
      deviceId: info.deviceId
        .map((n) => n.toString(16).padStart(2, "0"))
        .join(""),
      bootId: info.bootId,
    });
  }
  private syncGame() {
    if (this.game.issue) {
      // Do not perpetually renew an old battle state after losing its authority.
      this.wand?.stopFeedback();
      this.feedbackKey = "";
      this.fusion.reset(this.generation);
      this.motion.clearPending();
      return;
    }
    const state = this.game.snapshot,
      slot = this.game.slot;
    if (!state || !slot) return;
    const context = `${state.roundId}:${state.phase}`;
    if (context !== this.context) {
      this.context = context;
      this.presentationEpoch = (this.presentationEpoch + 1) >>> 0 || 1;
      this.fusion.reset(this.generation);
      this.motion.clearPending();
    }
    const own = state.players[slot],
      other = state.players[slot === "P1" ? "P2" : "P1"];
    if (other?.connected) {
      const key = `${other.slot}:${state.roomGeneration}`;
      if (key !== this.videoPeerKey) {
        this.videoPeerKey = key;
        this.peer.start(this.localVideo ?? new MediaStream(), slot === "P2");
      }
    }
    if (!other?.connected && this.videoPeerKey) {
      this.peer.stop();
      this.videoPeerKey = "";
      this.remoteVideo = undefined;
    }
    if (own && this.wand?.getSnapshot().phase === "streaming") {
      const phase =
        state.phase === "playing"
          ? PresentationPhase.Playing
          : state.phase === "countdown"
            ? PresentationPhase.Countdown
            : state.phase === "result"
              ? state.result?.outcome === "aborted"
                ? PresentationPhase.Aborted
                : state.result?.outcome === "draw"
                  ? PresentationPhase.Draw
                  : state.result?.winner === slot
                    ? PresentationPhase.Won
                    : PresentationPhase.Lost
              : PresentationPhase.Practice;
      const feedback = {
        phase,
        hp: own.hp,
        maxHp: own.maxHp,
        statusFlags:
          (own.shieldUntilMs > this.game.now() ? 1 : 0) |
          (own.offenseLockedUntilMs > this.game.now() ? 2 : 0),
        presentationEpoch: this.presentationEpoch,
      };
      const key = JSON.stringify(feedback);
      if (key !== this.feedbackKey) {
        this.feedbackKey = key;
        this.wand.setState(feedback);
      }
    }
    for (const event of state.recentEvents) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (event.roundId !== state.roundId || this.game.now() - event.atMs > 300)
        continue;
      if (
        event.type === "castAccepted" &&
        event.actor === slot &&
        event.spell
      ) {
        this.lastSpell = event.spell;
        this.lastSpellAt = performance.now();
        this.notice = "";
      }
      const effect =
        event.type === "castAccepted" && event.actor === slot
          ? CueEffect.AcceptedCast
          : event.type === "impactBlocked" && event.target === slot
            ? CueEffect.BlockedIncomingHit
            : event.type === "damage" && event.target === slot
              ? CueEffect.TookDamage
              : event.type === "roundEnded"
                ? CueEffect.RoundResult
                : undefined;
      if (effect !== undefined)
        this.wand?.cue({
          effect,
          spell: event.spell ? codeOf(event.spell) : SpellCode.None,
          durationMs: 180,
          presentationEpoch: this.presentationEpoch,
        });
    }
    if (this.seen.size > 512) this.seen = new Set([...this.seen].slice(-256));
  }
  destroy() {
    this.dead = true;
    this.attemptGeneration++;
    this.phoneRequest?.abort();
    this.phoneRequest = undefined;
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.visibility);
    this.wand?.disconnect();
    this.speech.stop();
    this.peer.stop();
    this.game.disconnect();
    this.localVideo?.getTracks().forEach((t) => t.stop());
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}

/** The local broker explains refusals in a small JSON body; show that instead of a generic line. */
async function brokerIssue(response: Response, fallback: string): Promise<string> {
  try {
    const value: unknown = await response.json();
    const issue = value && typeof value === "object" ? (value as { issue?: unknown }).issue : undefined;
    if (typeof issue === "string" && issue.length > 0 && issue.length <= 120) return issue;
  } catch {
    // no usable body
  }
  return fallback;
}

async function hostedPhoneEnabled(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/phone/config", {
    cache: "no-store",
    method: "POST",
    signal,
  });
  if (!response.ok) throw new Error(await brokerIssue(response, "Phone pairing is unavailable."));
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { enabled?: unknown }).enabled !== "boolean"
  )
    throw new Error("Phone pairing returned an invalid response.");
  return (value as { enabled: boolean }).enabled;
}

async function createHostedPair(signal: AbortSignal): Promise<HostedPair> {
  const response = await fetch("/api/phone/pair", { method: "POST", signal });
  if (!response.ok) throw new Error(await brokerIssue(response, "Phone pairing is unavailable."));
  return parseHostedPair(await response.json());
}
export const nameOf = (spell: SpellName) =>
  spell[0].toUpperCase() + spell.slice(1);
const codeOf = (spell: SpellName) =>
  spell === "stupefy"
    ? SpellCode.Stupefy
    : spell === "protego"
      ? SpellCode.Protego
      : SpellCode.Expelliarmus;
