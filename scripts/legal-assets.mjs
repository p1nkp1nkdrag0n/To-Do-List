import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const text = (file) => fs.readFileSync(file, "utf8");
const noticeName = /^(licen[sc]es?|copying|notices?|copyright|authors|ofl)([._-]|$)|third.?party.*(notic|licen)/i;
const rootFiles = new Set([
  ".gitignore", ".gitattributes", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "index.html",
  "package.json", "package-lock.json", "vite.config.ts", "vitest.config.ts",
  "playwright.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json",
  "tsconfig.server.json",
]);

// Only reviewed source locations are eligible; never walk the deployment directory.
export function isSourceFile(file) {
  if (file.includes("\\") || file.split("/").some((part) => part === "..")) return false;
  if (rootFiles.has(file)) return true;
  if (/^deploy\/(Caddyfile\.example|team-project-manager-v2\.env\.example|team-project-manager\.service)$/.test(file)) return true;
  return /^(src|server|shared|scripts|tests|licenses)\//.test(file)
    && !/(^|\/)(\.|node_modules\/|data\/)/.test(file)
    && /\.(ts|tsx|js|mjs|css|json|md|txt)$/.test(file)
    && !/(secret|credential|\.env|\.sqlite|\.pem)/i.test(file);
}

export function sourceFiles(root) {
  let names;
  // The downloaded archive is independently rebuildable without a Git checkout.
  if (fs.existsSync(path.join(root, "SOURCE_MANIFEST.json"))) {
    names = json(path.join(root, "SOURCE_MANIFEST.json")).files.map((entry) => entry.path);
  } else {
    names = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const untracked = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(isSourceFile);
    if (untracked.length) throw new Error(`Stage reviewed source files before building: ${untracked.join(", ")}`);
  }
  return [...new Set(names)].filter(isSourceFile).sort().map((name) => {
    const absolute = path.join(root, name);
    if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== path.resolve(absolute)) {
      throw new Error(`Source archive refuses links or non-files: ${name}`);
    }
    return { name, data: fs.readFileSync(absolute) };
  });
}

// Deterministic POSIX ustar, using regular files only; no dependency or shell archive command.
export function sourceArchive(files) {
  const chunks = [];
  for (const { name, data } of files) {
    const archiveName = `to-do-list/${name}`;
    if (Buffer.byteLength(archiveName) > 100) throw new Error(`Source path too long: ${name}`);
    const header = Buffer.alloc(512);
    const put = (value, offset, length) => header.write(value, offset, length, "utf8");
    const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";
    put(archiveName, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(data.length, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    put(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function noticeFiles(directory, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...noticeFiles(path.join(directory, entry.name), `${relative}/`));
    else if (entry.isFile() && noticeName.test(entry.name)) result.push(relative);
  }
  return result.sort();
}

export function dependencyNotices(root) {
  const lock = json(path.join(root, "package-lock.json"));
  const packages = [];
  const sections = ["THIRD-PARTY LICENSES AND NOTICES\n\nComplete upstream notice files for installed non-dev npm packages.\nIncludes build tools declared as production dependencies, not just browser code.\nEach package retains its own license; the application license does not replace it.\n"];
  for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!location || entry.dev) continue;
    const directory = path.join(root, location);
    if (!fs.existsSync(path.join(directory, "package.json"))) {
      if (entry.optional) continue;
      throw new Error(`Missing locked dependency: ${location}; run npm ci.`);
    }
    const pkg = json(path.join(directory, "package.json"));
    if (pkg.version !== entry.version) throw new Error(`Dependency differs from lockfile: ${location}`);
    let notices = noticeFiles(directory).map((name) => ({ name: `${location}/${name}`, data: text(path.join(directory, name)) }));
    if (!notices.some((item) => /licen[sc]e|copying|ofl/i.test(path.basename(item.name)))) {
      // Native npm wrappers use the same release's parent package license.
      const parent = pkg.name.startsWith("@esbuild/") ? "esbuild" : pkg.name.startsWith("@rolldown/binding-") ? "rolldown" : null;
      if (parent) {
        const parentPath = path.join(root, "node_modules", parent);
        if (json(path.join(parentPath, "package.json")).version !== pkg.version) throw new Error(`Native license version mismatch: ${pkg.name}`);
        notices = noticeFiles(parentPath).map((name) => ({ name: `node_modules/${parent}/${name}`, data: text(path.join(parentPath, name)) }));
      } else if (pkg.name === "cookie-signature" && pkg.version === "1.0.7") {
        notices.push({ name: `${location}/Readme.md`, data: text(path.join(directory, "Readme.md")) });
      } else {
        throw new Error(`No complete license found for ${pkg.name}@${pkg.version}; review upstream before release.`);
      }
    }
    const license = pkg.license ?? pkg.licenses?.map((item) => item.type).join(" OR ");
    if (!license) throw new Error(`Missing license metadata: ${location}`);
    packages.push({ name: pkg.name, version: pkg.version, license, location, resolved: entry.resolved, integrity: entry.integrity, notices: notices.map((item) => ({ path: item.name, sha256: sha256(item.data) })) });
    sections.push(`\n${"=".repeat(78)}\n${pkg.name}@${pkg.version} — ${license}\nPackage: ${location}\nSource package: ${entry.resolved}\n`);
    for (const notice of notices) sections.push(`\n--- BEGIN ${notice.name} ---\n${notice.data}\n--- END ${notice.name} ---\n`);
  }
  return { packages, text: sections.join("") };
}

const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function createLegalAssets(root, browserPackages = []) {
  const pkg = json(path.join(root, "package.json"));
  if (pkg.license !== "AGPL-3.0-only") throw new Error("Expected AGPL-3.0-only application license.");
  const files = sourceFiles(root);
  for (const required of rootFiles) {
    if (!files.some((file) => file.name === required)) throw new Error(`Missing source file: ${required}`);
  }
  const manifest = { files: files.map((file) => ({ path: file.name, sha256: sha256(file.data) })) };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const sourceId = sha256(manifestText);
  const sourceName = `source-${sourceId}.tar.gz`;
  const archive = sourceArchive([...files, { name: "SOURCE_MANIFEST.json", data: Buffer.from(manifestText) }]);
  const notices = dependencyNotices(root);
  for (const location of browserPackages) {
    if (!notices.packages.some((item) => item.location === location)) throw new Error(`Browser dependency missing notices: ${location}`);
  }
  const metadata = { version: pkg.version, license: pkg.license, sourceId, sourceArchive: sourceName, archiveSha256: sha256(archive), browserPackages, packages: notices.packages };
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>关于 / 开源许可 · TO DO LIST</title>
<style>body{margin:0;background:#f3f6fa;color:#172033;font:16px/1.7 system-ui,sans-serif}main{max-width:760px;margin:5vh auto;padding:28px;background:white;border-radius:16px}h1{font-size:26px}a{color:#075ccc}li{margin:12px 0}code{overflow-wrap:anywhere}small{color:#526079}@media(max-width:800px){main{margin:0;border-radius:0;padding:24px}}</style>
<main><a href="/">← 返回应用</a><h1>关于 / 开源许可</h1><p>TO DO LIST v${escapeHtml(pkg.version)}</p>
<p>本项目原创代码采用 <strong>GNU Affero General Public License v3.0 only（AGPL-3.0-only）</strong>。本软件不提供任何担保；详见许可全文。</p>
<ul><li><a href="LICENSE.txt">AGPLv3 许可全文</a></li><li><a href="THIRD_PARTY_NOTICES.txt">第三方完整许可与原作者声明</a></li><li><a href="${sourceName}" download>下载此构建的对应源码</a></li></ul>
<p>源码包包含本次构建的应用源码、构建脚本、依赖锁文件和部署示例。解压后按 README 安装锁定依赖并构建；修改源码后重新构建即可生成新的源码包。无需登录即可下载。</p>
<p>Inter 字体继续采用 OFL-1.1；Lucide 采用 ISC，派生自 Feather 的图标保留 MIT 声明。其他第三方组件按各自许可分发。</p>
<p><small>源码标识（SHA-256）：<code>${sourceId}</code><br>校验记录：<a href="build.json">构建与依赖清单</a> · <a href="SOURCE_MANIFEST.json">源码文件校验清单</a></small></p></main></html>`;
  return new Map([
    ["index.html", html], ["LICENSE.txt", fs.readFileSync(path.join(root, "LICENSE"))],
    ["THIRD_PARTY_NOTICES.txt", notices.text], ["build.json", JSON.stringify(metadata, null, 2) + "\n"],
    ["SOURCE_MANIFEST.json", manifestText], [sourceName, archive],
  ]);
}

export function legalAssetsPlugin() {
  let root;
  return {
    name: "application-license-and-corresponding-source",
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use("/legal", (_request, response, next) => {
        try {
          const name = decodeURIComponent((_request.url ?? "/").split("?")[0]).replace(/^\//, "") || "index.html";
          const asset = createLegalAssets(root).get(name);
          if (asset === undefined) return next();
          response.setHeader("Content-Type", name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".json") ? "application/json" : name.endsWith(".gz") ? "application/gzip" : "text/plain; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(asset);
        } catch (error) { next(error); }
      });
    },
    generateBundle(_options, bundle) {
      const browserPackages = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const normalized = id.replaceAll("\\", "/");
          const start = normalized.indexOf("node_modules/");
          if (start < 0) continue;
          const location = normalized.slice(start).match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1];
          if (location) browserPackages.add(location);
        }
      }
      // CSS font assets do not always appear in JavaScript chunk.modules.
      browserPackages.add("node_modules/@fontsource-variable/inter");
      for (const [name, source] of createLegalAssets(root, [...browserPackages].sort())) {
        this.emitFile({ type: "asset", fileName: `legal/${name}`, source });
      }
    },
  };
}
