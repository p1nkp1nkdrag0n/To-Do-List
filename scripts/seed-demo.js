const baseUrl = process.env.APP_URL || "http://localhost:4000";
const password = "demo123456";
const bootstrapCode = process.env.BOOTSTRAP_CODE || "";
const registrationCodes = (process.env.DEMO_REGISTRATION_CODES || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const users = [
  { username: "demo_admin", displayName: "项目管理员" },
  { username: "demo_alice", displayName: "Alice 设计" },
  { username: "demo_bob", displayName: "Bob 前端" },
  { username: "demo_chen", displayName: "Chen 后端" }
];

const statusLabel = {
  todo: "待办",
  doing: "进行中",
  done: "完成"
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value, amount) {
  const date = typeof value === "string" ? parseDate(value) : new Date(value);
  date.setDate(date.getDate() + amount);
  return formatDate(date);
}

function startOfWeek(value) {
  const date = typeof value === "string" ? parseDate(value) : new Date(value);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return formatDate(date);
}

async function call(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${data.error || response.statusText}`);
  }
  return data;
}

async function registerOrLogin(user, registrationCode) {
  try {
    return await call("/api/auth/register", {
      method: "POST",
      body: { ...user, password, registrationCode }
    });
  } catch (error) {
    if (!String(error.message).includes("already taken")) {
      if (String(error.message).includes("Registration code") || String(error.message).includes("Invalid registration code")) {
        throw new Error(
          `${error.message}\nSet BOOTSTRAP_CODE for demo_admin and DEMO_REGISTRATION_CODES with one invite code per remaining demo account.`
        );
      }
      throw error;
    }
    return call("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password }
    });
  }
}

function findByTitle(state, title) {
  const item = state.tasks.find((task) => task.title === title);
  if (!item) {
    throw new Error(`Task not found after creation: ${title}`);
  }
  return item;
}

async function addTask(token, projectId, state, task) {
  const next = await call(`/api/projects/${projectId}/tasks`, {
    token,
    method: "POST",
    body: task
  });
  return { state: next, task: findByTitle(next, task.title) };
}

async function main() {
  await fetch(`${baseUrl}/api/projects`).catch(() => {
    throw new Error(`Cannot reach ${baseUrl}. Please start the app with npm run dev first.`);
  });

  const accounts = {};
  for (const [index, user] of users.entries()) {
    const registrationCode = index === 0 ? bootstrapCode : registrationCodes[index - 1];
    accounts[user.username] = await registerOrLogin(user, registrationCode);
  }

  const admin = accounts.demo_admin;
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false }).replace(/[/: ]/g, "-");
  let state = await call("/api/projects", {
    token: admin.token,
    method: "POST",
    body: {
      name: `演示项目 - 团队发布节奏 ${stamp}`,
      timezone: "Asia/Shanghai"
    }
  });
  const projectId = state.project.id;

  for (const user of users.slice(1)) {
    state = await call(`/api/projects/${projectId}/members`, {
      token: admin.token,
      method: "POST",
      body: { username: user.username, role: "member" }
    });
  }

  const today = formatDate(new Date());
  const monday = startOfWeek(today);

  const created = {};
  for (const task of [
    { title: "产品准备", description: "确认范围、资料和验收口径。", status: "doing" },
    { title: "需求冻结", description: "冻结本轮 v1 范围。", status: "done", parent: "产品准备" },
    { title: "原型评审", description: "检查团队与个人模式主流程。", status: "doing", parent: "产品准备" },
    { title: "前端实现", description: "完成核心界面与甘特交互。", status: "doing" },
    { title: "甘特图交互", description: "支持周/月/年、条形拖拽和里程碑。", status: "doing", parent: "前端实现" },
    { title: "个人日程视图", description: "支持一天小时视图和 5 分钟吸附。", status: "todo", parent: "前端实现" },
    { title: "后端联调", description: "账号、权限、审批和实时广播。", status: "doing" },
    { title: "权限与审批", description: "成员提交请求，管理员审批。", status: "doing", parent: "后端联调" },
    { title: "实时同步", description: "多浏览器订阅项目更新。", status: "todo", parent: "后端联调" },
    { title: "发布验收", description: "完成一次端到端走查。", status: "todo" }
  ]) {
    const parentId = task.parent ? created[task.parent].id : null;
    const result = await addTask(admin.token, projectId, state, {
      title: task.title,
      description: task.description,
      status: task.status,
      parentId
    });
    state = result.state;
    created[task.title] = result.task;
  }

  const members = Object.fromEntries(state.members.map((member) => [member.username, member]));
  const assignments = [
    ["需求冻结", "demo_alice", 0, 1, "done"],
    ["原型评审", "demo_alice", 2, 4, "doing"],
    ["甘特图交互", "demo_bob", 1, 5, "doing"],
    ["个人日程视图", "demo_bob", 5, 8, "todo"],
    ["权限与审批", "demo_chen", 1, 6, "doing"],
    ["实时同步", "demo_chen", 6, 10, "todo"],
    ["发布验收", "demo_admin", 11, 13, "todo"]
  ];

  for (const [taskTitle, username, startOffset, endOffset, status] of assignments) {
    state = await call(`/api/projects/${projectId}/assignments`, {
      token: admin.token,
      method: "POST",
      body: {
        taskId: created[taskTitle].id,
        userId: members[username].userId,
        startDate: addDays(monday, startOffset),
        endDate: addDays(monday, endOffset),
        status
      }
    });
  }

  for (const milestone of [
    { task: "需求冻结", date: addDays(monday, 1), title: "需求冻结", color: "#24a148" },
    { task: "原型评审", date: addDays(monday, 4), title: "评审会", color: "#f97316" },
    { task: "实时同步", date: addDays(monday, 10), title: "联调完成", color: "#8b5cf6" },
    { task: "发布验收", date: addDays(monday, 13), title: "验收日", color: "#e11d48" }
  ]) {
    state = await call(`/api/projects/${projectId}/milestones`, {
      token: admin.token,
      method: "POST",
      body: {
        taskId: created[milestone.task].id,
        date: milestone.date,
        title: milestone.title,
        color: milestone.color
      }
    });
  }

  const knowledgeCategory = await call(`/api/projects/${projectId}/knowledge/categories`, {
    token: admin.token,
    method: "POST",
    body: { name: "项目资料" }
  });
  const knowledgeCategoryId = knowledgeCategory.categories[0].id;

  await call(`/api/projects/${projectId}/knowledge/documents`, {
    token: admin.token,
    method: "POST",
    body: {
      categoryId: knowledgeCategoryId,
      title: "发布节奏说明",
      content: `# 发布节奏说明

- 周一确认范围和负责人
- 周中完成原型与核心功能评审
- 周五检查风险、审批和成员负载

每日容量按 12 小时计算，过载需要提前调整。`
    }
  });

  await call(`/api/projects/${projectId}/knowledge/documents`, {
    token: admin.token,
    method: "POST",
    body: {
      categoryId: knowledgeCategoryId,
      title: "验收清单",
      content: `## 核心检查项

- 团队甘特图周/月/年视图正常
- 成员负载和风险统计正常
- 成员提交审批后管理员可以处理
- 知识库文档可以被项目成员查看`
    }
  });

  await call("/api/personal/events", {
    token: accounts.demo_alice.token,
    method: "POST",
    body: {
      title: "客户访谈",
      startAt: `${addDays(monday, 2)}T14:00`,
      endAt: `${addDays(monday, 2)}T15:30`,
      allDay: false
    }
  });
  await call("/api/personal/events", {
    token: accounts.demo_bob.token,
    method: "POST",
    body: {
      title: "组件走查",
      startAt: `${addDays(monday, 3)}T10:00`,
      endAt: `${addDays(monday, 3)}T11:00`,
      allDay: false
    }
  });

  const bobEvents = await call("/api/personal/events", { token: accounts.demo_bob.token });
  const bobPersonalEvent = bobEvents.events.find((event) => event.title === "组件走查");
  if (bobPersonalEvent) {
    await call(`/api/projects/${projectId}/requests`, {
      token: accounts.demo_bob.token,
      method: "POST",
      body: {
        type: "personal_to_team_task",
        eventId: bobPersonalEvent.id,
        title: "组件走查补充任务",
        description: "由个人日程提交到团队，等待管理员审批。",
        startDate: addDays(monday, 3),
        endDate: addDays(monday, 3),
        status: "todo"
      }
    });
  }

  await call(`/api/projects/${projectId}/requests`, {
    token: accounts.demo_alice.token,
    method: "POST",
    body: {
      type: "knowledge_document_create",
      categoryId: knowledgeCategoryId,
      title: "客户访谈记录模板",
      content: `# 客户访谈记录模板

- 访谈对象：
- 核心问题：
- 结论：
- 后续行动：`
    }
  });

  const bobAssignment = state.assignments.find((item) => item.username === "demo_bob" && item.taskId === created["甘特图交互"].id);
  if (bobAssignment) {
    await call(`/api/projects/${projectId}/requests`, {
      token: accounts.demo_bob.token,
      method: "POST",
      body: {
        type: "assignment_update",
        assignmentId: bobAssignment.id,
        startDate: addDays(monday, 2),
        endDate: addDays(monday, 6),
        status: "doing"
      }
    });
  }

  console.log("Demo data created.");
  console.log(`Project: ${state.project.name}`);
  console.log(`Project ID: ${projectId}`);
  console.log("Open: http://localhost:5173/");
  console.log("Accounts:");
  for (const user of users) {
    console.log(`- ${user.username} / ${password} (${user.displayName})`);
  }
  console.log("Suggested visual checks:");
  console.log("- Login as demo_admin, open Team Mode, switch week/month/year scales.");
  console.log("- Check colored assignment bars, task tree nesting, milestone flags, busy slots, and pending approvals.");
  console.log("- Login as demo_bob in another browser/private window to see personal/team schedule sync.");
  console.log(`Statuses used: ${Object.values(statusLabel).join(" / ")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
