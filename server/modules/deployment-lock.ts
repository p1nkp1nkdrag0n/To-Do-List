import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const DEPLOYMENT_LOCK_FORMAT_VERSION = 1 as const;

interface DeploymentLockOwner {
  formatVersion: typeof DEPLOYMENT_LOCK_FORMAT_VERSION;
  databasePath: string;
  pid: number;
  token: string;
  acquiredAt: string;
}

export type DeploymentLockRelease = () => Promise<void>;

const MAX_OWNER_BYTES = 16 * 1024;
const OwnerSchema = z
  .object({
    formatVersion: z.literal(DEPLOYMENT_LOCK_FORMAT_VERSION),
    databasePath: z.string().min(1),
    pid: z.number().int().positive(),
    token: z.string().uuid(),
    acquiredAt: z.iso.datetime(),
  })
  .strict();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function normalizedPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function lstatIfExists(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function assertNoSymbolicLinkComponents(
  inputPath: string,
  label: string,
): Promise<void> {
  const absolutePath = path.resolve(inputPath);
  const parsed = path.parse(absolutePath);
  const segments = absolutePath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let currentPath = parsed.root;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatIfExists(currentPath);
    if (stat === undefined) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links.`);
    }
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EISDIR", "EPERM", "EBADF"].includes(errorCode(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeOwner(
  directoryPath: string,
  owner: DeploymentLockOwner,
): Promise<void> {
  const ownerPath = path.join(directoryPath, "owner.json");
  const handle = await fs.open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directoryPath);
}

async function readOwner(lockPath: string): Promise<DeploymentLockOwner> {
  const lockStat = await fs.lstat(lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(
      `Deployment lock is not a regular directory: ${lockPath}`,
    );
  }
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerStat = await fs.lstat(ownerPath);
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
    throw new Error(
      `Deployment lock owner is not a regular file: ${ownerPath}`,
    );
  }
  if (ownerStat.size > MAX_OWNER_BYTES) {
    throw new Error("Deployment lock owner record is too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Deployment lock owner record is invalid and cannot be proven stale.",
      { cause: error },
    );
  }
  const parsed = OwnerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "Deployment lock owner record is invalid and cannot be proven stale.",
    );
  }
  return parsed.data;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw new Error(`Unable to determine whether deployment lock PID ${pid} is alive.`, {
      cause: error,
    });
  }
}

function isLockContention(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
    errorCode(error) ?? "",
  );
}

export function getDeploymentLockPath(databasePath: string): string {
  if (databasePath === ":memory:") {
    throw new Error("Deployment locking requires a filesystem DB_PATH.");
  }
  const resolvedDatabasePath = path.resolve(databasePath);
  return path.join(
    path.dirname(resolvedDatabasePath),
    `.${path.basename(resolvedDatabasePath)}.deployment-lock`,
  );
}

export async function acquireDeploymentLock(
  databasePath: string,
): Promise<DeploymentLockRelease> {
  const resolvedDatabasePath = path.resolve(databasePath);
  const lockPath = getDeploymentLockPath(resolvedDatabasePath);
  const parentPath = path.dirname(lockPath);
  await assertNoSymbolicLinkComponents(parentPath, "DB_PATH parent");
  await fs.mkdir(parentPath, { recursive: true });
  await assertNoSymbolicLinkComponents(parentPath, "DB_PATH parent");

  for (;;) {
    const token = randomUUID();
    const candidatePath = `${lockPath}.candidate-${token}`;
    const owner: DeploymentLockOwner = {
      formatVersion: DEPLOYMENT_LOCK_FORMAT_VERSION,
      databasePath: resolvedDatabasePath,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    await fs.mkdir(candidatePath, { recursive: false, mode: 0o700 });
    try {
      await writeOwner(candidatePath, owner);
      try {
        await fs.rename(candidatePath, lockPath);
        await syncDirectory(parentPath);
      } catch (error) {
        if (!isLockContention(error) || (await lstatIfExists(lockPath)) === undefined) {
          throw error;
        }
        await fs.rm(candidatePath, { recursive: true, force: true });
        const existingOwner = await readOwner(lockPath);
        if (
          normalizedPath(existingOwner.databasePath) !==
          normalizedPath(resolvedDatabasePath)
        ) {
          throw new Error(
            "Deployment lock owner record refers to a different DB_PATH and cannot be recovered automatically.",
          );
        }
        if (isProcessAlive(existingOwner.pid)) {
          throw new Error(
            `Deployment is locked by live process PID ${existingOwner.pid}. Stop the server or other offline operation and retry.`,
          );
        }

        // The retired directory remains as an ABA guard for contenders that read
        // the same stale owner before this atomic rename.
        const retiredPath = `${lockPath}.retired-${existingOwner.token}`;
        try {
          await fs.rename(lockPath, retiredPath);
          await syncDirectory(parentPath);
        } catch (retireError) {
          if (
            errorCode(retireError) === "ENOENT" ||
            (isLockContention(retireError) &&
              (await lstatIfExists(lockPath)) !== undefined)
          ) {
            continue;
          }
          throw retireError;
        }
        continue;
      }

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        const current = await lstatIfExists(lockPath);
        if (current === undefined) {
          released = true;
          return;
        }
        const currentOwner = await readOwner(lockPath);
        if (currentOwner.token !== token || currentOwner.pid !== process.pid) {
          released = true;
          return;
        }
        const retiredPath = `${lockPath}.retired-${token}`;
        try {
          await fs.rename(lockPath, retiredPath);
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            released = true;
            return;
          }
          throw error;
        }
        await syncDirectory(parentPath);
        released = true;
      };
    } catch (error) {
      await fs.rm(candidatePath, { recursive: true, force: true });
      throw error;
    }
  }
}
