import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function existsChecked(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function inside(candidate, parent) {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Persistent storage only: never silently switch databases after a permission failure. */
export function pickDataRoot({ env = process.env, platform = process.platform, home = os.homedir(), programRoot } = {}) {
  const configured = env.TODOLIST_DATA_ROOT;
  if (configured && !path.isAbsolute(configured)) throw new Error("TODOLIST_DATA_ROOT must be absolute.");
  const root = path.resolve(configured || (platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ToDoList")
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "ToDoList")));
  // The default single-exe program is a child of the data root, not vice versa.
  if (programRoot && inside(root, path.resolve(programRoot))) throw new Error("Data directory must be outside the program directory.");
  if (existsChecked(root + ".migration-lock")) throw new Error("Data migration is in progress; do not start a second instance.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (programRoot && inside(fs.realpathSync(root), existsChecked(programRoot) ? fs.realpathSync(programRoot) : path.resolve(programRoot))) throw new Error("Data directory must be outside the program directory.");
  const probe = path.join(root, `.write-test-${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 }); }
  finally { if (existsChecked(probe)) fs.unlinkSync(probe); }
  return root;
}

/**
 * Explicit, offline migration. Copy the WHOLE old root, including config.json,
 * SQLite, uploads and per-user keys. Never merge, overwrite or delete originals.
 * A destination with existing data is authoritative and must be handled manually.
 */
export function migrateDataRoot(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) return;
  if (inside(destination, source) || inside(source, destination)) throw new Error("Migration roots must not overlap.");
  if (!fs.lstatSync(source).isDirectory()) throw new Error("Legacy data root must be a real directory, not a symbolic link.");
  if (existsChecked(destination) && (!fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink())) throw new Error("Migration destination must be a real directory.");
  if (existsChecked(destination) && fs.readdirSync(destination).length > 0) throw new Error("Destination already contains data; migration refused.");
  const check = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Migration refuses symbolic links.");
      if (entry.isDirectory()) check(p);
      else if (!entry.isFile()) throw new Error("Migration refuses special files.");
      else if (/-wal$|-shm$|-journal$/.test(entry.name)) throw new Error("Stop the old application and cleanly close SQLite before migration.");
    }
  };
  check(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const realSource = fs.realpathSync(source);
  const realDestination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  if (inside(realDestination, realSource) || inside(realSource, realDestination)) throw new Error("Migration roots must not overlap through aliases.");
  const lock = destination + ".migration-lock";
  const fd = fs.openSync(lock, "wx", 0o600);
  const stage = destination + ".migration-" + crypto.randomUUID();
  const databasePath = path.join(source, "data", "app.sqlite");
  let database;
  let transactionStarted = false;
  try {
    // Recheck under the migration lock before publishing.
    if (existsChecked(destination) && fs.readdirSync(destination).length > 0) throw new Error("Destination already contains data.");
    // Fail fast if an old process holds a SQLite transaction. Keep the lock
    // through copying so a racing writer cannot produce a torn database copy.
    if (!existsChecked(databasePath)) throw new Error("Legacy app.sqlite was not found.");
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    transactionStarted = true;
    // A normal old instance can reopen and commit after the first preflight.
    // With the write lock now held, nonempty WAL must never be skipped: those
    // committed frames may not yet be present in the main database file.
    const wal = databasePath + "-wal";
    if (existsChecked(wal)) {
      const walState = fs.lstatSync(wal);
      if (!walState.isFile() || walState.isSymbolicLink() || walState.size > 0)
        throw new Error("数据库在迁移检查后仍有 WAL 写入或日志状态异常；请关闭旧程序后重试，日志未被删除。");
    }
    if (existsChecked(databasePath + "-journal"))
      throw new Error("迁移锁内发现数据库 journal；请正常关闭旧程序后重试。");
    if (existsChecked(databasePath + "-shm")) {
      const shmState = fs.lstatSync(databasePath + "-shm");
      if (!shmState.isFile() || shmState.isSymbolicLink()) throw new Error("SQLite SHM 状态异常，已拒绝迁移。");
    }
    fs.mkdirSync(stage, { mode: 0o700 });
    const owned = new Map([[stage, fs.lstatSync(stage)]]);
    const copyTree = (from, to) => {
      for (const name of fs.readdirSync(from)) {
        const input = path.join(from, name), output = path.join(to, name);
        // The connection may create empty sidecars after preflight. Keep them
        // in the source and let SQLite close its own handles normally.
        if (input === databasePath + "-wal" || input === databasePath + "-shm") continue;
        const stat = fs.lstatSync(input);
        if (stat.isSymbolicLink()) throw new Error("Migration refuses symbolic links.");
        if (stat.isDirectory()) {
          fs.mkdirSync(output, { mode: 0o700 });
          owned.set(output, fs.lstatSync(output));
          copyTree(input, output);
        } else if (stat.isFile()) {
          fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
          const copied = fs.openSync(output, "r+");
          try { fs.fsyncSync(copied); } finally { fs.closeSync(copied); }
          owned.set(output, fs.lstatSync(output));
        } else throw new Error("Migration refuses special files.");
      }
    };
    copyTree(source, stage);
    const validateOwned = dir => {
      const before = owned.get(dir), after = fs.lstatSync(dir);
      if (!before || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev)
        throw new Error("Migration staging ownership changed; data was not published.");
      if (after.isDirectory()) for (const name of fs.readdirSync(dir)) validateOwned(path.join(dir, name));
    };
    validateOwned(stage);
    check(stage);
    if (existsChecked(destination)) fs.rmdirSync(destination); // empty only; never recursive
    fs.renameSync(stage, destination);
  } finally {
    try {
      if (transactionStarted) database.exec("ROLLBACK");
    } finally {
      try { database?.close(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }
    // Failed staging copies are deliberately retained. Do not recursively delete
    // a directory another process may have populated after its creation.

  }
}

/** Malformed/unreadable configuration is an error, never a request to reset keys. */
export function readLauncherConfig(filename) {
  if (!existsChecked(filename)) return {};
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid launcher configuration.");
  return value;
}

export function writeLauncherConfig(filename, config) {
  const temp = filename + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { if (existsChecked(temp)) fs.unlinkSync(temp); }
}

/** Detect old fallbacks even when permissions now select a different program root.
 * Only existence is inspected; no old database or key is opened or auto-migrated.
 * Injectable paths keep regression tests isolated from actual user directories.
 */
export function findLegacyDataRoots({
  destination, programRoot, env = process.env, temporaryRoot = os.tmpdir(), home = os.homedir(),
}) {
  if (existsChecked(path.join(destination, "data", "app.sqlite"))) return [];
  const candidates = [
    env.TODOLIST_LEGACY_ROOT,
    programRoot && path.join(programRoot, "ToDoList-data"),
    env.TODOLIST_EXE_DIR && path.join(env.TODOLIST_EXE_DIR, "ToDoList-app", "ToDoList-data"),
    path.join(temporaryRoot, "ToDoList"),
    path.join(temporaryRoot, "ToDoList-app", "ToDoList-data"),
    path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ToDoList", "app", "ToDoList-data"),
  ].filter(Boolean).map(p => path.resolve(p));
  return [...new Set(candidates)].filter(p => p !== path.resolve(destination) &&
    existsChecked(path.join(p, "data", "app.sqlite")));
}
