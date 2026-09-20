import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { DuelController, nameOf } from "./controller";
import { DuelEffects } from "./effects";
import { GestureGuide } from "./GestureGuide";
import { GestureTrials } from "./GestureTrials";
import { TelemetryPanel } from "./TelemetryPanel";
import type { GameEvent, Player, Spell, SpellRule } from "./contracts";
import "./game.css";

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
      ) : spell === "incendio" ? (
        <path d="M25 6c4 11-6 12 1 20 5-2 6-6 6-9 12 15 6 24-8 24-13 0-19-12-9-22-1 7 3 9 4 7-4-9 5-11 6-20Z" />
      ) : spell === "episkey" ? (
        <path d="M19 10h10v9h9v10h-9v9H19v-9h-9V19h9v-9Z" />
      ) : (
        <path d="M10 31c8-26 20 15 28-13M10 19c8 26 20-15 28 13M24 8v5m0 22v5" />
      )}
    </svg>
  );
}
function HealthPanel({
  player,
  own,
  now,
}: {
  player?: Player | null;
  own: boolean;
  now: number;
}) {
  const health = player?.hp ?? 100,
    max = player?.maxHp ?? 100;
  const status = player && player.shieldUntilMs > now
    ? "◇ SHIELDED"
    : player && player.offenseLockedUntilMs > now
      ? "✧ DISARMED"
      : health === 0 ? "FAINTED" : undefined;
  return (
    <section
      className={`health-panel ${own ? "my-health" : "opponent-hud"}`}
      aria-label={own ? "Your wizard" : "Rival wizard"}
    >
      <div className="health-name">
        <strong>{own ? "YOU" : player?.source === "bot" ? "PRACTICE" : "RIVAL"}</strong>
      </div>
      <div className="health-track">
        <span>HP</span>
        <meter
          min={0}
          max={max}
          value={health}
          aria-label={own ? "Your health" : "Opponent health"}
          data-low={health <= max * 0.25}
        />
      </div>
      <div className="health-caption">
        {status && <span>{status}</span>}
        <b>
          {health} / {max}
        </b>
      </div>
    </section>
  );
}

function spellSummary(rule: SpellRule) {
  if (rule.heal) return `+${rule.heal} HP`;
  if (rule.shieldMs) return "Block one hit";
  return `${rule.damage} damage${rule.offenseLockMs ? " · Disarm" : ""}`;
}

function battleMessage(
  event: GameEvent | undefined,
  slot: string | undefined,
): string {
  const invitation = "Speak a spell and move your wand.";
  if (!event) return invitation;
  const actor = event.actor === slot ? "You" : "Your rival";
  const target = event.target === slot ? "You" : "Your rival";
  if (event.type === "damage") return `${target} took ${event.amount} damage!`;
  if (event.type === "healed") return `${target} recovered ${event.amount} HP!`;
  if (event.type === "impactBlocked") return `${target} blocked the spell!`;
  if (event.type === "castAccepted" && event.spell)
    return `${actor} cast ${nameOf(event.spell)}!`;
  return invitation;
}

function PlayOption({
  kind = "dev", checked, disabled, onChange,
}: {
  kind?: "dev" | "motion";
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className="play-option"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {kind === "motion"
          ? <path d="m4 20 12-12m-4-4V1m8 11h3M5 7 3 5m14-1 3-2m-2 15 2 2" />
          : <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" />}
      </svg>
      <span>{kind === "motion" ? "Simple motion" : "Dev mode"}</span>
      <span className="option-track" aria-hidden="true"><i /></span>
    </button>
  );
}

/** Local feedback only: this SVG never represents an accepted spell or a hit. */
function MiscastVisual({ spell }: { spell: Spell }) {
  return (
    <svg
      className={`miscast-effect miscast-${spell}`}
      viewBox="0 0 180 180"
      fill="none"
      role="img"
      aria-label={`${nameOf(spell)} fizzled near your wand`}
      data-testid="local-miscast"
      data-spell={spell}
    >
      {spell === "protego" ? (
        <g className="miscast-shield">
          <path className="shield-shard shard-left" d="m90 22-48 20v46l20 21 17-28-9-21 20-13Z" />
          <path className="shield-shard shard-right" d="m98 24 40 18v46l-24 36-14-32 14-27-18-14Z" />
          <path className="shield-shard shard-base" d="m87 87-16 30 19 28 16-13-13-28Z" />
          <path className="miscast-dust dust-one" d="m47 126 4-5 4 5-4 5Z" />
          <path className="miscast-dust dust-two" d="m131 112 3-4 3 4-3 4Z" />
        </g>
      ) : spell === "episkey" ? (
        <g className="miscast-heal">
          <path className="healing-wisp wisp-left" d="M72 125c-37-8-43-38-25-46s11-33 23-40" />
          <path className="healing-wisp wisp-right" d="M101 125c32-16 41-37 24-50s-8-24-12-35" />
          <path className="healing-wisp wisp-middle" d="M88 129c18-22-13-40 1-59s6-27 0-37" />
          <path className="miscast-dust dust-one" d="m56 63 4-6 4 6-4 6Z" />
          <path className="miscast-dust dust-two" d="m110 48 3-5 3 5-3 5Z" />
        </g>
      ) : (
        <g className="miscast-sparks">
          <path className="miscast-failed-trail" d="M94 57q34-12 44 9t-9 39" />
          <g className="miscast-ember ember-one"><circle cx="96" cy="56" r="4" /><path d="m89 60-7 4" /></g>
          <g className="miscast-ember ember-two"><circle cx="96" cy="56" r="3" /><path d="m91 62-3 6" /></g>
          <g className="miscast-ember ember-three"><circle cx="96" cy="56" r="2" /></g>
        </g>
      )}
    </svg>
  );
}

const LESSONS: Record<Spell, { purpose: string; success: string }> = {
  stupefy: { purpose: "A quick strike. Watch your rival's health fall.", success: "A direct hit. Each spell recharges on its own." },
  protego: { purpose: "Block the incoming spell. Misses reset when you try again.", success: "Blocked. A shield stops one hit, then disappears." },
  episkey: { purpose: "Recover some health while your attacks recharge.", success: "Health restored. Healing cannot exceed your maximum HP." },
  expelliarmus: { purpose: "Disarm your rival to briefly stop their attacks.", success: "Disarmed. Your rival can still shield or heal." },
  incendio: { purpose: "A slower, stronger strike. Watch it cross the courtyard.", success: "A powerful hit. Its longer cooldown rewards good timing." },
};

function TutorialLesson({ controller }: { controller: DuelController }) {
  const lesson = controller.game.snapshot?.tutorial;
  if (!lesson) return null;
  const spell = lesson.spell;
  const rule = controller.game.rules?.spells.find((candidate) => candidate.spell === spell);
  if (!spell || lesson.stage === "free") {
    return (
      <section className="tutorial-panel tutorial-finale" aria-label="Tutorial guide">
        <div className="tutorial-copy">
          <span className="lesson-count">{lesson.stage === "free" ? "YOUR TURN" : "ALL FIVE SPELLS"}</span>
          <h2>{lesson.stage === "free" ? "Put it together." : "Your first duel."}</h2>
          <p>Thirty seconds. Use your spells to defeat the Practice Wizard.</p>
        </div>
        {lesson.stage !== "free" && <button onClick={() => controller.advanceTutorial()}>Begin duel <span aria-hidden="true">→</span></button>}
      </section>
    );
  }
  const complete = lesson.stage === "complete";
  const raised = spell === "protego" || spell === "episkey";
  const motion = controller.simpleMotion
    ? "move your wand in any direction"
    : raised ? "raise your wand and hold it still" : "jab forward, then return to rest";
  return (
    <section className={`tutorial-panel ${spell}`} aria-label="Tutorial guide" data-stage={lesson.stage}>
      {!controller.simpleMotion && <GestureGuide spell={spell} />}
      <div className="tutorial-copy">
        <span className="lesson-count">SPELL {lesson.step + 1} / 5{complete ? " · MASTERED" : ""}</span>
        <h2>{nameOf(spell)}</h2>
        <p>{complete ? LESSONS[spell].success : LESSONS[spell].purpose}</p>
        {!complete && <p className="tutorial-action">Say “{nameOf(spell)}” as you {motion}.</p>}
        {rule && <div className="lesson-stats"><span>{spellSummary(rule)}</span><span>{rule.cooldownMs / 1000}s cooldown</span></div>}
      </div>
      <div className="tutorial-next">
        {lesson.stage === "instruction" ? <button onClick={() => controller.advanceTutorial()}>Try it <span aria-hidden="true">→</span></button>
          : complete ? <button onClick={() => controller.advanceTutorial()}>Continue <span aria-hidden="true">→</span></button>
          : <span className="lesson-listening" role="status">Your turn{controller.devMode ? " · or click the spell" : ""}</span>}
        {lesson.paused && <span className="lesson-paused">Duel paused</span>}
      </div>
    </section>
  );
}

export function GameApp() {
  const [controller, setController] = useState<DuelController>();
  const [, redraw] = useState(0);
  const low = false;
  const [revision, setRevision] = useState(0);
  const [codeInput, setCodeInput] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    effects = useRef<DuelEffects>();
  const [renderIssue, setRenderIssue] = useState("");
  useEffect(() => {
    const next = new DuelController();
    next.onChange = () => redraw((n) => n + 1);
    setController(next);
    return () => next.destroy();
  }, [revision]);
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
  const me = slot ? game?.players[slot] : undefined;
  const opponent = slot
    ? game?.players[slot === "P1" ? "P2" : "P1"]
    : undefined;
  useEffect(() => {
    effects.current?.update(game, slot);
  }, [game, slot]);
  const live = !c?.game.issue && (game?.phase === "playing" || game?.phase === "countdown");
  const miscast = game?.phase === "playing" && live ? c?.miscast : undefined;
  const wand = c?.wand?.getSnapshot(),
    wandReady = wand?.phase === "streaming";
  const mic = c?.speech.getSnapshot(),
    micReady = c?.devMode || mic?.phase === "listening" || mic?.phase === "busy";
  const phone = c?.phoneSession?.getState();
  const pairingPhone = c?.source === "phone" && c.busy && !wandReady;
  const inRoom = !!c?.roomCode;
  const tutorial = c?.mode === "tutorial";
  const solo = c?.mode === "solo" || tutorial;
  const result = game?.result;
  const now = c?.game.now() ?? 0;
  const issue =
    c?.issue ||
    c?.game.issue ||
    wand?.issue ||
    (inRoom && !c?.devMode ? mic?.issue : "") ||
    renderIssue;
  const checkingWand =
    c?.busy ||
    ["recovering", "validating", "synchronizing", "suspended"].includes(
      wand?.phase ?? "",
    );
  const startingMic = mic?.phase === "starting" || mic?.phase === "calibrating";
  const recent = game?.recentEvents.filter(
    (event) => event.roundId === game.roundId && now - event.atMs < 5000,
  );
  const lastEvent = recent
    ?.filter((event) =>
      ["castAccepted", "damage", "healed", "impactBlocked"].includes(
        event.type,
      ),
    )
    .at(-1);
  const reaction = (own: boolean) => {
    const target = own ? slot : slot === "P1" ? "P2" : "P1";
    const event = recent
      ?.filter(
        (event) =>
          event.target === target &&
          ["damage", "healed", "impactBlocked"].includes(event.type) &&
          now - event.atMs < 700,
      )
      .at(-1);
    return event
      ? event.type === "damage"
        ? "is-hit"
        : event.type === "healed"
          ? "is-healing"
          : "is-blocking"
      : "";
  };
  const status = miscast?.message ?? (
    c?.notice && performance.now() - c.noticeAt < 1400
      ? c.notice
      : battleMessage(lastEvent, slot));
  const leaveRoom = () => {
    c?.leaveRoom();
    setCodeInput("");
  };
  const recoverWand = () =>
    void (wand?.canRetry
      ? c?.retryWand()
      : c?.connect(c.source === "phone" ? "phone" : "ble"));
  const roomHeading =
    c?.game.issue || result?.outcome === "aborted"
      ? "Duel paused"
      : result?.outcome === "draw"
        ? "An even match!"
        : result
          ? result.winner === slot
            ? "Victory!"
            : "Defeat!"
          : me?.ready
            ? solo ? "Wands up…" : "Waiting for your rival…"
            : tutorial ? "Tutorial duel" : solo ? "Solo duel" : "Battle lobby";
  return (
    <main className={`game-shell ${inRoom ? "in-duel" : "at-home"}`}>
      <header className="game-top">
        <a className="wordmark" href="/" aria-label="Wandduel home">
          <span className="brand-star" aria-hidden="true">
            ✦
          </span>{" "}
          WANDDUEL
        </a>
        <div className="top-actions">
          {wandReady && (
            <span className="source-tag">
              <i />
              {c?.source === "phone" ? "iPhone" : "Badge"} connected
            </span>
          )}
          {inRoom ? (
            <button className="quiet" onClick={leaveRoom}>
              Leave duel
            </button>
          ) : c?.source && !pairingPhone ? (
            <button className="quiet" onClick={() => setRevision((n) => n + 1)}>
              Change wand
            </button>
          ) : null}
        </div>
      </header>
      <div className={inRoom ? "duel-layout" : "entry-layout"}>
        {!inRoom && (
          <section className="entry-copy">
            {!c?.source ? (
              <>
                <h1>
                  Wands at
                  <br />
                  the ready.
                </h1>
                <div className="connection-choices">
                  <button onClick={() => void c?.connect("ble")} disabled={!c}>
                    <span aria-hidden="true">✦</span> Connect badge{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void c?.connect("phone")}
                    disabled={!c}
                  >
                    <span aria-hidden="true">▯</span> Connect iPhone{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </>
            ) : pairingPhone ? (
              <>
                {c.phoneClaim ? (
                  c.phoneClaimApproved ? (
                    <>
                      <h1>
                        Connecting
                        <br />
                        your iPhone…
                      </h1>
                      <p role="status">Keep Safari open.</p>
                    </>
                  ) : (
                    <>
                      <h1>Does {c.phoneClaim.challenge} match your iPhone?</h1>
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
                    <p>Open your camera and scan this code.</p>
                    <p role="status">Waiting for your iPhone…</p>
                  </>
                ) : c.pairingCode ? (
                  <>
                    <h1>Pick up your iPhone.</h1>
                    <p className="phone-address">{c.phoneUrl}</p>
                    <output className="pair-code">{c.pairingCode}</output>
                    <p role="status">Waiting for your iPhone…</p>
                  </>
                ) : (
                  <h1>
                    Preparing
                    <br />
                    your iPhone…
                  </h1>
                )}
                {phone?.relayAvailable && (
                  <button
                    className="secondary"
                    onClick={() => c.phoneSession?.chooseRelay()}
                  >
                    Use internet connection
                  </button>
                )}
                <button
                  className="quiet"
                  onClick={() => c.cancelPhonePairing()}
                >
                  Cancel
                </button>
              </>
            ) : wandReady ? (
              <>
                <h1>
                  Your wand
                  <br />
                  is ready.
                </h1>
                <div className="connection-choices">
                  <button onClick={() => void c.startDuel()} disabled={c.busy}>
                    Start a duel <span aria-hidden="true">→</span>
                  </button>
                  <button className="secondary" onClick={() => void c.startDuel("solo")} disabled={c.busy}>
                    Duel a bot <span aria-hidden="true">→</span>
                  </button>
                  <button className="tutorial-entry" onClick={() => void c.startDuel("tutorial")} disabled={c.busy}>
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6c-3-3-7-3-10-1v14c3-2 7-2 10 1m0-14c3-3 7-3 10-1v14c-3-2-7-2-10 1V6Z" /></svg>
                    Tutorial duel <span aria-hidden="true">→</span>
                  </button>
                </div>
                <form
                  className="join-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void c.joinDuel(codeInput);
                  }}
                >
                  <label htmlFor="duel-code">Already have a duel code?</label>
                  <div>
                    <input
                      id="duel-code"
                      placeholder="ABC123"
                      value={codeInput}
                      onChange={(event) =>
                        setCodeInput(event.target.value.toUpperCase())
                      }
                      maxLength={7}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                    />
                    <button className="secondary" disabled={c.busy}>
                      Join with code
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <h1>
                  {wand?.phase === "unsupported"
                    ? "Your badge needs repair."
                    : wand?.phase === "recovering"
                      ? "Reconnecting your wand…"
                      : wand?.phase === "validating"
                        ? "Checking fresh movement…"
                        : c.busy
                          ? "Connecting…"
                          : "Let's reconnect."}
                </h1>
                {wand?.phase === "unsupported" ? (
                  <button onClick={() => void c.connect("phone")}>
                    Use iPhone
                  </button>
                ) : (
                  !checkingWand && (
                    <>
                      <button onClick={recoverWand}>
                        {c.source === "phone"
                          ? "Reconnect iPhone"
                          : "Reconnect badge"}
                      </button>
                      <button
                        className="quiet"
                        onClick={() => setRevision((n) => n + 1)}
                      >
                        Choose another wand
                      </button>
                    </>
                  )
                )}
                {phone?.relayAvailable && (
                  <button
                    className="secondary"
                    onClick={() => c.phoneSession?.chooseRelay()}
                  >
                    Use internet connection
                  </button>
                )}
              </>
            )}
          </section>
        )}
        <div className="arena-frame">
          {inRoom && (
            <div className="arena-title">
              <span>
                <i /> {tutorial ? "TUTORIAL DUEL" : solo ? "SOLO DUEL" : "THE MOONLIT COURTYARD"}
              </span>
              <span>ROUND {game?.roundId || 1}</span>
              {live && game?.phase === "playing" && (!tutorial || game.tutorial?.stage === "free") && (
                <time className="round-clock" aria-label="Time remaining">
                  {Math.max(
                    0,
                    Math.ceil(((game?.roundEndsAtMs ?? now) - now) / 1000),
                  )}
                  s
                </time>
              )}
            </div>
          )}
          <div
            className={`arena ${inRoom ? "arena-live" : "arena-preview"} ${result ? "arena-result" : ""}`}
          >
            <div className="arena-vignette" />
            <div className="duel-platform rival-platform" />
            <div className="duel-platform player-platform" />
            <div
              className={`wizard rival-wizard ${reaction(false)} ${opponent?.hp === 0 ? "is-fainted" : ""}`}
            >
              <img
                src="/art/wizard-rival-front.png"
                alt="Rival wizard facing you"
              />
              {opponent && opponent.offenseLockedUntilMs > now && (
                <span className="wizard-status">DISARMED</span>
              )}
            </div>
            <div
              className={`wizard player-wizard ${reaction(true)} ${me?.hp === 0 ? "is-fainted" : ""}`}
            >
              <img
                src="/art/wizard-player-back.png"
                alt="Your wizard, facing the rival"
              />
              {me && me.offenseLockedUntilMs > now && (
                <span className="wizard-status">DISARMED</span>
              )}
            </div>
            <canvas ref={canvas} className="spell-canvas" aria-hidden="true" />
            {miscast && <MiscastVisual key={miscast.id} spell={miscast.spell} />}
            {(live || result) && (
              <>
                <HealthPanel player={opponent} own={false} now={now} />
                <HealthPanel player={me} own now={now} />
              </>
            )}
            {game?.phase === "countdown" && (
              <div className="countdown" aria-live="assertive">
                <span>WANDS UP</span>
                {Math.max(
                  1,
                  Math.ceil(((game.countdownEndsAtMs ?? now) - now) / 1000),
                )}
              </div>
            )}
            {inRoom && !live && (
              <div
                className={`lobby-overlay ${result ? "result-overlay" : ""}`}
              >
                <section className="setup-card battle-lobby">
                  <span className="result-emblem" aria-hidden="true">
                    {result
                      ? result.outcome === "aborted"
                        ? "Ⅱ"
                        : result.winner === slot
                          ? "✦"
                          : "◇"
                      : "⚔"}
                  </span>
                  <h1>{roomHeading}</h1>
                  {result && (
                    <p className="result-score">
                      YOU <b>{me?.hp ?? 0}</b>
                      <span>HP</span> — RIVAL <b>{opponent?.hp ?? 0}</b>
                      <span>HP</span>
                    </p>
                  )}
                  {(!result ||
                    result.outcome === "aborted" ||
                    c?.game.issue) && (
                    <>
                      {!solo && <div className="room-invite">
                        <span>DUEL CODE</span>
                        <output className="pair-code" aria-label="Duel code">
                          {c?.roomCode}
                        </output>
                      </div>}
                      <p className="pair-status" role="status">
                        {c?.game.issue
                          ? "Battle connection interrupted."
                          : result?.outcome === "aborted"
                            ? "Reconnect, then ready up for a fresh round."
                            : tutorial
                              ? "Learn one spell at a time."
                              : solo
                              ? "Practice Wizard awaits."
                              : opponent?.connected
                              ? opponent.ready
                                ? "Your rival is ready."
                                : "Your rival has joined."
                              : "Share this code with your rival."}
                      </p>
                    </>
                  )}
                  {c?.game.issue ? (
                    <button
                      disabled={c.busy}
                      onClick={() => void c.reconnectBattle()}
                    >
                      Reconnect battle
                    </button>
                  ) : !wandReady ? (
                    wand?.phase === "unsupported" ? (
                      <button onClick={() => void c?.connect("phone")}>
                        Use iPhone
                      </button>
                    ) : checkingWand ? (
                      <p role="status">Checking your wand…</p>
                    ) : (
                      <button onClick={recoverWand}>Reconnect wand</button>
                    )
                  ) : !micReady ? (
                    <button
                      disabled={startingMic}
                      onClick={() => void c?.startMic()}
                    >
                      {mic?.phase === "calibrating"
                        ? "A moment of quiet…"
                        : startingMic
                          ? "Warming up…"
                          : "Enable microphone"}
                    </button>
                  ) : null}
                  <div className="ready-actions">
                    <button
                      disabled={!c?.canReady()}
                      onClick={() => c?.ready()}
                    >
                      {!solo && !opponent?.connected
                        ? "Waiting for rival…"
                        : me?.ready
                        ? solo ? "Wands up…" : "Waiting for opponent…"
                        : result
                          ? "Rematch"
                          : "Ready"}
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
        {tutorial && game?.phase === "playing" && c && !c.game.issue && <TutorialLesson controller={c} />}
        {inRoom && (
          <section className="battle-console" aria-label="Spell book">
            <div className={`battle-dialogue ${miscast ? "miscast-dialogue" : ""}`} role="status">
              <span className="dialogue-star" aria-hidden="true">
                ✦
              </span>
              <p>
                {live
                  ? status
                  : result
                    ? result.outcome === "win"
                      ? result.winner === slot
                        ? "Well cast, wizard. The courtyard is yours."
                        : "A worthy rival. A new strategy. One more duel?"
                      : result.outcome === "draw"
                        ? "Equal magic. A rematch will settle it."
                        : "Your wand stays paired. Ready when you are."
                    : "Five spells. Choose your moment."}
              </p>
              <span className="dialogue-arrow" aria-hidden="true">
                ▼
              </span>
            </div>
            <div className="spell-dock">
              {c?.game.rules?.spells
                .filter((rule) => rule.enabled)
                .map((rule) => {
                  const remaining = Math.max(
                    0,
                    (me?.cooldownUntilMs[rule.spell] ?? 0) - now,
                  );
                  const support =
                    rule.spell === "protego" || rule.spell === "episkey";
                  const SpellCard = c.devMode ? "button" : "div";
                  const lessonSpell = game?.tutorial?.spell === rule.spell;
                  return (
                    <SpellCard
                      key={rule.spell}
                      className={`spell-slot ${rule.spell} ${remaining ? "recharging" : ""} ${c.devMode ? "spell-cast-button" : ""} ${lessonSpell ? "spell-lesson" : ""}`}
                      aria-label={`${c.devMode ? "Cast " : ""}${nameOf(rule.spell)}: ${remaining ? `recharging ${(remaining / 1000).toFixed(1)} seconds` : "ready"}`}
                      disabled={c.devMode ? !c.canCastSpell(rule.spell) : undefined}
                      onClick={c.devMode ? () => c.castSpell(rule.spell) : undefined}
                    >
                      <div className="spell-title">
                        <SpellGlyph spell={rule.spell} />
                        <strong>{nameOf(rule.spell)}</strong>
                      </div>
                      <span className="spell-description">
                        {spellSummary(rule)}
                      </span>
                      <div className="spell-meta">
                        <span>{c.simpleMotion ? "MOVE" : support ? "RAISE" : "JAB"} + SPEAK</span>
                        <b>
                          {remaining
                            ? `${(remaining / 1000).toFixed(1)}s`
                            : `${rule.cooldownMs / 1000}s CD`}
                        </b>
                      </div>
                      <div
                        className="cooldown-track"
                        role="progressbar"
                        aria-label={`${nameOf(rule.spell)} recharge`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(
                          100 * (1 - remaining / rule.cooldownMs),
                        )}
                      >
                        <i
                          style={{
                            width: `${100 * Math.max(0, 1 - remaining / rule.cooldownMs)}%`,
                          }}
                        />
                      </div>
                    </SpellCard>
                  );
                })}
            </div>
          </section>
        )}
        {inRoom && c?.devMode && <TelemetryPanel controller={c} />}
      </div>
      {c?.devMode && c.source && !inRoom && <GestureTrials controller={c} />}
      {!inRoom && (
        <footer className="play-options" aria-label="Play options">
          {c?.devMode && c.simpleMotion && <p className="simple-motion-hint">Say a spell + move your wand.</p>}
          {c?.devMode && <PlayOption kind="motion" checked={c.simpleMotion} disabled={c.busy} onChange={(value) => c.setSimpleMotion(value)} />}
          <PlayOption checked={c?.devMode ?? false} disabled={!c || c.busy} onChange={(value) => c?.setDevMode(value)} />
        </footer>
      )}
      <div className="game-announcement" aria-live="polite">
        {issue ? (
          <span className="error-banner" role="alert">
            {issue === "Clock synchronization expired"
              ? "Your wand connection was interrupted. Reconnect to continue."
              : issue}
          </span>
        ) : null}
      </div>
    </main>
  );
}
