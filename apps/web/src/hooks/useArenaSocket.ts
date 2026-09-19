import { useEffect, useRef, useState } from "react";
import type { ArenaEnvelope, ConnectionState, Effect } from "../types";

/** An effect plus the moment it arrived, so the canvas can fade it out. */
export type TimedEffect = Effect & { at: number };

const BACKOFF_INITIAL_MS = 400;
const BACKOFF_MAX_MS = 5000;
const EFFECT_TTL_MS = 900;
const MAX_TIMED_EFFECTS = 40;

export function defaultArenaUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/arena`;
}

/**
 * Subscribe to the host's authoritative state stream.
 *
 * Reconnects with bounded exponential backoff. The client never computes game
 * rules; it only renders whatever the host last said.
 */
export function useArenaSocket(url: string = defaultArenaUrl()) {
  const [envelope, setEnvelope] = useState<ArenaEnvelope | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const effectsRef = useRef<TimedEffect[]>([]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let backoff = BACKOFF_INITIAL_MS;
    let closed = false;

    const connect = () => {
      if (closed) {
        return;
      }
      setConnection("connecting");
      socket = new WebSocket(url);

      socket.onopen = () => {
        backoff = BACKOFF_INITIAL_MS;
        setConnection("open");
      };

      socket.onmessage = (message) => {
        let next: ArenaEnvelope;
        try {
          next = JSON.parse(message.data as string) as ArenaEnvelope;
        } catch {
          return; // A malformed frame must not take the projector down.
        }

        if (next.effects && next.effects.length > 0) {
          const now = performance.now();
          const kept = effectsRef.current.filter(
            (effect) => now - effect.at < EFFECT_TTL_MS,
          );
          for (const effect of next.effects) {
            kept.push({ ...effect, at: now });
          }
          effectsRef.current = kept.slice(-MAX_TIMED_EFFECTS);
        }

        setEnvelope(next);
      };

      socket.onclose = () => {
        setConnection("closed");
        if (closed) {
          return;
        }
        retryTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };

      socket.onerror = () => {
        // onclose always follows, which is where the retry lives.
        socket?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [url]);

  return { envelope, connection, effectsRef };
}
