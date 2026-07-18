import { pipeline } from "node:stream/promises";

import { Router, type Request, type Response } from "express";

import {
  AddResourceVersionMetadataSchema,
  ArchiveResourceRequestSchema,
  CreateTagRequestSchema,
  CreateResourceMetadataSchema,
  DeleteTagRequestSchema,
  DeleteResourceRequestSchema,
  PatchResourceRequestSchema,
  PatchTagRequestSchema,
  PermanentDeleteResourceRequestSchema,
  ResourceListQuerySchema,
  RestoreResourceRequestSchema,
  RestoreVersionRequestSchema,
} from "../../../shared/resource-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { validationError } from "../../http/errors.js";
import { asyncRoute, parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { parseResourceMultipart, type UploadedResourceFile } from "./multipart.js";
import { ResourceService } from "./resource-service.js";

function parseQuery(request: Request) {
  const parsed = ResourceListQuerySchema.safeParse(request.query);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

function parseMetadata<Output>(
  schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false; error: Parameters<typeof validationError>[0] } },
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

async function deleteUploadedFile(
  dependencies: V2RuntimeDependencies,
  file: UploadedResourceFile | undefined,
): Promise<void> {
  if (file !== undefined) await dependencies.blobStore.delete(file.storageKey);
}

function contentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 150) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createResourceRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const service = new ResourceService(dependencies);

  router.get("/:projectId/tags", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ tags: service.listTags(response.locals.auth, request.params.projectId!) });
  });
  router.post("/:projectId/tags", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(
      service.createTag(
        response.locals.auth,
        request.params.projectId!,
        parseRequestBody(CreateTagRequestSchema, request),
      ),
    );
  });
  router.patch("/:projectId/tags/:tagId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(
      service.updateTag(
        response.locals.auth,
        request.params.projectId!,
        request.params.tagId!,
        parseRequestBody(PatchTagRequestSchema, request),
      ),
    );
  });
  router.delete("/:projectId/tags/:tagId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(DeleteTagRequestSchema, request);
    response.json(
      service.deleteTag(
        response.locals.auth,
        request.params.projectId!,
        request.params.tagId!,
        input.expectedRevision,
      ),
    );
  });

  router.get("/:projectId/resources", (request, response: Response<unknown, AuthLocals>) => {
    response.json({
      resources: service.list(response.locals.auth, request.params.projectId!, parseQuery(request)),
    });
  });

  router.post(
    "/:projectId/resources",
    asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
      service.preflightCreate(response.locals.auth, request.params.projectId!);
      const multipart = await parseResourceMultipart(request, dependencies.blobStore);
      try {
        const metadata = parseMetadata(CreateResourceMetadataSchema, multipart.metadata);
        const result = service.create(
          response.locals.auth,
          request.params.projectId!,
          metadata,
          multipart.file,
        );
        response.status(201).json(result);
      } catch (error) {
        await deleteUploadedFile(dependencies, multipart.file);
        throw error;
      }
    }),
  );

  router.get(
    "/:projectId/resources/:resourceId",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.detail(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
        ),
      );
    },
  );

  router.patch(
    "/:projectId/resources/:resourceId",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.update(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          parseRequestBody(PatchResourceRequestSchema, request),
        ),
      );
    },
  );

  router.post(
    "/:projectId/resources/:resourceId/versions",
    asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
      service.preflightVersionWrite(
        response.locals.auth,
        request.params.projectId!,
        request.params.resourceId!,
      );
      const multipart = await parseResourceMultipart(request, dependencies.blobStore);
      try {
        const metadata = parseMetadata(AddResourceVersionMetadataSchema, multipart.metadata);
        const result = service.addVersion(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          metadata,
          multipart.file,
        );
        response.status(201).json(result);
      } catch (error) {
        await deleteUploadedFile(dependencies, multipart.file);
        throw error;
      }
    }),
  );

  router.post(
    "/:projectId/resources/:resourceId/versions/:versionId/restore",
    asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
      const result = await service.restoreVersion(
        response.locals.auth,
        request.params.projectId!,
        request.params.resourceId!,
        request.params.versionId!,
        parseRequestBody(RestoreVersionRequestSchema, request),
      );
      response.status(201).json(result);
    }),
  );

  router.get(
    "/:projectId/resources/:resourceId/versions/:versionId/download",
    asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
      const download = service.download(
        response.locals.auth,
        request.params.projectId!,
        request.params.resourceId!,
        request.params.versionId!,
      );
      response.setHeader("Content-Type", download.mimeType);
      response.setHeader("Content-Length", download.byteSize.toString());
      response.setHeader("Content-Disposition", contentDisposition(download.originalFilename));
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (download.storageKey !== null) {
        await pipeline(dependencies.blobStore.open(download.storageKey), response);
      } else {
        response.end(Buffer.from(download.markdownContent ?? "", "utf8"));
      }
    }),
  );

  router.post(
    "/:projectId/resources/:resourceId/archive",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ArchiveResourceRequestSchema, request);
      response.json(
        service.archive(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          input.expectedRevision,
        ),
      );
    },
  );
  router.post(
    "/:projectId/resources/:resourceId/unarchive",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ArchiveResourceRequestSchema, request);
      response.json(
        service.unarchive(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          input.expectedRevision,
        ),
      );
    },
  );
  router.delete(
    "/:projectId/resources/:resourceId",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(DeleteResourceRequestSchema, request);
      response.json(
        service.trash(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          input.expectedRevision,
        ),
      );
    },
  );
  router.get(
    "/:projectId/trash/resources",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json({
        resources: service.trashList(response.locals.auth, request.params.projectId!),
      });
    },
  );
  router.post(
    "/:projectId/resources/:resourceId/restore",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(RestoreResourceRequestSchema, request);
      response.json(
        service.restore(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          input.expectedRevision,
        ),
      );
    },
  );
  router.delete(
    "/:projectId/resources/:resourceId/permanent",
    asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(PermanentDeleteResourceRequestSchema, request);
      response.json(
        await service.permanentlyDelete(
          response.locals.auth,
          request.params.projectId!,
          request.params.resourceId!,
          input.expectedRevision,
        ),
      );
    }),
  );

  return router;
}
