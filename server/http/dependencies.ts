import { randomBytes, randomInt, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import type { V2Database } from "../db/database.js";
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
  trustProxyHops?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  sessionTokenGenerator?: () => string;
  registrationInviteCodeGenerator?: () => string;
  projectInviteCodeGenerator?: () => string;
  passwordHasher?: (password: string) => Promise<string>;
  passwordVerifier?: (password: string, passwordHash: string) => Promise<boolean>;
  logger?: V2Logger;
}

export interface V2RuntimeDependencies {
  database: V2Database;
  sessionSecret: string;
  cookieSecure: boolean;
  bootstrapCode: string;
  trustProxyHops: number;
  clock: () => Date;
  idGenerator: () => string;
  sessionTokenGenerator: () => string;
  registrationInviteCodeGenerator: () => string;
  projectInviteCodeGenerator: () => string;
  passwordHasher: (password: string) => Promise<string>;
  passwordVerifier: (password: string, passwordHash: string) => Promise<boolean>;
  logger: V2Logger;
}

export function resolveDependencies(
  dependencies: V2AppDependencies,
): V2RuntimeDependencies {
  return {
    ...dependencies,
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
