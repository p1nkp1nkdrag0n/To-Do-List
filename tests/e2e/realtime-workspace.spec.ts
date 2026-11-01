import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const HARNESS = "/tests/e2e/realtime-workspace-harness.html";
const MINUTES = "合成会议记录：确认甲、乙、丙的工作安排。";

type Draft = {
  title: string;
  ownerName: string;
  estimatedHours: number;
  dueDate: string | null;
  dependsOnTitle?: string | null;
};

type SubmittedTask = {
  clientTaskId: string;
  title: string;
  ownerUserId: string | null;
  predecessorClientTaskIds: string[];
};

type FinishCall = { text: string; tasks: SubmittedTask[]; scheduleRevision: number };

const initialTasks: Draft[] = [
  { title: "甲", ownerName: "张同学", estimatedHours: 2, dueDate: null },
  { title: "乙", ownerName: "李同学", estimatedHours: 3, dueDate: null },
  { title: "丙", ownerName: "未分配", estimatedHours: 1, dueDate: null, dependsOnTitle: "甲" },
];

function row(page: Page, index: number): Locator {
  return page.locator(".realtime-review-item").nth(index);
}

function title(rowLocator: Locator): Locator {
  return rowLocator.locator(".realtime-review-title");
}

async function calls(page: Page): Promise<FinishCall[]> {
  return page.evaluate(() => (globalThis as unknown as { __meetingTest: { finishCalls: FinishCall[] } }).__meetingTest.finishCalls);
}

async function submit(page: Page): Promise<FinishCall> {
  const previous = (await calls(page)).length;
  await page.getByRole("button", { name: "确认并生成排期" }).click();
  await expect.poll(async () => (await calls(page)).length).toBe(previous + 1);
  await expect(page.getByText("提交失败，任务清单与编辑内容已保留，可直接重试。")).toBeVisible();
  return (await calls(page))[previous]!;
}

async function selectedValue(select: Locator, text: string): Promise<string> {
  const option = select.locator("option").filter({ hasText: text });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value).toBeTruthy();
  return value!;
}

async function openWorkspace(
  page: Page,
  tasks: Draft[] = initialTasks,
  waitForFinalCorrection?: Promise<void>,
  onFinalCorrection?: () => void,
  meetingView = false,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.route("**/api/meeting/correct", async (route) => {
    const body = route.request().postDataJSON() as { text: string; hotwords?: unknown };
    if (body.hotwords === undefined) {
      onFinalCorrection?.();
      if (waitForFinalCorrection) await waitForFinalCorrection;
    }
    await route.fulfill({ json: { text: body.text } });
  });
  await page.route("**/api/meeting/draft", async (route) => {
    await route.fulfill({ json: { tasks, scheduleRevision: 42 } });
  });
  if (meetingView) {
    await page.route("**/api/meeting/status?*", async (route) => route.fulfill({ json: { undoAvailable: false } }));
    await page.route("**/api/meeting/summary", async (route) => route.fulfill({ json: { title: "合成纪要" } }));
  }
  const target = meetingView ? `${HARNESS}?view=meeting` : HARNESS;
  await page.goto(target);
  await expect(page).toHaveURL(`http://127.0.0.1:5173${target}`);
  await expect(page).toHaveTitle("Realtime workspace harness");
  if (meetingView) {
    await expect(page.getByText("会议处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "实时记录", exact: true }).first().click();
  }
  await expect(page.getByText("实时会议", { exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "开始实时记录" }).click();
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.evaluate((text) => (globalThis as unknown as { __meetingTest: { emitFinal: (value: string) => void } }).__meetingTest.emitFinal(text), MINUTES);
  await expect(page.getByText(MINUTES, { exact: true })).toBeVisible();
  return { errors, warnings };
}

async function makeReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "结束并生成排期" }).click();
  await expect(page.getByText("确认任务清单", { exact: true })).toBeVisible();
}

async function evidence(page: Page, name: string): Promise<void> {
  const dir = process.env.TODO_REVIEW_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name), fullPage: false });
}

async function expectReadableHeader(page: Page): Promise<void> {
  const back = await page.getByRole("button", { name: "返回会议" }).boundingBox();
  const heading = await page.locator(".realtime-review-head strong").boundingBox();
  expect(back).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(back!.width).toBeGreaterThan(40);
  expect(back!.height).toBeLessThan(30);
  expect(heading!.height).toBeLessThan(30);
}

test("同名后改名和真实前驱改名都保留原有依赖 ID", async ({ page }) => {
  const consoleState = await openWorkspace(page);
  await makeReview(page);
  await expect(row(page, 2)).toContainText("依赖：甲");
  await title(row(page, 1)).fill("甲");
  await expect(row(page, 2)).toContainText("依赖：甲");
  await title(row(page, 1)).fill("丁");
  await expect(row(page, 2)).toContainText("依赖：甲");
  await title(row(page, 0)).fill("戊");
  await expect(row(page, 2)).toContainText("依赖：戊");
  await expectReadableHeader(page);
  await evidence(page, "review-desktop.png");

  const result = await submit(page);
  expect(result.text).toBe(MINUTES);
  expect(result.scheduleRevision).toBe(42);
  expect(result.tasks.map((task) => task.title)).toEqual(["戊", "丁", "丙"]);
  expect(result.tasks[0]!.ownerUserId).toBe("member-a");
  expect(result.tasks[2]!.predecessorClientTaskIds).toEqual([result.tasks[0]!.clientTaskId]);
  expect(consoleState.errors).toEqual([]);
});

test("删除同名的其他任务不影响依赖，删除真实前驱才清除", async ({ page }) => {
  await openWorkspace(page);
  await makeReview(page);
  await title(row(page, 1)).fill("甲");
  await row(page, 1).getByRole("button", { name: "删除", exact: true }).click();
  await expect(row(page, 1)).toContainText("依赖：甲");
  const before = await submit(page);
  expect(before.tasks[1]!.predecessorClientTaskIds).toEqual([before.tasks[0]!.clientTaskId]);
  await row(page, 0).getByRole("button", { name: "删除", exact: true }).click();
  await expect(row(page, 0)).toContainText("无依赖");
  const after = await submit(page);
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0]!.title).toBe("丙");
  expect(after.tasks[0]!.predecessorClientTaskIds).toEqual([]);
});

test("多前驱可以追加并逐项移除，提交引用各自的任务 ID", async ({ page }) => {
  await openWorkspace(page);
  await makeReview(page);
  const successor = row(page, 2);
  const add = successor.locator(".realtime-review-dependency-select");
  await add.selectOption(await selectedValue(add, "乙"));
  await expect(successor.locator(".realtime-review-dependency-chip")).toHaveCount(2);
  const both = await submit(page);
  expect(both.tasks[2]!.predecessorClientTaskIds).toEqual([
    both.tasks[0]!.clientTaskId,
    both.tasks[1]!.clientTaskId,
  ]);
  await successor.locator(".realtime-review-dependency-chip").filter({ hasText: "甲" })
    .getByRole("button", { name: "移除" }).click();
  await expect(successor).not.toContainText("依赖：甲");
  await expect(successor).toContainText("依赖：乙");
  const one = await submit(page);
  expect(one.tasks[2]!.predecessorClientTaskIds).toEqual([one.tasks[1]!.clientTaskId]);
  await successor.locator(".realtime-review-dependency-chip").filter({ hasText: "乙" })
    .getByRole("button", { name: "移除" }).click();
  await expect(successor).toContainText("无依赖");
  const none = await submit(page);
  expect(none.tasks[2]!.predecessorClientTaskIds).toEqual([]);
});

test("初始同名依赖必须由用户选择具体任务后才能提交", async ({ page }) => {
  await openWorkspace(page, [initialTasks[0]!, { ...initialTasks[1]!, title: "甲" }, initialTasks[2]!]);
  await makeReview(page);
  const confirm = page.getByRole("button", { name: "确认并生成排期" });
  await expect(confirm).toBeDisabled();
  await expect(row(page, 2)).toContainText("待确认依赖：甲");
  const select = row(page, 2).getByLabel("确认「丙」的依赖「甲」");
  await expect(select.locator("option")).toHaveText(["选择具体前驱…", "任务 1：甲", "任务 2：甲"]);
  const secondId = await select.locator("option").nth(2).getAttribute("value");
  expect(secondId).toBeTruthy();
  await select.selectOption(secondId!);
  await expect(confirm).toBeEnabled();
  await expect(row(page, 2)).toContainText("依赖：甲");
  const result = await submit(page);
  expect(result.tasks[0]!.clientTaskId).not.toBe(result.tasks[1]!.clientTaskId);
  expect(result.tasks[2]!.predecessorClientTaskIds).toEqual([result.tasks[1]!.clientTaskId]);
  expect(result.tasks[2]!.predecessorClientTaskIds).toEqual([secondId]);
});

test("未找到的初始依赖阻止提交，移除后可继续", async ({ page }) => {
  await openWorkspace(page, [initialTasks[0]!, initialTasks[1]!, { ...initialTasks[2]!, dependsOnTitle: "不存在的任务" }]);
  await makeReview(page);
  const confirm = page.getByRole("button", { name: "确认并生成排期" });
  await expect(confirm).toBeDisabled();
  const unresolved = row(page, 2).locator(".realtime-review-dependency-chip").filter({ hasText: "待确认依赖：不存在的任务" });
  await expect(unresolved).toBeVisible();
  await unresolved.getByRole("button", { name: "移除" }).click();
  await expect(confirm).toBeEnabled();
  const result = await submit(page);
  expect(result.tasks[2]!.predecessorClientTaskIds).toEqual([]);
});

test("没有识别到任务时保留原会议内容，不提交空清单", async ({ page }) => {
  await openWorkspace(page, []);
  await page.getByRole("button", { name: "结束并生成排期" }).click();
  await expect(page.getByRole("alert")).toContainText("没有识别到任务，原排期未更改");
  await expect(page.getByText(MINUTES, { exact: true })).toBeVisible();
  expect(await calls(page)).toHaveLength(0);
});

test("任务抽取请求等待期间继续锁定重录、返回和再次生成", async ({ page }) => {
  await openWorkspace(page);
  let releaseDraft!: () => void;
  let draftCount = 0;
  const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
  await page.route("**/api/meeting/draft", async (route) => {
    draftCount += 1;
    await draftGate;
    await route.fulfill({ json: { tasks: initialTasks, scheduleRevision: 42 } });
  });
  await page.getByRole("button", { name: "结束并生成排期" }).click();
  await expect.poll(() => draftCount).toBe(1);
  await expect(page.getByRole("button", { name: "开始实时记录" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回会议" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束并生成排期" })).toBeDisabled();
  expect(await calls(page)).toHaveLength(0);
  releaseDraft();
  await expect(page.getByText("确认任务清单", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as { __meetingTest: { exitCount: number } }).__meetingTest.exitCount)).toBe(0);
});

test("MeetingView 请求失败保留编辑并重试，成功后关闭确认清单", async ({ page }) => {
  const runBodies: Array<{ projectId: string; minutes: string; expectedScheduleRevision: number; tasks: SubmittedTask[] }> = [];
  await page.route("**/api/meeting/run", async (route) => {
    runBodies.push(route.request().postDataJSON() as typeof runBodies[number]);
    if (runBodies.length === 1) {
      await route.fulfill({ status: 409, json: { error: { code: "SYNTHETIC_CONFLICT", message: "合成失败，请重试。" } } });
      return;
    }
    await route.fulfill({ json: {
      projectId: "synthetic-project", conflictsBefore: 0, conflictsAfter: 0,
      appliedPlanId: null, undoAvailable: false, durationMs: 1, events: [],
    } });
  });
  const consoleState = await openWorkspace(page, initialTasks, undefined, undefined, true);
  await makeReview(page);
  await title(row(page, 1)).fill("已确认乙");
  await expectReadableHeader(page);
  await evidence(page, "meeting-view-desktop.png");
  await page.getByRole("button", { name: "确认并生成排期" }).click();
  await expect(page.getByText("提交失败，任务清单与编辑内容已保留，可直接重试。")).toBeVisible();
  await expect(title(row(page, 1))).toHaveValue("已确认乙");
  await expect(row(page, 2)).toContainText("依赖：甲");
  await expect.poll(() => runBodies.length).toBe(1);
  await page.getByRole("button", { name: "确认并生成排期" }).click();
  await expect(page.getByText("确认任务清单", { exact: true })).toHaveCount(0);
  await expect(page.getByText("会议处理", { exact: true })).toBeVisible();
  await expect.poll(() => runBodies.length).toBe(2);
  expect(runBodies[0]).toEqual(runBodies[1]);
  const runBody = runBodies[1]!;
  expect(runBody.projectId).toBe("synthetic-project");
  expect(runBody.minutes).toBe(MINUTES);
  expect(runBody.expectedScheduleRevision).toBe(42);
  expect(runBody.tasks.map((task) => task.title)).toEqual(["甲", "已确认乙", "丙"]);
  expect(runBody.tasks[2]!.predecessorClientTaskIds).toEqual([runBody.tasks[0]!.clientTaskId]);
  // Chromium logs the intentionally returned 409; every other console error is unexpected.
  expect(consoleState.errors.filter((error) => !error.includes("409 (Conflict)"))).toEqual([]);
  // Existing recorder uses ScriptProcessorNode; Chromium emits this deprecation warning.
  expect(consoleState.warnings.filter((warning) => !warning.includes("ScriptProcessorNode is deprecated"))).toEqual([]);
});

test("生成或提交中锁定操作，提交失败后保留编辑内容并可重试", async ({ page }) => {
  let releaseCorrection!: () => void;
  let finalCorrectionCount = 0;
  const correctionGate = new Promise<void>((resolve) => { releaseCorrection = resolve; });
  await openWorkspace(page, initialTasks, correctionGate, () => { finalCorrectionCount += 1; });
  await page.getByRole("button", { name: "结束并生成排期" }).click();
  await expect.poll(() => finalCorrectionCount).toBe(1);
  await expect(page.getByRole("button", { name: "开始实时记录" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回会议" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束并生成排期" })).toBeDisabled();
  releaseCorrection();
  await expect(page.getByText("确认任务清单", { exact: true })).toBeVisible();
  await title(row(page, 1)).fill("已编辑乙");
  await page.evaluate(() => { (globalThis as unknown as { __meetingTest: { finishMode: string } }).__meetingTest.finishMode = "pending"; });
  await page.getByRole("button", { name: "确认并生成排期" }).click();
  await expect(page.getByRole("button", { name: "正在生成…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "开始实时记录" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回会议" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回查看字幕" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "结束并生成排期" })).toHaveCount(0);
  await expect(title(row(page, 1))).toBeDisabled();
  await expect(row(page, 1).getByRole("button", { name: "删除" })).toBeDisabled();
  await expect(row(page, 2).locator(".realtime-review-dependency-select")).toBeDisabled();
  await page.evaluate(() => (globalThis as unknown as { __meetingTest: { resolveFinish: ((value: boolean) => void) | null } }).__meetingTest.resolveFinish?.(false));
  await expect(page.getByText("提交失败，任务清单与编辑内容已保留，可直接重试。")).toBeVisible();
  await expect(title(row(page, 1))).toHaveValue("已编辑乙");
  await expect(row(page, 2)).toContainText("依赖：甲");
  await page.evaluate(() => { (globalThis as unknown as { __meetingTest: { finishMode: string } }).__meetingTest.finishMode = "failure"; });
  const retried = await submit(page);
  expect(retried.tasks[1]!.title).toBe("已编辑乙");
  expect(retried.tasks[2]!.predecessorClientTaskIds).toEqual([retried.tasks[0]!.clientTaskId]);
  expect(await page.evaluate(() => (globalThis as unknown as { __meetingTest: { exitCount: number } }).__meetingTest.exitCount)).toBe(0);
  expect(finalCorrectionCount).toBe(1);
});

test("窄屏可查看并编辑真实确认清单", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const consoleState = await openWorkspace(page);
  await makeReview(page);
  await expect(title(row(page, 0))).toBeVisible();
  await title(row(page, 1)).fill("窄屏修改");
  await expect(title(row(page, 1))).toHaveValue("窄屏修改");
  await expectReadableHeader(page);
  const titleBox = await title(row(page, 1)).boundingBox();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.width).toBeGreaterThan(250);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await evidence(page, "review-mobile.png");
  const result = await submit(page);
  expect(result.tasks[1]!.title).toBe("窄屏修改");
  expect(result.tasks[2]!.predecessorClientTaskIds).toEqual([result.tasks[0]!.clientTaskId]);
  expect(consoleState.errors).toEqual([]);
});
