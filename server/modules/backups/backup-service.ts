import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fileSystem } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { V2Database } from "../../db/database.js";
import { CURRENT_SCHEMA_VERSION } from "../../db/migrations.js";

export const BACKUP_FORMAT_VERSION = 1 as const;

export interface BackupManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  schemaVersion: number;
  createdAt: string;
  files: BackupManifestFile[];
}

export interface CreateOfflineBackupOptions {
  database: V2Database;
  uploadPath: string;
  backupPath: string;
  name?: string;
  now?: () => Date;
}

export interface OfflineBackupResult {
  backupDirectory: string;
  manifest: BackupManifest;
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isEqualToOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(
    normalizeForComparison(parent),
    normalizeForComparison(candidate),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function validateBackupName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    path.isAbsolute(name) ||
    path.basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)
  ) {
    throw new Error("Backup name must be a safe directory name without path traversal.");
  }
  return name;
}

function defaultBackupName(now: Date): string {
  return `v2-backup-${now.toISOString().replaceAll(":", "-")}`;
}

async function lstatIfExists(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fileSystem.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
    const stats = await lstatIfExists(currentPath);
    if (stats === undefined) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links.`);
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function describeFile(
  absolutePath: string,
  relativePath: string,
): Promise<BackupManifestFile> {
  const stats = await fileSystem.stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Backup entry is not a regular file: ${relativePath}`);
  }
  return {
    path: relativePath.split(path.sep).join("/"),
    size: stats.size,
    sha256: await sha256File(absolutePath),
  };
}

async function copyFileWithDigest(
  sourcePath: string,
  destinationPath: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const digestStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    fs.createReadStream(sourcePath),
    digestStream,
    fs.createWriteStream(destinationPath, { flags: "wx" }),
  );
  return { size, sha256: hash.digest("hex") };
}

async function copyUploads(
  uploadRoot: string,
  destinationRoot: string,
): Promise<BackupManifestFile[]> {
  let rootStats: fs.Stats;
  try {
    rootStats = await fileSystem.lstat(uploadRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fileSystem.mkdir(destinationRoot, { recursive: true });
      return [];
    }
    throw error;
  }

  if (rootStats.isSymbolicLink()) {
    throw new Error("UPLOAD_PATH must not be a symbolic link.");
  }
  if (!rootStats.isDirectory()) {
    throw new Error("UPLOAD_PATH must be a directory.");
  }

  await fileSystem.mkdir(destinationRoot, { recursive: true });
  const manifestFiles: BackupManifestFile[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    const sourceDirectory = path.resolve(uploadRoot, relativeDirectory);
    if (!isEqualToOrInside(sourceDirectory, uploadRoot)) {
      throw new Error("Upload path traversal was rejected.");
    }

    const entries = await fileSystem.readdir(sourceDirectory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativeEntry = path.join(relativeDirectory, entry.name);
      const sourceEntry = path.resolve(uploadRoot, relativeEntry);
      const destinationEntry = path.resolve(destinationRoot, relativeEntry);
      if (
        !isEqualToOrInside(sourceEntry, uploadRoot) ||
        !isEqualToOrInside(destinationEntry, destinationRoot)
      ) {
        throw new Error("Upload path traversal was rejected.");
      }

      const stats = await fileSystem.lstat(sourceEntry);
      if (stats.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in uploads: ${relativeEntry}`);
      }
      if (stats.isDirectory()) {
        await fileSystem.mkdir(destinationEntry, { recursive: false });
        await visit(relativeEntry);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Only regular upload files can be backed up: ${relativeEntry}`);
      }

      const digest = await copyFileWithDigest(sourceEntry, destinationEntry);
      manifestFiles.push({
        path: path.posix.join(
          "uploads",
          relativeEntry.split(path.sep).join("/"),
        ),
        ...digest,
      });
    }
  }

  await visit("");
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  return manifestFiles;
}

function inspectSnapshot(databasePath: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    const journalMode = database.prepare("PRAGMA journal_mode = DELETE").get() as
      | { journal_mode?: unknown }
      | undefined;
    if (journalMode?.journal_mode !== "delete") {
      throw new Error("SQLite backup could not be normalized to a standalone journal mode.");
    }
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrityRows.length !== 1 ||
      integrityRows[0]?.integrity_check !== "ok"
    ) {
      throw new Error("SQLite backup failed integrity_check.");
    }

    const migrationTable = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as Record<string, unknown> | undefined;
    if (migrationTable === undefined) {
      throw new Error("SQLite backup does not contain schema_migrations.");
    }
    const row = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version?: unknown } | undefined;
    if (!Number.isSafeInteger(row?.version) || Number(row?.version) < 1) {
      throw new Error("SQLite backup has an invalid schema migration version.");
    }
    const schemaVersion = Number(row!.version);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`,
      );
    }
    return schemaVersion;
  } finally {
    database.close();
  }
}

export async function createOfflineBackup(
  options: CreateOfflineBackupOptions,
): Promise<OfflineBackupResult> {
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Backup timestamp must be a valid Date.");
  }

  const backupRoot = path.resolve(options.backupPath);
  const uploadRoot = path.resolve(options.uploadPath);
  await assertNoSymbolicLinkComponents(backupRoot, "BACKUP_PATH");
  await assertNoSymbolicLinkComponents(uploadRoot, "UPLOAD_PATH");
  if (
    isEqualToOrInside(backupRoot, uploadRoot) ||
    isEqualToOrInside(uploadRoot, backupRoot)
  ) {
    throw new Error("BACKUP_PATH and UPLOAD_PATH must be separate directory trees.");
  }

  const name = validateBackupName(options.name ?? defaultBackupName(now));
  const backupDirectory = path.resolve(backupRoot, name);
  if (!isEqualToOrInside(backupDirectory, backupRoot) || backupDirectory === backupRoot) {
    throw new Error("Backup directory must remain inside BACKUP_PATH.");
  }

  await assertNoSymbolicLinkComponents(backupRoot, "BACKUP_PATH");
  await assertNoSymbolicLinkComponents(uploadRoot, "UPLOAD_PATH");
  await fileSystem.mkdir(backupRoot, { recursive: true });
  await assertNoSymbolicLinkComponents(backupRoot, "BACKUP_PATH");
  const backupRootStats = await fileSystem.lstat(backupRoot);
  if (backupRootStats.isSymbolicLink() || !backupRootStats.isDirectory()) {
    throw new Error("BACKUP_PATH must be a real directory, not a symbolic link.");
  }
  try {
    await fileSystem.lstat(backupDirectory);
    throw new Error(`Backup directory already exists: ${backupDirectory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const stagingDirectory = path.resolve(
    backupRoot,
    `.${name}.tmp-${randomUUID()}`,
  );
  await fileSystem.mkdir(stagingDirectory, { recursive: false });

  try {
    const databasePath = path.join(stagingDirectory, "database.sqlite");
    await options.database.backupTo(databasePath);
    const schemaVersion = inspectSnapshot(databasePath);
    const databaseFile = await describeFile(databasePath, "database.sqlite");
    const uploadFiles = await copyUploads(
      uploadRoot,
      path.join(stagingDirectory, "uploads"),
    );
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion,
      createdAt: now.toISOString(),
      files: [databaseFile, ...uploadFiles],
    };
    await fileSystem.writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await fileSystem.rename(stagingDirectory, backupDirectory);
    return { backupDirectory, manifest };
  } catch (error) {
    await fileSystem.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
