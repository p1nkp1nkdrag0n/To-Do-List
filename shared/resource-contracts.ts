import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  ResourceKindSchema,
  RevisionSchema,
} from "./contracts.js";

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MAX_RESOURCE_TITLE_LENGTH = 200;
export const MAX_VERSION_NOTE_LENGTH = 2_000;

const ResourceTitleSchema = z.string().trim().min(1).max(MAX_RESOURCE_TITLE_LENGTH);
const VersionNoteSchema = z.string().trim().max(MAX_VERSION_NOTE_LENGTH);
const MarkdownContentSchema = z.string().refine(
  (content) => new TextEncoder().encode(content).byteLength <= MAX_MARKDOWN_BYTES,
  { message: `Markdown content must be at most ${MAX_MARKDOWN_BYTES} UTF-8 bytes.` },
);
const TagIdsSchema = z
  .array(IdSchema)
  .max(100)
  .transform((tagIds) => [...new Set(tagIds)]);
const TagNameSchema = z.string().trim().min(1).max(80);
const TagColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

const CreateResourceFields = {
  title: ResourceTitleSchema,
  phaseId: IdSchema.nullable().optional(),
  sourceTaskId: IdSchema.nullable().optional(),
  tagIds: TagIdsSchema.optional(),
  versionNote: VersionNoteSchema.optional(),
};

export const CreateResourceMetadataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("markdown"),
      ...CreateResourceFields,
      markdownContent: MarkdownContentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      ...CreateResourceFields,
    })
    .strict(),
]);

export const AddResourceVersionMetadataSchema = z
  .object({
    expectedRevision: RevisionSchema,
    versionNote: VersionNoteSchema,
    markdownContent: MarkdownContentSchema.optional(),
  })
  .strict();

export const PatchResourceSchema = z
  .object({
    expectedRevision: RevisionSchema,
    title: ResourceTitleSchema.optional(),
    phaseId: IdSchema.nullable().optional(),
    sourceTaskId: IdSchema.nullable().optional(),
    tagIds: TagIdsSchema.optional(),
  })
  .strict()
  .refine(
    ({ title, phaseId, sourceTaskId, tagIds }) =>
      title !== undefined ||
      phaseId !== undefined ||
      sourceTaskId !== undefined ||
      tagIds !== undefined,
    { message: "At least one resource field must be provided." },
  );

export const RestoreVersionSchema = z
  .object({
    expectedRevision: RevisionSchema,
    versionNote: VersionNoteSchema,
  })
  .strict();

const RevisionOnlyResourceActionSchema = z
  .object({ expectedRevision: RevisionSchema })
  .strict();

export const ArchiveResourceSchema = RevisionOnlyResourceActionSchema;
export const DeleteResourceSchema = RevisionOnlyResourceActionSchema;
export const RestoreResourceSchema = RevisionOnlyResourceActionSchema;

export const PermanentDeleteResourceSchema = z
  .object({
    expectedRevision: RevisionSchema,
    confirmation: z.literal("PERMANENT_DELETE"),
  })
  .strict();

const IncludeArchivedSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const ResourceListFiltersSchema = z
  .object({
    phaseId: IdSchema.optional(),
    sourceTaskId: IdSchema.optional(),
    tagId: IdSchema.optional(),
    includeArchived: IncludeArchivedSchema.optional(),
  })
  .strict();

export const CreateTagRequestSchema = z
  .object({ name: TagNameSchema, color: TagColorSchema })
  .strict();

export const PatchTagRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    name: TagNameSchema.optional(),
    color: TagColorSchema.optional(),
  })
  .strict()
  .refine(({ name, color }) => name !== undefined || color !== undefined, {
    message: "At least one tag field must be provided.",
  });

export const DeleteTagRequestSchema = z
  .object({ expectedRevision: RevisionSchema })
  .strict();

export const TagEntitySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    name: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    createdBy: IdSchema,
    updatedBy: IdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    revision: RevisionSchema,
  })
  .strict();

export const ResourceEntitySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    phaseId: IdSchema.nullable(),
    sourceTaskId: IdSchema.nullable(),
    kind: ResourceKindSchema,
    title: ResourceTitleSchema,
    currentVersionNumber: z.number().int().nonnegative(),
    tags: z.array(TagEntitySchema).max(100),
    createdBy: IdSchema,
    updatedBy: IdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    revision: RevisionSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
    archivedBy: IdSchema.nullable(),
    deletedAt: IsoDateTimeSchema.nullable(),
    deletedBy: IdSchema.nullable(),
    purgeAfter: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .refine(
    ({ deletedAt, purgeAfter }) =>
      (deletedAt === null && purgeAfter === null) ||
      (deletedAt !== null && purgeAfter !== null),
    {
      message: "deletedAt and purgeAfter must either both be set or both be null.",
      path: ["purgeAfter"],
    },
  );

export const ResourceVersionEntitySchema = z
  .object({
    id: IdSchema,
    resourceId: IdSchema,
    versionNumber: z.number().int().positive(),
    originalFilename: z.string().trim().min(1).max(255),
    byteSize: z.number().int().nonnegative(),
    mimeType: z.string().trim().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    markdownContent: MarkdownContentSchema.nullable(),
    restoredFromVersionId: IdSchema.nullable(),
    versionNote: VersionNoteSchema,
    createdBy: IdSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const TrashEntitySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    entityType: z.enum(["project", "task", "resource"]),
    title: ResourceTitleSchema,
    deletedAt: IsoDateTimeSchema,
    deletedBy: IdSchema.nullable(),
    purgeAfter: IsoDateTimeSchema,
    revision: RevisionSchema,
  })
  .strict();

export const PatchResourceRequestSchema = PatchResourceSchema;
export const RestoreVersionRequestSchema = RestoreVersionSchema;
export const ArchiveResourceRequestSchema = ArchiveResourceSchema;
export const DeleteResourceRequestSchema = DeleteResourceSchema;
export const RestoreResourceRequestSchema = RestoreResourceSchema;
export const PermanentDeleteResourceRequestSchema =
  PermanentDeleteResourceSchema;
export const ResourceListQuerySchema = ResourceListFiltersSchema;
export const TrashEntrySchema = TrashEntitySchema;

export type CreateResourceMetadata = z.infer<
  typeof CreateResourceMetadataSchema
>;
export type AddResourceVersionMetadata = z.infer<
  typeof AddResourceVersionMetadataSchema
>;
export type PatchResource = z.infer<typeof PatchResourceSchema>;
export type RestoreVersion = z.infer<typeof RestoreVersionSchema>;
export type ArchiveResource = z.infer<typeof ArchiveResourceSchema>;
export type DeleteResource = z.infer<typeof DeleteResourceSchema>;
export type RestoreResource = z.infer<typeof RestoreResourceSchema>;
export type PermanentDeleteResource = z.infer<
  typeof PermanentDeleteResourceSchema
>;
export type ResourceListFilters = z.infer<typeof ResourceListFiltersSchema>;
export type ResourceEntity = z.infer<typeof ResourceEntitySchema>;
export type ResourceVersionEntity = z.infer<
  typeof ResourceVersionEntitySchema
>;
export type TagEntity = z.infer<typeof TagEntitySchema>;
export type TrashEntity = z.infer<typeof TrashEntitySchema>;
export type CreateTagRequest = z.infer<typeof CreateTagRequestSchema>;
export type PatchTagRequest = z.infer<typeof PatchTagRequestSchema>;
