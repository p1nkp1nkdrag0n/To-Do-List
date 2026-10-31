import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
  if (fs.existsSync(root + ".migration-lock")) throw new Error("Data migration is in progress; do not start a second instance.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (programRoot && inside(fs.realpathSync(root), fs.existsSync(programRoot) ? fs.realpathSync(programRoot) : path.resolve(programRoot))) throw new Error("Data directory must be outside the program directory.");
  const probe = path.join(root, `.write-test-${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 }); }
  finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
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
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) throw new Error("Destination already contains data; migration refused.");
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
  const lock = destination + ".migration-lock";
  const fd = fs.openSync(lock, "wx", 0o600);
  const stage = destination + ".migration-" + crypto.randomUUID();
  try {
    // Recheck under the migration lock before publishing.
    if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) throw new Error("Destination already contains data.");
    fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
    check(stage);
    if (fs.existsSync(destination)) fs.rmdirSync(destination); // empty only; never recursive
    fs.renameSync(stage, destination);
  } finally {
    fs.closeSync(fd); fs.unlinkSync(lock);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Malformed/unreadable configuration is an error, never a request to reset keys. */
export function readLauncherConfig(filename) {
  if (!fs.existsSync(filename)) return {};
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid launcher configuration.");
  return value;
}

export function writeLauncherConfig(filename, config) {
  const temp = filename + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

/** Detect old fallbacks even when permissions now select a different program root.
 * Only existence is inspected; no old database or key is opened or auto-migrated.
 * Injectable paths keep regression tests isolated from actual user directories.
 */
export function findLegacyDataRoots({
  destination, programRoot, env = process.env, temporaryRoot = os.tmpdir(), home = os.homedir(),
}) {
  if (fs.existsSync(path.join(destination, "data", "app.sqlite"))) return [];
  const candidates = [
    env.TODOLIST_LEGACY_ROOT,
    programRoot && path.join(programRoot, "ToDoList-data"),
    env.TODOLIST_EXE_DIR && path.join(env.TODOLIST_EXE_DIR, "ToDoList-app", "ToDoList-data"),
    path.join(temporaryRoot, "ToDoList"),
    path.join(temporaryRoot, "ToDoList-app", "ToDoList-data"),
    path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ToDoList", "app", "ToDoList-data"),
  ].filter(Boolean).map(p => path.resolve(p));
  return [...new Set(candidates)].filter(p => p !== path.resolve(destination) &&
    fs.existsSync(path.join(p, "data", "app.sqlite")));
}
