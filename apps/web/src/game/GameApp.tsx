import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { DuelController, nameOf } from "./controller";
import { DuelEffects } from "./effects";
import type { Spell } from "./contracts";
import "./game.css";

function Video({
  stream,
  className,
  label,
}: {
  stream?: MediaStream;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
    return () => {
      if (ref.current) ref.current.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted
      aria-label={label}
    />
  );
}

function PhoneQr({ value }: { value: string }) {
  const drawing = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value, "Byte");
    code.make();
    const margin = 4,
      modules = code.getModuleCount();
    let path = "";
    for (let row = 0; row < modules; row++)
      for (let column = 0; column < modules; column++)
        if (code.isDark(row, column))
          path += `M${column + margin} ${row + margin}h1v1h-1z`;
    return { path, size: modules + margin * 2 };
  }, [value]);
  return (
    <svg
      className="phone-qr"
      viewBox={`0 0 ${drawing.size} ${drawing.size}`}
      role="img"
      aria-label="Scan this code with your iPhone"
      shapeRendering="crispEdges"
    >
      <rect width={drawing.size} height={drawing.size} fill="#fffefb" />
      <path d={drawing.path} fill="#29243d" />
    </svg>
  );
}

export function SpellGlyph({ spell }: { spell: Spell }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="20"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity=".3"
      />
      {spell === "protego" ? (
        <path d="M24 9 37 15v10c0 8-13 15-13 15S11 33 11 25V15l13-6Zm0 7v16m-7-8h14" />
      ) : spell === "stupefy" ? (
        <path d="m29 8-16 19h11l-5 13 16-20H24l5-12Z" />
      ) : (
        <path d="M10 31c8-26 20 15 28-13M10 19c8 26 20-15 28 13M24 8v5m0 22v5" />
      )}
    </svg>
  );
}
function GripGuide() {
  return <svg className="grip-guide" viewBox="0 0 160 120" role="img" aria-label="Hold your wand comfortably on its side at a slight diagonal. We learn your starting grip.">
    <g transform="rotate(60 80 60)">
    <rect x="54" y="15" width="52" height="85" rx="10" fill="none" stroke="currentColor" strokeWidth="4" />
    <path d="M72 25h16M76 90h8M117 64h27m-9-9 9 9-9 9M43 50H16m9-9-9 9 9 9" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="80" cy="58" r="12" fill="currentColor" opacity=".15" />
    </g>
  </svg>;
}
export function GameApp() {
  const [controller, setController] = useState<DuelController>();
  const [, redraw] = useState(0);
  const [low, setLow] = useState(false);
  const [revision, setRevision] = useState(0);
  const [codeInput, setCodeInput] = useState("");
  // Survives "Choose another wand", which rebuilds the controller; "Leave duel" clears it.
  const roomCode = useRef("");
  const canvas = useRef<HTMLCanvasElement>(null),
    effects = useRef<DuelEffects>();
  const [renderIssue, setRenderIssue] = useState("");
  useEffect(() => {
    const c = new DuelController();
    c.roomCode = roomCode.current;
    c.onChange = () => {
      roomCode.current = c.roomCode;
      redraw((n) => n + 1);
    };
    setController(c);
    return () => c.destroy();
  }, [revision]);
  const leaveDuel = () => {
    roomCode.current = "";
    setCodeInput("");
    setRevision((n) => n + 1);
  };
  useEffect(() => {
    if (!controller || !canvas.current) return;
    try {
      const renderer = new DuelEffects(
        canvas.current,
        () => controller.game.now(),
        low,
      );
      effects.current = renderer;
      controller.renderingReady = true;
      setRenderIssue("");
      return () => {
        controller.renderingReady = false;
        effects.current = undefined;
        renderer.dispose();
      };
    } catch {
      controller.renderingReady = false;
      setRenderIssue("Your browser needs WebGL 2 to duel.");
    }
  }, [controller, low]);
  const c = controller,
    game = c?.game.snapshot,
    slot = c?.game.slot;
  const me = slot ? game?.players[slot] : undefined,
    opponent = slot ? game?.players[slot === "P1" ? "P2" : "P1"] : undefined;
  useEffect(() => {
    if (game && slot) effects.current?.update(game, slot);
  }, [game, slot]);
  const live = game?.phase === "playing" || game?.phase === "countdown";
  const motion = c?.motion.getState(),
    mic = c?.speech.getSnapshot();
  const wandReady = c?.wand?.getSnapshot().phase === "streaming";
  const wand = c?.wand?.getSnapshot();
  const phone = c?.phoneSession?.getState();
  const pairingPhone = c?.source === "phone" && c.busy && !wandReady;
  const micReady = mic?.phase === "listening" || mic?.phase === "busy";
  const practice = motion?.phase === "ready" && micReady;
  const issue =
    c?.issue ||
    c?.game.issue ||
    c?.wand?.getSnapshot().issue ||
    mic?.issue ||
    renderIssue;
  const now = c?.game.now() ?? 0;
  const result = game?.result;
  return (
    <main className={`game-shell ${live ? "in-duel" : ""}`}>
      <header className="game-top">
        <a className="wordmark" href="/">
          wandduel<span>✦</span>
        </a>
        <div className="top-actions">
          {c?.source && (
            <span className="source-tag">
              {c.source === "phone"
                ? "iPhone"
                : c.source === "ble"
                  ? "Badge"
                  : "Scripted QA"}
            </span>
          )}
          {c?.source && !pairingPhone && (
            <button className="quiet" onClick={() => setRevision((n) => n + 1)}>
              Leave
            </button>
          )}
        </div>
      </header>
      <div className={`arena ${live ? "arena-live" : ""}`}>
        <Video
          stream={c?.remoteVideo}
          className="opponent-video"
          label="Opponent camera"
        />
        <div className="portal-corners" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <canvas ref={canvas} className="spell-canvas" aria-hidden="true" />
        {live ? (
          <>
            <div className="opponent-hud">
              <span>{opponent?.name ?? "Opponent"}</span>
              <meter
                min={0}
                max={opponent?.maxHp ?? 100}
                value={opponent?.hp ?? 100}
                aria-label="Opponent health"
              />
            </div>
            <time className="round-clock">
              {Math.max(
                0,
                Math.ceil(((game?.roundEndsAtMs ?? now) - now) / 1000),
              )}
            </time>
            {game?.phase === "countdown" && (
              <div className="countdown" aria-live="assertive">
                {Math.max(
                  1,
                  Math.ceil(((game.countdownEndsAtMs ?? now) - now) / 1000),
                )}
              </div>
            )}
            {!c?.remoteVideo && (
              <div
                className="opponent-sigil"
                aria-label="Opponent video unavailable"
              >
                ✧
              </div>
            )}
            <div className="my-health">
              <span>♥ {me?.hp ?? 100}</span>
              <meter
                min={0}
                max={me?.maxHp ?? 100}
                value={me?.hp ?? 100}
                aria-label="Your health"
              />
            </div>
            <div className="spell-dock">
              {c?.game.rules?.spells
                .filter((r) => r.enabled)
                .map((rule) => {
                  const remaining = Math.max(
                    0,
                    (me?.cooldownUntilMs[rule.spell] ?? 0) - now,
                  );
                  return (
                    <div
                      key={rule.spell}
                      className={`spell-slot ${rule.spell} ${remaining ? "recharging" : ""}`}
                    >
                      <SpellGlyph spell={rule.spell} />
                      <span>{nameOf(rule.spell)}</span>
                      <small>
                        {remaining
                          ? `${(remaining / 1000).toFixed(1)}s`
                          : rule.spell === "protego"
                            ? "Raise + speak"
                            : "Jab + speak"}
                      </small>
                    </div>
                  );
                })}
            </div>
            {c?.localVideo && (
              <Video
                stream={c.localVideo}
                className="self-video"
                label="Your camera"
              />
            )}
            {!!me && me.shieldUntilMs > now && (
              <div className="guard-label">Protego</div>
            )}
            {game?.projectiles.some((p) => p.target === slot) && (
              <div className="incoming-label" role="status">
                Incoming spell
              </div>
            )}
          </>
        ) : (
          <section className="setup-card">
            {result ? (
              <>
                <div className="result-star" aria-hidden="true">
                  {result.outcome === "aborted" ? "↻" : "✦"}
                </div>
                <h1>
                  {result.outcome === "aborted"
                    ? "Duel paused"
                    : result.outcome === "draw"
                      ? "A worthy match"
                      : result.winner === slot
                        ? "Brilliantly cast!"
                        : "Another round?"}
                </h1>
                <button
                  disabled={!c?.healthy() || !!me?.ready}
                  onClick={() => c?.ready()}
                >
                  {me?.ready ? "Waiting for opponent…" : "Rematch"}
                </button>
                {result.outcome === "aborted" && (
                  <button
                    className="quiet"
                    onClick={() => setRevision((n) => n + 1)}
                  >
                    Reconnect
                  </button>
                )}
              </>
            ) : !c?.roomCode ? (
              <>
                <div className="wand-illustration" aria-hidden="true">
                  <span>✦</span>
                  <i />
                  <b>✧</b>
                </div>
                <h1>Find your opponent.</h1>
                <div className="connection-choices">
                  <button
                    onClick={() => void c?.startDuel()}
                    disabled={!c || c.busy}
                  >
                    <span aria-hidden="true">✦</span> Start a duel
                  </button>
                </div>
                <form
                  className="join-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    c?.joinDuel(codeInput);
                  }}
                >
                  <input
                    aria-label="Duel code"
                    placeholder="Duel code"
                    value={codeInput}
                    onChange={(event) =>
                      setCodeInput(event.target.value.toUpperCase())
                    }
                    maxLength={7}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="secondary"
                    disabled={!c || c.busy}
                  >
                    Join with code
                  </button>
                </form>
                <p className="pair-status">
                  One player starts; the other joins with the code.
                </p>
              </>
            ) : !c?.source ? (
              <>
                <output className="pair-code" aria-label="Duel code">
                  {c.roomCode}
                </output>
                <p className="pair-status" role="status">
                  Give this code to your opponent.
                </p>
                <h1>Wands at the ready.</h1>
                <div className="connection-choices">
                  <button onClick={() => void c?.connect("ble")} disabled={!c}>
                    <span aria-hidden="true">✧</span> Connect badge
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void c?.connect("phone")}
                    disabled={!c}
                  >
                    <span aria-hidden="true">▯</span> Connect iPhone
                  </button>
                </div>
                <button className="quiet" onClick={leaveDuel}>
                  Leave duel
                </button>
                <label className="quality-choice">
                  <input
                    type="checkbox"
                    checked={low}
                    onChange={(e) => setLow(e.target.checked)}
                  />{" "}
                  Low graphics
                </label>
              </>
            ) : pairingPhone ? (
              <>
                {c.phoneClaim ? (
                  c.phoneClaimApproved ? (
                    <>
                      <div className="result-star" aria-hidden="true">
                        ✧
                      </div>
                      <h1>Connecting your iPhone…</h1>
                      <p role="status">Keep Safari open.</p>
                    </>
                  ) : (
                    <>
                      <h1>
                        Does {c.phoneClaim.challenge} match your iPhone?
                      </h1>
                      <p>Only continue when both screens show this code.</p>
                      <button onClick={() => c.confirmPhoneClaim()}>
                        Yes, connect
                      </button>
                    </>
                  )
                ) : c.phoneHosted && c.phoneUrl ? (
                  <>
                    <h1>Scan with iPhone.</h1>
                    <PhoneQr value={c.phoneUrl} />
                    <p className="phone-address">
                      Open your camera and scan this code.
                    </p>
                    <p className="pair-status" role="status">
                      Waiting for your iPhone…
                    </p>
                  </>
                ) : c.pairingCode ? (
                  <>
                    <h1>Pick up your iPhone.</h1>
                    <p className="phone-address">{c.phoneUrl}</p>
                    <output className="pair-code">{c.pairingCode}</output>
                    <p className="pair-status" role="status">
                      Waiting for your iPhone…
                    </p>
                  </>
                ) : (
                  <>
                    <div className="result-star" aria-hidden="true">
                      ✧
                    </div>
                    <h1>Preparing your iPhone…</h1>
                  </>
                )}
                {phone?.relayAvailable && <button className="secondary" onClick={() => c.phoneSession?.chooseRelay()}>Use internet connection</button>}
                <button className="quiet" onClick={() => c.cancelPhonePairing()}>
                  Cancel
                </button>
              </>
            ) : !wandReady ? (
              <>
                <div className="result-star" aria-hidden="true">
                  ✧
                </div>
                <h1>{wand?.phase === "unsupported" ? "Your badge needs repair."
                  : wand?.phase === "recovering" ? (c.source === "phone" ? "Reconnecting your iPhone…" : "Reconnecting your badge…")
                  : wand?.phase === "validating" ? "Checking fresh movement…"
                  : c.busy ? "Connecting…" : "Let's reconnect."}</h1>
                {wand?.phase === "unsupported" ? <button onClick={() => void c.connect("phone")}>Use iPhone</button> : !c.busy && !["recovering", "validating", "synchronizing"].includes(wand?.phase ?? "") && (
                  <>
                    <button onClick={() => void (wand?.canRetry ? c.retryWand() : c.connect(c.source === "phone" ? "phone" : "ble"))}>
                      {c.source === "phone" ? "Reconnect iPhone" : "Reconnect badge"}
                    </button>
                    <button className="quiet" onClick={() => setRevision((n) => n + 1)}>
                      Choose another wand
                    </button>
                  </>
                )}
                {phone?.relayAvailable && <button className="secondary" onClick={() => c.phoneSession?.chooseRelay()}>Use internet connection</button>}
              </>
            ) : !micReady ? (
              <>
                <div className="result-star" aria-hidden="true">
                  ♪
                </div>
                <h1>
                  {mic?.phase === "calibrating"
                    ? "A moment of quiet…"
                    : mic?.phase === "starting"
                      ? "Warming up…"
                      : "Speak your magic."}
                </h1>
                <button
                  onClick={() => void c.startMic()}
                  disabled={
                    mic?.phase === "starting" || mic?.phase === "calibrating"
                  }
                >
                  Enable microphone
                </button>
              </>
            ) : motion?.phase === "uncalibrated" || motion?.phase === "fault" ? (
              <>
                <GripGuide />
                <h1>Find your wand grip.</h1>
                <p>Try sideways, slightly diagonal. We’ll learn your grip.</p>
                <button onClick={() => c.startCalibration()}>Start calibration</button>
              </>
            ) : motion?.phase === "stillness" || motion?.phase === "resuming" ? (
              <>
                <div className="result-star" aria-hidden="true">
                  ✧
                </div>
                <h1>{motion.phase === "resuming" ? "Hold still for a moment." : "Hold your wand still."}</h1>
                <progress
                  max={motion.progressTargetMs || 1500}
                  value={motion.progressMs}
                  aria-label="Stillness calibration"
                />
                <p role="status">{motion.reason === "keep-still" ? "Keep still; the timer restarts on its own." : "Keep this comfortable grip."}</p>
                <button className="quiet" onClick={() => c.startCalibration()}>Reset grip</button>
              </>
            ) : !practice ? (
              <>
                <SpellGlyph
                  spell={
                    motion?.calibratingSpell ??
                    (!motion?.calibratedSpells.includes("stupefy")
                      ? "stupefy"
                      : "protego")
                  }
                />
                <h1>
                  {motion?.calibratingSpell
                    ? motion.calibratingSpell === "stupefy"
                      ? "Jab forward, three times."
                      : "Raise, hold, lower. Three times."
                    : "Learn your wand."}
                </h1>
                {motion?.calibratingSpell ? (
                  <>
                    <p>{motion.examplesBySpell[motion.calibratingSpell]} / 3</p>
                    <p role="status">{motion.lastIssue || ({ "hold-still": "Hold still", "return-neutral": "Hold still", armed: "Ready when you are", moving: "Moving…", settling: "Settling…", ready: "Got it" }[motion.progress])}</p>
                  </>
                ) : (
                  <button
                    onClick={() =>
                      c.calibrate(
                        !motion?.calibratedSpells.includes("stupefy")
                          ? "stupefy"
                          : "protego",
                      )
                    }
                  >
                    Practice{" "}
                    {!motion?.calibratedSpells.includes("stupefy")
                      ? "Stupefy"
                      : "Protego"}
                  </button>
                )}
                <button className="quiet" onClick={() => c.startCalibration()}>Reset grip</button>
              </>
            ) : (
              <>
                <div className="practice-spells">
                  {(["stupefy", "protego"] as Spell[]).map((spell) => (
                    <div
                      key={spell}
                      className={c.practiced.has(spell) ? "learned" : ""}
                    >
                      <SpellGlyph spell={spell} />
                      <span>
                        {nameOf(spell)} {c.practiced.has(spell) ? "✓" : ""}
                      </span>
                      <small>
                        {spell === "stupefy" ? "Jab + speak" : "Raise + speak"}
                      </small>
                    </div>
                  ))}
                </div>
                <h1>
                  {me?.ready
                    ? "Waiting for your rival…"
                    : c.practiced.size < 2
                      ? "Cast each spell once."
                      : "Ready to duel?"}
                </h1>
                <p className="pair-status" role="status">
                  Duel code {c.roomCode}
                </p>
                <div className="ready-actions">
                  {!c.localVideo && (
                    <button
                      className="secondary"
                      onClick={() => void c.startCamera(low)}
                    >
                      Enable camera
                    </button>
                  )}
                  <button
                    disabled={
                      c.practiced.size < 2 || !c.healthy() || !!me?.ready
                    }
                    onClick={() => c.ready()}
                  >
                    Ready
                  </button>
                </div>
                {c.localVideo && (
                  <Video
                    stream={c.localVideo}
                    className="setup-preview"
                    label="Your camera"
                  />
                )}
              </>
            )}
          </section>
        )}
      </div>
      <div className="game-announcement" aria-live="polite">
        {issue ? (
          <span className="error-banner" role="alert">
            {issue === "Clock synchronization expired"
              ? "Your wand connection was interrupted. Reconnect to continue."
              : issue}
          </span>
        ) : c?.cameraIssue ? (
          <span className="warning-banner">{c.cameraIssue}</span>
        ) : c?.notice && performance.now()-c.noticeAt<1400 ? (
          <span>{c.notice}</span>
        ) : c?.lastSpell && performance.now() - c.lastSpellAt < 1400 ? (
          <span>{nameOf(c.lastSpell)} ✦</span>
        ) : null}
      </div>
    </main>
  );
}
