import { randomBytes, randomInt, randomUUID } from "node:crypto";
import path from "node:path";

import bcrypt from "bcryptjs";

import { DEFAULT_MAX_UPLOAD_BYTES } from "../config/env.js";
import type { V2Database } from "../db/database.js";
import { BlobStore } from "../modules/resources/blob-store.js";
import type { V2Logger } from "./errors.js";

export const defaultV2Logger: V2Logger = {
  error(error, context) {
    console.error("Unexpected v2 HTTP error", context, error);
  },
};

export interface V2AppDependencies {
  database: V2Database;
  sessionSecret: string;
  cookieSecure: boolean;
  bootstrapCode: string;
  uploadPath?: string;
  maxUploadBytes?: number;
  blobStore?: BlobStore;
  trustProxyHops?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  sessionTokenGenerator?: () => string;
  registrationInviteCodeGenerator?: () => string;
  projectInviteCodeGenerator?: () => string;
  passwordHasher?: (password: string) => Promise<string>;
  passwordVerifier?: (password: string, passwordHash: string) => Promise<boolean>;
  logger?: V2Logger;
  publishEntityInvalidation?: (
    projectId: string,
    entityType: "project" | "task" | "participant" | "resource" | "availability",
    entityId: string,
  ) => void;
}

export interface V2RuntimeDependencies {
  database: V2Database;
  sessionSecret: string;
  cookieSecure: boolean;
  bootstrapCode: string;
  uploadPath: string;
  maxUploadBytes: number;
  blobStore: BlobStore;
  trustProxyHops: number;
  clock: () => Date;
  idGenerator: () => string;
  sessionTokenGenerator: () => string;
  registrationInviteCodeGenerator: () => string;
  projectInviteCodeGenerator: () => string;
  passwordHasher: (password: string) => Promise<string>;
  passwordVerifier: (password: string, passwordHash: string) => Promise<boolean>;
  logger: V2Logger;
  publishEntityInvalidation?: (
    projectId: string,
    entityType: "project" | "task" | "participant" | "resource" | "availability",
    entityId: string,
  ) => void;
}

export function resolveDependencies(
  dependencies: V2AppDependencies,
): V2RuntimeDependencies {
  const uploadPath =
    dependencies.uploadPath ??
    path.resolve(process.cwd(), "data", "v2", "uploads");
  const maxUploadBytes =
    dependencies.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  return {
    ...dependencies,
    uploadPath,
    maxUploadBytes,
    blobStore:
      dependencies.blobStore ?? new BlobStore({ rootPath: uploadPath, maxUploadBytes }),
    trustProxyHops: dependencies.trustProxyHops ?? 0,
    clock: dependencies.clock ?? (() => new Date()),
    idGenerator: dependencies.idGenerator ?? randomUUID,
    sessionTokenGenerator:
      dependencies.sessionTokenGenerator ??
      (() => randomBytes(32).toString("base64url")),
    registrationInviteCodeGenerator:
      dependencies.registrationInviteCodeGenerator ??
      (() => randomBytes(32).toString("base64url")),
    projectInviteCodeGenerator:
      dependencies.projectInviteCodeGenerator ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0")),
    passwordHasher:
      dependencies.passwordHasher ?? ((password) => bcrypt.hash(password, 10)),
    passwordVerifier:
      dependencies.passwordVerifier ??
      ((password, passwordHash) => bcrypt.compare(password, passwordHash)),
    logger: dependencies.logger ?? defaultV2Logger,
  };
}
