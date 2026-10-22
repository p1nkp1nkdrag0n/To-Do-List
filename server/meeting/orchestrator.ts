/**
 * 会议编排器：把「查冲突 → 唤醒协调员 → 试算 → 挑方案 → 落库」串成一条自动链路。
 *
 * 关键设计：
 *  - MCP 仍然是**独立子进程**，走真 stdio 协议，不是把工具函数 import 进来；
 *  - 编排器不直接写库，所有改动都通过 MCP 工具完成，保持单一写入口；
 *  - 每完成一次数据变更就回调 `onDataChanged`，由上层（API 进程）广播给浏览器。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  AppliedPlanRecord,
  MeetingEvent,
  MeetingEventListener,
  MeetingRunResult,
} from "./events.js";

export interface OrchestratorOptions {
  projectId: string;
  /** MCP 子进程的工作目录，默认 process.cwd()。 */
  cwd?: string;
  /** 透传给子进程的环境变量，默认继承当前进程。 */
  env?: Record<string, string>;
  /** 每产生一个事件回调一次（日志面板用）。 */
  onEvent?: MeetingEventListener;
  /** 数据被改动后回调（浏览器刷新用）。 */
  onDataChanged?: (projectId: string) => void;
  /** 总共允许等多少个回合，防止模型失控时死循环。 */
  maxRounds?: number;
}

interface PlanSummary {
  id: string;
  label: string;
  feasible: boolean;
  summary: string;
  operations?: unknown[];
  after: { conflicts: number; shortfallMinutes: number; slippageDays: number; operations: number };
}

interface ToolOutcome {
  ok: boolean;
  payload: Record<string, unknown>;
  summary: string;
}

function childEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...base, ...extra };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const content =
    (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((entry) => entry.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

function clip(value: string, length = 120): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export class MeetingOrchestrator {
  private readonly events: MeetingEvent[] = [];

  constructor(private readonly options: OrchestratorOptions) {}

  get eventLog(): MeetingEvent[] {
    return [...this.events];
  }

  private emit(event: MeetingEvent): void {
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  private async callTool(
    client: Client,
    tool: string,
    args: Record<string, unknown>,
    describe: (payload: Record<string, unknown>) => string,
  ): Promise<ToolOutcome> {
    const started = Date.now();
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const payload = parsePayload(result);
    const ok = result.isError !== true;
    const summary = ok
      ? describe(payload)
      : clip(String((result.content ?? [])[0]?.text ?? "调用失败"), 160);

    this.emit({
      type: "tool.call",
      at: new Date().toISOString(),
      tool,
      status: ok ? "ok" : "error",
      argumentsSummary: clip(JSON.stringify(args), 100),
      resultSummary: clip(summary, 160),
      durationMs: Date.now() - started,
      message: `${tool} → ${clip(summary, 80)}`,
    });

    return { ok, payload, summary };
  }

  async run(): Promise<MeetingRunResult> {
    const startedAt = Date.now();
    const projectId = this.options.projectId;
    let conflictsBefore = 0;
    let conflictsAfter = 0;
    let appliedPlanId: string | null = null;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "server/mcp/main.ts"],
      cwd: this.options.cwd ?? process.cwd(),
      env: childEnvironment(this.options.env),
      stderr: "pipe",
    });
    const client = new Client({ name: "meeting-orchestrator", version: "0.1.0" });

    try {
      this.emit({
        type: "session.started",
        at: new Date().toISOString(),
        message: `会议处理开始，项目 ${projectId}`,
        detail: { projectId },
      });

      await client.connect(transport);
      this.emit({
        type: "session.started",
        at: new Date().toISOString(),
        message: "MCP 子进程已就绪（stdio 真协议）",
        detail: { cwd: this.options.cwd ?? process.cwd() },
      });

      const conflictsOutcome = await this.callTool(
        client,
        "check_conflicts",
        { projectId },
        (payload) => String(payload.summary ?? `${payload.count ?? 0} 条冲突`),
      );
      conflictsBefore = Number(conflictsOutcome.payload.count ?? 0);

      if (conflictsBefore === 0) {
        this.emit({
          type: "session.finished",
          at: new Date().toISOString(),
          message: "没有冲突，无需调整。",
        });
        return {
          projectId,
          events: this.eventLog,
          conflictsBefore: 0,
          conflictsAfter: 0,
          appliedPlanId: null,
          appliedPlan: null,
          durationMs: Date.now() - startedAt,
        };
      }

      const conflictList =
        (conflictsOutcome.payload.conflicts as Array<{ type: string; summary: string }>) ?? [];
      this.emit({
        type: "conflict.found",
        at: new Date().toISOString(),
        message: `发现 ${conflictsBefore} 条红冲突`,
        detail: {
          count: conflictsBefore,
          conflicts: conflictList.map((conflict) => ({
            type: conflict.type,
            summary: conflict.summary,
          })),
        },
      });

      this.emit({
        type: "coordinator.wake",
        at: new Date().toISOString(),
        message: "检测到红冲突 → 唤醒协调员",
      });

      const planOutcome = await this.callTool(
        client,
        "plan_reschedule",
        { projectId },
        (payload) => {
          const plans = (payload.plans as PlanSummary[]) ?? [];
          const feasible = plans.filter((plan) => plan.feasible);
          return `${plans.length} 个候选方案，${feasible.length} 个可行；推荐 ${String(payload.recommendation ?? "无")}`;
        },
      );

      const plans = (planOutcome.payload.plans as PlanSummary[]) ?? [];
      if (plans.length === 0) {
        throw new Error("协调员没有找到任何候选方案。");
      }

      this.emit({
        type: "plan.ready",
        at: new Date().toISOString(),
        message: `协调员给出 ${plans.length} 个方案，推荐 ${String(planOutcome.payload.recommendation ?? plans[0]!.id)}`,
        detail: {
          plans: plans.map((plan) => ({
            id: plan.id,
            label: plan.label,
            feasible: plan.feasible,
            summary: plan.summary,
            after: plan.after,
          })),
        },
      });

      const chosen = plans.find((plan) => plan.feasible) ?? plans[0]!;
      const applyOutcome = await this.callTool(
        client,
        "apply_plan",
        { projectId, planId: chosen.id },
        (payload) => String(payload.summary ?? "已应用"),
      );
      appliedPlanId = chosen.id;
      conflictsAfter = Number(applyOutcome.payload.conflictsAfter ?? 0);

      this.emit({
        type: "plan.applied",
        at: new Date().toISOString(),
        message:
          conflictsAfter === 0
            ? `已应用「${chosen.label}」，冲突清零`
            : `已应用「${chosen.label}」，仍有 ${conflictsAfter} 条冲突`,
        detail: {
          planId: chosen.id,
          label: chosen.label,
          conflictsAfter,
          operations: chosen.summary,
        },
      });

      this.options.onDataChanged?.(projectId);
      this.emit({
        type: "session.finished",
        at: new Date().toISOString(),
        message: `会议处理完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
        detail: { conflictsBefore, conflictsAfter, appliedPlanId },
      });

      return {
        projectId,
        events: this.eventLog,
        conflictsBefore,
        conflictsAfter,
        appliedPlanId,
        appliedPlan: {
          id: chosen.id,
          label: chosen.label,
          operations: (chosen.operations ?? []) as import("../mcp/reschedule.js").PlanOperation[],
          createdParticipants: (applyOutcome.payload.createdParticipants ??
            []) as AppliedPlanRecord["createdParticipants"],
        },
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "session.failed",
        at: new Date().toISOString(),
        message: `处理失败：${message}`,
      });
      throw error;
    } finally {
      try {
        await client.close();
      } catch {
        // 子进程可能已经退出，忽略关闭错误。
      }
    }
  }
}
