import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { ArenaEnvelope } from "../types";
import type { TimedEffect } from "../hooks/useArenaSocket";
import { drawArena } from "../lib/drawArena";

type Props = {
  envelope: ArenaEnvelope | null;
  effectsRef: MutableRefObject<TimedEffect[]>;
};

/**
 * Canvas surface: camera frame behind, player plates in front.
 *
 * Draws on requestAnimationFrame so effect fades stay smooth even though state
 * only arrives 20 times a second.
 */
export function ArenaStage({ envelope, effectsRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const envelopeRef = useRef<ArenaEnvelope | null>(envelope);
  const frameRef = useRef<HTMLImageElement | null>(null);
  const frameSourceRef = useRef<string | null>(null);

  envelopeRef.current = envelope;

  // Decode the JPEG only when the bytes actually change, not every render.
  useEffect(() => {
    const encoded = envelope?.frameJpegBase64 ?? null;
    if (encoded === frameSourceRef.current) {
      return;
    }
    frameSourceRef.current = encoded;

    if (!encoded) {
      frameRef.current = null;
      return;
    }
    const image = new Image();
    image.src = `data:image/jpeg;base64,${encoded}`;
    image.onload = () => {
      frameRef.current = image;
    };
  }, [envelope?.frameJpegBase64]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    let running = true;

    const render = () => {
      if (!running) {
        return;
      }

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = Math.max(1, Math.floor(width * ratio));
        canvas.height = Math.max(1, Math.floor(height * ratio));
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      const current = envelopeRef.current;
      if (current) {
        drawArena({
          ctx,
          width,
          height,
          envelope: current,
          frame: frameRef.current,
          effects: effectsRef.current,
          now: performance.now(),
        });
      } else {
        ctx.clearRect(0, 0, width, height);
      }

      requestAnimationFrame(render);
    };

    requestAnimationFrame(render);
    return () => {
      running = false;
    };
  }, [effectsRef]);

  return <canvas ref={canvasRef} aria-label="Phantom Arena stage" />;
}
