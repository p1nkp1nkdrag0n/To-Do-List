import type { TourPlacement } from "./tour-types.js";

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface TourPosition {
  x: number;
  y: number;
  placement: TourPlacement;
  arrowOffset: number;
}

const VIEWPORT_MARGIN = 16;
const TARGET_GAP = 15;

const opposites: Record<TourPlacement, TourPlacement> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

function rawPosition(
  target: RectLike,
  bubble: SizeLike,
  placement: TourPlacement,
): { x: number; y: number } {
  if (placement === "top") {
    return {
      x: target.left + target.width / 2 - bubble.width / 2,
      y: target.top - bubble.height - TARGET_GAP,
    };
  }
  if (placement === "bottom") {
    return {
      x: target.left + target.width / 2 - bubble.width / 2,
      y: target.bottom + TARGET_GAP,
    };
  }
  if (placement === "left") {
    return {
      x: target.left - bubble.width - TARGET_GAP,
      y: target.top + target.height / 2 - bubble.height / 2,
    };
  }
  return {
    x: target.right + TARGET_GAP,
    y: target.top + target.height / 2 - bubble.height / 2,
  };
}

function overflowScore(
  position: { x: number; y: number },
  bubble: SizeLike,
  viewport: SizeLike,
): number {
  return Math.max(0, VIEWPORT_MARGIN - position.x)
    + Math.max(0, VIEWPORT_MARGIN - position.y)
    + Math.max(0, position.x + bubble.width + VIEWPORT_MARGIN - viewport.width)
    + Math.max(0, position.y + bubble.height + VIEWPORT_MARGIN - viewport.height);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function positionTourBubble(
  target: RectLike,
  bubble: SizeLike,
  viewport: SizeLike,
  preferred: TourPlacement = "bottom",
): TourPosition {
  const perpendicular: TourPlacement[] = preferred === "top" || preferred === "bottom"
    ? ["right", "left"]
    : ["bottom", "top"];
  const placements = [preferred, opposites[preferred], ...perpendicular];
  const candidates = placements.map((placement) => {
    const raw = rawPosition(target, bubble, placement);
    return { placement, raw, score: overflowScore(raw, bubble, viewport) };
  });
  const selected = candidates.find((candidate) => candidate.score === 0)
    ?? candidates.reduce((best, candidate) => candidate.score < best.score ? candidate : best);
  const x = clamp(selected.raw.x, VIEWPORT_MARGIN, viewport.width - bubble.width - VIEWPORT_MARGIN);
  const y = clamp(selected.raw.y, VIEWPORT_MARGIN, viewport.height - bubble.height - VIEWPORT_MARGIN);
  const arrowOffset = selected.placement === "top" || selected.placement === "bottom"
    ? clamp(target.left + target.width / 2 - x, 24, bubble.width - 24)
    : clamp(target.top + target.height / 2 - y, 24, bubble.height - 24);
  return { x, y, placement: selected.placement, arrowOffset };
}
