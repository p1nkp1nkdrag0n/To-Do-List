import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openV2Database,
  V2Database,
} from "../../server/db/database.js";

const databases: V2Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function memoryDatabase(): V2Database {
  const database = openV2Database(":memory:");
  databases.push(database);
  return database;
}

describe("V2Database", () => {
  it("enables foreign keys and configures the busy timeout", () => {
    const database = memoryDatabase();

    expect(database.get<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual({
      foreign_keys: 1,
    });
    expect(database.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({
      timeout: 5_000,
    });
  });

  it("provides prepare, run, get, and all helpers", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE samples (id TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const insert = database.prepare(
      "INSERT INTO samples (id, value) VALUES (?, ?)",
    );
    expect(insert.run("one", "first").changes).toBe(1);
    expect(database.run("INSERT INTO samples VALUES (?, ?)", ["two", "second"]).changes).toBe(1);
    expect(database.get<{ value: string }>("SELECT value FROM samples WHERE id = ?", ["one"])).toEqual({
      value: "first",
    });
    expect(database.all<{ id: string }>("SELECT id FROM samples ORDER BY id")).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
  });

  it("rolls back every write when a transaction callback throws", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE samples (id TEXT PRIMARY KEY)");

    expect(() =>
      database.transaction(() => {
        database.run("INSERT INTO samples VALUES (?)", ["rolled-back"]);
        throw new Error("stop");
      }),
    ).toThrow("stop");

    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM samples")).toEqual({
      count: 0,
    });
  });

  it("commits a successful transaction atomically", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE samples (id TEXT PRIMARY KEY)");

    const result = database.transaction(() => {
      database.run("INSERT INTO samples VALUES (?)", ["committed"]);
      return "result";
    });

    expect(result).toBe("result");
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM samples")).toEqual({
      count: 1,
    });
  });

  it("rejects AsyncFunction callbacks before beginning a transaction", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE samples (id TEXT PRIMARY KEY)");
    let invoked = false;
    const asyncOperation = async () => {
      invoked = true;
      database.run("INSERT INTO samples VALUES (?)", ["async"]);
    };

    expect(() =>
      database.transaction(asyncOperation as unknown as () => never),
    ).toThrowError(TypeError);
    expect(invoked).toBe(false);

    database.transaction(() => {
      database.run("INSERT INTO samples VALUES (?)", ["sync-after-async"]);
    });
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM samples")).toEqual({
      count: 1,
    });
  });

  it("rolls back a generic Promise-like result and restores transaction state", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE samples (id TEXT PRIMARY KEY)");
    const promiseLikeOperation = () => {
      database.run("INSERT INTO samples VALUES (?)", ["thenable"]);
      return { then() {} };
    };

    expect(() =>
      database.transaction(
        promiseLikeOperation as unknown as () => string,
      ),
    ).toThrowError(
      new TypeError(
        "Transaction callbacks must be synchronous and must not return Promise-like values.",
      ),
    );

    database.transaction(() => {
      database.run("INSERT INTO samples VALUES (?)", ["sync-after-thenable"]);
    });
    expect(database.all<{ id: string }>("SELECT id FROM samples")).toEqual([
      { id: "sync-after-thenable" },
    ]);
  });

  it("rejects async transaction callbacks at the TypeScript boundary", () => {
    const database = memoryDatabase();

    if (false) {
      // @ts-expect-error Transaction callbacks must return synchronously.
      database.transaction(async () => "not allowed");
    }

    expect(database).toBeDefined();
  });

  it("uses WAL journal mode for file-backed databases", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-db-"));
    temporaryDirectories.push(directory);
    const database = openV2Database(path.join(directory, "nested", "app.sqlite"));
    databases.push(database);

    expect(database.get<{ journal_mode: string }>("PRAGMA journal_mode")).toEqual({
      journal_mode: "wal",
    });
  });

  it("validates busyTimeoutMs before creating directories", () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("mkdirSync must not run");
    });

    try {
      expect(() =>
        openV2Database(path.join(os.tmpdir(), "unused", "app.sqlite"), {
          busyTimeoutMs: -1,
        }),
      ).toThrow(/busyTimeoutMs/i);
      expect(mkdirSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("closes the native database when PRAGMA initialization fails", () => {
    const initializationError = new Error("forced PRAGMA failure");
    const execSpy = vi
      .spyOn(V2Database.prototype, "exec")
      .mockImplementationOnce(() => {
        throw initializationError;
      });
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");

    try {
      expect(() => openV2Database(":memory:")).toThrow(initializationError);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      execSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});
