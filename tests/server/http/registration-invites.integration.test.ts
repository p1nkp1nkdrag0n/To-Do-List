import { createHash } from "node:crypto";

import type { Express } from "express";
import request, { type Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { createV2App } from "../../../server/http/app.js";

const SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
const BOOTSTRAP_CODE = "test-bootstrap-code";
const PASSWORD = "password123";

interface LoggedInUser {
  id: string;
  username: string;
  agent: Agent;
}

describe("v2 registration invite HTTP API", () => {
  let database: V2Database;
  let application: Express;
  let now: Date;
  let codes: string[];

  beforeEach(() => {
    now = new Date("2026-07-17T08:00:00.000Z");
    codes = [];
    database = openV2Database(":memory:");
    migrateV2Database(database, () => now.toISOString());
    application = createV2App({
      database,
      sessionSecret: SESSION_SECRET,
      bootstrapCode: BOOTSTRAP_CODE,
      cookieSecure: false,
      clock: () => new Date(now),
      registrationInviteCodeGenerator: () =>
        codes.shift() ?? "deterministic-registration-code",
      passwordHasher: async (password) => `hash:${password}`,
      passwordVerifier: async (password, hash) => hash === `hash:${password}`,
    });
  });

  afterEach(() => {
    database.close();
  });

  async function bootstrapLeader(): Promise<LoggedInUser> {
    const registered = await request(application).post("/api/auth/register").send({
      username: "leader",
      displayName: "Leader",
      password: PASSWORD,
      bootstrapCode: BOOTSTRAP_CODE,
    });
    expect(registered.status).toBe(201);
    return login("leader", registered.body.user.id);
  }

  async function login(username: string, id: string): Promise<LoggedInUser> {
    const agent = request.agent(application);
    const response = await agent.post("/api/auth/login").send({
      username,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    return { id, username, agent };
  }

  async function registerWithInvite(
    username: string,
    registrationInviteCode: string,
  ) {
    return request(application).post("/api/auth/register").send({
      username,
      displayName: username.toUpperCase(),
      password: PASSWORD,
      registrationInviteCode,
    });
  }

  it("creates a hash-only one-time invite and supports the complete team onboarding flow", async () => {
    const leader = await bootstrapLeader();
    codes = ["registration-code-one"];

    const invalidCreate = await leader.agent
      .post("/api/team/registration-invites")
      .send({ expiresInHours: 48 });
    expect(invalidCreate.status).toBe(400);
    expect(invalidCreate.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM registration_invites",
      ),
    ).toEqual({ count: 0 });

    const created = await leader.agent
      .post("/api/team/registration-invites")
      .send({});
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      invite: {
        id: expect.any(String),
        code: "registration-code-one",
        expiresAt: "2026-07-18T08:00:00.000Z",
        revision: 1,
      },
    });

    const stored = database.get<{
      code_hash: string;
      expires_at: string;
      created_by: string;
      revision: number;
    }>(
      `SELECT code_hash, expires_at, created_by, revision
         FROM registration_invites WHERE id = ?`,
      [created.body.invite.id],
    );
    expect(stored).toEqual({
      code_hash: createHash("sha256")
        .update("registration-code-one", "utf8")
        .digest("hex"),
      expires_at: "2026-07-18T08:00:00.000Z",
      created_by: leader.id,
      revision: 1,
    });
    expect(JSON.stringify(stored)).not.toContain("registration-code-one");

    const secondRegistration = await registerWithInvite(
      "second",
      "registration-code-one",
    );
    expect(secondRegistration.status).toBe(201);
    expect(secondRegistration.body.teamMember).toBe(false);
    const secondId = secondRegistration.body.user.id as string;
    expect(
      database.get<{
        used_at: string | null;
        used_by: string | null;
        revision: number;
      }>(
        "SELECT used_at, used_by, revision FROM registration_invites WHERE id = ?",
        [created.body.invite.id],
      ),
    ).toEqual({ used_at: now.toISOString(), used_by: secondId, revision: 2 });

    const reuse = await registerWithInvite("third", "registration-code-one");
    expect(reuse.status).toBe(403);
    expect(reuse.body.error.code).toBe("REGISTRATION_INVITE_INVALID");

    const second = await login("second", secondId);
    const denied = await second.agent
      .post("/api/team/registration-invites")
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("TEAM_MEMBERSHIP_REQUIRED");
    const deniedRevoke = await second.agent
      .delete(`/api/team/registration-invites/${created.body.invite.id}`)
      .send({ expectedRevision: 2 });
    expect(deniedRevoke.status).toBe(403);
    expect(deniedRevoke.body.error.code).toBe("TEAM_MEMBERSHIP_REQUIRED");

    const added = await leader.agent.post("/api/team/members").send({
      username: "second",
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ added: true, member: { userId: secondId } });
    const usedRevoke = await second.agent
      .delete(`/api/team/registration-invites/${created.body.invite.id}`)
      .send({ expectedRevision: 2 });
    expect(usedRevoke.status).toBe(409);
    expect(usedRevoke.body.error.latest).toMatchObject({
      id: created.body.invite.id,
      revision: 2,
      state: "used",
    });

    const activities = database.all<{
      actor_id: string | null;
      entity_id: string | null;
      action: string;
      metadata_json: string;
    }>(
      `SELECT actor_id, entity_id, action, metadata_json
         FROM activity_log
        WHERE action LIKE 'registration_invite.%'
        ORDER BY rowid`,
    );
    expect(activities).toEqual([
      {
        actor_id: leader.id,
        entity_id: created.body.invite.id,
        action: "registration_invite.created",
        metadata_json: JSON.stringify({
          expiresAt: "2026-07-18T08:00:00.000Z",
        }),
      },
      {
        actor_id: secondId,
        entity_id: created.body.invite.id,
        action: "registration_invite.used",
        metadata_json: "{}",
      },
    ]);
    const activityText = JSON.stringify(activities);
    expect(activityText).not.toContain("registration-code-one");
    expect(activityText).not.toContain(stored!.code_hash);
  });

  it("rejects expiry and supports revision-checked early revocation", async () => {
    const leader = await bootstrapLeader();
    codes = ["expiring-code", "revoked-code"];

    const expiring = await leader.agent
      .post("/api/team/registration-invites")
      .send({});
    now = new Date("2026-07-18T08:00:00.000Z");
    expect((await registerWithInvite("expired", "expiring-code")).status).toBe(403);
    const expiredRevoke = await leader.agent
      .delete(
        `/api/team/registration-invites/${expiring.body.invite.id}`,
      )
      .send({ expectedRevision: 1 });
    expect(expiredRevoke.status).toBe(409);
    expect(expiredRevoke.body.error.latest).toMatchObject({
      id: expiring.body.invite.id,
      revision: 1,
      state: "expired",
    });

    const revokable = await leader.agent
      .post("/api/team/registration-invites")
      .send({});
    const revoked = await leader.agent
      .delete(`/api/team/registration-invites/${revokable.body.invite.id}`)
      .send({ expectedRevision: 1 });
    expect(revoked.status).toBe(204);
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM registration_invites WHERE id = ?",
        [revokable.body.invite.id],
      ),
    ).toEqual({ revoked_at: now.toISOString(), revision: 2 });
    expect((await registerWithInvite("revoked", "revoked-code")).status).toBe(403);

    const stale = await leader.agent
      .delete(`/api/team/registration-invites/${revokable.body.invite.id}`)
      .send({ expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: "REVISION_CONFLICT",
      message: "The registration invite changed on another client.",
      latest: {
        id: revokable.body.invite.id,
        expiresAt: revokable.body.invite.expiresAt,
        createdAt: now.toISOString(),
        usedAt: null,
        revokedAt: now.toISOString(),
        revision: 2,
        state: "revoked",
      },
    });
    expect(JSON.stringify(stale.body)).not.toContain("revoked-code");

    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM activity_log
          WHERE action = 'registration_invite.revoked'
            AND entity_id = ?`,
        [revokable.body.invite.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("does not authorize registration after the API invite creator is disabled", async () => {
    const leader = await bootstrapLeader();
    codes = ["disabled-api-creator"];
    const created = await leader.agent
      .post("/api/team/registration-invites")
      .send({});
    expect(created.status).toBe(201);
    database.run(
      `UPDATE users
          SET disabled_at = ?, revision = revision + 1
        WHERE id = ?`,
      [now.toISOString(), leader.id],
    );

    const response = await registerWithInvite(
      "blocked-by-disabled-creator",
      "disabled-api-creator",
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      code: "REGISTRATION_INVITE_INVALID",
      message: "The registration invite is invalid or unavailable.",
    });
    expect(
      database.get<{ used_at: string | null; revision: number }>(
        "SELECT used_at, revision FROM registration_invites WHERE id = ?",
        [created.body.invite.id],
      ),
    ).toEqual({ used_at: null, revision: 1 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE username = 'blocked-by-disabled-creator'",
      ),
    ).toEqual({ count: 0 });
  });
});
