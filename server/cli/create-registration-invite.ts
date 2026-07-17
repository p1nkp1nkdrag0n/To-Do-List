import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig } from "../config/env.js";
import { openV2Database, type V2Database } from "../db/database.js";
import { migrateV2Database } from "../db/migrations.js";
import { resolveDependencies } from "../http/dependencies.js";
import { RegistrationInviteService } from "../modules/registration-invites/registration-invite-service.js";

interface CreatorRow extends Record<string, unknown> {
  id: string;
  username: string;
}

export interface RegistrationInviteCliOptions {
  argv?: string[];
  environment?: Record<string, string | undefined>;
  cwd?: string;
  writeOutput?: (message: string) => void;
  writeError?: (message: string) => void;
}

function parseCreatedBy(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  if (
    argv.length === 2 &&
    argv[0] === "--created-by" &&
    argv[1]!.trim() !== ""
  ) {
    return argv[1]!.trim().toLowerCase();
  }
  throw new Error("Usage: npm run invite:create -- [--created-by username]");
}

function resolveCreator(
  database: V2Database,
  requestedUsername: string | undefined,
): CreatorRow {
  if (requestedUsername !== undefined) {
    const creator = database.get<CreatorRow>(
      `SELECT users.id, users.username
         FROM team_members
         JOIN users ON users.id = team_members.user_id
        WHERE users.username = ? COLLATE NOCASE
          AND team_members.removed_at IS NULL
          AND users.disabled_at IS NULL`,
      [requestedUsername],
    );
    if (creator === undefined) {
      throw new Error(
        `No active team member has username "${requestedUsername}".`,
      );
    }
    return creator;
  }

  const activeMembers = database.all<CreatorRow>(
    `SELECT users.id, users.username
       FROM team_members
       JOIN users ON users.id = team_members.user_id
      WHERE team_members.removed_at IS NULL
        AND users.disabled_at IS NULL
      ORDER BY users.username COLLATE NOCASE`,
  );
  if (activeMembers.length !== 1) {
    throw new Error(
      "--created-by username is required unless exactly one active team member exists.",
    );
  }
  return activeMembers[0]!;
}

export function runRegistrationInviteCli(
  options: RegistrationInviteCliOptions = {},
): number {
  const argv = options.argv ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const writeOutput = options.writeOutput ?? ((message) => console.log(message));
  const writeError = options.writeError ?? ((message) => console.error(message));
  let database: V2Database | undefined;
  let exitCode = 0;

  try {
    const config = parseConfig(environment, cwd);
    database = openV2Database(config.dbPath);
    migrateV2Database(database);
    const creator = resolveCreator(database, parseCreatedBy(argv));
    const dependencies = resolveDependencies({
      database,
      sessionSecret: config.sessionSecret,
      cookieSecure: config.cookieSecure,
      bootstrapCode: config.bootstrapCode,
      trustProxyHops: config.trustProxyHops,
    });
    const invite = new RegistrationInviteService(dependencies).create(
      creator.id,
    );
    writeOutput(JSON.stringify(invite));
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
  }
  return exitCode;
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entrypointUrl === import.meta.url) {
  process.exitCode = runRegistrationInviteCli();
}
