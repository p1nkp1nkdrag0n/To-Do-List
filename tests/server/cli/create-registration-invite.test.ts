import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openV2Database } from "../../../server/db/database.js";
import { MIGRATIONS } from "../../../server/db/migrations.js";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

async function runInviteCli(
  databasePath: string,
  args: string[],
): Promise<CommandResult> {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const child = spawn(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repositoryRoot, "server", "cli", "create-registration-invite.ts"),
      ...args,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

describe("v2 registration invite CLI", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("uses the v2 schema and requires an explicit creator when the team is ambiguous", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["invite:create"]).toBe(
      "tsx server/cli/create-registration-invite.ts",
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-invite-cli-"));
    roots.push(root);
    const databasePath = path.join(root, "app.sqlite");
    const database = openV2Database(databasePath);
    const baseline = MIGRATIONS[0]!;
    database.exec(baseline.sql);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version >= 1),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      )
    `);
    const createdAt = "2026-07-17T08:00:00.000Z";
    database.run(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
      [baseline.version, baseline.name, baseline.checksum, createdAt],
    );
    for (const username of ["leader", "manager"]) {
      database.run(
        `INSERT INTO users
          (id, username, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, 'unused', ?, ?, ?)`,
        [`user-${username}`, username, username.toUpperCase(), createdAt, createdAt],
      );
      database.run(
        "INSERT INTO team_members (user_id, joined_at) VALUES (?, ?)",
        [`user-${username}`, createdAt],
      );
    }
    database.close();

    const ambiguous = await runInviteCli(databasePath, []);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.stderr).toContain("--created-by");

    const result = await runInviteCli(databasePath, ["--created-by", "leader"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const outputLine = result.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("{"));
    expect(outputLine).toBeDefined();
    const output = JSON.parse(outputLine!) as {
      id: string;
      code: string;
      expiresAt: string;
      revision: number;
    };
    expect(output).toMatchObject({
      id: expect.any(String),
      code: expect.any(String),
      expiresAt: expect.any(String),
      revision: 1,
    });

    const reopened = openV2Database(databasePath);
    const stored = reopened.get<{
      code_hash: string;
      created_by: string;
      created_at: string;
      expires_at: string;
    }>(
      `SELECT code_hash, created_by, created_at, expires_at
         FROM registration_invites WHERE id = ?`,
      [output.id],
    );
    expect(stored).toBeDefined();
    expect(
      reopened.get<{ version: number }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ),
    ).toEqual({ version: 4 });
    expect(stored!.created_by).toBe("user-leader");
    expect(stored!.code_hash).toBe(
      createHash("sha256").update(output.code, "utf8").digest("hex"),
    );
    expect(
      Date.parse(stored!.expires_at) - Date.parse(stored!.created_at),
    ).toBe(24 * 60 * 60 * 1000);
    const activity = reopened.get<{ actor_id: string; metadata_json: string }>(
      `SELECT actor_id, metadata_json FROM activity_log
        WHERE action = 'registration_invite.created' AND entity_id = ?`,
      [output.id],
    );
    expect(activity?.actor_id).toBe("user-leader");
    expect(JSON.stringify(activity)).not.toContain(output.code);
    expect(JSON.stringify(activity)).not.toContain(stored!.code_hash);
    reopened.close();

    const singleMemberDatabase = openV2Database(databasePath);
    singleMemberDatabase.run(
      `UPDATE team_members
          SET removed_at = ?, removed_by = 'user-leader', revision = revision + 1
        WHERE user_id = 'user-manager'`,
      [new Date().toISOString()],
    );
    singleMemberDatabase.close();
    const automaticCreator = await runInviteCli(databasePath, []);
    expect(automaticCreator.exitCode, automaticCreator.stderr).toBe(0);
    const automaticOutputLine = automaticCreator.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("{"));
    const automaticOutput = JSON.parse(automaticOutputLine!) as { id: string };
    const finalDatabase = openV2Database(databasePath);
    expect(
      finalDatabase.get<{ created_by: string }>(
        "SELECT created_by FROM registration_invites WHERE id = ?",
        [automaticOutput.id],
      ),
    ).toEqual({ created_by: "user-leader" });
    finalDatabase.close();
  });
});
