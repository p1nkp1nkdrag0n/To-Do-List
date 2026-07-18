import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig } from "../config/env.js";
import { openV2Database, type V2Database } from "../db/database.js";
import { createOfflineBackup } from "../modules/backups/backup-service.js";
import {
  acquireDeploymentLock,
  type DeploymentLockRelease,
} from "../modules/deployment-lock.js";

export interface BackupCliOptions {
  argv?: string[];
  environment?: Record<string, string | undefined>;
  cwd?: string;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

function parseBackupName(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  if (argv.length === 1 && !argv[0]!.startsWith("--")) {
    return argv[0];
  }
  if (
    argv.length === 2 &&
    argv[0] === "--name" &&
    argv[1]!.trim() !== ""
  ) {
    return argv[1];
  }
  throw new Error("Usage: backup [--name backup-name]");
}

async function assertDatabaseFile(databasePath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(databasePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(`Database file does not exist: ${databasePath}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("DB_PATH must be a regular file and not a symbolic link.");
  }
}

export async function runBackupCli(
  options: BackupCliOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const writeOutput = options.writeOutput ?? ((message) => console.log(message));
  const writeError = options.writeError ?? ((message) => console.error(message));
  let database: V2Database | undefined;
  let releaseLock: DeploymentLockRelease | undefined;
  let exitCode = 0;

  try {
    const name = parseBackupName(argv);
    const config = parseConfig(environment, cwd);
    releaseLock = await acquireDeploymentLock(config.dbPath);
    await assertDatabaseFile(config.dbPath);
    database = openV2Database(config.dbPath);
    const result = await createOfflineBackup({
      database,
      uploadPath: config.uploadPath,
      backupPath: config.backupPath,
      name,
    });
    writeOutput(JSON.stringify(result));
  } catch (error) {
    exitCode = 1;
    writeError(error instanceof Error ? error.message : String(error));
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (error) {
        exitCode = 1;
        writeError(
          `Failed to close the v2 database: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (releaseLock !== undefined) {
      try {
        await releaseLock();
      } catch (error) {
        exitCode = 1;
        writeError(
          `Failed to release the deployment lock: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return exitCode;
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entrypointUrl === import.meta.url) {
  process.exitCode = await runBackupCli();
}
