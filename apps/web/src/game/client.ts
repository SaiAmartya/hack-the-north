import { socketUrl } from "../phone/relay";
import {
  parseRules,
  parseSnapshot,
  type Rules,
  type Slot,
  type Snapshot,
  type Source,
} from "./contracts";
export class GameClient {
  token = "";
  slot?: Slot;
  rules?: Rules;
  snapshot?: Snapshot;
  connectionGeneration = 0;
  issue = "";
  private socket?: WebSocket;
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
  async connect(source: Source) {
    this.disconnect();
    const lifecycle = this.lifecycle;
    this.issue = "";
    const abort = new AbortController();
    this.requests.add(abort);
    let session;
    try {
      const response = await fetch("/api/game/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Wizard", source }),
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "This duel is full."
            : "Start the game server to connect.",
        );
      session = await response.json();
    } finally {
      this.requests.delete(abort);
    }
    if (
      typeof session.token !== "string" ||
      !["P1", "P2"].includes(session.slot)
    )
      throw new Error("Invalid game session");
    if (lifecycle !== this.lifecycle) {
      this.release(session.token);
      throw new Error("Connection cancelled");
    }
    this.token = session.token;
    this.slot = session.slot;
    const ws = (this.socket = new WebSocket(socketUrl("/ws/game")));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Game connection timed out"));
      }, 5000);
      this.pendingConnect = () => {
        clearTimeout(timeout);
        reject(new Error("Connection cancelled"));
      };
      ws.onopen = () => this.send({ type: "auth", token: this.token });
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        try {
          if (String(event.data).length > 128_000)
            throw new Error("Game message too large");
          const message = JSON.parse(String(event.data));
          if (message.v !== 1) throw new Error("Unsupported game version");
          this.lastMessage = performance.now();
          if (message.type === "welcome") {
            this.rules = parseRules(message.rules);
            this.snapshot = parseSnapshot(message.snapshot);
            this.connectionGeneration = message.connectionGeneration;
            this.offset = this.snapshot.serverNowMs - performance.now();
            clearTimeout(timeout);
            this.pendingConnect = undefined;
            this.startHeartbeat();
            resolve();
          } else if (message.type === "snapshot") {
            const next = parseSnapshot(message.snapshot);
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
          else if (message.type === "error")
            this.issue = "Game connection needs restarting.";
          this.onChange();
        } catch {
          this.issue = "Game connection needs restarting.";
          ws.close(1008);
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Cannot reach the game server"));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        reject(new Error("Game disconnected"));
        if (this.socket === ws) {
          this.issue = "Game disconnected. Reconnect to play.";
          this.stopHeartbeat();
          this.onChange();
        }
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
  async pair(): Promise<{ code: string; expiresAtMs: number }> {
    const lifecycle = this.lifecycle,
      abort = new AbortController();
    this.requests.add(abort);
    try {
      const response = await fetch("/api/game/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
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
    this.slot = undefined;
    this.snapshot = undefined;
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
