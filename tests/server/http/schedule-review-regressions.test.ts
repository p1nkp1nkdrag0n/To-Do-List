import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
} from "./schedule-fixture.js";

describe("Task 3 review regressions", () => {
  let fixture: ScheduleFixture;

  beforeEach(() => {
    fixture = createScheduleFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it("soft-deletes an active task subtree without leaking its schedule entities", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const parent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Parent" })).body.task as { id: string; revision: number };
    const child = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Child", parentId: parent.id })).body.task as { id: string };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/participants`).send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 30 })).body.participant as { id: string };
    const dependency = (await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/dependencies`).send({ predecessorTaskId: parent.id })).body.dependency as { id: string };
    const deliverable = (await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/deliverables`).send({ title: "Child output" })).body.deliverable as { id: string };

    const removed = await leader.agent.delete(`/api/projects/${project.id}/tasks/${parent.id}`).send({ expectedRevision: parent.revision });
    expect(removed.status).toBe(200);
    const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks).toEqual([]);
    expect(schedule.body.participants).toEqual([]);
    expect(schedule.body.dependencies).toEqual([]);
    expect(schedule.body.deliverableRequirements).toEqual([]);
    expect(fixture.database.get<{ deleted_at: string | null }>("SELECT deleted_at FROM tasks WHERE id=?", [child.id])?.deleted_at).not.toBeNull();
    expect(fixture.database.get<{ removed_at: string | null }>("SELECT removed_at FROM task_participants WHERE id=?", [participant.id])?.removed_at).not.toBeNull();
    expect(fixture.database.get<{ deleted_at: string | null }>("SELECT deleted_at FROM task_dependencies WHERE id=?", [dependency.id])?.deleted_at).not.toBeNull();
    expect(fixture.database.get<{ id: string }>("SELECT id FROM deliverable_requirements WHERE id=?", [deliverable.id])).toBeDefined();
  });

  it("keeps a removed participant and its immutable progress as a revisioned tombstone", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const task = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Task" })).body.task as { id: string };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${task.id}/participants`).send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 30 })).body.participant as { id: string; revision: number };
    await leader.agent.post(`/api/projects/${project.id}/participants/${participant.id}/progress`).send({ participantExpectedRevision: 1, completionPercent: 25, summary: "Started", blockers: "", nextSteps: "Continue" });

    const deleted = await leader.agent.delete(`/api/projects/${project.id}/participants/${participant.id}`).send({ expectedRevision: 2 });
    expect(deleted.status).toBe(200);
    expect(fixture.database.get<{ removed_at: string | null; revision: number }>("SELECT removed_at, revision FROM task_participants WHERE id=?", [participant.id])).toMatchObject({ removed_at: expect.any(String), revision: 3 });
    const stale = await leader.agent.delete(`/api/projects/${project.id}/participants/${participant.id}`).send({ expectedRevision: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.latest).toMatchObject({ id: participant.id, deletedAt: expect.any(String), revision: 3 });
    expect(fixture.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM progress_updates WHERE participant_id=?", [participant.id])).toEqual({ count: 1 });
  });

  it("fulfills a task deliverable through the public API before review", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const task = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Report" })).body.task as { id: string };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${task.id}/participants`).send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 30 })).body.participant as { id: string };
    const deliverable = (await leader.agent.post(`/api/projects/${project.id}/tasks/${task.id}/deliverables`).send({ title: "Report PDF" })).body.deliverable as { id: string; revision: number };
    await leader.agent.post(`/api/projects/${project.id}/participants/${participant.id}/progress`).send({ participantExpectedRevision: 1, completionPercent: 100, summary: "Ready", blockers: "", nextSteps: "Review" });
    const resourceId = "00000000-0000-4000-8000-000000000201";
    fixture.database.run(`INSERT INTO resources (id, project_id, kind, title, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'markdown', 'Report', ?, ?, ?, ?)`, [resourceId, project.id, leader.id, leader.id, "2026-07-17T08:00:00.000Z", "2026-07-17T08:00:00.000Z"]);

    const fulfilled = await leader.agent.post(`/api/projects/${project.id}/deliverables/${deliverable.id}/fulfill`).send({ expectedRevision: deliverable.revision, resourceId });
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.deliverable).toMatchObject({ fulfilledResourceId: resourceId, revision: 2 });
    expect(fulfilled.body.task.status).toBe("pending_review");
  });

  it("uses an explicit milestone submission and review workflow", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const created = await leader.agent.post(`/api/projects/${project.id}/milestones`).send({ title: "Proposal deadline", dueDate: "2026-07-31", status: "in_progress" });
    expect(created.status).toBe(201);
    expect(created.body.milestone.status).toBe("in_progress");
    const submitted = await leader.agent.post(`/api/projects/${project.id}/milestones/${created.body.milestone.id}/submit-review`).send({ expectedRevision: 1 });
    expect(submitted.status).toBe(200);
    expect(submitted.body.milestone).toMatchObject({ status: "pending_review", revision: 2 });
    const reviewed = await leader.agent.post(`/api/projects/${project.id}/milestones/${created.body.milestone.id}/review`).send({ expectedRevision: 2 });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.milestone).toMatchObject({ status: "done", revision: 3 });
  });

  it("requires the current rule revision when generating instances", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly" })).body.task as { id: string };
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({ sourceTaskId: source.id, frequency: "weekly", intervalCount: 1, dayOfWeek: 1, startsOn: "2026-07-20" })).body.rule as { id: string; revision: number };
    const generated = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({ expectedRevision: rule.revision, throughDate: "2026-07-20" });
    expect(generated.status).toBe(200);
    expect(generated.body.rule.revision).toBe(2);
  });

  it("recomputes both old and new parent ancestor chains when reparenting", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const oldParent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Old parent" })).body.task as { id: string };
    const newParent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "New parent" })).body.task as { id: string };
    const child = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Child", parentId: oldParent.id })).body.task as { id: string; revision: number };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/participants`).send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 30 })).body.participant as { id: string };
    await leader.agent.post(`/api/projects/${project.id}/participants/${participant.id}/progress`).send({ participantExpectedRevision: 1, completionPercent: 20, summary: "Working", blockers: "", nextSteps: "Continue" });

    const reparented = await leader.agent.patch(`/api/projects/${project.id}/tasks/${child.id}`).send({ expectedRevision: child.revision + 1, parentId: newParent.id });
    expect(reparented.status).toBe(200);
    const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldParent.id, status: "not_started", revision: 3 }),
      expect.objectContaining({ id: newParent.id, status: "in_progress", revision: 2 }),
    ]));
  });

  it("recomputes a pending parent when a new child is created", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const parent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Parent" })).body.task as { id: string };
    const firstChild = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "First child", parentId: parent.id })).body.task as { id: string };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${firstChild.id}/participants`).send({
      userId: leader.id,
      startDate: "2026-07-20",
      endDate: "2026-07-20",
      estimatedMinutes: 30,
    })).body.participant as { id: string };
    await leader.agent.post(`/api/projects/${project.id}/participants/${participant.id}/progress`).send({
      participantExpectedRevision: 1,
      completionPercent: 100,
      summary: "Done",
      blockers: "",
      nextSteps: "Review",
    });
    await leader.agent.post(`/api/projects/${project.id}/tasks/${firstChild.id}/review`).send({ expectedRevision: 2 });
    const pendingParent = (await leader.agent.get(`/api/projects/${project.id}/tasks/${parent.id}`)).body.task as { revision: number; status: string };
    expect(pendingParent.status).toBe("pending_review");

    await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Second child", parentId: parent.id });
    const refreshedParent = (await leader.agent.get(`/api/projects/${project.id}/tasks/${parent.id}`)).body.task;
    expect(refreshedParent).toMatchObject({ status: "in_progress", revision: pendingParent.revision + 1 });
  });

  it("applies a child-before-parent template in parent order", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const templateId = "00000000-0000-4000-8000-000000000301";
    fixture.database.run(
      `INSERT INTO team_schedule_templates (id, name, payload_json, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'Out of order', ?, ?, ?, ?, ?)`,
      [
        templateId,
        JSON.stringify({
          version: 1,
          anchorSemantics: "relative_days",
          phases: [],
          tasks: [
            { key: "child", phaseKey: null, parentKey: "parent", title: "Child", description: "", position: 0, startOffsetDays: 1, dueOffsetDays: 2 },
            { key: "parent", phaseKey: null, parentKey: null, title: "Parent", description: "", position: 1, startOffsetDays: 0, dueOffsetDays: 3 },
          ],
          dependencies: [], milestones: [], deliverableRequirements: [],
        }),
        leader.id,
        leader.id,
        "2026-07-17T08:00:00.000Z",
        "2026-07-17T08:00:00.000Z",
      ],
    );
    const applied = await leader.agent.post(`/api/projects/${project.id}/templates/${templateId}/apply`).send({ anchorDate: "2026-08-01" });
    expect(applied.status).toBe(200);
    const tasks = (await leader.agent.get(`/api/projects/${project.id}/tasks`)).body.tasks as Array<{ id: string; title: string; parentId: string | null }>;
    const parent = tasks.find(({ title }) => title === "Parent")!;
    expect(tasks.find(({ title }) => title === "Child")?.parentId).toBe(parent.id);
  });

  it("does not mutate a project schedule when saving a team template and retains archived template conflicts", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const before = (await leader.agent.get(`/api/projects/${project.id}/schedule`)).body.revision;
    const saved = await leader.agent.post(`/api/projects/${project.id}/templates`).send({ name: "No schedule mutation", anchorDate: "2026-07-20" });
    expect(saved.status).toBe(201);
    expect(saved.body.scheduleRevision).toBe(before);
    const archived = await leader.agent.delete(`/api/projects/templates/${saved.body.template.id}`).send({ expectedRevision: 1 });
    expect(archived.status).toBe(200);
    const stale = await leader.agent.delete(`/api/projects/templates/${saved.body.template.id}`).send({ expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.latest).toMatchObject({ id: saved.body.template.id, revision: 2 });
  });

  it("returns a structured conflict for duplicate active team template names", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const first = await leader.agent.post(`/api/projects/${project.id}/templates`).send({
      name: "Research sprint",
      anchorDate: "2026-07-20",
    });

    const duplicate = await leader.agent.post(`/api/projects/${project.id}/templates`).send({
      name: "research sprint",
      anchorDate: "2026-07-20",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({
      code: "TEMPLATE_NAME_CONFLICT",
      fieldErrors: { name: [expect.any(String)] },
    });

    const second = await leader.agent.post(`/api/projects/${project.id}/templates`).send({
      name: "Competition sprint",
      anchorDate: "2026-07-20",
    });
    const renamed = await leader.agent.patch(`/api/projects/templates/${second.body.template.id}`).send({
      expectedRevision: second.body.template.revision,
      name: first.body.template.name,
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.code).toBe("TEMPLATE_NAME_CONFLICT");
  });

  it("copies schedule offsets into independent recurrence instances and never regenerates a past frontier", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Lab meeting", startDate: "2026-07-20", dueDate: "2026-07-22" })).body.task as { id: string };
    await leader.agent.post(`/api/projects/${project.id}/tasks/${source.id}/participants`).send({ userId: leader.id, startDate: "2026-07-21", endDate: "2026-07-22", estimatedMinutes: 90 });
    await leader.agent.post(`/api/projects/${project.id}/tasks/${source.id}/deliverables`).send({ title: "Meeting notes" });
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({ sourceTaskId: source.id, frequency: "weekly", intervalCount: 1, dayOfWeek: 1, startsOn: "2026-07-20" })).body.rule as { id: string; revision: number };
    const first = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({ expectedRevision: rule.revision, throughDate: "2026-07-20" });
    expect(first.status).toBe(200);
    expect(first.body.tasks).toEqual([expect.objectContaining({ startDate: "2026-07-20", dueDate: "2026-07-22" })]);
    const firstTask = first.body.tasks[0] as { id: string };
    const copiedParticipants = (await leader.agent.get(`/api/projects/${project.id}/participants`)).body.participants as Array<{ taskId: string; startDate: string; endDate: string; progressPercent: number }>;
    expect(copiedParticipants).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: firstTask.id, startDate: "2026-07-21", endDate: "2026-07-22", progressPercent: 0 })]));
    const copiedDeliverables = (await leader.agent.get(`/api/projects/${project.id}/deliverables`)).body.deliverables as Array<{ taskId: string; title: string; fulfilledResourceId: string | null }>;
    expect(copiedDeliverables).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: firstTask.id, title: "Meeting notes", fulfilledResourceId: null })]));

    const edited = await leader.agent.patch(`/api/projects/${project.id}/recurring-rules/${rule.id}`).send({ expectedRevision: first.body.rule.revision, intervalCount: 2, endsOn: "2026-08-31" });
    expect(edited.status).toBe(200);
    expect(edited.body.rule.nextOccurrenceOn).toBe("2026-08-03");
    const later = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({ expectedRevision: edited.body.rule.revision, throughDate: "2026-08-31" });
    expect(later.status).toBe(200);
    expect(later.body.tasks.map((task: { occurrenceDate: string }) => task.occurrenceDate)).toEqual(["2026-08-03", "2026-08-17", "2026-08-31"]);
  });

  it("restarts an edited recurrence pattern at its first ungenerated occurrence", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly sync" })).body.task as { id: string };
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({
      sourceTaskId: source.id,
      frequency: "weekly",
      intervalCount: 1,
      dayOfWeek: 1,
      startsOn: "2026-07-20",
    })).body.rule as { id: string; revision: number };
    const first = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({
      expectedRevision: rule.revision,
      throughDate: "2026-07-20",
    });

    const edited = await leader.agent.patch(`/api/projects/${project.id}/recurring-rules/${rule.id}`).send({
      expectedRevision: first.body.rule.revision,
      dayOfWeek: 2,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.rule.nextOccurrenceOn).toBe("2026-07-21");

    const generated = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({
      expectedRevision: edited.body.rule.revision,
      throughDate: "2026-08-04",
    });
    expect(generated.body.tasks.map((task: { occurrenceDate: string }) => task.occurrenceDate)).toEqual([
      "2026-07-21",
      "2026-07-28",
      "2026-08-04",
    ]);
  });

  it("copies fulfilled source requirements into recurrence instances as unfulfilled requirements", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly report" })).body.task as { id: string };
    const deliverable = (await leader.agent.post(`/api/projects/${project.id}/tasks/${source.id}/deliverables`).send({ title: "Report document" })).body.deliverable as { id: string; revision: number };
    const resourceId = "00000000-0000-4000-8000-000000000501";
    fixture.database.run(
      `INSERT INTO resources (id, project_id, kind, title, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'markdown', 'Source report', ?, ?, ?, ?)`,
      [resourceId, project.id, leader.id, leader.id, "2026-07-17T08:00:00.000Z", "2026-07-17T08:00:00.000Z"],
    );
    await leader.agent.post(`/api/projects/${project.id}/deliverables/${deliverable.id}/fulfill`).send({
      expectedRevision: deliverable.revision,
      resourceId,
    });
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({
      sourceTaskId: source.id,
      frequency: "weekly",
      intervalCount: 1,
      dayOfWeek: 1,
      startsOn: "2026-07-20",
    })).body.rule as { id: string; revision: number };

    const generated = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({
      expectedRevision: rule.revision,
      throughDate: "2026-07-20",
    });
    const generatedTaskId = generated.body.tasks[0].id as string;
    const requirements = (await leader.agent.get(`/api/projects/${project.id}/deliverables`)).body.deliverables as Array<{
      taskId: string;
      title: string;
      fulfilledResourceId: string | null;
    }>;
    expect(requirements).toContainEqual(expect.objectContaining({
      taskId: generatedTaskId,
      title: "Report document",
      fulfilledResourceId: null,
    }));
  });

  it("requires completed ancestors to be reopened before reopening a child", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const parent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Parent" })).body.task as { id: string };
    const child = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Child", parentId: parent.id })).body.task as { id: string };
    const participant = (await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/participants`).send({
      userId: leader.id,
      startDate: "2026-07-20",
      endDate: "2026-07-20",
      estimatedMinutes: 30,
    })).body.participant as { id: string };
    await leader.agent.post(`/api/projects/${project.id}/participants/${participant.id}/progress`).send({
      participantExpectedRevision: 1,
      completionPercent: 100,
      summary: "Done",
      blockers: "",
      nextSteps: "Review",
    });
    const reviewedChild = await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/review`).send({ expectedRevision: 2 });
    const currentParent = (await leader.agent.get(`/api/projects/${project.id}/tasks/${parent.id}`)).body.task as { revision: number };
    await leader.agent.post(`/api/projects/${project.id}/tasks/${parent.id}/review`).send({ expectedRevision: currentParent.revision });

    const blocked = await leader.agent.post(`/api/projects/${project.id}/tasks/${child.id}/reopen`).send({
      expectedRevision: reviewedChild.body.task.revision,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TASK_COMPLETED_ANCESTOR_LOCKED");
  });

  it("deactivates a recurring rule without clearing generated task history", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly" })).body.task as { id: string };
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({ sourceTaskId: source.id, frequency: "weekly", intervalCount: 1, dayOfWeek: 1, startsOn: "2026-07-20" })).body.rule as { id: string; revision: number };
    const generated = await leader.agent.post(`/api/projects/${project.id}/recurring-rules/${rule.id}/generate`).send({ expectedRevision: rule.revision, throughDate: "2026-07-20" });
    const generatedId = generated.body.tasks[0].id as string;
    const deactivated = await leader.agent.delete(`/api/projects/${project.id}/recurring-rules/${rule.id}`).send({ expectedRevision: generated.body.rule.revision });
    expect(deactivated.status).toBe(200);
    expect(fixture.database.get<{ recurring_rule_id: string | null }>("SELECT recurring_rule_id FROM tasks WHERE id=?", [generatedId])).toEqual({ recurring_rule_id: rule.id });
    expect((await leader.agent.get(`/api/projects/${project.id}/recurring-rules/${rule.id}`)).body.rule).toMatchObject({ isActive: false });
  });

  it("does not reactivate a recurring rule whose source task is deleted", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly source" })).body.task as { id: string; revision: number };
    const rule = (await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({
      sourceTaskId: source.id,
      frequency: "weekly",
      intervalCount: 1,
      dayOfWeek: 1,
      startsOn: "2026-07-20",
    })).body.rule as { id: string; revision: number };
    await leader.agent.delete(`/api/projects/${project.id}/recurring-rules/${rule.id}`).send({ expectedRevision: rule.revision });
    await leader.agent.delete(`/api/projects/${project.id}/tasks/${source.id}`).send({ expectedRevision: source.revision });

    const reactivated = await leader.agent.patch(`/api/projects/${project.id}/recurring-rules/${rule.id}`).send({
      expectedRevision: 2,
      isActive: true,
    });
    expect(reactivated.status).toBe(409);
    expect(reactivated.body.error.latest).toMatchObject({ id: source.id, deletedAt: expect.any(String) });
    expect((await leader.agent.get(`/api/projects/${project.id}/recurring-rules/${rule.id}`)).body.rule).toMatchObject({
      isActive: false,
      revision: 2,
    });
  });

  it("requires a current revision to restore a deleted dependency and blocks dependency changes on completed tasks", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const first = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "First" })).body.task as { id: string };
    const second = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Second" })).body.task as { id: string };
    const dependency = (await leader.agent.post(`/api/projects/${project.id}/tasks/${second.id}/dependencies`).send({ predecessorTaskId: first.id })).body.dependency as { id: string };
    expect((await leader.agent.delete(`/api/projects/${project.id}/dependencies/${dependency.id}`).send({ expectedRevision: 1 })).status).toBe(200);
    const missingRevision = await leader.agent.post(`/api/projects/${project.id}/tasks/${second.id}/dependencies`).send({ predecessorTaskId: first.id });
    expect(missingRevision.status).toBe(409);
    expect(missingRevision.body.error.latest).toMatchObject({ id: dependency.id, revision: 2, deletedAt: expect.any(String) });
    const restored = await leader.agent.post(`/api/projects/${project.id}/tasks/${second.id}/dependencies`).send({ predecessorTaskId: first.id, expectedRevision: 2 });
    expect(restored.status).toBe(201);
    const staleDelete = await leader.agent.delete(`/api/projects/${project.id}/dependencies/${dependency.id}`).send({ expectedRevision: 1 });
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body.error.latest).toMatchObject({ revision: 3 });
  });

  it("rejects a task subtree deletion while an active recurrence uses a subtree task", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const parent = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Parent" })).body.task as { id: string; revision: number };
    const child = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Source", parentId: parent.id })).body.task as { id: string };
    await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({ sourceTaskId: child.id, frequency: "weekly", intervalCount: 1, dayOfWeek: 1, startsOn: "2026-07-20" });
    const before = (await leader.agent.get(`/api/projects/${project.id}/schedule`)).body.revision;
    const deleted = await leader.agent.delete(`/api/projects/${project.id}/tasks/${parent.id}`).send({ expectedRevision: parent.revision });
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.code).toBe("TASK_RECURRING_SOURCE");
    expect((await leader.agent.get(`/api/projects/${project.id}/schedule`)).body.revision).toBe(before);
  });

  it("invalidates a pending milestone when its requirement changes and locks fulfilled requirements after review", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const milestone = (await leader.agent.post(`/api/projects/${project.id}/milestones`).send({ title: "Submission", dueDate: "2026-07-31", status: "in_progress" })).body.milestone as { id: string; revision: number };
    const deliverable = (await leader.agent.post(`/api/projects/${project.id}/milestones/${milestone.id}/deliverables`).send({ title: "Receipt" })).body.deliverable as { id: string; revision: number };
    const resourceId = "00000000-0000-4000-8000-000000000401";
    fixture.database.run(`INSERT INTO resources (id, project_id, kind, title, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'markdown', 'Receipt', ?, ?, ?, ?)`, [resourceId, project.id, leader.id, leader.id, "2026-07-17T08:00:00.000Z", "2026-07-17T08:00:00.000Z"]);
    const fulfilled = await leader.agent.post(`/api/projects/${project.id}/deliverables/${deliverable.id}/fulfill`).send({ expectedRevision: deliverable.revision, resourceId });
    const submitted = await leader.agent.post(`/api/projects/${project.id}/milestones/${milestone.id}/submit-review`).send({ expectedRevision: milestone.revision });
    expect(submitted.body.milestone).toMatchObject({ status: "pending_review", revision: 2 });
    const edited = await leader.agent.patch(`/api/projects/${project.id}/deliverables/${deliverable.id}`).send({ expectedRevision: fulfilled.body.deliverable.revision, title: "Signed receipt" });
    expect(edited.status).toBe(200);
    expect((await leader.agent.get(`/api/projects/${project.id}/milestones/${milestone.id}`)).body.milestone).toMatchObject({ status: "in_progress", revision: 3 });
    const resubmitted = await leader.agent.post(`/api/projects/${project.id}/milestones/${milestone.id}/submit-review`).send({ expectedRevision: 3 });
    const reviewed = await leader.agent.post(`/api/projects/${project.id}/milestones/${milestone.id}/review`).send({ expectedRevision: resubmitted.body.milestone.revision });
    expect(reviewed.body.milestone.status).toBe("done");
    const currentDeliverable = ((await leader.agent.get(`/api/projects/${project.id}/deliverables/${deliverable.id}`)).body.deliverable as { revision: number });
    const blocked = await leader.agent.post(`/api/projects/${project.id}/deliverables/${deliverable.id}/unfulfill`).send({ expectedRevision: currentDeliverable.revision });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("MILESTONE_COMPLETED_LOCKED");
  });
});
