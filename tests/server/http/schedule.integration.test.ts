import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
} from "./schedule-fixture.js";

describe("v2 schedule phase and task API", () => {
  let fixture: ScheduleFixture;

  beforeEach(() => {
    fixture = createScheduleFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it("isolates projects while giving every project member equal schedule rights", async () => {
    const leader = await fixture.bootstrap();
    const member = await fixture.register("member");
    const outsider = await fixture.register("outsider");
    await fixture.addToTeam(leader, member);
    await fixture.addToTeam(leader, outsider);
    const project = await fixture.createProject(leader, [member.id]);

    const hidden = await outsider.agent.get(`/api/projects/${project.id}/schedule`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("PROJECT_NOT_FOUND");

    const initial = await member.agent.get(`/api/projects/${project.id}/schedule`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      projectId: project.id,
      revision: 1,
      phases: [],
      tasks: [],
      participants: [],
      dependencies: [],
      milestones: [],
      deliverableRequirements: [],
      conflicts: [],
    });

    const phaseResponse = await member.agent
      .post(`/api/projects/${project.id}/phases`)
      .send({
        name: "Experiments",
        description: "Run and analyze experiments",
        position: 2,
        startDate: "2026-07-20",
        endDate: "2026-08-20",
      });
    expect(phaseResponse.status).toBe(201);
    expect(phaseResponse.body).toMatchObject({
      scheduleRevision: 2,
      phase: { name: "Experiments", revision: 1 },
    });
    const phase = phaseResponse.body.phase as { id: string; revision: number };

    const taskResponse = await leader.agent
      .post(`/api/projects/${project.id}/tasks`)
      .send({
        phaseId: phase.id,
        title: "Calibrate equipment",
        position: 1,
        startDate: "2026-07-21",
        dueDate: "2026-07-25",
      });
    expect(taskResponse.status).toBe(201);
    expect(taskResponse.body).toMatchObject({
      scheduleRevision: 3,
      task: { title: "Calibrate equipment", status: "not_started", revision: 1 },
    });
    const task = taskResponse.body.task as { id: string; revision: number };

    const schedule = await member.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body).toMatchObject({
      revision: 3,
      phases: [{ id: phase.id, name: "Experiments" }],
      tasks: [{ id: task.id, phaseId: phase.id, parentId: null }],
    });
  });

  it("returns sanitized latest entities for phase and task revision conflicts", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const phase = (
      await leader.agent
        .post(`/api/projects/${project.id}/phases`)
        .send({ name: "Phase" })
    ).body.phase as { id: string; revision: number };
    const task = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Task" })
    ).body.task as { id: string; revision: number };

    const phasePatch = await leader.agent
      .patch(`/api/projects/${project.id}/phases/${phase.id}`)
      .send({ expectedRevision: 1, name: "Updated phase" });
    expect(phasePatch.status).toBe(200);
    expect(phasePatch.body).toMatchObject({
      scheduleRevision: 4,
      phase: { name: "Updated phase", revision: 2 },
    });
    const stalePhase = await leader.agent
      .patch(`/api/projects/${project.id}/phases/${phase.id}`)
      .send({ expectedRevision: 1, name: "Stale" });
    expect(stalePhase.status).toBe(409);
    expect(stalePhase.body.error).toMatchObject({
      code: "REVISION_CONFLICT",
      latest: { id: phase.id, name: "Updated phase", revision: 2 },
    });

    const taskPatch = await leader.agent
      .patch(`/api/projects/${project.id}/tasks/${task.id}`)
      .send({ expectedRevision: 1, description: "Current" });
    expect(taskPatch.status).toBe(200);
    expect(taskPatch.body).toMatchObject({
      scheduleRevision: 5,
      task: { description: "Current", revision: 2 },
    });
    const staleTask = await leader.agent
      .patch(`/api/projects/${project.id}/tasks/${task.id}`)
      .send({ expectedRevision: 1, description: "Stale" });
    expect(staleTask.status).toBe(409);
    expect(staleTask.body.error.latest).toMatchObject({
      id: task.id,
      description: "Current",
      revision: 2,
    });
    expect(
      (await leader.agent.get(`/api/projects/${project.id}/schedule`)).body.revision,
    ).toBe(5);
  });

  it("rejects parent cycles and clears phase references with revisioned deletion", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const phase = (
      await leader.agent
        .post(`/api/projects/${project.id}/phases`)
        .send({ name: "Temporary phase" })
    ).body.phase as { id: string; revision: number };
    const parent = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Parent", phaseId: phase.id })
    ).body.task as { id: string; revision: number };
    const child = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Child", parentId: parent.id, phaseId: phase.id })
    ).body.task as { id: string; revision: number };

    const cycle = await leader.agent
      .patch(`/api/projects/${project.id}/tasks/${parent.id}`)
      .send({ expectedRevision: 1, parentId: child.id });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe("TASK_PARENT_CYCLE");

    const staleDelete = await leader.agent
      .delete(`/api/projects/${project.id}/phases/${phase.id}`)
      .send({ expectedRevision: 2 });
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body.error.latest).toMatchObject({
      id: phase.id,
      revision: 1,
    });

    const deleted = await leader.agent
      .delete(`/api/projects/${project.id}/phases/${phase.id}`)
      .send({ expectedRevision: 1 });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, scheduleRevision: 5 });
    const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.phases).toEqual([]);
    expect(schedule.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, phaseId: null, revision: 2 }),
        expect.objectContaining({ id: child.id, phaseId: null, revision: 2 }),
      ]),
    );
  });

  it("records immutable progress, recomputes ancestors, and enforces review and reopen", async () => {
    const leader = await fixture.bootstrap();
    const member = await fixture.register("member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);
    const parent = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Parent" })
    ).body.task as { id: string; revision: number };
    const child = (
      await member.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Child", parentId: parent.id })
    ).body.task as { id: string; revision: number };

    const assignment = await member.agent
      .post(`/api/projects/${project.id}/tasks/${child.id}/participants`)
      .send({
        userId: member.id,
        startDate: "2026-07-20",
        endDate: "2026-07-25",
        estimatedMinutes: 300,
      });
    expect(assignment.status).toBe(201);
    expect(assignment.body).toMatchObject({
      scheduleRevision: 4,
      participant: {
        userId: member.id,
        status: "not_started",
        progressPercent: 0,
        revision: 1,
      },
    });
    const participant = assignment.body.participant as {
      id: string;
      revision: number;
    };

    const staleAssignment = await leader.agent
      .patch(`/api/projects/${project.id}/participants/${participant.id}`)
      .send({ expectedRevision: 2, estimatedMinutes: 360 });
    expect(staleAssignment.status).toBe(409);
    expect(staleAssignment.body.error.latest).toMatchObject({
      id: participant.id,
      estimatedMinutes: 300,
      revision: 1,
    });

    const blocked = await member.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: 1,
        completionPercent: 40,
        summary: "Completed setup.",
        blockers: "Equipment booking unavailable.",
        nextSteps: "Confirm a new booking.",
      });
    expect(blocked.status).toBe(201);
    expect(blocked.body).toMatchObject({
      scheduleRevision: 5,
      participant: { status: "blocked", progressPercent: 40, revision: 2 },
      task: { id: child.id, status: "blocked", revision: 2 },
    });
    let schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, status: "blocked", revision: 2 }),
        expect.objectContaining({ id: child.id, status: "blocked", revision: 2 }),
      ]),
    );

    const completed = await member.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: 2,
        completionPercent: 100,
        summary: "Experiment complete.",
        blockers: "",
        nextSteps: "Request review.",
      });
    expect(completed.status).toBe(201);
    expect(completed.body).toMatchObject({
      scheduleRevision: 6,
      participant: { status: "done", progressPercent: 100, revision: 3 },
      task: { status: "pending_review", revision: 3 },
    });
    const progress = await leader.agent.get(
      `/api/projects/${project.id}/participants/${participant.id}/progress`,
    );
    expect(progress.status).toBe(200);
    expect(progress.body.progressUpdates).toHaveLength(2);
    expect(progress.body.progressUpdates[0]).toMatchObject({
      completionPercent: 40,
      blockers: "Equipment booking unavailable.",
    });

    const reviewedChild = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${child.id}/review`)
      .send({ expectedRevision: 3 });
    expect(reviewedChild.status).toBe(200);
    expect(reviewedChild.body).toMatchObject({
      scheduleRevision: 7,
      task: { status: "done", revision: 4, reviewedBy: leader.id },
    });
    schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, status: "pending_review", revision: 4 }),
      ]),
    );

    const locked = await member.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: 3,
        completionPercent: 90,
        summary: "Attempted edit.",
        blockers: "",
        nextSteps: "",
      });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("TASK_COMPLETED_LOCKED");

    const reopened = await member.agent
      .post(`/api/projects/${project.id}/tasks/${child.id}/reopen`)
      .send({ expectedRevision: 4 });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({
      scheduleRevision: 8,
      task: { status: "pending_review", revision: 5, reviewedAt: null },
    });
  });

  it("gates task review on real fulfilled deliverables", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const task = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Submission" })
    ).body.task as { id: string; revision: number };
    const assignment = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/participants`)
      .send({
        userId: leader.id,
        startDate: "2026-07-20",
        endDate: "2026-07-21",
        estimatedMinutes: 60,
      });
    const participant = assignment.body.participant as { id: string };
    const deliverableResponse = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/deliverables`)
      .send({ title: "Final report", description: "PDF" });
    expect(deliverableResponse.status).toBe(201);
    const deliverable = deliverableResponse.body.deliverable as { id: string };

    const progress = await leader.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: 1,
        completionPercent: 100,
        summary: "Finished.",
        blockers: "",
        nextSteps: "Upload report.",
      });
    expect(progress.body.task).toMatchObject({ status: "in_progress", revision: 2 });

    const gated = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/review`)
      .send({ expectedRevision: 2 });
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe("TASK_NOT_PENDING_REVIEW");

    const now = "2026-07-17T08:00:00.000Z";
    const resourceId = "00000000-0000-4000-8000-000000000099";
    fixture.database.run(
      `INSERT INTO resources
        (id, project_id, kind, title, current_version_number, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'markdown', 'Final report', 1, ?, ?, ?, ?)`,
      [resourceId, project.id, leader.id, leader.id, now, now],
    );
    const resourceVersionId = "00000000-0000-4000-8000-000000000098";
    fixture.database.run(
      `INSERT INTO resource_versions
        (id, resource_id, version_number, original_filename, byte_size, mime_type, sha256,
         markdown_content, version_note, created_by, created_at)
       VALUES (?, ?, 1, 'Final report.md', 1, 'text/markdown', ?, '#', '', ?, ?)`,
      [resourceVersionId, resourceId, "a".repeat(64), leader.id, now],
    );
    fixture.database.run(
      `UPDATE deliverable_requirements
          SET fulfilled_resource_id = ?, fulfilled_resource_version_id = ?, fulfilled_at = ?, fulfilled_by = ?
        WHERE id = ?`,
      [resourceId, resourceVersionId, now, leader.id, deliverable.id],
    );

    const reviewed = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/review`)
      .send({ expectedRevision: 2 });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.task).toMatchObject({ status: "done", revision: 3 });
  });

  it("creates revisioned finish-to-start dependencies and rejects a cycle", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const first = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Design" })).body.task as { id: string };
    const second = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Build" })).body.task as { id: string };
    const created = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${second.id}/dependencies`)
      .send({ predecessorTaskId: first.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ scheduleRevision: 4, dependency: { predecessorTaskId: first.id, successorTaskId: second.id, revision: 1 } });
    const cycle = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${first.id}/dependencies`)
      .send({ predecessorTaskId: second.id });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe("DEPENDENCY_CYCLE");
    const removed = await leader.agent
      .delete(`/api/projects/${project.id}/dependencies/${created.body.dependency.id}`)
      .send({ expectedRevision: 1 });
    expect(removed.body).toEqual({ deleted: true, scheduleRevision: 5 });
  });

  it("generates independent recurring instances and applies a saved template", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const source = (await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Weekly meeting", startDate: "2026-07-20", dueDate: "2026-07-20" })).body.task as { id: string };
    const rule = await leader.agent.post(`/api/projects/${project.id}/recurring-rules`).send({
      sourceTaskId: source.id,
      frequency: "weekly",
      intervalCount: 1,
      dayOfWeek: 1,
      startsOn: "2026-07-20",
    });
    expect(rule.status).toBe(201);
    const generated = await leader.agent
      .post(`/api/projects/${project.id}/recurring-rules/${rule.body.rule.id}/generate`)
      .send({ expectedRevision: rule.body.rule.revision, throughDate: "2026-08-03" });
    expect(generated.status).toBe(200);
    expect(generated.body.tasks.map((task: { occurrenceDate: string }) => task.occurrenceDate)).toEqual(["2026-07-20", "2026-07-27", "2026-08-03"]);
    expect(new Set(generated.body.tasks.map((task: { id: string }) => task.id)).size).toBe(3);

    const saved = await leader.agent.post(`/api/projects/${project.id}/templates`).send({ name: "Meeting plan", anchorDate: "2026-07-20" });
    expect(saved.status).toBe(201);
    const applied = await leader.agent
      .post(`/api/projects/${project.id}/templates/${saved.body.template.id}/apply`)
      .send({ anchorDate: "2026-09-01" });
    expect(applied.status).toBe(200);
    const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.revision).toBe(applied.body.scheduleRevision);
    expect(schedule.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Weekly meeting", startDate: "2026-09-01", dueDate: "2026-09-01" }),
    ]));
  });
});
