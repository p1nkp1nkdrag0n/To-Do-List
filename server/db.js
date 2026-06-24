import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";

const wasmPath = path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
const defaultDatabasePath = process.env.NODE_ENV === "production"
  ? "/var/lib/team-project-manager/app.sqlite"
  : path.join(process.cwd(), "data/app.sqlite");

export async function createDatabase(filePath = process.env.DB_PATH || defaultDatabasePath) {
  const SQL = await initSqlJs({
    locateFile: () => wasmPath
  });

  let database;
  if (filePath) {
    try {
      const file = await fs.readFile(filePath);
      database = new SQL.Database(file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      database = new SQL.Database();
    }
  } else {
    database = new SQL.Database();
  }

  const db = new AppDatabase(SQL, database, filePath);
  await db.initialize();
  return db;
}

export class AppDatabase {
  constructor(SQL, database, filePath) {
    this.SQL = SQL;
    this.database = database;
    this.filePath = filePath;
    this.ready = Promise.resolve();
    this.saveCounter = 0;
    this.loadedMtimeMs = 0;
  }

  async initialize() {
    this.database.run("PRAGMA foreign_keys = ON");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        color TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        color TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS personal_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        assignment_id TEXT,
        title TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        is_team_event INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        type TEXT NOT NULL,
        target_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewer_id TEXT,
        review_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_categories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES knowledge_categories(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS registration_invites (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        used_at TEXT,
        used_by TEXT,
        FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `);
    await this.persist();
  }

  async persist() {
    if (!this.filePath) {
      return;
    }
    const save = async () => {
      const directory = path.dirname(this.filePath);
      const tempPath = path.join(
        directory,
        `.${path.basename(this.filePath)}.${process.pid}.${++this.saveCounter}.tmp`
      );
      await fs.mkdir(directory, { recursive: true });
      try {
        await fs.writeFile(tempPath, Buffer.from(this.database.export()));
        await fs.rename(tempPath, this.filePath);
        const stat = await fs.stat(this.filePath);
        this.loadedMtimeMs = stat.mtimeMs;
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    };
    this.ready = this.ready.then(save, save);
    await this.ready;
  }

  async reloadIfChanged() {
    if (!this.filePath) {
      return;
    }
    await this.ready;
    let stat;
    try {
      stat = await fs.stat(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (this.loadedMtimeMs && stat.mtimeMs <= this.loadedMtimeMs) {
      return;
    }
    const file = await fs.readFile(this.filePath);
    const nextDatabase = new this.SQL.Database(file);
    nextDatabase.run("PRAGMA foreign_keys = ON");
    const previousDatabase = this.database;
    this.database = nextDatabase;
    this.loadedMtimeMs = stat.mtimeMs;
    previousDatabase.close?.();
  }

  async run(sql, params = []) {
    this.database.run(sql, params);
    const changed = this.database.getRowsModified();
    await this.persist();
    return changed;
  }

  async exec(sql) {
    this.database.run(sql);
    const changed = this.database.getRowsModified();
    await this.persist();
    return changed;
  }

  get(sql, params = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params);
      if (!statement.step()) {
        return null;
      }
      return statement.getAsObject();
    } finally {
      statement.free();
    }
  }

  all(sql, params = []) {
    const statement = this.database.prepare(sql);
    const rows = [];
    try {
      statement.bind(params);
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }
}
