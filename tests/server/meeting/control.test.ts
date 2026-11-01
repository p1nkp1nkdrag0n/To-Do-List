/**
 * 暂停开关的单测：只有暂停状态才会真的等待。
 */
import { describe, expect, it } from "vitest";

import { MeetingControl } from "../../../server/meeting/control.js";

describe("MeetingControl", () => {
  it("默认不暂停，waitIfPaused 立刻返回", async () => {
    const control = new MeetingControl();
    expect(control.isPaused).toBe(false);
    await expect(control.waitIfPaused()).resolves.toBeUndefined();
  });

  it("暂停后会停住，resume 之后才继续", async () => {
    const control = new MeetingControl();
    control.pause();
    expect(control.isPaused).toBe(true);

    let resumed = false;
    const waiting = control.waitIfPaused().then(() => {
      resumed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumed).toBe(false);

    control.resume();
    await waiting;
    expect(resumed).toBe(true);
    expect(control.isPaused).toBe(false);
  });

  it("resume 会把所有等待者一起放行", async () => {
    const control = new MeetingControl();
    control.pause();
    let count = 0;
    const waiters = [
      control.waitIfPaused().then(() => (count += 1)),
      control.waitIfPaused().then(() => (count += 1)),
      control.waitIfPaused().then(() => (count += 1)),
    ];
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(count).toBe(0);
    control.resume();
    await Promise.all(waiters);
    expect(count).toBe(3);
  });

  it("重复 pause 不会叠加状态", () => {
    const control = new MeetingControl();
    control.pause();
    control.pause();
    control.resume();
    expect(control.isPaused).toBe(false);
  });
});
