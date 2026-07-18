import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBackupCli } from "../../../server/cli/backup.js";
import { runRestoreCli } from "../../../server/cli/restore.js";
import {
  openV2Database,
  type V2Database,
} from "../../../server/db/database.js";
import {
  CURRENT_SCHEMA_VERSION,
  migrateV2Database,
} from "../../../server/db/migrations.js";
import {
  createOfflineBackup,
  type BackupManifest,
} from "../../../server/modules/backups/backup-service.js";
import {
  RESTORE_CONFIRMATION,
  RESTORE_JOURNAL_FORMAT_VERSION,
  getRestoreJournalPath,
  recoverInterruptedRestore,
  restoreOfflineBackup,
} from "../../../server/modules/backups/restore-service.js";
import {
  DEPLOYMENT_LOCK_FORMAT_VERSION,
  acquireDeploymentLock,
  getDeploymentLockPath,
} from "../../../server/modules/deployment-lock.js";

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

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function closeTrackedDatabase(database: V2Database): void {
  database.close();
  const index = databases.indexOf(database);
  if (index >= 0) {
    databases.splice(index, 1);
  }
}

interface BackupFixture {
  backupDirectory: string;
  backupPath: string;
}

async function createBackupFixture(root: string): Promise<BackupFixture> {
  const database = openV2Database(path.join(root, "source.sqlite"));
  databases.push(database);
  migrateV2Database(database);
  database.exec("CREATE TABLE backup_probe (value TEXT NOT NULL)");
  database.run("INSERT INTO backup_probe (value) VALUES (?)", ["backed-up"]);
  const uploadPath = path.join(root, "source-uploads");
  fs.mkdirSync(path.join(uploadPath, "nested"), { recursive: true });
  fs.writeFileSync(path.join(uploadPath, "payload.txt"), "backup upload");
  fs.writeFileSync(path.join(uploadPath, "nested", "data.txt"), "nested");
  const backupPath = path.join(root, "backups");
  const result = await createOfflineBackup({
    database,
    uploadPath,
    backupPath,
    name: "fixture",
    now: () => new Date("2026-07-18T02:00:00.000Z"),
  });
  closeTrackedDatabase(database);
  return { backupDirectory: result.backupDirectory, backupPath };
}

function createRestoreTarget(root: string): {
  databasePath: string;
  uploadPath: string;
} {
  const databasePath = path.join(root, "target", "app.sqlite");
  const uploadPath = path.join(root, "target-uploads");
  const database = openV2Database(databasePath);
  migrateV2Database(database);
  database.exec("CREATE TABLE backup_probe (value TEXT NOT NULL)");
  database.run("INSERT INTO backup_probe (value) VALUES (?)", ["current"]);
  database.close();
  fs.mkdirSync(uploadPath, { recursive: true });
  fs.writeFileSync(path.join(uploadPath, "payload.txt"), "current upload");
  fs.writeFileSync(path.join(uploadPath, "target-only.txt"), "keep on failure");
  return { databasePath, uploadPath };
}

function readManifest(backupDirectory: string): BackupManifest {
  return JSON.parse(
    fs.readFileSync(path.join(backupDirectory, "manifest.json"), "utf8"),
  ) as BackupManifest;
}

function writeManifest(
  backupDirectory: string,
  manifest: BackupManifest | Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(backupDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function updateManifestDigest(
  backupDirectory: string,
  manifest: BackupManifest,
  manifestPath: string,
): void {
  const filePath = path.join(
    backupDirectory,
    ...manifestPath.split("/"),
  );
  const content = fs.readFileSync(filePath);
  const entry = manifest.files.find((file) => file.path === manifestPath);
  if (entry === undefined) {
    throw new Error(`Missing manifest entry for ${manifestPath}`);
  }
  entry.size = content.length;
  entry.sha256 = sha256(content);
}

function expectCurrentRestoreTarget(
  databasePath: string,
  uploadPath: string,
): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(database.prepare("SELECT value FROM backup_probe").all()).toEqual([
      { value: "current" },
    ]);
  } finally {
    database.close();
  }
  expect(fs.readFileSync(path.join(uploadPath, "payload.txt"), "utf8")).toBe(
    "current upload",
  );
  expect(
    fs.readFileSync(path.join(uploadPath, "target-only.txt"), "utf8"),
  ).toBe("keep on failure");
}

describe("V2Database backup", () => {
  it("backs up committed WAL contents into a standalone SQLite file", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "source.sqlite");
    const backupPath = path.join(directory, "backup.sqlite");
    const database = openV2Database(sourcePath);
    databases.push(database);
    database.exec("PRAGMA wal_autocheckpoint = 0");
    database.exec("CREATE TABLE samples (value TEXT NOT NULL)");
    database.run("INSERT INTO samples (value) VALUES (?)", ["from-wal"]);

    expect(fs.existsSync(`${sourcePath}-wal`)).toBe(true);

    await database.backupTo(backupPath);

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT value FROM samples").get(),
      ).toEqual({ value: "from-wal" });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }
  });
});

describe("createOfflineBackup", () => {
  it("creates a self-describing snapshot with all upload files", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "app.sqlite");
    const uploadPath = path.join(root, "uploads-source");
    const backupPath = path.join(root, "backups");
    const database = openV2Database(databasePath);
    databases.push(database);
    migrateV2Database(database);
    database.run(
      `INSERT INTO users
        (id, username, password_hash, display_name, created_at, updated_at)
       VALUES ('user-1', 'leader', 'unused', 'Leader', ?, ?)`,
      ["2026-07-18T00:00:00.000Z", "2026-07-18T00:00:00.000Z"],
    );
    fs.mkdirSync(path.join(uploadPath, "nested"), { recursive: true });
    fs.writeFileSync(path.join(uploadPath, "notes.txt"), "research notes");
    fs.writeFileSync(
      path.join(uploadPath, "nested", "result.bin"),
      Buffer.from([0, 1, 2, 3, 255]),
    );

    const result = await createOfflineBackup({
      database,
      uploadPath,
      backupPath,
      name: "team-snapshot",
      now: () => new Date("2026-07-18T01:02:03.000Z"),
    });

    expect(result.backupDirectory).toBe(
      path.join(backupPath, "team-snapshot"),
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(result.backupDirectory, "manifest.json"),
        "utf8",
      ),
    ) as BackupManifest;
    expect(manifest).toEqual({
      formatVersion: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: "2026-07-18T01:02:03.000Z",
      files: [
        {
          path: "database.sqlite",
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          path: "uploads/nested/result.bin",
          size: 5,
          sha256: sha256(Buffer.from([0, 1, 2, 3, 255])),
        },
        {
          path: "uploads/notes.txt",
          size: Buffer.byteLength("research notes"),
          sha256: sha256("research notes"),
        },
      ],
    });
    expect(
      fs.readFileSync(
        path.join(result.backupDirectory, "uploads", "notes.txt"),
        "utf8",
      ),
    ).toBe("research notes");

    const snapshot = new DatabaseSync(
      path.join(result.backupDirectory, "database.sqlite"),
      { readOnly: true },
    );
    try {
      expect(snapshot.prepare("SELECT username FROM users").all()).toEqual([
        { username: "leader" },
      ]);
    } finally {
      snapshot.close();
    }
  });

  it("rejects a backup name that escapes BACKUP_PATH", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "app.sqlite"));
    databases.push(database);
    migrateV2Database(database);

    await expect(
      createOfflineBackup({
        database,
        uploadPath: path.join(root, "uploads"),
        backupPath: path.join(root, "backups"),
        name: "../escaped",
      }),
    ).rejects.toThrow(/name|path traversal|inside/i);

    expect(fs.existsSync(path.join(root, "escaped"))).toBe(false);
  });

  it("rejects symbolic links in the upload tree", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "app.sqlite"));
    const uploadPath = path.join(root, "uploads");
    const externalPath = path.join(root, "external");
    databases.push(database);
    migrateV2Database(database);
    fs.mkdirSync(uploadPath, { recursive: true });
    fs.mkdirSync(externalPath, { recursive: true });
    fs.writeFileSync(path.join(externalPath, "secret.txt"), "not portable");
    fs.symlinkSync(externalPath, path.join(uploadPath, "linked"), "junction");

    await expect(
      createOfflineBackup({
        database,
        uploadPath,
        backupPath: path.join(root, "backups"),
        name: "unsafe",
      }),
    ).rejects.toThrow(/symbolic link/i);

    expect(fs.existsSync(path.join(root, "backups", "unsafe"))).toBe(false);
  });

  it("rejects a symbolic link in an UPLOAD_PATH ancestor", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "app.sqlite"));
    const externalParent = path.join(root, "external-parent");
    const linkedParent = path.join(root, "linked-parent");
    databases.push(database);
    migrateV2Database(database);
    fs.mkdirSync(path.join(externalParent, "uploads"), { recursive: true });
    fs.writeFileSync(
      path.join(externalParent, "uploads", "artifact.txt"),
      "outside configured path",
    );
    fs.symlinkSync(externalParent, linkedParent, "junction");

    await expect(
      createOfflineBackup({
        database,
        uploadPath: path.join(linkedParent, "uploads"),
        backupPath: path.join(root, "backups"),
        name: "ancestor-link",
      }),
    ).rejects.toThrow(/symbolic link/i);

    expect(
      fs.existsSync(path.join(root, "backups", "ancestor-link")),
    ).toBe(false);
  });

  it("rejects a BACKUP_PATH ancestor link before creating through it", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "app.sqlite"));
    const externalParent = path.join(root, "external-backups");
    const linkedParent = path.join(root, "linked-backups");
    databases.push(database);
    migrateV2Database(database);
    fs.mkdirSync(externalParent, { recursive: true });
    fs.symlinkSync(externalParent, linkedParent, "junction");

    await expect(
      createOfflineBackup({
        database,
        uploadPath: path.join(root, "uploads"),
        backupPath: path.join(linkedParent, "backups"),
        name: "must-not-exist",
      }),
    ).rejects.toThrow(/symbolic link/i);

    expect(fs.existsSync(path.join(externalParent, "backups"))).toBe(false);
  });
});

describe("restoreOfflineBackup", () => {
  it("rejects a target ancestor link before creating through it", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const externalParent = path.join(root, "external-target");
    const linkedParent = path.join(root, "linked-target");
    fs.mkdirSync(externalParent, { recursive: true });
    fs.symlinkSync(externalParent, linkedParent, "junction");

    await expect(
      restoreOfflineBackup({
        ...fixture,
        databasePath: path.join(linkedParent, "database", "app.sqlite"),
        uploadPath: path.join(root, "restored-uploads"),
        confirm: true,
      }),
    ).rejects.toThrow(/symbolic link/i);

    expect(fs.existsSync(path.join(externalParent, "database"))).toBe(false);
  });

  it("requires explicit confirmation before changing targets", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: false,
      }),
    ).rejects.toThrow(/confirm/i);

    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("restores the database and replaces the complete upload directory", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);

    const result = await restoreOfflineBackup({
      ...fixture,
      ...target,
      confirm: true,
    });

    expect(result).toMatchObject({
      backupDirectory: fixture.backupDirectory,
      databasePath: target.databasePath,
      uploadPath: target.uploadPath,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    const database = new DatabaseSync(target.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM backup_probe").all()).toEqual([
        { value: "backed-up" },
      ]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      database.close();
    }
    expect(
      fs.readFileSync(path.join(target.uploadPath, "payload.txt"), "utf8"),
    ).toBe("backup upload");
    expect(
      fs.readFileSync(
        path.join(target.uploadPath, "nested", "data.txt"),
        "utf8",
      ),
    ).toBe("nested");
    expect(fs.existsSync(path.join(target.uploadPath, "target-only.txt"))).toBe(
      false,
    );
  });

  it("rejects a corrupted file hash without touching existing targets", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    fs.appendFileSync(
      path.join(fixture.backupDirectory, "uploads", "payload.txt"),
      "-corrupt",
    );

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: true,
      }),
    ).rejects.toThrow(/hash|size/i);

    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects manifest path traversal without writing outside staging", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    const manifest = readManifest(fixture.backupDirectory);
    const upload = manifest.files.find(
      (file) => file.path === "uploads/payload.txt",
    )!;
    upload.path = "../escaped.txt";
    writeManifest(fixture.backupDirectory, manifest);

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: true,
      }),
    ).rejects.toThrow(/path|manifest/i);

    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("strictly rejects unknown manifest fields", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    const manifest = readManifest(fixture.backupDirectory);
    writeManifest(fixture.backupDirectory, {
      ...manifest,
      unexpected: true,
    });

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: true,
      }),
    ).rejects.toThrow(/manifest/i);

    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects a database schema newer than this build", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    const backupDatabasePath = path.join(
      fixture.backupDirectory,
      "database.sqlite",
    );
    const futureDatabase = new DatabaseSync(backupDatabasePath);
    try {
      futureDatabase.exec("PRAGMA journal_mode = DELETE");
      futureDatabase
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum, applied_at)
           VALUES (?, 'future', ?, ?)`,
        )
        .run(
          CURRENT_SCHEMA_VERSION + 1,
          "f".repeat(64),
          "2026-07-18T03:00:00.000Z",
        );
    } finally {
      futureDatabase.close();
    }
    const manifest = readManifest(fixture.backupDirectory);
    manifest.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    updateManifestDigest(
      fixture.backupDirectory,
      manifest,
      "database.sqlite",
    );
    writeManifest(fixture.backupDirectory, manifest);

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: true,
      }),
    ).rejects.toThrow(/newer|schema/i);

    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects a corrupt SQLite file even when its manifest digest matches", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    const backupDatabasePath = path.join(
      fixture.backupDirectory,
      "database.sqlite",
    );
    const content = fs.readFileSync(backupDatabasePath);
    content[0] = content[0]! ^ 0xff;
    fs.writeFileSync(backupDatabasePath, content);
    const manifest = readManifest(fixture.backupDirectory);
    updateManifestDigest(
      fixture.backupDirectory,
      manifest,
      "database.sqlite",
    );
    writeManifest(fixture.backupDirectory, manifest);

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirm: true,
      }),
    ).rejects.toThrow(/sqlite|database|integrity/i);

    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rolls back both destinations when the atomic replacement fails", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    const rename = fs.promises.rename.bind(fs.promises);
    let replacementFailed = false;
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (source, destination) => {
        const sourcePath = String(source);
        if (
          !replacementFailed &&
          sourcePath.includes(".target-uploads.restore-")
        ) {
          replacementFailed = true;
          throw new Error("forced upload replacement failure");
        }
        await rename(source, destination);
      });

    try {
      await expect(
        restoreOfflineBackup({
          ...fixture,
          ...target,
          confirm: true,
        }),
      ).rejects.toThrow(/forced upload replacement failure/i);
    } finally {
      renameSpy.mockRestore();
    }

    expect(replacementFailed).toBe(true);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
    expect(
      fs
        .readdirSync(path.dirname(target.databasePath))
        .some((name) => name.includes(".restore-") || name.includes(".rollback-")),
    ).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(target.uploadPath))
        .some((name) => name.includes(".restore-") || name.includes(".rollback-")),
    ).toBe(false);
  });
});

describe("offline backup CLI", () => {
  it("uses parseConfig paths and restores only with the exact confirmation value", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "configured", "app.sqlite");
    const uploadPath = path.join(root, "configured", "uploads");
    const backupPath = path.join(root, "configured", "backups");
    const database = openV2Database(databasePath);
    databases.push(database);
    migrateV2Database(database);
    database.exec("CREATE TABLE cli_probe (value TEXT NOT NULL)");
    database.run("INSERT INTO cli_probe VALUES ('from backup')");
    closeTrackedDatabase(database);
    fs.mkdirSync(uploadPath, { recursive: true });
    fs.writeFileSync(path.join(uploadPath, "cli.txt"), "from backup");
    const environment = {
      NODE_ENV: "test",
      DB_PATH: databasePath,
      UPLOAD_PATH: uploadPath,
      BACKUP_PATH: backupPath,
    };
    const output: string[] = [];
    const errors: string[] = [];

    expect(
      await runBackupCli({
        argv: ["--name", "cli-snapshot"],
        environment,
        cwd: root,
        writeOutput: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      }),
    ).toBe(0);
    expect(errors).toEqual([]);
    const created = JSON.parse(output.at(-1)!) as { backupDirectory: string };
    expect(created.backupDirectory).toBe(
      path.join(backupPath, "cli-snapshot"),
    );

    const live = new DatabaseSync(databasePath);
    live.prepare("UPDATE cli_probe SET value = 'changed'").run();
    live.close();
    fs.writeFileSync(path.join(uploadPath, "cli.txt"), "changed");

    expect(
      await runRestoreCli({
        argv: ["--from", created.backupDirectory, "--confirm"],
        environment,
        cwd: root,
        writeOutput: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors.at(-1)).toMatch(/confirmation|confirm|value/i);

    expect(
      await runRestoreCli({
        argv: ["--from", created.backupDirectory, "--confirm", "yes"],
        environment,
        cwd: root,
        writeOutput: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors.at(-1)).toMatch(/confirmation|confirm/i);

    expect(
      await runRestoreCli({
        argv: [
          "--from",
          created.backupDirectory,
          "--confirm",
          RESTORE_CONFIRMATION,
        ],
        environment,
        cwd: root,
        writeOutput: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      }),
    ).toBe(0);

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM cli_probe").get()).toEqual({
        value: "from backup",
      });
    } finally {
      restored.close();
    }
    expect(fs.readFileSync(path.join(uploadPath, "cli.txt"), "utf8")).toBe(
      "from backup",
    );
  });
});

describe("restoreOfflineBackup", () => {
  it("requires explicit confirmation and restores a complete snapshot", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "live", "app.sqlite");
    const uploadPath = path.join(root, "live", "uploads");
    const database = openV2Database(databasePath);
    databases.push(database);
    migrateV2Database(database);
    database.exec("CREATE TABLE restore_probe (value TEXT NOT NULL)");
    database.run("INSERT INTO restore_probe (value) VALUES ('original')");
    fs.mkdirSync(uploadPath, { recursive: true });
    fs.writeFileSync(path.join(uploadPath, "artifact.txt"), "original upload");
    const backup = await createOfflineBackup({
      database,
      uploadPath,
      backupPath: path.join(root, "backups"),
      name: "roundtrip",
    });
    closeTrackedDatabase(database);

    const mutated = new DatabaseSync(databasePath);
    mutated.prepare("UPDATE restore_probe SET value = 'mutated'").run();
    mutated.close();
    fs.writeFileSync(path.join(uploadPath, "artifact.txt"), "mutated upload");
    fs.writeFileSync(path.join(uploadPath, "extra.txt"), "remove me");

    await expect(
      restoreOfflineBackup({
        backupDirectory: backup.backupDirectory,
        databasePath,
        uploadPath,
        confirmation: "yes",
      }),
    ).rejects.toThrow(/confirmation/i);

    await restoreOfflineBackup({
      backupDirectory: backup.backupDirectory,
      databasePath,
      uploadPath,
      confirmation: RESTORE_CONFIRMATION,
    });

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM restore_probe").get()).toEqual({
        value: "original",
      });
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      restored.close();
    }
    expect(fs.readFileSync(path.join(uploadPath, "artifact.txt"), "utf8")).toBe(
      "original upload",
    );
    expect(fs.existsSync(path.join(uploadPath, "extra.txt"))).toBe(false);
  });

  it("rejects tampered files before changing the destination", async () => {
    const root = temporaryDirectory();
    const sourceDatabasePath = path.join(root, "source", "app.sqlite");
    const sourceUploadPath = path.join(root, "source", "uploads");
    const sourceDatabase = openV2Database(sourceDatabasePath);
    databases.push(sourceDatabase);
    migrateV2Database(sourceDatabase);
    fs.mkdirSync(sourceUploadPath, { recursive: true });
    fs.writeFileSync(path.join(sourceUploadPath, "artifact.txt"), "trusted");
    const backup = await createOfflineBackup({
      database: sourceDatabase,
      uploadPath: sourceUploadPath,
      backupPath: path.join(root, "backups"),
      name: "tampered",
    });
    fs.writeFileSync(
      path.join(backup.backupDirectory, "uploads", "artifact.txt"),
      "tampered",
    );

    const databasePath = path.join(root, "destination", "app.sqlite");
    const uploadPath = path.join(root, "destination", "uploads");
    const destination = openV2Database(databasePath);
    databases.push(destination);
    destination.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
    destination.run("INSERT INTO sentinel VALUES ('keep database')");
    closeTrackedDatabase(destination);
    fs.mkdirSync(uploadPath, { recursive: true });
    fs.writeFileSync(path.join(uploadPath, "sentinel.txt"), "keep upload");

    await expect(
      restoreOfflineBackup({
        backupDirectory: backup.backupDirectory,
        databasePath,
        uploadPath,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/size|sha-?256|checksum/i);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT value FROM sentinel").get()).toEqual({
        value: "keep database",
      });
    } finally {
      preserved.close();
    }
    expect(fs.readFileSync(path.join(uploadPath, "sentinel.txt"), "utf8")).toBe(
      "keep upload",
    );
  });

  it("rejects manifest path traversal and unknown manifest fields", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "source.sqlite"));
    databases.push(database);
    migrateV2Database(database);
    const backup = await createOfflineBackup({
      database,
      uploadPath: path.join(root, "uploads"),
      backupPath: path.join(root, "backups"),
      name: "invalid-manifest",
    });
    const manifest = readManifest(backup.backupDirectory);
    manifest.files[0]!.path = "../database.sqlite";
    writeManifest(backup.backupDirectory, {
      ...manifest,
      unexpected: true,
    });

    await expect(
      restoreOfflineBackup({
        backupDirectory: backup.backupDirectory,
        databasePath: path.join(root, "destination", "app.sqlite"),
        uploadPath: path.join(root, "destination", "uploads"),
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/manifest|path traversal|relative path/i);
    expect(fs.existsSync(path.join(root, "database.sqlite"))).toBe(false);
  });

  it("refuses a backup database newer than the supported schema", async () => {
    const root = temporaryDirectory();
    const database = openV2Database(path.join(root, "source.sqlite"));
    databases.push(database);
    migrateV2Database(database);
    const backup = await createOfflineBackup({
      database,
      uploadPath: path.join(root, "uploads"),
      backupPath: path.join(root, "backups"),
      name: "future-schema",
    });
    const snapshotPath = path.join(backup.backupDirectory, "database.sqlite");
    const snapshot = new DatabaseSync(snapshotPath);
    const futureVersion = CURRENT_SCHEMA_VERSION + 1;
    try {
      snapshot
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          futureVersion,
          "future_schema",
          "f".repeat(64),
          "2026-07-18T00:00:00.000Z",
        );
    } finally {
      snapshot.close();
    }
    const manifest = readManifest(backup.backupDirectory);
    const databaseEntry = manifest.files.find(
      (entry) => entry.path === "database.sqlite",
    )!;
    const snapshotContent = fs.readFileSync(snapshotPath);
    databaseEntry.size = snapshotContent.byteLength;
    databaseEntry.sha256 = sha256(snapshotContent);
    manifest.schemaVersion = futureVersion;
    writeManifest(backup.backupDirectory, manifest);

    await expect(
      restoreOfflineBackup({
        backupDirectory: backup.backupDirectory,
        databasePath: path.join(root, "destination", "app.sqlite"),
        uploadPath: path.join(root, "destination", "uploads"),
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/newer than supported/i);
  });
});

interface ReferencedBlobBackupFixture extends BackupFixture {
  storageKey: string;
  content: Buffer;
}

async function createReferencedBlobBackupFixture(
  root: string,
): Promise<ReferencedBlobBackupFixture> {
  const database = openV2Database(path.join(root, "blob-source.sqlite"));
  databases.push(database);
  migrateV2Database(database);
  const now = "2026-07-18T02:00:00.000Z";
  const storageKey = "a".repeat(64);
  const content = Buffer.from("versioned research artifact", "utf8");
  database.run(
    `INSERT INTO users
       (id, username, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["user-1", "researcher", "hash", "Researcher", now, now],
  );
  database.run(
    `INSERT INTO projects
       (id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["project-1", "Research", "user-1", "user-1", now, now],
  );
  database.run(
    `INSERT INTO resources
       (id, project_id, kind, title, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?)`,
    [
      "resource-1",
      "project-1",
      "Artifact",
      "user-1",
      "user-1",
      now,
      now,
    ],
  );
  database.run(
    `INSERT INTO resource_versions
       (id, resource_id, version_number, original_filename, byte_size,
        mime_type, sha256, storage_key, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "resource-version-1",
      "resource-1",
      "artifact.bin",
      content.byteLength,
      "application/octet-stream",
      sha256(content),
      storageKey,
      "user-1",
      now,
    ],
  );
  database.run(
    "UPDATE resources SET current_version_number = 1 WHERE id = ?",
    ["resource-1"],
  );

  const uploadPath = path.join(root, "blob-source-uploads");
  fs.mkdirSync(uploadPath, { recursive: true });
  fs.writeFileSync(path.join(uploadPath, storageKey), content);
  const backupPath = path.join(root, "blob-backups");
  const result = await createOfflineBackup({
    database,
    uploadPath,
    backupPath,
    name: "referenced-blob",
    now: () => new Date(now),
  });
  closeTrackedDatabase(database);
  return {
    backupDirectory: result.backupDirectory,
    backupPath,
    storageKey,
    content,
  };
}

function mutateBackupDatabase(
  fixture: BackupFixture,
  mutation: (database: DatabaseSync) => void,
): void {
  const databasePath = path.join(fixture.backupDirectory, "database.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    mutation(database);
  } finally {
    database.close();
  }
  const manifest = readManifest(fixture.backupDirectory);
  updateManifestDigest(fixture.backupDirectory, manifest, "database.sqlite");
  writeManifest(fixture.backupDirectory, manifest);
}

describe("restore logical validation", () => {
  it("rejects a migration checksum mismatch before replacing targets", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    mutateBackupDatabase(fixture, (database) => {
      database
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
        .run("0".repeat(64));
    });

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/migration.*checksum/i);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects foreign key violations before replacing targets", async () => {
    const root = temporaryDirectory();
    const fixture = await createBackupFixture(root);
    const target = createRestoreTarget(root);
    mutateBackupDatabase(fixture, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare(
          `INSERT INTO sessions
             (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "orphan-session",
          "missing-user",
          "orphan-token",
          "2026-07-19T00:00:00.000Z",
          "2026-07-18T00:00:00.000Z",
          "2026-07-18T00:00:00.000Z",
        );
    });

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/foreign key/i);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects a referenced blob omitted from both uploads and manifest", async () => {
    const root = temporaryDirectory();
    const fixture = await createReferencedBlobBackupFixture(root);
    const target = createRestoreTarget(root);
    fs.rmSync(path.join(fixture.backupDirectory, "uploads", fixture.storageKey));
    const manifest = readManifest(fixture.backupDirectory);
    manifest.files = manifest.files.filter(
      (file) => file.path !== `uploads/${fixture.storageKey}`,
    );
    writeManifest(fixture.backupDirectory, manifest);

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/referenced.*blob|storage key/i);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects a referenced blob whose hash disagrees with the database row", async () => {
    const root = temporaryDirectory();
    const fixture = await createReferencedBlobBackupFixture(root);
    const target = createRestoreTarget(root);
    mutateBackupDatabase(fixture, (database) => {
      database.exec("DROP TRIGGER resource_versions_are_immutable_update");
      database
        .prepare("UPDATE resource_versions SET sha256 = ? WHERE storage_key = ?")
        .run("b".repeat(64), fixture.storageKey);
    });

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/referenced.*sha|database.*sha|blob.*sha/i);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });

  it("rejects a referenced blob whose size disagrees with the database row", async () => {
    const root = temporaryDirectory();
    const fixture = await createReferencedBlobBackupFixture(root);
    const target = createRestoreTarget(root);
    mutateBackupDatabase(fixture, (database) => {
      database.exec("DROP TRIGGER resource_versions_are_immutable_update");
      database
        .prepare("UPDATE resource_versions SET byte_size = byte_size + 1 WHERE storage_key = ?")
        .run(fixture.storageKey);
    });

    await expect(
      restoreOfflineBackup({
        ...fixture,
        ...target,
        confirmation: RESTORE_CONFIRMATION,
      }),
    ).rejects.toThrow(/referenced.*size|database.*size|blob.*size/i);
    expectCurrentRestoreTarget(target.databasePath, target.uploadPath);
  });
});

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Test child process did not expose a PID.");
  }
  await once(child, "exit");
  return pid;
}

describe("deployment lock", () => {
  it("rejects a second holder while the recorded process is alive", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "data", "app.sqlite");
    const release = await acquireDeploymentLock(databasePath);
    try {
      const owner = JSON.parse(
        fs.readFileSync(
          path.join(getDeploymentLockPath(databasePath), "owner.json"),
          "utf8",
        ),
      ) as { pid: number; databasePath: string; token: string };
      expect(owner).toMatchObject({
        pid: process.pid,
        databasePath: path.resolve(databasePath),
      });
      await expect(acquireDeploymentLock(databasePath)).rejects.toThrow(
        new RegExp(`locked.*${process.pid}`, "i"),
      );
      const retiredPath = `${getDeploymentLockPath(databasePath)}.retired-${owner.token}`;
      await release();
      expect(fs.existsSync(retiredPath)).toBe(true);
    } finally {
      await release();
    }
    expect(fs.existsSync(getDeploymentLockPath(databasePath))).toBe(false);
  });

  it("atomically recovers a lock owned by a process that has exited", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "data", "app.sqlite");
    const lockPath = getDeploymentLockPath(databasePath);
    const deadPid = await exitedProcessId();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        formatVersion: DEPLOYMENT_LOCK_FORMAT_VERSION,
        databasePath: path.resolve(databasePath),
        pid: deadPid,
        token: randomUUID(),
        acquiredAt: "2026-07-18T02:00:00.000Z",
      })}\n`,
    );

    const release = await acquireDeploymentLock(databasePath);
    try {
      const owner = JSON.parse(
        fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
      ) as { pid: number };
      expect(owner.pid).toBe(process.pid);
    } finally {
      await release();
    }
  });

  it("makes both offline CLIs fail clearly while another holder owns the lock", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "configured", "app.sqlite");
    const uploadPath = path.join(root, "configured", "uploads");
    const backupPath = path.join(root, "configured", "backups");
    const database = openV2Database(databasePath);
    migrateV2Database(database);
    database.close();
    fs.mkdirSync(uploadPath, { recursive: true });
    const environment = {
      NODE_ENV: "test",
      DB_PATH: databasePath,
      UPLOAD_PATH: uploadPath,
      BACKUP_PATH: backupPath,
    };
    const errors: string[] = [];
    const release = await acquireDeploymentLock(databasePath);
    try {
      expect(
        await runBackupCli({
          argv: ["--name", "blocked"],
          environment,
          cwd: root,
          writeOutput: () => undefined,
          writeError: (message) => errors.push(message),
        }),
      ).toBe(1);
      expect(
        await runRestoreCli({
          argv: [
            "--from",
            "missing",
            "--confirm",
            RESTORE_CONFIRMATION,
          ],
          environment,
          cwd: root,
          writeOutput: () => undefined,
          writeError: (message) => errors.push(message),
        }),
      ).toBe(1);
    } finally {
      await release();
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(new RegExp(`locked.*${process.pid}`, "i"));
    expect(errors[1]).toMatch(new RegExp(`locked.*${process.pid}`, "i"));
  });
});

type InterruptedRestorePhase =
  | "prepared"
  | "partial-originals"
  | "originals-moved"
  | "database-installed"
  | "uploads-installed"
  | "validated";

const journalMarkers = [
  "01-originals-moved",
  "02-database-installed",
  "03-uploads-installed",
  "04-validated",
] as const;

function restoreOperationPaths(
  databasePath: string,
  uploadPath: string,
  operationId: string,
) {
  const rollbackPath = (targetPath: string) =>
    path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.restore-rollback-${operationId}`,
    );
  return {
    stagedDatabasePath: path.join(
      path.dirname(databasePath),
      `.${path.basename(databasePath)}.restore-stage-${operationId}`,
    ),
    stagedUploadPath: path.join(
      path.dirname(uploadPath),
      `.${path.basename(uploadPath)}.restore-stage-${operationId}`,
    ),
    databaseRollbackPath: rollbackPath(databasePath),
    walRollbackPath: rollbackPath(`${databasePath}-wal`),
    shmRollbackPath: rollbackPath(`${databasePath}-shm`),
    uploadRollbackPath: rollbackPath(uploadPath),
  };
}

function writeJournalMarker(journalPath: string, marker: string): void {
  fs.writeFileSync(path.join(journalPath, marker), `${marker}\n`);
}

async function createInterruptedRestore(
  root: string,
  phase: InterruptedRestorePhase,
): Promise<{
  fixture: BackupFixture;
  target: ReturnType<typeof createRestoreTarget>;
  journalPath: string;
  operationPaths: ReturnType<typeof restoreOperationPaths>;
}> {
  const fixture = await createBackupFixture(root);
  const target = createRestoreTarget(root);
  const operationId = "11111111-1111-4111-8111-111111111111";
  const operationPaths = restoreOperationPaths(
    target.databasePath,
    target.uploadPath,
    operationId,
  );
  fs.copyFileSync(
    path.join(fixture.backupDirectory, "database.sqlite"),
    operationPaths.stagedDatabasePath,
  );
  fs.cpSync(
    path.join(fixture.backupDirectory, "uploads"),
    operationPaths.stagedUploadPath,
    { recursive: true },
  );

  const originals = {
    database: fs.existsSync(target.databasePath),
    databaseWal: fs.existsSync(`${target.databasePath}-wal`),
    databaseShm: fs.existsSync(`${target.databasePath}-shm`),
    uploads: fs.existsSync(target.uploadPath),
  };
  const journalPath = getRestoreJournalPath(target.databasePath);
  fs.mkdirSync(journalPath, { recursive: false });
  fs.writeFileSync(
    path.join(journalPath, "journal.json"),
    `${JSON.stringify({
      formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
      operationId,
      databasePath: path.resolve(target.databasePath),
      uploadPath: path.resolve(target.uploadPath),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      originals,
    })}\n`,
  );

  if (phase === "prepared") {
    return { fixture, target, journalPath, operationPaths };
  }

  fs.renameSync(target.databasePath, operationPaths.databaseRollbackPath);
  if (phase === "partial-originals") {
    return { fixture, target, journalPath, operationPaths };
  }
  if (originals.databaseWal) {
    fs.renameSync(`${target.databasePath}-wal`, operationPaths.walRollbackPath);
  }
  if (originals.databaseShm) {
    fs.renameSync(`${target.databasePath}-shm`, operationPaths.shmRollbackPath);
  }
  fs.renameSync(target.uploadPath, operationPaths.uploadRollbackPath);
  writeJournalMarker(journalPath, journalMarkers[0]);
  if (phase === "originals-moved") {
    return { fixture, target, journalPath, operationPaths };
  }

  fs.renameSync(operationPaths.stagedDatabasePath, target.databasePath);
  writeJournalMarker(journalPath, journalMarkers[1]);
  if (phase === "database-installed") {
    return { fixture, target, journalPath, operationPaths };
  }

  fs.renameSync(operationPaths.stagedUploadPath, target.uploadPath);
  writeJournalMarker(journalPath, journalMarkers[2]);
  if (phase === "uploads-installed") {
    return { fixture, target, journalPath, operationPaths };
  }

  writeJournalMarker(journalPath, journalMarkers[3]);
  return { fixture, target, journalPath, operationPaths };
}

function expectNoRestoreArtifacts(
  journalPath: string,
  operationPaths: ReturnType<typeof restoreOperationPaths>,
): void {
  expect(fs.existsSync(journalPath)).toBe(false);
  for (const artifactPath of Object.values(operationPaths)) {
    expect(fs.existsSync(artifactPath), artifactPath).toBe(false);
  }
}

describe("interrupted restore recovery", () => {
  it.each<InterruptedRestorePhase>([
    "prepared",
    "partial-originals",
    "originals-moved",
    "database-installed",
    "uploads-installed",
  ])("rolls back an unvalidated %s phase", async (phase) => {
    const root = temporaryDirectory();
    const state = await createInterruptedRestore(root, phase);

    await recoverInterruptedRestore(state.target);

    expectCurrentRestoreTarget(
      state.target.databasePath,
      state.target.uploadPath,
    );
    expectNoRestoreArtifacts(state.journalPath, state.operationPaths);
  });

  it("keeps a validated restored deployment and finishes durable cleanup", async () => {
    const root = temporaryDirectory();
    const state = await createInterruptedRestore(root, "validated");

    await recoverInterruptedRestore(state.target);

    const database = new DatabaseSync(state.target.databasePath, {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT value FROM backup_probe").get()).toEqual({
        value: "backed-up",
      });
    } finally {
      database.close();
    }
    expect(
      fs.readFileSync(path.join(state.target.uploadPath, "payload.txt"), "utf8"),
    ).toBe("backup upload");
    expectNoRestoreArtifacts(state.journalPath, state.operationPaths);
  });

  it("never rolls back a validated deployment when rollback cleanup is interrupted", async () => {
    const root = temporaryDirectory();
    const state = await createInterruptedRestore(root, "validated");
    const remove = fs.promises.rm.bind(fs.promises);
    let interrupted = false;
    const removeSpy = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (targetPath, options) => {
        if (
          !interrupted &&
          path.resolve(String(targetPath)) ===
            path.resolve(state.operationPaths.uploadRollbackPath)
        ) {
          interrupted = true;
          throw new Error("forced validated cleanup interruption");
        }
        await remove(targetPath, options);
      });

    try {
      await expect(recoverInterruptedRestore(state.target)).rejects.toThrow(
        /forced validated cleanup interruption/i,
      );
    } finally {
      removeSpy.mockRestore();
    }

    const restored = new DatabaseSync(state.target.databasePath, {
      readOnly: true,
    });
    try {
      expect(restored.prepare("SELECT value FROM backup_probe").get()).toEqual({
        value: "backed-up",
      });
    } finally {
      restored.close();
    }
    expect(
      fs.readFileSync(path.join(state.target.uploadPath, "payload.txt"), "utf8"),
    ).toBe("backup upload");
    expect(fs.existsSync(state.journalPath)).toBe(true);

    await recoverInterruptedRestore(state.target);
    expectNoRestoreArtifacts(state.journalPath, state.operationPaths);
  });

  it("rejects a journal recorded for different targets without touching data", async () => {
    const root = temporaryDirectory();
    const state = await createInterruptedRestore(root, "prepared");
    const journalFile = path.join(state.journalPath, "journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as {
      uploadPath: string;
    };
    journal.uploadPath = path.join(root, "outside", "uploads");
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);

    await expect(recoverInterruptedRestore(state.target)).rejects.toThrow(
      /journal.*target|upload_path|upload path/i,
    );
    expectCurrentRestoreTarget(
      state.target.databasePath,
      state.target.uploadPath,
    );
  });
});
