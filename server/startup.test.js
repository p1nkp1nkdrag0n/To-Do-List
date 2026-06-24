import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createDatabase } from "./db.js";
import { startServer } from "./startup.js";

const testBootstrapCode = "startup-bootstrap-code";
process.env.BOOTSTRAP_CODE = testBootstrapCode;

async function tempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "team-planner-startup-"));
}

async function tempDist(root) {
  const distPath = path.join(root, "dist");
  await fs.mkdir(distPath, { recursive: true });
  await fs.writeFile(
    path.join(distPath, "index.html"),
    "<!doctype html><html><body><div id=\"root\">startup-ok</div></body></html>"
  );
  return distPath;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function waitForServerOutput(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`Server did not start in time. stdout: ${output} stderr: ${errors}`));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    const onStdout = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Server running at http:\/\/localhost:(\d+)/);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onStderr = (chunk) => {
      errors += chunk.toString();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited before startup with code ${code}. stdout: ${output} stderr: ${errors}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function api(baseUrl, pathName, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function register(baseUrl, username) {
  const result = await api(baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username, password: "secret123", displayName: username.toUpperCase(), registrationCode: testBootstrapCode }
  });
  assert.equal(result.response.status, 201);
  return result.data;
}

async function createProject(baseUrl, token, name = "Startup") {
  const result = await api(baseUrl, "/api/projects", {
    token,
    method: "POST",
    body: { name, timezone: "Asia/Shanghai" }
  });
  assert.equal(result.response.status, 201);
  return result.data.project;
}

function socketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function runInviteScript(dbPath, count = 1) {
  const child = spawn(process.execPath, ["scripts/create-invites.js", "--count", String(count)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: dbPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, errors);
  return output;
}

test("startup server listens, serves frontend fallback and protects api routes", async () => {
  const root = await tempWorkspace();
  const db = await createDatabase(path.join(root, "app.sqlite"));
  const distPath = await tempDist(root);
  const started = await startServer({ port: 0, host: "127.0.0.1", db, distPath });
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    assert.equal(started.host, "127.0.0.1");

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /startup-ok/);

    const fallback = await fetch(`${baseUrl}/projects/some-route`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /startup-ok/);

    const protectedApi = await fetch(`${baseUrl}/api/projects`);
    assert.equal(protectedApi.status, 401);
    assert.deepEqual(await protectedApi.json(), { error: "Authentication is required." });

    const admin = await register(baseUrl, "startupadmin");
    const project = await createProject(baseUrl, admin.token);
    assert.equal(project.name, "Startup");
  } finally {
    await closeServer(started.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production startup requires auth and bootstrap secrets", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalBootstrapCode = process.env.BOOTSTRAP_CODE;
  process.env.NODE_ENV = "production";
  delete process.env.AUTH_SECRET;
  delete process.env.BOOTSTRAP_CODE;

  try {
    await assert.rejects(
      () => startServer({ port: 0 }),
      /Missing required production environment variables: AUTH_SECRET, BOOTSTRAP_CODE/
    );
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalAuthSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalAuthSecret;
    }
    if (originalBootstrapCode === undefined) {
      delete process.env.BOOTSTRAP_CODE;
    } else {
      process.env.BOOTSTRAP_CODE = originalBootstrapCode;
    }
  }
});

test("startup websocket rejects invalid subscriptions and accepts project members", async () => {
  const root = await tempWorkspace();
  const db = await createDatabase(path.join(root, "app.sqlite"));
  const distPath = await tempDist(root);
  const started = await startServer({ port: 0, db, distPath });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  const wsUrl = `ws://127.0.0.1:${started.port}/ws`;

  try {
    const deniedSocket = await openSocket(wsUrl);
    deniedSocket.send(JSON.stringify({ type: "subscribe", projectId: "missing", token: "bad-token" }));
    assert.deepEqual(await socketMessage(deniedSocket), { type: "auth:error" });
    deniedSocket.close();

    const admin = await register(baseUrl, "socketadmin");
    const project = await createProject(baseUrl, admin.token, "Socket Project");
    const memberSocket = await openSocket(wsUrl);
    memberSocket.send(JSON.stringify({ type: "subscribe", projectId: project.id, token: admin.token }));
    assert.deepEqual(await socketMessage(memberSocket), { type: "subscribe:ok", projectId: project.id });
    memberSocket.close();
  } finally {
    await closeServer(started.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup database path creates a persistent sqlite file", async () => {
  const root = await tempWorkspace();
  const dbPath = path.join(root, "nested", "app.sqlite");

  try {
    const db = await createDatabase(dbPath);
    await db.run(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
      ["persisted-user", "persisted", "hash", "Persisted User", "2026-06-17T00:00:00.000Z"]
    );

    const stat = await fs.stat(dbPath);
    assert.equal(stat.isFile(), true);

    const reopened = await createDatabase(dbPath);
    const user = reopened.get("SELECT username, display_name AS displayName FROM users WHERE id = ?", ["persisted-user"]);
    assert.deepEqual(user, { username: "persisted", displayName: "Persisted User" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invite creation script writes registration invites to DB_PATH", async () => {
  const root = await tempWorkspace();
  const dbPath = path.join(root, "invites.sqlite");

  try {
    const output = await runInviteScript(dbPath, 2);
    assert.match(output, /Created 2 registration invites/);

    const db = await createDatabase(dbPath);
    const inviteCount = db.get("SELECT COUNT(*) AS count FROM registration_invites").count;
    assert.equal(inviteCount, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("running server reloads invite codes created by the CLI", async () => {
  const root = await tempWorkspace();
  const dbPath = path.join(root, "live-invites.sqlite");
  const db = await createDatabase(dbPath);
  const distPath = await tempDist(root);
  const started = await startServer({ port: 0, host: "127.0.0.1", db, distPath });
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    await register(baseUrl, "liveadmin");
    const output = await runInviteScript(dbPath, 1);
    const inviteCode = output.trim().split(/\r?\n/).at(-1);
    const invited = await api(baseUrl, "/api/auth/register", {
      method: "POST",
      body: { username: "liveinvited", password: "secret123", displayName: "LIVE", registrationCode: inviteCode }
    });
    assert.equal(invited.response.status, 201);
  } finally {
    await closeServer(started.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server index entrypoint boots on a random port", async () => {
  const root = await tempWorkspace();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
      DB_PATH: path.join(root, "entrypoint.sqlite"),
      AUTH_SECRET: "startup-test-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const port = await waitForServerOutput(child);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication is required." });
  } finally {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
