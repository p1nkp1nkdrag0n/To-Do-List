import {
  CalendarClock,
  FileArchive,
  FolderKanban,
  GanttChartSquare,
  Layers3,
  LoaderCircle,
  Plus,
  Search,
  Settings,
  Sparkles,
  TableProperties,
  Users,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";

import { tourDefinition } from "./tour-definitions";
import { positionTourBubble, type RectLike, type TourPosition } from "./tour-position";
import type { TourController } from "./useProductTour";
import type { TourIconName, TourStep } from "./tour-types";

interface ProductTourProps {
  controller: TourController;
  onCreateProject: () => void;
}

const iconMap: Record<TourIconName, ComponentType<{ size?: number }>> = {
  calendar: CalendarClock,
  file: FileArchive,
  folder: FolderKanban,
  gantt: GanttChartSquare,
  layers: Layers3,
  plus: Plus,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  table: TableProperties,
  users: Users,
};

function visibleTarget(step: TourStep): HTMLElement | undefined {
  for (const targetId of step.targetIds) {
    const element = document.querySelector<HTMLElement>(`[data-tour-id="${targetId}"]`);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return element;
  }
  return undefined;
}

function expandedTargetRect(element: HTMLElement): RectLike | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const padding = 8;
  const left = Math.max(4, rect.left - padding);
  const top = Math.max(4, rect.top - padding);
  const right = Math.min(window.innerWidth - 4, rect.right + padding);
  const bottom = Math.min(window.innerHeight - 4, rect.bottom + padding);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden);
}

function Spotlight({ rect }: { rect: RectLike }) {
  const common: CSSProperties = { position: "fixed" };
  return (
    <>
      <span className="tour-scrim-piece tour-scrim-top" style={{ ...common, inset: `0 0 auto 0`, height: rect.top }} />
      <span className="tour-scrim-piece tour-scrim-left" style={{ ...common, left: 0, top: rect.top, width: rect.left, height: rect.height }} />
      <span className="tour-scrim-piece tour-scrim-right" style={{ ...common, left: rect.right, right: 0, top: rect.top, height: rect.height }} />
      <span className="tour-scrim-piece tour-scrim-bottom" style={{ ...common, inset: `${rect.bottom}px 0 0 0` }} />
      <span
        className="tour-target-shield"
        data-testid="tour-target-shield"
        style={{
          ...common,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }}
      />
    </>
  );
}

export function ProductTour({ controller, onCreateProject }: ProductTourProps) {
  const active = controller.active;
  const [targetRect, setTargetRect] = useState<RectLike>();
  const [targetMissing, setTargetMissing] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [position, setPosition] = useState<TourPosition>();
  const bubbleRef = useRef<HTMLElement>(null);

  const definition = active ? tourDefinition(active.section) : undefined;
  const step = active && definition ? definition.steps[active.stepIndex] : undefined;

  useEffect(() => {
    if (!active || !step || !controller.viewportSupported) return;
    let disposed = false;
    let targetElement: HTMLElement | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame = 0;

    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (disposed || !targetElement?.isConnected) return;
        const nextRect = expandedTargetRect(targetElement);
        if (nextRect) {
          setTargetRect(nextRect);
          setTargetMissing(false);
        }
      });
    };

    const attach = (element: HTMLElement) => {
      if (targetElement === element) {
        measure();
        return;
      }
      resizeObserver?.disconnect();
      targetElement = element;
      setTargetMissing(false);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      element.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(element);
      measure();
      window.setTimeout(measure, reducedMotion ? 0 : 280);
    };

    const locate = () => {
      const element = visibleTarget(step);
      if (element) attach(element);
    };

    setTargetRect(undefined);
    setTargetMissing(false);
    locate();
    const mutationObserver = new MutationObserver(locate);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    const missingTimer = window.setTimeout(() => {
      if (!targetElement && !disposed) setTargetMissing(true);
    }, 4_000);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      disposed = true;
      window.clearTimeout(missingTimer);
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active?.section, active?.stepIndex, controller.viewportSupported, retryToken, step]);

  useLayoutEffect(() => {
    if (!targetRect || !bubbleRef.current) {
      setPosition(undefined);
      return;
    }
    const bubble = bubbleRef.current;
    const reposition = () => {
      const bubbleRect = bubble.getBoundingClientRect();
      setPosition(positionTourBubble(
        targetRect,
        { width: bubbleRect.width, height: bubbleRect.height },
        { width: window.innerWidth, height: window.innerHeight },
        step?.placement,
      ));
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [step?.placement, targetRect]);

  useEffect(() => {
    if (!active || !controller.viewportSupported) return;
    const root = document.getElementById("root");
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";

    const focusBubble = window.requestAnimationFrame(() => bubbleRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!bubbleRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        controller.snooze();
        return;
      }
      if (event.key === "ArrowLeft" && active.stepIndex > 0 && !targetMissing) {
        event.preventDefault();
        event.stopPropagation();
        controller.previous();
        return;
      }
      if (event.key === "ArrowRight" && step?.action !== "create-project" && !targetMissing) {
        event.preventDefault();
        event.stopPropagation();
        controller.next();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(bubbleRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        bubbleRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(focusBubble);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (root) root.inert = false;
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [
    active?.section,
    active?.stepIndex,
    controller.next,
    controller.previous,
    controller.snooze,
    controller.viewportSupported,
    step?.action,
    targetMissing,
  ]);

  if (!active || !definition || !step || !controller.viewportSupported) return null;

  const Icon = iconMap[step.icon];
  const waiting = !targetRect && !targetMissing;
  const isLast = active.stepIndex === definition.steps.length - 1;
  const bubbleStyle: CSSProperties = position
    ? {
        left: position.x,
        top: position.y,
        "--tour-arrow-offset": `${position.arrowOffset}px`,
      } as CSSProperties
    : {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
      };

  return createPortal(
    <div className="product-tour-layer" aria-live="polite">
      {targetRect ? <Spotlight rect={targetRect} /> : <span className="tour-scrim-full" />}
      <section
        ref={bubbleRef}
        className={`tour-bubble ${targetMissing || waiting ? "tour-bubble-centered" : ""}`}
        data-placement={position?.placement}
        data-tour-section={active.section}
        data-tour-step={step.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-tour-title"
        tabIndex={-1}
        style={bubbleStyle}
      >
        <div
          className="tour-segments"
          aria-hidden="true"
          style={{ "--tour-step-count": definition.steps.length } as CSSProperties}
        >
          {definition.steps.map((item, index) => (
            <span
              key={item.id}
              className={index < active.stepIndex ? "complete" : index === active.stepIndex ? "current" : ""}
            />
          ))}
        </div>
        <header className="tour-bubble-header">
          <span className="tour-context-icon"><Icon size={18} /></span>
          <button
            className="icon-button tour-close"
            type="button"
            onClick={controller.snooze}
            aria-label="稍后再看"
            title="稍后再看"
          >
            <X size={17} />
          </button>
        </header>

        {targetMissing ? (
          <div className="tour-message">
            <small>页面定位</small>
            <h2 id="product-tour-title">页面尚未准备好</h2>
            <p>目标区域可能仍在加载，或当前页面状态暂时没有显示它。</p>
            <footer className="tour-recovery-actions">
              <button className="secondary-button" type="button" onClick={controller.snooze}>稍后</button>
              <button className="primary-button" type="button" onClick={() => setRetryToken((value) => value + 1)}>重试</button>
            </footer>
          </div>
        ) : waiting ? (
          <div className="tour-message tour-waiting">
            <LoaderCircle className="spin" size={20} />
            <h2 id="product-tour-title">正在定位页面控件</h2>
          </div>
        ) : (
          <>
            <div className="tour-message">
              <small>第 {active.stepIndex + 1} 步，共 {definition.steps.length} 步</small>
              <h2 id="product-tour-title">{step.title}</h2>
              <p>{step.description}</p>
            </div>
            <footer className="tour-actions">
              <button className="tour-skip-button" type="button" onClick={controller.skipSection}>跳过本段</button>
              <span>
                {step.action !== "create-project" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={controller.previous}
                    disabled={active.stepIndex === 0}
                  >
                    上一步
                  </button>
                ) : null}
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    if (step.action === "create-project") {
                      controller.pauseForAction();
                      onCreateProject();
                    } else {
                      controller.next();
                    }
                  }}
                >
                  {step.action === "create-project" ? "开始创建" : isLast ? "完成" : "下一步"}
                </button>
              </span>
            </footer>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
