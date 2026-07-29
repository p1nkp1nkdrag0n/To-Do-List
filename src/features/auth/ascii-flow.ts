export const ASCII_GLYPHS = ".:+*#%@01/\\";

export interface AsciiPoint {
  x: number;
  y: number;
  glyph: string;
  phase: number;
  opacity: number;
}

export interface PointerInfluence {
  x: number;
  y: number;
  active: boolean;
  radius?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function chooseAsciiGlyph(seed: number, index: number): string {
  const random = mulberry32(seed + index * 97_409);
  return ASCII_GLYPHS[Math.floor(random() * ASCII_GLYPHS.length)] ?? ".";
}

export function createAsciiGrid(
  width: number,
  height: number,
  cellSize = 18,
  maxCharacters = 4_500,
  seed = 2_026,
): AsciiPoint[] {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const minimumCellSize = Math.max(8, cellSize);
  const areaCellSize = Math.sqrt(
    Math.max(1, safeWidth * safeHeight) / Math.max(1, maxCharacters),
  );
  const spacing = Math.max(minimumCellSize, areaCellSize);
  const columns = Math.floor(safeWidth / spacing);
  const rows = Math.floor(safeHeight / spacing);
  const random = mulberry32(seed);
  const points: AsciiPoint[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      points.push({
        x: (column + 0.5) * spacing,
        y: (row + 0.5) * spacing,
        glyph: chooseAsciiGlyph(seed, index),
        phase: random() * Math.PI * 2,
        opacity: 0.18 + random() * 0.34,
      });
    }
  }

  return points;
}

export function calculateAsciiOffset(
  point: AsciiPoint,
  pointer: PointerInfluence,
  elapsedMs: number,
  reducedMotion = false,
): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };

  const time = elapsedMs / 1_000;
  let x = Math.sin(time * 0.24 + point.y * 0.018 + point.phase) * 2.8;
  let y = Math.cos(time * 0.18 + point.x * 0.012 + point.phase) * 1.4;

  if (!pointer.active) return { x, y };

  const dx = pointer.x - point.x;
  const dy = pointer.y - point.y;
  const distance = Math.hypot(dx, dy);
  const radius = pointer.radius ?? 140;
  if (distance === 0 || distance >= radius) return { x, y };

  const strength = (1 - distance / radius) ** 2;
  const normalizedX = dx / distance;
  const normalizedY = dy / distance;
  x += normalizedX * strength * 24 - normalizedY * strength * 9;
  y += normalizedY * strength * 24 + normalizedX * strength * 9;
  return { x, y };
}

export function trailOpacity(ageMs: number, durationMs = 450): number {
  if (ageMs <= 0) return 1;
  if (ageMs >= durationMs) return 0;
  return 1 - ageMs / durationMs;
}
