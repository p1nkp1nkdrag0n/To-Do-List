import { describe, expect, it } from "vitest";

import { requireNumberField, requireToolOk } from "../../../server/meeting/tool-result.js";

describe("MCP 工具结果校验", () => {
  it("工具失败时抛出可读错误", () => {
    expect(() =>
      requireToolOk({ ok: false, payload: {}, summary: "没有权限" }, "check_conflicts"),
    ).toThrow(/check_conflicts 失败：没有权限/);
  });

  it("缺少 count 时不再当成 0", () => {
    expect(() =>
      requireNumberField({ ok: true, payload: {}, summary: "" }, "count", "check_conflicts"),
    ).toThrow(/缺少 count/);
  });

  it("count 不是数字时拒绝", () => {
    expect(() =>
      requireNumberField({ ok: true, payload: { count: "0" }, summary: "" }, "count", "check_conflicts"),
    ).toThrow(/缺少 count/);
  });

  it("合法结果返回数字", () => {
    expect(
      requireNumberField({ ok: true, payload: { count: 3 }, summary: "" }, "count", "check_conflicts"),
    ).toBe(3);
  });
});
