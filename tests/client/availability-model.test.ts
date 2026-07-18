import { describe, expect, it } from "vitest";

import { toggleHalfHourSlot } from "../../src/features/availability/availability-model.js";

describe("availability slot editing", () => {
  it("merges adjacent half-hour cells into one weekly interval", () => {
    let slots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }> = [];
    slots = toggleHalfHourSlot(slots, 1, 540);
    slots = toggleHalfHourSlot(slots, 1, 570);
    expect(slots).toEqual([{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }]);
  });

  it("splits an interval when a selected cell is removed", () => {
    expect(
      toggleHalfHourSlot(
        [{ dayOfWeek: 3, startMinute: 540, endMinute: 630 }],
        3,
        570,
      ),
    ).toEqual([
      { dayOfWeek: 3, startMinute: 540, endMinute: 570 },
      { dayOfWeek: 3, startMinute: 600, endMinute: 630 },
    ]);
  });
});
