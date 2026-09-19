import type { ArenaEnvelope, PlayerId, PlayerState } from "../types";
import { PLAYER_COLORS, SPELL_NAMES } from "../types";
import type { TimedEffect } from "../hooks/useArenaSocket";

export type DrawInput = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  envelope: ArenaEnvelope;
  frame: HTMLImageElement | null;
  effects: TimedEffect[];
  now: number;
};

const PLATE_WIDTH = 210;
const PLATE_HEIGHT = 74;
const EFFECT_TTL_MS = 900;

/**
 * Draw one frame of the arena.
 *
 * Pure rendering: every number shown here came from the host. No game rule is
 * evaluated in TypeScript.
 */
export function drawArena({
  ctx,
  width,
  height,
  envelope,
  frame,
  effects,
  now,
}: DrawInput): void {
  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx, width, height, frame);

  const players = envelope.state.players;
  for (const playerId of ["P1", "P2"] as PlayerId[]) {
    const player = players[playerId];
    if (!player) {
      continue;
    }
    const marker = envelope.markers[playerId];
    const anchored = Boolean(marker?.visible);

    const { x, y } = anchored
      ? plateFromMarker(marker.x, marker.y, width, height)
      : cornerPlate(playerId, width, height);

    drawPlate(ctx, player, x, y, anchored);
    if (anchored) {
      drawMarkerTether(ctx, playerId, marker.x * width, marker.y * height, x, y);
    }
  }

  drawEffects(ctx, width, height, envelope, effects, now);
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: HTMLImageElement | null,
): void {
  if (frame && frame.complete && frame.naturalWidth > 0) {
    // Letterbox rather than stretch, so marker coordinates stay meaningful.
    const scale = Math.min(width / frame.naturalWidth, height / frame.naturalHeight);
    const drawWidth = frame.naturalWidth * scale;
    const drawHeight = frame.naturalHeight * scale;
    ctx.drawImage(
      frame,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    return;
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#0b1020");
  gradient.addColorStop(1, "#05070b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(141, 153, 184, 0.55)";
  ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("no camera frame - corner HUDs active", width / 2, height / 2);
  ctx.textAlign = "left";
}

function plateFromMarker(
  markerX: number,
  markerY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = clamp(markerX * width - PLATE_WIDTH / 2, 12, width - PLATE_WIDTH - 12);
  const y = clamp(markerY * height - PLATE_HEIGHT - 42, 12, height - PLATE_HEIGHT - 12);
  return { x, y };
}

function cornerPlate(
  playerId: PlayerId,
  width: number,
  height: number,
): { x: number; y: number } {
  const y = height - PLATE_HEIGHT - 18;
  return playerId === "P1"
    ? { x: 18, y }
    : { x: width - PLATE_WIDTH - 18, y };
}

function drawPlate(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  x: number,
  y: number,
  anchored: boolean,
): void {
  const color = PLAYER_COLORS[player.id];

  ctx.fillStyle = "rgba(10, 13, 20, 0.82)";
  roundRect(ctx, x, y, PLATE_WIDTH, PLATE_HEIGHT, 10);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = anchored ? 2 : 1;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = "800 17px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(player.id, x + 12, y + 22);

  ctx.fillStyle = "#eef2ff";
  ctx.font = "600 14px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${player.health}`, x + PLATE_WIDTH - 12, y + 22);
  ctx.textAlign = "left";

  drawBar(ctx, x + 12, y + 32, PLATE_WIDTH - 24, 9, player.health / 100, color);
  drawBar(ctx, x + 12, y + 46, PLATE_WIDTH - 24, 6, player.mana / 100, "#6f8cff");

  ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "rgba(238, 242, 255, 0.72)";
  const spell = player.lastSpell ? SPELL_NAMES[player.lastSpell] ?? player.lastSpell : "-";
  ctx.fillText(spell, x + 12, y + PLATE_HEIGHT - 7);

  if (!anchored) {
    ctx.fillStyle = "rgba(141, 153, 184, 0.8)";
    ctx.textAlign = "right";
    ctx.fillText("no marker", x + PLATE_WIDTH - 12, y + PLATE_HEIGHT - 7);
    ctx.textAlign = "left";
  }
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fraction: number,
  color: string,
): void {
  ctx.fillStyle = "rgba(26, 32, 50, 0.95)";
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.fill();

  const filled = Math.max(0, Math.min(1, fraction)) * width;
  if (filled <= 0) {
    return;
  }
  ctx.fillStyle = color;
  roundRect(ctx, x, y, filled, height, height / 2);
  ctx.fill();
}

function drawMarkerTether(
  ctx: CanvasRenderingContext2D,
  playerId: PlayerId,
  markerX: number,
  markerY: number,
  plateX: number,
  plateY: number,
): void {
  ctx.strokeStyle = PLAYER_COLORS[playerId];
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(plateX + PLATE_WIDTH / 2, plateY + PLATE_HEIGHT);
  ctx.lineTo(markerX, markerY);
  ctx.stroke();

  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(markerX, markerY, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawEffects(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  envelope: ArenaEnvelope,
  effects: TimedEffect[],
  now: number,
): void {
  for (const effect of effects) {
    const age = now - effect.at;
    if (age > EFFECT_TTL_MS || !effect.player) {
      continue;
    }
    const fade = 1 - age / EFFECT_TTL_MS;
    const marker = envelope.markers[effect.player];
    const anchored = Boolean(marker?.visible);
    const base = anchored
      ? { x: marker.x * width, y: marker.y * height }
      : anchorForCorner(effect.player, width, height);

    ctx.globalAlpha = fade;

    if (effect.type === "damage" && effect.amount) {
      ctx.fillStyle = "#ff6b6b";
      ctx.font = "800 30px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`-${effect.amount}`, base.x, base.y - 60 - age * 0.05);
      ctx.textAlign = "left";
    } else if (effect.type === "shield_absorb") {
      ctx.strokeStyle = "#6ee7ff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(base.x, base.y, 34 + age * 0.05, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "cast") {
      ctx.fillStyle = PLAYER_COLORS[effect.player];
      ctx.font = "700 16px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      const name = effect.spell ? SPELL_NAMES[effect.spell] ?? effect.spell : "cast";
      ctx.fillText(name, base.x, base.y - 34);
      ctx.textAlign = "left";
    } else if (effect.type === "reject") {
      ctx.fillStyle = "rgba(255, 197, 85, 0.9)";
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(effect.note ?? "rejected", base.x, base.y - 22);
      ctx.textAlign = "left";
    }

    ctx.globalAlpha = 1;
  }
}

function anchorForCorner(
  playerId: PlayerId,
  width: number,
  height: number,
): { x: number; y: number } {
  const y = height - PLATE_HEIGHT - 30;
  return playerId === "P1"
    ? { x: 18 + PLATE_WIDTH / 2, y }
    : { x: width - PLATE_WIDTH / 2 - 18, y };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
