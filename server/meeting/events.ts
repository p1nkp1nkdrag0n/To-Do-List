/**
 * 会议编排的事件模型。
 *
 * 一条原则：**每个事件都要能直接渲染成日志面板里的一行字**。
 * 所以除结构化字段外，还有 `message`（中文人话）和 `at`（时间戳）。
 */

export type MeetingEventType =
  | "session.started"
  | "tool.call"
  | "conflict.found"
  | "coordinator.wake"
  | "plan.ready"
  | "plan.applied"
  | "session.finished"
  | "session.failed";

export interface MeetingToolCallEvent {
  type: "tool.call";
  at: string;
  tool: string;
  status: "ok" | "error";
  argumentsSummary: string;
  resultSummary: string;
  durationMs: number;
  message: string;
}

export interface MeetingSimpleEvent {
  type: Exclude<MeetingEventType, "tool.call">;
  at: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type MeetingEvent = MeetingToolCallEvent | MeetingSimpleEvent;

export type MeetingEventListener = (event: MeetingEvent) => void;

export interface AppliedPlanRecord {
  id: string;
  label: string;
  operations: import("../mcp/reschedule.js").PlanOperation[];
  /** 拆分时真正落库的分工（占位 id → 真实 id），撤销靠它精确删人。 */
  createdParticipants?: Array<{
    placeholderId: string;
    realId: string;
    taskId: string;
    userId: string;
  }>;
}

export interface MeetingRunResult {
  projectId: string;
  events: MeetingEvent[];
  conflictsBefore: number;
  conflictsAfter: number;
  appliedPlanId: string | null;
  /** 本次应用的方案（撤销时用它反推）；没应用则是 null。 */
  appliedPlan: AppliedPlanRecord | null;
  durationMs: number;
}

export function createEvent(
  type: MeetingEvent["type"],
  message: string,
  detail?: Record<string, unknown>,
): MeetingEvent {
  if (type === "tool.call") {
    throw new TypeError("tool.call 事件请用 MeetingToolCallEvent 结构构造。");
  }
  const event: MeetingSimpleEvent = { type, at: new Date().toISOString(), message };
  if (detail !== undefined) event.detail = detail;
  return event;
}
