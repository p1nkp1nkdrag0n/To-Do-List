import type { Request } from "express";
import Busboy from "busboy";

import { HttpError } from "../../http/errors.js";
import {
  BlobStore,
  BlobTooLargeError,
  InsufficientStorageError,
  type StoredBlob,
} from "./blob-store.js";

const MAX_METADATA_BYTES = 6 * 1024 * 1024;

export interface UploadedResourceFile extends StoredBlob {
  originalFilename: string;
  mimeType: string;
}

export interface ParsedResourceMultipart {
  metadata: unknown;
  file?: UploadedResourceFile;
}

function uploadError(error: unknown): HttpError | unknown {
  if (error instanceof BlobTooLargeError) {
    return new HttpError(413, "UPLOAD_TOO_LARGE", "The uploaded file exceeds the configured limit.");
  }
  if (error instanceof InsufficientStorageError) {
    return new HttpError(507, "INSUFFICIENT_STORAGE", "The upload host does not have enough free space.");
  }
  return error;
}

function safeFilename(value: string): string {
  const normalized = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const withoutControls = normalized.replace(/[\u0000-\u001f\u007f]/g, "");
  return (withoutControls || "upload.bin").slice(0, 255);
}

export async function parseResourceMultipart(
  request: Request,
  blobStore: BlobStore,
): Promise<ParsedResourceMultipart> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "MULTIPART_REQUIRED", "This endpoint requires multipart/form-data.");
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fields: 1,
        files: 1,
        parts: 3,
        fieldSize: MAX_METADATA_BYTES,
        fileSize: blobStore.maxUploadBytes + 1,
      },
    });
  } catch {
    throw new HttpError(400, "MULTIPART_INVALID", "The multipart request is invalid.");
  }

  let metadataText: string | undefined;
  let storedFile: UploadedResourceFile | undefined;
  let fileWrite: Promise<void> | undefined;
  let failure: unknown;
  let sawFile = false;

  const rememberFailure = (error: unknown): void => {
    failure ??= error;
  };

  parser.on("field", (name, value, info) => {
    if (name !== "metadata" || metadataText !== undefined) {
      rememberFailure(new HttpError(400, "MULTIPART_INVALID", "Exactly one metadata field is required."));
      return;
    }
    if (info.valueTruncated) {
      rememberFailure(new HttpError(413, "METADATA_TOO_LARGE", "The resource metadata is too large."));
      return;
    }
    metadataText = value;
  });

  parser.on("file", (name, stream, info) => {
    if (name !== "file" || sawFile) {
      sawFile = true;
      stream.resume();
      rememberFailure(new HttpError(400, "MULTIPART_INVALID", "At most one file field is allowed."));
      return;
    }
    sawFile = true;
    let truncated = false;
    stream.once("limit", () => {
      truncated = true;
    });
    fileWrite = blobStore
      .write(stream)
      .then((stored) => {
        if (truncated) {
          throw new BlobTooLargeError(blobStore.maxUploadBytes, blobStore.maxUploadBytes + 1);
        }
        storedFile = {
          ...stored,
          originalFilename: safeFilename(info.filename),
          mimeType: (info.mimeType.trim() || "application/octet-stream").slice(0, 255),
        };
      })
      .catch((error: unknown) => {
        rememberFailure(uploadError(error));
      });
  });
  parser.on("filesLimit", () => {
    rememberFailure(new HttpError(400, "MULTIPART_INVALID", "At most one file field is allowed."));
  });
  parser.on("fieldsLimit", () => {
    rememberFailure(new HttpError(400, "MULTIPART_INVALID", "Exactly one metadata field is required."));
  });
  parser.on("partsLimit", () => {
    rememberFailure(new HttpError(400, "MULTIPART_INVALID", "The multipart request has too many parts."));
  });

  await new Promise<void>((resolve, reject) => {
    parser.once("close", resolve);
    parser.once("error", reject);
    request.once("aborted", () => reject(new HttpError(400, "UPLOAD_INTERRUPTED", "The upload was interrupted.")));
    request.pipe(parser);
  }).catch((error: unknown) => {
    rememberFailure(uploadError(error));
  });
  await fileWrite;

  if (metadataText === undefined && failure === undefined) {
    failure = new HttpError(400, "MULTIPART_INVALID", "Exactly one metadata field is required.");
  }
  if (failure !== undefined) {
    if (storedFile !== undefined) await blobStore.delete(storedFile.storageKey);
    throw failure;
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText!);
  } catch {
    if (storedFile !== undefined) await blobStore.delete(storedFile.storageKey);
    throw new HttpError(400, "MULTIPART_METADATA_INVALID", "The metadata field must contain valid JSON.");
  }
  return { metadata, ...(storedFile === undefined ? {} : { file: storedFile }) };
}
