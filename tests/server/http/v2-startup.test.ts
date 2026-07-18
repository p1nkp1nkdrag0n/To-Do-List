import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../../server/config/env.js";
import { openV2Database, type V2Database } from "../../../server/db/database.js";
import {
  MIGRATIONS,
  migrateV2Database,
} from "../../../server/db/migrations.js";
import { startServer as startLegacyServer } from "../../../server/startup.js";
import { startV2Server, type V2ServerHandle } from "../../../server/v2.js";

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function manualIntervalScheduler() {
  let operation: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cancelled = false;
  return {
    scheduler: {
      schedule(nextOperation: () => void, nextIntervalMs: number) {
        operation = nextOperation;
        intervalMs = nextIntervalMs;
        return {
          cancel() {
            cancelled = true;
          },
        };
      },
    },
    run() {
      if (!cancelled) {
        operation?.();
      }
    },
    get intervalMs() {
      return intervalMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function seedAttemptOwner(database: V2Database, userId: string, now: Date): void {
  database.run(
    `INSERT INTO users
      (id, username, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, 'hash', 'Attempt Owner', ?, ?)`,
    [userId, `owner-${userId}`, now.toISOString(), now.toISOString()],
  );
}

function seedAttempts(
  database: V2Database,
  values: { suffix: string; userId: string; attemptedAt: string },
): void {
  database.run(
    `INSERT INTO auth_attempts
      (id, normalized_username, ip_address, state, attempted_at)
     VALUES (?, ?, '192.0.2.30', 'failed', ?)`,
    [`auth-${values.suffix}`, `user-${values.suffix}`, values.attemptedAt],
  );
  database.run(
    `INSERT INTO project_invite_attempts
      (id, attempted_code_hash, user_id, ip_address, succeeded, attempted_at)
     VALUES (?, 'digest', ?, '192.0.2.30', 0, ?)`,
    [`invite-${values.suffix}`, values.userId, values.attemptedAt],
  );
}

function seedRegistrationReservation(
  database: V2Database,
  id: string,
  reservedAt: string,
): void {
  database.run(
    `INSERT INTO registration_hash_reservations
      (id, authorization_key, reserved_at)
     VALUES (?, ?, ?)`,
    [id, `authorization:${id}`, reservedAt],
  );
}

describe("v2 standalone server", () => {
  const directories: string[] = [];
  const handles: V2ServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts the API on an ephemeral port and initializes its own database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-server-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        UPLOAD_PATH: "runtime/uploads",
        BACKUP_PATH: "runtime/backups",
        HOST: "127.0.0.1",
        PORT: "0",
        SESSION_SECRET: "test-session-secret-that-is-at-least-32-chars",
        BOOTSTRAP_CODE: "test-bootstrap-code",
        COOKIE_SECURE: "false",
      },
      directory,
    );

    const handle = await startV2Server(config);
    handles.push(handle);
    const response = await fetch(`${handle.url}/api/auth/me`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
    });
    expect(fs.existsSync(config.dbPath)).toBe(true);
    expect(
      handle.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      ),
    ).toEqual({ count: MIGRATIONS.length });
  });

  it("holds the deployment lock for the complete server lifetime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-server-lock-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        UPLOAD_PATH: "runtime/uploads",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );

    const first = await startV2Server(config);
    await expect(startV2Server(config)).rejects.toThrow(/locked by live process/i);
    await first.close();

    const restarted = await startV2Server(config);
    handles.push(restarted);
    expect((await fetch(`${restarted.url}/healthz`)).status).toBe(200);
  });

  it("purges stale authentication and invite attempts during startup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-startup-purge-"));
    directories.push(directory);
    const now = new Date("2026-07-17T08:00:00.000Z");
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );
    const seedDatabase = openV2Database(config.dbPath);
    migrateV2Database(seedDatabase, () => now.toISOString());
    seedAttemptOwner(seedDatabase, "startup-owner", now);
    seedAttempts(seedDatabase, {
      suffix: "startup-stale",
      userId: "startup-owner",
      attemptedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    seedAttempts(seedDatabase, {
      suffix: "startup-recent",
      userId: "startup-owner",
      attemptedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString(),
    });
    seedRegistrationReservation(
      seedDatabase,
      "registration-startup-stale",
      new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
    );
    seedRegistrationReservation(
      seedDatabase,
      "registration-startup-recent",
      new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
    );
    seedDatabase.close();
    const interval = manualIntervalScheduler();

    const handle = await startV2Server(config, {
      clock: () => new Date(now),
      intervalScheduler: interval.scheduler,
    });
    handles.push(handle);

    expect(
      handle.database.all<{ id: string }>(
        "SELECT id FROM auth_attempts ORDER BY id",
      ),
    ).toEqual([{ id: "auth-startup-recent" }]);
    expect(
      handle.database.all<{ id: string }>(
        "SELECT id FROM project_invite_attempts ORDER BY id",
      ),
    ).toEqual([{ id: "invite-startup-recent" }]);
    expect(
      handle.database.all<{ id: string }>(
        "SELECT id FROM registration_hash_reservations ORDER BY id",
      ),
    ).toEqual([{ id: "registration-startup-recent" }]);
    expect(interval.intervalMs).toBe(60 * 60 * 1000);
  });

  it("purges stale attempts on the periodic interval", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-periodic-purge-"));
    directories.push(directory);
    let now = new Date("2026-07-17T08:00:00.000Z");
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );
    const interval = manualIntervalScheduler();
    const handle = await startV2Server(config, {
      clock: () => new Date(now),
      intervalScheduler: interval.scheduler,
    });
    handles.push(handle);
    seedAttemptOwner(handle.database, "periodic-owner", now);
    seedAttempts(handle.database, {
      suffix: "periodic",
      userId: "periodic-owner",
      attemptedAt: now.toISOString(),
    });
    seedRegistrationReservation(
      handle.database,
      "registration-periodic",
      now.toISOString(),
    );

    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    interval.run();

    expect(
      handle.database.get<{
        authCount: number;
        inviteCount: number;
        registrationCount: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM auth_attempts) AS authCount,
           (SELECT COUNT(*) FROM project_invite_attempts) AS inviteCount,
           (SELECT COUNT(*) FROM registration_hash_reservations)
             AS registrationCount`,
      ),
    ).toEqual({ authCount: 0, inviteCount: 0, registrationCount: 0 });
  });

  it("cancels attempt housekeeping before closing the database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-purge-close-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );
    const interval = manualIntervalScheduler();
    const handle = await startV2Server(config, {
      intervalScheduler: interval.scheduler,
    });
    handles.push(handle);
    const transactionSpy = vi.spyOn(handle.database, "transaction");

    await handle.close();
    const transactionCallsAfterClose = transactionSpy.mock.calls.length;
    interval.run();

    expect(interval.cancelled).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(transactionCallsAfterClose);
  });

  it("shares one deterministic close promise and closes the database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-close-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );
    const handle = await startV2Server(config);
    handles.push(handle);
    const serverClose = vi.spyOn(handle.server, "close");

    const firstClose = handle.close();
    const concurrentClose = handle.close();

    expect(concurrentClose).toBe(firstClose);
    await firstClose;
    expect(handle.close()).toBe(firstClose);
    expect(serverClose).toHaveBeenCalledOnce();
    expect(() => handle.database.get("SELECT 1")).toThrow();
  });

  it("closes the database in finally when server.close fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-close-failure-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      directory,
    );
    const handle = await startV2Server(config);
    const closeFailure = new Error("forced server close failure");
    const serverClose = vi
      .spyOn(handle.server, "close")
      .mockImplementation(((callback?: (error?: Error) => void) => {
        queueMicrotask(() => callback?.(closeFailure));
        return handle.server;
      }) as typeof handle.server.close);

    try {
      const firstClose = handle.close();
      const repeatedClose = handle.close();
      expect(repeatedClose).toBe(firstClose);
      await expect(firstClose).rejects.toBe(closeFailure);
      await expect(repeatedClose).rejects.toBe(closeFailure);
      expect(handle.close()).toBe(firstClose);
      expect(serverClose).toHaveBeenCalledOnce();
      expect(() => handle.database.get("SELECT 1")).toThrow();
    } finally {
      serverClose.mockRestore();
      await closeServer(handle.server);
    }
  });

  it("runs legacy and v2 simultaneously with isolated ports and databases", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-coexistence-"));
    const legacyDbPath = path.join(directory, "legacy", "app.sqlite");
    const v2Config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: path.join("v2", "app.sqlite"),
        UPLOAD_PATH: path.join("v2", "uploads"),
        BACKUP_PATH: path.join("v2", "backups"),
        HOST: "127.0.0.1",
        PORT: "0",
        SESSION_SECRET: "test-session-secret-that-is-at-least-32-chars",
        BOOTSTRAP_CODE: "test-bootstrap-code",
        COOKIE_SECURE: "false",
      },
      directory,
    );
    const distPath = path.join(directory, "legacy-dist");
    fs.mkdirSync(distPath, { recursive: true });
    fs.writeFileSync(path.join(distPath, "index.html"), "<!doctype html><p>legacy</p>");
    const originalLegacyDbPath = process.env.DB_PATH;
    process.env.DB_PATH = legacyDbPath;
    let legacyServer: Server | undefined;
    let v2Handle: V2ServerHandle | undefined;

    try {
      const [legacyResult, v2Result] = await Promise.allSettled([
        startLegacyServer({
          port: 0,
          host: "127.0.0.1",
          distPath,
        }),
        startV2Server(v2Config),
      ]);
      if (legacyResult.status === "fulfilled") {
        legacyServer = legacyResult.value.server;
      }
      if (v2Result.status === "fulfilled") {
        v2Handle = v2Result.value;
      }
      if (legacyResult.status === "rejected") {
        throw legacyResult.reason;
      }
      if (v2Result.status === "rejected") {
        throw v2Result.reason;
      }

      const legacyUrl = `http://127.0.0.1:${legacyResult.value.port}`;
      expect(legacyResult.value.port).not.toBe(Number(new URL(v2Result.value.url).port));
      expect(legacyDbPath).not.toBe(v2Config.dbPath);

      const [legacyHealth, v2Health, legacyBoundary, v2Boundary] = await Promise.all([
        fetch(`${legacyUrl}/healthz`),
        fetch(`${v2Result.value.url}/healthz`),
        fetch(`${legacyUrl}/api/projects`),
        fetch(`${v2Result.value.url}/api/auth/me`),
      ]);
      expect(legacyHealth.status).toBe(200);
      expect(await legacyHealth.json()).toMatchObject({ ok: true });
      expect(v2Health.status).toBe(200);
      expect(await v2Health.json()).toEqual({ ok: true, version: "v2" });
      expect(legacyBoundary.status).toBe(401);
      expect(await legacyBoundary.json()).toEqual({ error: "Authentication is required." });
      expect(v2Boundary.status).toBe(401);
      expect(await v2Boundary.json()).toEqual({
        error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
      });
      expect(fs.existsSync(legacyDbPath)).toBe(true);
      expect(fs.existsSync(v2Config.dbPath)).toBe(true);
    } finally {
      await Promise.allSettled([
        ...(legacyServer === undefined ? [] : [closeServer(legacyServer)]),
        ...(v2Handle === undefined ? [] : [v2Handle.close()]),
      ]);
      if (originalLegacyDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalLegacyDbPath;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
