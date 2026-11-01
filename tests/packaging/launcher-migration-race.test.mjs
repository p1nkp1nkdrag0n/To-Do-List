import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDataRoot } from '../../packaging/launcher/data-root.mjs';

test('a WAL commit after preflight but before SQLite lock must not be dropped by raw copying', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-race-test-'));
  const source = path.join(base, 'old'), destination = path.join(base, 'new');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  const dbPath = path.join(source, 'data', 'app.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(title TEXT); INSERT INTO tasks VALUES('committed-before-preflight')");
  seed.close();
  assert.equal(fs.existsSync(dbPath + '-wal'), false);

  // Deterministic scheduler hook: a normal old application reconnects and commits
  // after source preflight. Keep its connection open so committed WAL is not
  // checkpointed on last-close. The migration itself uses its real SQLite lock.
  const originalOpen = fs.openSync;
  let writer;
  fs.openSync = function (filename, ...args) {
    if (filename === destination + '.migration-lock') {
      writer = new DatabaseSync(dbPath);
      writer.exec("INSERT INTO tasks VALUES('committed-after-preflight')");
    }
    return originalOpen.call(fs, filename, ...args);
  };
  try {
    assert.throws(() => migrateDataRoot(source, destination), /WAL|SQLite|close|停止|关闭/i);
    assert.deepEqual(writer.prepare('SELECT title FROM tasks ORDER BY rowid').all().map(r => r.title),
      ['committed-before-preflight', 'committed-after-preflight']);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(destination + '.migration-lock'), false);
  } finally {
    fs.openSync = originalOpen;
    writer?.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

import { resolveDataDirectory } from '../../packaging/launcher/launcher-data-flow.mjs';
import { findLegacyDataRoots } from '../../packaging/launcher/data-root.mjs';

for (const legacyLocation of ['exe-fallback', 'old-default-app']) {
  test(`real single-EXE nonempty default layout migrates ${legacyLocation} to independent persistent root`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-layout-test-'));
    const local = path.join(base, 'local'), exe = path.join(base, 'exe');
    const defaultRoot = path.join(local, 'ToDoList');
    const programRoot = path.join(defaultRoot, 'app', 'v', 'synthetic-hash');
    const source = legacyLocation === 'exe-fallback'
      ? path.join(exe, 'ToDoList-app', 'ToDoList-data')
      : path.join(defaultRoot, 'app', 'ToDoList-data');
    fs.mkdirSync(programRoot, { recursive: true });
    fs.mkdirSync(exe, { recursive: true });
    fs.writeFileSync(path.join(programRoot, 'program-sentinel'), 'preserve-program');
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    const seed = new DatabaseSync(path.join(source, 'data', 'app.sqlite'));
    seed.exec("CREATE TABLE tasks(title TEXT); INSERT INTO tasks VALUES('preserve-legacy')");
    seed.close();
    const answers = ['1', 'MIGRATE'], prompts = [];
    const options = {
      programRoot, platform: 'win32', home: path.join(base, 'home'),
      env: { LOCALAPPDATA: local, TODOLIST_EXE_DIR: exe },
      findLegacy: args => findLegacyDataRoots({ ...args, temporaryRoot: path.join(base, 'isolated-temp') }),
      isInteractive: true, log: () => {},
      ask: async prompt => { prompts.push(prompt); return answers.shift(); },
    };
    try {
      const selected = await resolveDataDirectory(options);
      assert.equal(selected, path.join(defaultRoot, 'storage'));
      assert.ok(prompts.some(p => p.includes(selected)), 'user sees the actual independent destination');
      assert.equal(fs.readFileSync(path.join(programRoot, 'program-sentinel'), 'utf8'), 'preserve-program');
      for (const root of [source, selected]) {
        const db = new DatabaseSync(path.join(root, 'data', 'app.sqlite'), { readOnly: true });
        try { assert.equal(db.prepare('SELECT title FROM tasks').get().title, 'preserve-legacy'); }
        finally { db.close(); }
      }
      assert.equal(fs.readFileSync(path.join(defaultRoot, 'todolist-data-root.txt'), 'utf8').trim(), selected);
      assert.equal(await resolveDataDirectory({ ...options, ask: async () => { throw new Error('must reuse saved selection'); } }), selected);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}

for (const answers of [['0'], ['1', 'NO']]) {
  test(`single-EXE migration cancellation ${answers.join('/')} never creates storage or persists pointer`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-layout-cancel-'));
    const local = path.join(base, 'local'), exe = path.join(base, 'exe');
    const defaultRoot = path.join(local, 'ToDoList');
    const programRoot = path.join(defaultRoot, 'app', 'v', 'synthetic-hash');
    const source = path.join(defaultRoot, 'app', 'ToDoList-data');
    fs.mkdirSync(programRoot, { recursive: true }); fs.mkdirSync(exe, { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    const seed = new DatabaseSync(path.join(source, 'data', 'app.sqlite'));
    seed.exec("CREATE TABLE tasks(title TEXT); INSERT INTO tasks VALUES('keep')"); seed.close();
    const queue = [...answers];
    try {
      await assert.rejects(resolveDataDirectory({
        programRoot, platform: 'win32', home: path.join(base, 'home'),
        env: { LOCALAPPDATA: local, TODOLIST_EXE_DIR: exe },
        findLegacy: args => findLegacyDataRoots({ ...args, temporaryRoot: path.join(base, 'isolated-temp') }),
        isInteractive: true, log: () => {}, ask: async () => queue.shift(),
      }), /取消/);
      assert.equal(fs.existsSync(path.join(defaultRoot, 'storage')), false);
      assert.equal(fs.existsSync(path.join(defaultRoot, 'todolist-data-root.txt')), false);
      assert.equal(fs.existsSync(path.join(exe, 'todolist-data-root.txt')), false);
      const check = new DatabaseSync(path.join(source, 'data', 'app.sqlite'), { readOnly: true });
      try { assert.equal(check.prepare('SELECT title FROM tasks').get().title, 'keep'); }
      finally { check.close(); }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}
