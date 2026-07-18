import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
  type ScheduleTestUser,
} from "./schedule-fixture.js";

interface ResourceView {
  id: string;
  title: string;
  kind: "markdown" | "file";
  revision: number;
  currentVersionNumber: number;
  archivedAt: string | null;
  deletedAt: string | null;
}

interface VersionView {
  id: string;
  versionNumber: number;
  originalFilename: string;
  byteSize: number;
  mimeType: string;
  sha256: string;
  markdownContent: string | null;
  restoredFromVersionId: string | null;
}

function storedBlobKeys(uploadPath: string): string[] {
  return fs.existsSync(uploadPath)
    ? fs.readdirSync(uploadPath).filter((name) => /^[a-f0-9]{64}$/.test(name))
    : [];
}

describe("v2 project resources", () => {
  let directory: string;
  let uploadPath: string;
  let fixture: ScheduleFixture;
  let leader: ScheduleTestUser;
  let outsider: ScheduleTestUser;
  let projectId: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-resources-"));
    uploadPath = path.join(directory, "uploads");
    fixture = createScheduleFixture({ uploadPath, maxUploadBytes: 32 });
    leader = await fixture.bootstrap();
    outsider = await fixture.register("resource-outsider");
    const project = await fixture.createProject(leader);
    projectId = project.id;
  });

  afterEach(() => {
    fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function createMarkdown(
    title = "Experiment notes",
    markdownContent = "# First result\n",
  ): Promise<{ resource: ResourceView; version: VersionView }> {
    const response = await leader.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({
          kind: "markdown",
          title,
          markdownContent,
          versionNote: "Initial draft",
          tagIds: [],
        }),
      );
    expect(response.status).toBe(201);
    return response.body as { resource: ResourceView; version: VersionView };
  }

  it("appends immutable Markdown versions and restores an old version as a new one", async () => {
    const created = await createMarkdown();
    expect(created.resource).toMatchObject({
      kind: "markdown",
      currentVersionNumber: 1,
      revision: 1,
    });
    expect(created.version).toMatchObject({
      versionNumber: 1,
      markdownContent: "# First result\n",
      restoredFromVersionId: null,
    });

    const second = await leader.agent
      .post(`/api/projects/${projectId}/resources/${created.resource.id}/versions`)
      .field(
        "metadata",
        JSON.stringify({
          expectedRevision: created.resource.revision,
          markdownContent: "# Revised result\n",
          versionNote: "After supervisor review",
        }),
      );
    expect(second.status).toBe(201);
    expect(second.body.resource).toMatchObject({
      currentVersionNumber: 2,
      revision: 2,
    });

    const restored = await leader.agent
      .post(
        `/api/projects/${projectId}/resources/${created.resource.id}/versions/${created.version.id}/restore`,
      )
      .send({ expectedRevision: 2, versionNote: "Restore accepted draft" });
    expect(restored.status).toBe(201);
    expect(restored.body.resource).toMatchObject({
      currentVersionNumber: 3,
      revision: 3,
    });
    expect(restored.body.version).toMatchObject({
      versionNumber: 3,
      markdownContent: "# First result\n",
      restoredFromVersionId: created.version.id,
    });

    const detail = await leader.agent.get(
      `/api/projects/${projectId}/resources/${created.resource.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.versions.map((version: VersionView) => version.versionNumber)).toEqual([
      3, 2, 1,
    ]);
  });

  it("stores file uploads by digest, forces authenticated attachment downloads, and isolates projects", async () => {
    const bytes = Buffer.from("raw-research-data");
    const created = await leader.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({
          kind: "file",
          title: "Raw data",
          versionNote: "Instrument export",
          tagIds: [],
        }),
      )
      .attach("file", bytes, {
        filename: "results.csv",
        contentType: "text/csv",
      });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.version).toMatchObject({
      originalFilename: "results.csv",
      byteSize: bytes.length,
      mimeType: "text/csv",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const storedFiles = storedBlobKeys(uploadPath);
    expect(storedFiles).toHaveLength(1);
    expect(storedFiles[0]).toMatch(/^[a-f0-9]{64}$/);

    const downloadPath = `/api/projects/${projectId}/resources/${created.body.resource.id}/versions/${created.body.version.id}/download`;
    const download = await leader.agent.get(downloadPath);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(download.text)).toEqual(bytes);

    const hidden = await outsider.agent.get(downloadPath);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("rejects stale updates and pins a fulfilled deliverable to the selected resource version", async () => {
    const created = await createMarkdown();
    const stale = await leader.agent
      .patch(`/api/projects/${projectId}/resources/${created.resource.id}`)
      .send({ expectedRevision: 99, title: "Stale title" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: "REVISION_CONFLICT",
      latest: { id: created.resource.id, revision: 1 },
    });

    const task = await leader.agent.post(`/api/projects/${projectId}/tasks`).send({
      title: "Submit paper",
      startDate: "2026-07-20",
      dueDate: "2026-08-20",
    });
    expect(task.status).toBe(201);
    const deliverable = await leader.agent
      .post(`/api/projects/${projectId}/tasks/${task.body.task.id}/deliverables`)
      .send({ title: "Manuscript" });
    expect(deliverable.status).toBe(201);

    const fulfilled = await leader.agent
      .post(
        `/api/projects/${projectId}/deliverables/${deliverable.body.deliverable.id}/fulfill`,
      )
      .send({
        expectedRevision: deliverable.body.deliverable.revision,
        resourceId: created.resource.id,
      });
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.deliverable.fulfilledResourceVersionId).toBe(
      created.version.id,
    );

    const nextVersion = await leader.agent
      .post(`/api/projects/${projectId}/resources/${created.resource.id}/versions`)
      .field(
        "metadata",
        JSON.stringify({
          expectedRevision: created.resource.revision,
          markdownContent: "# New draft\n",
          versionNote: "Continued editing",
        }),
      );
    expect(nextVersion.status, JSON.stringify(nextVersion.body)).toBe(201);
    const reread = await leader.agent.get(
      `/api/projects/${projectId}/deliverables/${deliverable.body.deliverable.id}`,
    );
    expect(reread.body.deliverable.fulfilledResourceVersionId).toBe(
      created.version.id,
    );
  });

  it("moves resources through archive and the 30-day trash before permanent deletion", async () => {
    const created = await createMarkdown("Discarded notes");
    const archived = await leader.agent
      .post(`/api/projects/${projectId}/resources/${created.resource.id}/archive`)
      .send({ expectedRevision: created.resource.revision });
    expect(archived.status).toBe(200);
    expect(archived.body.resource.archivedAt).not.toBeNull();

    const trashed = await leader.agent
      .delete(`/api/projects/${projectId}/resources/${created.resource.id}`)
      .send({ expectedRevision: archived.body.resource.revision });
    expect(trashed.status).toBe(200);
    expect(trashed.body.resource.deletedAt).not.toBeNull();

    const trash = await leader.agent.get(`/api/projects/${projectId}/trash/resources`);
    expect(trash.status).toBe(200);
    expect(trash.body.resources).toHaveLength(1);

    const restored = await leader.agent
      .post(`/api/projects/${projectId}/resources/${created.resource.id}/restore`)
      .send({ expectedRevision: trashed.body.resource.revision });
    expect(restored.status).toBe(200);
    expect(restored.body.resource).toMatchObject({ deletedAt: null, archivedAt: null });

    const trashedAgain = await leader.agent
      .delete(`/api/projects/${projectId}/resources/${created.resource.id}`)
      .send({ expectedRevision: restored.body.resource.revision });
    const permanent = await leader.agent
      .delete(`/api/projects/${projectId}/resources/${created.resource.id}/permanent`)
      .send({
        expectedRevision: trashedAgain.body.resource.revision,
        confirmation: "PERMANENT_DELETE",
      });
    expect(permanent.status).toBe(200);
    expect(permanent.body).toEqual({ deleted: true });
    expect(storedBlobKeys(uploadPath)).toEqual([]);
  });

  it("rejects oversized files without leaving partial blobs or database rows", async () => {
    const response = await leader.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({ kind: "file", title: "Too large", tagIds: [] }),
      )
      .attach("file", Buffer.alloc(33, 1), "large.bin");

    expect(response.status, JSON.stringify(response.body)).toBe(413);
    expect(response.body.error.code).toBe("UPLOAD_TOO_LARGE");
    expect(storedBlobKeys(uploadPath)).toEqual([]);
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM resources WHERE project_id=?",
        [projectId],
      ),
    ).toEqual({ count: 0 });
  });

  it("manages project tags and filters resources by tag", async () => {
    const createdTag = await leader.agent.post(`/api/projects/${projectId}/tags`).send({
      name: "Paper",
      color: "#2563eb",
    });
    expect(createdTag.status).toBe(201);
    const tag = createdTag.body.tag as { id: string; revision: number };

    const created = await leader.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({
          kind: "markdown",
          title: "Tagged notes",
          markdownContent: "# Notes",
          versionNote: "Initial",
          tagIds: [tag.id],
        }),
      );
    expect(created.status).toBe(201);
    expect(created.body.resource.tags).toEqual([
      expect.objectContaining({ id: tag.id, name: "Paper", color: "#2563eb" }),
    ]);

    const filtered = await leader.agent.get(
      `/api/projects/${projectId}/resources?tagId=${tag.id}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.resources.map((resource: ResourceView) => resource.id)).toEqual([
      created.body.resource.id,
    ]);

    const renamed = await leader.agent
      .patch(`/api/projects/${projectId}/tags/${tag.id}`)
      .send({ expectedRevision: tag.revision, name: "Manuscript" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.tag).toMatchObject({ name: "Manuscript", revision: 2 });

    const removed = await leader.agent
      .delete(`/api/projects/${projectId}/tags/${tag.id}`)
      .send({ expectedRevision: 2 });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    const detail = await leader.agent.get(
      `/api/projects/${projectId}/resources/${created.body.resource.id}`,
    );
    expect(detail.body.resource.tags).toEqual([]);
  });

  it("rejects unauthorized file uploads before initializing project storage", async () => {
    const response = await outsider.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({
          kind: "file",
          title: "Unauthorized payload",
          versionNote: "Must not be written",
          tagIds: [],
        }),
      )
      .attach("file", Buffer.alloc(32, 1), "payload.bin");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PROJECT_NOT_FOUND");
    expect(fs.existsSync(uploadPath)).toBe(false);
  });

  it("requires a deliverable to be unfulfilled before its resource enters trash", async () => {
    const created = await createMarkdown("Required report");
    const task = await leader.agent
      .post(`/api/projects/${projectId}/tasks`)
      .send({ title: "Submit report" });
    const deliverable = await leader.agent
      .post(`/api/projects/${projectId}/tasks/${task.body.task.id}/deliverables`)
      .send({ title: "Report" });
    await leader.agent
      .post(`/api/projects/${projectId}/deliverables/${deliverable.body.deliverable.id}/fulfill`)
      .send({
        expectedRevision: deliverable.body.deliverable.revision,
        resourceId: created.resource.id,
      });

    const blocked = await leader.agent
      .delete(`/api/projects/${projectId}/resources/${created.resource.id}`)
      .send({ expectedRevision: created.resource.revision });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("RESOURCE_IN_USE");
    expect(
      fixture.database.get<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM resources WHERE id=?",
        [created.resource.id],
      ),
    ).toEqual({ deleted_at: null });
  });

  it("rejects restoring a file version when its stored bytes no longer match the recorded digest", async () => {
    const bytes = Buffer.from("original-file");
    const created = await leader.agent
      .post(`/api/projects/${projectId}/resources`)
      .field(
        "metadata",
        JSON.stringify({ kind: "file", title: "Raw result", versionNote: "Initial", tagIds: [] }),
      )
      .attach("file", bytes, "result.bin");
    expect(created.status).toBe(201);
    const stored = fixture.database.get<{ storage_key: string }>(
      "SELECT storage_key FROM resource_versions WHERE id=?",
      [created.body.version.id],
    )!;
    fs.writeFileSync(path.join(uploadPath, stored.storage_key), Buffer.from("tampered-file"));

    const restored = await leader.agent
      .post(
        `/api/projects/${projectId}/resources/${created.body.resource.id}/versions/${created.body.version.id}/restore`,
      )
      .send({ expectedRevision: created.body.resource.revision, versionNote: "Restore" });
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe("RESOURCE_STORAGE_CORRUPT");
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id=?",
        [created.body.resource.id],
      ),
    ).toEqual({ count: 1 });
    expect(storedBlobKeys(uploadPath)).toEqual([stored.storage_key]);
  });
});
