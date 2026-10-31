import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pickDataRoot, migrateDataRoot, readLauncherConfig, writeLauncherConfig, findLegacyDataRoots } from "../../packaging/launcher/data-root.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todolist-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("data root is persistent, explicit, and outside program; no silent fallback", t => {
  const root = fixture(t), home = path.join(root, "home"), app = path.join(root, "program");
  const chosen = pickDataRoot({ env: {}, platform: "linux", home, programRoot: app });
  assert.equal(chosen, path.join(home, ".local/share/ToDoList"));
  assert.throws(() => pickDataRoot({ env: { TODOLIST_DATA_ROOT: path.join(app, "data") }, programRoot: app }));
  const blocked = path.join(root, "file"); fs.writeFileSync(blocked, "x");
  assert.throws(() => pickDataRoot({ env: { TODOLIST_DATA_ROOT: blocked }, programRoot: app }));
  assert.throws(() => pickDataRoot({ env: { TODOLIST_DATA_ROOT: "relative" }, programRoot: app }));
});
test("offline migration copies database/config/keys/uploads and retains originals", t => {
  const root = fixture(t), from = path.join(root, "old"), to = path.join(root, "new");
  for (const [name, content] of [["data/app.sqlite", "synthetic-db"], ["data/llm/test.json", "synthetic-key"], ["data/uploads/file", "upload"], ["config.json", '{"sessionSecret":"synthetic"}']]) {
    fs.mkdirSync(path.dirname(path.join(from, name)), { recursive: true });
    fs.writeFileSync(path.join(from, name), content);
  }
  fs.unlinkSync(path.join(from, "data/app.sqlite"));
  const db = new DatabaseSync(path.join(from, "data/app.sqlite"));
  db.exec("CREATE TABLE tasks (title TEXT); INSERT INTO tasks VALUES ('synthetic task');");
  db.close();
  migrateDataRoot(from, to);
  const migrated = new DatabaseSync(path.join(to, "data/app.sqlite"), { readOnly: true });
  assert.equal(migrated.prepare("SELECT title FROM tasks").get().title, "synthetic task");
  migrated.close();
  assert.deepEqual(fs.readFileSync(path.join(to, "data/llm/test.json")), fs.readFileSync(path.join(from, "data/llm/test.json")));
  assert.equal(fs.readFileSync(path.join(to, "config.json"), "utf8"), '{"sessionSecret":"synthetic"}');
  assert.deepEqual(fs.readFileSync(path.join(from, "data/app.sqlite")), fs.readFileSync(path.join(to, "data/app.sqlite")));
  assert.throws(() => migrateDataRoot(from, to), /contains data/);
});
test("migration refuses active SQLite sidecars, links, overlaps and existing destination", t => {
  const root = fixture(t), from = path.join(root, "old"), to = path.join(root, "new");
  fs.mkdirSync(from); fs.writeFileSync(path.join(from, "app.sqlite-wal"), "pending");
  assert.throws(() => migrateDataRoot(from, to), /Stop the old application/);
  assert.equal(fs.existsSync(to), false);
  fs.unlinkSync(path.join(from, "app.sqlite-wal"));
  fs.symlinkSync(path.join(root, "elsewhere"), path.join(from, "link"));
  assert.throws(() => migrateDataRoot(from, to), /symbolic links/);
  assert.throws(() => migrateDataRoot(from, path.join(from, "nested")), /overlap/);
});
test("configuration corruption never regenerates secrets; atomic updates preserve saved values", t => {
  const root = fixture(t), file = path.join(root, "config.json");
  assert.deepEqual(readLauncherConfig(file), {});
  writeLauncherConfig(file, { sessionSecret: "synthetic", port: 4000 });
  writeLauncherConfig(file, { ...readLauncherConfig(file), port: 4001 });
  assert.equal(readLauncherConfig(file).sessionSecret, "synthetic");
  fs.writeFileSync(file, "{bad");
  assert.throws(() => readLauncherConfig(file));
  assert.equal(fs.readFileSync(file, "utf8"), "{bad");
});


test("detects old temp and exe fallbacks when the selected program root changes", t => {
  const root = fixture(t), destination = path.join(root, "persistent");
  const temporaryRoot = path.join(root, "temporary"), exeDir = path.join(root, "exe");
  const tempLegacy = path.join(temporaryRoot, "ToDoList");
  const exeLegacy = path.join(exeDir, "ToDoList-app", "ToDoList-data");
  for (const candidate of [tempLegacy, exeLegacy]) {
    fs.mkdirSync(path.join(candidate, "data"), { recursive: true });
    fs.writeFileSync(path.join(candidate, "data", "app.sqlite"), "synthetic existence marker");
  }
  const args = {
    destination, programRoot: path.join(root, "new-local/app/versions/new"),
    env: { TODOLIST_EXE_DIR: exeDir, LOCALAPPDATA: path.join(root, "new-local") },
    temporaryRoot, home: path.join(root, "home"),
  };
  assert.deepEqual(findLegacyDataRoots(args), [exeLegacy, tempLegacy]);
  // Detection is non-mutating and does not create a new database.
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readFileSync(path.join(tempLegacy, "data/app.sqlite"), "utf8"), "synthetic existence marker");
  fs.mkdirSync(path.join(destination, "data"), { recursive: true });
  fs.writeFileSync(path.join(destination, "data/app.sqlite"), "existing current database");
  assert.deepEqual(findLegacyDataRoots(args), []);
});
