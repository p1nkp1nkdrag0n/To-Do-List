import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BlobStore } from "../../../server/modules/resources/blob-store.js";
import { purgeExpiredTrash } from "../../../server/modules/trash-housekeeping.js";
import { createScheduleFixture } from "../http/schedule-fixture.js";

describe("trash housekeeping", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("purges expired task progress and resource blobs while retaining failed work for retry", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-trash-purge-"));
    directories.push(directory);
    const uploadPath = path.join(directory, "uploads");
    const fixture = createScheduleFixture({ uploadPath, maxUploadBytes: 1_024 });
    try {
      const leader = await fixture.bootstrap();
      const project = await fixture.createProject(leader);
      const task = (
        await leader.agent
          .post(`/api/projects/${project.id}/tasks`)
          .send({ title: "Expired task" })
      ).body.task as { id: string; revision: number };
      const assignment = await leader.agent
        .post(`/api/projects/${project.id}/tasks/${task.id}/participants`)
        .send({
          userId: leader.id,
          startDate: "2026-07-20",
          endDate: "2026-07-20",
          estimatedMinutes: 60,
        });
      await leader.agent
        .post(`/api/projects/${project.id}/participants/${assignment.body.participant.id}/progress`)
        .send({
          participantExpectedRevision: assignment.body.participant.revision,
          completionPercent: 20,
          summary: "Started.",
          blockers: "",
          nextSteps: "Continue.",
        });
      const latestTask = await leader.agent.get(`/api/projects/${project.id}/tasks/${task.id}`);
      const scheduleBeforeTrash = await leader.agent.get(`/api/projects/${project.id}/schedule`);
      await leader.agent
        .delete(`/api/projects/${project.id}/tasks/${task.id}`)
        .send({
          expectedRevision: latestTask.body.task.revision,
          expectedScheduleRevision: scheduleBeforeTrash.body.revision,
        });

      const resource = await leader.agent
        .post(`/api/projects/${project.id}/resources`)
        .field(
          "metadata",
          JSON.stringify({
            kind: "file",
            title: "Expired file",
            versionNote: "Initial",
            tagIds: [],
          }),
        )
        .attach("file", Buffer.from("payload"), "payload.bin");
      await leader.agent
        .delete(`/api/projects/${project.id}/resources/${resource.body.resource.id}`)
        .send({ expectedRevision: resource.body.resource.revision });
      fixture.database.run(
        "UPDATE tasks SET purge_after='2026-07-17T07:59:59.000Z' WHERE id=?",
        [task.id],
      );
      fixture.database.run(
        "UPDATE resources SET purge_after='2026-07-17T07:59:59.000Z' WHERE id=?",
        [resource.body.resource.id],
      );

      const result = await purgeExpiredTrash({
        database: fixture.database,
        blobStore: new BlobStore({ rootPath: uploadPath, maxUploadBytes: 1_024 }),
        clock: () => new Date("2026-07-17T08:00:00.000Z"),
        idGenerator: randomUUID,
      });

      expect(result).toEqual({ projects: 0, tasks: 1, resources: 1, blobsDeleted: 1, blobsFailed: 0 });
      expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [task.id])).toBeUndefined();
      expect(
        fixture.database.get("SELECT id FROM progress_updates WHERE participant_id=?", [
          assignment.body.participant.id,
        ]),
      ).toBeUndefined();
      expect(
        fixture.database.get("SELECT id FROM resources WHERE id=?", [resource.body.resource.id]),
      ).toBeUndefined();
      expect(
        fs.readdirSync(uploadPath).filter((name) => /^[a-f0-9]{64}$/.test(name)),
      ).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("does not cascade an expired parent into a descendant whose retention has not elapsed", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-trash-retention-"));
    directories.push(directory);
    const uploadPath = path.join(directory, "uploads");
    const fixture = createScheduleFixture({ uploadPath, maxUploadBytes: 1_024 });
    try {
      const leader = await fixture.bootstrap();
      const project = await fixture.createProject(leader);
      const parent = (
        await leader.agent.post(`/api/projects/${project.id}/tasks`).send({ title: "Parent" })
      ).body.task as { id: string; revision: number };
      const child = (
        await leader.agent
          .post(`/api/projects/${project.id}/tasks`)
          .send({ title: "Child", parentId: parent.id })
      ).body.task as { id: string };
      const schedule = await leader.agent.get(`/api/projects/${project.id}/schedule`);
      const trashed = await leader.agent
        .delete(`/api/projects/${project.id}/tasks/${parent.id}`)
        .send({
          expectedRevision: parent.revision,
          expectedScheduleRevision: schedule.body.revision,
        });
      expect(trashed.status).toBe(200);
      fixture.database.run("UPDATE tasks SET purge_after=? WHERE id=?", [
        "2026-07-17T07:59:59.000Z",
        parent.id,
      ]);
      fixture.database.run("UPDATE tasks SET purge_after=? WHERE id=?", [
        "2026-07-19T08:00:00.000Z",
        child.id,
      ]);

      const first = await purgeExpiredTrash({
        database: fixture.database,
        blobStore: new BlobStore({ rootPath: uploadPath, maxUploadBytes: 1_024 }),
        clock: () => new Date("2026-07-18T08:00:00.000Z"),
        idGenerator: randomUUID,
      });
      expect(first.tasks).toBe(0);
      expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [parent.id])).toBeDefined();
      expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [child.id])).toBeDefined();

      const second = await purgeExpiredTrash({
        database: fixture.database,
        blobStore: new BlobStore({ rootPath: uploadPath, maxUploadBytes: 1_024 }),
        clock: () => new Date("2026-07-20T08:00:00.000Z"),
        idGenerator: randomUUID,
      });
      expect(second.tasks).toBe(1);
      expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [parent.id])).toBeUndefined();
      expect(fixture.database.get("SELECT id FROM tasks WHERE id=?", [child.id])).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});
