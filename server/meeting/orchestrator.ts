/**
 * 会议编排器：把「读纪要/转写 → 建任务 → 查冲突 → 唤醒协调员 → 试算 → 落库」串成一条自动链路。
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
import { MeetingControl } from "./control.js";
import { extractTasksFromText, type ExtractedTask } from "./extractor.js";

export interface OrchestratorOptions {
  projectId: string;
  /** MCP 子进程的工作目录，默认 process.cwd()。 */
  cwd?: string;
  /** 透传给子进程的环境变量，默认继承当前进程。 */
  env?: Record<string, string>;
  onEvent?: MeetingEventListener;
  onDataChanged?: (projectId: string) => void;
  maxRounds?: number;
  /**
   * 演示节奏：在关键步骤之间停一下，让观众看得清「先红后绿」。
   * 0 表示不停顿（测试用）。
   */
  paceMs?: number;
  /** 演示暂停开关；暂停时会在检查点停下来等。 */
  control?: MeetingControl;
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

interface ConflictResolution {
  conflictsBefore: number;
  conflictsAfter: number;
  appliedPlanId: string | null;
  appliedPlan: AppliedPlanRecord | null;
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

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

export class MeetingOrchestrator {
  private readonly events: MeetingEvent[] = [];

  constructor(private readonly options: OrchestratorOptions) {}

  get eventLog(): MeetingEvent[] {
    return [...this.events];
  }

  private async waitIfPaused(): Promise<void> {
    const control = this.options.control;
    if (control === undefined || !control.isPaused) return;
    this.emit({
      type: "session.started",
      at: new Date().toISOString(),
      message: "已暂停，点「继续」接着跑",
      detail: { paused: true },
    });
    await control.waitIfPaused();
    this.emit({
      type: "session.started",
      at: new Date().toISOString(),
      message: "已继续",
      detail: { paused: false },
    });
  }

  private async pause(): Promise<void> {
    const ms = this.options.paceMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
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

  /** 建立一个 MCP 子进程连接，跑完自动关闭。 */
  private async withClient<Result>(run: (client: Client) => Promise<Result>): Promise<Result> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "server/mcp/main.ts"],
      cwd: this.options.cwd ?? process.cwd(),
      env: childEnvironment(this.options.env),
      stderr: "pipe",
    });
    const client = new Client({ name: "meeting-orchestrator", version: "0.2.0" });
    try {
      await client.connect(transport);
      this.emit({
        type: "session.started",
        at: new Date().toISOString(),
        message: "MCP 子进程已就绪（stdio 真协议）",
        detail: { cwd: this.options.cwd ?? process.cwd() },
      });
      return await run(client);
    } finally {
      try {
        await client.close();
      } catch {
        // 子进程可能已经退出，忽略关闭错误。
      }
    }
  }

  /** 查冲突 → 唤醒协调员 → 试算 → 挑方案 → 落库。 */
  private async resolveConflicts(client: Client): Promise<ConflictResolution> {
    const projectId = this.options.projectId;
    const conflictsOutcome = await this.callTool(
      client,
      "check_conflicts",
      { projectId },
      (payload) => String(payload.summary ?? `${payload.count ?? 0} 条冲突`),
    );
    const conflictsBefore = Number(conflictsOutcome.payload.count ?? 0);

    if (conflictsBefore === 0) {
      this.emit({
        type: "session.finished",
        at: new Date().toISOString(),
        message: "没有冲突，无需调整。",
      });
      return { conflictsBefore: 0, conflictsAfter: 0, appliedPlanId: null, appliedPlan: null };
    }

    // 前端要显示「需要 10h / 可用 4h / 差 6h」，光有中文 summary 不够，
    // 这里补一次 get_tasks，把分工的工时和任务标题一起带进事件里。
    const tasksOutcome = await this.callTool(
      client,
      "get_tasks",
      { projectId },
      (payload) => `${(payload.tasks as unknown[])?.length ?? 0} 个任务`,
    );
    const participantIndex = new Map<
      string,
      { displayName: string; taskTitle: string; estimatedHours: number }
    >();
    const taskTitles = new Map<string, string>();
    for (const task of (tasksOutcome.payload.tasks as Array<{
      id: string;
      title: string;
      assignees?: Array<{ participantId: string; displayName: string; estimatedHours: number }>;
    }>) ?? []) {
      taskTitles.set(task.id, task.title);
      for (const assignee of task.assignees ?? []) {
        participantIndex.set(assignee.participantId, {
          displayName: assignee.displayName,
          taskTitle: task.title,
          estimatedHours: assignee.estimatedHours,
        });
      }
    }

    const conflictList = ((conflictsOutcome.payload.conflicts as Array<Record<string, unknown>>) ??
      []).map((conflict) => {
      const successorTitle =
        typeof conflict.successorTaskId === "string"
          ? taskTitles.get(conflict.successorTaskId)
          : undefined;
      const predecessorTitle =
        typeof conflict.predecessorTaskId === "string"
          ? taskTitles.get(conflict.predecessorTaskId)
          : undefined;
      const participantId = typeof conflict.participantId === "string" ? conflict.participantId : "";
      const info = participantIndex.get(participantId);
      if (info === undefined) {
        return { ...conflict, successorTitle, predecessorTitle };
      }
      const shortfallHours = Number(conflict.unallocatedMinutes ?? 0) / 60;
      return {
        ...conflict,
        displayName: info.displayName,
        taskTitle: info.taskTitle,
        estimatedHours: info.estimatedHours,
        availableHours: Math.max(0, Number((info.estimatedHours - shortfallHours).toFixed(1))),
        successorTitle,
        predecessorTitle,
      };
    });
    this.emit({
      type: "conflict.found",
      at: new Date().toISOString(),
      message: `发现 ${conflictsBefore} 条红冲突`,
      detail: {
        count: conflictsBefore,
        conflicts: conflictList,
      },
    });

    this.emit({
      type: "coordinator.wake",
      at: new Date().toISOString(),
      message: "检测到红冲突 → 唤醒协调员",
    });
    await this.pause();

    await this.waitIfPaused();
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
    await this.waitIfPaused();
    await this.pause();
    const applyOutcome = await this.callTool(
      client,
      "apply_plan",
      { projectId, planId: chosen.id },
      (payload) => String(payload.summary ?? "已应用"),
    );
    const conflictsAfter = Number(applyOutcome.payload.conflictsAfter ?? 0);

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

    return {
      conflictsBefore,
      conflictsAfter,
      appliedPlanId: chosen.id,
      appliedPlan: {
        id: chosen.id,
        label: chosen.label,
        operations: (chosen.operations ?? []) as import("../mcp/reschedule.js").PlanOperation[],
        createdParticipants: (applyOutcome.payload.createdParticipants ??
          []) as AppliedPlanRecord["createdParticipants"],
      },
    };
  }

  /** 老路径：项目里已经有任务，只做「查冲突 → 修复」。 */
  async run(): Promise<MeetingRunResult> {
    const startedAt = Date.now();
    this.emit({
      type: "session.started",
      at: new Date().toISOString(),
      message: `会议处理开始，项目 ${this.options.projectId}`,
      detail: { projectId: this.options.projectId },
    });

    const resolution = await this.withClient(async (client) =>
      this.resolveConflicts(client),
    );

    this.emit({
      type: "session.finished",
      at: new Date().toISOString(),
      message: `会议处理完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
      detail: {
        conflictsBefore: resolution.conflictsBefore,
        conflictsAfter: resolution.conflictsAfter,
        appliedPlanId: resolution.appliedPlanId,
      },
    });

    return {
      projectId: this.options.projectId,
      events: this.eventLog,
      ...resolution,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 新路径：给一段会议纪要，先抽任务、真建进库，再修复冲突。
   *
   * 这是「抽取员」真正干活的地方——不像老路径那样假设任务已经在库里。
   */
  async runFromMinutes(minutes: string): Promise<MeetingRunResult> {
    const startedAt = Date.now();
    const projectId = this.options.projectId;
    const today = new Date().toISOString().slice(0, 10);

    this.emit({
      type: "session.started",
      at: new Date().toISOString(),
      message: `收到会议纪要（${minutes.length} 字），开始抽取待办`,
      detail: { projectId, length: minutes.length },
    });

    const resolution = await this.withClient(async (client) => {
      // 1. 先拿到成员名单，抽取时只允许派给名单里的人
      const membersOutcome = await this.callTool(
        client,
        "list_members",
        { projectId },
        (payload) => `${(payload.members as unknown[])?.length ?? 0} 名成员`,
      );
      const members = (membersOutcome.payload.members as Array<{
        userId: string;
        displayName: string;
      }>) ?? [];
      const memberByName = new Map(members.map((member) => [member.displayName, member.userId]));
      const names = [...memberByName.keys()];

      // 2. 抽取
      const extraction = await extractTasksFromText(minutes, names);
      this.emit({
        type: "tool.call",
        at: new Date().toISOString(),
        tool: "extract_tasks",
        status: extraction.tasks.length > 0 ? "ok" : "error",
        argumentsSummary: `${minutes.length} 字纪要，成员 ${names.length} 人`,
        resultSummary: `${extraction.tasks.length} 条待办（${extraction.source === "deepseek" ? "大模型" : "规则"}）`,
        durationMs: 0,
        message:
          extraction.tasks.length === 0
            ? "没有从纪要里抽出待办"
            : `抽出 ${extraction.tasks.length} 条待办（${extraction.source === "deepseek" ? "大模型" : "规则"}）`,
      });
      if (extraction.tasks.length === 0) {
        throw new Error(
          `没能从这段纪要里抽出任务。${extraction.warnings.join("；")}`,
        );
      }

      // 3. 建任务 + 派人
      const created: Array<{ task: ExtractedTask; taskId: string }> = [];
      for (const task of extraction.tasks) {
        const userId = memberByName.get(task.ownerName);
        if (userId === undefined) continue;
        const dueDate = task.dueDate ?? addDays(today, 7);
        const createdTask = await this.callTool(
          client,
          "create_task",
          { projectId, title: task.title, startDate: today, dueDate },
          (payload) => `已建「${String(payload.title ?? task.title)}」`,
        );
        const taskId = String(createdTask.payload.taskId ?? "");
        if (taskId === "") continue;

        await this.callTool(
          client,
          "assign_member",
          {
            projectId,
            taskId,
            userId,
            startDate: today,
            endDate: dueDate,
            estimatedHours: task.estimatedHours,
          },
          (payload) => String(payload.summary ?? "已分配"),
        );
        created.push({ task, taskId });
      }
      this.options.onDataChanged?.(projectId);

      // 4. 依赖（放在建完之后，按标题匹配）
      for (const item of created) {
        const dependencyTitle = item.task.dependsOnTitle;
        if (dependencyTitle === undefined || dependencyTitle === null) continue;
        const predecessor = created.find((candidate) =>
          candidate.task.title.includes(dependencyTitle) ||
          dependencyTitle.includes(candidate.task.title),
        );
        if (predecessor === undefined) continue;
        await this.callTool(
          client,
          "set_dependency",
          {
            projectId,
            predecessorTaskId: predecessor.taskId,
            successorTaskId: item.taskId,
          },
          () => `「${item.task.title}」依赖「${predecessor.task.title}」`,
        );
      }

      this.emit({
        type: "plan.ready",
        at: new Date().toISOString(),
        message: `已把 ${created.length} 条待办写进排期，开始检查冲突`,
        detail: {
          tasks: created.map((item) => ({
            title: item.task.title,
            owner: item.task.ownerName,
            hours: item.task.estimatedHours,
          })),
        },
      });

      return this.resolveConflicts(client);
    });

    this.emit({
      type: "session.finished",
      at: new Date().toISOString(),
      message: `会议处理完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
      detail: {
        conflictsBefore: resolution.conflictsBefore,
        conflictsAfter: resolution.conflictsAfter,
        appliedPlanId: resolution.appliedPlanId,
      },
    });

    return {
      projectId,
      events: this.eventLog,
      ...resolution,
      durationMs: Date.now() - startedAt,
    };
  }
}
