import type { Spell } from "./contracts";

/** A small, locally drawn demonstration of the two wand gesture families. */
export function GestureGuide({ spell }: { spell: Spell }) {
  const raised = spell === "protego" || spell === "episkey";
  return (
    <svg
      className={`gesture-guide ${spell} ${raised ? "gesture-raise" : "gesture-jab"}`}
      viewBox="0 0 220 128"
      fill="none"
      role="img"
      aria-label={raised ? "Raise your wand, hold it still, then lower it." : "Jab your wand forward, then return to rest."}
    >
      <ellipse className="gesture-ground" cx="108" cy="110" rx="78" ry="8" />
      <path className="gesture-rest" d="M42 86 115 64" />
      {raised ? (
        <>
          <path className="gesture-path" d="M120 61Q121 29 88 17" />
          <path className="gesture-arrow" d="m94 14-9 1 3 9" />
          <path className="gesture-hold" d="M74 16v8m-10-4 5 5m14-6-4 6" />
        </>
      ) : (
        <>
          <path className="gesture-path" d="m124 59 58-17" />
          <path className="gesture-arrow" d="m171 36 14 5-9 12" />
          <path className="gesture-hold" d="m194 31 3-6m2 17 7-2m-13 13 5 4" />
        </>
      )}
      <g className="gesture-wand">
        <path className="gesture-sleeve" d="m22 108 25-37 19 13-9 24Z" />
        <path className="gesture-hand" d="m47 75 8-9c3-3 9-2 10 2l3 14-9 8-12-6Z" />
        <path className="gesture-stick" d="m59 76 63-21" />
        <path className="gesture-grip" d="m59 76 16-5" />
        <circle className="gesture-tip" cx="124" cy="54" r="3" />
      </g>
      <text x="110" y="126" textAnchor="middle">{raised ? "RAISE · HOLD · LOWER" : "JAB · RETURN"}</text>
    </svg>
  );
}
