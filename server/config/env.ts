import path from "node:path";

import { z } from "zod";

export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const DEVELOPMENT_SESSION_SECRET = "development-only-v2-session-secret";
const DEVELOPMENT_BOOTSTRAP_CODE = "development-bootstrap-code";
const SESSION_SECRET_PLACEHOLDER =
  "replace-with-at-least-32-random-characters";
const BOOTSTRAP_CODE_PLACEHOLDER = "replace-with-a-unique-bootstrap-code";

const BooleanEnvironmentValueSchema = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) =>
    value === undefined ? undefined : value === "true" || value === "1",
  );

const EnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DB_PATH: z.string().trim().min(1).optional(),
  UPLOAD_PATH: z.string().trim().min(1).optional(),
  BACKUP_PATH: z.string().trim().min(1).optional(),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_UPLOAD_BYTES),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  SESSION_SECRET: z.string().optional(),
  COOKIE_SECURE: BooleanEnvironmentValueSchema,
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  BOOTSTRAP_CODE: z.string().optional(),
});

export interface AppConfig {
  environment: "development" | "test" | "production";
  dbPath: string;
  uploadPath: string;
  backupPath: string;
  maxUploadBytes: number;
  host: string;
  port: number;
  sessionSecret: string;
  cookieSecure: boolean;
  trustProxyHops: number;
  bootstrapCode: string;
}

function resolveConfiguredPath(
  value: string | undefined,
  defaultSegments: string[],
  cwd: string,
): string {
  const configured = value ?? path.join(...defaultSegments);
  return path.resolve(cwd, configured);
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isEqualToOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(
    normalizePathForComparison(parent),
    normalizePathForComparison(candidate),
  );

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function validateUploadPath(uploadPath: string, cwd: string): void {
  const buildRoots = [path.resolve(cwd, "dist"), path.resolve(cwd, "public")];

  if (buildRoots.some((buildRoot) => isEqualToOrInside(uploadPath, buildRoot))) {
    throw new Error(
      "UPLOAD_PATH must not be equal to or inside the project dist or public directory.",
    );
  }
}

export function parseConfig(
  environment: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const sessionSecret = parsed.SESSION_SECRET ?? DEVELOPMENT_SESSION_SECRET;
  const bootstrapCode = parsed.BOOTSTRAP_CODE ?? DEVELOPMENT_BOOTSTRAP_CODE;

  if (
    parsed.NODE_ENV === "production" &&
    (sessionSecret.length < 32 ||
      sessionSecret === DEVELOPMENT_SESSION_SECRET ||
      sessionSecret === SESSION_SECRET_PLACEHOLDER)
  ) {
    throw new Error(
      "SESSION_SECRET must be set to a unique value of at least 32 characters in production.",
    );
  }
  if (parsed.NODE_ENV === "production" && parsed.COOKIE_SECURE === undefined) {
    throw new Error(
      "COOKIE_SECURE must be explicitly set to true or false in production.",
    );
  }
  if (
    parsed.NODE_ENV === "production" &&
    (bootstrapCode.length < 12 ||
      bootstrapCode === DEVELOPMENT_BOOTSTRAP_CODE ||
      bootstrapCode === BOOTSTRAP_CODE_PLACEHOLDER)
  ) {
    throw new Error(
      "BOOTSTRAP_CODE must be set to a unique value of at least 12 characters in production.",
    );
  }

  const uploadPath = resolveConfiguredPath(
    parsed.UPLOAD_PATH,
    ["data", "v2", "uploads"],
    cwd,
  );
  validateUploadPath(uploadPath, cwd);

  return {
    environment: parsed.NODE_ENV,
    dbPath: resolveConfiguredPath(
      parsed.DB_PATH,
      ["data", "v2", "app.sqlite"],
      cwd,
    ),
    uploadPath,
    backupPath: resolveConfiguredPath(
      parsed.BACKUP_PATH,
      ["data", "v2", "backups"],
      cwd,
    ),
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    host: parsed.HOST,
    port: parsed.PORT,
    sessionSecret,
    cookieSecure: parsed.COOKIE_SECURE ?? false,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    bootstrapCode,
  };
}
