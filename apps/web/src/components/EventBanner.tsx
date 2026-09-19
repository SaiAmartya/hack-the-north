import type { Modifier } from "../types";
import { MODIFIER_NAMES } from "../types";

type Props = {
  modifier: Modifier;
  commentary: string | null | undefined;
};

const MODIFIER_COLORS: Record<Modifier, string> = {
  none: "transparent",
  meteor: "#ff8a3d",
  mana_rain: "#4d9dff",
  double_damage: "#ff4d4d",
};

/**
 * The active arena modifier plus the Director's line.
 *
 * The commentary is explicitly labelled "Arena Director" because it is flavour,
 * not a ruling. The host decides what actually happened.
 */
export function EventBanner({ modifier, commentary }: Props) {
  if (modifier === "none" && !commentary) {
    return null;
  }

  return (
    <div className="banner">
      {modifier !== "none" ? (
        <div className="modifier" style={{ color: MODIFIER_COLORS[modifier] }}>
          {MODIFIER_NAMES[modifier]}
        </div>
      ) : null}
      {commentary ? (
        <div className="commentary">
          <span className="label">Arena Director</span>
          {commentary}
        </div>
      ) : null}
    </div>
  );
}
