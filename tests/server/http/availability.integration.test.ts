import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AvailabilityDocumentSchema,
  ProjectAvailabilitySummarySchema,
  ScheduleConflictSchema,
} from "../../../shared/availability-contracts.js";
import {
  createScheduleFixture,
  type ScheduleFixture,
} from "./schedule-fixture.js";

const semesterProfile = {
  validFrom: "2026-07-20",
  validThrough: "2026-12-31",
  weeklyCapacityMinutes: 60,
  privateNote: "Thesis defense preparation",
  weeklySlots: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
  exceptions: [
    {
      exceptionDate: "2026-07-27",
      kind: "unavailable" as const,
      startMinute: 540,
      endMinute: 570,
      privateNote: "Private advisor meeting",
    },
  ],
};

describe("v2 availability and project conflict API", () => {
  let fixture: ScheduleFixture;

  beforeEach(() => {
    fixture = createScheduleFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  it("atomically manages the current user's full private availability document", async () => {
    const leader = await fixture.bootstrap();

    const initial = await leader.agent.get("/api/me/availability");
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ revision: 1, profiles: [] });

    const updated = await leader.agent.put("/api/me/availability").send({
      expectedRevision: 1,
      profiles: [semesterProfile],
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      revision: 2,
      profiles: [
        {
          ...semesterProfile,
          id: expect.any(String),
          revision: 1,
        },
      ],
    });
    expect(AvailabilityDocumentSchema.safeParse(updated.body).success).toBe(true);

    const revised = await leader.agent.put("/api/me/availability").send({
      expectedRevision: 2,
      profiles: [
        {
          ...semesterProfile,
          id: updated.body.profiles[0].id,
          weeklyCapacityMinutes: 120,
        },
      ],
    });
    expect(revised.body).toMatchObject({
      revision: 3,
      profiles: [
        {
          id: updated.body.profiles[0].id,
          revision: 2,
          weeklyCapacityMinutes: 120,
        },
      ],
    });

    const loaded = await leader.agent.get("/api/me/availability");
    expect(loaded.body).toEqual(revised.body);

    const stale = await leader.agent.put("/api/me/availability").send({
      expectedRevision: 2,
      profiles: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: "REVISION_CONFLICT",
      latest: revised.body,
    });

    const activity = fixture.database.get<{
      project_id: string | null;
      metadata_json: string;
    }>(
      "SELECT project_id, metadata_json FROM activity_log WHERE action='availability.updated' ORDER BY rowid DESC LIMIT 1",
    );
    expect(activity?.project_id).toBeNull();
    expect(activity?.metadata_json).not.toContain(semesterProfile.privateNote);
    expect(activity?.metadata_json).not.toContain(
      semesterProfile.exceptions[0].privateNote,
    );
  });

  it("rolls back the whole availability document when a nested write fails", async () => {
    const leader = await fixture.bootstrap();
    const initial = await leader.agent.put("/api/me/availability").send({
      expectedRevision: 1,
      profiles: [{ ...semesterProfile, exceptions: [] }],
    });
    const activityBefore = fixture.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM activity_log WHERE action='availability.updated'",
    )!.count;
    fixture.database.exec(`
      CREATE TRIGGER test_fail_second_availability_profile
      BEFORE INSERT ON availability_profiles
      WHEN NEW.valid_from = '2027-01-01'
      BEGIN
        SELECT RAISE(ABORT, 'forced nested availability failure');
      END;
    `);

    const failed = await leader.agent.put("/api/me/availability").send({
      expectedRevision: initial.body.revision,
      profiles: [
        {
          ...semesterProfile,
          id: initial.body.profiles[0].id,
          exceptions: [],
        },
        {
          validFrom: "2027-01-01",
          validThrough: "2027-06-30",
          weeklyCapacityMinutes: 120,
          privateNote: "Must roll back",
          weeklySlots: [{ dayOfWeek: 2, startMinute: 540, endMinute: 600 }],
          exceptions: [],
        },
      ],
    });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("INTERNAL_ERROR");
    expect((await leader.agent.get("/api/me/availability")).body).toEqual(initial.body);
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action='availability.updated'",
      )!.count,
    ).toBe(activityBefore);
  });

  it("rejects duplicate exceptions as validation errors without writing", async () => {
    const leader = await fixture.bootstrap();
    const duplicate = {
      exceptionDate: "2026-07-27",
      kind: "unavailable" as const,
      startMinute: 540,
      endMinute: 570,
      privateNote: "Private reason",
    };

    const response = await leader.agent.put("/api/me/availability").send({
      expectedRevision: 1,
      profiles: [
        {
          ...semesterProfile,
          exceptions: [duplicate, duplicate],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect((await leader.agent.get("/api/me/availability")).body).toEqual({
      revision: 1,
      profiles: [],
    });
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action='availability.updated'",
      ),
    ).toEqual({ count: 0 });
  });

  it("returns only sanitized busy/free capacity to project members", async () => {
    const leader = await fixture.bootstrap();
    const member = await fixture.register("member");
    const outsider = await fixture.register("outsider");
    await fixture.addToTeam(leader, member);
    await fixture.addToTeam(leader, outsider);
    const project = await fixture.createProject(leader, [member.id]);
    await leader.agent.put("/api/me/availability").send({
      expectedRevision: 1,
      profiles: [semesterProfile],
    });

    const summary = await member.agent.get(
      `/api/projects/${project.id}/availability`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      projectId: project.id,
      members: expect.arrayContaining([
        expect.objectContaining({
          userId: leader.id,
          profiles: [
            expect.objectContaining({
              validFrom: semesterProfile.validFrom,
              validThrough: semesterProfile.validThrough,
              weeklyCapacityMinutes: semesterProfile.weeklyCapacityMinutes,
              weeklySlots: semesterProfile.weeklySlots,
              exceptions: [
                expect.objectContaining({
                  exceptionDate: "2026-07-27",
                  kind: "unavailable",
                }),
              ],
            }),
          ],
        }),
      ]),
    });
    expect(ProjectAvailabilitySummarySchema.safeParse(summary.body).success).toBe(true);
    const serialized = JSON.stringify(summary.body);
    expect(serialized).not.toContain("privateNote");
    expect(serialized).not.toContain(semesterProfile.privateNote);
    expect(serialized).not.toContain(semesterProfile.exceptions[0].privateNote);

    const hidden = await outsider.agent.get(
      `/api/projects/${project.id}/availability`,
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("allocates capacity within one project without creating cross-project conflicts", async () => {
    const leader = await fixture.bootstrap();
    const firstProject = await fixture.createProject(leader);
    const secondProject = await fixture.createProject(leader);
    await leader.agent.put("/api/me/availability").send({
      expectedRevision: 1,
      profiles: [{ ...semesterProfile, privateNote: "", exceptions: [] }],
    });

    const earlyTask = (await leader.agent
      .post(`/api/projects/${firstProject.id}/tasks`)
      .send({ title: "Early task", startDate: "2026-07-20", dueDate: "2026-07-20" })).body.task as { id: string };
    const lateTask = (await leader.agent
      .post(`/api/projects/${firstProject.id}/tasks`)
      .send({ title: "Later task", startDate: "2026-07-20", dueDate: "2026-07-21" })).body.task as { id: string };
    const otherProjectTask = (await leader.agent
      .post(`/api/projects/${secondProject.id}/tasks`)
      .send({ title: "Independent task", startDate: "2026-07-20", dueDate: "2026-07-20" })).body.task as { id: string };

    const earlyParticipant = (await leader.agent
      .post(`/api/projects/${firstProject.id}/tasks/${earlyTask.id}/participants`)
      .send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 60 })).body.participant as { id: string };
    const lateParticipant = (await leader.agent
      .post(`/api/projects/${firstProject.id}/tasks/${lateTask.id}/participants`)
      .send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-21", estimatedMinutes: 60 })).body.participant as { id: string };
    await leader.agent
      .post(`/api/projects/${secondProject.id}/tasks/${otherProjectTask.id}/participants`)
      .send({ userId: leader.id, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 60 });

    const firstSchedule = await leader.agent.get(
      `/api/projects/${firstProject.id}/schedule`,
    );
    expect(firstSchedule.body.conflicts).toEqual([
      expect.objectContaining({
        type: "unallocated_effort",
        severity: "red",
        participantId: lateParticipant.id,
        unallocatedMinutes: 60,
      }),
    ]);
    expect(firstSchedule.body.conflicts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: earlyParticipant.id }),
      ]),
    );

    const secondSchedule = await leader.agent.get(
      `/api/projects/${secondProject.id}/schedule`,
    );
    expect(secondSchedule.body.conflicts).toEqual([]);
  });

  it("reports overdue, missing availability, and dependency inversion without suggestions", async () => {
    const leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    const predecessor = (await leader.agent
      .post(`/api/projects/${project.id}/tasks`)
      .send({ title: "Predecessor", startDate: "2026-07-20", dueDate: "2026-07-25" })).body.task as { id: string };
    const successor = (await leader.agent
      .post(`/api/projects/${project.id}/tasks`)
      .send({ title: "Successor", startDate: "2026-07-24", dueDate: "2026-07-30" })).body.task as { id: string };
    const overdueTask = (await leader.agent
      .post(`/api/projects/${project.id}/tasks`)
      .send({ title: "Overdue", startDate: "2026-07-15", dueDate: "2026-07-16" })).body.task as { id: string };
    const overdueParticipant = (await leader.agent
      .post(`/api/projects/${project.id}/tasks/${overdueTask.id}/participants`)
      .send({ userId: leader.id, startDate: "2026-07-15", endDate: "2026-07-16", estimatedMinutes: 60 })).body.participant as { id: string };
    const dependency = (await leader.agent
      .post(`/api/projects/${project.id}/tasks/${successor.id}/dependencies`)
      .send({ predecessorTaskId: predecessor.id })).body.dependency as { id: string };
    const stateBefore = fixture.database.all<{
      id: string;
      start_date: string;
      end_date: string;
      revision: number;
    }>(
      "SELECT id, start_date, end_date, revision FROM task_participants WHERE project_id=? ORDER BY id",
      [project.id],
    );
    const activityBefore = fixture.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM activity_log",
    )!.count;

    const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
    expect(schedule.body.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "overdue", participantId: overdueParticipant.id }),
        expect.objectContaining({ type: "missing_availability", participantId: overdueParticipant.id }),
        expect.objectContaining({ type: "unallocated_effort", participantId: overdueParticipant.id }),
        expect.objectContaining({ type: "dependency_inversion", dependencyId: dependency.id }),
      ]),
    );
    expect(JSON.stringify(schedule.body.conflicts)).not.toContain("suggestion");
    for (const conflict of schedule.body.conflicts) {
      expect(ScheduleConflictSchema.safeParse(conflict).success).toBe(true);
    }
    expect(
      fixture.database.all(
        "SELECT id, start_date, end_date, revision FROM task_participants WHERE project_id=? ORDER BY id",
        [project.id],
      ),
    ).toEqual(stateBefore);
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log",
      )!.count,
    ).toBe(activityBefore);
  });
});
