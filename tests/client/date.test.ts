import { describe, expect, it } from "vitest";

import { addDays, inclusiveDays, projectDateRange } from "../../src/lib/date.js";

describe("timeline date helpers", () => {
  it("builds an inclusive sequence without timezone drift", () => {
    expect(inclusiveDays("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("uses all dated entities and adds a readable project margin", () => {
    expect(
      projectDateRange(
        ["2026-07-10", null, "2026-08-20"],
        "2026-07-18",
      ),
    ).toEqual({ start: "2026-07-03", end: "2026-08-27" });
  });
});
