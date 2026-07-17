import { describe, expect, it } from "vitest";

import { parseCookieHeader } from "../../../server/http/cookies.js";

describe("cookie parsing", () => {
  it("parses encoded values, embedded equals signs, and whitespace", () => {
    expect(
      parseCookieHeader(" first = hello%20world ; token=a=b=c; empty= "),
    ).toEqual({ first: "hello world", token: "a=b=c", empty: "" });
  });

  it("ignores malformed components and keeps the first duplicate", () => {
    expect(parseCookieHeader("broken; token=first; token=second; bad=%E0%A4%A")).toEqual({
      token: "first",
    });
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});
