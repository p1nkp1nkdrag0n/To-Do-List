import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const leader = {
  username: "e2e_leader",
  displayName: "林队长",
  password: "password-123",
};

const member = {
  username: "e2e_member",
  displayName: "周同学",
  password: "password-123",
};

async function register(
  page: Page,
  account: typeof leader,
  code: string,
  bootstrap = false,
): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".ascii-flow-canvas")).toBeVisible();
  const authPanel = page.locator(".auth-panel");
  await expect(authPanel).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Playwright viewport is required for auth alignment checks.");
  const panelPosition = await authPanel.evaluate((element, size) => {
    const rect = element.getBoundingClientRect();
    return {
      horizontalOffset: Math.abs(rect.left + rect.width / 2 - size.width / 2),
      verticalOffset: Math.abs(rect.top + rect.height / 2 - size.height / 2),
    };
  }, viewport);
  expect(panelPosition.horizontalOffset).toBeLessThan(2);
  expect(panelPosition.verticalOffset).toBeLessThan(2);
  await page.getByRole("tab", { name: "注册账号" }).click();
  await page.getByLabel("显示名称").fill(account.displayName);
  await page.getByLabel("用户名").fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByLabel("注册邀请码或初始化码").fill(code);
  if (bootstrap) {
    await page.getByLabel("这是首次部署的初始化码").check();
  }
  await page.getByRole("button", { name: "注册并登录" }).click();
}

async function projectId(context: BrowserContext): Promise<string> {
  const response = await context.request.get("/api/projects");
  expect(response.ok()).toBe(true);
  const body = await response.json() as { projects: Array<{ id: string }> };
  return body.projects[0]!.id;
}

test("two-person research workflow covers scheduling, collaboration, resources, and review", async ({ browser, page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await register(page, leader, "e2e-bootstrap-code", true);
  await expect(page.getByRole("heading", { name: "创建第一个项目" })).toBeVisible();
  const setupTour = page.locator('[data-tour-section="project-setup"]');
  await expect(setupTour).toBeVisible();
  await expect(setupTour).toContainText("第 1 步，共 1 步");
  await expect(page.locator('[data-tour-id="empty-create-project"]')).toHaveAttribute("data-tour-id", "empty-create-project");
  await setupTour.getByRole("button", { name: "开始创建" }).click();
  const projectDialog = page.getByRole("dialog", { name: "新建项目" });
  await projectDialog.getByLabel("项目名称").fill("全国大学生创新训练项目");
  await projectDialog.getByLabel("开始日期").fill("2026-07-20");
  await projectDialog.getByLabel("结束日期").fill("2026-12-20");
  await projectDialog.getByLabel("项目说明").fill("复现实验、论文撰写与答辩材料排期");
  await projectDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("1 名成员")).toBeVisible();
  const workspaceTour = page.locator('[data-tour-section="workspace"]');
  await expect(workspaceTour).toBeVisible();
  await expect(workspaceTour).toContainText("第 1 步，共 7 步");
  await expect(page.locator('[data-testid="tour-target-shield"]')).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await workspaceTour.getByRole("button", { name: "下一步" }).click();
  await expect(workspaceTour.getByRole("heading", { name: "邀请项目成员" })).toBeVisible();
  await workspaceTour.getByRole("button", { name: "上一步" }).click();
  await expect(workspaceTour.getByRole("heading", { name: "切换当前项目" })).toBeVisible();
  await workspaceTour.getByRole("button", { name: "跳过本段" }).click();
  await expect(workspaceTour).toBeHidden();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  const activeProjectId = await projectId(page.context());

  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("todo-list.theme.v1"))).toBe("light");

  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.locator(".sidebar")).toHaveCSS("width", "68px");
  expect(await page.evaluate(() => localStorage.getItem("todo-list.sidebar.v1"))).toBe("collapsed");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await page.waitForTimeout(700);
  await expect(page.locator(".tour-bubble")).toHaveCount(0);
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();

  await page.getByRole("button", { name: "邀请", exact: true }).click();
  const inviteDialog = page.getByRole("dialog", { name: "邀请项目成员" });
  await inviteDialog.getByRole("button", { name: "生成六位邀请码" }).click();
  const inviteCode = await inviteDialog.locator(".invite-code strong").innerText();
  expect(inviteCode).toMatch(/^\d{6}$/);
  await inviteDialog.getByRole("button", { name: "关闭" }).click();

  const registrationInviteResponse = await page.context().request.post(
    "/api/team/registration-invites",
    { data: {} },
  );
  expect(registrationInviteResponse.ok()).toBe(true);
  const registrationInvite = await registrationInviteResponse.json() as {
    invite: { code: string };
  };

  const memberContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
  });
  const memberPage = await memberContext.newPage();
  memberPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    await register(memberPage, member, registrationInvite.invite.code);
    await expect(memberPage.getByRole("heading", { name: `${member.displayName}，加入你的项目` })).toBeVisible();
    await memberPage.getByLabel("六位项目邀请码").fill(inviteCode);
    await memberPage.getByRole("button", { name: "加入团队与项目" }).click();
    await expect(memberPage.locator(".topbar-project strong")).toHaveText("全国大学生创新训练项目");
    const memberWorkspaceTour = memberPage.locator('[data-tour-section="workspace"]');
    await expect(memberWorkspaceTour).toBeVisible();
    await memberWorkspaceTour.getByRole("button", { name: "跳过本段" }).click();
    await expect(page.getByText("2 名成员")).toBeVisible();

    await memberPage.getByRole("button", { name: "可用时间" }).click();
    await expect(memberPage.getByRole("heading", { name: "我的可用时间" })).toBeVisible();
    const availabilityTour = memberPage.locator('[data-tour-section="availability"]');
    await expect(availabilityTour).toBeVisible();
    await expect(availabilityTour).toContainText("第 1 步，共 4 步");
    await availabilityTour.getByRole("button", { name: "稍后再看" }).click();
    await memberPage.reload();
    await memberPage.waitForTimeout(700);
    await expect(memberPage.locator(".tour-bubble")).toHaveCount(0);
    await memberPage.evaluate(() => sessionStorage.clear());
    await memberPage.reload();
    await memberPage.getByRole("button", { name: "可用时间" }).click();
    await expect(availabilityTour).toBeVisible();
    await availabilityTour.getByRole("button", { name: "跳过本段" }).click();
    await memberPage.getByRole("button", { name: "添加学期" }).last().click();
    await memberPage.getByLabel("每周投入上限（小时）").fill("0.5");
    await expect(memberPage.getByRole("button", { name: "减少每周投入上限" })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "增加每周投入上限" })).toBeVisible();
    await memberPage.getByRole("button", { name: "周一 09:00 不可用" }).click();
    const saveAvailability = memberPage.getByRole("button", { name: "保存更改" });
    await saveAvailability.click();
    await expect(saveAvailability).toBeDisabled();

    await page.getByRole("button", { name: "甘特图" }).click();
    await page.getByRole("button", { name: "添加任务" }).click();
    const newTaskDrawer = page.getByLabel("新建任务");
    await newTaskDrawer.getByLabel("任务名称").fill("模型复现实验");
    await newTaskDrawer.getByLabel("开始日期").fill("2026-07-20");
    await newTaskDrawer.getByLabel("截止日期").fill("2026-07-21");
    await newTaskDrawer.getByLabel("任务说明").fill("完成基线训练并整理实验记录。");
    await newTaskDrawer.getByRole("button", { name: "创建任务" }).click();
    const taskRow = page.locator(".gantt-meta-row.row-task").filter({ hasText: "模型复现实验" });
    await expect(taskRow).toBeVisible();
    await taskRow.click();
    const taskDrawer = page.getByLabel("任务详情：模型复现实验");
    const toolbarLayout = await page.locator(".gantt-toolbar").evaluate((toolbar) => {
      const segmentedWidth = toolbar.querySelector(".segmented-control")?.getBoundingClientRect().width ?? 0;
      const controls = [...toolbar.querySelectorAll("button")]
        .map((button) => button.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      let overlaps = 0;
      for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
          const left = controls[leftIndex]!;
          const right = controls[rightIndex]!;
          if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
            overlaps += 1;
          }
        }
      }
      return { segmentedWidth, overlaps };
    });
    expect(toolbarLayout.segmentedWidth).toBeGreaterThan(100);
    expect(toolbarLayout.overlaps).toBe(0);
    await taskDrawer.getByRole("button", { name: "责任分工" }).click();
    await taskDrawer.getByLabel("负责人").selectOption({ label: member.displayName });
    await taskDrawer.getByLabel("预计工时（小时）").fill("20");
    await taskDrawer.getByRole("button", { name: "添加分工" }).click();
    await expect(taskDrawer.getByText(`${member.displayName}`, { exact: true })).toBeVisible();
    await taskDrawer.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.locator(".conflict-summary")).toContainText("冲突");
    await expect(page.locator(".conflict-summary")).toHaveAttribute("role", "status");

    await memberPage.getByRole("button", { name: "甘特图" }).click();
    await expect(page.getByText("2 人在线")).toBeVisible();
    const leaderBar = page.locator(".timeline-bar.bar-participant").first();
    const memberBar = memberPage.locator(".timeline-bar.bar-participant").first();
    await expect(leaderBar).toBeVisible();
    await expect(memberBar).toBeVisible();
    const leaderBox = await leaderBar.boundingBox();
    expect(leaderBox).not.toBeNull();
    await page.mouse.move(leaderBox!.x + leaderBox!.width / 2, leaderBox!.y + leaderBox!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(180);
    await page.mouse.move(leaderBox!.x + leaderBox!.width / 2 + 36, leaderBox!.y + leaderBox!.height / 2, { steps: 4 });
    await expect(memberPage.locator(".timeline-drag-preview")).toBeVisible();
    await expect(memberBar).toHaveClass(/locked/);
    await expect(memberBar).toHaveAttribute("title", new RegExp(`${leader.displayName}.*正在调整`));
    await page.mouse.up();
    await expect(memberPage.locator(".timeline-drag-preview")).toBeHidden();

    await expect.poll(async () => {
      const response = await page.context().request.get(`/api/projects/${activeProjectId}/schedule`);
      const schedule = await response.json() as { participants: Array<{ startDate: string }> };
      return schedule.participants[0]?.startDate;
    }).toBe("2026-07-21");

    await page.getByRole("button", { name: "资料库" }).click();
    const resourcesTour = page.locator('[data-tour-section="resources"]');
    await expect(resourcesTour).toBeVisible();
    await expect(resourcesTour).toContainText("第 1 步，共 3 步");
    await resourcesTour.getByRole("button", { name: "跳过本段" }).click();
    await page.getByRole("button", { name: "上传文件" }).click();
    const resourceDialog = page.getByRole("dialog", { name: "上传文件" });
    await resourceDialog.getByLabel("资料名称").fill("实验报告.pdf");
    await resourceDialog.locator('input[type="file"]').setInputFiles({
      name: "experiment-report-v1.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("research report version one"),
    });
    await resourceDialog.getByLabel("版本说明").fill("基线实验初稿");
    await resourceDialog.getByRole("button", { name: "创建资料" }).click();
    const resourceDrawer = page.locator(".resource-drawer");
    await expect(resourceDrawer.getByRole("heading", { name: "实验报告.pdf" })).toBeVisible();
    await expect(resourceDrawer.getByRole("button", { name: "关闭资料详情" })).toBeVisible();
    await resourceDrawer.getByRole("button", { name: "添加版本" }).click();
    const versionDialog = page.getByRole("dialog", { name: "添加 实验报告.pdf 的新版本" });
    await versionDialog.locator('input[type="file"]').setInputFiles({
      name: "experiment-report-v2.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("research report version two with results"),
    });
    await versionDialog.getByLabel("版本说明").fill("补充消融实验");
    await versionDialog.getByRole("button", { name: "添加版本" }).click();
    await expect(resourceDrawer.getByText("2 个版本")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await resourceDrawer.locator(".version-history article").filter({ hasText: "v1" }).getByTitle("恢复为新版本").click();
    await expect(resourceDrawer.getByText("3 个版本")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await resourceDrawer.getByRole("button", { name: "移至回收站" }).click();
    await expect(resourceDrawer).toBeHidden();
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    await expect(page.getByRole("heading", { name: "资料回收站" })).toBeVisible();
    await page.locator(".resource-table-row").filter({ hasText: "实验报告.pdf" }).click();
    await page.locator(".resource-drawer").getByRole("button", { name: "恢复", exact: true }).click();
    await expect(page.getByText("回收站为空", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回资料库" }).click();
    await expect(page.locator(".resource-table-row").filter({ hasText: "实验报告.pdf" })).toBeVisible();

    await page.getByRole("button", { name: "甘特图" }).click();
    await page.locator(".gantt-meta-row.row-task").filter({ hasText: "模型复现实验" }).click();
    const reviewDrawer = page.getByLabel("任务详情：模型复现实验");
    await reviewDrawer.getByRole("button", { name: "交付物" }).click();
    await reviewDrawer.getByPlaceholder("新增交付要求").fill("实验报告");
    await reviewDrawer.locator(".inline-add").getByRole("button", { name: "添加" }).click();
    const resourceOption = reviewDrawer.locator(".fulfill-controls option").filter({ hasText: "实验报告.pdf" });
    const resourceId = await resourceOption.getAttribute("value");
    expect(resourceId).not.toBeNull();
    await reviewDrawer.locator(".fulfill-controls select").selectOption(resourceId!);
    await reviewDrawer.locator(".fulfill-controls").getByRole("button", { name: "绑定" }).click();
    await expect(reviewDrawer.getByText("已绑定资料版本")).toBeVisible();

    await reviewDrawer.getByRole("button", { name: "进展记录" }).click();
    await reviewDrawer.locator('input[type="range"]').fill("100");
    await reviewDrawer.getByLabel("进展说明").fill("完成复现，指标达到预期。");
    await reviewDrawer.getByLabel("下一步").fill("整理答辩图表。");
    await reviewDrawer.getByRole("button", { name: "提交进展" }).click();
    await expect(reviewDrawer.locator(".progress-history")).toContainText("100%");
    await reviewDrawer.getByRole("button", { name: "基本信息" }).click();
    await expect(reviewDrawer.getByText("待验收", { exact: true })).toBeVisible();
    await reviewDrawer.getByRole("button", { name: "验收完成" }).click();
    await expect(reviewDrawer.getByText("任务已完成，重新打开后才能修改。")).toBeVisible();

    await reviewDrawer.getByRole("button", { name: "关闭详情" }).click();
    await page.getByRole("button", { name: "里程碑", exact: true }).click();
    const milestoneDialog = page.getByRole("dialog", { name: "添加里程碑" });
    await milestoneDialog.getByLabel("里程碑名称").fill("答辩材料定稿");
    await milestoneDialog.getByLabel("截止日期").fill("2026-07-30");
    await milestoneDialog.getByLabel("说明").fill("确认答辩稿、附件和提交回执。");
    await milestoneDialog.getByRole("button", { name: "添加", exact: true }).click();
    await page.locator(".gantt-meta-row.row-milestone").filter({ hasText: "答辩材料定稿" }).click();
    const milestoneDrawer = page.getByLabel("里程碑详情：答辩材料定稿");
    await expect(milestoneDrawer).toBeVisible();
    await milestoneDrawer.getByRole("button", { name: "交付物" }).click();
    await milestoneDrawer.getByPlaceholder("新增交付要求").fill("答辩实验报告");
    await milestoneDrawer.locator(".inline-add").getByRole("button", { name: "添加" }).click();
    const milestoneDeliverable = milestoneDrawer.locator(".deliverable-list article").filter({ hasText: "答辩实验报告" });
    await milestoneDeliverable.locator("select").selectOption({ label: "实验报告.pdf · v3" });
    await milestoneDeliverable.getByRole("button", { name: "绑定" }).click();
    await milestoneDrawer.getByRole("button", { name: "基本信息" }).click();
    await milestoneDrawer.getByRole("button", { name: "提交验收" }).click();
    await expect(milestoneDrawer.getByText("待验收", { exact: true })).toBeVisible();
    await milestoneDrawer.getByRole("button", { name: "验收完成" }).click();
    await expect(milestoneDrawer.getByText("里程碑已验收，重新打开后才能修改。")).toBeVisible();
    await milestoneDrawer.getByRole("button", { name: "关闭详情" }).click();

    await page.getByRole("button", { name: "添加任务" }).click();
    const recurringSourceDrawer = page.getByLabel("新建任务");
    await recurringSourceDrawer.getByLabel("任务名称").fill("每周组会纪要");
    await recurringSourceDrawer.getByLabel("开始日期").fill("2026-07-27");
    await recurringSourceDrawer.getByLabel("截止日期").fill("2026-07-27");
    await recurringSourceDrawer.getByRole("button", { name: "创建任务" }).click();

    await page.getByRole("button", { name: "模板与周期" }).click();
    const scheduleTools = page.getByRole("dialog", { name: "模板与周期" });
    await expect(scheduleTools.getByText("竞赛项目模板", { exact: true })).toBeVisible();
    await expect(scheduleTools.getByText("科研课题模板", { exact: true })).toBeVisible();
    await scheduleTools.getByLabel("模板名称").fill("复现实验排期模板");
    await scheduleTools.getByLabel("模板基准日期").fill("2026-07-20");
    await scheduleTools.getByRole("button", { name: "保存当前结构" }).click();
    await expect(scheduleTools.getByRole("textbox", { name: "复现实验排期模板 模板名称", exact: true })).toHaveValue("复现实验排期模板");

    await scheduleTools.getByRole("button", { name: "周期任务", exact: true }).click();
    await scheduleTools.getByLabel("来源任务").selectOption({ label: "每周组会纪要" });
    await scheduleTools.getByLabel("重复方式").selectOption("weekly");
    await scheduleTools.getByLabel("每周日期").selectOption("1");
    await scheduleTools.getByLabel("开始日期").fill("2026-07-27");
    await scheduleTools.getByRole("button", { name: "创建周期规则" }).click();
    const recurringRule = scheduleTools.locator(".recurring-rule-row").filter({ hasText: "每周组会纪要" });
    await expect(recurringRule).toContainText("每 1 周");
    await recurringRule.getByLabel("生成至").fill("2026-08-03");
    await recurringRule.getByRole("button", { name: "生成实例" }).click();
    await expect(scheduleTools.getByText("已生成 2 个独立任务实例")).toBeVisible();
    await scheduleTools.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "添加任务" }).click();
    const archiveDraftDrawer = page.getByLabel("新建任务");
    await archiveDraftDrawer.getByLabel("任务名称").fill("待归档草稿");
    await archiveDraftDrawer.getByRole("button", { name: "创建任务" }).click();
    await page.locator(".gantt-meta-row.row-task").filter({ hasText: "待归档草稿" }).click();
    await page.getByLabel("任务详情：待归档草稿").getByRole("button", { name: "归档", exact: true }).click();
    await expect(page.locator(".gantt-meta-row.row-task").filter({ hasText: "待归档草稿" })).toHaveCount(0);

    await page.getByRole("button", { name: "项目设置" }).click();
    const projectSettings = page.getByRole("dialog", { name: "项目设置" });
    await expect(projectSettings.getByLabel("项目名称")).toHaveValue("全国大学生创新训练项目");
    await expect(projectSettings.getByRole("button", { name: "归档当前项目" })).toBeVisible();
    await expect(projectSettings.getByRole("button", { name: "移入项目回收站" })).toBeVisible();
    await projectSettings.getByRole("button", { name: "任务归档与回收站" }).click();
    const archivedTaskRow = projectSettings.locator(".lifecycle-list article").filter({ hasText: "待归档草稿" });
    await archivedTaskRow.getByRole("button", { name: "取消归档" }).click();
    await expect(projectSettings.getByText("暂无已归档任务")).toBeVisible();
    await projectSettings.getByRole("button", { name: "使用引导" }).click();
    const workspaceGuideRow = projectSettings.locator(".guide-section-list article").filter({ hasText: "甘特图工作区" });
    await expect(workspaceGuideRow).toContainText("已完成");
    await projectSettings.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
    await page.getByRole("button", { name: "项目设置" }).click();
    const replaySettings = page.getByRole("dialog", { name: "项目设置" });
    await replaySettings.getByRole("button", { name: "使用引导" }).click();
    const replayWorkspaceRow = replaySettings.locator(".guide-section-list article").filter({ hasText: "甘特图工作区" });
    await replayWorkspaceRow.getByRole("button", { name: "回放" }).click();
    const replayedWorkspaceTour = page.locator('[data-tour-section="workspace"]');
    await expect(replayedWorkspaceTour).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
    await expect(page.locator(".sidebar")).toHaveCSS("width", "220px");
    await replayedWorkspaceTour.getByRole("button", { name: "跳过本段" }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "68px");
    await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();
    await page.getByRole("button", { name: "项目设置" }).click();
    const resetSettings = page.getByRole("dialog", { name: "项目设置" });
    await resetSettings.getByRole("button", { name: "使用引导" }).click();
    await resetSettings.getByRole("button", { name: "重置全部进度" }).click();
    await expect(resetSettings.locator(".guide-section-list article").filter({ hasText: "甘特图工作区" })).toContainText("未查看");
    await resetSettings.getByRole("button", { name: "关闭" }).click();
    await page.waitForTimeout(700);
    await expect(page.locator(".tour-bubble")).toHaveCount(0);
    await expect(page.locator(".gantt-meta-row.row-task").filter({ hasText: "待归档草稿" })).toBeVisible();

    const finalScheduleResponse = await page.context().request.get(
      `/api/projects/${activeProjectId}/schedule`,
    );
    const finalSchedule = await finalScheduleResponse.json() as {
      tasks: Array<{ title: string; status: string }>;
    };
    expect(finalSchedule.tasks.find((task) => task.title === "模型复现实验")?.status).toBe("done");

    await page.getByRole("button", { name: "可用时间" }).click();
    const leaderAvailabilityTour = page.locator('[data-tour-section="availability"]');
    await expect(leaderAvailabilityTour).toBeVisible();
    await leaderAvailabilityTour.getByRole("button", { name: "跳过本段" }).click();
    const emptyAvailability = page.locator(".availability-empty");
    await expect(emptyAvailability).toBeVisible();
    const emptyAvailabilityBox = await emptyAvailability.boundingBox();
    const teamCapacityBox = await page.locator(".team-capacity").boundingBox();
    expect(emptyAvailabilityBox).not.toBeNull();
    expect(teamCapacityBox).not.toBeNull();
    expect(emptyAvailabilityBox!.height).toBeLessThanOrEqual(240);
    expect(teamCapacityBox!.y).toBeLessThan(900);

    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !message.includes("status of 401 (Unauthorized)"),
    );
    expect(unexpectedConsoleErrors).toEqual([]);
  } finally {
    await memberContext.close();
  }
});
