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
import { MotionRecognizer } from "../input/motion";
import { AccelerationSpikeRecognizer } from "../input/spike";
import { CastFusion, type CastRejection } from "../input/fusion";
import { SpeechClient } from "../speech/client";
import { GameClient, ROOM_CODE_PATTERN, normalizeRoomCode } from "./client";
import { DuelTelemetry } from "./telemetry";
import {
  CueEffect,
  PresentationPhase,
  SpellCode,
  StateStatusFlag,
  formatDeviceId,
} from "../wand/protocol";
import type { GameMode, Source, Spell } from "./contracts";

export class DuelController {
  readonly game = new GameClient();
  readonly speech = new SpeechClient();
  readonly motion: MotionRecognizer;
  readonly fusion: CastFusion;
  readonly spikes: AccelerationSpikeRecognizer;
  private simpleMotionEnabled = false;
  get simpleMotion(): boolean { return this.devMode && this.simpleMotionEnabled; }
  readonly telemetry = new DuelTelemetry();
  devMode = false;
  wand?: WandClient;
  source?: Source;
  /** The duel this player started or joined; every referee session is created inside it. */
  roomCode = "";
  mode: GameMode = "duel";
  /** The battle lobby opens as soon as the wand streams; Ready still needs healthy input. */
  battleLobby = false;
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
  lastSpell?: Spell;
  lastSpellAt = 0;
  miscast?: { id: string; spell: Spell; atMs: number; message: string };
  renderingReady = false;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribers: (() => void)[] = [];
  private seen = new Set<string>();
  private pendingCasts = new Map<string, { spell: Spell; roomId: string; roomGeneration: number;
    roundId: number; generation: number; context: string; sentAtMs: number }>();
  private presentedCasts = new Set<string>();
  private context = "";
  private feedbackKey = "";
  private presentationEpoch =
    crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  private dead = false;
  private attemptGeneration = 0;
  private phoneRelay?: PhoneRelayChannel;
  phoneSession?: PhoneSession;
  private observedWandGeneration = -1;
  private wasStreaming = false;
  private phoneRequest?: AbortController;
  private diagnosticKeys = new Map<string, string>();
  onChange = () => {};

  constructor() {
    this.fusion = new CastFusion((attempt) => {
      this.telemetry.record("cast.attempt", { ...attempt, input: this.simpleMotion ? "speech+acceleration-spike" : "speech+motion", healthy: this.healthy() });
      if (!this.healthy()) return;
      this.miscast = undefined;
      if (this.game.snapshot?.phase === "playing") {
        this.trackCast(attempt.id, attempt.spell);
        this.game.send({
          type: "cast",
          roundId: this.game.snapshot.roundId,
          attemptId: attempt.id,
          spell: attempt.spell,
          gestureId: attempt.gestureId,
          speechId: attempt.utteranceId,
          inputGeneration: this.generation,
        });
      } else if (
        this.game.snapshot?.phase === "lobby" ||
        this.game.snapshot?.phase === "result"
      ) {
        this.lastSpell = attempt.spell;
        this.lastSpellAt = performance.now();
        this.notice = `${nameOf(attempt.spell)}!`;
        this.wand?.cue({
          effect: CueEffect.AcceptedCast,
          spell: codeOf(attempt.spell),
          durationMs: 180,
          presentationEpoch: this.presentationEpoch,
        });
      }
      this.onChange();
    }, rejection => this.showMiscast(rejection));
    this.motion = new MotionRecognizer((evidence) => {
      this.telemetry.record(this.simpleMotion ? "gesture.shadow" : "gesture.accepted", evidence);
      if (this.simpleMotion || this.game.snapshot?.tutorial?.paused) return;
      this.fusion.pushGesture(evidence);
      this.recordFusion();
    });
    this.spikes = new AccelerationSpikeRecognizer(evidence => {
      this.telemetry.record("motion.spike", evidence);
      if (!this.simpleMotion || document.hidden || !this.recognitionEnabled()) return;
      this.fusion.pushGesture(evidence);
      this.recordFusion();
    });
    this.speech.setRecognitionEnabled(false);
    this.unsubscribers.push(
      this.speech.onOnset((e) => {
        this.telemetry.record("speech.onset", e);
        // Calibration speech cannot become a cast just as the last example ends.
        if (!document.hidden && this.recognitionEnabled())
          this.fusion.beginUtterance({ ...e, generation: this.generation });
      }),
      this.speech.onSpeech((e) => {
        this.telemetry.record("speech.evidence", e);
        if (!document.hidden && this.recognitionEnabled())
          this.fusion.pushUtterance({
            ...e,
            generation: this.generation,
            finalAtMs: e.arrivedMs,
          });
        this.recordFusion();
      }),
      this.speech.onDiscard((e) => {
        this.telemetry.record("speech.discard", { ...e, recognitionEnabled: this.recognitionEnabled(),
          speechPhase: this.speech.getSnapshot().phase, tutorial: this.game.snapshot?.tutorial ?? null });
        // Speech capture and wand input have separate generations, just as at onset.
        if (e.generation === this.speech.getSnapshot().generation)
          this.fusion.cancelUtterance(e.id, this.generation, e.disposition);
        this.recordFusion();
      }),
      this.speech.onDiagnostic(event => this.telemetry.record(`speech.${event.type}`, event, event.atMs)),
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
      this.telemetry.record("game.ack", message);
      if (message.command !== "cast" || typeof message.requestId !== "string") return;
      this.pruneCasts();
      const pending = this.pendingCasts.get(message.requestId);
      if (!pending) return;
      if (message.accepted === true && typeof message.actionId === "string" && message.actionId) {
        this.pendingCasts.delete(message.requestId);
        this.presentAcceptedCast(pending.spell, message.actionId);
        this.onChange();
      } else if (message.accepted === false) {
        this.pendingCasts.delete(message.requestId);
        this.notice =
          message.reason === "cooldown"
            ? "Spell recharging"
            : message.reason === "full_health"
              ? "Your health is already full"
              : message.reason === "offense_locked"
                ? "Disarmed — defend or heal"
                : "Spell not ready";
        this.noticeAt = performance.now();
        this.lastSpell = undefined;
        this.onChange();
      }
    };
    document.addEventListener("visibilitychange", this.visibility);
    this.timer = setInterval(() => {
      this.syncInputState();
      if (this.miscast && (performance.now() - this.miscast.atMs > 2_200 || !this.healthy()))
        this.miscast = undefined;
      this.fusion.advance(performance.now());
      this.recordFusion();
      this.syncGame();
      this.updatePhoneCoaching();
      this.onChange();
    }, 100);
  }
  setDevMode(enabled: boolean) {
    if (this.roomCode || this.busy) return;
    if (!enabled) this.setSimpleMotion(false);
    this.devMode = enabled;
    this.telemetry.enabled = enabled;
    this.diagnosticKeys.clear();
    this.configureWandTelemetry();
    this.telemetry.record("settings", { devMode: enabled, source: this.source ?? "unpaired" });
    this.onChange();
  }
  setSimpleMotion(enabled: boolean): void {
    if ((enabled && !this.devMode) || this.roomCode || this.busy || enabled === this.simpleMotionEnabled) return;
    this.simpleMotionEnabled = enabled;
    this.speech.setRecognitionEnabled(false);
    this.generation++;
    this.fusion.setSimpleMotion(enabled);
    this.fusion.reset(this.generation);
    this.spikes.reset();
    this.motion.clearPending();
    this.miscast = undefined;
    this.telemetry.record("settings", { devMode: this.devMode, simpleMotion: enabled });
    this.onChange();
  }
  exportTelemetry(): string {
    const info = this.wand?.getSnapshot().info;
    return this.telemetry.export({
      source: this.wand?.getSnapshot().source ?? "unpaired",
      mode: this.mode,
      inputGeneration: this.generation,
      profile: info ? { sampleHz: info.sampleHz, rangeG: info.rangeG, axisConvention: info.axisConvention,
        firmware: info.firmware, bootId: info.bootId } : null,
      speech: "local microphone; no audio retained",
      developerClicksEnabled: this.devMode,
      simpleMotionEnabled: this.simpleMotion,
      rules: this.game.rules ?? null,
      gestureProfile: this.simpleMotion ? "acceleration-spike-v1" : "quick-play-jab-raise-v5",
      context: { phase: this.game.snapshot?.phase ?? "paired", tutorial: this.game.snapshot?.tutorial ?? null,
        speech: this.speech.getSnapshot(), recognitionEnabled: this.recognitionEnabled(),
        gesture: this.motion.getState(), fusion: this.fusion.getState() },
    });
  }
  canCastSpell(spell: Spell): boolean {
    const state = this.game.snapshot, slot = this.game.slot;
    const own = slot ? state?.players[slot] : undefined;
    const rule = this.game.rules?.spells.find(item => item.spell === spell);
    if (!this.devMode || !this.healthy() || state?.phase !== "playing" || !own || !rule?.enabled) return false;
    if (state.tutorial?.paused || (state.tutorial?.stage === "practice" && state.tutorial.spell !== spell)) return false;
    if (own.cooldownUntilMs[spell] > this.game.now()) return false;
    if (spell === "episkey" && own.hp >= own.maxHp) return false;
    return !(rule.damage > 0 && own.offenseLockedUntilMs > this.game.now());
  }
  castSpell(spell: Spell): void {
    if (!this.canCastSpell(spell)) return;
    this.miscast = undefined;
    const id = `dev:${crypto.randomUUID()}`;
    this.telemetry.record("cast.attempt", { id, spell, input: "developer-click", generation: this.generation });
    this.trackCast(id, spell);
    this.game.send({ type: "cast", roundId: this.game.snapshot!.roundId, attemptId: id,
      spell, gestureId: id, speechId: id, inputGeneration: this.generation });
  }
  advanceTutorial(): void {
    const state = this.game.snapshot;
    if (!state?.tutorial || !state.tutorial.paused || !this.healthy()) return;
    this.game.send({ type: "tutorialContinue", roundId: state.roundId, step: state.tutorial.step });
  }
  private configureWandTelemetry(): void {
    if (!this.wand) return;
    this.wand.onDiagnostic = this.devMode
      ? event => this.telemetry.record(event.kind, event.data, event.atMs)
      : undefined;
  }
  private recordChanged(kind: string, value: unknown): void {
    if (!this.devMode) return;
    const key = JSON.stringify(value);
    if (this.diagnosticKeys.get(kind) === key) return;
    this.diagnosticKeys.set(kind, key);
    this.telemetry.record(kind, value);
  }
  private recordFusion(): void {
    this.recordChanged("fusion", this.fusion.getState());
  }
  private gameContext(): string {
    const state = this.game.snapshot;
    return state && this.game.slot
      ? `${state.roomId}:${state.roundId}:${state.phase}:${state.tutorial?.step}:${state.tutorial?.stage}` : "paired";
  }
  private trackCast(id: string, spell: Spell): void {
    const state = this.game.snapshot!;
    this.pruneCasts();
    this.pendingCasts.set(id, { spell, roomId: state.roomId, roomGeneration: state.roomGeneration,
      roundId: state.roundId, generation: this.generation, context: this.gameContext(), sentAtMs: performance.now() });
    if (this.pendingCasts.size > 32) this.pendingCasts.delete(this.pendingCasts.keys().next().value!);
  }
  private pruneCasts(): void {
    const state = this.game.snapshot, now = performance.now(), context = this.gameContext();
    for (const [id, cast] of this.pendingCasts) {
      if (this.dead || document.hidden || this.game.issue || this.wand?.getSnapshot().phase !== "streaming" ||
        state?.phase !== "playing" || state.roomId !== cast.roomId || state.roomGeneration !== cast.roomGeneration ||
        state.roundId !== cast.roundId || this.generation !== cast.generation || context !== cast.context ||
        now - cast.sentAtMs > 2_000) this.pendingCasts.delete(id);
    }
  }
  private presentAcceptedCast(spell: Spell, actionId?: string | null): void {
    const state = this.game.snapshot!;
    if (actionId) {
      const key = `${state.roomId}:${state.roomGeneration}:${state.roundId}:${actionId}`;
      if (this.presentedCasts.has(key)) return;
      this.presentedCasts.add(key);
      if (this.presentedCasts.size > 128) this.presentedCasts.delete(this.presentedCasts.values().next().value!);
    }
    this.miscast = undefined;
    this.lastSpell = spell;
    this.lastSpellAt = performance.now();
    this.notice = "";
    this.wand?.cue({ effect: CueEffect.AcceptedCast, spell: codeOf(spell), durationMs: 180,
      presentationEpoch: this.presentationEpoch });
  }
  private showMiscast(rejection: CastRejection): void {
    this.telemetry.record("cast.rejected_input", rejection);
    const state = this.game.snapshot;
    if (rejection.utterance.generation !== this.generation || !this.healthy() ||
      state?.phase !== "playing" || state.tutorial?.paused) return;
    const spell = rejection.utterance.spell;
    const support = spell === "protego" || spell === "episkey";
    const action = rejection.reason === "evidence-timing-mismatch"
      ? "Speak and move together."
      : this.simpleMotion ? "Move your wand as you say the spell."
        : support ? "Raise your wand and hold briefly." : "Give your wand a clear forward jab.";
    this.miscast = { id: `${this.generation}:${rejection.utterance.id}`, spell,
      atMs: performance.now(), message: `${nameOf(spell)} fizzled. ${action}` };
    this.onChange();
  }
  private recognitionEnabled(): boolean {
    return this.motion.getState().phase === "ready" && !this.game.snapshot?.tutorial?.paused;
  }
  private visibility = () => {
    if (document.hidden) {
      this.pendingCasts.clear();
      this.miscast = undefined;
      this.generation++;
      this.fusion.reset(this.generation);
      this.spikes.reset();
      this.motion.clearPending();
      this.wand?.suspend();
      this.speech.stop();
      this.sendUnhealthyHeartbeat();
      this.issue = "Paused while you’re away.";
      this.onChange();
    } else void this.resumeInput();
  };
  private async resumeInput() {
    const wand = this.wand;
    await wand?.resume();
    if (this.dead || document.hidden || this.wand !== wand) return;
    this.syncInputState();
    this.issue = "";
    this.autoStartMic();
    if (
      this.game.issue ||
      (wand?.getSnapshot().phase === "streaming" && !this.game.snapshot)
    )
      await this.reconnectBattle();
    this.onChange();
  }
  private sendUnhealthyHeartbeat() {
    this.game.send({
      type: "heartbeat",
      clientMs: performance.now(),
      inputGeneration: this.generation,
      healthy: false,
    });
  }
  healthy() {
    const mic = this.speech.getSnapshot().phase;
    return (
      !document.hidden &&
      !this.game.issue &&
      this.wand?.getSnapshot().phase === "streaming" &&
      this.motion.getState().phase === "ready" &&
      (this.devMode || ["listening", "busy"].includes(mic)) &&
      this.renderingReady
    );
  }
  /** Open a new room on the referee and show its code for the opponent. */
  async startDuel(mode: GameMode = "duel") {
    if (
      this.busy ||
      this.roomCode ||
      !this.source ||
      this.wand?.getSnapshot().phase !== "streaming"
    )
      return;
    this.busy = true;
    this.mode = mode;
    this.issue = "";
    this.onChange();
    try {
      if (mode !== "duel") await this.game.connect(this.source, undefined, mode);
      else await this.game.connect(this.source);
      this.roomCode = this.game.snapshot!.roomId;
    } catch (error) {
      this.game.disconnect();
      this.issue =
        error instanceof Error ? error.message : "Could not start a duel";
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
  /** Join the opponent's room using the already paired wand. */
  async joinDuel(input: string) {
    if (
      this.busy ||
      this.roomCode ||
      !this.source ||
      this.wand?.getSnapshot().phase !== "streaming"
    )
      return;
    const code = normalizeRoomCode(input);
    if (!ROOM_CODE_PATTERN.test(code)) {
      this.issue = "Enter the six-character duel code.";
      this.onChange();
      return;
    }
    this.issue = "";
    this.busy = true;
    this.mode = "duel";
    this.onChange();
    try {
      await this.game.connect(this.source, code);
      this.roomCode = code;
    } catch (error) {
      this.game.disconnect();
      this.issue =
        error instanceof Error ? error.message : "Could not join the duel.";
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
  leaveRoom() {
    this.pendingCasts.clear();
    this.presentedCasts.clear();
    this.miscast = undefined;
    this.game.disconnect();
    this.game.issue = "";
    this.roomCode = "";
    this.mode = "duel";
    this.context = "";
    this.feedbackKey = "";
    this.seen.clear();
    this.issue = "";
    this.wand?.stopFeedback();
    this.generation++;
    this.fusion.reset(this.generation);
    this.spikes.reset();
    this.motion.clearPending();
    this.onChange();
  }
  async reconnectBattle() {
    if (this.busy || !this.source || !this.roomCode) return;
    this.busy = true;
    this.issue = "";
    const request = this.attemptGeneration;
    this.generation++;
    this.fusion.reset(this.generation);
    this.spikes.reset();
    this.speech.setRecognitionEnabled(false);
    this.motion.useDefaultProfile(this.generation);
    this.onChange();
    try {
      const reattached = await this.game.reconnect();
      if (this.dead || request !== this.attemptGeneration) return;
      if (!reattached) await this.reopenRoom(this.source);
    } catch (error) {
      if (!this.dead && request === this.attemptGeneration)
        this.issue =
          error instanceof Error
            ? error.message
            : "Could not reconnect to the battle.";
    } finally {
      if (!this.dead && request === this.attemptGeneration) {
        this.busy = false;
        this.onChange();
      }
    }
  }
  private async reopenRoom(source: Source) {
    if (this.mode !== "duel") {
      await this.game.connect(source, undefined, this.mode);
      this.roomCode = this.game.snapshot!.roomId;
    } else await this.game.connect(source, this.roomCode);
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
    this.context = "";
    this.feedbackKey = "";
    this.seen.clear();
    this.source = source;
    this.generation++;
    this.fusion.reset(this.generation);
    this.spikes.reset();
    this.speech.setRecognitionEnabled(false);
    this.motion.reset();
    this.phoneRequest?.abort();
    this.phoneRequest = undefined;
    this.wand?.disconnect();
    this.phoneRelay = undefined;
    this.phoneSession = undefined;
    this.wasStreaming = false;
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
        const hosted = await hostedPhoneBroker(phoneRequest.signal);
        if (!hosted && location.protocol !== "https:")
          throw new Error("iPhone pairing is not set up on this referee.");
        const hostedPair = hosted
          ? await createHostedPair(phoneRequest.signal, hosted)
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
          : new PhoneRelayChannel(localPair!.ownerToken);
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
      if (["suspended", "recovering", "validating"].includes(state.phase))
        return;
      if (state.phase === "fault" && state.canRetry) {
        this.pairingCode = this.phoneUrl = "";
        this.phoneClaim = undefined;
        return;
      }
      if (state.phase !== "streaming")
        throw new Error(state.issue || "Wand connection failed");
      if (this.roomCode) await this.reopenRoom(source);
      if (request !== this.attemptGeneration || this.dead) return;
      this.pairingCode = "";
      this.phoneUrl = "";
      this.phoneClaim = undefined;
      this.phoneClaimApproved = false;
      this.syncInputState();
      this.autoStartMic();
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
      if (request !== this.attemptGeneration || this.dead || this.wand !== wand)
        return;
      const state = wand.getSnapshot();
      if (state.phase !== "streaming") {
        if (state.phase === "fault" && !state.canRetry)
          this.issue = state.issue || "Wand connection failed";
        return;
      }
      if (this.source === "ble" && this.roomCode && !this.game.snapshot)
        await this.reopenRoom("ble");
      if (request !== this.attemptGeneration || this.dead) return;
      this.syncInputState();
      this.autoStartMic();
    } catch (error) {
      if (request === this.attemptGeneration)
        this.issue =
          error instanceof Error ? error.message : "Could not reconnect";
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
    if (
      this.source !== "phone" ||
      this.wand?.getSnapshot().phase === "streaming"
    )
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
    this.spikes.reset();
    this.motion.reset();
    this.onChange();
  }
  private bindSamples() {
    const wand = this.wand!;
    this.configureWandTelemetry();
    this.unsubscribers.push(
      wand.onSample((sample) => {
        if (this.wand !== wand || document.hidden) return;
        this.syncInputState();
        if (sample.breaksGesture) {
          this.fusion.reset(this.generation);
          this.spikes.reset();
        }
        this.motion.push(sample, this.generation);
        if (this.simpleMotion && this.recognitionEnabled()) this.spikes.push(sample, this.generation);
        else this.spikes.reset();
        this.recordChanged("gesture.candidate", this.motion.getDiagnostics());
        const motion = this.motion.getState();
        this.recordChanged("gesture.state", { phase: motion.phase, progress: motion.progress, reason: motion.reason, issue: motion.lastIssue });
        const state = wand.getSnapshot();
        this.phoneSession?.reportAccepted({
          sequence: sample.seq,
          accepted: state.accepted,
          receivedHz: state.observedHz ?? 0,
          ageMs: Math.max(0, sample.ageUpperMs),
        });
        this.speech.setRecognitionEnabled(this.recognitionEnabled());
      }),
    );
  }
  private syncInputState() {
    const state = this.wand?.getSnapshot();
    if (!state) return;
    this.recordChanged("wand.state", { phase: state.phase, generation: state.generation, issue: state.issue,
      lost: state.lost, rejected: state.rejected, deviceDropped: state.deviceDropped, rttMs: state.rttMs });
    if (state.generation !== this.observedWandGeneration) {
      this.pendingCasts.clear();
      this.miscast = undefined;
      this.observedWandGeneration = state.generation;
      this.generation++;
      this.fusion.reset(this.generation);
      this.spikes.reset();
      this.motion.useDefaultProfile(this.generation);
      this.feedbackKey = "";
      this.speech.setRecognitionEnabled(false);
    }
    const streaming = state.phase === "streaming";
    if (streaming && !this.wasStreaming) {
      this.motion.useDefaultProfile(this.generation);
      this.battleLobby = true;
      this.issue = "";
    }
    // Any recognizer reset while the wand streams (a generation change it did not see) is
    // repaired with the shared profile instead of leaving Ready unexplainedly disabled.
    if (streaming && this.motion.getState().phase !== "ready")
      this.motion.useDefaultProfile(this.generation);
    if (!streaming && this.wasStreaming) {
      this.pendingCasts.clear();
      this.miscast = undefined;
      this.fusion.reset(this.generation);
      this.spikes.reset();
      this.motion.clearPending();
      this.speech.setRecognitionEnabled(false);
      this.sendUnhealthyHeartbeat();
    }
    this.wasStreaming = streaming;
  }
  /** The microphone starts as soon as the wand streams; a failure leaves the lobby's mic button. */
  private autoStartMic() {
    if (document.hidden || this.wand?.getSnapshot().phase !== "streaming")
      return;
    if (
      this.speech.getSnapshot().phase !== "off" &&
      this.speech.getSnapshot().phase !== "fault"
    )
      return;
    void this.startMic();
  }
  private updatePhoneCoaching() {
    const motion = this.motion.getState();
    const mic = this.speech.getSnapshot().phase;
    const instruction = this.game.snapshot?.tutorial?.paused
      ? "Read the lesson on your laptop"
      : !["listening", "busy"].includes(mic) && !this.devMode
      ? "Enable the laptop microphone"
      : motion.phase === "ready"
        ? "Move and speak your spell"
        : "Continue on the laptop";
    this.phoneSession?.coach({
      instruction,
      completed: 0,
      total: 0,
      hint: motion.lastIssue,
      diagnostics: this.motion.getDiagnostics(),
    });
  }
  async startMic() {
    this.issue = "";
    this.speech.setRecognitionEnabled(this.recognitionEnabled());
    try {
      await this.speech.start();
    } catch (error) {
      const issue = error instanceof Error ? error.message : "Microphone unavailable";
      if (!this.devMode) this.issue = issue;
      this.telemetry.record("speech.setup_failed", { issue });
    }
    this.onChange();
  }
  canReady(): boolean {
    const state = this.game.snapshot, slot = this.game.slot;
    const own = slot ? state?.players[slot] : undefined;
    if (!state || !slot || !own?.connected || own.ready || this.busy || !this.healthy() ||
      !this.wand?.getSnapshot().info || (state.phase !== "lobby" && state.phase !== "result")) return false;
    return state.mode !== "duel" || state.players[slot === "P1" ? "P2" : "P1"]?.connected === true;
  }
  ready() {
    const info = this.wand?.getSnapshot().info;
    if (!info || !this.canReady()) return;
    this.battleLobby = true;
    this.game.send({
      type: "ready",
      ready: true,
      inputGeneration: this.generation,
      healthy: true,
      deviceId: formatDeviceId(info.deviceId),
      bootId: info.bootId,
    });
  }
  private syncGame() {
    this.pruneCasts();
    this.recordChanged("game.connection", { issue: this.game.issue, mode: this.mode });
    if (this.game.issue || document.hidden) {
      this.miscast = undefined;
      // Do not perpetually renew an old battle state after losing its authority.
      this.wand?.stopFeedback();
      this.feedbackKey = "";
      this.fusion.reset(this.generation);
      this.spikes.reset();
      this.motion.clearPending();
      return;
    }
    const state = this.game.snapshot,
      slot = this.game.slot;
    const context = this.gameContext();
    if (context !== this.context) {
      this.miscast = undefined;
      this.context = context;
      this.presentationEpoch = (this.presentationEpoch + 1) >>> 0 || 1;
      this.fusion.reset(this.generation);
      this.spikes.reset();
      this.motion.clearPending();
      this.speech.setRecognitionEnabled(this.recognitionEnabled());
    }
    if (!state || !slot) {
      const key = `paired:${this.presentationEpoch}`;
      if (
        this.wand?.getSnapshot().phase === "streaming" &&
        this.feedbackKey !== key
      ) {
        this.feedbackKey = key;
        this.wand.setState({
          phase: PresentationPhase.Practice,
          hp: 100,
          maxHp: 100,
          statusFlags: 0,
          presentationEpoch: this.presentationEpoch,
        });
      }
      return;
    }
    const own = state.players[slot];
    this.recordChanged("game.state", { mode: state.mode, phase: state.phase, roundId: state.roundId,
      tutorial: state.tutorial, hp: { P1: state.players.P1?.hp, P2: state.players.P2?.hp }, result: state.result });
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
          (own.shieldUntilMs > this.game.now()
            ? StateStatusFlag.ShieldActive
            : 0) |
          (own.offenseLockedUntilMs > this.game.now()
            ? StateStatusFlag.OffenseLocked
            : 0),
        presentationEpoch: this.presentationEpoch,
      };
      const key = JSON.stringify(feedback);
      if (key !== this.feedbackKey) {
        this.feedbackKey = key;
        this.wand.setState(feedback);
      }
    }
    for (const event of state.recentEvents) {
      const eventKey = `${state.roomId}:${event.id}`;
      if (this.seen.has(eventKey)) continue;
      this.seen.add(eventKey);
      const receivedAtMs = performance.now();
      const clock = this.game.clockEstimate();
      this.telemetry.record("game.event", {
        ...event,
        estimatedBrowserAtMs: clock.serverMinusBrowserMs === null
          ? null : event.atMs - clock.serverMinusBrowserMs,
        ...clock,
      }, receivedAtMs);
      if (event.roundId !== state.roundId || this.game.now() - event.atMs > 300)
        continue;
      if (
        event.type === "castAccepted" &&
        event.actor === slot &&
        event.spell
      ) {
        this.presentAcceptedCast(event.spell, event.actionId);
        continue;
      }
      const effect =
        event.type === "impactBlocked" && event.target === slot
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
    this.pendingCasts.clear();
    this.dead = true;
    this.attemptGeneration++;
    this.phoneRequest?.abort();
    this.phoneRequest = undefined;
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.visibility);
    this.wand?.disconnect();
    this.speech.stop();
    this.game.disconnect();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}

/** The local broker explains refusals in a small JSON body; show that instead of a generic line. */
async function brokerIssue(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const value: unknown = await response.json();
    const issue =
      value && typeof value === "object"
        ? (value as { issue?: unknown }).issue
        : undefined;
    if (typeof issue === "string" && issue.length > 0 && issue.length <= 120)
      return issue;
  } catch {
    // no usable body
  }
  return fallback;
}

async function brokerPost(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    cache: "no-store",
    method: "POST",
    signal,
  });
  if (!response.ok)
    throw new Error(
      await brokerIssue(response, "Phone pairing is unavailable."),
    );
  return response.json();
}

/**
 * Who mints the hosted phone pair: this laptop's own broker when its launcher holds the enrollment
 * secret, otherwise the referee, which keeps the secret for every laptop. Neither path needs a
 * certificate on the laptop or the phone.
 */
type PhoneBroker = "local" | "referee";

async function hostedPhoneBroker(
  signal: AbortSignal,
): Promise<PhoneBroker | undefined> {
  const value = await brokerPost("/api/phone/config", signal);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { enabled?: unknown }).enabled !== "boolean"
  )
    throw new Error("Phone pairing returned an invalid response.");
  if ((value as { enabled: boolean }).enabled) return "local";
  const response = await fetch("/api/game/health", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Start the game server to connect.");
  const health: unknown = await response.json();
  return health &&
    typeof health === "object" &&
    (health as { phoneBroker?: unknown }).phoneBroker === true
    ? "referee"
    : undefined;
}

async function createHostedPair(
  signal: AbortSignal,
  broker: PhoneBroker,
): Promise<HostedPair> {
  if (broker === "local")
    return parseHostedPair(await brokerPost("/api/phone/pair", signal));
  const response = await fetch("/api/game/phone/pair", {
    cache: "no-store",
    method: "POST",
    signal,
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Wait a moment, then reconnect."
        : response.status === 404
          ? "iPhone pairing is not set up on this referee."
          : "Phone connection unavailable. Try again.",
    );
  return parseHostedPair(await response.json());
}
export const nameOf = (spell: Spell) => spell[0].toUpperCase() + spell.slice(1);
const codeOf = (spell: Spell) =>
  spell === "stupefy"
    ? SpellCode.Stupefy
    : spell === "protego"
      ? SpellCode.Protego
      : spell === "expelliarmus"
        ? SpellCode.Expelliarmus
        : spell === "incendio"
          ? SpellCode.Incendio
          : SpellCode.Episkey;
