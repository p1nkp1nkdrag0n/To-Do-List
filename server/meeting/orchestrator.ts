/**
 * 会议编排器：把「读纪要/转写 → 建任务 → 查冲突 → 唤醒协调员 → 试算 → 落库」串成一条自动链路。
 *
 * 关键设计：
 *  - MCP 仍然是**独立子进程**，走真 stdio 协议，不是把工具函数 import 进来；
 *  - 编排器不直接写库，所有改动都通过 MCP 工具完成，保持单一写入口；
 *  - 每完成一次数据变更就回调 `onDataChanged`，由上层（API 进程）广播给浏览器。
 */
import fs from "node:fs";
import path from "node:path";

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
import { requireNumberField, requireToolOk } from "./tool-result.js";

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
  /** 负责人不可替换：只允许延期 / 平移，不允许换人或拆分。 */
  lockOwners?: boolean;
  /** 触发这次处理的用户；决定用谁的模型 Key。 */
  actingUserId?: string;
  /** 触发这次处理的用户名；MCP 子进程用它作为执行身份。 */
  actingUserName?: string;
  /** 确认面板确认过的任务：给了就不再重新抽取。 */
  confirmedTasks?: Array<{
    clientTaskId?: string;
    title: string;
    ownerName: string;
    ownerUserId?: string | null;
    estimatedHours: number;
    dueDate?: string | null;
    dependsOnTitle?: string | null;
    dependsOnTitles?: string[];
    predecessorClientTaskIds?: string[];
  }>;
  /** 用户确认/抽取开始时的排期版本；批量替换必须带上。 */
  expectedScheduleRevision?: number;
  /** true 表示走 replace_schedule 单事务重建。 */
  replaceSchedule?: boolean;
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
    // 打包版直接跑编译后的 main.js（不依赖 tsx）；开发态没有 dist-server 时退回 tsx。
    const compiledCandidate = path.resolve(
      this.options.cwd ?? process.cwd(),
      "dist-server/server/mcp/main.js",
    );
    const compiledEntry =
      process.env.MCP_ENTRY ??
      (fs.existsSync(compiledCandidate) ? compiledCandidate : undefined);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args:
        compiledEntry !== undefined && compiledEntry !== ""
          ? [compiledEntry]
          : ["--import", "tsx", "server/mcp/main.ts"],
      cwd: this.options.cwd ?? process.cwd(),
      env: childEnvironment(
        this.options.actingUserName === undefined
          ? this.options.env
          : { ...this.options.env, MCP_USERNAME: this.options.actingUserName },
      ),
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
    requireToolOk(conflictsOutcome, "check_conflicts");
    const conflictsBefore = requireNumberField(conflictsOutcome, "count", "check_conflicts");

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
    requireToolOk(tasksOutcome, "get_tasks");
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
      { projectId, allowReassign: !this.options.lockOwners },
      (payload) => {
        const plans = (payload.plans as PlanSummary[]) ?? [];
        const feasible = plans.filter((plan) => plan.feasible);
        return `${plans.length} 个候选方案，${feasible.length} 个可行；推荐 ${String(payload.recommendation ?? "无")}`;
      },
    );

    requireToolOk(planOutcome, "plan_reschedule");
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
    // 工具失败时 payload 里没有 conflictsAfter，不能当成 0 来宣布“清零”。
    if (!applyOutcome.ok) {
      this.emit({
        type: "session.failed",
        at: new Date().toISOString(),
        message: `应用方案失败：${applyOutcome.summary}`,
        detail: { planId: chosen.id, label: chosen.label },
      });
      throw new Error(`应用方案失败：${applyOutcome.summary}`);
    }
    const rawConflictsAfter = applyOutcome.payload.conflictsAfter;
    const conflictsAfter = Number(rawConflictsAfter);
    if (rawConflictsAfter === undefined || !Number.isFinite(conflictsAfter)) {
      this.emit({
        type: "session.failed",
        at: new Date().toISOString(),
        message: "方案已提交，但没有返回冲突结果，无法确认是否生效。",
        detail: { planId: chosen.id, label: chosen.label },
      });
      throw new Error("方案已提交，但没有返回冲突结果，无法确认是否生效；请刷新甘特图后重试。");
    }

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
        afterRevisions: applyOutcome.payload.afterRevisions as
          | AppliedPlanRecord["afterRevisions"]
          | undefined,
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
      warnings: [],
    };
  }

  /**
   * 新路径：给一段会议纪要，先抽任务、真建进库，再修复冲突。
   *
   * 这是「抽取员」真正干活的地方——不像老路径那样假设任务已经在库里。
   */
  async runFromMinutes(minutes: string): Promise<MeetingRunResult> {
    const startedAt = Date.now();
    // 抽取阶段的提示要在结果里带回给界面（截断 / 跳过 / 无 Key）。
    let extractionWarnings: string[] = [];
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
      // 身份错了会在这里显形：以前会静默按 0 个成员继续，最后报“抽不出任务”。
      if (!membersOutcome.ok) {
        throw new Error(`读取项目成员失败：${membersOutcome.summary}`);
      }
      const members = (membersOutcome.payload.members as Array<{
        userId: string;
        displayName: string;
      }>) ?? [];
      const memberByName = new Map(members.map((member) => [member.displayName, member.userId]));
      const names = [...memberByName.keys()];

      // 2. 抽取：确认面板给了清单就直接用，避免“看到的和建出来的不一样”。
      const extraction =
        this.options.confirmedTasks !== undefined
          ? {
              tasks: this.options.confirmedTasks,
              source: "deepseek" as const,
              warnings: [`按确认面板的 ${this.options.confirmedTasks.length} 条任务建排期，未重新抽取。`],
            }
          : await extractTasksFromText(minutes, names, this.options.actingUserId);
      extractionWarnings = extraction.warnings;
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
        const noKey = extraction.warnings.some((w) => w.includes("没有配置"));
        // 最容易被误会的一种：纪要读懂了，但写的人不在当前项目里。
        const outsiders = extraction.warnings.find((w) => w.includes("不在项目成员里"));
        const hints = [
          outsiders !== undefined
            ? "这段纪要里的人是别的项目的。请切换到包含他们的项目（例如「Demo」），或者先把他们加进当前项目。"
            : "",
          noKey
            ? "你还没有配置大模型 Key：去「会议 → 手动 → AI 设置」添加后，抽取会准确很多；现在只能用规则解析，规则只认「谁 + 做什么 + 几小时」。"
            : "",
          outsiders === undefined && noKey === false
            ? "建议在纪要里把「谁负责什么、要多久、什么时候前完成」写清楚，再试一次。"
            : "",
          ...extraction.warnings,
        ].filter((line) => line !== "");
        throw new Error(`没能从这段纪要里抽出任务。\n${hints.join("\n")}`);
      }

      // 2.5 所有会议路径统一走 replace_schedule：确认清单与抽取结果都先变成候选任务。
      const batchTasks = extraction.tasks as Array<
        ExtractedTask & {
          clientTaskId?: string;
          ownerUserId?: string | null;
          dependsOnTitles?: string[];
          predecessorClientTaskIds?: string[];
        }
      >;
      const memberIdsByName = new Map<string, string[]>();
      for (const member of members) {
        const list = memberIdsByName.get(member.displayName) ?? [];
        list.push(member.userId);
        memberIdsByName.set(member.displayName, list);
      }
      const memberIds = new Set(members.map((member) => member.userId));
      const idsByTitle = new Map<string, string[]>();
      batchTasks.forEach((task, index) => {
        const clientTaskId = task.clientTaskId ?? `task-${index}`;
        const list = idsByTitle.get(task.title) ?? [];
        list.push(clientTaskId);
        idsByTitle.set(task.title, list);
      });

      const candidates = batchTasks.map((task, index) => {
        const clientTaskId = task.clientTaskId ?? `task-${index}`;
        let ownerUserId = task.ownerUserId ?? null;
        if (ownerUserId === null && task.ownerName !== "未分配") {
          const matches = memberIdsByName.get(task.ownerName) ?? [];
          if (matches.length === 0) {
            throw new Error(`负责人「${task.ownerName}」不在当前项目成员里，整批未提交。`);
          }
          if (matches.length > 1) {
            throw new Error(`成员姓名「${task.ownerName}」重名，请在确认面板里显式选择负责人。`);
          }
          ownerUserId = matches[0]!;
        }
        if (ownerUserId !== null && !memberIds.has(ownerUserId)) {
          throw new Error("负责人已不是当前项目成员，整批未提交。");
        }

        const dependencyTitles =
          task.dependsOnTitles ??
          (task.dependsOnTitle ? [task.dependsOnTitle] : []);
        const predecessorClientTaskIds = [...(task.predecessorClientTaskIds ?? [])];
        for (const dependencyTitle of dependencyTitles) {
          const exact = idsByTitle.get(dependencyTitle) ?? [];
          if (exact.length > 1) {
            throw new Error(`依赖标题「${dependencyTitle}」对应多个任务，无法确定前驱。`);
          }
          if (exact.length === 0) {
            throw new Error(`依赖标题「${dependencyTitle}」没有精确匹配，整批未提交。请在纪要中使用前驱任务的完整标题后重试。`);
          }
          if (!predecessorClientTaskIds.includes(exact[0]!)) {
            predecessorClientTaskIds.push(exact[0]!);
          }
        }
        if (predecessorClientTaskIds.includes(clientTaskId)) {
          throw new Error(`任务「${task.title}」不能依赖自己。`);
        }
        const rawDue = task.dueDate ?? null;
        const dueDate = rawDue === null || rawDue < today ? addDays(today, 7) : rawDue;
        return {
          clientTaskId,
          title: task.title,
          ownerUserId,
          estimatedMinutes: Math.round(task.estimatedHours * 60),
          startDate: today,
          dueDate,
          predecessorClientTaskIds,
        };
      });

      const outcome = await this.callTool(
        client,
        "replace_schedule",
        {
          projectId,
          expectedScheduleRevision: this.options.expectedScheduleRevision,
          replaceSchedule: this.options.replaceSchedule !== false,
          tasks: candidates,
        },
        (payload) => `已提交 ${String(payload.count ?? candidates.length)} 条任务`,
      );
      requireToolOk(outcome, "replace_schedule");
      const taskIds = (outcome.payload.taskIds as string[]) ?? [];
      const created = candidates.map((candidate, index) => ({
        task: batchTasks[index]!,
        taskId: taskIds[index] ?? "",
      }));
      this.options.onDataChanged?.(projectId);
      this.emit({
        type: "plan.ready",
        at: new Date().toISOString(),
        message: `已在一个事务内把 ${created.length} 条待办写进排期，开始检查冲突`,
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
      warnings: extractionWarnings,
    };
  }
}
