/**
 * MCP 冒烟测试：像真客户端那样走 stdio 协议连一次，而不是 import 工具函数。
 *
 *   npm run mcp:smoke
 *
 * 覆盖：握手 → tools/list → get_tasks → list_members → check_conflicts → plan_reschedule。
 * 退出码 0 表示全部通过。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "list_projects",
  "get_tasks",
  "list_members",
  "get_availability",
  "check_conflicts",
  "plan_reschedule",
  "apply_plan",
];

interface CallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function parsePayload(result: unknown): Record<string, unknown> {
  const typed = result as CallResult;
  const text = typed.content?.find((entry) => entry.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function childEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/mcp/main.ts"],
    cwd: process.cwd(),
    env: childEnvironment(),
    stderr: "pipe",
  });

  const client = new Client({ name: "sukesong-smoke", version: "0.0.1" });
  await client.connect(transport);

  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  checks.push({
    name: "tools/list",
    passed: EXPECTED_TOOLS.every((expected) => names.includes(expected)),
    detail: `${names.length} 个工具：${names.join(", ")}`,
  });

  const tasks = parsePayload(await client.callTool({ name: "get_tasks", arguments: {} }));
  const taskList = (tasks.tasks as unknown[]) ?? [];
  checks.push({
    name: "get_tasks",
    passed: taskList.length === 4,
    detail: `${taskList.length} 个任务`,
  });

  const members = parsePayload(await client.callTool({ name: "list_members", arguments: {} }));
  const memberList = (members.members as unknown[]) ?? [];
  checks.push({
    name: "list_members",
    passed: memberList.length === 3,
    detail: `${memberList.length} 名成员`,
  });

  const availability = parsePayload(
    await client.callTool({ name: "get_availability", arguments: {} }),
  );
  checks.push({
    name: "get_availability",
    passed: Array.isArray(availability.profiles),
    detail: `自身可用时间 ${(availability.profiles as unknown[]).length} 份`,
  });

  const conflicts = parsePayload(
    await client.callTool({ name: "check_conflicts", arguments: {} }),
  );
  const conflictList = (conflicts.conflicts as Array<{ type: string; summary: string }>) ?? [];
  const types = conflictList.map((conflict) => conflict.type);
  checks.push({
    name: "check_conflicts",
    passed:
      conflictList.length === 2 &&
      types.includes("unallocated_effort") &&
      types.includes("dependency_inversion"),
    detail: conflictList.map((conflict) => conflict.summary).join(" ｜ "),
  });

  const plans = parsePayload(
    await client.callTool({ name: "plan_reschedule", arguments: {} }),
  );
  const planList =
    (plans.plans as Array<{ id: string; feasible: boolean; after: { conflicts: number } }>) ?? [];
  checks.push({
    name: "plan_reschedule",
    passed: planList.some((plan) => plan.feasible && plan.after.conflicts === 0),
    detail: `${planList.length} 个方案，推荐 ${String(plans.recommendation)}`,
  });

  console.log("\n=== MCP 冒烟结果 ===");
  for (const check of checks) {
    console.log(`${check.passed ? "✓" : "✗"} ${check.name.padEnd(16)} ${check.detail}`);
  }

  await client.close();

  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项未通过。`);
    process.exitCode = 1;
  } else {
    console.log("\n全部通过。");
  }
}

main().catch((error: unknown) => {
  console.error("冒烟测试失败：", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
