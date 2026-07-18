import fs from "node:fs";
import path from "node:path";

import { parseConfig } from "../../server/config/env.js";
import { startV2Server } from "../../server/v2.js";

const workspace = path.resolve(process.cwd());
const runtimePath = path.resolve(workspace, ".e2e-runtime");

if (
  path.dirname(runtimePath) !== workspace
  || path.basename(runtimePath) !== ".e2e-runtime"
) {
  throw new Error("Refusing to reset an unexpected E2E runtime path.");
}

fs.rmSync(runtimePath, { recursive: true, force: true });
fs.mkdirSync(runtimePath, { recursive: true });

const config = parseConfig(
  {
    NODE_ENV: "test",
    DB_PATH: path.join(runtimePath, "app.sqlite"),
    UPLOAD_PATH: path.join(runtimePath, "uploads"),
    BACKUP_PATH: path.join(runtimePath, "backups"),
    HOST: "127.0.0.1",
    PORT: "4000",
    BOOTSTRAP_CODE: "e2e-bootstrap-code",
    SESSION_SECRET: "e2e-session-secret-with-at-least-32-characters",
    COOKIE_SECURE: "false",
  },
  workspace,
);

const handle = await startV2Server(config, { staticPath: null });
const shutdown = (): void => {
  void handle.close().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(`E2E API listening at ${handle.url}`);
