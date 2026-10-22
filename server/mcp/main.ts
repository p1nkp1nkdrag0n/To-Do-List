/**
 * MCP Server 入口（stdio）。
 *
 * 启动方式：
 *   npm run mcp
 * 或挂到任意 MCP 客户端（Claude Desktop 等）：
 *   { "command": "node", "args": ["--import", "tsx", "server/mcp/main.ts"],
 *     "cwd": "<仓库根目录>" }
 *
 * 注意：stdout 是 MCP 协议通道，任何调试输出都必须走 console.error。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpRuntime } from "./runtime.js";
import { registerTools } from "./tools.js";

const SERVER_INFO = { name: "sukesong-scheduler", version: "0.1.0" };

async function main(): Promise<void> {
  const runtime = createMcpRuntime();
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "苏客松参赛项目「会议排班助手」的排期服务。先用 list_projects / get_tasks 看清现状，" +
      "再用 check_conflicts 找冲突；不要凭空假设任务或成员存在。",
  });

  registerTools(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[mcp] sukesong-scheduler 已就绪：db=${runtime.database !== undefined ? "ok" : "?"} ` +
      `user=${runtime.auth.user.username} project=${runtime.defaultProjectId ?? "(none)"}`,
  );

  const shutdown = (signal: string) => {
    console.error(`[mcp] 收到 ${signal}，退出`);
    try {
      runtime.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[mcp] 启动失败：", error instanceof Error ? error.stack : error);
  process.exit(1);
});
