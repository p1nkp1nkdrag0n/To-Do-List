import { createHash, randomUUID } from "node:crypto";

import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { createV2App } from "../../../server/http/app.js";
import { projectInviteDigest } from "../../../server/modules/invites/invite-crypto.js";

const SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
const BOOTSTRAP_CODE = "test-bootstrap-code";

interface SeededUser {
  id: string;
  username: string;
  cookie: string;
}

describe("v2 project invite HTTP API", () => {
  let database: V2Database;
  let application: Express;
  let now: Date;
  let codes: string[];
  let leader: SeededUser;
  let projectId: string;

  beforeEach(() => {
    now = new Date("2026-07-17T08:00:00.000Z");
    codes = ["123456"];
    database = openV2Database(":memory:");
    migrateV2Database(database, () => now.toISOString());
    application = createV2App({
      database,
      sessionSecret: SESSION_SECRET,
      bootstrapCode: BOOTSTRAP_CODE,
      cookieSecure: false,
      clock: () => new Date(now),
      projectInviteCodeGenerator: () => codes.shift() ?? "999999",
    });
    leader = seedAuthenticatedUser("leader", true);
    projectId = seedProject(leader.id);
  });

  afterEach(() => {
    database.close();
  });

  function seedAuthenticatedUser(username: string, inTeam = false): SeededUser {
    const id = randomUUID();
    const token = `token-${username}-${randomUUID()}`;
    database.run(
      `INSERT INTO users
        (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, 'unused-test-hash', ?, ?, ?)`,
      [id, username, username.toUpperCase(), now.toISOString(), now.toISOString()],
    );
    if (inTeam) {
      database.run(
        "INSERT INTO team_members (user_id, joined_at) VALUES (?, ?)",
        [id, now.toISOString()],
      );
    }
    database.run(
      `INSERT INTO sessions
        (id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        createHash("sha256").update(token).digest("hex"),
        new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
    return { id, username, cookie: `team_session=${token}` };
  }

  function seedProject(userId: string): string {
    const id = randomUUID();
    database.run(
      `INSERT INTO projects
        (id, name, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'Research Project', ?, ?, ?, ?)`,
      [id, userId, userId, now.toISOString(), now.toISOString()],
    );
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#2563eb', ?, ?)`,
      [id, userId, now.toISOString(), userId],
    );
    return id;
  }

  function postAs(user: SeededUser, path: string) {
    return request(application).post(path).set("Cookie", user.cookie);
  }

  function deleteAs(user: SeededUser, path: string, expectedRevision = 1) {
    return request(application)
      .delete(path)
      .set("Cookie", user.cookie)
      .send({ expectedRevision });
  }

  async function createInvite(user = leader) {
    return postAs(user, `/api/projects/${projectId}/invites`).send({});
  }

  async function redeem(user: SeededUser, code: string) {
    return postAs(user, "/api/project-invites/redeem").send({ code });
  }

  it("generates six digits, stores only an HMAC digest, and expires in exactly two hours", async () => {
    codes = ["012345"];
    const response = await createInvite();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      invite: {
        id: expect.any(String),
        projectId,
        code: "012345",
        expiresAt: "2026-07-17T10:00:00.000Z",
        revision: 1,
      },
    });
    const stored = database.get<{ code_hash: string; expires_at: string }>(
      "SELECT code_hash, expires_at FROM project_invites WHERE id = ?",
      [response.body.invite.id],
    );
    expect(stored).toEqual({
      code_hash: projectInviteDigest(SESSION_SECRET, "012345"),
      expires_at: "2026-07-17T10:00:00.000Z",
    });
    expect(stored?.code_hash).not.toContain("012345");

    const outsider = seedAuthenticatedUser("outsider");
    now = new Date("2026-07-17T10:00:00.000Z");
    const expired = await redeem(outsider, "012345");
    expect(expired.status).toBe(400);
    expect(expired.body.error).toEqual({
      code: "PROJECT_INVITE_INVALID",
      message: "The project invite code is invalid or unavailable.",
    });
  });

  it("revokes every active old code when a project member generates a new one", async () => {
    const member = seedAuthenticatedUser("member", true);
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#16a34a', ?, ?)`,
      [projectId, member.id, now.toISOString(), leader.id],
    );
    codes = ["111111", "222222"];

    const first = await createInvite();
    const second = await createInvite(member);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM project_invites WHERE id = ?",
        [first.body.invite.id],
      ),
    ).toEqual({ revoked_at: now.toISOString(), revision: 2 });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM activity_log
          WHERE action = 'project_invite.revoked' AND entity_id = ?`,
        [first.body.invite.id],
      ),
    ).toEqual({ count: 1 });

    const outsider = seedAuthenticatedUser("outsider");
    expect((await redeem(outsider, "111111")).body.error.code).toBe(
      "PROJECT_INVITE_INVALID",
    );
    expect((await redeem(outsider, "222222")).status).toBe(200);
  });

  it("allows unlimited users and atomically auto-joins both team and project", async () => {
    codes = ["333333"];
    await createInvite();
    const first = seedAuthenticatedUser("first");
    const second = seedAuthenticatedUser("second");

    for (const user of [first, second]) {
      const response = await redeem(user, "333333");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        projectId,
        teamMember: true,
        projectMember: true,
        addedToTeam: true,
        addedToProject: true,
      });
      expect(
        database.get<{ team_count: number; project_count: number }>(
          `SELECT
             (SELECT COUNT(*) FROM team_members WHERE user_id = ?) AS team_count,
             (SELECT COUNT(*) FROM project_members WHERE project_id = ? AND user_id = ?)
               AS project_count`,
          [user.id, projectId, user.id],
        ),
      ).toEqual({ team_count: 1, project_count: 1 });
    }
  });

  it("is idempotent and successful attempts never consume the failure allowance", async () => {
    codes = ["444444"];
    await createInvite();
    const outsider = seedAuthenticatedUser("outsider");

    const first = await redeem(outsider, "444444");
    expect(first.body).toMatchObject({ addedToTeam: true, addedToProject: true });
    for (let index = 0; index < 6; index += 1) {
      const repeated = await redeem(outsider, "444444");
      expect(repeated.status).toBe(200);
      expect(repeated.body).toMatchObject({ addedToTeam: false, addedToProject: false });
    }
    expect(
      database.get<{ successes: number; failures: number }>(
        `SELECT
           SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failures
         FROM project_invite_attempts WHERE user_id = ?`,
        [outsider.id],
      ),
    ).toEqual({ successes: 7, failures: 0 });
  });

  it("reactivates tombstoned team and project memberships with new revisions", async () => {
    codes = ["414141"];
    const returning = seedAuthenticatedUser("returning-member", true);
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#16a34a', ?, ?)`,
      [projectId, returning.id, now.toISOString(), leader.id],
    );
    database.run(
      `UPDATE project_members
          SET removed_at = ?, removed_by = ?, revision = revision + 1
        WHERE project_id = ? AND user_id = ?`,
      [now.toISOString(), leader.id, projectId, returning.id],
    );
    database.run(
      `UPDATE team_members
          SET removed_at = ?, removed_by = ?, revision = revision + 1
        WHERE user_id = ?`,
      [now.toISOString(), leader.id, returning.id],
    );
    await createInvite();

    const response = await redeem(returning, "414141");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      projectId,
      teamMember: true,
      projectMember: true,
      addedToTeam: true,
      addedToProject: true,
    });
    expect(
      database.get<{
        teamRemovedAt: string | null;
        teamRevision: number;
        projectRemovedAt: string | null;
        projectRevision: number;
      }>(
        `SELECT
           (SELECT removed_at FROM team_members WHERE user_id = ?) AS teamRemovedAt,
           (SELECT revision FROM team_members WHERE user_id = ?) AS teamRevision,
           (SELECT removed_at FROM project_members WHERE project_id = ? AND user_id = ?)
             AS projectRemovedAt,
           (SELECT revision FROM project_members WHERE project_id = ? AND user_id = ?)
             AS projectRevision`,
        [
          returning.id,
          returning.id,
          projectId,
          returning.id,
          projectId,
          returning.id,
        ],
      ),
    ).toEqual({
      teamRemovedAt: null,
      teamRevision: 3,
      projectRemovedAt: null,
      projectRevision: 3,
    });
    expect(
      (
        await request(application)
          .get(`/api/projects/${projectId}`)
          .set("Cookie", returning.cookie)
      ).status,
    ).toBe(200);
  });

  it("revokes an active invite early and gives every invalid code the same response", async () => {
    codes = ["555555"];
    const created = await createInvite();
    const revoke = await deleteAs(
      leader,
      `/api/projects/${projectId}/invites/${created.body.invite.id}`,
    );
    expect(revoke.status).toBe(204);
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM project_invites WHERE id = ?",
        [created.body.invite.id],
      ),
    ).toEqual({ revoked_at: now.toISOString(), revision: 2 });

    const outsider = seedAuthenticatedUser("outsider");
    for (const code of ["555555", "000000"]) {
      const response = await redeem(outsider, code);
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual({
        code: "PROJECT_INVITE_INVALID",
        message: "The project invite code is invalid or unavailable.",
      });
    }
  });

  it("returns desensitized latest state for stale and superseded revoke races", async () => {
    const member = seedAuthenticatedUser("member", true);
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#16a34a', ?, ?)`,
      [projectId, member.id, now.toISOString(), leader.id],
    );
    codes = ["101010", "202020", "303030"];

    const first = await createInvite();
    expect(
      (
        await deleteAs(
          member,
          `/api/projects/${projectId}/invites/${first.body.invite.id}`,
          1,
        )
      ).status,
    ).toBe(204);
    const stale = await deleteAs(
      leader,
      `/api/projects/${projectId}/invites/${first.body.invite.id}`,
      1,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: "REVISION_CONFLICT",
      message: "The project invite changed on another client.",
      latest: {
        id: first.body.invite.id,
        projectId,
        expiresAt: first.body.invite.expiresAt,
        createdAt: now.toISOString(),
        revokedAt: now.toISOString(),
        revision: 2,
        state: "revoked",
      },
    });

    const second = await createInvite();
    const replacement = await createInvite(member);
    expect(replacement.status).toBe(201);
    const superseded = await deleteAs(
      leader,
      `/api/projects/${projectId}/invites/${second.body.invite.id}`,
      1,
    );
    expect(superseded.status).toBe(409);
    expect(superseded.body.error.latest).toMatchObject({
      id: second.body.invite.id,
      projectId,
      revision: 2,
      state: "revoked",
    });
    const serialized = JSON.stringify([stale.body, superseded.body]);
    expect(serialized).not.toContain("101010");
    expect(serialized).not.toContain("202020");
    expect(serialized).not.toContain(
      projectInviteDigest(SESSION_SECRET, "101010"),
    );
    expect(serialized).not.toContain(
      projectInviteDigest(SESSION_SECRET, "202020"),
    );
    expect(
      database.all<{ entity_id: string; count: number }>(
        `SELECT entity_id, COUNT(*) AS count
           FROM activity_log
          WHERE action = 'project_invite.revoked'
            AND entity_id IN (?, ?)
          GROUP BY entity_id
          ORDER BY entity_id`,
        [first.body.invite.id, second.body.invite.id],
      ),
    ).toEqual(
      [first.body.invite.id, second.body.invite.id]
        .sort()
        .map((entity_id) => ({ entity_id, count: 1 })),
    );
  });

  it("requires expectedRevision when revoking a project invite", async () => {
    const created = await createInvite();
    const response = await request(application)
      .delete(`/api/projects/${projectId}/invites/${created.body.invite.id}`)
      .set("Cookie", leader.cookie)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM project_invites WHERE id = ?",
        [created.body.invite.id],
      ),
    ).toEqual({ revoked_at: null, revision: 1 });
  });

  it("returns an expired latest entity instead of treating an expired invite as missing", async () => {
    const created = await createInvite();
    now = new Date("2026-07-17T10:00:00.000Z");

    const response = await deleteAs(
      leader,
      `/api/projects/${projectId}/invites/${created.body.invite.id}`,
      1,
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: "REVISION_CONFLICT",
      message: "The project invite changed on another client.",
      latest: {
        id: created.body.invite.id,
        projectId,
        expiresAt: created.body.invite.expiresAt,
        createdAt: "2026-07-17T08:00:00.000Z",
        revokedAt: null,
        revision: 1,
        state: "expired",
      },
    });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM activity_log
          WHERE action = 'project_invite.revoked' AND entity_id = ?`,
        [created.body.invite.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("revokes every active code before soft-removing a project member", async () => {
    const member = seedAuthenticatedUser("removed-member", true);
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#16a34a', ?, ?)`,
      [projectId, member.id, now.toISOString(), leader.id],
    );
    codes = ["121212"];
    const createdByLeader = await createInvite(leader);
    const createdByMemberId = randomUUID();
    database.run(
      `INSERT INTO project_invites
        (id, project_id, code_hash, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        createdByMemberId,
        projectId,
        projectInviteDigest(SESSION_SECRET, "343434"),
        new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        member.id,
        now.toISOString(),
      ],
    );

    const removed = await request(application)
      .delete(`/api/projects/${projectId}/members/${member.id}`)
      .set("Cookie", leader.cookie)
      .send({ expectedRevision: 1 });
    expect(removed.status).toBe(204);
    expect(
      database.all<{
        id: string;
        revoked_at: string | null;
        revoked_by: string | null;
        revision: number;
      }>(
        `SELECT id, revoked_at, revoked_by, revision FROM project_invites
          WHERE id IN (?, ?) ORDER BY id`,
        [createdByLeader.body.invite.id, createdByMemberId],
      ),
    ).toEqual(
      [createdByLeader.body.invite.id, createdByMemberId]
        .sort()
        .map((id) => ({
          id,
          revoked_at: now.toISOString(),
          revoked_by: leader.id,
          revision: 2,
        })),
    );
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        `SELECT removed_at, revision FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [projectId, member.id],
      ),
    ).toEqual({ removed_at: now.toISOString(), revision: 2 });

    const activities = database.all<{
      entity_id: string | null;
      action: string;
      metadata_json: string;
    }>(
      `SELECT entity_id, action, metadata_json FROM activity_log
        WHERE (action = 'project_invite.revoked' OR action = 'project.member_removed')
          AND project_id = ?
        ORDER BY rowid`,
      [projectId],
    );
    expect(activities.slice(0, 2)).toEqual(
      expect.arrayContaining([
        {
          entity_id: createdByLeader.body.invite.id,
          action: "project_invite.revoked",
          metadata_json: JSON.stringify({ reason: "member_removed" }),
        },
        {
          entity_id: createdByMemberId,
          action: "project_invite.revoked",
          metadata_json: JSON.stringify({ reason: "member_removed" }),
        },
      ]),
    );
    expect(activities.at(-1)).toEqual({
      entity_id: member.id,
      action: "project.member_removed",
      metadata_json: "{}",
    });

    for (const code of ["121212", "343434"]) {
      const redemption = await redeem(member, code);
      expect(redemption.status).toBe(400);
      expect(redemption.body.error.code).toBe("PROJECT_INVITE_INVALID");
    }
    expect(
      database.get<{ removed_at: string | null; revision: number }>(
        `SELECT removed_at, revision FROM project_members
          WHERE project_id = ? AND user_id = ?`,
        [projectId, member.id],
      ),
    ).toEqual({ removed_at: now.toISOString(), revision: 2 });
  });

  it("rejects an otherwise-active code whose creator is no longer a project member", async () => {
    const creator = seedAuthenticatedUser("former-creator", true);
    const outsider = seedAuthenticatedUser("creator-defense-outsider");
    database.run(
      `INSERT INTO project_members
        (project_id, user_id, color, joined_at, added_by)
       VALUES (?, ?, '#16a34a', ?, ?)`,
      [projectId, creator.id, now.toISOString(), leader.id],
    );
    codes = ["454545"];
    const created = await createInvite(creator);
    database.run(
      `UPDATE project_members
          SET removed_at = ?, removed_by = ?, revision = revision + 1
        WHERE project_id = ? AND user_id = ?`,
      [now.toISOString(), leader.id, projectId, creator.id],
    );

    const response = await redeem(outsider, "454545");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PROJECT_INVITE_INVALID");
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM project_invites WHERE id = ?",
        [created.body.invite.id],
      ),
    ).toEqual({ revoked_at: null, revision: 1 });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM project_members
          WHERE project_id = ? AND user_id = ? AND removed_at IS NULL`,
        [projectId, outsider.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects an active code from a disabled creator and records a failed attempt", async () => {
    const outsider = seedAuthenticatedUser("disabled-creator-outsider");
    codes = ["565656"];
    const created = await createInvite();
    expect(created.status).toBe(201);
    database.run(
      `UPDATE users
          SET disabled_at = ?, revision = revision + 1
        WHERE id = ?`,
      [now.toISOString(), leader.id],
    );

    const response = await redeem(outsider, "565656");

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: "PROJECT_INVITE_INVALID",
      message: "The project invite code is invalid or unavailable.",
    });
    expect(
      database.get<{ failures: number; successes: number }>(
        `SELECT
           SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS successes
         FROM project_invite_attempts WHERE user_id = ?`,
        [outsider.id],
      ),
    ).toEqual({ failures: 1, successes: 0 });
    expect(
      database.get<{ teamCount: number; projectCount: number; redeemedActivities: number }>(
        `SELECT
           (SELECT COUNT(*) FROM team_members WHERE user_id = ?) AS teamCount,
           (SELECT COUNT(*) FROM project_members WHERE project_id = ? AND user_id = ?)
             AS projectCount,
           (SELECT COUNT(*) FROM activity_log
             WHERE action = 'project_invite.redeemed' AND entity_id = ?)
             AS redeemedActivities`,
        [outsider.id, projectId, outsider.id, created.body.invite.id],
      ),
    ).toEqual({ teamCount: 0, projectCount: 0, redeemedActivities: 0 });
  });

  it("checks project membership and invite-code uniqueness inside the create transaction", async () => {
    const originalTransaction = database.transaction.bind(database);
    const originalGet = database.get.bind(database);
    let insideTransaction = false;
    const operationsOutsideTransaction: string[] = [];
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) =>
      originalTransaction(() => {
        insideTransaction = true;
        try {
          return operation();
        } finally {
          insideTransaction = false;
        }
      })) as typeof database.transaction);
    vi.spyOn(database, "get").mockImplementation(((sql: string, parameters = []) => {
      if (
        /(?:FROM\s+project_members|FROM\s+project_invites)/i.test(sql) &&
        !insideTransaction
      ) {
        operationsOutsideTransaction.push(sql);
      }
      return originalGet(sql, parameters);
    }) as typeof database.get);

    const response = await createInvite();

    expect(response.status).toBe(201);
    expect(operationsOutsideTransaction).toEqual([]);
  });

  it("blocks an account after five recent failures even when IPs differ", async () => {
    codes = ["666666"];
    await createInvite();
    const outsider = seedAuthenticatedUser("outsider");
    for (let index = 0; index < 5; index += 1) {
      database.run(
        `INSERT INTO project_invite_attempts
          (id, attempted_code_hash, user_id, ip_address, succeeded, attempted_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [
          randomUUID(),
          projectInviteDigest(SESSION_SECRET, `00000${index}`),
          outsider.id,
          `198.51.100.${index + 1}`,
          now.toISOString(),
        ],
      );
    }

    const response = await redeem(outsider, "666666");
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("PROJECT_INVITE_RATE_LIMITED");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND user_id = ?",
        [projectId, outsider.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("blocks an IP after five users fail without rate-limiting those accounts", async () => {
    codes = ["777777"];
    await createInvite();
    for (let index = 0; index < 5; index += 1) {
      const user = seedAuthenticatedUser(`failed-${index}`);
      const response = await redeem(user, "000000");
      expect(response.status).toBe(400);
    }
    const sixth = seedAuthenticatedUser("sixth");
    const response = await redeem(sixth, "777777");
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("PROJECT_INVITE_RATE_LIMITED");
  });

  it("purges project invite attempts older than 24 hours", async () => {
    const outsider = seedAuthenticatedUser("stale-attempt-user");
    const staleIds = [randomUUID(), randomUUID()];
    for (const [index, id] of staleIds.entries()) {
      database.run(
        `INSERT INTO project_invite_attempts
          (id, attempted_code_hash, user_id, ip_address, succeeded, attempted_at)
         VALUES (?, ?, ?, '192.0.2.20', ?, ?)`,
        [
          id,
          projectInviteDigest(SESSION_SECRET, `00000${index}`),
          outsider.id,
          index,
          new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
        ],
      );
    }

    expect((await redeem(outsider, "000009")).status).toBe(400);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM project_invite_attempts
          WHERE id IN (?, ?)`,
        staleIds,
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_invite_attempts WHERE user_id = ?",
        [outsider.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("performs invite checks and writes inside one immediate transaction", async () => {
    const outsider = seedAuthenticatedUser("transaction-user");
    const originalTransaction = database.transaction.bind(database);
    const originalGet = database.get.bind(database);
    const originalRun = database.run.bind(database);
    let insideTransaction = false;
    const operationsOutsideTransaction: string[] = [];

    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) =>
      originalTransaction(() => {
        insideTransaction = true;
        try {
          return operation();
        } finally {
          insideTransaction = false;
        }
      })) as typeof database.transaction);
    vi.spyOn(database, "get").mockImplementation(((sql: string, parameters = []) => {
      if (
        /(?:FROM\s+project_invite_attempts|FROM\s+project_invites)/i.test(sql) &&
        !insideTransaction
      ) {
        operationsOutsideTransaction.push(sql);
      }
      return originalGet(sql, parameters);
    }) as typeof database.get);
    vi.spyOn(database, "run").mockImplementation(((sql: string, parameters = []) => {
      if (
        /(?:project_invite_attempts|team_members|project_members)/i.test(sql) &&
        !insideTransaction
      ) {
        operationsOutsideTransaction.push(sql);
      }
      return originalRun(sql, parameters);
    }) as typeof database.run);

    const response = await redeem(outsider, "000008");

    expect(response.status).toBe(400);
    expect(operationsOutsideTransaction).toEqual([]);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_invite_attempts WHERE user_id = ?",
        [outsider.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("re-reads an invite after acquiring the transaction lock", async () => {
    codes = ["909090"];
    const created = await createInvite();
    const outsider = seedAuthenticatedUser("revocation-race-user");
    const originalTransaction = database.transaction.bind(database);
    let revokedBeforeLock = false;
    vi.spyOn(database, "transaction").mockImplementation(((operation: () => unknown) => {
      if (!revokedBeforeLock) {
        revokedBeforeLock = true;
        database.run(
          "UPDATE project_invites SET revoked_at = ?, revision = revision + 1 WHERE id = ?",
          [now.toISOString(), created.body.invite.id],
        );
      }
      return originalTransaction(operation);
    }) as typeof database.transaction);

    const response = await redeem(outsider, "909090");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PROJECT_INVITE_INVALID");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND user_id = ?",
        [projectId, outsider.id],
      ),
    ).toEqual({ count: 0 });
  });

  it("uses X-Forwarded-For only for the configured trusted proxy hop", async () => {
    const forwardedIp = "198.51.100.42";
    const directUser = seedAuthenticatedUser("direct-user");
    application = createV2App({
      database,
      sessionSecret: SESSION_SECRET,
      bootstrapCode: BOOTSTRAP_CODE,
      cookieSecure: false,
      trustProxyHops: 0,
      clock: () => new Date(now),
    });

    await postAs(directUser, "/api/project-invites/redeem")
      .set("X-Forwarded-For", forwardedIp)
      .send({ code: "000000" });
    const directIp = database.get<{ ip_address: string }>(
      `SELECT ip_address FROM project_invite_attempts
        WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`,
      [directUser.id],
    )?.ip_address;
    expect(directIp).toBeDefined();
    expect(directIp).not.toBe(forwardedIp);

    const proxiedUser = seedAuthenticatedUser("proxied-user");
    application = createV2App({
      database,
      sessionSecret: SESSION_SECRET,
      bootstrapCode: BOOTSTRAP_CODE,
      cookieSecure: false,
      trustProxyHops: 1,
      clock: () => new Date(now),
    });
    await postAs(proxiedUser, "/api/project-invites/redeem")
      .set("X-Forwarded-For", forwardedIp)
      .send({ code: "000000" });
    expect(
      database.get<{ ip_address: string }>(
        `SELECT ip_address FROM project_invite_attempts
          WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`,
        [proxiedUser.id],
      ),
    ).toEqual({ ip_address: forwardedIp });
  });

  it("never records or returns invite plaintext or digests outside creation", async () => {
    codes = ["888888"];
    const created = await createInvite();
    const outsider = seedAuthenticatedUser("outsider");
    const redeemed = await redeem(outsider, "888888");
    expect(redeemed.status).toBe(200);
    expect(JSON.stringify(redeemed.body)).not.toContain("888888");
    expect(JSON.stringify(redeemed.body)).not.toContain(
      projectInviteDigest(SESSION_SECRET, "888888"),
    );
    await deleteAs(
      outsider,
      `/api/projects/${projectId}/invites/${created.body.invite.id}`,
    );

    const activities = database.all<{
      action: string;
      metadata_json: string;
    }>(
      `SELECT action, metadata_json FROM activity_log
        WHERE action LIKE 'project_invite.%' ORDER BY rowid`,
    );
    expect(activities.map(({ action }) => action)).toEqual([
      "project_invite.generated",
      "project_invite.redeemed",
      "project_invite.revoked",
    ]);
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain("888888");
    expect(serialized).not.toContain(projectInviteDigest(SESSION_SECRET, "888888"));
  });

  it("hides projects from non-members when creating or revoking invites", async () => {
    const outsider = seedAuthenticatedUser("outsider", true);
    expect((await createInvite(outsider)).status).toBe(404);
    expect(
      (
        await deleteAs(
          outsider,
          `/api/projects/${projectId}/invites/${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
  });
});
