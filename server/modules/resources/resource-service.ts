import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type {
  AddResourceVersionMetadata,
  CreateTagRequest,
  CreateResourceMetadata,
  PatchResource,
  PatchTagRequest,
  ResourceEntity,
  ResourceListItem,
  ResourceListFilters,
  ResourceVersionSummary,
  ResourceVersionEntity,
  RestoreVersion,
  TagEntity,
} from "../../../shared/resource-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import type { UploadedResourceFile } from "./multipart.js";
import { drainStorageGarbageQueue } from "./storage-gc.js";

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface ResourceRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  phase_id: string | null;
  source_task_id: string | null;
  kind: "markdown" | "file";
  title: string;
  current_version_number: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
  archived_at: string | null;
  archived_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_after: string | null;
  trash_batch_id: string | null;
}

interface ResourceVersionRow extends Record<string, unknown> {
  id: string;
  resource_id: string;
  version_number: number;
  original_filename: string;
  byte_size: number;
  mime_type: string;
  sha256: string;
  markdown_content: string | null;
  storage_key: string | null;
  restored_from_version_id: string | null;
  version_note: string;
  created_by: string;
  created_at: string;
}

interface TagRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  name: string;
  color: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface ResourceDetail {
  resource: ResourceEntity;
  versions: ResourceVersionEntity[];
}

export interface DownloadDescriptor {
  originalFilename: string;
  byteSize: number;
  mimeType: string;
  markdownContent: string | null;
  storageKey: string | null;
}

function toVersion(row: ResourceVersionRow): ResourceVersionEntity {
  return {
    id: row.id,
    resourceId: row.resource_id,
    versionNumber: row.version_number,
    originalFilename: row.original_filename,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    markdownContent: row.markdown_content,
    restoredFromVersionId: row.restored_from_version_id,
    versionNote: row.version_note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toVersionSummary(row: ResourceVersionRow): ResourceVersionSummary {
  return {
    id: row.id,
    versionNumber: row.version_number,
    originalFilename: row.original_filename,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toTag(row: TagRow): TagEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    color: row.color,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function markdownFilename(title: string): string {
  const normalized = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").trim();
  return `${normalized || "document"}.md`.slice(0, 255);
}

function markdownBlob(content: string): {
  byteSize: number;
  sha256: string;
  originalFilename?: never;
} {
  const bytes = Buffer.from(content, "utf8");
  return {
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export class ResourceService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  preflightCreate(auth: AuthenticatedSession, projectId: string): void {
    this.requireWritableProject(auth, projectId);
  }

  preflightVersionWrite(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
  ): void {
    this.requireWritableProject(auth, projectId);
    this.assertEditable(
      this.requireVisibleResource(auth, projectId, resourceId, false),
    );
  }

  list(
    auth: AuthenticatedSession,
    projectId: string,
    filters: ResourceListFilters,
  ): ResourceListItem[] {
    this.requireProjectMember(auth, projectId);
    const clauses = ["resources.project_id=?", "resources.deleted_at IS NULL"];
    const parameters: Array<string | number> = [projectId];
    if (!filters.includeArchived) clauses.push("resources.archived_at IS NULL");
    if (filters.phaseId !== undefined) {
      clauses.push("resources.phase_id=?");
      parameters.push(filters.phaseId);
    }
    if (filters.sourceTaskId !== undefined) {
      clauses.push("resources.source_task_id=?");
      parameters.push(filters.sourceTaskId);
    }
    if (filters.tagId !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM resource_tag_links WHERE resource_id=resources.id AND tag_id=?)",
      );
      parameters.push(filters.tagId);
    }
    return this.dependencies.database
      .all<ResourceRow>(
        `${this.resourceSelect()} WHERE ${clauses.join(" AND ")}
          ORDER BY resources.updated_at DESC, resources.title COLLATE NOCASE`,
        parameters,
      )
      .map((row) => this.toListItem(row));
  }

  listTags(auth: AuthenticatedSession, projectId: string): TagEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.dependencies.database
      .all<TagRow>(
        `SELECT id, project_id, name, color, created_by, updated_by, created_at, updated_at, revision
           FROM project_tags WHERE project_id=? ORDER BY name COLLATE NOCASE`,
        [projectId],
      )
      .map(toTag);
  }

  createTag(
    auth: AuthenticatedSession,
    projectId: string,
    input: CreateTagRequest,
  ): { tag: TagEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertTagNameAvailable(projectId, input.name);
      const id = this.dependencies.idGenerator();
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run(
        `INSERT INTO project_tags
          (id, project_id, name, color, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, projectId, input.name, input.color.toLowerCase(), auth.user.id, auth.user.id, now, now],
      );
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_tag",
        entityId: id,
        action: "resource_tag.created",
      });
      this.bumpProjectContentRevision(projectId);
      return { tag: toTag(this.requireTag(projectId, id)) };
    });
  }

  updateTag(
    auth: AuthenticatedSession,
    projectId: string,
    tagId: string,
    input: PatchTagRequest,
  ): { tag: TagEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireTag(projectId, tagId);
      if (current.revision !== input.expectedRevision) this.throwLatestTag(projectId, tagId);
      const name = input.name ?? current.name;
      this.assertTagNameAvailable(projectId, name, tagId);
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE project_tags SET name=?, color=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=?`,
        [
          name,
          (input.color ?? current.color).toLowerCase(),
          auth.user.id,
          now,
          tagId,
          projectId,
          input.expectedRevision,
        ],
      );
      if (changed.changes !== 1) this.throwLatestTag(projectId, tagId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_tag",
        entityId: tagId,
        action: "resource_tag.updated",
      });
      this.bumpProjectContentRevision(projectId);
      return { tag: toTag(this.requireTag(projectId, tagId)) };
    });
  }

  deleteTag(
    auth: AuthenticatedSession,
    projectId: string,
    tagId: string,
    expectedRevision: number,
  ): { deleted: true } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireTag(projectId, tagId);
      if (current.revision !== expectedRevision) this.throwLatestTag(projectId, tagId);
      const changed = this.dependencies.database.run(
        "DELETE FROM project_tags WHERE id=? AND project_id=? AND revision=?",
        [tagId, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestTag(projectId, tagId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project_tag",
        entityId: tagId,
        action: "resource_tag.deleted",
      });
      this.bumpProjectContentRevision(projectId);
      return { deleted: true };
    });
  }

  detail(auth: AuthenticatedSession, projectId: string, resourceId: string): ResourceDetail {
    const resource = this.requireVisibleResource(auth, projectId, resourceId, false);
    return {
      resource: this.toResource(resource),
      versions: this.versionRows(resourceId).map(toVersion),
    };
  }

  trashDetail(auth: AuthenticatedSession, projectId: string, resourceId: string): ResourceDetail {
    const resource = this.requireVisibleResource(auth, projectId, resourceId, true);
    if (resource.deleted_at === null) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The resource was not found in the trash.");
    }
    return {
      resource: this.toResource(resource),
      versions: this.versionRows(resourceId).map(toVersion),
    };
  }

  create(
    auth: AuthenticatedSession,
    projectId: string,
    metadata: CreateResourceMetadata,
    file: UploadedResourceFile | undefined,
  ): { resource: ResourceEntity; version: ResourceVersionEntity } {
    const markdownContent =
      "markdownContent" in metadata ? metadata.markdownContent : undefined;
    this.assertPayload(metadata.kind, markdownContent, file);
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertReferences(
        projectId,
        metadata.phaseId ?? null,
        metadata.sourceTaskId ?? null,
        metadata.tagIds ?? [],
      );
      const resourceId = this.dependencies.idGenerator();
      const versionId = this.dependencies.idGenerator();
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run(
        `INSERT INTO resources
          (id, project_id, phase_id, source_task_id, kind, title, current_version_number,
           created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          resourceId,
          projectId,
          metadata.phaseId ?? null,
          metadata.sourceTaskId ?? null,
          metadata.kind,
          metadata.title,
          auth.user.id,
          auth.user.id,
          now,
          now,
        ],
      );
      const version = this.versionPayload(metadata.kind, metadata.title, markdownContent, file);
      this.insertVersion({
        id: versionId,
        resourceId,
        versionNumber: 1,
        ...version,
        versionNote: metadata.versionNote ?? "",
        restoredFromVersionId: null,
        actorId: auth.user.id,
        now,
      });
      this.replaceTagLinks(projectId, resourceId, metadata.tagIds ?? [], auth.user.id, now);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: "resource.created",
        metadata: { kind: metadata.kind, versionNumber: 1 },
      });
      this.bumpProjectContentRevision(projectId);
      return {
        resource: this.toResource(this.resourceRow(projectId, resourceId)!),
        version: toVersion(this.versionRow(resourceId, versionId)!),
      };
    });
  }

  update(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    input: PatchResource,
  ): { resource: ResourceEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, false);
      this.assertEditable(current);
      this.assertRevision(current, input.expectedRevision);
      const phaseId = input.phaseId === undefined ? current.phase_id : input.phaseId;
      const sourceTaskId =
        input.sourceTaskId === undefined ? current.source_task_id : input.sourceTaskId;
      const tagIds = input.tagIds ?? this.tagRows(resourceId).map((tag) => tag.id);
      this.assertReferences(projectId, phaseId, sourceTaskId, tagIds);
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE resources SET title=?, phase_id=?, source_task_id=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=? AND archived_at IS NULL AND deleted_at IS NULL`,
        [
          input.title ?? current.title,
          phaseId,
          sourceTaskId,
          auth.user.id,
          now,
          resourceId,
          projectId,
          input.expectedRevision,
        ],
      );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      if (input.tagIds !== undefined) {
        this.replaceTagLinks(projectId, resourceId, tagIds, auth.user.id, now);
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: "resource.updated",
      });
      this.bumpProjectContentRevision(projectId);
      return { resource: this.toResource(this.resourceRow(projectId, resourceId)!) };
    });
  }

  addVersion(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    metadata: AddResourceVersionMetadata,
    file: UploadedResourceFile | undefined,
  ): { resource: ResourceEntity; version: ResourceVersionEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, false);
      this.assertEditable(current);
      this.assertRevision(current, metadata.expectedRevision);
      this.assertPayload(current.kind, metadata.markdownContent, file);
      const now = this.dependencies.clock().toISOString();
      const versionId = this.dependencies.idGenerator();
      const versionNumber = current.current_version_number + 1;
      const payload = this.versionPayload(current.kind, current.title, metadata.markdownContent, file);
      this.insertVersion({
        id: versionId,
        resourceId,
        versionNumber,
        ...payload,
        versionNote: metadata.versionNote ?? "",
        restoredFromVersionId: null,
        actorId: auth.user.id,
        now,
      });
      const changed = this.dependencies.database.run(
        `UPDATE resources SET current_version_number=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=? AND archived_at IS NULL AND deleted_at IS NULL`,
        [versionNumber, auth.user.id, now, resourceId, projectId, metadata.expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource_version",
        entityId: versionId,
        action: "resource.version_added",
        metadata: { resourceId, versionNumber },
      });
      this.bumpProjectContentRevision(projectId);
      return {
        resource: this.toResource(this.resourceRow(projectId, resourceId)!),
        version: toVersion(this.versionRow(resourceId, versionId)!),
      };
    });
  }

  async restoreVersion(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    versionId: string,
    input: RestoreVersion,
  ): Promise<{ resource: ResourceEntity; version: ResourceVersionEntity }> {
    this.requireWritableProject(auth, projectId);
    const current = this.requireVisibleResource(auth, projectId, resourceId, false);
    this.assertEditable(current);
    this.assertRevision(current, input.expectedRevision);
    const source = this.versionRow(resourceId, versionId);
    if (source === undefined) {
      throw new HttpError(404, "RESOURCE_VERSION_NOT_FOUND", "The resource version was not found.");
    }

    let copiedFile: UploadedResourceFile | undefined;
    if (source.storage_key !== null) {
      const stored = await this.dependencies.blobStore.write(
        this.dependencies.blobStore.open(source.storage_key),
      );
      copiedFile = {
        ...stored,
        originalFilename: source.original_filename,
        mimeType: source.mime_type,
      };
      if (stored.byteSize !== source.byte_size || stored.sha256 !== source.sha256) {
        await this.dependencies.blobStore.delete(stored.storageKey);
        throw new HttpError(
          409,
          "RESOURCE_STORAGE_CORRUPT",
          "The stored file no longer matches the selected resource version.",
        );
      }
    }
    try {
      return this.dependencies.database.transaction(() => {
        this.requireWritableProject(auth, projectId);
        const latest = this.requireVisibleResource(auth, projectId, resourceId, false);
        this.assertEditable(latest);
        this.assertRevision(latest, input.expectedRevision);
        const now = this.dependencies.clock().toISOString();
        const nextVersionId = this.dependencies.idGenerator();
        const nextVersionNumber = latest.current_version_number + 1;
        const payload =
          latest.kind === "markdown"
            ? this.versionPayload("markdown", latest.title, source.markdown_content ?? "", undefined)
            : this.versionPayload("file", latest.title, undefined, copiedFile);
        this.insertVersion({
          id: nextVersionId,
          resourceId,
          versionNumber: nextVersionNumber,
          ...payload,
          versionNote: input.versionNote,
          restoredFromVersionId: source.id,
          actorId: auth.user.id,
          now,
        });
        const changed = this.dependencies.database.run(
          `UPDATE resources SET current_version_number=?, updated_by=?, updated_at=?, revision=revision+1
            WHERE id=? AND project_id=? AND revision=? AND archived_at IS NULL AND deleted_at IS NULL`,
          [nextVersionNumber, auth.user.id, now, resourceId, projectId, input.expectedRevision],
        );
        if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "resource_version",
          entityId: nextVersionId,
          action: "resource.version_restored",
          metadata: { resourceId, sourceVersionId: source.id, versionNumber: nextVersionNumber },
        });
        this.bumpProjectContentRevision(projectId);
        return {
          resource: this.toResource(this.resourceRow(projectId, resourceId)!),
          version: toVersion(this.versionRow(resourceId, nextVersionId)!),
        };
      });
    } catch (error) {
      if (copiedFile !== undefined) {
        await this.dependencies.blobStore.delete(copiedFile.storageKey);
      }
      throw error;
    }
  }

  download(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    versionId: string,
  ): DownloadDescriptor {
    this.requireVisibleResource(auth, projectId, resourceId, false);
    const version = this.versionRow(resourceId, versionId);
    if (version === undefined) {
      throw new HttpError(404, "RESOURCE_VERSION_NOT_FOUND", "The resource version was not found.");
    }
    return {
      originalFilename: version.original_filename,
      byteSize: version.byte_size,
      mimeType: version.mime_type,
      markdownContent: version.markdown_content,
      storageKey: version.storage_key,
    };
  }

  archive(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): { resource: ResourceEntity } {
    return this.changeArchive(auth, projectId, resourceId, expectedRevision, true);
  }

  unarchive(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): { resource: ResourceEntity } {
    return this.changeArchive(auth, projectId, resourceId, expectedRevision, false);
  }

  trash(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): { resource: ResourceEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, false);
      this.assertRevision(current, expectedRevision);
      this.assertResourceUnused(projectId, resourceId);
      const nowDate = this.dependencies.clock();
      const now = nowDate.toISOString();
      const purgeAfter = new Date(nowDate.getTime() + TRASH_RETENTION_MS).toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE resources SET deleted_at=?, deleted_by=?, purge_after=?, trash_batch_id=?,
                updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=? AND deleted_at IS NULL`,
        [
          now,
          auth.user.id,
          purgeAfter,
          this.dependencies.idGenerator(),
          auth.user.id,
          now,
          resourceId,
          projectId,
          expectedRevision,
        ],
      );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: "resource.trashed",
      });
      this.bumpProjectContentRevision(projectId);
      return { resource: this.toResource(this.resourceRow(projectId, resourceId)!) };
    });
  }

  trashList(auth: AuthenticatedSession, projectId: string): ResourceListItem[] {
    this.requireProjectMember(auth, projectId);
    return this.dependencies.database
      .all<ResourceRow>(
        `${this.resourceSelect()} WHERE resources.project_id=? AND resources.deleted_at IS NOT NULL
          ORDER BY resources.deleted_at DESC, resources.title COLLATE NOCASE`,
        [projectId],
      )
      .map((row) => this.toListItem(row));
  }

  restore(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): { resource: ResourceEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, true);
      this.assertRevision(current, expectedRevision);
      if (current.deleted_at === null) {
        throw new HttpError(409, "RESOURCE_NOT_TRASHED", "The resource is not in the trash.", {
          latest: this.toResource(current),
        });
      }
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE resources SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, trash_batch_id=NULL,
                archived_at=NULL, archived_by=NULL, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=? AND deleted_at IS NOT NULL`,
        [auth.user.id, now, resourceId, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: "resource.restored",
      });
      this.bumpProjectContentRevision(projectId);
      return { resource: this.toResource(this.resourceRow(projectId, resourceId)!) };
    });
  }

  async permanentlyDelete(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
  ): Promise<{ deleted: true }> {
    this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, true);
      this.assertRevision(current, expectedRevision);
      if (current.deleted_at === null) {
        throw new HttpError(409, "RESOURCE_NOT_TRASHED", "Only trashed resources can be deleted permanently.");
      }
      const changed = this.dependencies.database.run(
        "DELETE FROM resources WHERE id=? AND project_id=? AND revision=? AND deleted_at IS NOT NULL",
        [resourceId, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: "resource.permanently_deleted",
      });
      this.bumpProjectContentRevision(projectId);
    });
    await drainStorageGarbageQueue(this.dependencies);
    return { deleted: true };
  }

  private changeArchive(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    expectedRevision: number,
    archived: boolean,
  ): { resource: ResourceEntity } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      const current = this.requireVisibleResource(auth, projectId, resourceId, false);
      this.assertRevision(current, expectedRevision);
      if ((current.archived_at !== null) === archived) {
        throw new HttpError(
          409,
          archived ? "RESOURCE_ALREADY_ARCHIVED" : "RESOURCE_NOT_ARCHIVED",
          archived ? "The resource is already archived." : "The resource is not archived.",
          { latest: this.toResource(current) },
        );
      }
      const now = this.dependencies.clock().toISOString();
      const changed = archived
        ? this.dependencies.database.run(
            `UPDATE resources SET archived_at=?, archived_by=?, updated_by=?, updated_at=?, revision=revision+1
              WHERE id=? AND project_id=? AND revision=? AND archived_at IS NULL AND deleted_at IS NULL`,
            [now, auth.user.id, auth.user.id, now, resourceId, projectId, expectedRevision],
          )
        : this.dependencies.database.run(
            `UPDATE resources SET archived_at=NULL, archived_by=NULL, updated_by=?, updated_at=?, revision=revision+1
              WHERE id=? AND project_id=? AND revision=? AND archived_at IS NOT NULL AND deleted_at IS NULL`,
            [auth.user.id, now, resourceId, projectId, expectedRevision],
          );
      if (changed.changes !== 1) this.throwLatest(projectId, resourceId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "resource",
        entityId: resourceId,
        action: archived ? "resource.archived" : "resource.unarchived",
      });
      this.bumpProjectContentRevision(projectId);
      return { resource: this.toResource(this.resourceRow(projectId, resourceId)!) };
    });
  }

  private resourceSelect(): string {
    return `SELECT resources.id, resources.project_id, resources.phase_id, resources.source_task_id,
                   resources.kind, resources.title, resources.current_version_number,
                   resources.created_by, resources.updated_by, resources.created_at, resources.updated_at,
                   resources.revision, resources.archived_at, resources.archived_by,
                   resources.deleted_at, resources.deleted_by, resources.purge_after, resources.trash_batch_id
              FROM resources`;
  }

  private bumpProjectContentRevision(projectId: string): void {
    const changed = this.dependencies.database.run(
      "UPDATE projects SET schedule_revision=schedule_revision+1 WHERE id=? AND deleted_at IS NULL",
      [projectId],
    );
    if (changed.changes !== 1) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
  }

  private versionSelect(): string {
    return `SELECT id, resource_id, version_number, original_filename, byte_size, mime_type, sha256,
                   markdown_content, storage_key, restored_from_version_id, version_note, created_by, created_at
              FROM resource_versions`;
  }

  private resourceRow(projectId: string, resourceId: string): ResourceRow | undefined {
    return this.dependencies.database.get<ResourceRow>(
      `${this.resourceSelect()} WHERE resources.project_id=? AND resources.id=?`,
      [projectId, resourceId],
    );
  }

  private versionRow(resourceId: string, versionId: string): ResourceVersionRow | undefined {
    return this.dependencies.database.get<ResourceVersionRow>(
      `${this.versionSelect()} WHERE resource_id=? AND id=?`,
      [resourceId, versionId],
    );
  }

  private versionRows(resourceId: string): ResourceVersionRow[] {
    return this.dependencies.database.all<ResourceVersionRow>(
      `${this.versionSelect()} WHERE resource_id=? ORDER BY version_number DESC`,
      [resourceId],
    );
  }

  private tagRows(resourceId: string): TagRow[] {
    return this.dependencies.database.all<TagRow>(
      `SELECT project_tags.id, project_tags.project_id, project_tags.name, project_tags.color,
              project_tags.created_by, project_tags.updated_by, project_tags.created_at,
              project_tags.updated_at, project_tags.revision
         FROM project_tags JOIN resource_tag_links ON resource_tag_links.tag_id=project_tags.id
        WHERE resource_tag_links.resource_id=? ORDER BY project_tags.name COLLATE NOCASE`,
      [resourceId],
    );
  }

  private requireTag(projectId: string, tagId: string): TagRow {
    const row = this.dependencies.database.get<TagRow>(
      `SELECT id, project_id, name, color, created_by, updated_by, created_at, updated_at, revision
         FROM project_tags WHERE project_id=? AND id=?`,
      [projectId, tagId],
    );
    if (row === undefined) {
      throw new HttpError(404, "RESOURCE_TAG_NOT_FOUND", "The resource tag was not found.");
    }
    return row;
  }

  private assertTagNameAvailable(projectId: string, name: string, excludedId?: string): void {
    const existing = this.dependencies.database.get<{ id: string }>(
      `SELECT id FROM project_tags WHERE project_id=? AND name=? COLLATE NOCASE
        AND (? IS NULL OR id<>?) LIMIT 1`,
      [projectId, name, excludedId ?? null, excludedId ?? null],
    );
    if (existing !== undefined) {
      throw new HttpError(409, "RESOURCE_TAG_NAME_CONFLICT", "A project tag already uses this name.", {
        fieldErrors: { name: ["Choose a different tag name."] },
      });
    }
  }

  private throwLatestTag(projectId: string, tagId: string): never {
    const latest = this.dependencies.database.get<TagRow>(
      `SELECT id, project_id, name, color, created_by, updated_by, created_at, updated_at, revision
         FROM project_tags WHERE project_id=? AND id=?`,
      [projectId, tagId],
    );
    if (latest === undefined) {
      throw new HttpError(404, "RESOURCE_TAG_NOT_FOUND", "The resource tag was not found.");
    }
    throw new HttpError(409, "REVISION_CONFLICT", "The resource tag changed on another client.", {
      latest: toTag(latest),
    });
  }

  private toResource(row: ResourceRow): ResourceEntity {
    return {
      id: row.id,
      projectId: row.project_id,
      phaseId: row.phase_id,
      sourceTaskId: row.source_task_id,
      kind: row.kind,
      title: row.title,
      currentVersionNumber: row.current_version_number,
      tags: this.tagRows(row.id).map(toTag),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      archivedAt: row.archived_at,
      archivedBy: row.archived_by,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      purgeAfter: row.purge_after,
    };
  }

  private toListItem(row: ResourceRow): ResourceListItem {
    const currentVersion = this.dependencies.database.get<ResourceVersionRow>(
      `${this.versionSelect()} WHERE resource_id=? AND version_number=?`,
      [row.id, row.current_version_number],
    );
    if (currentVersion === undefined) {
      throw new HttpError(
        500,
        "RESOURCE_VERSION_MISSING",
        "The resource current version is missing.",
      );
    }
    return {
      ...this.toResource(row),
      currentVersion: toVersionSummary(currentVersion),
    };
  }

  private requireProjectMember(auth: AuthenticatedSession, projectId: string): { archived_at: string | null } {
    const project = this.dependencies.database.get<{ archived_at: string | null }>(
      `SELECT projects.archived_at FROM projects
        JOIN project_members ON project_members.project_id=projects.id
       WHERE projects.id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND projects.deleted_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (project === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return project;
  }

  private requireWritableProject(auth: AuthenticatedSession, projectId: string): void {
    const project = this.requireProjectMember(auth, projectId);
    if (project.archived_at !== null) {
      throw new HttpError(409, "PROJECT_ARCHIVED", "Unarchive the project before changing its resources.");
    }
  }

  private requireVisibleResource(
    auth: AuthenticatedSession,
    projectId: string,
    resourceId: string,
    includeDeleted: boolean,
  ): ResourceRow {
    const row = this.dependencies.database.get<ResourceRow>(
      `${this.resourceSelect()}
        JOIN project_members ON project_members.project_id=resources.project_id
        JOIN projects ON projects.id=resources.project_id
       WHERE resources.project_id=? AND resources.id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND projects.deleted_at IS NULL
         ${includeDeleted ? "" : "AND resources.deleted_at IS NULL"}`,
      [projectId, resourceId, auth.user.id],
    );
    if (row === undefined) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The resource was not found.");
    }
    return row;
  }

  private assertEditable(resource: ResourceRow): void {
    if (resource.archived_at !== null) {
      throw new HttpError(409, "RESOURCE_ARCHIVED", "Unarchive the resource before changing it.", {
        latest: this.toResource(resource),
      });
    }
  }

  private assertRevision(resource: ResourceRow, expectedRevision: number): void {
    if (resource.revision !== expectedRevision) {
      throw new HttpError(409, "REVISION_CONFLICT", "The resource changed on another client.", {
        latest: this.toResource(resource),
      });
    }
  }

  private throwLatest(projectId: string, resourceId: string): never {
    const latest = this.resourceRow(projectId, resourceId);
    if (latest === undefined) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The resource was not found.");
    }
    throw new HttpError(409, "REVISION_CONFLICT", "The resource changed on another client.", {
      latest: this.toResource(latest),
    });
  }

  private assertReferences(
    projectId: string,
    phaseId: string | null,
    sourceTaskId: string | null,
    tagIds: string[],
  ): void {
    if (
      phaseId !== null &&
      this.dependencies.database.get("SELECT id FROM phases WHERE id=? AND project_id=?", [phaseId, projectId]) ===
        undefined
    ) {
      throw new HttpError(400, "RESOURCE_PHASE_INVALID", "The selected phase is not in this project.");
    }
    if (
      sourceTaskId !== null &&
      this.dependencies.database.get(
        "SELECT id FROM tasks WHERE id=? AND project_id=? AND archived_at IS NULL AND deleted_at IS NULL",
        [sourceTaskId, projectId],
      ) === undefined
    ) {
      throw new HttpError(400, "RESOURCE_TASK_INVALID", "The selected source task is not active in this project.");
    }
    if (tagIds.length > 0) {
      const count = this.dependencies.database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM project_tags WHERE project_id=? AND id IN (${tagIds.map(() => "?").join(", ")})`,
        [projectId, ...tagIds],
      )!.count;
      if (count !== tagIds.length) {
        throw new HttpError(400, "RESOURCE_TAGS_INVALID", "Every selected tag must belong to this project.");
      }
    }
  }

  private replaceTagLinks(
    projectId: string,
    resourceId: string,
    tagIds: string[],
    actorId: string,
    now: string,
  ): void {
    this.dependencies.database.run("DELETE FROM resource_tag_links WHERE resource_id=?", [resourceId]);
    for (const tagId of tagIds) {
      this.dependencies.database.run(
        `INSERT INTO resource_tag_links (project_id, resource_id, tag_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [projectId, resourceId, tagId, actorId, now],
      );
    }
  }

  private assertPayload(
    kind: "markdown" | "file",
    markdownContent: string | undefined,
    file: UploadedResourceFile | undefined,
  ): void {
    if (kind === "markdown" && (markdownContent === undefined || file !== undefined)) {
      throw new HttpError(400, "RESOURCE_PAYLOAD_INVALID", "Markdown resources require content and must not include a file.");
    }
    if (kind === "file" && (file === undefined || markdownContent !== undefined)) {
      throw new HttpError(400, "RESOURCE_PAYLOAD_INVALID", "File resources require exactly one uploaded file.");
    }
  }

  private versionPayload(
    kind: "markdown" | "file",
    title: string,
    markdownContent: string | undefined,
    file: UploadedResourceFile | undefined,
  ): {
    originalFilename: string;
    byteSize: number;
    mimeType: string;
    sha256: string;
    markdownContent: string | null;
    storageKey: string | null;
  } {
    if (kind === "markdown") {
      const content = markdownContent!;
      return {
        originalFilename: markdownFilename(title),
        ...markdownBlob(content),
        mimeType: "text/markdown; charset=utf-8",
        markdownContent: content,
        storageKey: null,
      };
    }
    return {
      originalFilename: file!.originalFilename,
      byteSize: file!.byteSize,
      mimeType: file!.mimeType,
      sha256: file!.sha256,
      markdownContent: null,
      storageKey: file!.storageKey,
    };
  }

  private insertVersion(input: {
    id: string;
    resourceId: string;
    versionNumber: number;
    originalFilename: string;
    byteSize: number;
    mimeType: string;
    sha256: string;
    markdownContent: string | null;
    storageKey: string | null;
    versionNote: string;
    restoredFromVersionId: string | null;
    actorId: string;
    now: string;
  }): void {
    this.dependencies.database.run(
      `INSERT INTO resource_versions
        (id, resource_id, version_number, original_filename, byte_size, mime_type, sha256,
         markdown_content, storage_key, version_note, restored_from_version_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.resourceId,
        input.versionNumber,
        input.originalFilename,
        input.byteSize,
        input.mimeType,
        input.sha256,
        input.markdownContent,
        input.storageKey,
        input.versionNote,
        input.restoredFromVersionId,
        input.actorId,
        input.now,
      ],
    );
  }

  private assertResourceUnused(projectId: string, resourceId: string): void {
    const deliverable = this.dependencies.database.get<{ id: string }>(
      `SELECT id FROM deliverable_requirements
        WHERE project_id=? AND fulfilled_resource_id=? LIMIT 1`,
      [projectId, resourceId],
    );
    if (deliverable !== undefined) {
      throw new HttpError(
        409,
        "RESOURCE_IN_USE",
        "Unfulfill every deliverable that uses this resource before moving it to trash.",
      );
    }
  }

}
