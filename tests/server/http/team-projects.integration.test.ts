import { createHash, randomUUID } from "node:crypto";

import type { Express } from "express";
import request, { type Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { createV2App } from "../../../server/http/app.js";

const NOW = new Date("2026-07-17T08:00:00.000Z");
const BOOTSTRAP_CODE = "test-bootstrap-code";
const SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";

interface TestUser {
  id: string;
  username: string;
  agent: Agent;
}

describe("v2 team and project HTTP API", () => {
  let database: V2Database;
  let application: Express;
  let registrationSequence: number;

  beforeEach(() => {
    database = openV2Database(":memory:");
    migrateV2Database(database, () => NOW.toISOString());
    application = createV2App({
      database,
      bootstrapCode: BOOTSTRAP_CODE,
      sessionSecret: SESSION_SECRET,
      cookieSecure: false,
      clock: () => new Date(NOW),
    });
    registrationSequence = 0;
  });

  afterEach(() => {
    database.close();
  });

  async function login(username: string): Promise<Agent> {
    const agent = request.agent(application);
    const response = await agent.post("/api/auth/login").send({
      username,
      password: "password123",
    });
    expect(response.status).toBe(200);
    return agent;
  }

  async function bootstrap(): Promise<TestUser> {
    const response = await request(application).post("/api/auth/register").send({
      username: "leader",
      displayName: "Team Leader",
      password: "password123",
      bootstrapCode: BOOTSTRAP_CODE,
    });
    expect(response.status).toBe(201);
    return { id: response.body.user.id, username: "leader", agent: await login("leader") };
  }

  async function registerOutside(username: string): Promise<TestUser> {
    const code = `registration-${++registrationSequence}`;
    const creatorId = database.get<{ user_id: string }>(
      `SELECT team_members.user_id
         FROM team_members
         JOIN users ON users.id = team_members.user_id
        WHERE team_members.removed_at IS NULL AND users.disabled_at IS NULL
        ORDER BY team_members.joined_at
        LIMIT 1`,
    )?.user_id;
    if (creatorId === undefined) {
      throw new Error("An active registration invite creator is required.");
    }
    database.run(
      `INSERT INTO registration_invites
        (id, code_hash, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        createHash("sha256").update(code).digest("hex"),
        new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
        creatorId,
        NOW.toISOString(),
      ],
    );
    const response = await request(application).post("/api/auth/register").send({
      username,
      displayName: username.toUpperCase(),
      password: "password123",
      registrationInviteCode: code,
    });
    expect(response.status).toBe(201);
    return { id: response.body.user.id, username, agent: await login(username) };
  }

  async function addToTeam(actor: TestUser, user: TestUser) {
    const response = await actor.agent.post("/api/team/members").send({
      username: user.username.toUpperCase(),
    });
    expect(response.status).toBe(200);
    return response;
  }

  async function createProject(
    actor: TestUser,
    memberUserIds: string[] = [],
    name = "Research Project",
  ) {
    const response = await actor.agent.post("/api/projects").send({
      name,
      description: "Paper schedule",
      startDate: "2026-07-20",
      endDate: "2026-09-01",
      memberUserIds,
    });
    expect(response.status).toBe(201);
    return response.body as {
      project: { id: string; name: string; revision: number; startDate: string | null };
      members: Array<{ userId: string; username: string; color: string }>;
    };
  }

  it("enforces the team boundary and adds registered users idempotently", async () => {
    const leader = await bootstrap();
    const outsider = await registerOutside("outsider");

    const denied = await outsider.agent.get("/api/team");
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      error: {
        code: "TEAM_MEMBERSHIP_REQUIRED",
        message: "Team membership is required.",
      },
    });

    const firstAdd = await addToTeam(leader, outsider);
    expect(firstAdd.body).toMatchObject({
      added: true,
      member: { userId: outsider.id, username: "outsider", revision: 1 },
    });
    const secondAdd = await leader.agent.post("/api/team/members").send({
      userId: outsider.id,
    });
    expect(secondAdd.status).toBe(200);
    expect(secondAdd.body).toMatchObject({ added: false, member: { userId: outsider.id } });

    const team = await outsider.agent.get("/api/team");
    expect(team.status).toBe(200);
    expect(team.body.members.map((member: { username: string }) => member.username)).toEqual([
      "leader",
      "outsider",
    ]);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [outsider.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_added'",
      ),
    ).toEqual({ count: 1 });
  });

  it("soft-removes and reactivates team membership without revision ABA", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    const manager = await registerOutside("manager");
    await addToTeam(leader, member);
    await addToTeam(leader, manager);

    const missingRevision = await leader.agent.delete(`/api/team/members/${member.id}`);
    expect(missingRevision.status).toBe(400);
    expect(missingRevision.body.error.code).toBe("VALIDATION_ERROR");

    const stale = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: "REVISION_CONFLICT",
      message: "The team membership changed on another client.",
      latest: {
        userId: member.id,
        username: "member",
        displayName: "MEMBER",
        joinedAt: NOW.toISOString(),
        removedAt: null,
        revision: 1,
        state: "active",
      },
    });

    const removed = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(removed.status).toBe(204);
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        "SELECT removed_at, revision FROM team_members WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ removed_at: NOW.toISOString(), revision: 2 });
    expect((await member.agent.get("/api/team")).status).toBe(403);
    expect((await member.agent.get("/api/auth/me")).body).toMatchObject({
      teamMember: false,
    });
    const removedInviteCreation = await member.agent
      .post("/api/team/registration-invites")
      .send({});
    expect(removedInviteCreation.status).toBe(403);
    expect(removedInviteCreation.body.error.code).toBe(
      "TEAM_MEMBERSHIP_REQUIRED",
    );

    const alreadyRemoved = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 2 });
    expect(alreadyRemoved.status).toBe(409);
    expect(alreadyRemoved.body.error.latest).toMatchObject({
      userId: member.id,
      removedAt: NOW.toISOString(),
      revision: 2,
      state: "removed",
    });

    const reactivated = await addToTeam(leader, member);
    expect(reactivated.body).toMatchObject({
      added: true,
      member: { userId: member.id, revision: 3 },
    });
    const aba = await manager.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(aba.status).toBe(409);
    expect(aba.body.error.latest).toMatchObject({
      userId: member.id,
      removedAt: null,
      revision: 3,
      state: "active",
    });
    expect(
      (
        await manager.agent
          .delete(`/api/team/members/${member.id}`)
          .send({ expectedRevision: 3 })
      ).status,
    ).toBe(204);
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        "SELECT removed_at, revision FROM team_members WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ removed_at: NOW.toISOString(), revision: 4 });
    expect(
      database.get<{ additions: number; removals: number }>(
        `SELECT
           SUM(CASE WHEN action = 'team.member_added' THEN 1 ELSE 0 END) AS additions,
           SUM(CASE WHEN action = 'team.member_removed' THEN 1 ELSE 0 END) AS removals
         FROM activity_log WHERE entity_id = ?`,
        [member.id],
      ),
    ).toEqual({ additions: 2, removals: 2 });
  });

  it("soft-removes and reactivates project membership without revision ABA", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const created = await createProject(leader, [member.id]);
    const path = `/api/projects/${created.project.id}/members/${member.id}`;

    const missingRevision = await leader.agent.delete(path);
    expect(missingRevision.status).toBe(400);
    expect(missingRevision.body.error.code).toBe("VALIDATION_ERROR");
    const stale = await leader.agent.delete(path).send({ expectedRevision: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: "REVISION_CONFLICT",
      message: "The project membership changed on another client.",
      latest: {
        userId: member.id,
        username: "member",
        displayName: "MEMBER",
        color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        joinedAt: NOW.toISOString(),
        removedAt: null,
        revision: 1,
        state: "active",
      },
    });

    expect(
      (await leader.agent.delete(path).send({ expectedRevision: 1 })).status,
    ).toBe(204);
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        `SELECT removed_at, revision FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [created.project.id, member.id],
      ),
    ).toEqual({ removed_at: NOW.toISOString(), revision: 2 });
    expect((await member.agent.get(`/api/projects/${created.project.id}`)).status).toBe(404);
    expect((await member.agent.get("/api/projects")).body).toEqual({ projects: [] });

    const alreadyRemoved = await leader.agent
      .delete(path)
      .send({ expectedRevision: 2 });
    expect(alreadyRemoved.status).toBe(409);
    expect(alreadyRemoved.body.error.latest).toMatchObject({
      userId: member.id,
      removedAt: NOW.toISOString(),
      revision: 2,
      state: "removed",
    });
    const reactivated = await leader.agent
      .post(`/api/projects/${created.project.id}/members`)
      .send({ userId: member.id });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({
      added: true,
      member: { userId: member.id, revision: 3 },
    });
    const aba = await leader.agent.delete(path).send({ expectedRevision: 1 });
    expect(aba.status).toBe(409);
    expect(aba.body.error.latest).toMatchObject({
      userId: member.id,
      removedAt: null,
      revision: 3,
      state: "active",
    });
    expect(
      (await leader.agent.delete(path).send({ expectedRevision: 3 })).status,
    ).toBe(204);
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        `SELECT removed_at, revision FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [created.project.id, member.id],
      ),
    ).toEqual({ removed_at: NOW.toISOString(), revision: 4 });
    expect(
      database.get<{ additions: number; removals: number }>(
        `SELECT
           SUM(CASE WHEN action = 'project.member_added' THEN 1 ELSE 0 END) AS additions,
           SUM(CASE WHEN action = 'project.member_removed' THEN 1 ELSE 0 END) AS removals
         FROM activity_log WHERE project_id = ? AND entity_id = ?`,
        [created.project.id, member.id],
      ),
    ).toEqual({ additions: 1, removals: 2 });
  });

  it("prevents deleting the last team member and protects assigned task data", async () => {
    const leader = await bootstrap();
    const last = await leader.agent
      .delete(`/api/team/members/${leader.id}`)
      .send({ expectedRevision: 1 });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("LAST_TEAM_MEMBER");

    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const project = await createProject(leader, [member.id]);
    const taskId = randomUUID();
    database.run(
      `INSERT INTO tasks
        (id, project_id, title, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Experiment', 'not_started', ?, ?, ?, ?)`,
      [taskId, project.project.id, leader.id, leader.id, NOW.toISOString(), NOW.toISOString()],
    );
    database.run(
      `INSERT INTO task_participants
        (id, project_id, task_id, user_id, start_date, end_date, estimated_minutes,
         status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-07-20', '2026-07-21', 120, 'not_started', ?, ?, ?, ?)`,
      [
        randomUUID(),
        project.project.id,
        taskId,
        member.id,
        leader.id,
        leader.id,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
    );

    const unsafe = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(unsafe.status).toBe(409);
    expect(unsafe.body.error.code).toBe("TEAM_MEMBER_HAS_PROJECTS");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_participants WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("requires explicit project removal before removing a team member", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    const manager = await registerOutside("manager");
    await addToTeam(leader, member);
    await addToTeam(leader, manager);
    const project = await createProject(leader, [member.id]);

    expect((await manager.agent.get(`/api/projects/${project.project.id}`)).status).toBe(404);

    const rejected = await manager.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual({
      error: {
        code: "TEAM_MEMBER_HAS_PROJECTS",
        message: "The team member has 1 project membership and must be removed from it first.",
      },
    });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND user_id = ?",
        [project.project.id, member.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_removed'",
      ),
    ).toEqual({ count: 0 });

    const projectRemoval = await leader.agent.delete(
      `/api/projects/${project.project.id}/members/${member.id}`,
    ).send({ expectedRevision: 1 });
    expect(projectRemoval.status).toBe(204);

    const removed = await manager.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(removed.status).toBe(204);
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        "SELECT removed_at, revision FROM team_members WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ removed_at: NOW.toISOString(), revision: 2 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_removed'",
      ),
    ).toEqual({ count: 1 });

    expect(
      (
        await leader.agent
          .delete(`/api/team/members/${manager.id}`)
          .send({ expectedRevision: 1 })
      ).status,
    ).toBe(204);
    const lastMember = await leader.agent
      .delete(`/api/team/members/${leader.id}`)
      .send({ expectedRevision: 1 });
    expect(lastMember.status).toBe(409);
    expect(lastMember.body.error.code).toBe("LAST_TEAM_MEMBER");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [leader.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("preserves team and project membership for recoverable soft-deleted projects", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const project = await createProject(leader, [member.id]);
    const deletedAt = NOW.toISOString();
    database.run(
      `UPDATE projects
          SET deleted_at = ?, deleted_by = ?, purge_after = ?, revision = revision + 1
        WHERE id = ?`,
      [
        deletedAt,
        leader.id,
        new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        project.project.id,
      ],
    );

    const rejected = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("TEAM_MEMBER_HAS_PROJECTS");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [member.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND user_id = ?",
        [project.project.id, member.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM projects WHERE id = ?",
        [project.project.id],
      ),
    ).toEqual({ deleted_at: deletedAt });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_removed'",
      ),
    ).toEqual({ count: 0 });
  });

  it("rechecks project membership after locking a team-member removal", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const project = await createProject(leader);
    const originalTransaction = database.transaction.bind(database);
    let membershipInjected = false;
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) => {
      if (!membershipInjected) {
        membershipInjected = true;
        database.run(
          `INSERT INTO project_members
            (project_id, user_id, color, joined_at, added_by)
           VALUES (?, ?, '#dc2626', ?, ?)`,
          [project.project.id, member.id, NOW.toISOString(), leader.id],
        );
      }
      return originalTransaction(operation);
    }) as typeof database.transaction);

    const response = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("TEAM_MEMBER_HAS_PROJECTS");
    expect(
      database.get<{ teamCount: number; projectCount: number }>(
        `SELECT
           (SELECT COUNT(*) FROM team_members WHERE user_id = ?) AS teamCount,
           (SELECT COUNT(*) FROM project_members WHERE project_id = ? AND user_id = ?)
             AS projectCount`,
        [member.id, project.project.id, member.id],
      ),
    ).toEqual({ teamCount: 1, projectCount: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_removed'",
      ),
    ).toEqual({ count: 0 });
  });

  it("rechecks the last-team-member invariant after acquiring the lock", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const originalTransaction = database.transaction.bind(database);
    let memberRemoved = false;
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) => {
      if (!memberRemoved) {
        memberRemoved = true;
        database.run("DELETE FROM team_members WHERE user_id = ?", [member.id]);
      }
      return originalTransaction(operation);
    }) as typeof database.transaction);

    const response = await leader.agent
      .delete(`/api/team/members/${leader.id}`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_TEAM_MEMBER");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [leader.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'team.member_removed'",
      ),
    ).toEqual({ count: 0 });
  });

  it("protects task assignments even if project membership is already absent", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const project = await createProject(leader, [member.id]);
    const taskId = randomUUID();
    database.run(
      `INSERT INTO tasks
        (id, project_id, title, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Orphaned responsibility', 'not_started', ?, ?, ?, ?)`,
      [taskId, project.project.id, leader.id, leader.id, NOW.toISOString(), NOW.toISOString()],
    );
    database.run(
      `INSERT INTO task_participants
        (id, project_id, task_id, user_id, start_date, end_date, estimated_minutes,
         status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-07-20', '2026-07-21', 60, 'not_started', ?, ?, ?, ?)`,
      [
        randomUUID(),
        project.project.id,
        taskId,
        member.id,
        leader.id,
        leader.id,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
    );
    database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.run(
        "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
        [project.project.id, member.id],
      );
    } finally {
      database.exec("PRAGMA foreign_keys = ON");
    }

    const response = await leader.agent
      .delete(`/api/team/members/${member.id}`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("TEAM_MEMBER_REMOVAL_UNSAFE");
    expect(
      database.get<{ teamCount: number; assignmentCount: number }>(
        `SELECT
           (SELECT COUNT(*) FROM team_members WHERE user_id = ?) AS teamCount,
           (SELECT COUNT(*) FROM task_participants WHERE user_id = ?) AS assignmentCount`,
        [member.id, member.id],
      ),
    ).toEqual({ teamCount: 1, assignmentCount: 1 });
  });

  it("creates isolated projects atomically with creator inclusion and stable colors", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    const outsider = await registerOutside("outsider");
    await addToTeam(leader, member);

    const invalid = await leader.agent.post("/api/projects").send({
      name: "Invalid Project",
      memberUserIds: [member.id, outsider.id],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("PROJECT_MEMBERS_INVALID");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM projects WHERE name = 'Invalid Project'",
      ),
    ).toEqual({ count: 0 });

    const first = await createProject(leader, [member.id, member.id], "First Project");
    const second = await createProject(leader, [member.id], "Second Project");
    expect(first.members.map(({ userId }) => userId).sort()).toEqual(
      [leader.id, member.id].sort(),
    );
    const firstMemberColor = first.members.find(({ userId }) => userId === member.id)?.color;
    const secondMemberColor = second.members.find(({ userId }) => userId === member.id)?.color;
    expect(firstMemberColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(secondMemberColor).toBe(firstMemberColor);

    const outsiderProjects = await outsider.agent.get("/api/projects");
    expect(outsiderProjects.status).toBe(200);
    expect(outsiderProjects.body).toEqual({ projects: [] });
    expect((await outsider.agent.get(`/api/projects/${first.project.id}`)).status).toBe(404);
    expect((await member.agent.get(`/api/projects/${first.project.id}`)).status).toBe(200);
  });

  it("gives every project member equal mutation rights and detects stale revisions", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    const third = await registerOutside("third");
    await addToTeam(leader, member);
    await addToTeam(member, third);
    const created = await createProject(leader, [member.id]);

    const updated = await member.agent.patch(`/api/projects/${created.project.id}`).send({
      expectedRevision: 1,
      name: "Updated by Member",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.project).toMatchObject({ name: "Updated by Member", revision: 2 });

    const stale = await leader.agent.patch(`/api/projects/${created.project.id}`).send({
      expectedRevision: 1,
      description: "Stale write",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("REVISION_CONFLICT");
    expect(stale.body.error.latest).toMatchObject({
      id: created.project.id,
      name: "Updated by Member",
      revision: 2,
    });

    const invalidDates = await member.agent.patch(`/api/projects/${created.project.id}`).send({
      expectedRevision: 2,
      startDate: "2026-10-01",
    });
    expect(invalidDates.status).toBe(400);
    expect(invalidDates.body.error.code).toBe("PROJECT_DATE_RANGE_INVALID");

    const added = await member.agent
      .post(`/api/projects/${created.project.id}/members`)
      .send({ userId: third.id });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ added: true, member: { userId: third.id } });
    expect(
      (
        await member.agent
          .delete(`/api/projects/${created.project.id}/members/${leader.id}`)
          .send({ expectedRevision: 1 })
      )
        .status,
    ).toBe(204);
    expect((await leader.agent.get(`/api/projects/${created.project.id}`)).status).toBe(404);
    expect(
      (
        await member.agent
          .delete(`/api/projects/${created.project.id}/members/${third.id}`)
          .send({ expectedRevision: 1 })
      )
        .status,
    ).toBe(204);
    const memberActivities = database.all<{
      project_id: string | null;
      actor_id: string | null;
      entity_type: string;
      entity_id: string | null;
      action: string;
      metadata_json: string;
    }>(
      `SELECT project_id, actor_id, entity_type, entity_id, action, metadata_json
         FROM activity_log
        WHERE project_id = ?
          AND action IN ('project.member_added', 'project.member_removed')
        ORDER BY rowid`,
      [created.project.id],
    );
    expect(memberActivities).toEqual([
      {
        project_id: created.project.id,
        actor_id: member.id,
        entity_type: "project_member",
        entity_id: third.id,
        action: "project.member_added",
        metadata_json: "{}",
      },
      {
        project_id: created.project.id,
        actor_id: member.id,
        entity_type: "project_member",
        entity_id: leader.id,
        action: "project.member_removed",
        metadata_json: "{}",
      },
      {
        project_id: created.project.id,
        actor_id: member.id,
        entity_type: "project_member",
        entity_id: third.id,
        action: "project.member_removed",
        metadata_json: "{}",
      },
    ]);
    expect(JSON.stringify(memberActivities)).not.toContain("password123");
    expect(JSON.stringify(memberActivities)).not.toContain(SESSION_SECRET);
    expect(JSON.stringify(memberActivities)).not.toContain(BOOTSTRAP_CODE);
    const finalMember = await member.agent.delete(
      `/api/projects/${created.project.id}/members/${member.id}`,
    ).send({ expectedRevision: 1 });
    expect(finalMember.status).toBe(409);
    expect(finalMember.body.error.code).toBe("LAST_PROJECT_MEMBER");
  });

  it("protects participant records when removing a project member", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const created = await createProject(leader, [member.id]);
    const taskId = randomUUID();
    database.run(
      `INSERT INTO tasks
        (id, project_id, title, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Experiment', 'not_started', ?, ?, ?, ?)`,
      [taskId, created.project.id, leader.id, leader.id, NOW.toISOString(), NOW.toISOString()],
    );
    database.run(
      `INSERT INTO task_participants
        (id, project_id, task_id, user_id, start_date, end_date, estimated_minutes,
         status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-07-20', '2026-07-21', 60, 'not_started', ?, ?, ?, ?)`,
      [randomUUID(), created.project.id, taskId, member.id, leader.id, leader.id,
        NOW.toISOString(), NOW.toISOString()],
    );

    const response = await leader.agent.delete(
      `/api/projects/${created.project.id}/members/${member.id}`,
    ).send({ expectedRevision: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PROJECT_MEMBER_REMOVAL_UNSAFE");
  });

  it("rechecks task assignments after locking a project-member removal", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const created = await createProject(leader, [member.id]);
    const taskId = randomUUID();
    database.run(
      `INSERT INTO tasks
        (id, project_id, title, status, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Race task', 'not_started', ?, ?, ?, ?)`,
      [taskId, created.project.id, leader.id, leader.id, NOW.toISOString(), NOW.toISOString()],
    );
    const originalTransaction = database.transaction.bind(database);
    let assignmentInjected = false;
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) => {
      if (!assignmentInjected) {
        assignmentInjected = true;
        database.run(
          `INSERT INTO task_participants
            (id, project_id, task_id, user_id, start_date, end_date,
             estimated_minutes, status, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, '2026-07-20', '2026-07-21', 60, 'not_started',
                   ?, ?, ?, ?)`,
          [
            randomUUID(),
            created.project.id,
            taskId,
            member.id,
            leader.id,
            leader.id,
            NOW.toISOString(),
            NOW.toISOString(),
          ],
        );
      }
      return originalTransaction(operation);
    }) as typeof database.transaction);

    const response = await leader.agent.delete(
      `/api/projects/${created.project.id}/members/${member.id}`,
    ).send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PROJECT_MEMBER_REMOVAL_UNSAFE");
    expect(
      database.get<{ membershipCount: number; assignmentCount: number }>(
        `SELECT
           (SELECT COUNT(*) FROM project_members WHERE project_id = ? AND user_id = ?)
             AS membershipCount,
           (SELECT COUNT(*) FROM task_participants WHERE project_id = ? AND user_id = ?)
             AS assignmentCount`,
        [created.project.id, member.id, created.project.id, member.id],
      ),
    ).toEqual({ membershipCount: 1, assignmentCount: 1 });
  });

  it("rechecks the final-project-member invariant after acquiring the lock", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    const created = await createProject(leader, [member.id]);
    const originalTransaction = database.transaction.bind(database);
    let leaderMembershipRemoved = false;
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) => {
      if (!leaderMembershipRemoved) {
        leaderMembershipRemoved = true;
        database.run(
          "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
          [created.project.id, leader.id],
        );
      }
      return originalTransaction(operation);
    }) as typeof database.transaction);

    const response = await member.agent.delete(
      `/api/projects/${created.project.id}/members/${member.id}`,
    ).send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_PROJECT_MEMBER");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND user_id = ?",
        [created.project.id, member.id],
      ),
    ).toEqual({ count: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE action = 'project.member_removed'",
      ),
    ).toEqual({ count: 0 });
  });

  it("blocks removing the final enabled project member when only disabled memberships remain", async () => {
    const leader = await bootstrap();
    const disabledMember = await registerOutside("disabled-member");
    await addToTeam(leader, disabledMember);
    const created = await createProject(leader, [disabledMember.id]);
    database.run(
      `UPDATE users
          SET disabled_at = ?, revision = revision + 1
        WHERE id = ?`,
      [NOW.toISOString(), disabledMember.id],
    );

    const response = await leader.agent
      .delete(`/api/projects/${created.project.id}/members/${leader.id}`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_PROJECT_MEMBER");
    expect(
      database.get<{ leaderRevision: number; leaderRemovedAt: string | null }>(
        `SELECT revision AS leaderRevision, removed_at AS leaderRemovedAt
           FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [created.project.id, leader.id],
      ),
    ).toEqual({ leaderRevision: 1, leaderRemovedAt: null });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM activity_log
          WHERE action = 'project.member_removed' AND entity_id = ?`,
        [leader.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("allows removing a disabled project member while an enabled member remains", async () => {
    const leader = await bootstrap();
    const disabledMember = await registerOutside("disabled-member");
    await addToTeam(leader, disabledMember);
    const created = await createProject(leader, [disabledMember.id]);
    database.run(
      `UPDATE users
          SET disabled_at = ?, revision = revision + 1
        WHERE id = ?`,
      [NOW.toISOString(), disabledMember.id],
    );

    const response = await leader.agent
      .delete(`/api/projects/${created.project.id}/members/${disabledMember.id}`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(204);
    expect(
      database.get<{ revision: number; removed_at: string | null }>(
        `SELECT revision, removed_at FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [created.project.id, disabledMember.id],
      ),
    ).toEqual({ revision: 2, removed_at: NOW.toISOString() });
  });

  it("rolls back project and creator membership when any selected membership fails", async () => {
    const leader = await bootstrap();
    const member = await registerOutside("member");
    await addToTeam(leader, member);
    database.exec(`
      CREATE TRIGGER fail_selected_project_member
      BEFORE INSERT ON project_members
      WHEN NEW.user_id = '${member.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced membership failure');
      END
    `);

    const response = await leader.agent.post("/api/projects").send({
      name: "Rollback Project",
      memberUserIds: [member.id],
    });
    expect(response.status).toBe(500);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM projects WHERE name = 'Rollback Project'",
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM project_members
           JOIN projects ON projects.id = project_members.project_id
          WHERE projects.name = 'Rollback Project'`,
      ),
    ).toEqual({ count: 0 });
  });
});
