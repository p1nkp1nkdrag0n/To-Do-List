import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
  type ScheduleTestUser,
} from "./schedule-fixture.js";

describe("v2 archive and trash lifecycle", () => {
  let fixture: ScheduleFixture;
  let leader: ScheduleTestUser;

  beforeEach(async () => {
    fixture = createScheduleFixture();
    leader = await fixture.bootstrap();
  });

  afterEach(() => fixture.close());

  it("archives, trashes, and batch-restores a task subtree with its live relationships", async () => {
    const member = await fixture.register("lifecycle-member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);
    const parent = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Parent experiment" })
    ).body.task as { id: string; revision: number };
    const child = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Child measurement", parentId: parent.id })
    ).body.task as { id: string; revision: number };
    const predecessor = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Prepare samples" })
    ).body.task as { id: string; revision: number };
    const participantResponse = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${child.id}/participants`)
      .send({
        userId: member.id,
        startDate: "2026-07-20",
        endDate: "2026-07-25",
        estimatedMinutes: 300,
      });
    const participant = participantResponse.body.participant as {
      id: string;
      revision: number;
    };
    const dependencyResponse = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${child.id}/dependencies`)
      .send({ predecessorTaskId: predecessor.id });
    const dependency = dependencyResponse.body.dependency as {
      id: string;
      revision: number;
    };
    const progress = await member.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: participant.revision,
        completionPercent: 40,
        summary: "First batch measured.",
        blockers: "",
        nextSteps: "Measure the remaining samples.",
      });
    expect(progress.status).toBe(201);

    const latestParent = await leader.agent.get(
      `/api/projects/${project.id}/tasks/${parent.id}`,
    );
    let schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);

    const archived = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${parent.id}/archive`)
      .send({
        expectedRevision: latestParent.body.task.revision,
        expectedScheduleRevision: schedule.body.revision,
      });
    expect(archived.status).toBe(200);
    expect(archived.body.tasks).toHaveLength(2);
    expect(archived.body.tasks.every((task: { archivedAt: string | null }) => task.archivedAt)).toBe(
      true,
    );
    expect(
      (await leader.agent.get(`/api/projects/${project.id}/archived/tasks`)).body.tasks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id }),
        expect.objectContaining({ id: child.id }),
      ]),
    );
    schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks.map((task: { id: string }) => task.id)).not.toContain(parent.id);

    const unarchived = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${parent.id}/unarchive`)
      .send({
        expectedRevision: archived.body.rootRevision,
        expectedScheduleRevision: archived.body.scheduleRevision,
      });
    expect(unarchived.status).toBe(200);
    schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.tasks.map((task: { id: string }) => task.id)).toEqual(
      expect.arrayContaining([parent.id, child.id]),
    );

    const removedBeforeTrash = await leader.agent
      .delete(`/api/projects/${project.id}/dependencies/${dependency.id}`)
      .send({ expectedRevision: dependency.revision });
    expect(removedBeforeTrash.status).toBe(200);

    const trashed = await leader.agent
      .delete(`/api/projects/${project.id}/tasks/${parent.id}`)
      .send({
        expectedRevision: unarchived.body.rootRevision,
        expectedScheduleRevision: removedBeforeTrash.body.scheduleRevision,
      });
    expect(trashed.status).toBe(200);
    expect(trashed.body).toMatchObject({ deleted: true });
    expect(trashed.body.trashBatchId).toEqual(expect.any(String));

    const trash = await leader.agent.get(`/api/projects/${project.id}/trash`);
    expect(trash.status).toBe(200);
    expect(trash.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id }),
        expect.objectContaining({ id: child.id }),
      ]),
    );

    const restored = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${parent.id}/restore`)
      .send({
        expectedRevision: trashed.body.rootRevision,
        expectedScheduleRevision: trashed.body.scheduleRevision,
      });
    expect(restored.status).toBe(200);
    expect(restored.body.tasks).toHaveLength(2);
    expect(
      fixture.database.get<{ removed_at: string | null }>(
        "SELECT removed_at FROM task_participants WHERE id=?",
        [participant.id],
      ),
    ).toEqual({ removed_at: null });
    expect(
      fixture.database.get<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM task_dependencies WHERE id=?",
        [dependency.id],
      ),
    ).not.toEqual({ deleted_at: null });
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM progress_updates WHERE participant_id=?",
        [participant.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("restores a whole project or permanently removes its task progress after confirmation", async () => {
    const project = await fixture.createProject(leader);
    const task = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Project task" })
    ).body.task as { id: string; revision: number };
    const assignment = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/participants`)
      .send({
        userId: leader.id,
        startDate: "2026-07-20",
        endDate: "2026-07-21",
        estimatedMinutes: 60,
      });
    const participant = assignment.body.participant as { id: string; revision: number };
    await leader.agent
      .post(`/api/projects/${project.id}/participants/${participant.id}/progress`)
      .send({
        participantExpectedRevision: participant.revision,
        completionPercent: 10,
        summary: "Started.",
        blockers: "",
        nextSteps: "Continue.",
      });

    const archived = await leader.agent
      .post(`/api/projects/${project.id}/archive`)
      .send({ expectedRevision: project.revision });
    expect(archived.status).toBe(200);
    expect(archived.body.project.archivedAt).not.toBeNull();
    expect(
      (await leader.agent.get("/api/projects")).body.projects.map(
        (listed: { id: string }) => listed.id,
      ),
    ).not.toContain(project.id);
    expect((await leader.agent.get("/api/projects/archived")).body.projects).toEqual([
      expect.objectContaining({ id: project.id }),
    ]);
    const archivedWrite = await leader.agent
      .post(`/api/projects/${project.id}/tasks`)
      .send({ title: "Must not be created" });
    expect(archivedWrite.status).toBe(409);
    expect(archivedWrite.body.error.code).toBe("PROJECT_ARCHIVED");

    const unarchived = await leader.agent
      .post(`/api/projects/${project.id}/unarchive`)
      .send({ expectedRevision: archived.body.project.revision });
    expect(unarchived.status).toBe(200);

    const trashed = await leader.agent
      .delete(`/api/projects/${project.id}`)
      .send({
        expectedRevision: unarchived.body.project.revision,
        expectedScheduleRevision: (
          await leader.agent.get(`/api/projects/${project.id}/schedule`)
        ).body.revision,
      });
    expect(trashed.status).toBe(200);
    expect((await leader.agent.get(`/api/projects/${project.id}`)).status).toBe(404);

    const projectTrash = await leader.agent.get("/api/trash/projects");
    expect(projectTrash.status).toBe(200);
    expect(projectTrash.body.projects).toEqual([
      expect.objectContaining({ id: project.id }),
    ]);

    const restored = await leader.agent
      .post(`/api/trash/projects/${project.id}/restore`)
      .send({ expectedRevision: trashed.body.project.revision });
    expect(restored.status).toBe(200);
    expect((await leader.agent.get(`/api/projects/${project.id}`)).status).toBe(200);

    const trashedAgain = await leader.agent
      .delete(`/api/projects/${project.id}`)
      .send({
        expectedRevision: restored.body.project.revision,
        expectedScheduleRevision: (
          await leader.agent.get(`/api/projects/${project.id}/schedule`)
        ).body.revision,
      });
    const rejected = await leader.agent
      .delete(`/api/trash/projects/${project.id}/permanent`)
      .send({
        expectedRevision: trashedAgain.body.project.revision,
        confirmation: "wrong",
      });
    expect(rejected.status).toBe(400);

    const removed = await leader.agent
      .delete(`/api/trash/projects/${project.id}/permanent`)
      .send({
        expectedRevision: trashedAgain.body.project.revision,
        confirmation: project.id,
      });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM progress_updates WHERE participant_id=?",
        [participant.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects stale subtree mutations using the project schedule revision", async () => {
    const project = await fixture.createProject(leader);
    const parent = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Parent" })
    ).body.task as { id: string; revision: number };
    const child = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Child", parentId: parent.id })
    ).body.task as { id: string; revision: number };
    const staleScheduleRevision = (
      await leader.agent.get(`/api/projects/${project.id}/schedule`)
    ).body.revision as number;
    await leader.agent
      .patch(`/api/projects/${project.id}/tasks/${child.id}`)
      .send({ expectedRevision: child.revision, title: "Child changed elsewhere" });

    const stale = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${parent.id}/archive`)
      .send({
        expectedRevision: parent.revision,
        expectedScheduleRevision: staleScheduleRevision,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("SCHEDULE_REVISION_CONFLICT");
  });

  it("does not permanently cascade into a descendant from another trash batch", async () => {
    const project = await fixture.createProject(leader);
    const parent = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Parent" })
    ).body.task as { id: string; revision: number };
    const child = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Child", parentId: parent.id })
    ).body.task as { id: string; revision: number };
    let scheduleRevision = (
      await leader.agent.get(`/api/projects/${project.id}/schedule`)
    ).body.revision as number;
    const childTrash = await leader.agent
      .delete(`/api/projects/${project.id}/tasks/${child.id}`)
      .send({ expectedRevision: child.revision, expectedScheduleRevision: scheduleRevision });
    scheduleRevision = childTrash.body.scheduleRevision;
    const parentTrash = await leader.agent
      .delete(`/api/projects/${project.id}/tasks/${parent.id}`)
      .send({ expectedRevision: parent.revision, expectedScheduleRevision: scheduleRevision });

    const rejected = await leader.agent
      .delete(`/api/projects/${project.id}/tasks/${parent.id}/permanent`)
      .send({
        expectedRevision: parentTrash.body.rootRevision,
        expectedScheduleRevision: parentTrash.body.scheduleRevision,
        confirmation: parent.id,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("TASK_TRASH_BATCH_MISMATCH");
    expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [child.id])).toBeDefined();
  });

  it("restores tasks while leaving invalid participant relationships tombstoned", async () => {
    const member = await fixture.register("restore-disabled-member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);
    const task = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks`)
        .send({ title: "Member task" })
    ).body.task as { id: string; revision: number };
    const participant = (
      await leader.agent
        .post(`/api/projects/${project.id}/tasks/${task.id}/participants`)
        .send({
          userId: member.id,
          startDate: "2026-07-20",
          endDate: "2026-07-21",
          estimatedMinutes: 60,
        })
    ).body.participant as { id: string };
    const scheduleRevision = (
      await leader.agent.get(`/api/projects/${project.id}/schedule`)
    ).body.revision as number;
    const trashed = await leader.agent
      .delete(`/api/projects/${project.id}/tasks/${task.id}`)
      .send({ expectedRevision: task.revision, expectedScheduleRevision: scheduleRevision });
    fixture.database.run("UPDATE users SET disabled_at=? WHERE id=?", [
      "2026-07-18T08:00:00.000Z",
      member.id,
    ]);

    const restored = await leader.agent
      .post(`/api/projects/${project.id}/tasks/${task.id}/restore`)
      .send({
        expectedRevision: trashed.body.rootRevision,
        expectedScheduleRevision: trashed.body.scheduleRevision,
      });
    expect(restored.status).toBe(200);
    expect(restored.body.skippedParticipantIds).toEqual([participant.id]);
    expect(
      fixture.database.get<{ removed_at: string | null }>(
        "SELECT removed_at FROM task_participants WHERE id=?",
        [participant.id],
      )?.removed_at,
    ).not.toBeNull();
  });

  it("rejects project trash when resource content changed after the schedule snapshot", async () => {
    const project = await fixture.createProject(leader);
    const staleScheduleRevision = (
      await leader.agent.get(`/api/projects/${project.id}/schedule`)
    ).body.revision as number;
    const created = await leader.agent
      .post(`/api/projects/${project.id}/resources`)
      .field(
        "metadata",
        JSON.stringify({
          kind: "markdown",
          title: "Submission notes",
          markdownContent: "# Draft",
          tagIds: [],
        }),
      );
    expect(created.status).toBe(201);

    const rejected = await leader.agent.delete(`/api/projects/${project.id}`).send({
      expectedRevision: project.revision,
      expectedScheduleRevision: staleScheduleRevision,
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("SCHEDULE_REVISION_CONFLICT");
    expect(
      (await leader.agent.get(`/api/projects/${project.id}/resources/${created.body.resource.id}`))
        .status,
    ).toBe(200);
  });
});
