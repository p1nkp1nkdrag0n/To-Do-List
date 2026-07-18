import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../server/config/env.js";
import { startV2Server, type V2ServerHandle } from "../../../server/v2.js";
import { nodeHttpFetch } from "./node-http-fetch.js";

describe("v2 static client hosting", () => {
  const directories: string[] = [];
  const handles: V2ServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves the built client with SPA fallback without masking API errors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-static-client-"));
    directories.push(directory);
    const staticPath = path.join(directory, "dist");
    fs.mkdirSync(staticPath);
    fs.writeFileSync(
      path.join(staticPath, "index.html"),
      "<!doctype html><title>V2 client</title><main>client shell</main>",
    );
    const config = parseConfig(
      {
        NODE_ENV: "test",
        DB_PATH: "runtime/v2.sqlite",
        UPLOAD_PATH: "runtime/uploads",
        HOST: "127.0.0.1",
        PORT: "0",
        BOOTSTRAP_CODE: "static-client-bootstrap",
      },
      directory,
    );
    const handle = await startV2Server(config, { staticPath });
    handles.push(handle);

    const root = await nodeHttpFetch(handle.url);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("client shell");

    const clientRoute = await nodeHttpFetch(`${handle.url}/gantt`);
    expect(clientRoute.status).toBe(200);
    expect(await clientRoute.text()).toContain("client shell");

    const apiRoute = await nodeHttpFetch(`${handle.url}/api/not-found`);
    expect(apiRoute.status).toBe(404);
    expect(await apiRoute.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
