import { useEffect, useRef } from "react";

import {
  calculateAsciiOffset,
  createAsciiGrid,
  trailOpacity,
  type AsciiPoint,
} from "./ascii-flow";

interface TrailPoint {
  x: number;
  y: number;
  createdAt: number;
}

export function AsciiFlowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = reducedMotionQuery.matches;
    let points: AsciiPoint[] = [];
    let frame = 0;
    let startTime = performance.now();
    let visible = !document.hidden;
    let trail: TrailPoint[] = [];
    let lastTrailAt = 0;
    const pointer = { x: 0, y: 0, active: false, radius: 140 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      points = createAsciiGrid(rect.width, rect.height);
    };

    const draw = (now: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);
      context.font = '600 10px "SFMono-Regular", Consolas, "Liberation Mono", monospace';
      context.textAlign = "center";
      context.textBaseline = "middle";

      for (const point of points) {
        const offset = calculateAsciiOffset(
          point,
          pointer,
          now - startTime,
          reducedMotion,
        );
        const distanceFromPointer = pointer.active
          ? Math.hypot(pointer.x - point.x, pointer.y - point.y)
          : Number.POSITIVE_INFINITY;
        const pointerBoost = Math.max(0, 1 - distanceFromPointer / pointer.radius);
        context.globalAlpha = Math.min(0.78, point.opacity + pointerBoost * 0.28);
        context.fillStyle = pointerBoost > 0.5 ? "#0875ff" : "#2b86f8";
        context.fillText(point.glyph, point.x + offset.x, point.y + offset.y);
      }

      trail = trail.filter((point) => now - point.createdAt < 450);
      context.font = '700 11px "SFMono-Regular", Consolas, monospace';
      for (const [index, point] of trail.entries()) {
        context.globalAlpha = trailOpacity(now - point.createdAt) * 0.82;
        context.fillStyle = index % 2 === 0 ? "#2edbea" : "#18aef5";
        context.fillText(index % 3 === 0 ? "+" : "0", point.x, point.y);
      }
      context.globalAlpha = 1;

      if (!reducedMotion && visible) frame = requestAnimationFrame(draw);
    };

    const redraw = () => {
      cancelAnimationFrame(frame);
      startTime = performance.now();
      draw(startTime);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = true;
      if (event.timeStamp - lastTrailAt >= 18) {
        trail.push({ x: pointer.x, y: pointer.y, createdAt: performance.now() });
        if (trail.length > 28) trail.shift();
        lastTrailAt = event.timeStamp;
      }
    };

    const onPointerLeave = () => {
      pointer.active = false;
    };

    const onVisibilityChange = () => {
      visible = !document.hidden;
      if (!visible) {
        cancelAnimationFrame(frame);
      } else if (!reducedMotion) {
        frame = requestAnimationFrame(draw);
      }
    };

    const onReducedMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      pointer.active = false;
      trail = [];
      redraw();
    };

    const observer = new ResizeObserver(() => {
      resize();
      redraw();
    });
    observer.observe(canvas);
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    canvas.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotionQuery.addEventListener("change", onReducedMotionChange);
    resize();
    draw(startTime);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotionQuery.removeEventListener("change", onReducedMotionChange);
    };
  }, []);

  return <canvas className="ascii-flow-canvas" ref={canvasRef} aria-hidden="true" />;
}
