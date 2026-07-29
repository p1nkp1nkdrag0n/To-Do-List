import { describe, expect, it } from "vitest";

import {
  calculateAsciiOffset,
  chooseAsciiGlyph,
  createAsciiGrid,
  trailOpacity,
} from "../../src/features/auth/ascii-flow.js";

describe("ASCII flow model", () => {
  it("creates a deterministic bounded grid", () => {
    const first = createAsciiGrid(1_920, 1_080, 18, 4_500, 42);
    const second = createAsciiGrid(1_920, 1_080, 18, 4_500, 42);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(4_500);
    expect(first.length).toBeGreaterThan(3_000);
  });

  it("selects stable glyphs", () => {
    expect(chooseAsciiGlyph(12, 8)).toBe(chooseAsciiGlyph(12, 8));
    expect(chooseAsciiGlyph(12, 8).length).toBe(1);
  });

  it("applies local pointer influence and honors reduced motion", () => {
    const point = createAsciiGrid(40, 40, 18, 100, 7)[0]!;
    const active = calculateAsciiOffset(
      point,
      { x: point.x + 20, y: point.y, active: true, radius: 140 },
      500,
    );
    const inactive = calculateAsciiOffset(
      point,
      { x: point.x + 20, y: point.y, active: false, radius: 140 },
      500,
    );
    expect(active).not.toEqual(inactive);
    expect(calculateAsciiOffset(point, { x: 0, y: 0, active: true }, 500, true))
      .toEqual({ x: 0, y: 0 });
  });

  it("fades a trail over its configured lifetime", () => {
    expect(trailOpacity(0)).toBe(1);
    expect(trailOpacity(225)).toBeCloseTo(0.5);
    expect(trailOpacity(450)).toBe(0);
  });
});
