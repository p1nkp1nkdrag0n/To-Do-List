import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig } from "../config/env.js";
import {
  RESTORE_CONFIRMATION,
  restoreOfflineBackup,
} from "../modules/backups/restore-service.js";
import {
  acquireDeploymentLock,
  type DeploymentLockRelease,
} from "../modules/deployment-lock.js";

export interface RestoreCliOptions {
  argv?: string[];
  environment?: Record<string, string | undefined>;
  cwd?: string;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

interface RestoreArguments {
  backupDirectory: string;
  confirmation: string;
}

const usage = `Usage: restore --from backup-directory --confirm ${RESTORE_CONFIRMATION}`;

function parseRestoreArguments(argv: string[]): RestoreArguments {
  let backupDirectory: string | undefined;
  let confirmation: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--from") {
      if (backupDirectory !== undefined || argv[index + 1] === undefined) {
        throw new Error(usage);
      }
      backupDirectory = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (argument === "--confirm") {
      const possibleValue = argv[index + 1];
      if (
        confirmation !== undefined ||
        possibleValue === undefined ||
        possibleValue.startsWith("--")
      ) {
        throw new Error(`Restore confirmation requires an explicit value. ${usage}`);
      }
      confirmation = possibleValue;
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") && backupDirectory === undefined) {
      backupDirectory = argument;
      continue;
    }
    throw new Error(usage);
  }

  if (backupDirectory === undefined || confirmation === undefined) {
    throw new Error(usage);
  }
  return { backupDirectory, confirmation };
}

export async function runRestoreCli(
  options: RestoreCliOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const writeOutput = options.writeOutput ?? ((message) => console.log(message));
  const writeError = options.writeError ?? ((message) => console.error(message));
  let releaseLock: DeploymentLockRelease | undefined;
  let exitCode = 0;

  try {
    const args = parseRestoreArguments(argv);
    const config = parseConfig(environment, cwd);
    releaseLock = await acquireDeploymentLock(config.dbPath);
    const backupDirectory = path.isAbsolute(args.backupDirectory)
      ? path.resolve(args.backupDirectory)
      : path.resolve(config.backupPath, args.backupDirectory);
    const result = await restoreOfflineBackup({
      backupDirectory,
      backupPath: config.backupPath,
      databasePath: config.dbPath,
      uploadPath: config.uploadPath,
      confirmation: args.confirmation,
    });
    writeOutput(JSON.stringify(result));
  } catch (error) {
    exitCode = 1;
    writeError(error instanceof Error ? error.message : String(error));
  } finally {
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
  process.exitCode = await runRestoreCli();
}
