import path from "node:path";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_UPLOAD_BYTES,
  parseConfig,
} from "../../server/config/env.js";

describe("v2 environment configuration", () => {
  it("uses development defaults rooted outside public build output", () => {
    const root = path.resolve("C:/workspace/team-project-manager");
    const config = parseConfig({}, root);

    expect(config).toMatchObject({
      environment: "development",
      dbPath: path.join(root, "data", "v2", "app.sqlite"),
      uploadPath: path.join(root, "data", "v2", "uploads"),
      backupPath: path.join(root, "data", "v2", "backups"),
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      host: "0.0.0.0",
      port: 4000,
      cookieSecure: false,
      trustProxyHops: 0,
      bootstrapCode: "development-bootstrap-code",
    });
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
    expect(config.uploadPath.startsWith(path.join(root, "dist"))).toBe(false);
    expect(config.uploadPath.startsWith(path.join(root, "public"))).toBe(false);
  });

  it("parses explicit numeric, boolean, and relative path values", () => {
    const root = path.resolve("C:/workspace/team-project-manager");
    const config = parseConfig(
      {
        DB_PATH: "runtime/app.sqlite",
        UPLOAD_PATH: "runtime/uploads",
        BACKUP_PATH: "runtime/backups",
        MAX_UPLOAD_BYTES: "1048576",
        HOST: "127.0.0.1",
        PORT: "4100",
        SESSION_SECRET: "local-secret",
        COOKIE_SECURE: "true",
        TRUST_PROXY_HOPS: "1",
      },
      root,
    );

    expect(config.dbPath).toBe(path.join(root, "runtime", "app.sqlite"));
    expect(config.uploadPath).toBe(path.join(root, "runtime", "uploads"));
    expect(config.backupPath).toBe(path.join(root, "runtime", "backups"));
    expect(config.maxUploadBytes).toBe(1_048_576);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4100);
    expect(config.cookieSecure).toBe(true);
    expect(config.trustProxyHops).toBe(1);
  });

  it.each([
    ["dist directory", "dist"],
    ["nested dist directory", path.join("dist", "uploads")],
    ["public directory", "public"],
    ["nested public directory", path.join("public", "assets", "uploads")],
  ])("rejects UPLOAD_PATH inside the project %s", (_label, uploadPath) => {
    const root = path.resolve("C:/workspace/team-project-manager");

    expect(() => parseConfig({ UPLOAD_PATH: uploadPath }, root)).toThrow(
      /UPLOAD_PATH.*(?:dist|public)/i,
    );
  });

  it("does not confuse sibling names with dist or public containment", () => {
    const root = path.resolve("C:/workspace/team-project-manager");

    expect(
      parseConfig({ UPLOAD_PATH: "dist-uploads" }, root).uploadPath,
    ).toBe(path.join(root, "dist-uploads"));
    expect(
      parseConfig({ UPLOAD_PATH: "public-files" }, root).uploadPath,
    ).toBe(path.join(root, "public-files"));
  });

  it.runIf(process.platform === "win32")(
    "rejects Windows build paths regardless of casing",
    () => {
      const root = path.resolve("C:/Workspace/Team-Project-Manager");

      expect(() =>
        parseConfig(
          {
            UPLOAD_PATH:
              "c:/workspace/TEAM-PROJECT-MANAGER/DIST/private-uploads",
          },
          root,
        ),
      ).toThrow(/UPLOAD_PATH.*dist/i);
    },
  );

  it("rejects missing or unsafe production session secrets", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrow(
      /SESSION_SECRET/i,
    );
    expect(() =>
      parseConfig({ NODE_ENV: "production", SESSION_SECRET: "too-short" }),
    ).toThrow(/SESSION_SECRET/i);
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        SESSION_SECRET: "replace-with-at-least-32-random-characters",
        COOKIE_SECURE: "true",
        BOOTSTRAP_CODE: "a-safe-bootstrap-code",
      }),
    ).toThrow(/SESSION_SECRET/i);
  });

  it("requires COOKIE_SECURE to be explicit in production", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        SESSION_SECRET: "a-strong-production-secret-with-32-chars",
      }),
    ).toThrow(/COOKIE_SECURE.*(?:explicit|true|false)/i);
  });

  it("requires an explicit safe bootstrap code in production", () => {
    const production = {
      NODE_ENV: "production",
      SESSION_SECRET: "a-strong-production-secret-with-32-chars",
      COOKIE_SECURE: "true",
    };

    expect(() => parseConfig(production)).toThrow(/BOOTSTRAP_CODE/i);
    expect(() =>
      parseConfig({ ...production, BOOTSTRAP_CODE: "too-short" }),
    ).toThrow(/BOOTSTRAP_CODE/i);
    expect(() =>
      parseConfig({
        ...production,
        BOOTSTRAP_CODE: "replace-with-a-unique-bootstrap-code",
      }),
    ).toThrow(/BOOTSTRAP_CODE/i);
    expect(
      parseConfig({ ...production, BOOTSTRAP_CODE: "a-safe-bootstrap-code" })
        .bootstrapCode,
    ).toBe("a-safe-bootstrap-code");
  });

  it.each([
    ["false", false],
    ["true", true],
  ])(
    "accepts explicit production COOKIE_SECURE=%s",
    (cookieSecure, expected) => {
      const config = parseConfig({
        NODE_ENV: "production",
      SESSION_SECRET: "a-strong-production-secret-with-32-chars",
      COOKIE_SECURE: cookieSecure,
      BOOTSTRAP_CODE: "a-safe-bootstrap-code",
      });

      expect(config.cookieSecure).toBe(expected);
    },
  );

  it("accepts a strong production session secret", () => {
    const config = parseConfig({
      NODE_ENV: "production",
      SESSION_SECRET: "a-strong-production-secret-with-32-chars",
      COOKIE_SECURE: "1",
      BOOTSTRAP_CODE: "a-safe-bootstrap-code",
    });

    expect(config.environment).toBe("production");
    expect(config.cookieSecure).toBe(true);
  });

  it.each(["-1", "1.5", "not-a-number"])(
    "rejects invalid TRUST_PROXY_HOPS=%s",
    (trustProxyHops) => {
      expect(() => parseConfig({ TRUST_PROXY_HOPS: trustProxyHops })).toThrow(
        /TRUST_PROXY_HOPS|number/i,
      );
    },
  );

  it("ships a Caddy-safe production environment example", () => {
    const example = fs.readFileSync(
      path.resolve("deploy/team-project-manager-v2.env.example"),
      "utf8",
    );
    const caddyfile = fs.readFileSync(
      path.resolve("deploy/Caddyfile.example"),
      "utf8",
    );
    const activeSettings = Object.fromEntries(
      example
        .split(/\r?\n/)
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    expect(activeSettings).toMatchObject({
      HOST: "127.0.0.1",
      COOKIE_SECURE: "true",
      TRUST_PROXY_HOPS: "1",
    });
    expect(example).toMatch(
      /# For a trusted direct HTTP LAN deployment[^\r\n]*\r?\n# HOST=0\.0\.0\.0\r?\n# COOKIE_SECURE=false\r?\n# TRUST_PROXY_HOPS=0/,
    );
    const caddyUpstream = caddyfile.match(
      /^\s*reverse_proxy\s+([^\s:]+):(\d+)\s*$/m,
    );
    expect(caddyUpstream).not.toBeNull();
    expect({ host: caddyUpstream?.[1], port: caddyUpstream?.[2] }).toEqual({
      host: activeSettings.HOST,
      port: activeSettings.PORT,
    });
    expect(caddyUpstream?.[1]).toBe("127.0.0.1");
  });
});
