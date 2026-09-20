import { socketUrl } from "../phone/relay";
import {
  parseIceServers,
  parseRules,
  parseSnapshot,
  type Rules,
  type Slot,
  type Snapshot,
  type Source,
} from "./contracts";
/** Six characters from an alphabet without look-alikes; typed input is normalized first. */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export class GameClient {
  token = "";
  slot?: Slot;
  rules?: Rules;
  snapshot?: Snapshot;
  iceServers: RTCIceServer[] = [];
  connectionGeneration = 0;
  issue = "";
  private socket?: WebSocket;
  private roomId = "";
  private offset?: number;
  private bestRtt = Infinity;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastMessage = 0;
  private lifecycle = 0;
  private pendingConnect?: () => void;
  private requests = new Set<AbortController>();
  onChange = () => {};
  onSignal: (payload: Record<string, unknown>, generation: number) => void =
    () => {};
  onAck: (message: Record<string, unknown>) => void = () => {};
  getHealth = () => ({ healthy: false, inputGeneration: 0 });
  now() {
    return performance.now() + (this.offset ?? 0);
  }
  /** Open a fresh duel room; the returned code is what the opponent types to join. */
  async createRoom(): Promise<string> {
    const lifecycle = this.lifecycle,
      abort = new AbortController();
    this.requests.add(abort);
    try {
      const response = await fetch("/api/game/room", {
        method: "POST",
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Too many duels right now. Try again soon."
            : "Start the game server to connect.",
        );
      const room = await response.json();
      if (lifecycle !== this.lifecycle) throw new Error("Connection cancelled");
      if (typeof room.code !== "string" || !ROOM_CODE_PATTERN.test(room.code))
        throw new Error("Invalid duel code");
      return room.code;
    } finally {
      this.requests.delete(abort);
    }
  }
  async connect(source: Source, code?: string): Promise<void> {
    this.disconnect();
    const lifecycle = this.lifecycle;
    this.issue = "";
    if (code !== undefined && !ROOM_CODE_PATTERN.test(code))
      throw new Error("Enter the six-character duel code.");
    const abort = new AbortController();
    this.requests.add(abort);
    let session;
    try {
      const response = await fetch("/api/game/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Wizard", source, code }),
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "This duel is full."
            : response.status === 404
              ? "No duel with that code."
              : response.status === 429
                ? "Too many duels right now. Try again soon."
                : "Start the game server to connect.",
        );
      session = await response.json();
    } finally {
      this.requests.delete(abort);
    }
    if (
      typeof session.token !== "string" ||
      !["P1", "P2"].includes(session.slot) ||
      typeof session.roomId !== "string" ||
      !ROOM_CODE_PATTERN.test(session.roomId) ||
      (code !== undefined && session.roomId !== code)
    ) {
      if (typeof session.token === "string") this.release(session.token);
      throw new Error("Invalid game session");
    }
    if (lifecycle !== this.lifecycle) {
      this.release(session.token);
      throw new Error("Connection cancelled");
    }
    this.token = session.token;
    this.slot = session.slot;
    this.roomId = session.roomId;
    if (!(await this.openSocket()))
      throw new Error(this.issue);
  }
  /** Reattach the existing reservation; false lets the caller explicitly rejoin an expired one. */
  async reconnect(): Promise<boolean> {
    if (!this.token || !this.slot) return false;
    const lifecycle = ++this.lifecycle;
    this.pendingConnect?.();
    this.pendingConnect = undefined;
    this.stopHeartbeat();
    const previous = this.socket;
    this.issue = "Reconnecting to the duel…";
    this.onChange();
    if (previous) {
      previous.onclose = previous.onmessage = previous.onerror = previous.onopen = null;
      if (previous.readyState !== WebSocket.CLOSED) {
        // The referee retains its peer until the old close handshake completes.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (previous.onclose === closed) previous.onclose = null;
            if (this.pendingConnect === cancel) this.pendingConnect = undefined;
            if (error) reject(error);
            else resolve();
          };
          const closed = () => finish();
          const cancel = () => finish(new Error("Connection cancelled"));
          const timeout = setTimeout(() => {
            this.issue = "Previous connection is still closing. Reconnect again.";
            finish(new Error(this.issue));
          }, 5000);
          previous.onclose = closed;
          this.pendingConnect = cancel;
          if (previous.readyState !== WebSocket.CLOSING) previous.close();
        });
      }
    }
    if (lifecycle !== this.lifecycle) throw new Error("Connection cancelled");
    this.socket = undefined;
    return this.openSocket();
  }
  private async openSocket(): Promise<boolean> {
    const ws = (this.socket = new WebSocket(socketUrl("/ws/game")));
    const lifecycle = this.lifecycle;
    const active = () => this.socket === ws && this.lifecycle === lifecycle;
    return new Promise<boolean>((resolve, reject) => {
      let welcomed = false;
      const timeout = setTimeout(() => {
        if (!active()) return;
        this.issue = "Game connection timed out. Reconnect to play.";
        this.pendingConnect = undefined;
        reject(new Error(this.issue));
        ws.close();
      }, 5000);
      this.pendingConnect = () => {
        clearTimeout(timeout);
        reject(new Error("Connection cancelled"));
      };
      ws.onopen = () => {
        if (active()) this.send({ type: "auth", token: this.token });
      };
      ws.onmessage = (event) => {
        if (!active()) return;
        try {
          if (String(event.data).length > 128_000)
            throw new Error("Game message too large");
          const message = JSON.parse(String(event.data));
          if (message.v !== 1) throw new Error("Unsupported game version");
          this.lastMessage = performance.now();
          if (message.type === "welcome") {
            const snapshot = parseSnapshot(message.snapshot);
            if (message.roomId !== this.roomId || snapshot.roomId !== this.roomId)
              throw new Error("Unexpected duel room");
            this.rules = parseRules(message.rules);
            this.snapshot = snapshot;
            this.iceServers = parseIceServers(message.iceServers);
            this.connectionGeneration = message.connectionGeneration;
            this.offset = this.snapshot.serverNowMs - performance.now();
            this.bestRtt = Infinity;
            this.issue = "";
            welcomed = true;
            clearTimeout(timeout);
            this.pendingConnect = undefined;
            this.startHeartbeat();
            resolve(true);
          } else if (message.type === "snapshot") {
            const next = parseSnapshot(message.snapshot);
            if (next.roomId !== this.roomId) throw new Error("Unexpected duel room");
            if (
              !this.snapshot ||
              next.stateVersion >= this.snapshot.stateVersion
            )
              this.snapshot = next;
          } else if (message.type === "pong") {
            const rtt = performance.now() - message.clientMs;
            if (
              Number.isFinite(rtt) &&
              rtt >= 0 &&
              rtt < this.bestRtt &&
              Number.isFinite(message.serverMs)
            ) {
              this.bestRtt = rtt;
              this.offset =
                message.serverMs - (message.clientMs + performance.now()) / 2;
            }
          } else if (message.type === "signal")
            this.onSignal(message.payload, message.generation);
          else if (message.type === "ack") this.onAck(message);
          else if (message.type === "error") {
            if (!welcomed && message.code === "auth_failed") {
              clearTimeout(timeout);
              this.pendingConnect = undefined;
              this.issue = "Battle session ended. Rejoin the duel.";
              resolve(false);
              ws.close();
            } else this.issue = "Game connection needs restarting.";
          }
          this.onChange();
        } catch {
          this.issue = "Game connection needs restarting.";
          ws.close(1008);
        }
      };
      ws.onerror = () => {
        if (!active()) return;
        clearTimeout(timeout);
        this.pendingConnect = undefined;
        this.issue = "Cannot reach the game server";
        reject(new Error("Cannot reach the game server"));
        ws.close();
      };
      ws.onclose = () => {
        if (!active()) return;
        clearTimeout(timeout);
        this.pendingConnect = undefined;
        reject(new Error("Game disconnected"));
        if (!this.issue || this.issue === "Reconnecting to the duel…")
          this.issue = "Game disconnected. Reconnect to play.";
        this.stopHeartbeat();
        this.onChange();
      };
    });
  }
  private startHeartbeat() {
    this.stopHeartbeat();
    const send = () => {
      if (performance.now() - this.lastMessage > 1500) {
        this.issue = "Game connection lost";
        this.socket?.close();
        return;
      }
      this.send({
        type: "heartbeat",
        clientMs: performance.now(),
        ...this.getHealth(),
      });
    };
    send();
    this.heartbeat = setInterval(send, 500);
  }
  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  send(message: Record<string, unknown>) {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 16_384) {
      this.issue = "Game connection too slow";
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ v: 1, ...message }));
  }
  async pair(): Promise<{ code: string; expiresAtMs: number; ownerToken: string }> {
    const lifecycle = this.lifecycle,
      abort = new AbortController();
    this.requests.add(abort);
    try {
      const response = await fetch("/api/game/pair", {
        method: "POST",
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          "Phone pairing unavailable. Start the phone-enabled profile.",
        );
      const pair = await response.json();
      if (lifecycle !== this.lifecycle) throw new Error("Pairing cancelled");
      if (
        typeof pair.code !== "string" ||
        typeof pair.ownerToken !== "string" || pair.ownerToken.length < 32 ||
        !/^[A-Z0-9]{10}$/.test(pair.code) ||
        !Number.isFinite(pair.expiresAtMs)
      )
        throw new Error("Invalid pairing response");
      return pair;
    } finally {
      this.requests.delete(abort);
    }
  }
  signal(payload: Record<string, unknown>) {
    this.send({
      type: "signal",
      generation: this.connectionGeneration,
      signalId: crypto.randomUUID(),
      payload,
    });
  }
  disconnect() {
    this.lifecycle++;
    this.pendingConnect?.();
    this.pendingConnect = undefined;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.stopHeartbeat();
    this.send({ type: "leave" });
    if (this.token) this.release(this.token);
    const ws = this.socket;
    this.socket = undefined;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = null;
      ws.onopen = null;
      ws.close();
    }
    this.token = "";
    this.roomId = "";
    this.slot = undefined;
    this.snapshot = undefined;
    this.iceServers = [];
    this.offset = undefined;
    this.bestRtt = Infinity;
  }
  private release(token: string) {
    void fetch("/api/game/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {});
  }
}
