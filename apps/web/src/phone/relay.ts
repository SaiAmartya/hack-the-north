import type {
  WandTransport,
  ByteListener,
  NotificationKind,
} from "../wand/transport";

export function socketUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}
export function recordBytes(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== 20 ||
    !value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    throw new Error("Invalid wand record");
  return new Uint8Array(value);
}

export type HostedPair = {
  roomId: string;
  ownerToken: string;
  expiresAtMs: number;
  socketUrl: string;
  phoneUrl: string;
};

export type HostedClaim = { claimId: string; challenge: string };

export type HostedPhoneRelayOptions = {
  mode: "hosted";
  pair: HostedPair;
  onClaim: (claim: HostedClaim) => void;
};

export function parseHostedPair(value: unknown): HostedPair {
  if (!value || typeof value !== "object")
    throw new Error("Invalid hosted phone session");
  const pair = value as Partial<HostedPair>;
  if (
    typeof pair.roomId !== "string" ||
    !/^[0-9a-f]{32}$/.test(pair.roomId) ||
    typeof pair.ownerToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(pair.ownerToken) ||
    typeof pair.expiresAtMs !== "number" ||
    !Number.isSafeInteger(pair.expiresAtMs) ||
    pair.expiresAtMs <= Date.now() ||
    typeof pair.socketUrl !== "string" ||
    typeof pair.phoneUrl !== "string"
  )
    throw new Error("Invalid hosted phone session");
  let socket: URL, phone: URL;
  try {
    socket = new URL(pair.socketUrl);
    phone = new URL(pair.phoneUrl);
  } catch {
    throw new Error("Invalid hosted phone session");
  }
  if (
    socket.protocol !== "wss:" ||
    socket.username ||
    socket.password ||
    socket.search ||
    socket.hash ||
    socket.pathname !== `/ws/${pair.roomId}` ||
    phone.protocol !== "https:" ||
    phone.username ||
    phone.password ||
    phone.hash ||
    phone.host !== socket.host ||
    phone.pathname !== "/phone" ||
    phone.searchParams.size !== 1 ||
    phone.searchParams.get("room") !== pair.roomId
  )
    throw new Error("Invalid hosted phone session");
  return pair as HostedPair;
}

/** Opaque channel beneath VirtualWandTransport. No spell or combat messages. */
export class PhoneRelayChannel implements WandTransport {
  readonly source = "PHONE";
  private socket?: WebSocket;
  private cancelConnect?: () => void;
  private serial = 0;
  private readonly token: string;
  private readonly endpoint?: string;
  private readonly expiresAtMs?: number;
  private readonly onClaim?: (claim: HostedClaim) => void;
  private readonly hosted: boolean;
  private claim?: HostedClaim;
  private listeners = new Map<NotificationKind, ByteListener>();
  private pending = new Map<
    string,
    {
      resolve: (bytes: Uint8Array) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(tokenOrOptions: string | HostedPhoneRelayOptions) {
    if (typeof tokenOrOptions === "string") {
      this.token = tokenOrOptions;
      this.hosted = false;
    } else {
      const pair = parseHostedPair(tokenOrOptions.pair);
      this.token = pair.ownerToken;
      this.endpoint = pair.socketUrl;
      this.expiresAtMs = pair.expiresAtMs;
      this.onClaim = tokenOrOptions.onClaim;
      this.hosted = true;
    }
  }

  async connect(onDisconnect: () => void): Promise<void> {
    this.disconnect();
    const ws = (this.socket = new WebSocket(
      this.endpoint ?? socketUrl("/ws/dev-wand"),
    ));
    return new Promise((resolve, reject) => {
      let settled = false;
      const remaining = this.expiresAtMs
        ? Math.max(1, Math.min(120_000, this.expiresAtMs - Date.now()))
        : 60_000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cancelConnect = undefined;
        reject(new Error("Phone pairing expired"));
        ws.close();
      }, remaining);
      let paired = false;
      this.cancelConnect = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Phone connection cancelled"));
      };
      ws.onopen = () =>
        ws.send(JSON.stringify({ v: 1, type: "owner", token: this.token }));
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.v !== 1) throw new Error("Invalid relay version");
          if (message.type === "claim") {
            if (
              !this.onClaim ||
              typeof message.claimId !== "string" ||
              !/^[0-9a-f]{32}$/.test(message.claimId) ||
              typeof message.challenge !== "string" ||
              !/^[0-9]{6}$/.test(message.challenge)
            )
              throw new Error("Invalid phone claim");
            this.claim = {
              claimId: message.claimId,
              challenge: message.challenge,
            };
            this.onClaim(this.claim);
          } else if (message.type === "paired") {
            if (
              !Number.isSafeInteger(message.generation) ||
              message.generation < 1
            )
              throw new Error("Invalid relay generation");
            paired = true;
            this.claim = undefined;
            settled = true;
            clearTimeout(timer);
            this.cancelConnect = undefined;
            resolve();
          } else if (message.type === "reply") {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            if (message.error) {
              this.pending.delete(message.id);
              clearTimeout(entry.timer);
              entry.reject(new Error("Phone command failed"));
            } else {
              const data =
                message.data == null
                  ? new Uint8Array()
                  : recordBytes(message.data);
              this.pending.delete(message.id);
              clearTimeout(entry.timer);
              entry.resolve(data);
            }
          } else if (message.type === "notify") {
            if (message.kind !== "motion" && message.kind !== "status")
              throw new Error("Invalid subscription");
            const listener = this.listeners.get(message.kind);
            if (!listener) throw new Error("Unexpected notification");
            if (
              this.hosted &&
              (typeof message.deliveryId !== "string" ||
                !/^[0-9a-f]{32}$/.test(message.deliveryId))
            )
              throw new Error("Invalid notification delivery");
            listener(recordBytes(message.data));
            if (this.hosted)
              ws.send(
                JSON.stringify({
                  v: 1,
                  type: "received",
                  id: message.deliveryId,
                }),
              );
          }
        } catch {
          ws.close(1008, "Invalid wand message");
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.cancelConnect = undefined;
          reject(new Error("Cannot reach your phone"));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.socket !== ws) return;
        this.socket = undefined;
        this.cancelConnect = undefined;
        this.clearPending();
        this.listeners.clear();
        if (paired) onDisconnect();
        else if (!settled) {
          settled = true;
          reject(new Error("Phone disconnected"));
        }
      };
    });
  }
  approve(claimId: string) {
    const ws = this.socket;
    if (
      !this.onClaim ||
      !this.claim ||
      this.claim.claimId !== claimId ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    )
      throw new Error("Phone claim is no longer pending");
    this.claim = undefined;
    ws.send(JSON.stringify({ v: 1, type: "approve", claimId }));
  }
  private request(operation: string, data?: Uint8Array): Promise<Uint8Array> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Phone disconnected"));
    if (ws.bufferedAmount > 16_384 || this.pending.size > 8) {
      this.disconnect();
      return Promise.reject(new Error("Phone connection too slow"));
    }
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Phone command timed out"));
      }, 1000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          v: 1,
          type: "op",
          id,
          operation,
          ...(data ? { data: [...data] } : {}),
        }),
      );
    });
  }
  readInfo() {
    return this.request("info");
  }
  readStatus() {
    return this.request("status");
  }
  async subscribe(kind: NotificationKind, listener: ByteListener) {
    this.listeners.set(kind, listener);
    await this.request(`subscribe-${kind}`);
  }
  async writeControl(bytes: Uint8Array) {
    await this.request("control", bytes);
  }
  disconnect() {
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    const ws = this.socket;
    this.socket = undefined;
    this.claim = undefined;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      ws.close();
    }
    this.clearPending();
    this.listeners.clear();
  }

  private clearPending() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Phone disconnected"));
    }
    this.pending.clear();
  }
}
