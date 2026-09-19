import { parsePhoneMessage, type PhoneData, type PhoneMessage, type PhoneRole, type PhoneRoute, type PhoneIssueCode, type PhoneSignal } from "../../../../shared/phone-v2";

export type PhoneFailure = { code: string; message: string; recoverable: boolean };
export type PhoneLinkState = { phase: "connecting" | "approval" | "direct" | "relay" | "recovering" | "choice" | "paused" | "closed"; route: PhoneRoute; generation: number; issue?: PhoneFailure; relayAvailable: boolean };
const copy: Record<PhoneIssueCode, string> = { network: "Connection interrupted. Reconnecting…", congestion: "Connection is too slow. Reconnecting…", paused: "Resume your wand on your iPhone.", orientation: "Hold your iPhone upright and resume.", sensor: "Motion stopped. Resume your iPhone.", protocol: "Connection needs a fresh start.", expired: "Scan a new code to connect.", "direct-unavailable": "A direct connection is unavailable on this Wi-Fi." };
export function phoneFailure(code: PhoneIssueCode, recoverable = true): PhoneFailure { return { code, message: copy[code], recoverable }; }
type LinkOptions = {
  role: PhoneRole; url: string; token?: string;
  onMessage: (message: PhoneMessage) => void;
  onData: (message: PhoneData) => void;
  onCarrier: () => void;
  onGeneration?: (generation: number) => void;
  onFailure: (failure: PhoneFailure) => void;
  onState: (state: PhoneLinkState) => void;
};

/** One approved pair; WebRTC and WSS only carry the same validated envelopes. */
export class PhoneLink {
  state: PhoneLinkState = { phase: "connecting", route: "direct", generation: 0, relayAvailable: false };
  private socket?: WebSocket;
  private peer?: RTCPeerConnection;
  private control?: RTCDataChannel;
  private motion?: RTCDataChannel;
  private resumeToken?: string;
  private signallingExpired = false;
  private closed = false;
  private paused = false;
  private pendingOffer?: PhoneSignal;
  private ice: RTCIceCandidateInit[] = [];
  private retry = 0;
  private recoveryUntil = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private directTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private signalTail: Promise<void> = Promise.resolve();
  private carrierReported = false;
  constructor(private readonly options: LinkOptions) {}
  start() { this.closed = false; this.openSocket(); }
  get generation() { return this.state.generation; }
  get route() { return this.state.route; }
  get ready() { return this.state.route === "relay" ? this.socket?.readyState === WebSocket.OPEN && this.carrierReported : this.control?.readyState === "open" && this.motion?.readyState === "open"; }
  send(message: PhoneData): boolean {
    if (this.closed || message.generation !== this.generation) return false;
    if (this.route === "relay") return this.sendSocket(message);
    const channel = message.kind === "motion" ? this.motion : this.control;
    if (!channel || channel.readyState !== "open") return false;
    if (channel.bufferedAmount > (message.kind === "motion" ? 4096 : 16384)) {
      if (message.kind !== "motion") this.fail("congestion");
      return false;
    }
    channel.send(JSON.stringify(message)); return true;
  }
  signal(message: PhoneMessage) { return this.sendSocket(message); }
  interrupt(code: PhoneIssueCode) {
    this.send({ v: 2, type: "data", generation: this.generation, kind: "issue", code, recoverable: true });
    this.fail(code);
  }
  chooseRelay() {
    if (this.options.role !== "owner") return;
    this.sendSocket({ v: 2, type: "route", generation: this.generation, route: "relay" });
  }
  reset() {
    if (this.signallingExpired) { this.closePeer(); this.update({ phase: "recovering", issue: phoneFailure("expired", false) }); return false; }
    this.closePeer();
    this.update({ phase: "recovering" });
    if (!this.sendSocket({ v: 2, type: "reset-link", generation: this.generation })) this.openSocket();
    return true;
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { this.update({ phase: "paused" }); return; }
    if (this.pendingOffer) { const offer = this.pendingOffer; this.pendingOffer = undefined; this.queueSignal(offer); }
  }
  close() {
    this.sendSocket({ v: 2, type: "leave" });
    this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.expiryTimer); this.closePeer();
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null; socket.close(); }
    this.resumeToken = undefined; this.update({ phase: "closed" });
  }
  private update(update: Partial<PhoneLinkState>) { this.state = { ...this.state, ...update }; this.options.onState({ ...this.state }); }
  private sendSocket(message: PhoneMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16384) return false;
    socket.send(JSON.stringify(message)); return true;
  }
  private openSocket() {
    if (this.closed || this.signallingExpired || this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    const socket = this.socket = new WebSocket(this.options.url);
    socket.onopen = () => this.sendSocket(this.resumeToken ? { v: 2, type: "resume", role: this.options.role, token: this.resumeToken } : this.options.role === "owner" ? { v: 2, type: "owner", token: this.options.token! } : { v: 2, type: "phone" });
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      try { this.receive(parsePhoneMessage(String(event.data))); } catch { this.fail("protocol", false); socket.close(1008, "Invalid phone envelope"); }
    };
    socket.onerror = () => { /* Close determines bounded recovery, not duplicate errors. */ };
    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return;
      this.socket = undefined;
      if (!(this.route === "direct" && this.ready)) this.fail("network");
      this.reconnect();
    };
  }
  private reconnect() {
    if (!this.resumeToken || this.closed || this.signallingExpired) return;
    if (!this.recoveryUntil) this.recoveryUntil = Date.now() + 30_000;
    const delays = [500, 1000, 2000, 4000];
    if (this.retry >= delays.length || Date.now() >= this.recoveryUntil) { if (!this.ready) this.fail("expired", false); return; }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retry++; this.openSocket(); }, delays[this.retry]);
  }
  private receive(message: PhoneMessage) {
    if (message.type === "data") { if (message.generation === this.generation && this.route === "relay") this.options.onData(message); return; }
    if (message.type === "paired") {
      if (message.resumeToken) this.resumeToken = message.resumeToken;
      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => { this.fail("expired", false); this.closePeer(); }, Math.max(0, Math.min(2147483647, message.expiresAtMs - Date.now())));
      this.retry = 0; this.recoveryUntil = 0;
      if (message.generation === this.generation && this.route === "direct" && this.ready) return;
      this.prepare(message.generation, message.route); return;
    }
    if (message.type === "route") { if (message.generation >= this.generation) this.prepare(message.generation, message.route); return; }
    if (message.type === "signal") { if (message.generation === this.generation) this.queueSignal(message.signal); return; }
    if (message.type === "recovering") {
      if (this.route === "direct" && this.ready && message.generation === this.generation) return;
      this.closePeer(); this.update({ generation: message.generation, route: message.route }); this.fail(message.code); return;
    }
    if (message.type === "peer-unavailable") { this.fail(message.code, message.recoverable); return; }
    if (message.type === "error") {
      if (message.code === "signalling-expired") {
        this.signallingExpired = true; this.resumeToken = undefined; clearTimeout(this.retryTimer);
        const socket = this.socket; this.socket = undefined;
        if (socket) { socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null; socket.close(); }
        if (this.route === "direct" && this.ready) return;
      }
      this.fail(message.code.includes("expir") ? "expired" : "protocol", false); return;
    }
    this.options.onMessage(message);
  }
  private prepare(generation: number, route: PhoneRoute) {
    this.closePeer(); this.update({ generation, route, phase: route === "direct" ? "connecting" : "relay", issue: undefined, relayAvailable: false });
    this.options.onGeneration?.(generation);
    if (route === "relay") { this.carrierReported = true; this.options.onCarrier(); return; }
    if (typeof RTCPeerConnection === "undefined") { this.unavailable(); return; }
    const peer = this.peer = new RTCPeerConnection({ iceServers: [] });
    peer.onicecandidate = event => {
      if (this.peer !== peer || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      this.sendSocket({ v: 2, type: "signal", generation, signal: { type: "ice", candidate: { candidate: candidate.candidate ?? "", sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment } } });
    };
    peer.onconnectionstatechange = () => { if (this.peer === peer && ["failed", "closed", "disconnected"].includes(peer.connectionState)) this.fail("network"); };
    peer.ondatachannel = event => this.attach(event.channel, peer);
    this.directTimer = setTimeout(() => { if (this.peer === peer && !this.ready && !this.paused) this.unavailable(); }, 10_000);
    if (this.options.role === "owner") {
      this.attach(peer.createDataChannel("wand-control", { ordered: true }), peer);
      this.attach(peer.createDataChannel("wand-motion", { ordered: false, maxRetransmits: 0 }), peer);
      void (async () => {
        await peer.setLocalDescription(await peer.createOffer());
        if (this.peer === peer && peer.localDescription) this.sendSocket({ v: 2, type: "signal", generation, signal: { type: "offer", sdp: peer.localDescription.sdp } });
      })().catch(() => { if (this.peer === peer) this.unavailable(); });
    }
  }
  private attach(channel: RTCDataChannel, peer: RTCPeerConnection) {
    if (this.peer !== peer || !["wand-control", "wand-motion"].includes(channel.label)) { channel.close(); return; }
    if (channel.label === "wand-control" ? !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null : channel.ordered || channel.maxRetransmits !== 0 || channel.maxPacketLifeTime !== null) { channel.close(); this.fail("protocol", false); return; }
    if (channel.label === "wand-control") this.control = channel; else this.motion = channel;
    channel.onopen = () => {
      if (this.peer !== peer || !this.ready || this.carrierReported) return;
      clearTimeout(this.directTimer); this.carrierReported = true; this.update({ phase: "direct", issue: undefined }); this.options.onCarrier();
    };
    channel.onmessage = event => {
      if (this.peer !== peer) return;
      try {
        const message = parsePhoneMessage(String(event.data));
        if (message.type !== "data" || (channel.label === "wand-motion") !== (message.kind === "motion")) throw new Error("Wrong data channel");
        if (message.generation === this.generation) this.options.onData(message);
      } catch { this.fail("protocol", false); }
    };
    channel.onclose = () => { if (this.peer === peer && this.carrierReported) this.fail("network"); };
  }
  private queueSignal(signal: PhoneSignal) {
    if (this.paused && signal.type === "offer") { this.pendingOffer = signal; return; }
    const peer = this.peer;
    if (signal.type === "answer" && this.options.role === "owner" && this.paused) {
      this.paused = false;
      clearTimeout(this.directTimer);
      this.directTimer = setTimeout(() => { if (this.peer === peer && !this.ready) this.unavailable(); }, 10_000);
    }
    this.signalTail = this.signalTail.then(async () => {
      if (!peer || this.peer !== peer) return;
      if (signal.type === "ice") {
        if (!peer.remoteDescription) this.ice.push(signal.candidate);
        else await peer.addIceCandidate(signal.candidate);
      } else {
        await peer.setRemoteDescription(signal);
        if (this.peer !== peer) return;
        for (const candidate of this.ice.splice(0)) await peer.addIceCandidate(candidate);
        if (signal.type === "offer") {
          await peer.setLocalDescription(await peer.createAnswer());
          if (this.peer === peer && peer.localDescription) this.sendSocket({ v: 2, type: "signal", generation: this.generation, signal: { type: "answer", sdp: peer.localDescription.sdp } });
        }
      }
    }).catch(() => { if (this.peer === peer) this.unavailable(); });
  }
  private unavailable() { this.closePeer(); this.update({ phase: "choice", relayAvailable: true, issue: phoneFailure("direct-unavailable", false) }); }
  private fail(code: PhoneIssueCode, recoverable = true) {
    if (this.signallingExpired && recoverable) { code = "expired"; recoverable = false; }
    if (this.state.issue && (!this.state.issue.recoverable || this.state.issue.code === "paused" && code === "network")) return;
    const issue = phoneFailure(code, recoverable);
    if (this.state.issue?.code === code && this.state.phase === "recovering") return;
    this.update({ phase: code === "paused" ? "paused" : "recovering", issue });
    if (!recoverable) this.closePeer();
    this.options.onFailure(issue);
  }
  private closePeer() {
    clearTimeout(this.directTimer); this.carrierReported = false;
    const peer = this.peer; this.peer = undefined; this.control = this.motion = undefined; this.ice = []; this.signalTail = Promise.resolve();
    if (peer) { peer.onconnectionstatechange = peer.onicecandidate = peer.ondatachannel = null; peer.close(); }
  }
}
