import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { dependencyNotices, isSourceFile, sourceArchive, sourceFiles } from "../scripts/legal-assets.mjs";

const directories: string[] = [];
function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-legal-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("corresponding source and license packaging", () => {
  it("excludes runtime data, credentials and traversal while keeping build/deployment examples", () => {
    for (const file of [".env", "server/.env", "data/app.sqlite", "public/upload.txt", "deploy/production.env", "server/key.pem", "src/credentials.json", "src/../data/password.txt", "src\\app.ts", ".git/config", "node_modules/react/index.js"]) {
      expect(isSourceFile(file), file).toBe(false);
    }
    for (const file of ["LICENSE", "package-lock.json", "src/App.tsx", "server/v2.ts", "scripts/legal-assets.mjs", "deploy/team-project-manager-v2.env.example"]) {
      expect(isSourceFile(file), file).toBe(true);
    }
  });

  it("packages actual modified bytes, refuses unreviewed source, and reproduces from an extracted manifest", () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/app.ts"), "original");
    fs.writeFileSync(path.join(root, ".env"), "TEST_SECRET=excluded");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "src/app.ts", ".env"], { cwd: root });
    fs.writeFileSync(path.join(root, "src/app.ts"), "modified source");
    const files = sourceFiles(root);
    expect(files.map((file: { name: string }) => file.name)).toEqual(["src/app.ts"]);
    const archive = sourceArchive(files);
    expect(gunzipSync(archive).includes(Buffer.from("modified source"))).toBe(true);
    expect(gunzipSync(archive).includes(Buffer.from("TEST_SECRET"))).toBe(false);
    expect(sourceArchive(files)).toEqual(archive);
    fs.writeFileSync(path.join(root, "src/new.ts"), "new source");
    expect(() => sourceFiles(root)).toThrow("Stage reviewed source");
    fs.writeFileSync(path.join(root, "SOURCE_MANIFEST.json"), JSON.stringify({ files: [{ path: "src/app.ts" }] }));
    expect(sourceArchive(sourceFiles(root))).toEqual(archive);
  });

  it("fails on missing non-optional packages or license texts instead of silently dropping attribution", () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/example": { version: "1.0.0" } } }));
    expect(() => dependencyNotices(root)).toThrow("Missing locked dependency");
    fs.mkdirSync(path.join(root, "node_modules/example"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/example/package.json"), JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" }));
    expect(() => dependencyNotices(root)).toThrow("No complete license found");
  });
});
