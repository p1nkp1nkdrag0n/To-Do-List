import { describe, expect, it } from "vitest";

import { TOUR_DEFINITIONS } from "../../src/features/onboarding/tour-definitions.js";
import { positionTourBubble } from "../../src/features/onboarding/tour-position.js";
import {
  clearTourProgress,
  clearTourSnooze,
  completeTourSection,
  emptyTourProgress,
  isTourSnoozed,
  readTourProgress,
  snoozeTours,
  tourProgressKey,
  writeTourProgress,
} from "../../src/features/onboarding/tour-storage.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

describe("product onboarding state", () => {
  it("uses isolated versioned progress for each account", () => {
    const storage = memoryStorage();
    const leaderProgress = completeTourSection(emptyTourProgress(), "workspace");
    writeTourProgress(storage, "leader-id", leaderProgress);

    expect(readTourProgress(storage, "leader-id").completedSections).toEqual(["workspace"]);
    expect(readTourProgress(storage, "member-id").completedSections).toEqual([]);
    expect(tourProgressKey("leader-id")).not.toBe(tourProgressKey("member-id"));
  });

  it("sanitizes corrupt, duplicated, and unknown stored sections", () => {
    const storage = memoryStorage({
      [tourProgressKey("corrupt")]: "{",
      [tourProgressKey("mixed")]: JSON.stringify({
        version: 1,
        completedSections: ["workspace", "workspace", "unknown", 17],
      }),
    });

    expect(readTourProgress(storage, "corrupt")).toEqual(emptyTourProgress());
    expect(readTourProgress(storage, "mixed").completedSections).toEqual(["workspace"]);
  });

  it("keeps completion idempotent and supports reset", () => {
    const storage = memoryStorage();
    const once = completeTourSection(emptyTourProgress(), "resources");
    const twice = completeTourSection(once, "resources");
    expect(twice).toBe(once);

    writeTourProgress(storage, "user", twice);
    clearTourProgress(storage, "user");
    expect(readTourProgress(storage, "user")).toEqual(emptyTourProgress());
  });

  it("snoozes only in the supplied session storage", () => {
    const firstSession = memoryStorage();
    const nextSession = memoryStorage();
    snoozeTours(firstSession, "user");
    expect(isTourSnoozed(firstSession, "user")).toBe(true);
    expect(isTourSnoozed(nextSession, "user")).toBe(false);
    clearTourSnooze(firstSession, "user");
    expect(isTourSnoozed(firstSession, "user")).toBe(false);
  });

  it("defines the approved progressive step counts", () => {
    expect(TOUR_DEFINITIONS["project-setup"].steps).toHaveLength(1);
    expect(TOUR_DEFINITIONS.workspace.steps).toHaveLength(7);
    expect(TOUR_DEFINITIONS.resources.steps).toHaveLength(3);
    expect(TOUR_DEFINITIONS.availability.steps).toHaveLength(4);
  });
});

describe("tour bubble positioning", () => {
  it("flips above a target when the preferred bottom placement overflows", () => {
    const position = positionTourBubble(
      { left: 500, top: 760, right: 700, bottom: 820, width: 200, height: 60 },
      { width: 360, height: 240 },
      { width: 1200, height: 860 },
      "bottom",
    );
    expect(position.placement).toBe("top");
    expect(position.y).toBeGreaterThanOrEqual(16);
  });

  it("shifts the bubble inside the 16px viewport margin", () => {
    const position = positionTourBubble(
      { left: 2, top: 200, right: 42, bottom: 240, width: 40, height: 40 },
      { width: 360, height: 220 },
      { width: 1100, height: 700 },
      "top",
    );
    expect(position.x).toBeGreaterThanOrEqual(16);
    expect(position.x + 360).toBeLessThanOrEqual(1084);
    expect(position.arrowOffset).toBeGreaterThanOrEqual(24);
  });
});
