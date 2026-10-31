/**
 * MCP 只读工具的独立单测。
 *
 * 两条原则：
 * 1. 走真协议（InMemoryTransport + Client），不直接 import 工具函数；
 * 2. 不碰 data/v2/app.sqlite，每个用例在自己的临时库里重建一份小号 fixture。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { openV2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { resolveDependencies } from "../../../server/http/dependencies.js";
import { createMcpRuntime, type McpRuntime } from "../../../server/mcp/runtime.js";
import { registerTools } from "../../../server/mcp/tools.js";
import { AvailabilityService } from "../../../server/modules/availability/availability-service.js";
import type { AuthenticatedSession } from "../../../server/modules/auth/auth-service.js";
import { ProjectService } from "../../../server/modules/projects/project-service.js";
import { ScheduleService } from "../../../server/modules/schedule/schedule-service.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROJECT_NAME = "MCP 测试项目";

const WEEK_SLOT = { startMinute: 1_140, endMinute: 1_260 }; // 19:00–21:00，2h
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

type MemberKey = "lead" | "backend" | "qa";

interface Fixture {
  dbPath: string;
  projectId: string;
  today: string;
  userIds: Record<MemberKey, string>;
}

interface FixtureOptions {
  /** 故意不给某个成员登记可用时间，用来触发 missing_availability。 */
  omitAvailabilityFor?: MemberKey;
}

interface Connected {
  runtime: McpRuntime;
  server: McpServer;
  client: Client;
}

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** 与 AvailabilityService 内部一致的「今天」口径：项目时区里的日期。 */
function todayInShanghai(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function sessionFor(
  id: string,
  username: string,
  displayName: string,
  now: Date,
): AuthenticatedSession {
  const iso = now.toISOString();
  return {
    sessionId: "test-session",
    tokenHash: "test-session",
    teamMember: true,
    user: {
      id,
      username,
      displayName,
      createdAt: iso,
      updatedAt: iso,
      revision: 1,
    },
  };
}

function buildFixture(options: FixtureOptions = {}): Fixture {
  const now = new Date();
  const today = todayInShanghai(now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-tools-"));
  const dbPath = path.join(directory, "app.sqlite");

  const database = openV2Database(dbPath);
  migrateV2Database(database, () => now.toISOString());

  const dependencies = resolveDependencies({
    database,
    sessionSecret: "mcp-test-session-secret-at-least-32-chars",
    cookieSecure: false,
    bootstrapCode: "mcp-test-bootstrap-code",
    clock: () => new Date(now.getTime()),
  });
  const availabilityService = new AvailabilityService(dependencies);
  const scheduleService = new ScheduleService(dependencies);
  const projectService = new ProjectService(dependencies);

  const members: Array<{
    key: MemberKey;
    username: string;
    displayName: string;
    weeklyCapacityMinutes: number;
    slots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
    exceptions: Array<{
      exceptionDate: string;
      kind: "available" | "unavailable";
      startMinute: number;
      endMinute: number;
      privateNote: string;
    }>;
  }> = [
    {
      key: "lead",
      username: "lead",
      displayName: "邱业恒",
      weeklyCapacityMinutes: 1_140,
      slots: EVERY_DAY.map((dayOfWeek) => ({
        dayOfWeek,
        startMinute: 540,
        endMinute: 1_080,
      })),
      exceptions: [],
    },
    {
      key: "backend",
      username: "zhang.gong",
      displayName: "张工",
      weeklyCapacityMinutes: 480,
      slots: EVERY_DAY.map((dayOfWeek) => ({ dayOfWeek, ...WEEK_SLOT })),
      exceptions: [
        {
          exceptionDate: shiftDays(today, 6),
          kind: "unavailable",
          startMinute: WEEK_SLOT.startMinute,
          endMinute: WEEK_SLOT.endMinute,
          privateNote: "周五晚有事",
        },
      ],
    },
    {
      key: "qa",
      username: "li.gong",
      displayName: "李工",
      weeklyCapacityMinutes: 900,
      slots: EVERY_DAY.map((dayOfWeek) => ({
        dayOfWeek,
        startMinute: 1_140,
        endMinute: 1_320,
      })),
      exceptions: [],
    },
  ];

  const userIds = {} as Record<MemberKey, string>;
  for (const member of members) {
    const id = randomUUID();
    userIds[member.key] = id;
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, member.username, "test-hash", member.displayName, now.toISOString(), now.toISOString()],
    );
    database.run(
      `INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)`,
      [id, now.toISOString(), (userIds.lead ?? id)],
    );
  }

  const leadSession = sessionFor(userIds.lead, "lead", "邱业恒", now);
  const project = projectService.create(leadSession, {
    name: PROJECT_NAME,
    description: "只为 MCP 单测准备的小号项目",
    startDate: shiftDays(today, -7),
    endDate: shiftDays(today, 60),
    memberUserIds: [userIds.backend, userIds.qa],
  });

  for (const member of members) {
    if (options.omitAvailabilityFor === member.key) continue;
    availabilityService.replaceDocument(
      sessionFor(userIds[member.key], member.username, member.displayName, now),
      {
        expectedRevision: 1,
        profiles: [
          {
            validFrom: shiftDays(today, -7),
            validThrough: shiftDays(today, 60),
            weeklyCapacityMinutes: member.weeklyCapacityMinutes,
            privateNote: "",
            weeklySlots: member.slots,
            exceptions: member.exceptions,
          },
        ],
      },
    );
  }

  const tasks = [
    {
      key: "T1",
      title: "MCP 工具层接口联调",
      owner: "backend" as MemberKey,
      startDate: shiftDays(today, 1),
      dueDate: shiftDays(today, 1),
      estimatedMinutes: 600,
    },
    {
      key: "T2",
      title: "甘特图与冲突面板联调",
      owner: "qa" as MemberKey,
      startDate: shiftDays(today, 1),
      dueDate: shiftDays(today, 2),
      estimatedMinutes: 180,
    },
    {
      key: "T3",
      title: "全流程彩排与兜底录屏",
      owner: "lead" as MemberKey,
      startDate: shiftDays(today, 5),
      dueDate: shiftDays(today, 6),
      estimatedMinutes: 120,
    },
  ];

  for (const task of tasks) {
    const created = scheduleService.createTask(leadSession, project.project.id, {
      title: task.title,
      startDate: task.startDate,
      dueDate: task.dueDate,
    });
    scheduleService.addParticipant(leadSession, project.project.id, created.task.id, {
      userId: userIds[task.owner],
      startDate: task.startDate,
      endDate: task.dueDate,
      estimatedMinutes: task.estimatedMinutes,
    });
  }

  database.close();

  return { dbPath, projectId: project.project.id, today, userIds };
}

async function connect(fixture: Fixture, username = "lead"): Promise<Connected> {
  const runtime = createMcpRuntime({ dbPath: fixture.dbPath, username });
  const server = new McpServer({ name: "mcp-test-server", version: "0.0.0" });
  registerTools(server, runtime);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return { runtime, server, client };
}

function textOf(result: unknown): string {
  const content =
    (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

function payloadOf(result: unknown): Record<string, any> {
  return JSON.parse(textOf(result)) as Record<string, any>;
}

const fixtures: Fixture[] = [];
const openConnections: Connected[] = [];

function makeFixture(options: FixtureOptions = {}): Fixture {
  const fixture = buildFixture(options);
  fixtures.push(fixture);
  return fixture;
}

async function connectTo(fixture: Fixture, username?: string): Promise<Connected> {
  const connection = await connect(fixture, username);
  openConnections.push(connection);
  return connection;
}

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop()!;
    await connection.client.close();
    await connection.server.close();
    connection.runtime.close();
  }
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    fs.rmSync(path.dirname(fixture.dbPath), { recursive: true, force: true });
  }
});

describe("MCP 只读工具", () => {
  it("tools/list 暴露全部 11 个工具", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "apply_plan",
        "assign_member",
        "check_conflicts",
        "create_task",
        "get_availability",
        "get_tasks",
        "list_members",
        "list_projects",
        "plan_reschedule",
        "replace_schedule",
        "set_dependency",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  it("list_projects 返回刚建的项目，并把它设为默认项目", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({
      id: fixture.projectId,
      name: PROJECT_NAME,
      timezone: "Asia/Shanghai",
    });
    expect(payload.defaultProjectId).toBe(fixture.projectId);
  });

  it("get_tasks 合并出任务树，assignees 带 displayName", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "get_tasks", arguments: {} }));
    expect(payload.projectId).toBe(fixture.projectId);
    expect(payload.tasks).toHaveLength(3);

    const integration = payload.tasks.find((task: any) => task.title === "MCP 工具层接口联调");
    expect(integration).toBeDefined();
    expect(integration.assignees).toHaveLength(1);
    expect(integration.assignees[0]).toMatchObject({
      userId: fixture.userIds.backend,
      displayName: "张工",
      estimatedMinutes: 600,
      estimatedHours: 10,
    });
    expect(integration.dependsOn).toEqual([]);
    expect(integration.blocks).toEqual([]);
  });

  it("list_members 返回成员数与每周可用时段", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "list_members", arguments: {} }));
    expect(payload.projectId).toBe(fixture.projectId);
    expect(payload.members).toHaveLength(3);

    const backend = payload.members.find((member: any) => member.displayName === "张工");
    expect(backend).toBeDefined();
    expect(backend.profiles).toHaveLength(1);
    expect(backend.profiles[0].weeklyCapacityMinutes).toBe(480);
    expect(backend.profiles[0].weeklyCapacityHours).toBe(8);
    expect(backend.profiles[0].weeklySlots).toHaveLength(7);
    expect(backend.profiles[0].exceptions).toHaveLength(1);
    expect(backend.profiles[0].exceptions[0].kind).toBe("unavailable");
  });

  it("check_conflicts 报出 1 条 unallocated_effort，且 summary 是人话", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "check_conflicts", arguments: {} }));
    expect(payload.count).toBe(1);
    expect(payload.conflicts).toHaveLength(1);

    const conflict = payload.conflicts[0];
    expect(conflict.type).toBe("unallocated_effort");
    expect(conflict.severity).toBe("red");
    expect(conflict.userId).toBe(fixture.userIds.backend);
    expect(conflict.unallocatedMinutes).toBe(480);
    expect(conflict.summary).toContain("张工");
    expect(conflict.summary).toContain("排不进去");
    expect(conflict.summary).toContain("8.0h");
    expect(payload.summary).toContain("排不进去");
  });

  it("没有登记可用时间时能触发 missing_availability", async () => {
    const fixture = makeFixture({ omitAvailabilityFor: "qa" });
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "check_conflicts", arguments: {} }));
    const types = payload.conflicts.map((conflict: any) => conflict.type);
    expect(types).toContain("missing_availability");

    const missing = payload.conflicts.find((conflict: any) => conflict.type === "missing_availability");
    expect(missing.userId).toBe(fixture.userIds.qa);
    expect(missing.summary).toContain("没有登记可用时间");
  });

  it("projectId 不存在时返回 isError 而不是抛异常", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const result = (await client.callTool({
      name: "get_tasks",
      arguments: { projectId: "does-not-exist" },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("调用失败");
  });

  it("get_availability 不传参数时返回当前账号自己的可用时间", async () => {
    const fixture = makeFixture();
    const { client } = await connectTo(fixture);

    const payload = payloadOf(await client.callTool({ name: "get_availability", arguments: {} }));
    expect(payload.scope).toBe("self");
    expect(payload.userId).toBe(fixture.userIds.lead);
    expect(Array.isArray(payload.profiles)).toBe(true);
    expect(payload.profiles).toHaveLength(1);
  });
});
