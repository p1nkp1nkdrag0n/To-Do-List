import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { parseConfig } from "../../../server/config/env.js";
import { startV2Server, type V2ServerHandle } from "../../../server/v2.js";
import { nodeHttpFetch } from "../http/node-http-fetch.js";

interface Account {
  id: string;
  cookie: string;
}

async function jsonRequest<T>(
  url: string,
  pathName: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; cookie?: string }> {
  const response = await nodeHttpFetch(`${url}${pathName}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const responseText = await response.text();
  const body = responseText === "" ? undefined : JSON.parse(responseText);
  return { status: response.status, body: body as T, ...(cookie ? { cookie } : {}) };
}

async function openSocket(url: string, projectId: string, cookie: string): Promise<WebSocket> {
  const socketUrl = new URL(url);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/ws";
  socketUrl.searchParams.set("projectId", projectId);
  const socket = new WebSocket(socketUrl, { headers: { Cookie: cookie } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for collaboration message."));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

describe("v2 collaboration WebSocket", () => {
  const directories: string[] = [];
  const handles: V2ServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  async function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-collaboration-"));
    directories.push(directory);
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        UPLOAD_PATH: "runtime/uploads",
        HOST: "127.0.0.1",
        PORT: "0",
        BOOTSTRAP_CODE: "collaboration-bootstrap",
      },
      directory,
    );
    const handle = await startV2Server(config, {
      realtimeLockTtlMs: 250,
      realtimeSweepIntervalMs: 25,
    });
    handles.push(handle);
    await jsonRequest(handle.url, "/api/auth/register", {
      method: "POST",
      body: {
        username: "leader",
        displayName: "Leader",
        password: "password-123",
        bootstrapCode: "collaboration-bootstrap",
      },
    });
    const leaderLogin = await jsonRequest<{ user: { id: string } }>(handle.url, "/api/auth/login", {
      method: "POST",
      body: { username: "leader", password: "password-123" },
    });
    const leader: Account = { id: leaderLogin.body.user.id, cookie: leaderLogin.cookie! };
    const invite = await jsonRequest<{ invite: { code: string } }>(handle.url, "/api/team/registration-invites", {
      method: "POST",
      cookie: leader.cookie,
      body: {},
    });
    const memberRegistration = await jsonRequest<{ user: { id: string } }>(handle.url, "/api/auth/register", {
      method: "POST",
      body: {
        username: "member",
        displayName: "Member",
        password: "password-123",
        registrationInviteCode: invite.body.invite.code,
      },
    });
    const memberLogin = await jsonRequest<{ user: { id: string } }>(handle.url, "/api/auth/login", {
      method: "POST",
      body: { username: "member", password: "password-123" },
    });
    const member: Account = { id: memberRegistration.body.user.id, cookie: memberLogin.cookie! };
    const teamAddition = await jsonRequest(handle.url, "/api/team/members", {
      method: "POST",
      cookie: leader.cookie,
      body: { userId: member.id },
    });
    expect(teamAddition.status).toBe(200);
    const createdProject = await jsonRequest<{
      project: { id: string };
      members: Array<{ userId: string; revision: number }>;
    }>(handle.url, "/api/projects", {
      method: "POST",
      cookie: leader.cookie,
      body: { name: "Collaboration", description: "", memberUserIds: [member.id] },
    });
    const projectId = createdProject.body.project.id;
    const leaderProjectRevision = createdProject.body.members.find(
      (projectMember) => projectMember.userId === leader.id,
    )?.revision;
    if (leaderProjectRevision === undefined) {
      throw new Error("The project creator membership was not returned.");
    }
    const task = await jsonRequest<{ task: { id: string; revision: number } }>(handle.url, `/api/projects/${projectId}/tasks`, {
      method: "POST",
      cookie: leader.cookie,
      body: { title: "Shared assignment", startDate: "2026-07-20", dueDate: "2026-07-24" },
    });
    const assignment = await jsonRequest<{ participant: { id: string } }>(handle.url, `/api/projects/${projectId}/tasks/${task.body.task.id}/participants`, {
      method: "POST",
      cookie: leader.cookie,
      body: { userId: member.id, startDate: "2026-07-20", endDate: "2026-07-24", estimatedMinutes: 480 },
    });
    return {
      handle,
      leader,
      member,
      leaderProjectRevision,
      projectId,
      task: task.body.task,
      participantId: assignment.body.participant.id,
    };
  }

  it("rejects concurrent drag, broadcasts previews, releases on disconnect, and invalidates after commit", async () => {
    const state = await setup();
    const leaderSocket = await openSocket(state.handle.url, state.projectId, state.leader.cookie);
    const memberSocket = await openSocket(state.handle.url, state.projectId, state.member.cookie);
    sockets.push(leaderSocket, memberSocket);

    const granted = nextMessage(leaderSocket, (message) => message.type === "drag.lock.granted");
    leaderSocket.send(JSON.stringify({ type: "drag.lock.acquire", participantId: state.participantId }));
    expect(await granted).toMatchObject({ participantId: state.participantId, ownerId: state.leader.id });

    const denied = nextMessage(memberSocket, (message) => message.type === "drag.lock.denied");
    memberSocket.send(JSON.stringify({ type: "drag.lock.acquire", participantId: state.participantId }));
    expect(await denied).toMatchObject({ participantId: state.participantId, ownerId: state.leader.id });

    const preview = nextMessage(memberSocket, (message) => message.type === "drag.preview");
    leaderSocket.send(JSON.stringify({
      type: "drag.preview",
      participantId: state.participantId,
      startDate: "2026-07-21",
      endDate: "2026-07-25",
    }));
    expect(await preview).toMatchObject({
      participantId: state.participantId,
      startDate: "2026-07-21",
      endDate: "2026-07-25",
      ownerId: state.leader.id,
    });

    const released = nextMessage(memberSocket, (message) => message.type === "drag.lock.released");
    leaderSocket.close();
    expect(await released).toMatchObject({ participantId: state.participantId });

    const memberGranted = nextMessage(memberSocket, (message) => message.type === "drag.lock.granted");
    memberSocket.send(JSON.stringify({ type: "drag.lock.acquire", participantId: state.participantId }));
    expect(await memberGranted).toMatchObject({ ownerId: state.member.id });

    const invalidated = nextMessage(memberSocket, (message) => message.type === "entity.invalidated");
    const updated = await jsonRequest(state.handle.url, `/api/projects/${state.projectId}/tasks/${state.task.id}`, {
      method: "PATCH",
      cookie: state.leader.cookie,
      body: { expectedRevision: state.task.revision, title: "Committed title" },
    });
    expect(updated.status).toBe(200);
    expect(await invalidated).toMatchObject({ entityType: "project", entityId: state.projectId });
  });

  it("expires an abandoned lock after the heartbeat timeout", async () => {
    const state = await setup();
    const leaderSocket = await openSocket(state.handle.url, state.projectId, state.leader.cookie);
    const memberSocket = await openSocket(state.handle.url, state.projectId, state.member.cookie);
    sockets.push(leaderSocket, memberSocket);
    const granted = nextMessage(leaderSocket, (message) => message.type === "drag.lock.granted");
    leaderSocket.send(JSON.stringify({ type: "drag.lock.acquire", participantId: state.participantId }));
    await granted;
    const expired = nextMessage(memberSocket, (message) => message.type === "drag.lock.released", 1_500);
    expect(await expired).toMatchObject({ participantId: state.participantId, reason: "expired" });
  });

  it("invalidates project schedules when a member changes availability", async () => {
    const state = await setup();
    const memberSocket = await openSocket(state.handle.url, state.projectId, state.member.cookie);
    sockets.push(memberSocket);
    const invalidated = nextMessage(
      memberSocket,
      (message) => message.type === "entity.invalidated" && message.entityType === "availability",
    );

    const updated = await jsonRequest(state.handle.url, "/api/me/availability", {
      method: "PUT",
      cookie: state.leader.cookie,
      body: {
        expectedRevision: 1,
        profiles: [
          {
            validFrom: "2026-07-01",
            validThrough: "2026-12-31",
            weeklyCapacityMinutes: 600,
            privateNote: "",
            weeklySlots: [
              { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
            ],
            exceptions: [],
          },
        ],
      },
    });

    expect(updated.status).toBe(200);
    expect(await invalidated).toMatchObject({
      entityType: "availability",
      entityId: state.leader.id,
    });
  });

  it("invalidates project membership when an invite is redeemed", async () => {
    const state = await setup();
    const registrationInvite = await jsonRequest<{ invite: { code: string } }>(
      state.handle.url,
      "/api/team/registration-invites",
      { method: "POST", cookie: state.leader.cookie, body: {} },
    );
    await jsonRequest(state.handle.url, "/api/auth/register", {
      method: "POST",
      body: {
        username: "outsider",
        displayName: "Outsider",
        password: "password-123",
        registrationInviteCode: registrationInvite.body.invite.code,
      },
    });
    const outsiderLogin = await jsonRequest(state.handle.url, "/api/auth/login", {
      method: "POST",
      body: { username: "outsider", password: "password-123" },
    });
    const projectInvite = await jsonRequest<{ invite: { code: string } }>(
      state.handle.url,
      `/api/projects/${state.projectId}/invites`,
      { method: "POST", cookie: state.leader.cookie, body: {} },
    );
    const leaderSocket = await openSocket(state.handle.url, state.projectId, state.leader.cookie);
    sockets.push(leaderSocket);
    const invalidated = nextMessage(
      leaderSocket,
      (message) => message.type === "entity.invalidated" && message.entityId === state.projectId,
    );

    const redeemed = await jsonRequest(state.handle.url, "/api/project-invites/redeem", {
      method: "POST",
      cookie: outsiderLogin.cookie,
      body: { code: projectInvite.body.invite.code },
    });

    expect(redeemed.status).toBe(200);
    expect(await invalidated).toMatchObject({
      entityType: "project",
      entityId: state.projectId,
    });
  });

  it("revokes an existing realtime connection when project membership is removed", async () => {
    const state = await setup();
    const leaderSocket = await openSocket(state.handle.url, state.projectId, state.leader.cookie);
    sockets.push(leaderSocket);
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for revoked socket.")), 2_000);
      leaderSocket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });

    const removed = await jsonRequest(
      state.handle.url,
      `/api/projects/${state.projectId}/members/${state.leader.id}`,
      {
        method: "DELETE",
        cookie: state.member.cookie,
        body: { expectedRevision: state.leaderProjectRevision },
      },
    );

    expect(removed).toMatchObject({ status: 204 });
    await expect(closed).resolves.toEqual({ code: 1008, reason: "Project access revoked" });
  });
});
