import { useEffect, useRef, useState } from "react";
import { VirtualWandEndpoint } from "../wand/endpoint";
import type { DeviceId, InfoRecord } from "../wand/protocol";
import { PhoneSampler } from "./sensor";
import { recordBytes, socketUrl } from "./relay";
import { HostedPhoneWand } from "./HostedPhoneWand";
import "./phone.css";

const PHONE_ID_KEY = "wandduel.phone-device-id.v1";

export type PhoneWandProps =
  | { mode?: "lan" }
  | { mode: "hosted"; roomId: string };

function phoneInfo(): InfoRecord {
  let deviceId = crypto.getRandomValues(new Uint8Array(6));
  try {
    const stored = localStorage.getItem(PHONE_ID_KEY);
    if (stored && /^[0-9a-f]{12}$/i.test(stored)) {
      deviceId = Uint8Array.from(
        stored.match(/../g)!.map((part) => Number.parseInt(part, 16)),
      );
    } else {
      localStorage.setItem(
        PHONE_ID_KEY,
        [...deviceId].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
    }
  } catch {
    // Storage can be unavailable in private or managed browsing contexts.
  }
  return {
    version: 1,
    capabilities: 15,
    sampleHz: 50,
    rangeG: 8,
    deviceId: [
      deviceId[0],
      deviceId[1],
      deviceId[2],
      deviceId[3],
      deviceId[4],
      deviceId[5],
    ] as DeviceId,
    bootId: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
    firmware: { major: 0, minor: 2, patch: 0 },
    axisConvention: 1,
  };
}

export function PhoneWand(props: PhoneWandProps = {}) {
  if (props.mode === "hosted") return <HostedPhoneWand roomId={props.roomId} infoFactory={phoneInfo} />;
  return <LegacyPhoneWand {...props} />;
}

function LegacyPhoneWand(props: PhoneWandProps = {}) {
  const hosted = props.mode === "hosted";
  const hostedRoomId = hosted ? props.roomId : "";
  const hostedRoomValid = /^[0-9a-f]{32}$/.test(hostedRoomId);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState(
    hosted && !hostedRoomValid ? "Scan the code again." : "Connect your wand",
  );
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [hp, setHp] = useState<number>();
  const [cue, setCue] = useState(0);
  const [showWakeHint, setShowWakeHint] = useState(false);
  const info = useRef<InfoRecord | null>(null);
  const endpointInfo = info.current ?? (info.current = phoneInfo());
  const cleanup = useRef<(reason?: string) => void>(() => {});
  const mounted = useRef(false);
  const connectingRef = useRef(false);
  const attempt = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const pageHide = () => cleanup.current("Wand paused. Reconnect.");
    window.addEventListener("pagehide", pageHide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", pageHide);
      cleanup.current();
    };
  }, []);
  async function connect() {
    if (connectingRef.current || active) return;
    if (hosted && !hostedRoomValid) {
      setPhase("This wand link is invalid.");
      return;
    }
    cleanup.current();
    const attemptId = ++attempt.current;
    connectingRef.current = true;
    setConnecting(true);
    setChallenge("");
    setShowWakeHint(false);
    setPhase("Requesting motion access…");
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let ws: WebSocket | undefined;
    let wakeLock: WakeLockSentinel | undefined;
    const current = () =>
      !stopped && mounted.current && attempt.current === attemptId;
    function stop(reason = "Connect your wand") {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      window.removeEventListener("devicemotion", onMotion);
      document.removeEventListener("visibilitychange", hide);
      endpoint?.disconnect();
      const ownedWakeLock = wakeLock;
      wakeLock = undefined;
      if (ownedWakeLock) void ownedWakeLock.release().catch(() => undefined);
      const socket = ws;
      ws = undefined;
      if (socket) {
        socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null;
        socket.close();
      }
      if (attempt.current === attemptId) {
        connectingRef.current = false;
        cleanup.current = () => {};
        if (mounted.current) {
          setConnecting(false);
          setActive(false);
          setChallenge("");
          setHp(undefined);
          setCue(0);
          setPhase(reason);
        }
      }
    }
    cleanup.current = stop;
    let endpoint: VirtualWandEndpoint | undefined;
    const sampler = new PhoneSampler();
    const onMotion = (event: DeviceMotionEvent) => {
      const a = event.accelerationIncludingGravity;
      if (a) sampler.observe(a.x, a.y, a.z, performance.now());
    };
    const hide = () => {
      if (document.hidden) stop("Wand paused. Reconnect.");
    };
    try {
      if (!window.isSecureContext)
        throw new Error("Open the trusted HTTPS address on your laptop.");
      const motion = DeviceMotionEvent as typeof DeviceMotionEvent & {
        requestPermission?: () => Promise<string>;
      };
      if (
        motion.requestPermission &&
        (await motion.requestPermission()) !== "granted"
      )
        throw new Error("Allow motion to use your wand.");
      if (!current()) return;
      const wakeLockApi = (navigator as Partial<Navigator>).wakeLock;
      if (wakeLockApi) {
        void wakeLockApi
          .request("screen")
          .then((lock) => {
            if (!current()) {
              void lock.release().catch(() => undefined);
              return;
            }
            wakeLock = lock;
            lock.addEventListener(
              "release",
              () => {
                if (wakeLock !== lock) return;
                wakeLock = undefined;
                if (current()) setShowWakeHint(true);
              },
              { once: true },
            );
          })
          .catch(() => {
            if (current()) setShowWakeHint(true);
          });
      } else {
        setShowWakeHint(true);
      }
      const wand = new VirtualWandEndpoint({
        nowMs: () => performance.now(),
        info: endpointInfo,
        sensorHealthy: false,
      });
      endpoint = wand;
      let lastTick = performance.now(),
        healthAt = 0,
        lastMotion = 0,
        sensorReady = false;
      const sensorDeadline = lastTick + 3_000;
      const send = (message: object) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 16_384) {
          stop("Connection too slow. Reconnect.");
          return;
        }
        ws.send(JSON.stringify({ v: 1, ...message }));
      };
      const openRelay = () => {
        if (!current() || ws) return;
        ws = new WebSocket(
          socketUrl(hosted ? `/ws/${hostedRoomId}` : "/ws/dev-wand"),
        );
        ws.onopen = () =>
          send(
            hosted
              ? { type: "phone" }
              : { type: "phone", code: code.trim().toUpperCase() },
          );
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.v !== 1) throw new Error("Unsupported relay version");
            if (msg.type === "awaiting") {
              if (!hosted || !/^[0-9]{6}$/.test(msg.challenge))
                throw new Error("Invalid confirmation challenge");
              setChallenge(msg.challenge);
              setPhase("Confirm on your laptop");
              return;
            }
            if (msg.type === "paired") {
              if (
                !Number.isSafeInteger(msg.generation) ||
                msg.generation < 1
              )
                throw new Error("Invalid relay generation");
              setChallenge("");
              setPhase("Your wand is ready");
              setActive(true);
              return;
            }
            if (msg.type !== "op") return;
            let data: Uint8Array | undefined;
            switch (msg.operation) {
              case "info":
                data = wand.readInfo();
                break;
              case "status":
                data = wand.readStatus();
                break;
              case "control":
                wand.writeControl(recordBytes(msg.data));
                break;
              case "subscribe-motion":
                wand.subscribeMotion((bytes) =>
                  send({ type: "notify", kind: "motion", data: [...bytes] }),
                );
                break;
              case "subscribe-status":
                wand.subscribeStatus((bytes) =>
                  send({ type: "notify", kind: "status", data: [...bytes] }),
                );
                break;
              default:
                throw new Error("Unsupported command");
            }
            send({
              type: "reply",
              id: msg.id,
              ...(data ? { data: [...data] } : {}),
            });
          } catch {
            stop("Connection interrupted. Reconnect.");
          }
        };
        ws.onclose = () => stop("Connection closed. Reconnect.");
        ws.onerror = () => stop("Unable to connect. Try again.");
        setPhase("Finding your laptop…");
      };
      timer = setInterval(() => {
        const now = performance.now();
        if (now - lastTick > 200) {
          stop("Wand paused. Reconnect.");
          return;
        }
        lastTick = now;
        const sample = sampler.select(now, wand.info.bootId);
        if (sample) {
          lastMotion = now;
          wand.setSensorHealthy(true);
          wand.emitMotion(sample);
          if (!sensorReady) {
            sensorReady = true;
            openRelay();
          }
        }
        if (!sensorReady && now >= sensorDeadline) {
          stop("No motion detected. Try again.");
          return;
        }
        if (sensorReady && now - lastMotion > 500)
          wand.setSensorHealthy(false);
        wand.tick();
        if (now - healthAt >= 500) {
          healthAt = now;
          wand.notifyHealth();
        }
        const shown = wand.getPresentation();
        setHp(shown.state?.hp);
        setCue(shown.cue?.effect ?? 0);
      }, 20);
      window.addEventListener("devicemotion", onMotion);
      document.addEventListener("visibilitychange", hide);
      setPhase("Move your iPhone to finish connecting…");
    } catch (error) {
      if (current())
        stop(error instanceof Error ? error.message : "Unable to connect");
    }
  }
  return (
    <main className="phone-page">
      <a className="wordmark" href="/">
        wandduel<span>✦</span>
      </a>
      <div className={`wand-orb cue-${cue}`} aria-hidden="true">
        ✧
      </div>
      <h1>{phase}</h1>
      {showWakeHint ? (
        <p role="status">Keep this screen awake during your duel.</p>
      ) : null}
      {hosted && !hostedRoomValid ? (
        <p>Open the iPhone pairing screen on your laptop and scan its QR code.</p>
      ) : active ? (
        <>
          <output className="phone-health">
            {hp === undefined ? "✦" : `${hp} ♥`}
          </output>
          <button className="quiet" onClick={() => cleanup.current()}>
            Disconnect
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          {hosted ? (
            challenge ? (
              <>
                <p>Confirmation code</p>
                <output className="pair-code" aria-label="Confirmation code">
                  {challenge}
                </output>
                <p>Confirm this code on your laptop.</p>
              </>
            ) : (
              <button disabled={!hostedRoomValid || connecting}>
                Connect wand
              </button>
            )
          ) : (
            <>
              <label htmlFor="pair-code">Laptop code</label>
              <input
                id="pair-code"
                value={code}
                maxLength={10}
                autoComplete="off"
                autoCapitalize="characters"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button disabled={code.trim().length !== 10 || connecting}>
                Connect wand
              </button>
            </>
          )}
        </form>
      )}
    </main>
  );
}
