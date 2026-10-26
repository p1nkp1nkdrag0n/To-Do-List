import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { dependencyNotices, isSourceFile, sha256 } from "./legal-assets.mjs";

const directory = path.resolve("dist/legal");
const read = (name) => fs.readFileSync(path.join(directory, name));
const metadata = JSON.parse(read("build.json"));
const manifestBytes = read("SOURCE_MANIFEST.json");
const manifest = JSON.parse(manifestBytes);
assert.equal(metadata.license, "AGPL-3.0-only");
assert.equal(metadata.sourceId, sha256(manifestBytes));
assert.deepEqual(read("LICENSE.txt"), fs.readFileSync("LICENSE"));
assert.equal(read("THIRD_PARTY_NOTICES.txt").toString(), dependencyNotices(process.cwd()).text);
assert.equal(metadata.archiveSha256, sha256(read(metadata.sourceArchive)));
assert.ok(read("index.html").toString().includes(metadata.sourceArchive));
const archive = gunzipSync(read(metadata.sourceArchive));
const archived = new Map();
for (let offset = 0; archive[offset];) {
  const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
  const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, ""), 8);
  assert.ok(name.startsWith("to-do-list/"));
  assert.equal(archive[offset + 156], 48); // regular files only
  archived.set(name.slice(11), archive.subarray(offset + 512, offset + 512 + size));
  offset += 512 + Math.ceil(size / 512) * 512;
}
assert.equal(archived.size, manifest.files.length + 1);
assert.deepEqual(archived.get("SOURCE_MANIFEST.json"), manifestBytes);
for (const file of manifest.files) {
  assert.ok(isSourceFile(file.path), `Unexpected source path: ${file.path}`);
  assert.equal(sha256(archived.get(file.path)), file.sha256, file.path);
  assert.equal(sha256(fs.readFileSync(file.path)), file.sha256, `Stale build: ${file.path}`);
}
for (const location of metadata.browserPackages) {
  assert.ok(metadata.packages.some((pkg) => pkg.location === location), `Missing browser notice: ${location}`);
}
for (const required of ["react", "react-dom", "lucide-react", "@fontsource-variable/inter", "express", "busboy", "ws", "sql.js"]) {
  assert.ok(metadata.packages.some((pkg) => pkg.name === required), `Missing dependency: ${required}`);
}
const notices = read("THIRD_PARTY_NOTICES.txt").toString();
for (const expected of ["SIL OPEN FONT LICENSE", "Cole Bemis", "Lucide Icons", "Mozilla Public License", "Apache License"]) assert.ok(notices.includes(expected), expected);
assert.ok(!metadata.browserPackages.some((name) => name.includes("lightningcss")), "Review MPL runtime distribution before release.");
const fonts = fs.readdirSync("dist/assets").filter((name) => name.endsWith(".woff2"));
assert.ok(fonts.length > 0, "Missing Inter font assets");
const originalFonts = fs.readdirSync("node_modules/@fontsource-variable/inter/files").filter((name) => name.endsWith(".woff2"))
  .map((name) => sha256(fs.readFileSync(path.join("node_modules/@fontsource-variable/inter/files", name))));
for (const font of fonts) assert.ok(originalFonts.includes(sha256(fs.readFileSync(path.join("dist/assets", font)))), `Modified or unknown font: ${font}`);
console.log(`License artifacts verified: ${metadata.packages.length} packages, ${metadata.browserPackages.length} browser packages, ${fonts.length} unchanged fonts, ${manifest.files.length} source files. Source ${metadata.sourceId}`);
