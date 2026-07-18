import { describe, expect, it } from "vitest";

import {
  AddResourceVersionMetadataSchema,
  ArchiveResourceSchema,
  CreateResourceMetadataSchema,
  DeleteResourceSchema,
  MAX_MARKDOWN_BYTES,
  PatchResourceSchema,
  PermanentDeleteResourceSchema,
  ResourceEntitySchema,
  ResourceListFiltersSchema,
  ResourceVersionEntitySchema,
  RestoreResourceSchema,
  RestoreVersionSchema,
  TagEntitySchema,
  TrashEntitySchema,
} from "../../shared/resource-contracts.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000002";
const VERSION_ID = "00000000-0000-4000-8000-000000000003";
const PHASE_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000005";
const USER_ID = "00000000-0000-4000-8000-000000000006";
const TAG_ID = "00000000-0000-4000-8000-000000000007";
const NOW = "2026-07-18T08:00:00.000Z";

describe("resource request contracts", () => {
  it("accepts markdown creation metadata and rejects unknown fields", () => {
    const input = {
      kind: "markdown" as const,
      title: "Experiment notes",
      phaseId: PHASE_ID,
      sourceTaskId: TASK_ID,
      tagIds: [TAG_ID],
      markdownContent: "# Result\n\nPassed.",
      versionNote: "Initial draft",
    };

    expect(CreateResourceMetadataSchema.parse(input)).toEqual(input);
    expect(
      CreateResourceMetadataSchema.safeParse({ ...input, extra: true }).success,
    ).toBe(false);
  });

  it("keeps file creation metadata free of markdown content", () => {
    const input = {
      kind: "file" as const,
      title: "Submission package",
      tagIds: [TAG_ID],
      versionNote: "Competition release",
    };

    expect(CreateResourceMetadataSchema.parse(input)).toEqual(input);
    expect(
      CreateResourceMetadataSchema.safeParse({
        ...input,
        markdownContent: "must come from the uploaded file",
      }).success,
    ).toBe(false);
  });

  it("enforces title, markdown UTF-8 byte, and version note limits", () => {
    const base = {
      kind: "markdown" as const,
      title: "x".repeat(200),
      markdownContent: "a".repeat(MAX_MARKDOWN_BYTES),
      versionNote: "n".repeat(2_000),
    };

    expect(CreateResourceMetadataSchema.safeParse(base).success).toBe(true);
    expect(
      CreateResourceMetadataSchema.safeParse({
        ...base,
        title: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      CreateResourceMetadataSchema.safeParse({
        ...base,
        markdownContent: `${base.markdownContent}a`,
      }).success,
    ).toBe(false);
    expect(
      CreateResourceMetadataSchema.safeParse({
        ...base,
        markdownContent: "界".repeat(Math.floor(MAX_MARKDOWN_BYTES / 3) + 1),
      }).success,
    ).toBe(false);
    expect(
      CreateResourceMetadataSchema.safeParse({
        ...base,
        versionNote: "n".repeat(2_001),
      }).success,
    ).toBe(false);
  });

  it("accepts version metadata with service-validated optional markdown", () => {
    const input = {
      expectedRevision: 3,
      versionNote: "Restore citations",
      markdownContent: "Updated body",
    };

    expect(AddResourceVersionMetadataSchema.parse(input)).toEqual(input);
    expect(
      AddResourceVersionMetadataSchema.safeParse({
        expectedRevision: 0,
        versionNote: "invalid revision",
      }).success,
    ).toBe(false);
    expect(
      AddResourceVersionMetadataSchema.safeParse({
        expectedRevision: 3,
      }).success,
    ).toBe(false);
  });

  it("requires a real patch and deduplicates tag ids in insertion order", () => {
    const otherTagId = "00000000-0000-4000-8000-000000000008";
    expect(
      PatchResourceSchema.parse({
        expectedRevision: 2,
        tagIds: [TAG_ID, otherTagId, TAG_ID],
      }),
    ).toEqual({ expectedRevision: 2, tagIds: [TAG_ID, otherTagId] });
    expect(
      PatchResourceSchema.safeParse({ expectedRevision: 2 }).success,
    ).toBe(false);
    expect(
      PatchResourceSchema.safeParse({
        expectedRevision: 2,
        kind: "file",
      }).success,
    ).toBe(false);
  });

  it("defines restore and lifecycle revision contracts with explicit permanent confirmation", () => {
    expect(
      RestoreVersionSchema.parse({
        expectedRevision: 4,
        versionNote: "Restore version 1",
      }),
    ).toEqual({ expectedRevision: 4, versionNote: "Restore version 1" });

    for (const schema of [
      ArchiveResourceSchema,
      DeleteResourceSchema,
      RestoreResourceSchema,
    ]) {
      expect(schema.parse({ expectedRevision: 4 })).toEqual({
        expectedRevision: 4,
      });
      expect(
        schema.safeParse({ expectedRevision: 4, extra: true }).success,
      ).toBe(false);
    }

    expect(
      PermanentDeleteResourceSchema.parse({
        expectedRevision: 4,
        confirmation: "PERMANENT_DELETE",
      }),
    ).toEqual({
      expectedRevision: 4,
      confirmation: "PERMANENT_DELETE",
    });
    expect(
      PermanentDeleteResourceSchema.safeParse({
        expectedRevision: 4,
        confirmation: true,
      }).success,
    ).toBe(false);
  });

  it("parses strict list filters including a false archived flag", () => {
    expect(
      ResourceListFiltersSchema.parse({
        phaseId: PHASE_ID,
        sourceTaskId: TASK_ID,
        tagId: TAG_ID,
        includeArchived: "false",
      }),
    ).toEqual({
      phaseId: PHASE_ID,
      sourceTaskId: TASK_ID,
      tagId: TAG_ID,
      includeArchived: false,
    });
    expect(
      ResourceListFiltersSchema.parse({ includeArchived: true }),
    ).toEqual({ includeArchived: true });
    expect(
      ResourceListFiltersSchema.safeParse({ includeArchived: "yes" }).success,
    ).toBe(false);
    expect(
      ResourceListFiltersSchema.safeParse({ unknown: "value" }).success,
    ).toBe(false);
  });
});

describe("resource response contracts", () => {
  const tag = {
    id: TAG_ID,
    projectId: PROJECT_ID,
    name: "submission",
    color: "#1a73e8",
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  };

  const resource = {
    id: RESOURCE_ID,
    projectId: PROJECT_ID,
    phaseId: PHASE_ID,
    sourceTaskId: TASK_ID,
    kind: "markdown" as const,
    title: "Experiment notes",
    currentVersionNumber: 2,
    tags: [tag],
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 3,
    archivedAt: null,
    archivedBy: null,
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
  };

  const version = {
    id: VERSION_ID,
    resourceId: RESOURCE_ID,
    versionNumber: 2,
    originalFilename: "Experiment notes.md",
    byteSize: 12,
    mimeType: "text/markdown",
    sha256: "a".repeat(64),
    markdownContent: "# Result",
    restoredFromVersionId: null,
    versionNote: "Reviewed",
    createdBy: USER_ID,
    createdAt: NOW,
  };

  const trash = {
    id: RESOURCE_ID,
    projectId: PROJECT_ID,
    entityType: "resource" as const,
    title: "Experiment notes",
    deletedAt: NOW,
    deletedBy: USER_ID,
    purgeAfter: "2026-08-17T08:00:00.000Z",
    revision: 4,
  };

  it("accepts strict resource, version, tag, and trash entities", () => {
    expect(TagEntitySchema.parse(tag)).toEqual(tag);
    expect(ResourceEntitySchema.parse(resource)).toEqual(resource);
    expect(ResourceVersionEntitySchema.parse(version)).toEqual(version);
    expect(TrashEntitySchema.parse(trash)).toEqual(trash);

    expect(
      ResourceEntitySchema.safeParse({ ...resource, privatePath: "secret" })
        .success,
    ).toBe(false);
    expect(
      ResourceVersionEntitySchema.safeParse({
        ...version,
        storageKey: "b".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("validates resource metadata fields and trash lifecycle timestamps", () => {
    expect(
      ResourceEntitySchema.safeParse({
        ...resource,
        currentVersionNumber: -1,
      }).success,
    ).toBe(false);
    expect(
      ResourceVersionEntitySchema.safeParse({
        ...version,
        sha256: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      TrashEntitySchema.safeParse({ ...trash, purgeAfter: null }).success,
    ).toBe(false);
  });
});
