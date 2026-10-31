import { expect, test } from "@playwright/test";

const HARNESS = "/tests/e2e/realtime-harness.html";

async function openHarness(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(HARNESS);
  await expect(page.locator("#start")).toBeVisible();
}

async function socketStates(page: import("@playwright/test").Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = globalThis as unknown as { __rtSockets: Array<{ readyState: number }> };
    return state.__rtSockets.map((socket) => socket.readyState);
  });
}

test("正常停止：300ms 内仍为打开，计时器到点后关闭", async ({ page }) => {
  await openHarness(page);
  await page.click("#start");
  await page.waitForTimeout(120);
  await page.click("#stop");
  await page.waitForTimeout(80);
  expect(await socketStates(page)).toEqual([1]);
  await page.waitForTimeout(350);
  expect(await socketStates(page)).toEqual([3]);
});

test("连续停止：上一轮 pending 不被覆盖，最终关闭", async ({ page }) => {
  await openHarness(page);
  await page.click("#start");
  await page.waitForTimeout(120);
  await page.click("#stop");
  await page.click("#stop");
  await page.waitForTimeout(400);
  expect(await socketStates(page)).toEqual([3]);
});

test("停止后立即卸载：活动与待关闭连接都关闭", async ({ page }) => {
  await openHarness(page);
  await page.click("#start");
  await page.waitForTimeout(120);
  await page.click("#stop");
  await page.click("#unmount");
  await page.waitForTimeout(400);
  expect(await socketStates(page)).toEqual([3]);
});

test("停止后立即重启：旧连接关闭，新连接不被旧计时器误关", async ({ page }) => {
  await openHarness(page);
  await page.click("#start");
  await page.waitForTimeout(120);
  await page.click("#stop");
  await page.click("#start");
  await page.waitForTimeout(400);
  expect(await socketStates(page)).toEqual([3, 1]);
});

test("迟到授权：停止发生在 getUserMedia 返回前，流被就地停止且不建连接", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => {
    (globalThis as unknown as { __rtDelay: number }).__rtDelay = 300;
  });
  await page.click("#start");
  await page.waitForTimeout(50);
  await page.click("#stop");
  await page.waitForTimeout(500);
  expect(await socketStates(page)).toEqual([]);
  const ended = await page.evaluate(() => {
    const state = globalThis as unknown as { __rtTracks: Array<{ readyState: string }> };
    return state.__rtTracks.length > 0 && state.__rtTracks.every((track) => track.readyState === "ended");
  });
  expect(ended).toBe(true);
});
