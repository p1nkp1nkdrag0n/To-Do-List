import { createHash, randomUUID } from "node:crypto";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import {
  createV2App,
  type V2AppDependencies,
} from "../../../server/http/app.js";

const BOOTSTRAP_CODE = "test-bootstrap-code";
const SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("v2 authentication HTTP API", () => {
  let database: V2Database;
  let now: Date;

  beforeEach(() => {
    now = new Date("2026-07-17T08:00:00.000Z");
    database = openV2Database(":memory:");
    migrateV2Database(database, () => now.toISOString());
  });

  afterEach(() => {
    database.close();
  });

  function app(
    cookieSecure = false,
    overrides: Partial<V2AppDependencies> = {},
  ) {
    return createV2App({
      database,
      sessionSecret: SESSION_SECRET,
      cookieSecure,
      bootstrapCode: BOOTSTRAP_CODE,
      clock: () => new Date(now),
      ...overrides,
    });
  }

  async function registerBootstrap(
    application = app(),
    username = "leader",
  ) {
    return request(application).post("/api/auth/register").send({
      username,
      displayName: "Team Leader",
      password: "password123",
      bootstrapCode: BOOTSTRAP_CODE,
    });
  }

  function seedRegistrationInvite(code: string, overrides: {
    expiresAt?: string;
    revokedAt?: string | null;
    createdBy?: string;
  } = {}) {
    const id = randomUUID();
    const createdBy = overrides.createdBy ?? database.get<{ user_id: string }>(
      `SELECT team_members.user_id
         FROM team_members
         JOIN users ON users.id = team_members.user_id
        WHERE team_members.removed_at IS NULL AND users.disabled_at IS NULL
        ORDER BY team_members.joined_at
        LIMIT 1`,
    )?.user_id;
    if (createdBy === undefined) {
      throw new Error("An active registration invite creator is required.");
    }
    database.run(
      `INSERT INTO registration_invites
        (id, code_hash, expires_at, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        sha256(code),
        overrides.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        createdBy,
        now.toISOString(),
        overrides.revokedAt ?? null,
      ],
    );
    return id;
  }

  it("bootstraps only the first account and normalizes its public identity", async () => {
    const application = app();
    const denied = await request(application).post("/api/auth/register").send({
      username: "leader",
      displayName: "Team Leader",
      password: "password123",
      bootstrapCode: "wrong-bootstrap",
    });

    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      error: {
        code: "BOOTSTRAP_CODE_INVALID",
        message: "The bootstrap code is invalid.",
      },
    });

    const response = await registerBootstrap(application, "LEADER");
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      user: { username: "leader", displayName: "Team Leader", revision: 1 },
      teamMember: true,
    });
    expect(response.body.user).not.toHaveProperty("passwordHash");

    const user = database.get<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE username = 'leader'",
    );
    expect(user?.password_hash).not.toBe("password123");
    expect(user?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?",
        [user!.id],
      ),
    ).toEqual({ count: 1 });

    const second = await request(application).post("/api/auth/register").send({
      username: "member",
      displayName: "Member",
      password: "password123",
    });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe("REGISTRATION_INVITE_INVALID");

    const reusedBootstrap = await request(application).post("/api/auth/register").send({
      username: "late-bootstrap-user",
      displayName: "Late Bootstrap User",
      password: "password123",
      bootstrapCode: BOOTSTRAP_CODE,
    });
    expect(reusedBootstrap.status).toBe(403);
    expect(reusedBootstrap.body.error.code).toBe("BOOTSTRAP_CODE_INVALID");
  });

  it("consumes a valid registration invite once and leaves later accounts outside the team", async () => {
    const application = app();
    await registerBootstrap(application);
    const inviteId = seedRegistrationInvite("registration-code");

    const response = await request(application).post("/api/auth/register").send({
      username: "researcher",
      displayName: "Researcher",
      password: "password123",
      registrationInviteCode: "registration-code",
    });
    expect(response.status).toBe(201);
    expect(response.body.teamMember).toBe(false);

    const invite = database.get<{ used_at: string | null; used_by: string | null }>(
      "SELECT used_at, used_by FROM registration_invites WHERE id = ?",
      [inviteId],
    );
    expect(invite?.used_at).toBe(now.toISOString());
    expect(invite?.used_by).toBe(response.body.user.id);

    const reused = await request(application).post("/api/auth/register").send({
      username: "another",
      displayName: "Another",
      password: "password123",
      registrationInviteCode: "registration-code",
    });
    expect(reused.status).toBe(403);
    expect(reused.body.error.code).toBe("REGISTRATION_INVITE_INVALID");
  });

  it("rejects expired and revoked registration invites with the same error", async () => {
    const application = app();
    await registerBootstrap(application);
    seedRegistrationInvite("expired-code", {
      expiresAt: new Date(now.getTime() - 1).toISOString(),
    });
    seedRegistrationInvite("revoked-code", { revokedAt: now.toISOString() });

    for (const code of ["expired-code", "revoked-code", "unknown-code"]) {
      const response = await request(application).post("/api/auth/register").send({
        username: `member-${code.slice(0, 3)}`,
        displayName: "Member",
        password: "password123",
        registrationInviteCode: code,
      });
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({
        code: "REGISTRATION_INVITE_INVALID",
        message: "The registration invite is invalid or unavailable.",
      });
    }
  });

  it("rejects a registration invite whose creator is disabled before hashing", async () => {
    const initialApplication = app();
    const bootstrap = await registerBootstrap(initialApplication);
    const creatorId = bootstrap.body.user.id as string;
    const inviteId = seedRegistrationInvite("disabled-creator", {
      createdBy: creatorId,
    });
    database.run(
      `UPDATE users
          SET disabled_at = ?, revision = revision + 1
        WHERE id = ?`,
      [now.toISOString(), creatorId],
    );
    const passwordHasher = vi.fn(async () => "unused-password-hash");

    const response = await request(app(false, { passwordHasher }))
      .post("/api/auth/register")
      .send({
        username: "blocked-account",
        displayName: "Blocked Account",
        password: "password123",
        registrationInviteCode: "disabled-creator",
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({
      code: "REGISTRATION_INVITE_INVALID",
      message: "The registration invite is invalid or unavailable.",
    });
    expect(passwordHasher).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE username = 'blocked-account'",
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ used_at: string | null; revision: number }>(
        "SELECT used_at, revision FROM registration_invites WHERE id = ?",
        [inviteId],
      ),
    ).toEqual({ used_at: null, revision: 1 });
  });

  it("authorizes registration before hashing and rechecks the invite atomically", async () => {
    const passwordHasher = vi.fn(async () => "test-password-hash");
    const application = app(false, { passwordHasher });

    const badBootstrap = await request(application).post("/api/auth/register").send({
      username: "leader",
      displayName: "Leader",
      password: "password123",
      bootstrapCode: "wrong-bootstrap",
    });
    expect(badBootstrap.status).toBe(403);
    expect(passwordHasher).not.toHaveBeenCalled();

    await registerBootstrap(application);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
    const invalidInvite = await request(application).post("/api/auth/register").send({
      username: "outside",
      displayName: "Outside",
      password: "password123",
      registrationInviteCode: "unknown-invite",
    });
    expect(invalidInvite.status).toBe(403);
    expect(passwordHasher).toHaveBeenCalledTimes(1);

    const inviteId = seedRegistrationInvite("race-invite");
    const racingHasher = vi.fn(async () => {
      database.run(
        "UPDATE registration_invites SET revoked_at = ? WHERE id = ?",
        [now.toISOString(), inviteId],
      );
      return "racing-password-hash";
    });
    const raced = await request(app(false, { passwordHasher: racingHasher }))
      .post("/api/auth/register")
      .send({
        username: "raced",
        displayName: "Raced",
        password: "password123",
        registrationInviteCode: "race-invite",
      });

    expect(racingHasher).toHaveBeenCalledTimes(1);
    expect(raced.status).toBe(403);
    expect(raced.body.error.code).toBe("REGISTRATION_INVITE_INVALID");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE username = 'raced'",
      ),
    ).toEqual({ count: 0 });
  });

  it("holds one persistent registration hash reservation through successful invite use", async () => {
    await registerBootstrap(
      app(false, { passwordHasher: async () => "bootstrap-password-hash" }),
    );
    const inviteId = seedRegistrationInvite("reserved-success");
    let reservationDuringHash: Record<string, unknown> | undefined;
    const passwordHasher = vi.fn(async () => {
      reservationDuringHash = database.get(
        `SELECT authorization_key, reserved_at
           FROM registration_hash_reservations`,
      );
      return "reserved-password-hash";
    });

    const response = await request(app(false, { passwordHasher }))
      .post("/api/auth/register")
      .send({
        username: "reserved-user",
        displayName: "Reserved User",
        password: "password123",
        registrationInviteCode: "reserved-success",
      });

    expect(response.status).toBe(201);
    expect(passwordHasher).toHaveBeenCalledOnce();
    expect(reservationDuringHash).toEqual({
      authorization_key: `registration_invite:${inviteId}`,
      reserved_at: now.toISOString(),
    });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM registration_hash_reservations",
      ),
    ).toEqual({ count: 0 });
  });

  it("admits at most one password hash for fifty usernames sharing one invite", async () => {
    await registerBootstrap(
      app(false, { passwordHasher: async () => "bootstrap-password-hash" }),
    );
    seedRegistrationInvite("one-hash-invite");
    let releaseHasher!: (hash: string) => void;
    const hashGate = new Promise<string>((resolve) => {
      releaseHasher = resolve;
    });
    const passwordHasher = vi.fn(() => hashGate);
    const application = app(false, { passwordHasher });
    const responsesPromise = Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(application).post("/api/auth/register").send({
          username: `invite-user-${index.toString().padStart(2, "0")}`,
          displayName: `Invite User ${index}`,
          password: "password123",
          registrationInviteCode: "one-hash-invite",
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(passwordHasher.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    releaseHasher("shared-invite-password-hash");
    const responses = await responsesPromise;

    expect(passwordHasher).toHaveBeenCalledTimes(1);
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 403)).toHaveLength(49);
    expect(
      responses
        .filter(({ status }) => status === 403)
        .every(({ body }) => body.error.code === "REGISTRATION_INVITE_INVALID"),
    ).toBe(true);
  });

  it("admits at most one password hash for fifty bootstrap registrations", async () => {
    let releaseHasher!: (hash: string) => void;
    const hashGate = new Promise<string>((resolve) => {
      releaseHasher = resolve;
    });
    const passwordHasher = vi.fn(() => hashGate);
    const application = app(false, { passwordHasher });
    const responsesPromise = Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(application).post("/api/auth/register").send({
          username: `bootstrap-user-${index.toString().padStart(2, "0")}`,
          displayName: `Bootstrap User ${index}`,
          password: "password123",
          bootstrapCode: BOOTSTRAP_CODE,
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(passwordHasher.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    releaseHasher("bootstrap-concurrent-password-hash");
    const responses = await responsesPromise;

    expect(passwordHasher).toHaveBeenCalledTimes(1);
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 403)).toHaveLength(49);
    expect(
      responses
        .filter(({ status }) => status === 403)
        .every(({ body }) => body.error.code === "BOOTSTRAP_CODE_INVALID"),
    ).toBe(true);
    expect(
      database.get<{ activeTeamMembers: number; reservations: number }>(
        `SELECT
           (SELECT COUNT(*) FROM team_members WHERE removed_at IS NULL)
             AS activeTeamMembers,
           (SELECT COUNT(*) FROM registration_hash_reservations) AS reservations`,
      ),
    ).toEqual({ activeTeamMembers: 1, reservations: 0 });
  });

  it("releases registration reservations after hasher errors", async () => {
    await registerBootstrap(
      app(false, { passwordHasher: async () => "bootstrap-password-hash" }),
    );
    seedRegistrationInvite("hasher-error-invite");
    const hasherError = new Error("forced registration hasher error");
    const logger = { error: vi.fn() };
    const failed = await request(
      app(false, {
        passwordHasher: async () => {
          throw hasherError;
        },
        logger,
      }),
    )
      .post("/api/auth/register")
      .send({
        username: "hasher-error",
        displayName: "Hasher Error",
        password: "password123",
        registrationInviteCode: "hasher-error-invite",
      });

    expect(failed.status).toBe(500);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM registration_hash_reservations",
      ),
    ).toEqual({ count: 0 });
    const retry = await request(
      app(false, { passwordHasher: async () => "retry-password-hash" }),
    )
      .post("/api/auth/register")
      .send({
        username: "hasher-retry",
        displayName: "Hasher Retry",
        password: "password123",
        registrationInviteCode: "hasher-error-invite",
      });
    expect(retry.status).toBe(201);
  });

  it("releases reservations when an invite is revoked or expires during hashing", async () => {
    await registerBootstrap(
      app(false, { passwordHasher: async () => "bootstrap-password-hash" }),
    );
    for (const mode of ["revoked", "expired"] as const) {
      const code = `${mode}-during-hash`;
      const inviteId = seedRegistrationInvite(code);
      const passwordHasher = vi.fn(async () => {
        if (mode === "revoked") {
          database.run(
            "UPDATE registration_invites SET revoked_at = ? WHERE id = ?",
            [now.toISOString(), inviteId],
          );
        } else {
          now = new Date(now.getTime() + 60 * 60 * 1000);
        }
        return `${mode}-password-hash`;
      });
      const response = await request(app(false, { passwordHasher }))
        .post("/api/auth/register")
        .send({
          username: `${mode}-while-hashing`,
          displayName: mode,
          password: "password123",
          registrationInviteCode: code,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("REGISTRATION_INVITE_INVALID");
      expect(passwordHasher).toHaveBeenCalledOnce();
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM registration_hash_reservations",
        ),
      ).toEqual({ count: 0 });
    }
  });

  it("recovers a stale bootstrap hash reservation", async () => {
    database.run(
      `INSERT INTO registration_hash_reservations
        (id, authorization_key, reserved_at)
       VALUES (?, 'bootstrap', ?)`,
      [randomUUID(), new Date(now.getTime() - 6 * 60 * 1000).toISOString()],
    );
    const passwordHasher = vi.fn(async () => "recovered-bootstrap-hash");

    const response = await registerBootstrap(
      app(false, { passwordHasher }),
      "recovered-leader",
    );

    expect(response.status).toBe(201);
    expect(passwordHasher).toHaveBeenCalledOnce();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM registration_hash_reservations",
      ),
    ).toEqual({ count: 0 });
  });

  it("rolls back invite consumption when user creation fails", async () => {
    const logger = { error: vi.fn() };
    const application = app(false, { logger });
    await registerBootstrap(application);
    const inviteId = seedRegistrationInvite("rollback-code");
    database.exec(`
      CREATE TRIGGER fail_registration_invite_update
      BEFORE UPDATE ON registration_invites
      BEGIN
        SELECT RAISE(ABORT, 'forced invite failure');
      END
    `);

    const response = await request(application).post("/api/auth/register").send({
      username: "failure",
      displayName: "Failure",
      password: "password123",
      registrationInviteCode: "rollback-code",
    });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
    expect(JSON.stringify(response.body)).not.toContain("forced invite failure");
    expect(logger.error).toHaveBeenCalledOnce();
    expect(
      database.get<{ used_at: string | null }>(
        "SELECT used_at FROM registration_invites WHERE id = ?",
        [inviteId],
      ),
    ).toEqual({ used_at: null });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE username = 'failure'",
      ),
    ).toEqual({ count: 0 });
  });

  it("stores only a session hash and emits the required cookie flags", async () => {
    const application = app();
    await registerBootstrap(application);
    const agent = request.agent(application);
    const login = await agent.post("/api/auth/login").send({
      username: "LEADER",
      password: "password123",
    });

    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^team_session=[A-Za-z0-9_-]+;/);
    expect(cookie).toContain("Max-Age=1209600");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");

    const rawToken = cookie.match(/^team_session=([^;]+)/)?.[1] ?? "";
    expect(Buffer.from(rawToken, "base64url")).toHaveLength(32);
    const session = database.get<{ token_hash: string; expires_at: string }>(
      "SELECT token_hash, expires_at FROM sessions",
    );
    expect(session?.token_hash).toBe(sha256(rawToken));
    expect(session?.token_hash).not.toContain(rawToken);
    expect(session?.expires_at).toBe(
      new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { username: "leader" }, teamMember: true });

    const secureApplication = app(true);
    const secureLogin = await request(secureApplication).post("/api/auth/login").send({
      username: "leader",
      password: "password123",
    });
    expect(secureLogin.headers["set-cookie"]?.[0]).toContain("Secure");
  });

  it("uses the same dummy password comparison for missing and disabled users", async () => {
    const baseApplication = app();
    await registerBootstrap(baseApplication);
    database.run("UPDATE users SET disabled_at = ? WHERE username = 'leader'", [
      now.toISOString(),
    ]);
    const passwordVerifier = vi.fn(
      async (_password: string, _passwordHash: string) => false,
    );
    const hardenedApplication = app(false, { passwordVerifier });

    const missing = await request(hardenedApplication).post("/api/auth/login").send({
      username: "missing",
      password: "password123",
    });
    const disabled = await request(hardenedApplication).post("/api/auth/login").send({
      username: "leader",
      password: "password123",
    });

    expect(missing.status).toBe(401);
    expect(disabled.status).toBe(401);
    expect(disabled.body).toEqual(missing.body);
    expect(passwordVerifier).toHaveBeenCalledTimes(2);
    expect(passwordVerifier.mock.calls[0]?.[1]).toMatch(/^\$2[aby]\$/);
    expect(passwordVerifier.mock.calls[1]?.[1]).toBe(
      passwordVerifier.mock.calls[0]?.[1],
    );
  });

  it("atomically limits a normalized username and IP to five failed logins", async () => {
    const application = app();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(application).post("/api/auth/login").send({
          username: "  MISSING.USER  ",
          password: "wrong-password",
        }),
      ),
    );

    expect(attempts.map(({ status }) => status).sort()).toEqual([
      401,
      401,
      401,
      401,
      401,
      429,
    ]);
    expect(
      database.get<{
        count: number;
        usernames: number;
        ips: number;
      }>(
        `SELECT COUNT(*) AS count,
                COUNT(DISTINCT normalized_username) AS usernames,
                COUNT(DISTINCT ip_address) AS ips
           FROM auth_attempts`,
      ),
    ).toEqual({ count: 5, usernames: 1, ips: 1 });
    expect(
      database.get<{ normalized_username: string }>(
        "SELECT normalized_username FROM auth_attempts LIMIT 1",
      ),
    ).toEqual({ normalized_username: "missing.user" });
    const limited = await request(application).post("/api/auth/login").send({
      username: "missing.user",
      password: "wrong-password",
    });
    expect(limited.body).toEqual({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many failed login attempts. Try again later.",
      },
    });
  });

  it("admits at most five verifier calls for one username across rotating IPs", async () => {
    let releaseVerifier!: (result: boolean) => void;
    const verifierGate = new Promise<boolean>((resolve) => {
      releaseVerifier = resolve;
    });
    const passwordVerifier = vi.fn(() => verifierGate);
    const application = app(false, { passwordVerifier, trustProxyHops: 1 });
    const responsesPromise = Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(application)
          .post("/api/auth/login")
          .set("X-Forwarded-For", `198.51.100.${index + 1}`)
          .send({ username: "MISSING.USER", password: "wrong-password" }),
      ),
    );

    await vi.waitFor(() => {
      expect(passwordVerifier.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
    releaseVerifier(false);
    const responses = await responsesPromise;

    expect(passwordVerifier).toHaveBeenCalledTimes(5);
    expect(responses.filter(({ status }) => status === 401)).toHaveLength(5);
    expect(responses.filter(({ status }) => status === 429)).toHaveLength(45);
  });

  it("admits at most five verifier calls for one IP across rotating usernames", async () => {
    let releaseVerifier!: (result: boolean) => void;
    const verifierGate = new Promise<boolean>((resolve) => {
      releaseVerifier = resolve;
    });
    const passwordVerifier = vi.fn(() => verifierGate);
    const application = app(false, { passwordVerifier, trustProxyHops: 1 });
    const responsesPromise = Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(application)
          .post("/api/auth/login")
          .set("X-Forwarded-For", "198.51.100.200")
          .send({
            username: `rotating-${index.toString().padStart(2, "0")}`,
            password: "wrong-password",
          }),
      ),
    );

    await vi.waitFor(() => {
      expect(passwordVerifier.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
    releaseVerifier(false);
    const responses = await responsesPromise;

    expect(passwordVerifier).toHaveBeenCalledTimes(5);
    expect(responses.filter(({ status }) => status === 401)).toHaveLength(5);
    expect(responses.filter(({ status }) => status === 429)).toHaveLength(45);
  });

  it("keeps login limits scoped to the trusted client IP", async () => {
    const application = app(false, { trustProxyHops: 1 });
    const loginFrom = (ipAddress: string) =>
      request(application)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ipAddress)
        .send({ username: "missing", password: "wrong-password" });

    for (let index = 0; index < 5; index += 1) {
      expect((await loginFrom("198.51.100.10")).status).toBe(401);
    }
    expect((await loginFrom("198.51.100.10")).status).toBe(429);
    expect((await loginFrom("198.51.100.11")).status).toBe(429);
    const otherUsername = await request(application)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.11")
      .send({ username: "other-missing", password: "wrong-password" });
    expect(otherUsername.status).toBe(401);
    expect(
      database.all<{ ip_address: string; count: number }>(
        `SELECT ip_address, COUNT(*) AS count
           FROM auth_attempts
          GROUP BY ip_address
          ORDER BY ip_address`,
      ),
    ).toEqual([
      { ip_address: "198.51.100.10", count: 5 },
      { ip_address: "198.51.100.11", count: 1 },
    ]);
  });

  it("clears relevant failures after a successful login", async () => {
    const application = app();
    await registerBootstrap(application);
    for (let index = 0; index < 2; index += 1) {
      expect(
        (
          await request(application).post("/api/auth/login").send({
            username: "LEADER",
            password: "wrong-password",
          })
        ).status,
      ).toBe(401);
    }
    const pendingId = randomUUID();
    const loginIp = database.get<{ ip_address: string }>(
      "SELECT ip_address FROM auth_attempts WHERE normalized_username = 'leader' LIMIT 1",
    )!.ip_address;
    database.run(
      `INSERT INTO auth_attempts
        (id, normalized_username, ip_address, state, attempted_at)
       VALUES (?, 'leader', ?, 'pending', ?)`,
      [pendingId, loginIp, now.toISOString()],
    );
    expect(
      (
        await request(application).post("/api/auth/login").send({
          username: "leader",
          password: "password123",
        })
      ).status,
    ).toBe(200);
    expect(
      database.all<{ id: string; state: string }>(
        `SELECT id, state FROM auth_attempts
          WHERE normalized_username = 'leader' ORDER BY id`,
      ),
    ).toEqual([{ id: pendingId, state: "pending" }]);
    database.run("DELETE FROM auth_attempts WHERE id = ?", [pendingId]);

    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await request(application).post("/api/auth/login").send({
            username: "leader",
            password: "wrong-password",
          })
        ).status,
      ).toBe(401);
    }
  });

  it("releases a pending reservation when the password verifier throws", async () => {
    const verifierFailure = new Error("forced verifier failure");
    let pendingDuringVerifier = -1;
    const passwordVerifier = vi.fn(async () => {
      try {
        pendingDuringVerifier =
          database.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM auth_attempts WHERE state = 'pending'",
          )?.count ?? 0;
      } catch {
        pendingDuringVerifier = -1;
      }
      throw verifierFailure;
    });
    const logger = { error: vi.fn() };
    const application = app(false, { passwordVerifier, logger });

    const response = await request(application).post("/api/auth/login").send({
      username: "missing",
      password: "wrong-password",
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
    expect(pendingDuringVerifier).toBe(1);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_attempts",
      ),
    ).toEqual({ count: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      verifierFailure,
      expect.any(Object),
    );
  });

  it("purges authentication attempts older than 24 hours", async () => {
    const staleId = randomUUID();
    database.run(
      `INSERT INTO auth_attempts
        (id, normalized_username, ip_address, attempted_at)
       VALUES (?, 'stale-user', '192.0.2.10', ?)`,
      [staleId, new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()],
    );

    const response = await request(app()).post("/api/auth/login").send({
      username: "missing",
      password: "wrong-password",
    });

    expect(response.status).toBe(401);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_attempts WHERE id = ?",
        [staleId],
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_attempts",
      ),
    ).toEqual({ count: 1 });
  });

  it("revokes logout sessions and rejects expired or disabled accounts", async () => {
    const application = app();
    await registerBootstrap(application);
    const agent = request.agent(application);
    await agent.post("/api/auth/login").send({
      username: "leader",
      password: "password123",
    });

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toMatch(
      /^team_session=;.*Expires=Thu, 01 Jan 1970 00:00:00 GMT/,
    );
    expect(
      database.get<{ revoked_at: string | null; revision: number }>(
        "SELECT revoked_at, revision FROM sessions ORDER BY created_at LIMIT 1",
      ),
    ).toEqual({ revoked_at: now.toISOString(), revision: 2 });
    expect((await agent.get("/api/auth/me")).status).toBe(401);

    const expiringAgent = request.agent(application);
    await expiringAgent.post("/api/auth/login").send({
      username: "leader",
      password: "password123",
    });
    now = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000 + 1);
    expect((await expiringAgent.get("/api/auth/me")).body.error.code).toBe(
      "AUTH_REQUIRED",
    );

    now = new Date("2026-07-17T08:00:00.000Z");
    const disabledAgent = request.agent(application);
    await disabledAgent.post("/api/auth/login").send({
      username: "leader",
      password: "password123",
    });
    database.run("UPDATE users SET disabled_at = ? WHERE username = 'leader'", [
      now.toISOString(),
    ]);
    expect((await disabledAgent.get("/api/auth/me")).body.error.code).toBe(
      "AUTH_REQUIRED",
    );
  });

  it("returns standardized validation/auth/body-limit errors without CORS", async () => {
    const application = app();
    const invalid = await request(application)
      .post("/api/auth/register")
      .set("Origin", "https://example.invalid")
      .send({ username: "bad name", displayName: "", password: "short" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalid.body.error.fieldErrors).toMatchObject({
      username: expect.any(Array),
      displayName: expect.any(Array),
      password: expect.any(Array),
    });
    expect(invalid.headers).not.toHaveProperty("access-control-allow-origin");

    const unauthenticated = await request(application).get("/api/auth/me");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
    });

    const tooLarge = await request(application)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ username: "leader", password: "x".repeat(1024 * 1024) }));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The request payload exceeds 1 MiB.",
      },
    });
  });
});
