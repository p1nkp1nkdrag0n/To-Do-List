import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrateFile, readWithLegacy } from "../../server/config/config-root.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
function root() { const p = fs.mkdtempSync(path.join(os.tmpdir(), "config-copy-")); roots.push(p); return p; }
it("copies legacy keys without deleting originals and never overwrites destination", () => {
  const p = root(), old = path.join(p, "old.json"), next = path.join(p, "new/config.json");
  fs.writeFileSync(old, "synthetic-old");
  expect(readWithLegacy(next, old)).toBe("synthetic-old");
  expect(fs.readFileSync(old, "utf8")).toBe("synthetic-old");
  fs.writeFileSync(next, "synthetic-new");
  migrateFile(old, next);
  expect(readWithLegacy(next, old)).toBe("synthetic-new");
});
it("global key migration retains backup and cannot overwrite or revive removed user keys", async () => {
  const p = root();
  vi.spyOn(process, "cwd").mockReturnValue(p);
  vi.stubEnv("DB_PATH", path.join(p, "persistent/app.sqlite"));
  vi.resetModules();
  const { migrateLegacyConfigToOwner } = await import("../../server/meeting/llm-config.js");
  const old = path.join(p, "data/v2/llm-config.json");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ provider: "test", baseUrl: "https://example.invalid", model: "test", apiKey: "synthetic" }));
  expect(migrateLegacyConfigToOwner("test-user")).toBe(true);
  expect(fs.existsSync(old)).toBe(true);
  const next = path.join(p, "persistent/llm/test-user.json");
  fs.writeFileSync(next, '{"version":2,"activeId":null,"providers":[]}');
  expect(migrateLegacyConfigToOwner("test-user")).toBe(false);
  expect(JSON.parse(fs.readFileSync(next, "utf8")).providers).toEqual([]);
});
