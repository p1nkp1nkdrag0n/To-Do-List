import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "../../db/migrations.js";
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type BackupManifestFile,
} from "./backup-service.js";

export const RESTORE_CONFIRMATION = "RESTORE_V2_BACKUP";
export const RESTORE_JOURNAL_FORMAT_VERSION = 1 as const;

const RESTORE_JOURNAL_FILE = "journal.json";
const RESTORE_JOURNAL_MARKERS = [
  "01-originals-moved",
  "02-database-installed",
  "03-uploads-installed",
  "04-validated",
] as const;

export interface RestoreOfflineBackupOptions {
  backupDirectory: string;
  backupPath?: string;
  databasePath: string;
  uploadPath: string;
  confirm?: boolean;
  confirmation?: string;
}

export interface OfflineRestoreResult {
  backupDirectory: string;
  databasePath: string;
  uploadPath: string;
  schemaVersion: number;
}

export interface RecoverInterruptedRestoreOptions {
  databasePath: string;
  uploadPath: string;
}

interface FileDigest {
  size: number;
  sha256: string;
}

interface RestoreJournal {
  formatVersion: typeof RESTORE_JOURNAL_FORMAT_VERSION;
  operationId: string;
  databasePath: string;
  uploadPath: string;
  schemaVersion: number;
  originals: {
    database: boolean;
    databaseWal: boolean;
    databaseShm: boolean;
    uploads: boolean;
  };
}

interface RestoreOperationPaths {
  journalPath: string;
  stagedDatabasePath: string;
  stagedUploadPath: string;
  databaseRollbackPath: string;
  walRollbackPath: string;
  shmRollbackPath: string;
  uploadRollbackPath: string;
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isCanonicalIsoDate(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isSafeManifestPath(value: string): boolean {
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return value === "database.sqlite" || value.startsWith("uploads/");
}

const ManifestFileSchema = z
  .object({
    path: z.string().refine(isSafeManifestPath, "unsafe relative file path"),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const BackupManifestSchema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schemaVersion: z.number().int().nonnegative(),
    createdAt: z.string().refine(isCanonicalIsoDate, "invalid ISO timestamp"),
    files: z.array(ManifestFileSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    let databaseEntries = 0;
    for (const [index, file] of manifest.files.entries()) {
      const key = file.path.toLocaleLowerCase("en-US");
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "duplicate file path",
        });
      }
      seen.add(key);
      if (file.path === "database.sqlite") {
        databaseEntries += 1;
      }
    }
    if (databaseEntries !== 1) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "manifest must contain exactly one database.sqlite entry",
      });
    }
  });

const RestoreJournalSchema = z
  .object({
    formatVersion: z.literal(RESTORE_JOURNAL_FORMAT_VERSION),
    operationId: z.string().uuid(),
    databasePath: z.string().min(1),
    uploadPath: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    originals: z
      .object({
        database: z.boolean(),
        databaseWal: z.boolean(),
        databaseShm: z.boolean(),
        uploads: z.boolean(),
      })
      .strict(),
  })
  .strict();

function isEqualOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isEqualOrInside(left, right) || isEqualOrInside(right, left);
}

function normalizedPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getRestoreJournalPath(databasePath: string): string {
  const resolvedDatabasePath = path.resolve(databasePath);
  return path.join(
    path.dirname(resolvedDatabasePath),
    `.${path.basename(resolvedDatabasePath)}.restore-journal`,
  );
}

function restoreOperationPaths(
  databasePath: string,
  uploadPath: string,
  operationId: string,
): RestoreOperationPaths {
  const rollbackPath = (targetPath: string) =>
    path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.restore-rollback-${operationId}`,
    );
  return {
    journalPath: getRestoreJournalPath(databasePath),
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

async function writeDurableFile(
  filePath: string,
  content: string,
): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
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

async function readManifest(
  backupDirectory: string,
): Promise<BackupManifest> {
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const stat = await fs.lstat(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Invalid backup manifest: manifest.json must be a regular file.");
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Invalid backup manifest: manifest.json is too large.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("Invalid backup manifest JSON.", { cause: error });
  }
  const parsed = BackupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid backup manifest: ${details}`);
  }
  return parsed.data;
}

async function collectBackupFiles(
  backupDirectory: string,
): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = path.join(backupDirectory, relativeDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const fullPath = path.join(backupDirectory, relativePath);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Backup contains a symbolic link: ${relativePath}`,
        );
      }
      if (stat.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `Backup contains an unsupported filesystem entry: ${relativePath}`,
        );
      }
      files.add(relativePath.split(path.sep).join("/"));
    }
  };
  await visit("");
  return files;
}

function verifyFileSet(
  actualFiles: Set<string>,
  manifest: BackupManifest,
): void {
  const expectedFiles = new Set([
    "manifest.json",
    ...manifest.files.map((file) => file.path),
  ]);
  const missing = [...expectedFiles].filter((file) => !actualFiles.has(file));
  const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Backup file set does not match manifest (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
}

async function copyFileWithDigest(
  sourcePath: string,
  destinationPath: string,
): Promise<FileDigest> {
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Backup file must be a regular file: ${sourcePath}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const digestStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(
    createReadStream(sourcePath),
    digestStream,
    createWriteStream(destinationPath, { flags: "wx" }),
  );
  return { size, sha256: hash.digest("hex") };
}

function assertDigest(
  manifestFile: BackupManifestFile,
  actual: FileDigest,
): void {
  if (actual.size !== manifestFile.size) {
    throw new Error(
      `Backup file size mismatch for ${manifestFile.path}: expected ${manifestFile.size}, found ${actual.size}.`,
    );
  }
  if (actual.sha256 !== manifestFile.sha256) {
    throw new Error(`Backup file SHA-256 mismatch for ${manifestFile.path}.`);
  }
}

async function digestRegularFile(filePath: string): Promise<FileDigest> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Referenced blob must be a regular file: ${filePath}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function validateDeployment(
  databasePath: string,
  uploadPath: string,
  expectedSchemaVersion: number,
  manifest?: BackupManifest,
): Promise<number> {
  let referencedBlobs: Array<{
    storageKey: string;
    byteSize: number;
    sha256: string;
  }> = [];
  let schemaVersion = 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database
      .prepare("PRAGMA integrity_check")
      .all() as Array<{ integrity_check: string }>;
    if (
      integrityRows.length !== 1 ||
      integrityRows[0]?.integrity_check !== "ok"
    ) {
      throw new Error("Backup database failed SQLite integrity_check.");
    }
    const migrationTable = database
      .prepare(
        `SELECT 1 AS present
           FROM sqlite_master
          WHERE type = 'table' AND name = 'schema_migrations'`,
      )
      .get() as { present: number } | undefined;
    if (migrationTable === undefined) {
      throw new Error("Backup database has no schema_migrations table.");
    }
    const appliedMigrations = database
      .prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
      .all() as Array<{
      version: number;
      name: string;
      checksum: string;
    }>;
    const lastApplied = appliedMigrations.at(-1);
    if (
      lastApplied === undefined ||
      !Number.isSafeInteger(lastApplied.version) ||
      lastApplied.version < 1
    ) {
      throw new Error("Backup database has an invalid schema version.");
    }
    if (lastApplied.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Backup schema version ${lastApplied.version} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`,
      );
    }
    const expectedMigrations = MIGRATIONS.filter(
      (migration) => migration.version <= lastApplied.version,
    );
    if (appliedMigrations.length !== expectedMigrations.length) {
      throw new Error(
        "Backup database migration history does not match this build.",
      );
    }
    for (const [index, expected] of expectedMigrations.entries()) {
      const applied = appliedMigrations[index];
      if (applied?.version !== expected.version) {
        throw new Error(
          `Backup database migration version mismatch at position ${index + 1}.`,
        );
      }
      if (applied.name !== expected.name) {
        throw new Error(
          `Backup database migration ${expected.version} name mismatch.`,
        );
      }
      if (applied.checksum !== expected.checksum) {
        throw new Error(
          `Backup database migration ${expected.version} checksum mismatch.`,
        );
      }
    }
    if (lastApplied.version !== expectedSchemaVersion) {
      throw new Error(
        `Expected schema version ${expectedSchemaVersion} does not match database schema version ${lastApplied.version}.`,
      );
    }

    const foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Backup database failed foreign key validation (${foreignKeyViolations.length} violation(s)).`,
      );
    }

    referencedBlobs = database
      .prepare(
        `SELECT storage_key AS storageKey, byte_size AS byteSize, sha256
           FROM resource_versions
          WHERE storage_key IS NOT NULL`,
      )
      .all() as Array<{
      storageKey: string;
      byteSize: number;
      sha256: string;
    }>;
    schemaVersion = lastApplied.version;
  } finally {
    database.close();
  }

  await assertNoSymbolicLinkComponents(uploadPath, "UPLOAD_PATH");
  const uploadStat = await fs.lstat(uploadPath);
  if (uploadStat.isSymbolicLink() || !uploadStat.isDirectory()) {
    throw new Error("Restored UPLOAD_PATH must be a regular directory.");
  }
  const manifestFiles =
    manifest === undefined
      ? undefined
      : new Map(manifest.files.map((file) => [file.path, file]));
  for (const blob of referencedBlobs) {
    if (!/^[a-f0-9]{64}$/.test(blob.storageKey)) {
      throw new Error(
        `Referenced blob storage key is invalid: ${blob.storageKey}`,
      );
    }
    const manifestFile = manifestFiles?.get(`uploads/${blob.storageKey}`);
    if (manifestFiles !== undefined && manifestFile === undefined) {
      throw new Error(
        `Referenced blob ${blob.storageKey} is missing from the backup manifest.`,
      );
    }
    const blobPath = path.resolve(uploadPath, blob.storageKey);
    if (!isEqualOrInside(blobPath, uploadPath) || blobPath === uploadPath) {
      throw new Error(`Referenced blob path escaped UPLOAD_PATH: ${blob.storageKey}`);
    }
    const blobStat = await lstatIfExists(blobPath);
    if (blobStat === undefined) {
      throw new Error(`Referenced blob ${blob.storageKey} is missing from uploads.`);
    }
    const actual = await digestRegularFile(blobPath);
    if (actual.size !== blob.byteSize) {
      throw new Error(
        `Referenced blob ${blob.storageKey} size does not match the database row.`,
      );
    }
    if (actual.sha256 !== blob.sha256) {
      throw new Error(
        `Referenced blob ${blob.storageKey} SHA-256 does not match the database row.`,
      );
    }
    if (manifestFile !== undefined) {
      assertDigest(manifestFile, actual);
    }
  }
  return schemaVersion;
}

async function validateExistingTarget(
  targetPath: string,
  expectedType: "file" | "directory",
): Promise<void> {
  await assertNoSymbolicLinkComponents(targetPath, targetPath);
  const stat = await lstatIfExists(targetPath);
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Restore target must not be a symbolic link: ${targetPath}`);
  }
  if (
    (expectedType === "file" && !stat.isFile()) ||
    (expectedType === "directory" && !stat.isDirectory())
  ) {
    throw new Error(`Restore target has the wrong filesystem type: ${targetPath}`);
  }
}

async function syncRename(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.rename(sourcePath, destinationPath);
  await syncDirectory(path.dirname(sourcePath));
  if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
    await syncDirectory(path.dirname(destinationPath));
  }
}

async function removeRestoreArtifact(artifactPath: string): Promise<void> {
  const stat = await lstatIfExists(artifactPath);
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Restore artifact must not be a symbolic link: ${artifactPath}`);
  }
  await fs.rm(artifactPath, { recursive: true, force: true });
  await syncDirectory(path.dirname(artifactPath));
}

async function createRestoreJournal(journal: RestoreJournal): Promise<void> {
  const paths = restoreOperationPaths(
    journal.databasePath,
    journal.uploadPath,
    journal.operationId,
  );
  if ((await lstatIfExists(paths.journalPath)) !== undefined) {
    throw new Error(
      `An interrupted restore journal already exists: ${paths.journalPath}`,
    );
  }
  const temporaryJournalPath = `${paths.journalPath}.create-${journal.operationId}`;
  await fs.mkdir(temporaryJournalPath, { recursive: false, mode: 0o700 });
  try {
    await writeDurableFile(
      path.join(temporaryJournalPath, RESTORE_JOURNAL_FILE),
      `${JSON.stringify(journal)}\n`,
    );
    await syncRename(temporaryJournalPath, paths.journalPath);
  } catch (error) {
    await fs.rm(temporaryJournalPath, { recursive: true, force: true });
    throw error;
  }
}

async function writeJournalMarker(
  journalPath: string,
  marker: (typeof RESTORE_JOURNAL_MARKERS)[number],
): Promise<void> {
  await writeDurableFile(path.join(journalPath, marker), `${marker}\n`);
}

async function readRestoreJournal(
  options: RecoverInterruptedRestoreOptions,
): Promise<{ journal: RestoreJournal; completedMarkers: number }> {
  const databasePath = path.resolve(options.databasePath);
  const uploadPath = path.resolve(options.uploadPath);
  const journalPath = getRestoreJournalPath(databasePath);
  await assertNoSymbolicLinkComponents(path.dirname(databasePath), "DB_PATH parent");
  await assertNoSymbolicLinkComponents(path.dirname(uploadPath), "UPLOAD_PATH parent");
  const journalStat = await fs.lstat(journalPath);
  if (journalStat.isSymbolicLink() || !journalStat.isDirectory()) {
    throw new Error("Restore journal must be a regular directory.");
  }

  const allowedEntries = new Set<string>([
    RESTORE_JOURNAL_FILE,
    ...RESTORE_JOURNAL_MARKERS,
  ]);
  const entries = await fs.readdir(journalPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowedEntries.has(entry.name)) {
      throw new Error(`Restore journal contains an unexpected entry: ${entry.name}`);
    }
    const entryPath = path.join(journalPath, entry.name);
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Restore journal entry must be a regular file: ${entry.name}`);
    }
  }

  const journalFilePath = path.join(journalPath, RESTORE_JOURNAL_FILE);
  const journalFileStat = await fs.lstat(journalFilePath);
  if (journalFileStat.size > MAX_JOURNAL_BYTES) {
    throw new Error("Restore journal is too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(journalFilePath, "utf8"));
  } catch (error) {
    throw new Error("Restore journal JSON is invalid.", { cause: error });
  }
  const parsed = RestoreJournalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Restore journal is invalid: ${parsed.error.message}`);
  }
  const journal = parsed.data;
  if (
    normalizedPath(journal.databasePath) !== normalizedPath(databasePath) ||
    normalizedPath(journal.uploadPath) !== normalizedPath(uploadPath)
  ) {
    throw new Error("Restore journal target paths do not match DB_PATH and UPLOAD_PATH.");
  }
  if (journal.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Restore journal schema version ${journal.schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  let completedMarkers = 0;
  for (const marker of RESTORE_JOURNAL_MARKERS) {
    const markerPath = path.join(journalPath, marker);
    const markerStat = await lstatIfExists(markerPath);
    if (markerStat === undefined) {
      break;
    }
    const markerContent = await fs.readFile(markerPath, "utf8");
    if (markerContent !== `${marker}\n`) {
      break;
    }
    completedMarkers += 1;
  }
  return { journal, completedMarkers };
}

function journalTargets(journal: RestoreJournal, paths: RestoreOperationPaths) {
  return [
    {
      targetPath: journal.uploadPath,
      rollbackPath: paths.uploadRollbackPath,
      expectedType: "directory" as const,
      existed: journal.originals.uploads,
    },
    {
      targetPath: `${journal.databasePath}-shm`,
      rollbackPath: paths.shmRollbackPath,
      expectedType: "file" as const,
      existed: journal.originals.databaseShm,
    },
    {
      targetPath: `${journal.databasePath}-wal`,
      rollbackPath: paths.walRollbackPath,
      expectedType: "file" as const,
      existed: journal.originals.databaseWal,
    },
    {
      targetPath: journal.databasePath,
      rollbackPath: paths.databaseRollbackPath,
      expectedType: "file" as const,
      existed: journal.originals.database,
    },
  ];
}

async function rollbackInterruptedRestore(
  journal: RestoreJournal,
  paths: RestoreOperationPaths,
): Promise<void> {
  for (const target of journalTargets(journal, paths)) {
    const rollbackStat = await lstatIfExists(target.rollbackPath);
    const targetStat = await lstatIfExists(target.targetPath);
    if (rollbackStat?.isSymbolicLink() || targetStat?.isSymbolicLink()) {
      throw new Error("Restore rollback paths must not contain symbolic links.");
    }
    if (target.existed) {
      if (rollbackStat === undefined) {
        if (targetStat === undefined) {
          throw new Error(
            `Cannot recover interrupted restore because both target and rollback are missing: ${target.targetPath}`,
          );
        }
        await validateExistingTarget(target.targetPath, target.expectedType);
        continue;
      }
      if (
        (target.expectedType === "file" && !rollbackStat.isFile()) ||
        (target.expectedType === "directory" && !rollbackStat.isDirectory())
      ) {
        throw new Error(`Restore rollback has the wrong type: ${target.rollbackPath}`);
      }
      if (targetStat !== undefined) {
        await removeRestoreArtifact(target.targetPath);
      }
      await syncRename(target.rollbackPath, target.targetPath);
      continue;
    }
    if (rollbackStat !== undefined) {
      throw new Error(
        `Restore journal found an unexpected rollback target: ${target.rollbackPath}`,
      );
    }
    if (targetStat !== undefined) {
      await removeRestoreArtifact(target.targetPath);
    }
  }

  await removeRestoreArtifact(paths.stagedDatabasePath);
  await removeRestoreArtifact(paths.stagedUploadPath);
  await removeRestoreArtifact(paths.journalPath);
}

async function finishValidatedRestore(
  journal: RestoreJournal,
  paths: RestoreOperationPaths,
): Promise<void> {
  for (const target of journalTargets(journal, paths)) {
    await removeRestoreArtifact(target.rollbackPath);
  }
  await removeRestoreArtifact(paths.stagedDatabasePath);
  await removeRestoreArtifact(paths.stagedUploadPath);
  await removeRestoreArtifact(paths.journalPath);
}

export async function recoverInterruptedRestore(
  options: RecoverInterruptedRestoreOptions,
): Promise<boolean> {
  const databasePath = path.resolve(options.databasePath);
  const uploadPath = path.resolve(options.uploadPath);
  const journalPath = getRestoreJournalPath(databasePath);
  if ((await lstatIfExists(journalPath)) === undefined) {
    return false;
  }
  const { journal, completedMarkers } = await readRestoreJournal({
    databasePath,
    uploadPath,
  });
  const paths = restoreOperationPaths(
    databasePath,
    uploadPath,
    journal.operationId,
  );
  if (completedMarkers === RESTORE_JOURNAL_MARKERS.length) {
    try {
      await validateDeployment(databasePath, uploadPath, journal.schemaVersion);
    } catch {
      await rollbackInterruptedRestore(journal, paths);
      return true;
    }
    await finishValidatedRestore(journal, paths);
    return true;
  }
  await rollbackInterruptedRestore(journal, paths);
  return true;
}

async function moveOriginalTarget(
  targetPath: string,
  rollbackPath: string,
  expectedToExist: boolean,
  expectedType: "file" | "directory",
): Promise<void> {
  const targetStat = await lstatIfExists(targetPath);
  if (!expectedToExist) {
    if (targetStat !== undefined) {
      throw new Error(`Restore target changed after journal creation: ${targetPath}`);
    }
    return;
  }
  if (targetStat === undefined) {
    throw new Error(`Restore target disappeared after journal creation: ${targetPath}`);
  }
  await validateExistingTarget(targetPath, expectedType);
  if ((await lstatIfExists(rollbackPath)) !== undefined) {
    throw new Error(`Restore rollback path already exists: ${rollbackPath}`);
  }
  await syncRename(targetPath, rollbackPath);
}

async function replaceTargets(
  journal: RestoreJournal,
  paths: RestoreOperationPaths,
): Promise<void> {
  await createRestoreJournal(journal);
  let validatedMarkerWritten = false;
  try {
    await moveOriginalTarget(
      journal.databasePath,
      paths.databaseRollbackPath,
      journal.originals.database,
      "file",
    );
    await moveOriginalTarget(
      `${journal.databasePath}-wal`,
      paths.walRollbackPath,
      journal.originals.databaseWal,
      "file",
    );
    await moveOriginalTarget(
      `${journal.databasePath}-shm`,
      paths.shmRollbackPath,
      journal.originals.databaseShm,
      "file",
    );
    await moveOriginalTarget(
      journal.uploadPath,
      paths.uploadRollbackPath,
      journal.originals.uploads,
      "directory",
    );
    await writeJournalMarker(paths.journalPath, RESTORE_JOURNAL_MARKERS[0]);

    await syncRename(paths.stagedDatabasePath, journal.databasePath);
    await writeJournalMarker(paths.journalPath, RESTORE_JOURNAL_MARKERS[1]);
    await syncRename(paths.stagedUploadPath, journal.uploadPath);
    await writeJournalMarker(paths.journalPath, RESTORE_JOURNAL_MARKERS[2]);

    await validateDeployment(
      journal.databasePath,
      journal.uploadPath,
      journal.schemaVersion,
    );
    await writeJournalMarker(paths.journalPath, RESTORE_JOURNAL_MARKERS[3]);
    validatedMarkerWritten = true;
    await finishValidatedRestore(journal, paths);
  } catch (error) {
    try {
      await recoverInterruptedRestore({
        databasePath: journal.databasePath,
        uploadPath: journal.uploadPath,
      });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Restore failed and the durable journal could not recover all targets.",
      );
    }
    if (!validatedMarkerWritten) {
      throw error;
    }
  }
}

export async function restoreOfflineBackup(
  options: RestoreOfflineBackupOptions,
): Promise<OfflineRestoreResult> {
  if (
    options.confirm !== true &&
    options.confirmation !== RESTORE_CONFIRMATION
  ) {
    throw new Error("Explicit restore confirmation is required.");
  }

  const backupDirectory = path.resolve(options.backupDirectory);
  const databasePath = path.resolve(options.databasePath);
  const uploadPath = path.resolve(options.uploadPath);
  if (options.backupPath !== undefined) {
    const backupRoot = path.resolve(options.backupPath);
    const relative = path.relative(backupRoot, backupDirectory);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).length !== 1
    ) {
      throw new Error("Backup directory must be a direct child of BACKUP_PATH.");
    }
  }
  if (pathsOverlap(databasePath, uploadPath)) {
    throw new Error("DB_PATH and UPLOAD_PATH must not overlap.");
  }
  if (
    pathsOverlap(backupDirectory, databasePath) ||
    pathsOverlap(backupDirectory, uploadPath)
  ) {
    throw new Error("Backup and restore target paths must not overlap.");
  }

  await assertNoSymbolicLinkComponents(backupDirectory, "Backup directory");
  const backupStat = await fs.lstat(backupDirectory);
  if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
    throw new Error("Backup directory must be a regular directory.");
  }
  const manifest = await readManifest(backupDirectory);
  const actualFiles = await collectBackupFiles(backupDirectory);
  verifyFileSet(actualFiles, manifest);

  await assertNoSymbolicLinkComponents(
    path.dirname(databasePath),
    "DB_PATH parent",
  );
  await assertNoSymbolicLinkComponents(
    path.dirname(uploadPath),
    "UPLOAD_PATH parent",
  );
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.mkdir(path.dirname(uploadPath), { recursive: true });
  await assertNoSymbolicLinkComponents(
    path.dirname(databasePath),
    "DB_PATH parent",
  );
  await assertNoSymbolicLinkComponents(
    path.dirname(uploadPath),
    "UPLOAD_PATH parent",
  );

  await recoverInterruptedRestore({ databasePath, uploadPath });

  const operationId = randomUUID();
  const operationPaths = restoreOperationPaths(
    databasePath,
    uploadPath,
    operationId,
  );
  await fs.mkdir(operationPaths.stagedUploadPath, { recursive: false });

  try {
    for (const manifestFile of manifest.files) {
      const sourcePath = path.join(
        backupDirectory,
        ...manifestFile.path.split("/"),
      );
      const destinationPath =
        manifestFile.path === "database.sqlite"
          ? operationPaths.stagedDatabasePath
          : path.join(
              operationPaths.stagedUploadPath,
              ...manifestFile.path.slice("uploads/".length).split("/"),
            );
      const digest = await copyFileWithDigest(sourcePath, destinationPath);
      assertDigest(manifestFile, digest);
    }

    const schemaVersion = await validateDeployment(
      operationPaths.stagedDatabasePath,
      operationPaths.stagedUploadPath,
      manifest.schemaVersion,
      manifest,
    );
    await validateExistingTarget(databasePath, "file");
    await validateExistingTarget(`${databasePath}-wal`, "file");
    await validateExistingTarget(`${databasePath}-shm`, "file");
    await validateExistingTarget(uploadPath, "directory");
    const journal: RestoreJournal = {
      formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
      operationId,
      databasePath,
      uploadPath,
      schemaVersion,
      originals: {
        database: (await lstatIfExists(databasePath)) !== undefined,
        databaseWal: (await lstatIfExists(`${databasePath}-wal`)) !== undefined,
        databaseShm: (await lstatIfExists(`${databasePath}-shm`)) !== undefined,
        uploads: (await lstatIfExists(uploadPath)) !== undefined,
      },
    };
    await replaceTargets(journal, operationPaths);

    return {
      backupDirectory,
      databasePath,
      uploadPath,
      schemaVersion,
    };
  } finally {
    await Promise.allSettled([
      fs.rm(operationPaths.stagedDatabasePath, { force: true }),
      fs.rm(operationPaths.stagedUploadPath, { recursive: true, force: true }),
    ]);
  }
}
