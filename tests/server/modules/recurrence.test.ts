import { describe, expect, it } from "vitest";

import {
  enumerateOccurrences,
  firstOccurrenceOnOrAfter,
  nextOccurrenceAfter,
} from "../../../server/modules/schedule/recurrence.js";

describe("recurrence date arithmetic", () => {
  it("finds and advances deterministic weekly occurrences", () => {
    const rule = {
      frequency: "weekly" as const,
      intervalCount: 2,
      dayOfWeek: 1,
    };

    expect(firstOccurrenceOnOrAfter("2026-07-17", rule)).toBe("2026-07-20");
    expect(nextOccurrenceAfter("2026-07-20", rule)).toBe("2026-08-03");
    expect(
      enumerateOccurrences(
        { ...rule, nextOccurrenceOn: "2026-07-20", endsOn: null },
        "2026-08-20",
      ),
    ).toEqual({
      dates: ["2026-07-20", "2026-08-03", "2026-08-17"],
      nextOccurrenceOn: "2026-08-31",
      exhausted: false,
    });
  });

  it("clamps monthly days 29 through 31 without drifting after February", () => {
    for (const [dayOfMonth, expected] of [
      [29, ["2027-01-29", "2027-02-28", "2027-03-29"]],
      [30, ["2027-01-30", "2027-02-28", "2027-03-30"]],
      [31, ["2027-01-31", "2027-02-28", "2027-03-31"]],
    ] as const) {
      const rule = {
        frequency: "monthly" as const,
        intervalCount: 1,
        dayOfMonth,
        nextOccurrenceOn: `2027-01-${dayOfMonth}`,
        endsOn: null,
      };
      expect(enumerateOccurrences(rule, "2027-03-31").dates).toEqual(expected);
    }
  });

  it("uses leap-day clamping and honors an inclusive end date", () => {
    const rule = {
      frequency: "monthly" as const,
      intervalCount: 1,
      dayOfMonth: 31,
      nextOccurrenceOn: "2028-01-31",
      endsOn: "2028-02-29",
    };

    expect(enumerateOccurrences(rule, "2028-12-31")).toEqual({
      dates: ["2028-01-31", "2028-02-29"],
      nextOccurrenceOn: "2028-03-31",
      exhausted: true,
    });
  });

  it("caps generation before a runaway request", () => {
    expect(() =>
      enumerateOccurrences(
        {
          frequency: "weekly",
          intervalCount: 1,
          dayOfWeek: 1,
          nextOccurrenceOn: "2026-01-05",
          endsOn: null,
        },
        "2028-01-01",
        10,
      ),
    ).toThrow(/limit of 10/i);
  });
});
