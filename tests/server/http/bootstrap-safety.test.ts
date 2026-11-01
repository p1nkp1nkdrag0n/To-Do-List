import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { createV2App, type V2AppDependencies } from "../../../server/http/app.js";
import { resolveDependencies } from "../../../server/http/dependencies.js";
import { AuthService } from "../../../server/modules/auth/auth-service.js";

const code = "synthetic-bootstrap-code";
const input = { username: "admin", displayName: "Admin", password: "password123", bootstrapCode: code };
describe("bootstrap safety", () => {
  let dir: string, db: V2Database, other: V2Database, now: Date;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "bootstrap-safety-"));
    db = openV2Database(path.join(dir, "test.sqlite"));
    migrateV2Database(db);
    other = openV2Database(path.join(dir, "test.sqlite"));
    now = new Date("2026-10-31T00:00:00Z");
  });
  afterEach(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  function deps(database = db, overrides: Partial<V2AppDependencies> = {}): V2AppDependencies {
    return { database, sessionSecret: "test-secret-32-characters-long-only", cookieSecure: false,
      bootstrapCode: code, uploadPath: path.join(dir, "uploads"), clock: () => now,
      passwordHasher: vi.fn(async () => "synthetic-hash"), ...overrides };
  }
  it("requires configured code even from loopback, before hashing", async () => {
    const dependencies = deps(), app = createV2App(dependencies);
    for (const bootstrapCode of [undefined, "wrong"]) {
      const res = await request(app).post("/api/auth/bootstrap").send({ ...input, bootstrapCode });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("BOOTSTRAP_CODE_INVALID");
    }
    expect(dependencies.passwordHasher).not.toHaveBeenCalled();
    expect((await request(app).post("/api/auth/bootstrap").send(input)).status).toBe(201);
    expect(dependencies.passwordHasher).toHaveBeenCalledTimes(1);
  });
  it("retains local no-code setup only when no code is configured", async () => {
    const app = createV2App(deps(db, { bootstrapCode: "" }));
    expect((await request(app).get("/api/auth/bootstrap-status")).body.requiresBootstrapCode).toBe(false);
    expect((await request(app).post("/api/auth/bootstrap").send({ ...input, bootstrapCode: undefined })).status).toBe(201);
  });
  it("does not trust proxy-supplied remote clients as local", async () => {
    const app = createV2App(deps(db, { bootstrapCode: "", trustProxyHops: 1 }));
    const res = await request(app).post("/api/auth/bootstrap").set("X-Forwarded-For", "203.0.113.8").send(input);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BOOTSTRAP_LOCAL_ONLY");
  });
  it("persists failed code attempts across connections and recovers after the window", async () => {
    const a = new AuthService(resolveDependencies(deps()));
    const bDeps = deps(other), b = new AuthService(resolveDependencies(bDeps));
    for (let i = 0; i < 5; i++) await expect(a.bootstrapAdmin({ ...input, bootstrapCode: "wrong" }, "peer")).rejects.toMatchObject({ status: 403 });
    await expect(b.bootstrapAdmin(input, "peer")).rejects.toMatchObject({ status: 429 });
    expect(bDeps.passwordHasher).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 600_001);
    await expect(b.bootstrapAdmin(input, "peer")).resolves.toMatchObject({ teamMember: true });
  });
  it("shares the first-account hash reservation with bootstrap and register across connections", async () => {
    let finish!: (value: string) => void;
    const hasher = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const a = new AuthService(resolveDependencies(deps(db, { passwordHasher: hasher })));
    const bDeps = deps(other), b = new AuthService(resolveDependencies(bDeps));
    const pending = a.bootstrapAdmin(input, "peer-a");
    await expect(b.bootstrapAdmin({ ...input, username: "second" }, "peer-b")).rejects.toMatchObject({ status: 403 });
    await expect(b.register({ ...input, username: "third" }, "peer-c")).rejects.toMatchObject({ status: 403 });
    expect(hasher).toHaveBeenCalledTimes(1);
    expect(bDeps.passwordHasher).not.toHaveBeenCalled();
    finish("synthetic-hash");
    await pending;
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM registration_hash_reservations")?.count).toBe(0);
    await expect(b.bootstrapAdmin(input, "peer-b")).rejects.toMatchObject({ status: 409 });
    expect(bDeps.passwordHasher).not.toHaveBeenCalled();
  });
  it("releases a failed hash reservation without leaving users or sessions", async () => {
    const a = new AuthService(resolveDependencies(deps(db, { passwordHasher: async () => { throw new Error("synthetic failure"); } })));
    await expect(a.bootstrapAdmin(input, "peer")).rejects.toThrow("synthetic failure");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count).toBe(0);
    const b = new AuthService(resolveDependencies(deps(other)));
    await expect(b.bootstrapAdmin(input, "peer")).resolves.toMatchObject({ teamMember: true });
  });
  it("rolls back a session write failure and releases admission for a retry", async () => {
    db.exec(`CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic session failure'); END`);
    const a = new AuthService(resolveDependencies(deps()));
    await expect(a.bootstrapAdmin(input, "peer")).rejects.toThrow("synthetic session failure");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM team_members")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM registration_hash_reservations")?.count).toBe(0);
    db.exec("DROP TRIGGER fail_session");
    await expect(a.bootstrapAdmin(input, "peer")).resolves.toMatchObject({ teamMember: true });
  });
  it("rejects an expired hash holder after another connection replaces its reservation", async () => {
    let finish!: (value: string) => void;
    const a = new AuthService(resolveDependencies(deps(db, {
      passwordHasher: () => new Promise<string>(resolve => { finish = resolve; }),
    })));
    const pending = a.bootstrapAdmin(input, "peer-a");
    now = new Date(now.getTime() + 300_001);
    const b = new AuthService(resolveDependencies(deps(other)));
    await b.bootstrapAdmin({ ...input, username: "second" }, "peer-b");
    finish("old-hash");
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(db.all<{ username: string }>("SELECT username FROM users")).toEqual([{ username: "second" }]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM sessions")?.count).toBe(1);
  });
});
