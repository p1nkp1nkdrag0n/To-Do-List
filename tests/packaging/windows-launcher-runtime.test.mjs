import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("Windows executes the compiled C# launcher against synthetic filesystem fixtures", {
  skip: process.platform !== "win32" ? "Requires Windows/.NET Framework" : false,
}, async (t) => {
  const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  assert.ok(fs.existsSync(compiler), "Install .NET Framework C# compiler to run the Windows launcher gate");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-native-"));
  t.after(() => {
    // Only remove this test's own temporary tree, never a launcher/user directory.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("launcher-native-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const exe = path.join(root, "launcher-tests.exe");
  const compile = spawnSync(compiler, [
    "/nologo", "/target:exe", "/main:LauncherRuntimeHarness", `/out:${exe}`,
    "/r:System.IO.Compression.dll", "/r:System.IO.Compression.FileSystem.dll",
    fileURLToPath(new URL("../../packaging/single-exe/Launcher.cs", import.meta.url)),
    fileURLToPath(new URL("./fixtures/LauncherRuntimeHarness.cs", import.meta.url)),
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);

  async function run(name, ...args) {
    await t.test([name, ...args].join(": "), () => {
      const caseRoot = fs.mkdtempSync(path.join(root, "case-"));
      if (name === "junction") {
        const outside = path.join(caseRoot, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "saved"), "keep");
        fs.symlinkSync(outside, path.join(caseRoot, "linked"), "junction");
      }
      const result = spawnSync(exe, [name, caseRoot, ...args], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^PASS /);
    });
  }

  for (const name of ["exclusive", "extract", "foreign", "junction", "temp", "length", "sentinels"]) await run(name);
  for (const entry of ["../escape.txt", "nested/../file.txt", "CON.txt", "COM1.txt", "file:stream", "trailing.", "trailing "]) {
    await run("unsafe", entry);
  }
});
