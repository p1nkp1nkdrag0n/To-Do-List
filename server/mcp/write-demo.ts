/**
 * 写入类工具的端到端验证（在**副本库**上跑，不动演示库）。
 *
 *   cp data/v2/app.sqlite .tmp/write-test.sqlite
 *   DB_PATH=.tmp/write-test.sqlite npx tsx server/mcp/write-demo.ts
 *
 * 走真协议：create_task → assign_member → set_dependency → get_tasks → check_conflicts。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpRuntime } from "./runtime.js";
import { registerTools } from "./tools.js";

function payload(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}");
}

async function main(): Promise<void> {
  const runtime = createMcpRuntime({ dbPath: process.env.DB_PATH });
  const server = new McpServer({ name: "write-demo", version: "0.0.1" });
  registerTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "write-demo-client", version: "0.0.1" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) =>
    payload(await client.callTool({ name, arguments: args }));

  const members = await call("list_members", {});
  const qa = (members.members as any[]).find((member) => member.displayName === "李工");
  const tasksBefore = await call("get_tasks", {});

  const created = await call("create_task", {
    title: "盘点宣传物料",
    description: "由 write-demo 创建的验证任务",
    startDate: "2026-11-02",
    dueDate: "2026-11-06",
  });
  console.log("create_task →", created.taskId, created.summary);

  const assigned = await call("assign_member", {
    taskId: created.taskId,
    userId: qa.userId,
    startDate: "2026-11-02",
    endDate: "2026-11-06",
    estimatedHours: 6,
  });
  console.log("assign_member →", assigned.summary);

  const dependency = await call("set_dependency", {
    predecessorTaskId: created.taskId,
    successorTaskId: (tasksBefore.tasks as any[]).find((task) => task.title.includes("彩排"))
      .id,
  });
  console.log("set_dependency →", dependency.summary);

  const tasksAfter = await call("get_tasks", {});
  const found = (tasksAfter.tasks as any[]).find((task) => task.id === created.taskId);
  console.log(
    "get_tasks →",
    `${(tasksAfter.tasks as any[]).length} 个任务，新建的任务${found ? "存在" : "缺失"}`,
    found ? `（${found.assignees?.[0]?.displayName} ${found.assignees?.[0]?.estimatedHours}h，blocks=${found.blocks?.length}）` : "",
  );

  const conflicts = await call("check_conflicts", {});
  console.log("check_conflicts →", conflicts.summary);

  const pass =
    tasksAfter.tasks.length === tasksBefore.tasks.length + 1 &&
    found !== undefined &&
    String(conflicts.count).length > 0;
  console.log(pass ? "\n✅ 写入链路通过" : "\n❌ 写入链路异常");

  await client.close();
  await server.close();
  runtime.close();
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("失败：", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
