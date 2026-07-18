import { createHash, randomUUID } from "node:crypto";

import type { Express } from "express";
import request, { type Agent } from "supertest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { createV2App } from "../../../server/http/app.js";

export const SCHEDULE_NOW = new Date("2026-07-17T08:00:00.000Z");
const BOOTSTRAP_CODE = "test-bootstrap-code";
const SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";

export interface ScheduleTestUser {
  id: string;
  username: string;
  agent: Agent;
}

export interface ScheduleFixture {
  application: Express;
  database: V2Database;
  bootstrap(): Promise<ScheduleTestUser>;
  register(username: string): Promise<ScheduleTestUser>;
  addToTeam(actor: ScheduleTestUser, user: ScheduleTestUser): Promise<void>;
  createProject(
    actor: ScheduleTestUser,
    memberUserIds?: string[],
  ): Promise<{ id: string; revision: number }>;
  close(): void;
}

export function createScheduleFixture(): ScheduleFixture {
  const database = openV2Database(":memory:");
  migrateV2Database(database, () => SCHEDULE_NOW.toISOString());
  const application = createV2App({
    database,
    bootstrapCode: BOOTSTRAP_CODE,
    sessionSecret: SESSION_SECRET,
    cookieSecure: false,
    clock: () => new Date(SCHEDULE_NOW),
    passwordHasher: async (password) => `test:${password}`,
    passwordVerifier: async (password, hash) => hash === `test:${password}`,
  });
  let inviteSequence = 0;

  async function login(username: string): Promise<Agent> {
    const agent = request.agent(application);
    const response = await agent.post("/api/auth/login").send({
      username,
      password: "password123",
    });
    if (response.status !== 200) {
      throw new Error(`Login failed for ${username}: ${response.status}`);
    }
    return agent;
  }

  async function bootstrap(): Promise<ScheduleTestUser> {
    const response = await request(application).post("/api/auth/register").send({
      username: "leader",
      displayName: "Team Leader",
      password: "password123",
      bootstrapCode: BOOTSTRAP_CODE,
    });
    if (response.status !== 201) {
      throw new Error(`Bootstrap failed: ${response.status}`);
    }
    return {
      id: response.body.user.id as string,
      username: "leader",
      agent: await login("leader"),
    };
  }

  async function register(username: string): Promise<ScheduleTestUser> {
    const creatorId = database.get<{ user_id: string }>(
      `SELECT user_id FROM team_members
        WHERE removed_at IS NULL ORDER BY joined_at LIMIT 1`,
    )?.user_id;
    if (creatorId === undefined) {
      throw new Error("Bootstrap the fixed team before registering more users.");
    }
    const code = `schedule-registration-${++inviteSequence}`;
    database.run(
      `INSERT INTO registration_invites
        (id, code_hash, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        createHash("sha256").update(code).digest("hex"),
        new Date(SCHEDULE_NOW.getTime() + 60 * 60 * 1000).toISOString(),
        creatorId,
        SCHEDULE_NOW.toISOString(),
      ],
    );
    const response = await request(application).post("/api/auth/register").send({
      username,
      displayName: username.toUpperCase(),
      password: "password123",
      registrationInviteCode: code,
    });
    if (response.status !== 201) {
      throw new Error(`Registration failed for ${username}: ${response.status}`);
    }
    return {
      id: response.body.user.id as string,
      username,
      agent: await login(username),
    };
  }

  return {
    application,
    database,
    bootstrap,
    register,
    async addToTeam(actor, user) {
      const response = await actor.agent.post("/api/team/members").send({
        userId: user.id,
      });
      if (response.status !== 200) {
        throw new Error(`Adding ${user.username} to team failed: ${response.status}`);
      }
    },
    async createProject(actor, memberUserIds = []) {
      const response = await actor.agent.post("/api/projects").send({
        name: "Research schedule",
        description: "Task 3 integration",
        startDate: "2026-07-20",
        endDate: "2026-12-31",
        memberUserIds,
      });
      if (response.status !== 201) {
        throw new Error(`Project creation failed: ${response.status}`);
      }
      return response.body.project as { id: string; revision: number };
    },
    close() {
      database.close();
    },
  };
}
