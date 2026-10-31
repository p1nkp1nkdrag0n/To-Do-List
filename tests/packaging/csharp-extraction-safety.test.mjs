/**
 * Linux source-contract + filesystem MODEL tests, NOT compilation/execution of
 * Launcher.cs. Windows reparse points, sharing flags and EXE remain a release gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const source = fs.readFileSync(new URL("../../packaging/single-exe/Launcher.cs", import.meta.url), "utf8");
test("C# extraction owns creation exclusively, validates before claim, never recursively cleans", () => {
  assert.match(source, /extern bool CreateDirectoryW/);
  assert.match(source, /if \(!CreateExclusiveDirectory\(candidate\)\) continue/);
  assert.ok(source.indexOf("RejectReparseAncestors(staging);") < source.indexOf('new FileStream(claim'));
  assert.match(source, /FileMode.CreateNew, FileAccess.Write, FileShare.None/);
  assert.match(source, /VerifyOwnedTree\(staging, owned\)/);
  assert.doesNotMatch(source, /Directory\.Delete|File\.Delete|File\.Create\(/);
  assert.match(source, /FileOptions.DeleteOnClose/);
  assert.match(source, /Extract\(zipFile, staging, owned\)/);
  assert.match(source, /new ZipArchive\(zip, ZipArchiveMode.Read, true\)/);
  assert.match(source, /if \(child.ExitCode != 0\) PauseOnError\(\)/);
  assert.match(source, /Console.IsInputRedirected/);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function exclusiveDir(p) { fs.mkdirSync(p); return p; }
function writeExclusive(p, data) { fs.writeFileSync(p, data, { flag: "wx" }); }
function assertOwned(root, owned) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    assert.equal(e.isSymbolicLink(), false, "reparse model");
    assert.ok(owned.has(p), "foreign entry");
    if (e.isDirectory()) assertOwned(p, owned);
  }
}
test("model failure matrix: existing candidate/claim/foreign payload preserved", t => {
  const root = fixture(t), staging = exclusiveDir(path.join(root, "stage"));
  writeExclusive(path.join(staging, ".claim"), "foreign-claim");
  assert.throws(() => exclusiveDir(staging), /EEXIST/);
  assert.throws(() => writeExclusive(path.join(staging, ".claim"), "ours"), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(staging, ".claim"), "utf8"), "foreign-claim");
  const target = path.join(staging, "node.exe");
  writeExclusive(target, "foreign-node");
  assert.throws(() => writeExclusive(target, "payload"), /EEXIST/);
  assert.equal(fs.readFileSync(target, "utf8"), "foreign-node");
});
test("model failure matrix: postclaim foreign entries and symlink refused, not removed", t => {
  const root = fixture(t), staging = exclusiveDir(path.join(root, "stage"));
  const claim = path.join(staging, ".claim"); writeExclusive(claim, "ours");
  const owned = new Set([staging, claim]);
  const foreign = path.join(staging, "foreign"); writeExclusive(foreign, "keep");
  assert.throws(() => assertOwned(staging, owned), /foreign/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "keep");
  const other = exclusiveDir(path.join(root, "outside")); writeExclusive(path.join(other, "saved"), "keep");
  fs.symlinkSync(other, path.join(staging, "junction-model"));
  assert.throws(() => assertOwned(staging, owned));
  assert.equal(fs.readFileSync(path.join(other, "saved"), "utf8"), "keep");
});
test("model failure matrix: target collision and copy failure preserve old tree", t => {
  const root = fixture(t), old = exclusiveDir(path.join(root, "version")), stage = exclusiveDir(path.join(root, "stage"));
  writeExclusive(path.join(old, "saved"), "old-program-and-data");
  writeExclusive(path.join(stage, "partial"), "incomplete");
  assert.throws(() => exclusiveDir(old), /EEXIST/);
  // Failure policy deliberately retains stage; never recursive-delete anything.
  assert.equal(fs.readFileSync(path.join(old, "saved"), "utf8"), "old-program-and-data");
  assert.equal(fs.readFileSync(path.join(stage, "partial"), "utf8"), "incomplete");
});


test("C# entry point, sentinel, failure-closed reparse checks and console inheritance contracts", () => {
  assert.match(source, /EntryPoint = "CreateDirectoryW", ExactSpelling = true/);
  assert.match(source, /Path.Combine\("launcher", "launcher-data-flow.mjs"\)/);
  const guard = source.slice(source.indexOf("private static void RejectReparseAncestors"), source.indexOf("private static string CreateStaging"));
  assert.match(guard, /File.GetAttributes\(current\)/);
  assert.doesNotMatch(guard, /Directory.Exists|File.Exists|catch \(Exception|catch \(IOException|catch \(UnauthorizedAccessException/);
  assert.match(guard, /catch \(FileNotFoundException\)/);
  assert.match(guard, /catch \(DirectoryNotFoundException\)/);
  for (const stream of ["Input", "Output", "Error"])
    assert.ok(source.includes("start.RedirectStandard" + stream + " = false;"));
  assert.match(source, /start.CreateNoWindow = false/);
  assert.match(source, /start.UseShellExecute = false/);
  const build = fs.readFileSync(new URL("../../packaging/single-exe/build.ps1", import.meta.url), "utf8");
  assert.match(build, /\/target:exe/);
  assert.doesNotMatch(build, /\/target:winexe/);
});
