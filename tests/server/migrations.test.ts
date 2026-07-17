import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  openV2Database,
  V2Database,
} from "../../server/db/database.js";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrateV2Database,
} from "../../server/db/migrations.js";

const databases: V2Database[] = [];
const temporaryDirectories: string[] = [];
const timestamp = "2026-07-17T08:30:00.000Z";

const requiredTables = [
  "activity_log",
  "availability_exceptions",
  "availability_profiles",
  "availability_slots",
  "deliverable_requirements",
  "milestones",
  "phases",
  "progress_updates",
  "project_invites",
  "project_members",
  "project_tags",
  "projects",
  "recurring_task_rules",
  "registration_invites",
  "resource_tag_links",
  "resource_versions",
  "resources",
  "schema_migrations",
  "sessions",
  "task_dependencies",
  "task_participants",
  "tasks",
  "team_members",
  "users",
] as const;

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function migratedDatabase(): V2Database {
  const database = openV2Database(":memory:");
  databases.push(database);
  migrateV2Database(database);
  return database;
}

function seedProject(database: V2Database): {
  projectId: string;
  taskId: string;
  userId: string;
} {
  const userId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const taskId = "00000000-0000-4000-8000-000000000003";

  database.run(
    `INSERT INTO users
       (id, username, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, "member", "hash", "Member", timestamp, timestamp],
  );
  database.run(
    `INSERT INTO team_members (user_id, joined_at, revision)
     VALUES (?, ?, 1)`,
    [userId, timestamp],
  );
  database.run(
    `INSERT INTO projects
       (id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, "Research", userId, userId, timestamp, timestamp],
  );
  database.run(
    `INSERT INTO project_members
       (project_id, user_id, color, joined_at, added_by)
     VALUES (?, ?, ?, ?, ?)`,
    [projectId, userId, "#2563eb", timestamp, userId],
  );
  database.run(
    `INSERT INTO tasks
       (id, project_id, title, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      projectId,
      "Experiment",
      "not_started",
      userId,
      userId,
      timestamp,
      timestamp,
    ],
  );

  return { projectId, taskId, userId };
}

function seedAdditionalProject(
  database: V2Database,
  userId: string,
): { projectId: string; taskId: string } {
  const projectId = "00000000-0000-4000-8000-000000000020";
  const taskId = "00000000-0000-4000-8000-000000000021";

  database.run(
    `INSERT INTO projects
       (id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, "Competition", userId, userId, timestamp, timestamp],
  );
  database.run(
    `INSERT INTO project_members
       (project_id, user_id, color, joined_at, added_by)
     VALUES (?, ?, ?, ?, ?)`,
    [projectId, userId, "#16a34a", timestamp, userId],
  );
  insertTask(database, { id: taskId, projectId, userId });

  return { projectId, taskId };
}

function insertTask(
  database: V2Database,
  values: {
    id: string;
    projectId: string;
    userId: string;
    phaseId?: string | null;
    parentId?: string | null;
    recurringRuleId?: string | null;
  },
): void {
  database.run(
    `INSERT INTO tasks
       (id, project_id, phase_id, parent_id, recurring_rule_id, title, status,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?)`,
    [
      values.id,
      values.projectId,
      values.phaseId ?? null,
      values.parentId ?? null,
      values.recurringRuleId ?? null,
      "Task",
      values.userId,
      values.userId,
      timestamp,
      timestamp,
    ],
  );
}

function insertPhase(
  database: V2Database,
  id: string,
  projectId: string,
  userId: string,
): void {
  database.run(
    `INSERT INTO phases
       (id, project_id, name, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, "Phase", userId, userId, timestamp, timestamp],
  );
}

function insertRecurringRule(
  database: V2Database,
  id: string,
  projectId: string,
  sourceTaskId: string,
  userId: string,
): void {
  database.run(
    `INSERT INTO recurring_task_rules
       (id, project_id, source_task_id, frequency, day_of_week, starts_on,
        next_occurrence_on, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, 'weekly', 1, '2026-07-20', '2026-07-20', ?, ?, ?, ?)`,
    [id, projectId, sourceTaskId, userId, userId, timestamp, timestamp],
  );
}

function insertResource(
  database: V2Database,
  values: {
    id: string;
    projectId: string;
    userId: string;
    phaseId?: string | null;
    sourceTaskId?: string | null;
  },
): void {
  database.run(
    `INSERT INTO resources
       (id, project_id, phase_id, source_task_id, kind, title,
        created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'markdown', 'Notes', ?, ?, ?, ?)`,
    [
      values.id,
      values.projectId,
      values.phaseId ?? null,
      values.sourceTaskId ?? null,
      values.userId,
      values.userId,
      timestamp,
      timestamp,
    ],
  );
}

describe("v2 schema migrations", () => {
  it("stores a deterministic SHA-256 checksum for every migration", () => {
    const database = migratedDatabase();
    const migration = MIGRATIONS[0] as (typeof MIGRATIONS)[number] & {
      checksum?: string;
    };
    const expectedChecksum = createHash("sha256")
      .update(migration.sql, "utf8")
      .digest("hex");

    expect(migration.checksum).toBe(expectedChecksum);
    expect(
      database.get<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = ?",
        [migration.version],
      ),
    ).toEqual({ checksum: expectedChecksum });
  });

  it("rejects a database created by a newer migration version", () => {
    const database = openV2Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    database.run(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (?, 'future', ?, ?)`,
      [CURRENT_SCHEMA_VERSION + 1, "f".repeat(64), timestamp],
    );

    expect(() => migrateV2Database(database)).toThrow(
      new RegExp(
        `schema version ${CURRENT_SCHEMA_VERSION + 1}.*newer.*${CURRENT_SCHEMA_VERSION}`,
        "i",
      ),
    );
  });

  it("reads applied migration history while an immediate transaction is active", () => {
    const nativeDatabase = new DatabaseSync(":memory:");
    nativeDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const database = new V2Database(nativeDatabase);
    databases.push(database);
    const transactionStates: boolean[] = [];
    nativeDatabase.setAuthorizer((actionCode, tableName, columnName) => {
      if (
        actionCode === constants.SQLITE_READ &&
        tableName === "schema_migrations" &&
        columnName === "version"
      ) {
        transactionStates.push(nativeDatabase.isTransaction);
      }
      return constants.SQLITE_OK;
    });

    migrateV2Database(database);

    expect(transactionStates.length).toBeGreaterThan(0);
    expect(transactionStates.every(Boolean)).toBe(true);
  });

  it("rejects tampered names and checksums for applied migrations", () => {
    const database = migratedDatabase();
    const migration = MIGRATIONS[0]!;

    database.run(
      "UPDATE schema_migrations SET name = 'tampered' WHERE version = ?",
      [migration.version],
    );
    expect(() => migrateV2Database(database)).toThrow(
      /migration 1.*name.*mismatch/i,
    );

    database.run(
      "UPDATE schema_migrations SET name = ?, checksum = ? WHERE version = ?",
      [migration.name, "0".repeat(64), migration.version],
    );
    expect(() => migrateV2Database(database)).toThrow(
      /migration 1.*checksum.*mismatch/i,
    );
  });

  it("fails clearly when schema_migrations has incompatible columns", () => {
    const database = openV2Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);

    expect(() => migrateV2Database(database)).toThrow(
      /incompatible schema_migrations.*checksum/i,
    );
  });

  it("remains idempotent after a file-backed database is closed and reopened", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "app.sqlite");
    const firstConnection = openV2Database(databasePath);
    databases.push(firstConnection);
    migrateV2Database(firstConnection);
    firstConnection.close();

    const secondConnection = openV2Database(databasePath);
    databases.push(secondConnection);
    migrateV2Database(secondConnection);

    expect(
      secondConnection.all<{ version: number; checksum: string }>(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      ),
    ).toEqual(
      MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
    );
  });

  it("rolls back a failed migration and can retry on the same connection", () => {
    const database = openV2Database(":memory:");
    databases.push(database);
    database.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");

    expect(() => migrateV2Database(database)).toThrow(/sessions already exists/i);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM sqlite_schema
          WHERE type = 'table' AND name IN ('users', 'registration_invites')`,
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      ),
    ).toEqual({ count: 0 });

    database.exec("DROP TABLE sessions");
    migrateV2Database(database);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      ),
    ).toEqual({ count: MIGRATIONS.length });
  });

  it("creates every baseline table and is idempotent", () => {
    const database = migratedDatabase();

    migrateV2Database(database);

    const tables = database
      .all<{ name: string }>(
        `SELECT name
           FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .map(({ name }) => name);
    expect(tables).toEqual(expect.arrayContaining([...requiredTables]));
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      ),
    ).toEqual({ count: 1 });
  });

  it("enforces foreign keys", () => {
    const database = migratedDatabase();

    expect(() =>
      database.run(
        `INSERT INTO projects
           (id, name, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "00000000-0000-4000-8000-000000000010",
          "Orphan",
          "00000000-0000-4000-8000-000000000099",
          "00000000-0000-4000-8000-000000000099",
          timestamp,
          timestamp,
        ],
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("allows only one participant record per task and member", () => {
    const database = migratedDatabase();
    const { projectId, taskId, userId } = seedProject(database);
    const values = [
      "00000000-0000-4000-8000-000000000004",
      projectId,
      taskId,
      userId,
      "2026-07-17",
      "2026-07-20",
      240,
      "not_started",
      userId,
      userId,
      timestamp,
      timestamp,
    ];
    const sql = `INSERT INTO task_participants
      (id, project_id, task_id, user_id, start_date, end_date,
       estimated_minutes, status, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    database.run(sql, values);

    expect(() =>
      database.run(sql, [
        "00000000-0000-4000-8000-000000000005",
        ...values.slice(1),
      ]),
    ).toThrow(/UNIQUE/i);
  });

  it("requires a deliverable to target exactly one task or milestone", () => {
    const database = migratedDatabase();
    const { projectId, taskId, userId } = seedProject(database);
    const milestoneId = "00000000-0000-4000-8000-000000000006";
    database.run(
      `INSERT INTO milestones
        (id, project_id, title, due_date, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        milestoneId,
        projectId,
        "Submit paper",
        "2026-07-25",
        "not_started",
        userId,
        userId,
        timestamp,
        timestamp,
      ],
    );

    const insert = (task: string | null, milestone: string | null) =>
      database.run(
        `INSERT INTO deliverable_requirements
          (id, project_id, task_id, milestone_id, title, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          projectId,
          task,
          milestone,
          "Required report",
          userId,
          userId,
          timestamp,
          timestamp,
        ],
      );

    expect(() => insert(null, null)).toThrow(/CHECK/i);
    expect(() => insert(taskId, milestoneId)).toThrow(/CHECK/i);
    expect(() => insert(taskId, null)).not.toThrow();
    expect(() => insert(null, milestoneId)).not.toThrow();
  });

  it("rejects every cross-project phase, task, rule, and resource reference", () => {
    const database = migratedDatabase();
    const first = seedProject(database);
    const second = seedAdditionalProject(database, first.userId);
    const secondPhaseId = "00000000-0000-4000-8000-000000000022";
    const secondRuleId = "00000000-0000-4000-8000-000000000023";
    const secondResourceId = "00000000-0000-4000-8000-000000000024";
    insertPhase(database, secondPhaseId, second.projectId, first.userId);
    insertRecurringRule(
      database,
      secondRuleId,
      second.projectId,
      second.taskId,
      first.userId,
    );
    insertResource(database, {
      id: secondResourceId,
      projectId: second.projectId,
      userId: first.userId,
    });

    const attempts: Array<[string, () => void]> = [
      ["tasks.phase_id", () => insertTask(database, {
        id: crypto.randomUUID(), projectId: first.projectId,
        userId: first.userId, phaseId: secondPhaseId,
      })],
      ["tasks.parent_id", () => insertTask(database, {
        id: crypto.randomUUID(), projectId: first.projectId,
        userId: first.userId, parentId: second.taskId,
      })],
      ["tasks.recurring_rule_id", () => insertTask(database, {
        id: crypto.randomUUID(), projectId: first.projectId,
        userId: first.userId, recurringRuleId: secondRuleId,
      })],
      ["milestones.phase_id", () => database.run(
        `INSERT INTO milestones
           (id, project_id, phase_id, title, due_date, status,
            created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, 'Review', '2026-07-25', 'not_started', ?, ?, ?, ?)`,
        [crypto.randomUUID(), first.projectId, secondPhaseId, first.userId,
          first.userId, timestamp, timestamp],
      )],
      ["resources.phase_id", () => insertResource(database, {
        id: crypto.randomUUID(), projectId: first.projectId,
        userId: first.userId, phaseId: secondPhaseId,
      })],
      ["resources.source_task_id", () => insertResource(database, {
        id: crypto.randomUUID(), projectId: first.projectId,
        userId: first.userId, sourceTaskId: second.taskId,
      })],
      ["deliverable_requirements.fulfilled_resource_id", () => database.run(
        `INSERT INTO deliverable_requirements
           (id, project_id, task_id, title, fulfilled_resource_id,
            created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, 'Report', ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), first.projectId, first.taskId, secondResourceId,
          first.userId, first.userId, timestamp, timestamp],
      )],
    ];
    const failures: string[] = [];

    for (const [relationship, attempt] of attempts) {
      try {
        attempt();
        failures.push(`${relationship}: accepted`);
      } catch (error) {
        if (!/FOREIGN KEY/i.test(String(error))) {
          failures.push(`${relationship}: ${String(error)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("allows same-project and null references including recurring task creation", () => {
    const database = migratedDatabase();
    const { projectId, taskId, userId } = seedProject(database);
    const phaseId = "00000000-0000-4000-8000-000000000030";
    const ruleId = "00000000-0000-4000-8000-000000000031";
    const occurrenceTaskId = "00000000-0000-4000-8000-000000000032";
    const resourceId = "00000000-0000-4000-8000-000000000033";
    const milestoneId = "00000000-0000-4000-8000-000000000034";
    const deliverableId = "00000000-0000-4000-8000-000000000035";
    insertPhase(database, phaseId, projectId, userId);

    insertRecurringRule(database, ruleId, projectId, taskId, userId);
    insertTask(database, {
      id: occurrenceTaskId,
      projectId,
      userId,
      phaseId,
      parentId: taskId,
      recurringRuleId: ruleId,
    });
    database.run(
      "UPDATE tasks SET phase_id = NULL, parent_id = NULL, recurring_rule_id = NULL WHERE id = ?",
      [occurrenceTaskId],
    );

    database.run(
      `INSERT INTO milestones
         (id, project_id, phase_id, title, due_date, status,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Review', '2026-07-25', 'not_started', ?, ?, ?, ?)`,
      [milestoneId, projectId, phaseId, userId, userId, timestamp, timestamp],
    );
    database.run("UPDATE milestones SET phase_id = NULL WHERE id = ?", [milestoneId]);

    insertResource(database, {
      id: resourceId,
      projectId,
      userId,
      phaseId,
      sourceTaskId: taskId,
    });
    database.run(
      "UPDATE resources SET phase_id = NULL, source_task_id = NULL WHERE id = ?",
      [resourceId],
    );

    database.run(
      `INSERT INTO deliverable_requirements
         (id, project_id, task_id, title, fulfilled_resource_id,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Report', ?, ?, ?, ?, ?)`,
      [deliverableId, projectId, taskId, resourceId, userId, userId, timestamp, timestamp],
    );
    database.run(
      "UPDATE deliverable_requirements SET fulfilled_resource_id = NULL WHERE id = ?",
      [deliverableId],
    );

    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM recurring_task_rules WHERE id = ?",
        [ruleId],
      ),
    ).toEqual({ count: 1 });
  });

  it("preserves project IDs while physical deletes clear optional references", () => {
    const database = migratedDatabase();
    const { projectId, taskId, userId } = seedProject(database);
    const phaseId = "00000000-0000-4000-8000-000000000040";
    const ruleId = "00000000-0000-4000-8000-000000000041";
    const childTaskId = "00000000-0000-4000-8000-000000000042";
    const milestoneId = "00000000-0000-4000-8000-000000000043";
    const resourceId = "00000000-0000-4000-8000-000000000044";
    const deliverableId = "00000000-0000-4000-8000-000000000045";

    insertPhase(database, phaseId, projectId, userId);
    insertRecurringRule(database, ruleId, projectId, taskId, userId);
    insertTask(database, {
      id: childTaskId,
      projectId,
      userId,
      phaseId,
      parentId: taskId,
      recurringRuleId: ruleId,
    });
    database.run(
      `INSERT INTO milestones
         (id, project_id, phase_id, title, due_date, status,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Review', '2026-07-25', 'not_started', ?, ?, ?, ?)`,
      [milestoneId, projectId, phaseId, userId, userId, timestamp, timestamp],
    );
    insertResource(database, {
      id: resourceId,
      projectId,
      userId,
      phaseId,
      sourceTaskId: taskId,
    });
    database.run(
      `INSERT INTO deliverable_requirements
         (id, project_id, milestone_id, title, fulfilled_resource_id,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Report', ?, ?, ?, ?, ?)`,
      [deliverableId, projectId, milestoneId, resourceId, userId, userId, timestamp, timestamp],
    );

    database.run("DELETE FROM phases WHERE id = ?", [phaseId]);
    expect(
      database.get<{ phase_id: string | null; project_id: string }>(
        "SELECT phase_id, project_id FROM tasks WHERE id = ?",
        [childTaskId],
      ),
    ).toEqual({ phase_id: null, project_id: projectId });
    expect(
      database.get<{ phase_id: string | null; project_id: string }>(
        "SELECT phase_id, project_id FROM milestones WHERE id = ?",
        [milestoneId],
      ),
    ).toEqual({ phase_id: null, project_id: projectId });
    expect(
      database.get<{ phase_id: string | null; project_id: string }>(
        "SELECT phase_id, project_id FROM resources WHERE id = ?",
        [resourceId],
      ),
    ).toEqual({ phase_id: null, project_id: projectId });

    database.run("DELETE FROM recurring_task_rules WHERE id = ?", [ruleId]);
    expect(
      database.get<{ recurring_rule_id: string | null; project_id: string }>(
        "SELECT recurring_rule_id, project_id FROM tasks WHERE id = ?",
        [childTaskId],
      ),
    ).toEqual({ recurring_rule_id: null, project_id: projectId });

    database.run("DELETE FROM tasks WHERE id = ?", [taskId]);
    expect(
      database.get<{ source_task_id: string | null; project_id: string }>(
        "SELECT source_task_id, project_id FROM resources WHERE id = ?",
        [resourceId],
      ),
    ).toEqual({ source_task_id: null, project_id: projectId });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tasks WHERE id = ?",
        [childTaskId],
      ),
    ).toEqual({ count: 0 });

    database.run("DELETE FROM resources WHERE id = ?", [resourceId]);
    expect(
      database.get<{
        fulfilled_resource_id: string | null;
        project_id: string;
      }>(
        `SELECT fulfilled_resource_id, project_id
           FROM deliverable_requirements
          WHERE id = ?`,
        [deliverableId],
      ),
    ).toEqual({ fulfilled_resource_id: null, project_id: projectId });
  });

  it("adds revision and trash metadata to mutable core entities", () => {
    const database = migratedDatabase();

    for (const table of ["projects", "tasks", "resources"] as const) {
      const columns = database
        .all<{ name: string }>(`PRAGMA table_info(${table})`)
        .map(({ name }) => name);
      expect(columns, table).toEqual(
        expect.arrayContaining([
          "revision",
          "deleted_at",
          "deleted_by",
          "purge_after",
        ]),
      );
    }
  });
});
