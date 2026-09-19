import type { AcceptedMotion, PhoneCoaching, PhoneData, PhoneOperation } from "../../../../shared/phone-v2";
import type { ByteListener, NotificationKind, WandTransport } from "../wand/transport";
import type { HostedClaim, HostedPair } from "./relay";
import { PhoneLink, type PhoneFailure, type PhoneLinkState } from "./link";
import { PhoneTrace } from "./trace";

type Pending = { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type PhoneSessionState = PhoneLinkState;

/** Hosted phone WandTransport. A recovered carrier is followed by a fresh WandClient OPEN. */
export class PhoneSession implements WandTransport {
  readonly source = "PHONE";
  private link: PhoneLink;
  private serial = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Map<NotificationKind, ByteListener>();
  private stateListeners = new Set<(state: PhoneSessionState) => void>();
  private onDisconnect?: (failure?: PhoneFailure) => void;
  private wait?: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private begunGeneration = 0;
  private hasConnected = false;
  private carrierRestartPending = false;
  private through = 0;
  private receiptTimer?: ReturnType<typeof setInterval>;
  private accepted?: AcceptedMotion;
  private acceptedAt = 0;
  private acceptedSent = -1;
  private trace = new PhoneTrace();
  constructor(private options: { pair: HostedPair; onClaim: (claim: HostedClaim) => void }) {
    this.link = new PhoneLink({ role: "owner", url: options.pair.socketUrl, token: options.pair.ownerToken,
      onMessage: message => { if (message.type === "claim") options.onClaim({ claimId: message.claimId, challenge: message.challenge }); },
      onData: message => this.receive(message), onCarrier: () => this.begin(),
      onGeneration: generation => {
        if (!this.begunGeneration || generation === this.begunGeneration) return;
        this.carrierRestartPending = true; this.begunGeneration = 0;
        this.clearRequests("Phone connection changed"); this.listeners.clear();
        this.onDisconnect?.({ code: "link_changed", message: "Phone connection changed. Reconnecting…", recoverable: true });
      },
      onFailure: failure => { this.clearRequests(failure.message); this.listeners.clear(); if (!failure.recoverable || !this.hasConnected) this.rejectWait(failure.message); this.trace.add({ event: "failure", generation: this.link.generation, reason: failure.code }); this.onDisconnect?.(failure); },
      onState: state => { for (const listener of this.stateListeners) listener(state); },
    });
  }
  getState() { return { ...this.link.state }; }
  subscribeState(listener: (state: PhoneSessionState) => void) { this.stateListeners.add(listener); listener(this.getState()); return () => { this.stateListeners.delete(listener); }; }
  connect(onDisconnect: (failure?: PhoneFailure) => void): Promise<void> {
    this.onDisconnect = onDisconnect;
    const wait = this.waitForLink(Math.max(1000, Math.min(120_000, this.options.pair.expiresAtMs - Date.now())));
    this.receiptTimer = setInterval(() => this.sendReceipt(), 100);
    this.link.start(); return wait;
  }
  recover(onDisconnect: (failure?: PhoneFailure) => void): Promise<void> {
    this.onDisconnect = onDisconnect; this.listeners.clear(); this.clearRequests("Fresh phone session required");
    this.begunGeneration = 0; this.accepted = undefined; this.through = 0;
    const wait = this.waitForLink(30_000);
    if (this.carrierRestartPending) {
      this.carrierRestartPending = false;
      if (this.link.ready) this.begin();
    } else if (!this.link.reset()) this.rejectWait("Scan a new code to connect.");
    return wait;
  }
  approve(claimId: string) { this.link.signal({ v: 2, type: "approve", claimId }); }
  chooseRelay() { this.link.chooseRelay(); }
  reportAccepted(accepted: AcceptedMotion) {
    if (accepted.accepted === this.accepted?.accepted) return;
    this.accepted = { ...accepted }; this.acceptedAt = performance.now();
    this.trace.add({ event: "accepted", generation: this.link.generation, count: accepted.accepted, ageMs: accepted.ageMs });
  }
  coach(value: PhoneCoaching) { this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "coaching", value }); }
  exportTrace() { return this.trace.export(); }
  readInfo() { return this.request("info"); }
  readStatus() { return this.request("status"); }
  async subscribe(kind: NotificationKind, listener: ByteListener) { this.listeners.set(kind, listener); await this.request(`subscribe-${kind}`); }
  async writeControl(data: Uint8Array) { await this.request("control", data); }
  disconnect() {
    this.onDisconnect = undefined; clearInterval(this.receiptTimer); this.receiptTimer = undefined;
    this.rejectWait("Phone disconnected"); this.clearRequests("Phone disconnected"); this.listeners.clear(); this.link.close();
  }
  private waitForLink(timeout: number) {
    this.rejectWait("Phone connection superseded");
    return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { this.wait = undefined; reject(new Error("Phone connection timed out. Try again.")); }, timeout); this.wait = { resolve, reject, timer }; });
  }
  private begin() {
    if (this.begunGeneration === this.link.generation) return;
    this.listeners.clear(); this.clearRequests("Phone link changed"); this.through = 0; this.accepted = undefined; this.acceptedSent = -1;
    const id = `begin-${this.link.generation}`;
    this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "begin-link", id });
    this.trace.add({ event: "begin", generation: this.link.generation });
  }
  private receive(message: PhoneData) {
    if (message.kind === "begun") {
      if (message.id !== `begin-${this.link.generation}`) return;
      this.begunGeneration = this.link.generation;
      this.hasConnected = true;
      if (this.wait) { clearTimeout(this.wait.timer); this.wait.resolve(); this.wait = undefined; }
    } else if (message.kind === "reply") {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("Phone command failed")); else pending.resolve(new Uint8Array(message.data ?? []));
    } else if (message.kind === "motion") {
      if (message.sequence <= this.through || this.begunGeneration !== message.generation) return;
      this.through = message.sequence;
      for (const data of message.records) this.listeners.get("motion")?.(new Uint8Array(data));
      this.trace.add({ event: "received", generation: message.generation, count: message.records.length });
    } else if (message.kind === "status") {
      this.listeners.get("status")?.(new Uint8Array(message.data)); this.sendReceipt([message.id]);
    } else if (message.kind === "issue") {
      if (message.code === "paused" || message.code === "orientation") this.link.setPaused(true);
      this.onDisconnect?.({ code: message.code, message: message.code === "paused" ? "Resume your wand on your iPhone." : "Phone input interrupted. Reconnecting…", recoverable: message.recoverable });
    }
  }
  private sendReceipt(statusIds: string[] = []) {
    if (this.begunGeneration !== this.link.generation) return;
    const freshAccepted = this.accepted && this.accepted.accepted !== this.acceptedSent && performance.now() - this.acceptedAt < 500 ? this.accepted : undefined;
    if (this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "receipt", through: this.through, statusIds, ...(freshAccepted ? { accepted: freshAccepted } : {}) }) && freshAccepted) this.acceptedSent = freshAccepted.accepted;
  }
  private request(operation: PhoneOperation, data?: Uint8Array): Promise<Uint8Array> {
    if (!this.link.ready || this.begunGeneration !== this.link.generation) return Promise.reject(new Error("Phone is reconnecting"));
    if (this.pending.size >= 4) return Promise.reject(new Error("Phone command queue is full"));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Phone command timed out")); }, 1000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.link.send({ v: 2, type: "data", generation: this.link.generation, kind: "op", id, operation, ...(data ? { data: [...data] } : {}) })) { clearTimeout(timer); this.pending.delete(id); reject(new Error("Phone connection is unavailable")); }
    });
  }
  private clearRequests(reason: string) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); } this.pending.clear(); }
  private rejectWait(reason: string) { if (this.wait) { clearTimeout(this.wait.timer); this.wait.reject(new Error(reason)); this.wait = undefined; } }
}
