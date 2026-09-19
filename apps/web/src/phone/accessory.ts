import type { AcceptedMotion, PhoneCoaching, PhoneData } from "../../../../shared/phone-v2";
import { VirtualWandEndpoint } from "../wand/endpoint";
import { MotionFlag, type InfoRecord } from "../wand/protocol";
import { PhoneLink, type PhoneLinkState } from "./link";
import { PhoneSampler } from "./sensor";
import { PhoneTrace } from "./trace";

export type AccessoryState = {
  link: PhoneLinkState; challenge: string; paused: boolean;
  sensorActive: boolean; reachingLaptop: boolean; observedHz: number; receivedHz: number; ageMs?: number;
  movement: number; coaching?: PhoneCoaching; hp?: number; cue: number;
  lastIssue?: string;
};
/** Raw phone acceleration under the same device endpoint as deterministic tests. */
export class PhoneAccessory {
  private link: PhoneLink;
  private endpoint: VirtualWandEndpoint;
  private sampler = new PhoneSampler();
  private trace = new PhoneTrace();
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(state: AccessoryState) => void>();
  private challenge = "";
  private paused = false;
  private started = false;
  private lastObservation = -Infinity;
  private lastAcceptance = -Infinity;
  private lastAcceptedCount = -1;
  private accepted?: AcceptedMotion;
  private observationTimes: number[] = [];
  private motionQueue: { data: number[]; at: number }[] = [];
  private motionDiscontinuityPending = false;
  private motionSequence = 0;
  private inFlightMotion: { sequence: number; at: number }[] = [];
  private inFlightStatus = new Map<string, number>();
  private statusSequence = 0;
  private beginId?: string;
  private begunGeneration = 0;
  private pendingBegin?: PhoneData & { kind: "begin-link" };
  private lastTick = 0;
  private lastFlush = 0;
  private lastHealth = 0;
  private lastUi = 0;
  private movement = 0;
  private priorAxes?: [number, number, number];
  private coaching?: PhoneCoaching;
  private lastIssue?: string;
  constructor(private readonly info: InfoRecord, url: string) {
    this.endpoint = this.makeEndpoint();
    this.link = new PhoneLink({ role: "phone", url,
      onMessage: message => { if (message.type === "awaiting") this.challenge = message.challenge; },
      onData: message => this.receive(message),
      onCarrier: () => { this.challenge = ""; },
      onFailure: failure => { this.lastIssue = failure.message; this.endpoint.disconnect(); this.begunGeneration = 0; this.motionQueue = []; this.inFlightMotion = []; this.inFlightStatus.clear(); this.lastAcceptance = -Infinity; },
      onState: () => {},
    });
  }
  subscribe(listener: (state: AccessoryState) => void) { this.listeners.add(listener); listener(this.getState()); return () => { this.listeners.delete(listener); }; }
  start() { if (this.timer) return; this.lastTick = performance.now(); this.timer = setInterval(() => this.tick(), 20); }
  observe(x: number | null, y: number | null, z: number | null, at = performance.now()) {
    if (this.paused || ![x,y,z,at].every(n => typeof n === "number" && Number.isFinite(n))) return;
    this.sampler.observe(x, y, z, at); this.lastObservation = at;
    this.observationTimes.push(at); while (this.observationTimes[0] < at - 1000) this.observationTimes.shift();
    const change = this.priorAxes ? Math.hypot(x! - this.priorAxes[0], y! - this.priorAxes[1], z! - this.priorAxes[2]) : 0;
    this.movement = Math.min(1, Math.max(change, Math.abs(Math.hypot(x!, y!, z!) - 9.80665)) / 5);
    this.priorAxes = [x!, y!, z!];
    this.trace.add({ event: "observation", generation: this.link.generation, x: x!, y: y!, z: z! });
  }
  getState(): AccessoryState {
    const now = performance.now(), shown = this.endpoint.getPresentation();
    return { link: { ...this.link.state }, challenge: this.challenge, paused: this.paused,
      sensorActive: !this.paused && now - this.lastObservation <= 500,
      reachingLaptop: !this.paused && now - this.lastAcceptance <= 500,
      observedHz: now - this.lastObservation <= 500 ? this.observationTimes.length : 0,
      receivedHz: now - this.lastAcceptance <= 500 ? this.accepted?.receivedHz ?? 0 : 0,
      ageMs: now - this.lastAcceptance <= 500 ? this.accepted?.ageMs : undefined,
      movement: !this.paused && now - this.lastObservation <= 500 ? this.movement : 0, coaching: this.coaching, hp: shown.state?.hp, cue: shown.cue?.effect ?? 0, lastIssue: this.lastIssue };
  }
  pause(code: "paused" | "orientation" | "sensor" = "paused") {
    if (this.paused) return;
    this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "issue", code, recoverable: true });
    this.paused = true; this.link.setPaused(true); this.endpoint.disconnect(); this.motionQueue = []; this.lastAcceptance = -Infinity;
    this.trace.add({ event: "pause", generation: this.link.generation, reason: code });
    this.emit();
  }
  resume() {
    this.paused = false; this.sampler = new PhoneSampler(); this.lastObservation = -Infinity; this.observationTimes = []; this.priorAxes = undefined; this.lastTick = performance.now();
    this.link.setPaused(false);
    if (this.pendingBegin) { const message = this.pendingBegin; this.pendingBegin = undefined; this.receive(message); }
    this.emit();
  }
  close() { clearInterval(this.timer); this.timer = undefined; this.endpoint.disconnect(); this.link.close(); this.motionQueue = []; this.listeners.clear(); }
  exportTrace() { return this.trace.export(); }
  private makeEndpoint() { return new VirtualWandEndpoint({ info: this.info, nowMs: () => performance.now(), sensorHealthy: false }); }
  private tick() {
    const now = performance.now();
    if (!this.paused && now - this.lastTick > 200) this.pause();
    this.lastTick = now;
    if (!this.paused) {
      const sample = this.sampler.select(now, this.info.bootId);
      if (sample) {
        this.trace.add({ event: "selected", generation: this.link.generation, seq: sample.seq, captureMs: sample.captureMs, flags: sample.flags, x: sample.axMg, y: sample.ayMg, z: sample.azMg });
        this.endpoint.setSensorHealthy(true); this.endpoint.emitMotion(sample);
        if (!this.started) { this.started = true; this.link.start(); }
      }
      if (now - this.lastObservation > 500) this.endpoint.setSensorHealthy(false);
      this.endpoint.tick();
      if (now - this.lastHealth >= 500) { this.lastHealth = now; this.endpoint.notifyHealth(); }
      // Count fresh selected readings, not two jitter-sensitive interval durations.
      if (this.link.route === "direct" || this.motionQueue.length >= 2 || now - this.lastFlush >= 40) {
        this.lastFlush = now;
        this.pruneMotion(now);
        if (this.motionQueue.length && this.link.ready && this.inFlightMotion.length < 8) {
          const records = this.motionQueue.map(x => [...x.data]);
          if (this.motionDiscontinuityPending) records[0][1] |= MotionFlag.Discontinuity;
          const sequence = ++this.motionSequence;
          if (this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "motion", sequence, records })) { this.motionQueue = []; this.motionDiscontinuityPending = false; this.inFlightMotion.push({ sequence, at: now }); }
        }
      }
      const oldest = Math.min(this.inFlightMotion[0]?.at ?? Infinity, ...this.inFlightStatus.values());
      if (now - oldest > 1000) this.link.interrupt("congestion");
    }
    if (now - this.lastUi >= 100) { this.lastUi = now; this.emit(); }
  }
  private emit() { const state = this.getState(); for (const listener of this.listeners) listener(state); }
  private pruneMotion(now: number) {
    const retained = this.motionQueue.filter(x => now - x.at <= 100).slice(-2);
    const dropped = this.motionQueue.length - retained.length;
    this.motionQueue = retained;
    if (!dropped) return;
    this.motionDiscontinuityPending = true;
    this.endpoint.recordDroppedSamples(dropped);
    this.trace.add({ event: "selected-drop", generation: this.link.generation, count: dropped });
  }
  private receive(message: PhoneData) {
    if (message.kind === "begin-link") {
      if (this.paused) { this.pendingBegin = message; return; }
      if (this.begunGeneration !== message.generation || this.beginId !== message.id) {
        this.endpoint.disconnect(); this.endpoint = this.makeEndpoint(); this.endpoint.setSensorHealthy(performance.now() - this.lastObservation <= 500);
        this.begunGeneration = message.generation; this.beginId = message.id; this.motionQueue = []; this.motionDiscontinuityPending = true; this.inFlightMotion = []; this.inFlightStatus.clear(); this.motionSequence = this.statusSequence = 0;
        this.accepted = undefined; this.lastAcceptedCount = -1; this.lastAcceptance = -Infinity; this.coaching = undefined;
      }
      this.link.send({ v: 2, type: "data", generation: message.generation, kind: "begun", id: message.id }); return;
    }
    if (this.paused || message.generation !== this.begunGeneration) return;
    if (message.kind === "receipt") {
      if (message.through > this.motionSequence) { this.link.interrupt("protocol"); return; }
      this.inFlightMotion = this.inFlightMotion.filter(x => x.sequence > message.through);
      for (const id of message.statusIds) this.inFlightStatus.delete(id);
      if (message.accepted && message.accepted.accepted > this.lastAcceptedCount) {
        this.accepted = message.accepted; this.lastAcceptedCount = message.accepted.accepted; this.lastAcceptance = performance.now();
        this.trace.add({ event: "accepted", generation: message.generation, count: message.accepted.accepted, ageMs: message.accepted.ageMs });
      }
    } else if (message.kind === "coaching") {
      this.coaching = message.value; this.trace.add({ event: "coaching", generation: message.generation, count: message.value.completed, reason: message.value.hint, calibration: message.value.diagnostics });
    } else if (message.kind === "op") {
      try {
        let data: Uint8Array | undefined;
        switch (message.operation) {
          case "info": data = this.endpoint.readInfo(); break;
          case "status": data = this.endpoint.readStatus(); break;
          case "control": this.endpoint.writeControl(new Uint8Array(message.data!)); break;
          case "subscribe-motion": this.endpoint.subscribeMotion(bytes => { const at = performance.now(); this.motionQueue.push({ data: [...bytes], at }); this.pruneMotion(at); }); break;
          case "subscribe-status": this.endpoint.subscribeStatus(bytes => {
            if (this.inFlightStatus.size >= 4) { this.link.interrupt("congestion"); return; }
            const id = `status-${++this.statusSequence}`;
            if (this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "status", id, data: [...bytes] })) this.inFlightStatus.set(id, performance.now());
          }); break;
        }
        this.link.send({ v: 2, type: "data", generation: message.generation, kind: "reply", id: message.id, ...(data ? { data: [...data] } : {}) });
      } catch { this.link.send({ v: 2, type: "data", generation: message.generation, kind: "reply", id: message.id, error: "operation-failed" }); }
    }
  }
}
